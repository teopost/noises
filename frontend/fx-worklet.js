/*
 * Effetti di una traccia (AudioWorklet), nell'ordine:
 *   taglio dei bassi → bassi → medi → alti → definizione (exciter) → compressore
 * La definizione raddrizza il segnale (valore assoluto: crea armoniche pari, in proporzione al
 * volume, come un exciter) e ne tiene solo la parte sopra la frequenza scelta, sommandola al
 * segnale: ridà presenza a una traccia ovattata (es. il basso separato) senza alzare i residui.
 * Il riverbero non è qui: è una mandata verso un riverbero condiviso (ConvolverNode).
 * Il terzo canale in ingresso è la linea del volume della traccia (guadagno campione per campione,
 * calcolato dal motore alla posizione nel brano): si applica dopo gli effetti, come un fader.
 *
 * Gli stessi calcoli sono replicati nell'esportazione sul server con ffmpeg (backend, fx_filter):
 * filtri biquad con coefficienti identici (formule RBJ), valore assoluto e il compressore di
 * ffmpeg (acompressor, rilevamento di picco, canali collegati al massimo), così il file
 * esportato e il link condiviso suonano come l'ascolto nell'editor.
 */

// ------------------------------------------------------------ parametri (uguali sul server)
const LOW_SHELF_HZ = 120;
const HIGH_SHELF_HZ = 4000;
const MID_Q = 1;
const EXC_GAIN = 8; // definizione al 100%: circa +17 dB sopra 1,5 kHz su un basso separato
const COMP_RELEASE_MS = 150;
const COMP_KNEE = 2.82843;

/** Coefficienti normalizzati (a0 = 1) di un biquad RBJ. */
function biquad(kind, f, fs, gainDb, q) {
  const w0 = (2 * Math.PI * Math.min(f, fs * 0.45)) / fs;
  const cs = Math.cos(w0), sn = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'hp') {
    const al = sn / (2 * Math.SQRT1_2);
    b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2;
    a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
  } else if (kind === 'peak') {
    const al = sn / (2 * q);
    b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A;
    a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
  } else {
    const al = (sn / 2) * Math.SQRT2, sa = 2 * Math.sqrt(A) * al;
    if (kind === 'low') {
      b0 = A * ((A + 1) - (A - 1) * cs + sa); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sa);
      a0 = (A + 1) + (A - 1) * cs + sa; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sa;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cs + sa); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sa);
      a0 = (A + 1) - (A - 1) * cs + sa; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sa;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Filtro biquad stereo (forma diretta I, come ffmpeg). */
class Biquad {
  constructor(c) { this.c = c; this.s = new Float64Array(8); }
  set(c) { this.c = c; }
  run(x, ch) {
    const c = this.c, s = this.s, o = ch * 4;
    const y = c.b0 * x + c.b1 * s[o] + c.b2 * s[o + 1] - c.a1 * s[o + 2] - c.a2 * s[o + 3];
    s[o + 1] = s[o]; s[o] = x;
    s[o + 3] = s[o + 2]; s[o + 2] = y;
    return y;
  }
}

/** Impostazioni del compressore dalla manopola "Compressione" (0–1). */
function compSettings(amount, attackMs) {
  const thrDb = -36 * amount;
  const ratio = 1 + 5 * amount;
  const makeupDb = -thrDb * (1 - 1 / ratio) * 0.5;
  return { threshold: Math.pow(10, thrDb / 20), ratio, makeup: Math.pow(10, makeupDb / 20), attack: attackMs, release: COMP_RELEASE_MS };
}

function hermite(x, x0, x1, p0, p1, m0, m1) {
  const w = x1 - x0, t = (x - x0) / w;
  m0 *= w; m1 *= w;
  const t2 = t * t, t3 = t2 * t;
  const c2 = -3 * p0 - 2 * m0 + 3 * p1 - m1, c3 = 2 * p0 + m0 - 2 * p1 + m1;
  return c3 * t3 + c2 * t2 + m0 * t + p0;
}

