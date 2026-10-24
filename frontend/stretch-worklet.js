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
 */

const FIFO = 1 << 15;

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
    this.fifoL = new Float32Array(FIFO);
    this.fifoR = new Float32Array(FIFO);
    this.fifoSrc = new Float64Array(FIFO);
    this.prevL = new Float32Array(this.L);
    this.prevR = new Float32Array(this.L);
    this.segL = new Float32Array(this.N + this.S + 4);
    this.segR = new Float32Array(this.N + this.S + 4);
    this.resetStretch(0);
    this.blocks = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  get bypass() {
    return this.rate === 1 && this.pitch === 1;
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
        this.stems = m.stems.map((s) => ({ l: s.l, r: s.r || s.l, gain: s.gain, target: s.gain, clips: s.clips || null }));
        this.len = m.length;
        this.playing = false;
        break;
      case 'add':
        this.stems.push({ l: m.l, r: m.r || m.l, gain: m.gain, target: m.gain, clips: m.clips || [] });
        break;
      case 'remove':
        this.stems.splice(m.index, 1);
        break;
      case 'clips':
        if (this.stems[m.index]) this.stems[m.index].clips = m.clips;
        break;
      case 'length':
        this.len = m.length;
        break;
      case 'gains':
        m.gains.forEach((g, i) => { if (this.stems[i]) this.stems[i].target = g; });
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

  /** Mix delle tracce a partire da `pos` (con il loop applicato campione per campione). */
  readMix(pos, outL, outR, n) {
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    for (const s of this.stems) {
      if (s.gain === 0) continue;
      const g = s.gain, l = s.l, r = s.r;
      for (let i = 0; i < n; i++) {
        const p = this.wrap(pos + i);
        if (p < 0 || p >= this.len) continue;
        const q = StretchPlayer.index(s, p);
        if (q < 0) continue;
        outL[i] += l[q] * g;
        outR[i] += r[q] * g;
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
    this.readMix(start, this.segL, this.segR, N);
    if (this.fifoLen + N > FIFO) this.compact();
    let w = this.fifoLen;
    for (let i = 0; i < N - L; i++, w++) {
      let l = this.segL[i], r = this.segR[i];
      if (i < L && this.hasPrev) {
        const k = i / L;
        l = this.prevL[i] * (1 - k) + l * k;
        r = this.prevR[i] * (1 - k) + r * k;
      }
      this.fifoL[w] = l;
      this.fifoR[w] = r;
      this.fifoSrc[w] = this.wrap(start + i);
    }
    this.fifoLen = w;
    this.prevL.set(this.segL.subarray(N - L, N));
    this.prevR.set(this.segR.subarray(N - L, N));
    this.hasPrev = true;
    this.inPos = this.wrap(this.inPos + (N - L) * ratio);
  }

  compact() {
    const drop = Math.max(0, Math.floor(this.fifoRead) - 2);
    if (!drop) return;
    this.fifoL.copyWithin(0, drop, this.fifoLen);
    this.fifoR.copyWithin(0, drop, this.fifoLen);
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
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    // guadagni: avvicinamento graduale al valore richiesto (niente click)
    for (const s of this.stems) s.gain += (s.target - s.gain) * 0.25;
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
        let l = 0, r = 0;
        for (const s of this.stems) {
          if (s.gain === 0) continue;
          const q = s.clips ? StretchPlayer.index(s, p) : (p < s.l.length ? p : -1);
          if (q < 0) continue;
          l += s.l[q] * s.gain;
          r += s.r[q] * s.gain;
        }
        oL[i] = l;
        oR[i] = r;
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
        oL[i] = cub(this.fifoL[a], this.fifoL[k], this.fifoL[k + 1], this.fifoL[k + 2]);
        oR[i] = cub(this.fifoR[a], this.fifoR[k], this.fifoR[k + 1], this.fifoR[k + 2]);
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
