'use strict';
// Note trascritte: piano roll modificabile, ascolto con synth, esportazione MIDI.
// Le note sono salvate in secondi e altezze ORIGINALI; la visualizzazione applica
// la velocità (engine.tempo) e la trasposizione (engine.pitch) correnti.

const DRUM_ROWS = [{ p: 42, label: 'Hi-hat' }, { p: 38, label: 'Rullante' }, { p: 36, label: 'Cassa' }];
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const rolls = {};          // stem → { canvas, row, rows: [pitch...], rowH }
const noteSaveTimers = {};
let notesSeq = 0;

const dispK = () => 100 / engine.tempo;            // secondi originali → timeline corrente
/** Battiti per battuta e quarti per battito del metro scelto (default 4/4). */
const gridBpb = () => (state.notes && state.notes.grid && state.notes.grid.beats_per_bar) || 4;
const gridBq = () => (state.notes && state.notes.grid && state.notes.grid.beat_quarters) || 1;
const isDrums = (stem) => stem === 'drums';
const shownPitch = (stem, p) => (isDrums(stem) ? p : p + engine.pitch);

// ------------------------------------------------------------------ caricamento

async function loadNotes(song) {
  const seq = ++notesSeq;
  state.notes = null;
  state.notesMissing = false;
  state.selNote = null;
  refreshNotesHeads('Caricamento…');
  updateRhythmControls();
  try {
    const data = await api(`/api/songs/${song.id}/notes`);
    if (seq !== notesSeq || !state.current || state.current.id !== song.id) return;
    setNotesData(data);
  } catch (e) {
    if (seq !== notesSeq) return;
    if (e.status === 409) {
      const fresh = state.songs.find((x) => x.id === song.id);
      if (fresh && fresh.phase === 'Trascrizione note') runTranscription(song);
      else {
        state.notesMissing = true;
        refreshNotesHeads('Non ancora trascritte');
        updateRhythmControls();
      }
    } else {
      refreshNotesHeads(`Trascrizione non disponibile: ${e.message}`);
    }
  }
}

function setNotesData(data) {
  state.notes = data;
  state.notesMissing = false;
  refreshNotesHeads();
  updateRhythmControls();
  for (const stem of Object.keys(rolls)) layoutRoll(stem);
  requestRedraw();
}

/** Avvia (o attende, se già in corso) ritmo + trascrizione delle note. */
async function runTranscription(song) {
  const seq = ++notesSeq;
  state.notesMissing = false;
  state.notesBusy = true;
  refreshNotesHeads('Trascrizione in corso (~1 min)…');
  updateRhythmControls();
  try {
    const data = await api(`/api/songs/${song.id}/notes/analyze`, { method: 'POST' });
    if (seq === notesSeq && state.current && state.current.id === song.id) setNotesData(data);
  } catch (e) {
    if (seq === notesSeq) refreshNotesHeads(`Trascrizione fallita: ${e.message}`);
  } finally {
    state.notesBusy = false;
    if (seq === notesSeq) updateRhythmControls();
  }
}

function refreshNotesHeads(message) {
  for (const [stem, r] of Object.entries(rolls)) {
    const notes = state.notes && state.notes.tracks[stem];
    r.row.querySelector('.count').textContent = message || (notes ? `${notes.length}` : '');
    r.row.querySelector('.rst').classList.toggle('hidden', !(state.notes && state.notes.edited.includes(stem)));
    r.row.querySelector('.sco').disabled = !notes;
    r.row.querySelector('.syn').disabled = !notes;
    r.row.querySelector('.syn').classList.toggle('on', state.synth.has(stem));
  }
}

// ------------------------------------------------------------------- piano roll

