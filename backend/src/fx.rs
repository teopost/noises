//! Effetti per traccia nell'esportazione e nei link condivisi.
//!
//! Riproduce con ffmpeg la catena dell'editor (frontend/fx-worklet.js), con gli stessi calcoli:
//! taglio dei bassi → bassi → medi → alti (biquad RBJ con coefficienti identici) → definizione
//! (valore assoluto filtrato, sommato al segnale) → compressore (acompressor, lo stesso algoritmo
//! usato nel browser) → volume della traccia → mandata al riverbero condiviso (afir con la stessa
//! risposta all'impulso, frontend/reverb.wav).

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const LOW_SHELF_HZ: f64 = 120.0;
const HIGH_SHELF_HZ: f64 = 4000.0;
const MID_Q: f64 = 1.0;
const EXC_GAIN: f64 = 8.0;
const COMP_RELEASE_MS: f64 = 150.0;
const COMP_KNEE: f64 = 2.82843;
/// Frequenza di campionamento a cui si applicano gli effetti nell'esportazione.
const SR: f64 = 44100.0;

/// Risposta all'impulso del riverbero (impostata all'avvio).
pub static REVERB_IR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Fx {
    /// false = effetti disattivati (confronto con l'originale): la traccia esce com'è
    pub on: bool,
    /// taglio dei bassi (Hz, 0 = spento)
    pub lowcut: f64,
    /// dB: bassi (shelf 120 Hz), medi (campana su `midf`), alti (shelf 4 kHz)
    pub low: f64,
    pub mid: f64,
    pub midf: f64,
    pub high: f64,
    /// definizione 0–1 sopra `excf` Hz
    pub exc: f64,
    pub excf: f64,
    /// compressione 0–1 e attacco (ms)
    pub comp: f64,
    pub att: f64,
    /// mandata al riverbero 0–1
    pub rev: f64,
}

impl Default for Fx {
    fn default() -> Self {
        Fx { on: true, lowcut: 0.0, low: 0.0, mid: 0.0, midf: 1000.0, high: 0.0, exc: 0.0, excf: 2000.0, comp: 0.0, att: 10.0, rev: 0.0 }
    }
}

fn clamp(v: f64, lo: f64, hi: f64, def: f64) -> f64 {
    if v.is_finite() { v.clamp(lo, hi) } else { def }
}

impl Fx {
    /// Valori nei limiti (gli stessi dell'editor).
    pub fn clamped(self) -> Fx {
        let lowcut = clamp(self.lowcut, 0.0, 400.0, 0.0);
        Fx {
            on: self.on,
            lowcut: if lowcut < 20.0 { 0.0 } else { lowcut },
            low: clamp(self.low, -12.0, 12.0, 0.0),
            mid: clamp(self.mid, -12.0, 12.0, 0.0),
            midf: clamp(self.midf, 150.0, 6000.0, 1000.0),
            high: clamp(self.high, -12.0, 12.0, 0.0),
            exc: clamp(self.exc, 0.0, 1.0, 0.0),
            excf: clamp(self.excf, 500.0, 8000.0, 2000.0),
            comp: clamp(self.comp, 0.0, 1.0, 0.0),
            att: clamp(self.att, 1.0, 50.0, 10.0),
            rev: clamp(self.rev, 0.0, 1.0, 0.0),
        }
    }

    /// Mandata al riverbero effettiva (0 se gli effetti sono spenti).
    pub fn send(&self) -> f64 {
        if self.on { self.rev } else { 0.0 }
    }

