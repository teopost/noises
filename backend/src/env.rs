//! Linea del volume (automazione) di tracce e gruppi nell'esportazione e nei link condivisi.
//!
//! Stessa formula dell'editor (frontend/envelope.js, stretch-worklet.js): punti (secondi alla
//! velocità originale, dB) uniti da rampe lineari in dB, valore costante prima del primo punto e
//! dopo l'ultimo, -60 dB = silenzio. Il guadagno si scrive come file audio a bassa frequenza di
//! campionamento (basta per un volume che cambia lentamente) e ffmpeg lo moltiplica per la traccia.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const MIN_DB: f64 = -60.0;
pub const MAX_DB: f64 = 6.0;
/// Campioni al secondo del file del guadagno (ffmpeg lo ricampiona alla frequenza della traccia).
pub const ENV_SR: u32 = 2000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvPoint {
    pub t: f64,
    pub v: f64,
}

/// Linea valida (ordinata, nei limiti, al massimo 2000 punti) oppure None se vuota.
pub fn clean(env: Option<Vec<EnvPoint>>) -> Option<Vec<EnvPoint>> {
    let mut e: Vec<EnvPoint> = env?
        .into_iter()
        .filter(|p| p.t.is_finite() && p.v.is_finite())
        .map(|p| EnvPoint { t: p.t.max(0.0), v: p.v.clamp(MIN_DB, MAX_DB) })
        .collect();
    e.sort_by(|a, b| a.t.total_cmp(&b.t));
    e.truncate(2000);
    (!e.is_empty()).then_some(e)
}

fn gain_of_db(v: f64) -> f64 {
    if v <= MIN_DB { 0.0 } else { 10f64.powf(v / 20.0) }
}

/// Guadagno della linea al tempo `t` (secondi alla velocità originale); `cur` accelera le
/// letture in ordine.
fn gain_at(env: &[EnvPoint], t: f64, cur: &mut usize) -> f64 {
    let n = env.len();
    let v = if t <= env[0].t {
        env[0].v
    } else if t >= env[n - 1].t {
        env[n - 1].v
    } else {
        while *cur + 1 < n - 1 && env[*cur + 1].t <= t {
            *cur += 1;
        }
        if env[*cur].t > t {
            *cur = 0;
            while env[*cur + 1].t <= t {
                *cur += 1;
            }
        }
        let (a, b) = (&env[*cur], &env[*cur + 1]);
        a.v + (t - a.t) / (b.t - a.t) * (b.v - a.v)
    };
    gain_of_db(v)
}

/// File WAV mono (float, ENV_SR Hz) con il prodotto delle linee, nella timeline del file
/// esportato (`scale` = 100 / velocità) e lungo `seconds`.
pub fn write_wav(path: &Path, envs: &[Vec<EnvPoint>], scale: f64, seconds: f64) -> anyhow::Result<()> {
    let n = (seconds.max(0.1) * ENV_SR as f64).ceil() as usize;
    let mut data = Vec::with_capacity(n * 4);
    let mut cursors = vec![0usize; envs.len()];
    for i in 0..n {
        let t = i as f64 / ENV_SR as f64 / scale;
        let mut g = 1.0;
        for (e, c) in envs.iter().zip(cursors.iter_mut()) {
            g *= gain_at(e, t, c);
        }
        data.extend_from_slice(&(g as f32).to_le_bytes());
    }
    let mut out = Vec::with_capacity(44 + data.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes()); // float
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&ENV_SR.to_le_bytes());
    out.extend_from_slice(&(ENV_SR * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    std::fs::write(path, out)?;
    Ok(())
}