function buildNotesRow(t) {
  const stem = t.name;
  const row = document.createElement('div');
  row.className = `track notes-row ${state.showNotes.has(stem) ? '' : 'hidden'}`;
  row.innerHTML = `
    <div class="track-head notes-head">
      <div class="track-title small"><span class="swatch" style="background:${t.color}"></span>Note · ${esc(LABELS[stem] || stem)} <span class="count"></span></div>
      <div class="track-btns">
        <button class="syn" title="Ascolta le note trascritte con un suono sintetico">🔊 Synth</button>
        <button class="sco" title="${isDrums(stem) ? 'Spartito batteria' : 'Spartito e tablatura'}">𝄞 Spartito</button>
        <button class="rst hidden" title="Annulla le correzioni e ripristina la trascrizione automatica">↺</button>
      </div>
    </div>
    <div class="lane"><canvas class="roll vcanvas" tabindex="0"
      title="Clic: seleziona · Trascina: sposta · Bordo destro: durata · Doppio clic: aggiungi · Canc: elimina · ↑↓: semitono · Shift: senza griglia"></canvas></div>`;
  const canvas = row.querySelector('canvas');
  rolls[stem] = { canvas, row, rows: [], rowH: 8, color: t.color };
  row.querySelector('.syn').addEventListener('click', () => {
    if (state.synth.has(stem)) state.synth.delete(stem); else state.synth.add(stem);
    synthResync();
    refreshNotesHeads();
  });
  row.querySelector('.sco').addEventListener('click', () => openScore(stem));
  row.querySelector('.rst').addEventListener('click', () => restoreNotes(stem));
  setupRollEditing(stem, canvas);
  layoutRoll(stem);
  setTimeout(() => refreshNotesHeads(state.notes ? undefined
    : state.notesMissing ? 'Non ancora trascritte' : state.notesBusy ? 'Trascrizione in corso (~1 min)…' : 'Caricamento…'));
  return row;
}

function toggleNotesLane(stem) {
  if (state.showNotes.has(stem)) state.showNotes.delete(stem); else state.showNotes.add(stem);
  const r = rolls[stem];
  if (r) r.row.classList.toggle('hidden', !state.showNotes.has(stem));
  syncTrackButtons();
  layoutRoll(stem);
  requestRedraw();
}

/** Righe (altezze) visualizzate: intervallo delle note ± margine, o le 3 righe della batteria. */
function layoutRoll(stem) {
  const r = rolls[stem];
  if (!r) return;
  if (isDrums(stem)) {
    r.rows = DRUM_ROWS.map((d) => d.p);
    r.rowH = 30;
  } else {
    const notes = (state.notes && state.notes.tracks[stem]) || [];
    let lo = 48, hi = 72;
    if (notes.length) {
      lo = Math.min(...notes.map((n) => n.pitch)) + engine.pitch - 3;
      hi = Math.max(...notes.map((n) => n.pitch)) + engine.pitch + 3;
    }
    r.rows = [];
    for (let p = hi; p >= lo; p--) r.rows.push(p);
    r.rowH = Math.max(5, Math.min(12, Math.floor(300 / r.rows.length)));
  }
  // altezza minima per l'intestazione; le righe si allargano per riempirla
  const minH = 96;
  if (r.rows.length * r.rowH < minH) r.rowH = minH / r.rows.length;
  r.row.style.height = `${Math.round(r.rows.length * r.rowH) + 2}px`;
}

function drawAllRolls() {
  for (const stem of Object.keys(rolls)) if (state.showNotes.has(stem)) drawRoll(stem);
}