/** Compressore: stesso algoritmo di ffmpeg acompressor (detection=peak, link=maximum). */
class Compressor {
  constructor() { this.slope = 0; }
  set(p, fs) {
    this.p = p;
    this.thres = Math.log(p.threshold);
    this.kneeStartLin = p.threshold / Math.sqrt(COMP_KNEE);
    this.kneeStart = Math.log(this.kneeStartLin);
    this.kneeStop = Math.log(p.threshold * Math.sqrt(COMP_KNEE));
    this.cKneeStop = (this.kneeStop - this.thres) / p.ratio + this.thres;
    this.att = Math.min(1, 1 / ((p.attack * fs) / 4000));
    this.rel = Math.min(1, 1 / ((p.release * fs) / 4000));
  }
  gain(absSample) {
    this.slope += (absSample - this.slope) * (absSample > this.slope ? this.att : this.rel);
    let g = 1;
    if (this.slope > 0 && this.slope > this.kneeStartLin) {
      const slope = Math.log(this.slope), p = this.p;
      let gl = (slope - this.thres) / p.ratio + this.thres;
      if (COMP_KNEE > 1 && slope < this.kneeStop) {
        gl = hermite(slope, this.kneeStart, this.kneeStop, this.kneeStart, this.cKneeStop, 1, 1 / p.ratio);
      }
      g = Math.exp(gl - slope);
    }
    return g * this.p.makeup;
  }
}

class FxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fx = null;
    this.eq = [];
    this.exc = null;
    this.comp = null;
    this.port.onmessage = (e) => { if (e.data.type === 'params') this.configure(e.data.fx); };
  }

  configure(fx) {
    this.fx = fx;
    const fs = sampleRate;
    const want = [
      fx.lowcut > 0 ? biquad('hp', fx.lowcut, fs) : null,
      fx.low ? biquad('low', LOW_SHELF_HZ, fs, fx.low) : null,
      fx.mid ? biquad('peak', fx.midf, fs, fx.mid, MID_Q) : null,
      fx.high ? biquad('high', HIGH_SHELF_HZ, fs, fx.high) : null,
    ];
    // un filtro già attivo resta lo stesso oggetto (con il suo stato): regolandolo non fa click
    this.eq = want.map((c, i) => {
      if (!c) return null;
      const b = this.eq[i] || new Biquad(c);
      b.set(c);
      return b;
    });
    if (fx.exc > 0) {
      const c = biquad('hp', fx.excf, fs);
      if (!this.exc) this.exc = [new Biquad(c), new Biquad(c)];
      this.exc[0].set(c);
      this.exc[1].set(c);
    } else {
      this.exc = null;
    }
    if (fx.comp > 0) {
      if (!this.comp) this.comp = new Compressor();
      this.comp.set(compSettings(fx.comp, fx.att), fs);
    } else {
      this.comp = null;
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    if (!inp || !inp.length) { oL.fill(0); oR.fill(0); return true; }
    const iL = inp[0], iR = inp[1] || inp[0], G = inp[2] || null;
    const fx = this.fx;
    if (!fx || fx.on === false) {
      if (G) for (let i = 0; i < oL.length; i++) { oL[i] = iL[i] * G[i]; oR[i] = iR[i] * G[i]; }
      else { oL.set(iL); oR.set(iR); }
      return true;
    }
    const n = oL.length;
    const eq = this.eq, exc = this.exc, comp = this.comp, amt = fx.exc * EXC_GAIN;
    for (let i = 0; i < n; i++) {
      let l = iL[i], r = iR[i];
      for (let k = 0; k < 4; k++) {
        const b = eq[k];
        if (!b) continue;
        l = b.run(l, 0);
        r = b.run(r, 1);
      }
      if (exc) {
        l += amt * exc[1].run(exc[0].run(Math.abs(l), 0), 0);
        r += amt * exc[1].run(exc[0].run(Math.abs(r), 1), 1);
      }
      if (comp) {
        const g = comp.gain(Math.max(Math.abs(l), Math.abs(r)));
        l *= g; r *= g;
      }
      const g = G ? G[i] : 1;
      oL[i] = l * g;
      oR[i] = r * g;
    }
    return true;
  }
}

registerProcessor('noises-fx', FxProcessor);