    /// Filtri da `[input]` a `[output]` (con il `;` finale), oppure None se non cambiano il suono.
    pub fn graph(&self, input: &str, output: &str, k: usize) -> Option<String> {
        let f = self.clone().clamped();
        if !f.on {
            return None;
        }
        let mut chain: Vec<String> = vec![];
        if f.lowcut > 0.0 {
            chain.push(biquad(Kind::HighPass, f.lowcut, 0.0));
        }
        if f.low != 0.0 {
            chain.push(biquad(Kind::LowShelf, LOW_SHELF_HZ, f.low));
        }
        if f.mid != 0.0 {
            chain.push(biquad(Kind::Peak, f.midf, f.mid));
        }
        if f.high != 0.0 {
            chain.push(biquad(Kind::HighShelf, HIGH_SHELF_HZ, f.high));
        }
        if chain.is_empty() && f.exc <= 0.0 && f.comp <= 0.0 {
            return None;
        }
        let mut g = format!("[{input}]aformat=sample_fmts=dbl:sample_rates={}", SR as u32);
        for c in &chain {
            g += ",";
            g += c;
        }
        if f.exc > 0.0 {
            let hp = biquad(Kind::HighPass, f.excf, 0.0);
            g += &format!(
                ",asplit=2[fxd{k}][fxs{k}];[fxs{k}]aeval=exprs=abs(val(ch)):c=same,{hp},{hp},volume={:.6}[fxe{k}];[fxd{k}][fxe{k}]amix=inputs=2:normalize=0",
                f.exc * EXC_GAIN
            );
        }
        if f.comp > 0.0 {
            let c = comp_settings(f.comp, f.att);
            g += &format!(
                ",acompressor=threshold={:.8}:ratio={:.6}:attack={:.4}:release={:.4}:makeup={:.6}:knee={COMP_KNEE}:detection=peak:link=maximum",
                c.threshold, c.ratio, c.attack, c.release, c.makeup
            );
        }
        g += &format!("[{output}];");
        Some(g)
    }
}

struct Comp {
    threshold: f64,
    ratio: f64,
    makeup: f64,
    attack: f64,
    release: f64,
}

/// Impostazioni del compressore dalla manopola "Compressione" (come compSettings nell'editor).
fn comp_settings(amount: f64, attack_ms: f64) -> Comp {
    let thr_db = -36.0 * amount;
    let ratio = 1.0 + 5.0 * amount;
    let makeup_db = -thr_db * (1.0 - 1.0 / ratio) * 0.5;
    Comp {
        threshold: 10f64.powf(thr_db / 20.0),
        ratio,
        makeup: 10f64.powf(makeup_db / 20.0),
        attack: attack_ms,
        release: COMP_RELEASE_MS,
    }
}

enum Kind {
    HighPass,
    LowShelf,
    Peak,
    HighShelf,
}

/// Filtro `biquad` di ffmpeg con i coefficienti RBJ normalizzati (a0 = 1), come nell'editor.
fn biquad(kind: Kind, f: f64, gain_db: f64) -> String {
    let w0 = 2.0 * std::f64::consts::PI * f.min(SR * 0.45) / SR;
    let (cs, sn) = (w0.cos(), w0.sin());
    let a = 10f64.powf(gain_db / 40.0);
    let (b0, b1, b2, a0, a1, a2) = match kind {
        Kind::HighPass => {
            let al = sn / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
            ((1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0, 1.0 + al, -2.0 * cs, 1.0 - al)
        }
        Kind::Peak => {
            let al = sn / (2.0 * MID_Q);
            (1.0 + al * a, -2.0 * cs, 1.0 - al * a, 1.0 + al / a, -2.0 * cs, 1.0 - al / a)
        }
        Kind::LowShelf | Kind::HighShelf => {
            let al = sn / 2.0 * std::f64::consts::SQRT_2;
            let sa = 2.0 * a.sqrt() * al;
            if matches!(kind, Kind::LowShelf) {
                (
                    a * ((a + 1.0) - (a - 1.0) * cs + sa),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cs),
                    a * ((a + 1.0) - (a - 1.0) * cs - sa),
                    (a + 1.0) + (a - 1.0) * cs + sa,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cs),
                    (a + 1.0) + (a - 1.0) * cs - sa,
                )
            } else {
                (
                    a * ((a + 1.0) + (a - 1.0) * cs + sa),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cs),
                    a * ((a + 1.0) + (a - 1.0) * cs - sa),
                    (a + 1.0) - (a - 1.0) * cs + sa,
                    2.0 * ((a - 1.0) - (a + 1.0) * cs),
                    (a + 1.0) - (a - 1.0) * cs - sa,
                )
            }
        }
    };
    format!(
        "biquad=b0={:.12}:b1={:.12}:b2={:.12}:a0=1:a1={:.12}:a2={:.12}",
        b0 / a0,
        b1 / a0,
        b2 / a0,
        a1 / a0,
        a2 / a0
    )
}