function lowerBound(notes, t) {
  let lo = 0, hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].start < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function drawRoll(stem) {
  const r = rolls[stem];
  const [ctx, w, h, dpr] = fitCanvas(r.canvas);
  const sl = tlEl().scrollLeft, z = state.zoom, k = dispK();
  const rh = r.rowH * dpr;
  // sfondo: tasti neri più scuri, righe dei Do evidenziate
  r.rows.forEach((p, i) => {
    if (isDrums(stem)) ctx.fillStyle = i % 2 ? '#161a21' : '#1a1e26';
    else ctx.fillStyle = BLACK.has(((p % 12) + 12) % 12) ? '#14171d' : '#1b1f27';
    ctx.fillRect(0, i * rh, w, rh);
    if (!isDrums(stem) && ((p % 12) + 12) % 12 === 0) {
      ctx.fillStyle = '#2c3240';
      ctx.fillRect(0, (i + 1) * rh - dpr, w, dpr);
    }
  });
  // griglia ritmica: battiti e battute
  const grid = state.notes && state.notes.grid;
  if (grid && grid.beats && grid.beats.length > 1) {
    const beats = grid.beats;
    const spacing = (beats[1] - beats[0]) * k * z;
    if (spacing >= 5) {
      const t0 = sl / z / k, t1 = (sl + w / dpr) / z / k;
      for (let i = Math.max(0, lowerBoundNum(beats, t0) - 1); i < beats.length && beats[i] <= t1; i++) {
        const bar = ((i - grid.downbeat) % gridBpb() + gridBpb()) % gridBpb() === 0;
        ctx.fillStyle = bar ? '#3a4152' : '#232833';
        ctx.fillRect(Math.round((beats[i] * k * z - sl) * dpr), 0, bar ? dpr * 1.5 : dpr, h);
      }
    }
  }
  if (!state.notes) return;
  const notes = state.notes.tracks[stem] || [];
  const rowOf = new Map(r.rows.map((p, i) => [p, i]));
  const t0 = sl / z / k - 10, t1 = (sl + w / dpr) / z / k;
  for (let i = lowerBound(notes, t0); i < notes.length && notes[i].start <= t1; i++) {
    const n = notes[i];
    const row = rowOf.get(shownPitch(stem, n.pitch));
    if (row == null) continue;
    const x = (n.start * k * z - sl) * dpr;
    const nw = Math.max(2 * dpr, (n.end - n.start) * k * z * dpr);
    if (x + nw < 0) continue;
    ctx.globalAlpha = 0.45 + 0.55 * (n.velocity / 127);
    ctx.fillStyle = r.color;
    ctx.fillRect(x, row * rh + dpr, nw, rh - 2 * dpr);
    ctx.globalAlpha = 1;
    if (state.selNote && state.selNote.note === n) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(x, row * rh + dpr, nw, rh - 2 * dpr);
    }
  }
  // etichette fisse a sinistra
  ctx.font = `${Math.min(10, r.rowH) * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8b93a5';
  r.rows.forEach((p, i) => {
    if (isDrums(stem)) ctx.fillText(DRUM_ROWS[i].label, 4 * dpr, (i + 0.5) * rh);
    else if (((p % 12) + 12) % 12 === 0 && r.rowH >= 5) ctx.fillText(`C${Math.floor(p / 12) - 1}`, 4 * dpr, (i + 0.5) * rh);
  });
}

function lowerBoundNum(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// --------------------------------------------------------------- griglia ritmica

/** Posizione in battiti (frazionaria) di un tempo originale, interpolando la griglia. */
function beatPos(t) {
  const b = state.notes && state.notes.grid && state.notes.grid.beats;
  if (!b || b.length < 2) return t * 2; // fallback 120 BPM
  const period = (b[b.length - 1] - b[0]) / (b.length - 1);
  if (t <= b[0]) return (t - b[0]) / period;
  if (t >= b[b.length - 1]) return b.length - 1 + (t - b[b.length - 1]) / period;
  const i = lowerBoundNum(b, t) - 1;
  return i + (t - b[i]) / (b[i + 1] - b[i]);
}

function beatTime(pos) {
  const b = state.notes && state.notes.grid && state.notes.grid.beats;
  if (!b || b.length < 2) return pos / 2;
  const period = (b[b.length - 1] - b[0]) / (b.length - 1);
  if (pos <= 0) return b[0] + pos * period;
  if (pos >= b.length - 1) return b[b.length - 1] + (pos - (b.length - 1)) * period;
  const i = Math.floor(pos);
  return b[i] + (pos - i) * (b[i + 1] - b[i]);
}

/** Aggancia un tempo originale alla griglia di sedicesimi. */
const snapTime = (t) => beatTime(Math.round(beatPos(t) * 4) / 4);

// ---------------------------------------------------------------------- modifica

function setupRollEditing(stem, canvas) {
  let drag = null;
  const at = (e) => {
    const r = rolls[stem];
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const t = (tlEl().scrollLeft + x) / state.zoom / dispK();
    const rowIdx = Math.min(r.rows.length - 1, Math.max(0, Math.floor(y / r.rowH)));
    return { x, t, rowIdx, shown: r.rows[rowIdx] };
  };
  const hit = (p) => {
    const notes = (state.notes && state.notes.tracks[stem]) || [];
    const pxPerSec = state.zoom * dispK();
    for (let i = lowerBound(notes, p.t - 30); i < notes.length && notes[i].start <= p.t + 0.02; i++) {
      const n = notes[i];
      if (shownPitch(stem, n.pitch) !== p.shown) continue;
      const endPad = Math.max(0, (4 - (n.end - n.start) * pxPerSec) / pxPerSec);
      if (p.t >= n.start - 0.01 && p.t <= n.end + endPad) {
        const edge = (n.end - p.t) * pxPerSec <= 6 && !isDrums(stem);
        return { n, edge };
      }
    }
    return null;
  };
  canvas.addEventListener('pointermove', (e) => {
    if (drag || !state.notes) return;
    const h = hit(at(e));
    canvas.style.cursor = h ? (h.edge ? 'ew-resize' : 'grab') : 'crosshair';
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.notes) return;
    const p = at(e);
    const h = hit(p);
    canvas.focus();
    if (!h) {
      state.selNote = null;
      requestRedraw();
      return;
    }
    e.preventDefault();
    state.selNote = { stem, note: h.n };
    drag = { p0: p, n: h.n, orig: { ...h.n }, mode: h.edge ? 'resize' : 'move', moved: false };
    canvas.setPointerCapture(e.pointerId);
    previewNote(stem, h.n.pitch);
    requestRedraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = at(e);
    const { n, orig } = drag;
    const free = e.shiftKey;
    if (drag.mode === 'move') {
      const len = orig.end - orig.start;
      let start = Math.max(0, orig.start + (p.t - drag.p0.t));
      if (!free) start = Math.max(0, snapTime(start));
      n.start = +start.toFixed(3);
      n.end = +(start + len).toFixed(3);
      const rows = rolls[stem].rows;
      const newPitch = isDrums(stem) ? p.shown : orig.pitch + (rows[drag.p0.rowIdx] - rows[p.rowIdx]) * -1;
      if (newPitch !== n.pitch && newPitch >= 0 && newPitch <= 127) {
        n.pitch = newPitch;
        previewNote(stem, n.pitch);
      }
    } else {
      let end = Math.max(orig.start + 0.03, p.t);
      if (!free) end = Math.max(orig.start + 0.03, snapTime(end));
      n.end = +end.toFixed(3);
    }
    drag.moved = true;
    requestRedraw();
  });
  const end = () => {
    if (!drag) return;
    if (drag.moved) {
      sortNotes(stem);
      saveNotes(stem);
    }
    drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    if (!state.notes) return;
    const p = at(e);
    if (hit(p)) return;
    const notes = state.notes.tracks[stem] || (state.notes.tracks[stem] = []);
    const start = e.shiftKey ? p.t : snapTime(p.t);
    const len = isDrums(stem) ? 0.1 : Math.max(0.05, beatTime(beatPos(start) + 1) - start);
    const pitch = isDrums(stem) ? p.shown : p.shown - engine.pitch;
    const n = { start: +start.toFixed(3), end: +(start + len).toFixed(3), pitch, velocity: 90 };
    notes.push(n);
    sortNotes(stem);
    state.selNote = { stem, note: n };
    previewNote(stem, pitch);
    saveNotes(stem);
    requestRedraw();
  });
  canvas.addEventListener('keydown', (e) => {
    const sel = state.selNote;
    if (!sel || sel.stem !== stem) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      const notes = state.notes.tracks[stem];
      const i = notes.indexOf(sel.note);
      if (i >= 0) notes.splice(i, 1);
      state.selNote = null;
      saveNotes(stem);
      requestRedraw();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isDrums(stem)) {
      e.preventDefault();
      e.stopPropagation();
      sel.note.pitch = Math.max(0, Math.min(127, sel.note.pitch + (e.key === 'ArrowUp' ? 1 : -1)));
      previewNote(stem, sel.note.pitch);
      saveNotes(stem);
      requestRedraw();
    }
  });
}

function sortNotes(stem) {
  state.notes.tracks[stem].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function saveNotes(stem) {
  const song = state.current;
  if (!state.notes.edited.includes(stem)) state.notes.edited.push(stem);
  refreshNotesHeads();
  clearTimeout(noteSaveTimers[stem]);
  noteSaveTimers[stem] = setTimeout(async () => {
    try {
      await api(`/api/songs/${song.id}/notes/${stem}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: state.notes.tracks[stem] }),
      });
    } catch (e) {
      alert(`Salvataggio note fallito: ${e.message}`);
    }
  }, 500);
}

