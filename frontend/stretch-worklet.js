/*
 * Motore audio in tempo reale (AudioWorklet): mixa le tracce e applica velocità e tonalità
 * mentre suona, senza rielaborare i file.
 *
 *  - velocità e tonalità originali → le tracce passano inalterate (bypass, precisione al campione)
 *  - altrimenti → WSOLA (overlap-add con ricerca della somiglianza, come SoundTouch) per il tempo,
 *    seguito da un ricampionatore cubico per la tonalità:
 *        stretch con rapporto r/p, poi lettura a passo p  ⇒  tempo r, tonalità p
 *
 * Il processore conosce in ogni istante la posizione del brano corrispondente al campione in
 * uscita e la comunica al thread principale (cursore, click, synth restano sincronizzati).
 *
 * Uscite: la 0 porta il mix delle tracce senza effetti; le tracce con effetti escono ognuna dalla
 * sua (1…MAX_BUS-1), già con velocità e tonalità applicate, verso la propria catena di effetti.
 * Il WSOLA cerca l'allineamento sul mix completo e lo applica uguale a tutte le uscite.
 *
 * Pan e canali: ogni traccia ha una matrice 2×2 [Sx→Sx, Dx→Sx, Sx→Dx, Dx→Dx] (pan.js) applicata
 * alla lettura, prima degli effetti: pan, bilanciamento e tracce di un solo canale.
 *
 * Linea del volume (automazione): punti { s: campione, v: dB } con rampe lineari in dB, calcolata
 * per ogni campione alla sua posizione nel brano (segue velocità, loop e salti da sola). Per le
 * tracce nel mix si applica qui; per quelle con effetti esce come terzo canale della loro uscita
 * e la applica la catena effetti dopo gli effetti (come un fader).
 */

const FIFO = 1 << 15;
const MAX_BUS = 17;
const ENV_MIN_DB = -60;
const DB = Math.LN10 / 20;
const ID = [1, 0, 0, 1];
const mat = (m) => (Array.isArray(m) && m.length === 4 && m.every(Number.isFinite) ? m.slice() : ID.slice());

/** Guadagno di una linea del volume alla posizione `p` (campioni). */
function envAt(e, p) {
  const S = e.s, V = e.v, n = S.length;
  let v;
  if (p <= S[0]) v = V[0];
  else if (p >= S[n - 1]) v = V[n - 1];
  else {
    let i = e.i;
    if (!(i < n - 1 && p >= S[i] && p < S[i + 1])) {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= p) lo = m; else hi = m; }
      i = e.i = lo;
    }
    v = V[i] + ((p - S[i]) / (S[i + 1] - S[i])) * (V[i + 1] - V[i]);
  }
  return v <= ENV_MIN_DB ? 0 : Math.exp(v * DB);
}

/** Prodotto delle linee della traccia (la sua e quella del gruppo); 1 senza linee. */
function envGain(s, p) {
  if (!s.envs) return 1;
  let g = 1;
  for (const e of s.envs) g *= envAt(e, p);
  return g;
}

class StretchPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stems = [];        // { l, r, gain, target, clips? } — clips: tracce utente [{ s, o, d }] in campioni
    this.len = 0;
    this.playing = false;
    this.startFrame = 0;
    this.src = 0;           // posizione di lettura (campioni) in bypass
    this.inPos = 0;         // posizione nominale di lettura in modalità stretch
    this.loop = null;       // { s, e } in campioni
    this.rate = 1;          // velocità (1 = originale)
    this.pitch = 1;         // rapporto di frequenza (1 = originale)
    this.N = Math.round(sampleRate * 0.04);   // segmento
    this.L = Math.round(sampleRate * 0.008);  // sovrapposizione
    this.S = Math.round(sampleRate * 0.012);  // finestra di ricerca
    this.fifoSrc = new Float64Array(FIFO);
    this.prevL = new Float32Array(this.L);   // coda del segmento precedente (mix completo)
    this.prevR = new Float32Array(this.L);
    this.segL = new Float32Array(this.N + this.S + 4);
    this.segR = new Float32Array(this.N + this.S + 4);
    this.buses = [];         // per uscita: FIFO e coda del segmento precedente
    this.active = [0];       // uscite in uso
    this.busStem = [];       // traccia di ogni uscita con effetti
    this.bus(0);
    this.resetStretch(0);
    this.blocks = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  get bypass() {
    return this.rate === 1 && this.pitch === 1;
  }

  bus(k) {
    if (!this.buses[k]) {
      this.buses[k] = {
        fifoL: new Float32Array(FIFO), fifoR: new Float32Array(FIFO),
        prevL: new Float32Array(this.L), prevR: new Float32Array(this.L),
        segL: new Float32Array(this.N + 4), segR: new Float32Array(this.N + 4),
      };
    }
    return this.buses[k];
  }

  /** Ricalcola le uscite in uso; una che si attiva parte da silenzio. */
  updateActive() {
    const set = new Set([0]);
    for (const s of this.stems) set.add(s.bus);
    const next = [...set].sort((a, b) => a - b);
    this.busStem = [];
    for (const s of this.stems) if (s.bus > 0) this.busStem[s.bus] = s;
    for (const k of next) {
      if (this.active.includes(k)) continue;
      const b = this.bus(k);
      b.fifoL.fill(0); b.fifoR.fill(0); b.prevL.fill(0); b.prevR.fill(0);
    }
    this.active = next;
  }

  resetStretch(pos) {
    this.inPos = pos;
    this.fifoLen = 0;
    this.fifoRead = 0;
    this.hasPrev = false;
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.stems = m.stems.map((s) => ({ name: s.name, l: s.l, r: s.r || s.l, gain: s.gain, target: s.gain, m: mat(s.mat), mt: mat(s.mat), clips: s.clips || null, bus: s.bus || 0 }));
        this.len = m.length;
        this.playing = false;
        this.updateActive();
        break;
      case 'add':
        this.stems = this.stems.filter((s) => s.name !== m.name);
        this.stems.push({ name: m.name, l: m.l, r: m.r || m.l, gain: m.gain, target: m.gain, m: mat(m.mat), mt: mat(m.mat), clips: m.clips || [], bus: m.bus || 0 });
        this.updateActive();
        break;
      case 'remove':
        this.stems = this.stems.filter((s) => s.name !== m.name);
        this.updateActive();
        break;
      case 'bus': {
        // la traccia passa a un'altra uscita (catena di effetti) o torna nel mix senza effetti
        const s = this.stems.find((x) => x.name === m.name);
        if (s) { s.bus = m.bus > 0 && m.bus < MAX_BUS ? m.bus : 0; this.updateActive(); }
        break;
      }
      case 'clips': {
        // null = traccia intera (percorso veloce), altrimenti elenco di clip
        const s = this.stems.find((x) => x.name === m.name);
        if (s) s.clips = m.clips;
        break;
      }
      case 'length':
        this.len = m.length;
        break;
      case 'envs':
        // { nome: [[{ s, v }…], …] | null }: linee della traccia e del suo gruppo
        for (const st of this.stems) {
          if (!(st.name in m.envs)) continue;
          const list = (m.envs[st.name] || []).filter((x) => x && x.length);
          st.envs = list.length ? list.map((x) => ({ s: Float64Array.from(x, (q) => q.s), v: Float64Array.from(x, (q) => q.v), i: 0 })) : null;
        }
        break;
      case 'gains':
        for (const s of this.stems) {
          if (s.name in m.gains) s.target = m.gains[s.name];
          if (m.mats && s.name in m.mats) s.mt = mat(m.mats[s.name]);
        }
        break;
      case 'play':
        this.playing = true;
        this.startFrame = Math.round(m.at * sampleRate);
        this.src = Math.round(m.pos);
        this.resetStretch(m.pos);
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seek':
        this.src = Math.round(m.pos);
        this.resetStretch(m.pos);
        break;
      case 'loop':
        this.loop = m.loop;
        break;
      case 'rate': {
        // riparte dalla posizione udibile in questo momento, nella nuova modalità
        const now = this.currentSrc();
        this.rate = m.rate;
        this.pitch = m.pitch;
        this.src = Math.round(now);
        this.resetStretch(now);
        break;
      }
    }
  }

  wrap(p) {
    const L = this.loop;
    if (L && p >= L.e) p = L.s + ((p - L.s) % (L.e - L.s));
    return p;
  }

  /** Indice nel file della traccia per la posizione `p` della timeline (-1 = silenzio). */
  static index(s, p) {
    if (!s.clips) return p < s.l.length ? p : -1;
    for (const c of s.clips) {
      if (p >= c.s && p < c.s + c.d) {
        const q = p - c.s + c.o;
        return q < s.l.length ? q : -1;
      }
    }
    return -1;
  }

  /** Mix delle tracce a partire da `pos` (con il loop applicato campione per campione);
   *  con `bus` solo le tracce di quell'uscita. */
  readMix(pos, outL, outR, n, bus = -1) {
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    for (const s of this.stems) {
      if (s.gain === 0 || (bus >= 0 && s.bus !== bus)) continue;
      const g = s.gain, l = s.l, r = s.r;
      const [a, b, c, d] = s.m;
      const env = s.envs && s.bus === 0; // le tracce con effetti hanno la linea dopo gli effetti
      for (let i = 0; i < n; i++) {
        const p = this.wrap(pos + i);
        if (p < 0 || p >= this.len) continue;
        const q = StretchPlayer.index(s, p);
        if (q < 0) continue;
        const gg = env ? g * envGain(s, p) : g;
        const x = l[q], y = r[q];
        outL[i] += (a * x + b * y) * gg;
        outR[i] += (c * x + d * y) * gg;
      }
    }
  }

  /** Produce un segmento WSOLA e lo accoda nella FIFO. */
  produceChunk() {
    const { N, L, S } = this;
    const ratio = this.rate / this.pitch;
    let base = Math.round(this.inPos - (this.hasPrev ? S / 2 : 0));
    let best = 0;
    if (this.hasPrev) {
      // cerca l'allineamento che somiglia di più alla coda del segmento precedente
      this.readMix(base, this.segL, this.segR, S + L);
      let bestScore = -Infinity;
      for (let o = 0; o <= S; o += 2) {
        let corr = 0, energy = 1e-9;
        for (let i = 0; i < L; i += 2) {
          const v = this.segL[o + i] + this.segR[o + i];
          corr += (this.prevL[i] + this.prevR[i]) * v;
          energy += v * v;
        }
        const score = corr / Math.sqrt(energy);
        if (score > bestScore) { bestScore = score; best = o; }
      }
    }
    const start = base + best;
    if (this.fifoLen + N > FIFO) this.compact();
    const single = this.active.length === 1;
    if (!single) { this.prevL.fill(0); this.prevR.fill(0); }
    for (const k of this.active) {
      const b = this.buses[k];
      // con una sola uscita il mix è quello di tutte le tracce
      this.readMix(start, b.segL, b.segR, N, single ? -1 : k);
      let w = this.fifoLen;
      for (let i = 0; i < N - L; i++, w++) {
        let l = b.segL[i], r = b.segR[i];
        if (i < L && this.hasPrev) {
          const f = i / L;
          l = b.prevL[i] * (1 - f) + l * f;
          r = b.prevR[i] * (1 - f) + r * f;
        }
        b.fifoL[w] = l;
        b.fifoR[w] = r;
      }
      b.prevL.set(b.segL.subarray(N - L, N));
      b.prevR.set(b.segR.subarray(N - L, N));
      if (single) {
        this.prevL.set(b.prevL);
        this.prevR.set(b.prevR);
      } else {
        for (let i = 0; i < L; i++) { this.prevL[i] += b.prevL[i]; this.prevR[i] += b.prevR[i]; }
      }
    }
    let w = this.fifoLen;
    for (let i = 0; i < N - L; i++, w++) this.fifoSrc[w] = this.wrap(start + i);
    this.fifoLen = w;
    this.hasPrev = true;
    this.inPos = this.wrap(this.inPos + (N - L) * ratio);
  }

  compact() {
    const drop = Math.max(0, Math.floor(this.fifoRead) - 2);
    if (!drop) return;
    for (const k of this.active) {
      const b = this.buses[k];
      b.fifoL.copyWithin(0, drop, this.fifoLen);
      b.fifoR.copyWithin(0, drop, this.fifoLen);
    }
    this.fifoSrc.copyWithin(0, drop, this.fifoLen);
    this.fifoLen -= drop;
    this.fifoRead -= drop;
  }

  /** Posizione del brano (campioni) del prossimo campione in uscita. */
  currentSrc() {
    if (this.bypass) return this.src;
    if (this.fifoLen > Math.floor(this.fifoRead)) return this.fifoSrc[Math.floor(this.fifoRead)];
    return this.inPos;
  }

  process(inputs, outputs) {
    for (const o of outputs) {
      o[0].fill(0);
      if (o[1]) o[1].fill(0);
      if (o[2]) o[2].fill(1); // guadagno della linea del volume (1 = invariato)
    }
    const n = outputs[0][0].length;
    // guadagni: avvicinamento graduale al valore richiesto (niente click)
    for (const s of this.stems) {
      s.gain += (s.target - s.gain) * 0.25;
      for (let j = 0; j < 4; j++) s.m[j] += (s.mt[j] - s.m[j]) * 0.25;
    }
    if (!this.playing || !this.stems.length) return true;

    let i = 0;
    const startOffset = this.startFrame - currentFrame;
    if (startOffset >= n) return true;
    if (startOffset > 0) i = startOffset; // inizio preciso al campione

    const reportSrc = this.currentSrc();
    const reportFrame = currentFrame + i;

    if (this.bypass) {
      for (; i < n; i++) {
        let p = this.src;
        if (p >= this.len) { this.end(); break; }
        for (const s of this.stems) {
          const o = outputs[s.bus] || outputs[0];
          if (s.bus > 0 && o[2]) o[2][i] = envGain(s, p); // linea per la catena effetti
          if (s.gain === 0) continue;
          const q = s.clips ? StretchPlayer.index(s, p) : (p < s.l.length ? p : -1);
          if (q < 0) continue;
          const g = s.bus === 0 && s.envs ? s.gain * envGain(s, p) : s.gain;
          const x = s.l[q], y = s.r[q], M = s.m;
          o[0][i] += (M[0] * x + M[1] * y) * g;
          (o[1] || o[0])[i] += (M[2] * x + M[3] * y) * g;
        }
        p++;
        if (this.loop && p >= this.loop.e) p = this.loop.s;
        this.src = p;
      }
    } else {
      for (; i < n; i++) {
        while (this.fifoLen - this.fifoRead < 4) {
          if (!this.loop && this.inPos >= this.len) break;
          this.produceChunk();
        }
        const avail = this.fifoLen - this.fifoRead;
        if (avail < 4) { this.end(); break; }
        // interpolazione cubica (Catmull-Rom) tra i campioni della FIFO
        const f = this.fifoRead, k = Math.floor(f), t = f - k;
        const a = Math.max(0, k - 1);
        const cub = (y0, y1, y2, y3) =>
          y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
        for (const j of this.active) {
          const b = this.buses[j], o = outputs[j];
          if (!o) continue;
          o[0][i] = cub(b.fifoL[a], b.fifoL[k], b.fifoL[k + 1], b.fifoL[k + 2]);
          if (o[1]) o[1][i] = cub(b.fifoR[a], b.fifoR[k], b.fifoR[k + 1], b.fifoR[k + 2]);
          if (o[2] && this.busStem[j]) o[2][i] = envGain(this.busStem[j], this.fifoSrc[k]);
        }
        this.fifoRead += this.pitch;
      }
      if (this.fifoRead > FIFO / 2) this.compact();
    }

    if (++this.blocks % 4 === 0) {
      this.port.postMessage({ type: 'pos', src: reportSrc, frame: reportFrame });
    }
    return true;
  }

  end() {
    this.playing = false;
    this.port.postMessage({ type: 'ended' });
  }
}

registerProcessor('stretch-player', StretchPlayer);