async function restoreNotes(stem) {
  const song = state.current;
  if (!confirm(`Annullare le correzioni e ripristinare la trascrizione automatica di "${LABELS[stem] || stem}"?`)) return;
  clearTimeout(noteSaveTimers[stem]);
  try {
    const data = await api(`/api/songs/${song.id}/notes/${stem}/edits`, { method: 'DELETE' });
    if (state.current !== song) return;
    state.notes.tracks[stem] = data.tracks[stem];
    state.notes.edited = data.edited;
    state.selNote = null;
    refreshNotesHeads();
    layoutRoll(stem);
    requestRedraw();
  } catch (e) {
    alert(e.message);
  }
}

// ------------------------------------------------------------------------ synth

const SYNTH = {
  vocals: { type: 'sine', cutoff: 4000, a: 0.02, r: 0.08 },
  bass: { type: 'triangle', cutoff: 900, a: 0.005, r: 0.06 },
  guitar: { type: 'sawtooth', cutoff: 2200, a: 0.004, r: 0.15 },
  piano: { type: 'triangle', cutoff: 3500, a: 0.003, r: 0.25, decay: true },
  other: { type: 'square', cutoff: 1800, a: 0.01, r: 0.12 },
};
const voices = new Set();
let noiseBuf = null, synthTimer = null, schedHorizon = null;

function noiseBuffer(ctx) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

function trackVolume(stem) {
  const t = engine.tracks.find((x) => x.name === stem);
  return t ? t.volume : 1;
}

/** Suona una nota sintetica: `when` in tempo AudioContext, durata in secondi reali. */
function playVoice(stem, pitch, velocity, when, dur) {
  const ctx = engine.ctx;
  const vol = (velocity / 127) * 0.22 * trackVolume(stem);
  const out = ctx.createGain();
  out.connect(engine.master);
  const nodes = [out];
  if (isDrums(stem)) {
    if (pitch === 36) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, when);
      o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
      out.gain.setValueAtTime(vol * 3, when);
      out.gain.exponentialRampToValueAtTime(0.001, when + 0.25);
      o.connect(out);
      o.start(when);
      o.stop(when + 0.3);
      nodes.push(o);
    } else {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const f = ctx.createBiquadFilter();
      f.type = pitch === 42 ? 'highpass' : 'bandpass';
      f.frequency.value = pitch === 42 ? 7000 : 1800;
      const len = pitch === 42 ? 0.05 : 0.15;
      out.gain.setValueAtTime(vol * (pitch === 42 ? 1.2 : 2.2), when);
      out.gain.exponentialRampToValueAtTime(0.001, when + len);
      src.connect(f).connect(out);
      src.start(when, Math.random() * 0.5);
      src.stop(when + len + 0.02);
      nodes.push(src, f);
    }
  } else {
    const cfg = SYNTH[stem] || SYNTH.other;
    const o = ctx.createOscillator();
    o.type = cfg.type;
    o.frequency.value = 440 * Math.pow(2, (pitch + engine.pitch - 69) / 12);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cfg.cutoff;
    out.gain.setValueAtTime(0, when);
    out.gain.linearRampToValueAtTime(vol, when + cfg.a);
    const off = when + Math.max(dur, cfg.a + 0.02);
    if (cfg.decay) out.gain.setTargetAtTime(vol * 0.3, when + cfg.a, 0.3);
    out.gain.setValueAtTime(cfg.decay ? vol * 0.3 : vol, off);
    out.gain.linearRampToValueAtTime(0, off + cfg.r);
    o.connect(f).connect(out);
    o.start(when);
    o.stop(off + cfg.r + 0.02);
    nodes.push(o, f);
  }
  const v = { nodes, end: when + dur + 0.5 };
  voices.add(v);
  nodes[nodes.length - 1].onended = () => {
    voices.delete(v);
    out.disconnect();
  };
}

function previewNote(stem, pitch) {
  if (!engine.ctx) return;
  engine.ctx.resume();
  playVoice(stem, pitch, 100, engine.ctx.currentTime + 0.01, isDrums(stem) ? 0.1 : 0.35);
}

function synthStopAll() {
  for (const v of voices) {
    for (const n of v.nodes) {
      try { if (n.stop) n.stop(); } catch {}
      try { n.disconnect(); } catch {}
    }
  }
  voices.clear();
  schedHorizon = null;
}

function synthResync() {
  synthStopAll();
}

/** Scheduler: ogni 40 ms programma note del synth e click dei prossimi 200 ms (look-ahead). */
function synthSchedule() {
  if (!engine.playing || !state.notes || !(state.synth.size || state.click)) {
    schedHorizon = null;
    return;
  }
  const pos = engine.position();
  // durante il pre-conteggio il tempo "musicale" è fermo: si programma rispetto all'avvio reale
  const now = Math.max(engine.ctx.currentTime, engine.t0 || 0);
  let from = schedHorizon;
  // salto (seek, loop) → riparte dalla posizione attuale
  if (from == null || pos < from - 0.3 || pos > from + 0.1) from = pos;
  let to = pos + 0.2;
  if (engine.loop && to > engine.loop.end) to = engine.loop.end;
  if (engine.stopAt != null) to = Math.min(to, engine.stopAt);
  const k = dispK();
  for (const stem of state.synth) {
    const notes = state.notes.tracks[stem] || [];
    for (let i = lowerBound(notes, from / k); i < notes.length; i++) {
      const n = notes[i];
      const ds = n.start * k;
      if (ds >= to) break;
      if (ds < from) continue;
      playVoice(stem, n.pitch, n.velocity, now + (ds - pos), (n.end - n.start) * k);
    }
  }
  if (state.click) {
    for (const b of clickTimes(from, to)) playClick(now + (b.t - pos), b.accent);
  }
  schedHorizon = to;
}

// ------------------------------------------------------- click intelligente

/** Ha senso solo se il ritmo del brano è stato analizzato. */
const hasGrid = () => !!(state.notes && state.notes.grid && state.notes.grid.beats && state.notes.grid.beats.length > 1);

/**
 * Battiti (tempo della timeline corrente) in [from, to): seguono la griglia rilevata,
 * quindi anche le variazioni di tempo di un'esecuzione dal vivo; oltre i bordi si estrapola.
 */
function clickTimes(from, to) {
  if (!hasGrid()) return [];
  const k = dispK(), db = state.notes.grid.downbeat, bpb = gridBpb();
  const out = [];
  for (let i = Math.ceil(beatPos(from / k) - 1e-6); ; i++) {
    const t = beatTime(i) * k;
    if (t >= to) break;
    if (t >= from - 1e-6 && t >= 0) out.push({ t, accent: (((i - db) % bpb) + bpb) % bpb === 0 });
    if (out.length > 5000) break;
  }
  return out;
}

const clickNodes = new Set();
function playClick(when, accent, gain = state.clickVol) {
  const ctx = engine.ctx;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = accent ? 1760 : 1175;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime((accent ? 0.75 : 0.5) * gain, when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
  o.connect(g).connect(ctx.destination); // fuori dal master: il volume del brano non lo cambia
  o.start(when);
  o.stop(when + 0.08);
  const v = { o, g };
  clickNodes.add(v);
  o.onended = () => { clickNodes.delete(v); g.disconnect(); };
}

// ------------------------------------------------------------- pre-conteggio

let countTimers = [];

/** Dati del pre-conteggio per una partenza da `p` (tempo timeline): durata e colpi. */
function countInPlan(p, bars) {
  const k = dispK();
  const iNext = Math.ceil(beatPos(p / k) - 1e-3);         // primo battito della musica dopo p
  const bNext = beatTime(iNext) * k;
  const period = (beatTime(iNext) - beatTime(iNext - 1)) * k;
  const bpb = gridBpb();
  const n = bars * bpb;
  const lead = Math.max(0, bNext - p);                    // musica prima del primo battito
  const delay = Math.max(0, n * period - lead);           // attesa prima di far partire l'audio
  // colpi: l'ultimo cade un battito prima di bNext, così il "4" porta dritto sul battito
  const beats = [];
  for (let j = n; j >= 1; j--) beats.push({ rel: delay + lead - j * period, num: ((n - j) % bpb) + 1 });
  return { delay, beats };
}

/** Avvia la riproduzione, preceduta dal pre-conteggio se attivo. */
function playWithCountIn() {
  if (!engine.tracks.length || engine.playing) return;
  if (!state.countIn || !hasGrid()) {
    engine.play();
    return;
  }
  engine.ctx.resume();
  const plan = countInPlan(engine.startOffset(), state.countIn);
  engine.play(plan.delay);
  const start = engine.t0 - plan.delay;
  for (const b of plan.beats) {
    const when = start + b.rel;
    playClick(when, b.num === 1, Math.max(0.6, state.clickVol));
    countTimers.push(setTimeout(() => showCount(b.num), Math.max(0, (when - engine.ctx.currentTime) * 1000)));
  }
  countTimers.push(setTimeout(() => showCount(null), Math.max(0, (engine.t0 - engine.ctx.currentTime) * 1000)));
}

function showCount(n) {
  const el = $('#countin');
  el.classList.toggle('hidden', n == null);
  if (n != null) {
    el.textContent = n;
    el.classList.remove('pulse');
    void el.offsetWidth; // riavvia l'animazione
    el.classList.add('pulse');
  }
}

function countInStop() {
  countTimers.forEach(clearTimeout);
  countTimers = [];
  showCount(null);
  for (const v of clickNodes) {
    try { v.o.stop(); } catch {}
    try { v.g.disconnect(); } catch {}
  }
  clickNodes.clear();
}

/** Opzioni click/pre-conteggio per l'esportazione (tempi relativi all'inizio del file). */
function exportClickOptions(range) {
  const withClick = $('#exp-click').checked && hasGrid();
  const bars = hasGrid() ? Number($('#exp-countin').value) : 0;
  if (!withClick && !bars) return {};
  const s = range ? range.start : 0, e = range ? range.end : engine.duration;
  const times = [], accents = [];
  let preRoll = 0;
  if (bars) {
    const plan = countInPlan(s, bars);
    preRoll = plan.delay;
    for (const b of plan.beats) { times.push(b.rel); accents.push(b.num === 1); }
  }
  if (withClick) {
    for (const b of clickTimes(s, e)) { times.push(b.t - s + preRoll); accents.push(b.accent); }
  }
  return {
    pre_roll: +preRoll.toFixed(4),
    click: { times: times.map((t) => +Math.max(0, t).toFixed(4)), accents, gain: state.clickVol },
  };
}

function setupClick() {
  try {
    state.click = localStorage.getItem('noises.click') === '1';
    state.clickVol = Number(localStorage.getItem('noises.clickVol') || 0.8);
    state.countIn = Number(localStorage.getItem('noises.countIn') || 0);
  } catch {
    state.click = false; state.clickVol = 0.8; state.countIn = 0;
  }
  const save = () => {
    try {
      localStorage.setItem('noises.click', state.click ? '1' : '0');
      localStorage.setItem('noises.clickVol', String(state.clickVol));
      localStorage.setItem('noises.countIn', String(state.countIn));
    } catch {}
  };
  $('#click').classList.toggle('on', state.click);
  $('#click-vol').value = state.clickVol;
  $('#countin-sel').value = String(state.countIn);
  $('#click').addEventListener('click', () => {
    state.click = !state.click;
    $('#click').classList.toggle('on', state.click);
    schedHorizon = null;
    save();
  });
  $('#click-vol').addEventListener('input', (e) => { state.clickVol = Number(e.target.value); save(); });
  $('#countin-sel').addEventListener('change', (e) => { state.countIn = Number(e.target.value); save(); });
}

/** Abilita i comandi del ritmo quando la griglia è disponibile. */
function updateRhythmControls() {
  const ok = hasGrid();
  for (const id of ['#click', '#countin-sel', '#meter-btn']) {
    $(id).disabled = !ok;
    $(id).classList.toggle('hidden', !ok && (state.notesMissing || state.notesBusy));
  }
  $('#click-vol').classList.toggle('hidden', !ok && (state.notesMissing || state.notesBusy));
  const btn = $('#analyze-notes');
  btn.classList.toggle('hidden', ok || !(state.notesMissing || state.notesBusy));
  btn.disabled = !!state.notesBusy;
  btn.textContent = state.notesBusy ? '⏳ Analisi in corso (~1 min)…' : '🎼 Analizza ritmo e note';
  if (ok) {
    const g = state.notes.grid;
    $('#bpm').textContent = `${Math.round(g.bpm * engine.tempo / 100)} BPM`;
    $('#meter-btn').textContent = `${(g.time_signature || [4, 4]).join('/')} ▾`;
  } else {
    $('#bpm').textContent = '';
  }
}

// ------------------------------------------------------------------ metro

function currentRhythm() {
  const g = state.notes.grid;
  return { ...(g.rhythm || { time_signature: [4, 4], offset: 0, multiplier: 1 }) };
}

async function setRhythm(patch) {
  const song = state.current;
  const r = { ...currentRhythm(), ...patch };
  try {
    const grid = await api(`/api/songs/${song.id}/rhythm`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r),
    });
    if (state.current !== song || !state.notes) return;
    state.notes.grid = grid;
    schedHorizon = null;
    updateRhythmControls();
    renderMeterMenu();
    requestRedraw();
    if (!$('#score-view').classList.contains('hidden')) loadScore();
  } catch (e) {
    alert(e.message);
  }
}

function renderMeterMenu() {
  if (!hasGrid()) return;
  const r = currentRhythm();
  const ts = r.time_signature.join('/');
  document.querySelectorAll('#meter-menu [data-ts]').forEach((b) => b.classList.toggle('on', b.dataset.ts === ts));
  document.querySelectorAll('#meter-menu [data-mult]').forEach((b) => b.classList.toggle('on', Number(b.dataset.mult) === r.multiplier));
}

function setupMeter() {
  const menu = $('#meter-menu');
  $('#meter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    renderMeterMenu();
    menu.classList.remove('hidden');
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${r.bottom + 4}px`;
  });
  menu.querySelectorAll('[data-ts]').forEach((b) => b.addEventListener('click', () =>
    setRhythm({ time_signature: b.dataset.ts.split('/').map(Number), offset: 0 })));
  menu.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () =>
    setRhythm({ offset: (((currentRhythm().offset + Number(b.dataset.shift)) % gridBpb()) + gridBpb()) % gridBpb() })));
  menu.querySelectorAll('[data-mult]').forEach((b) => b.addEventListener('click', () =>
    setRhythm({ multiplier: Number(b.dataset.mult), offset: 0 })));
  document.addEventListener('pointerdown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target.id !== 'meter-btn') menu.classList.add('hidden');
  });
  $('#analyze-notes').addEventListener('click', () => state.current && runTranscription(state.current));
}

// ------------------------------------------------------------------------- MIDI

const GM_PROGRAM = { vocals: 53, bass: 33, guitar: 27, piano: 0, other: 48 };

function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

function midiTrack(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out = [];
  let last = 0;
  for (const ev of events) {
    out.push(...vlq(Math.max(0, ev.tick - last)), ...ev.data);
    last = Math.max(last, ev.tick);
  }
  out.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(out.length), ...out];
}

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const textEvent = (type, s) => {
  const b = [...new TextEncoder().encode(s)];
  return [0xff, type, ...vlq(b.length), ...b];
};

/**
 * MIDI type 1: una traccia per strumento + mappa dei tempi ricavata dai battiti rilevati,
 * così le battute del sequencer coincidono con quelle del brano e i tempi restano esatti.
 */
function exportMidi(filename, range) {
  if (!state.notes) {
    alert('La trascrizione non è ancora pronta.');
    return;
  }
  const PPQ = 480;
  const grid = state.notes.grid;
  const k = dispK();
  // inizio della battuta che contiene l'istante 0 (come nello spartito)
  const bpb = gridBpb(), bq = gridBq();
  const b0 = Math.floor((beatPos(range ? range.start / k : 0) - grid.downbeat) / bpb) * bpb + grid.downbeat;
  const tickOf = (tOrig) => Math.round((beatPos(tOrig) - b0) * PPQ * bq);
  const t0 = range ? range.start / k : 0, t1 = range ? range.end / k : Infinity;

  const tempoEv = [{ tick: 0, order: 0, data: textEvent(0x03, state.current.name) },
    { tick: 0, order: 0, data: [0xff, 0x58, 4, ...(() => {
      const ts = grid.time_signature || [4, 4];
      return [ts[0], Math.round(Math.log2(ts[1])), 24, 8];
    })()] }];
  const beats = grid.beats || [];
  const period = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
  // il tempo MIDI è in microsecondi per quarto: un battito vale `bq` quarti
  const tempoAt = (sec) => [0xff, 0x51, 3, ...u32(Math.round((sec * k * 1e6) / bq)).slice(1)];
  tempoEv.push({ tick: 0, order: 1, data: tempoAt(beats.length > 1 ? beats[1] - beats[0] : period) });
  for (let i = 0; i + 1 < beats.length; i++) {
    const tick = Math.round((i - b0) * PPQ * bq);
    if (tick >= 0) tempoEv.push({ tick, order: 1, data: tempoAt(beats[i + 1] - beats[i]) });
  }
  const chunks = [midiTrack(tempoEv)];

  const active = activeStems().map((t) => t.name).filter((s) => (state.notes.tracks[s] || []).length);
  if (!active.length) {
    alert('Nessuna traccia attiva con note trascritte.');
    return;
  }
  let ch = 0;
  for (const stem of active) {
    const drums = isDrums(stem);
    const channel = drums ? 9 : (ch === 9 ? ++ch : ch);
    if (!drums) ch++;
    const evs = [{ tick: 0, order: 0, data: textEvent(0x03, LABELS[stem] || stem) }];
    if (!drums) evs.push({ tick: 0, order: 1, data: [0xc0 | channel, GM_PROGRAM[stem] ?? 0] });
    for (const n of state.notes.tracks[stem]) {
      if (n.start < t0 || n.start >= t1) continue;
      const p = Math.max(0, Math.min(127, drums ? n.pitch : n.pitch + engine.pitch));
      const on = tickOf(n.start);
      const off = Math.max(on + 1, tickOf(Math.min(n.end, t1)));
      evs.push({ tick: on, order: 3, data: [0x90 | channel, p, n.velocity] });
      evs.push({ tick: off, order: 2, data: [0x80 | channel, p, 0] });
    }
    chunks.push(midiTrack(evs));
  }
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, chunks.length, (PPQ >> 8) & 255, PPQ & 255];
  const bytes = new Uint8Array([...header, ...chunks.flat()]);
  downloadBlob(new Blob([bytes], { type: 'audio/midi' }), filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function setupNotes() {
  synthTimer = setInterval(synthSchedule, 40);
  setupClick();
  setupMeter();
}
