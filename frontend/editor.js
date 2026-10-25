'use strict';
// Editor multitraccia: selezione delle tracce, gruppi, ordine, modifica delle clip, annulla/ripeti.
//
// Ogni traccia è un insieme di clip sulla timeline (secondi alla velocità originale).
// Le tracce separate di un brano nascono raggruppate: si spostano e si tagliano insieme.

const EDGE_PX = 7;
const GROUP_COLORS = ['#7c5cff', '#2bd47d', '#ff8a3d', '#4fc3f7', '#ff5c7a', '#c49bff', '#f5c542'];
let layoutTimer = null;
let toastTimer = null;


const deep = (x) => JSON.parse(JSON.stringify(x));
const ek = () => 100 / engine.tempo;
const trackByName = (n) => engine.tracks.find((t) => t.name === n);
const groupOf = (name) => state.groups.find((g) => g.tracks.includes(name)) || null;
const isAnchored = () => false; // modello precedente: nei progetti nessun gruppo è ancorato
const trackLabel = (t) => trackTitle(t);
const groupColor = (g) => GROUP_COLORS[[...g.id].reduce((a, c) => a + c.charCodeAt(0), 0) % GROUP_COLORS.length];

/** Tracce che si muovono insieme a `t` (il suo gruppo, o solo lei). */
function peersOf(t) {
  const g = groupOf(t.name);
  return g ? g.tracks.map(trackByName).filter(Boolean) : [t];
}


/** Nei progetti ogni traccia ha clip esplicite (nessun percorso "traccia intera"). */
function isDefaultClips() {
  return false;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ------------------------------------------------------------------ disposizione

/** Prepara gruppi, selezione e cronologia all'apertura di un progetto. */
function initLayout(project) {
  state.groups = deep(project.groups || []).map((g) => ({ ...g, anchored: false }));
  state.undo = [];
  state.redo = [];
  state.selTracks = new Set();
  state.selClip = null;
  updateEditUI();
}




function cleanGroups() {
  const live = new Set(engine.tracks.map((t) => t.name));
  state.groups = state.groups
    .map((g) => ({ ...g, tracks: g.tracks.filter((n) => live.has(n)) }))
    .filter((g) => g.tracks.length >= 2);
}

function saveLayout() {
  saveProject();
}

// ------------------------------------------------------------ annulla / ripeti

function snapshot() {
  return JSON.stringify({
    tracks: engine.tracks.map((t) => ({ name: t.name, label: t.label || '', song: t.song, part: t.part, clips: t.clips })),
    groups: state.groups, markers: state.markers || [],
  });
}

/** Da chiamare PRIMA di ogni modifica annullabile. */
function pushUndo(label) {
  if (!state.current || !engine.tracks.length) return;
  state.undo.push({ label, snap: snapshot() });
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  updateEditUI();
}

async function restoreSnapshot(json) {
  const s = JSON.parse(json);
  const project = state.current;
  const wanted = new Set(s.tracks.map((t) => t.name));
  // tracce nate dopo lo stato da ripristinare
  for (const t of [...engine.tracks]) if (!wanted.has(t.name)) engine.removeTrack(t);
  // tracce eliminate dopo: l'audio si riscarica dalla libreria
  const missing = s.tracks.filter((st) => !trackByName(st.name) && songById(st.song));
  if (missing.length) setLoader('Ripristino delle tracce…', '', null);
  try {
    for (const st of missing) {
      const r = await fetch(sourceUrl(st.song, st.part));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const audio = await decodeToArrays(await r.arrayBuffer());
      if (state.current !== project) return;
      engine.addTrack({ ...st, ...audio });
    }
  } catch (e) {
    toast(`Ripristino incompleto: ${e.message}`);
  } finally {
    setLoader(null);
  }
  for (const st of s.tracks) {
    const t = trackByName(st.name);
    if (!t) continue;
    t.clips = deep(st.clips);
    t.label = st.label || '';
    engine.setClips(t);
  }
  const order = new Map(s.tracks.map((t, i) => [t.name, i]));
  engine.tracks.sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
  state.groups = s.groups;
  state.markers = s.markers;
  state.selClip = null;
  engine.updateLength();
  if (state.refTrack && !trackByName(state.refTrack) && engine.tracks.length) setReference(engine.tracks[0], true);
  saveProject();
  layoutTimeline();
  buildTracks();
}

async function undo() {
  const e = state.undo.pop();
  if (!e) return;
  state.redo.push({ label: e.label, snap: snapshot() });
  await restoreSnapshot(e.snap);
  toast(`Annullato: ${e.label}`);
  updateEditUI();
}

async function redo() {
  const e = state.redo.pop();
  if (!e) return;
  state.undo.push({ label: e.label, snap: snapshot() });
  await restoreSnapshot(e.snap);
  toast(`Ripetuto: ${e.label}`);
  updateEditUI();
}

// -------------------------------------------------------------------- selezione

function selectTracks(names, additive) {
  if (!additive) state.selTracks = new Set();
  const all = names.every((n) => state.selTracks.has(n));
  for (const n of names) {
    if (additive && all) state.selTracks.delete(n);
    else state.selTracks.add(n);
  }
  syncSelection();
}

/** Clic su una traccia: seleziona lei e il suo gruppo (Ctrl/Shift: aggiunge o toglie);
 *  accordi, note e click passano al suo brano. */
function selectTrack(t, additive) {
  selectTracks(peersOf(t).map((x) => x.name), additive);
  if (!additive && typeof setReference === 'function') setReference(t);
}

function clearTrackSelection() {
  state.selTracks = new Set();
  state.selClip = null;
  syncSelection();
}

function syncSelection() {
  for (const t of engine.tracks) if (t.row) t.row.classList.toggle('selected', state.selTracks.has(t.name));
  updateEditUI();
  requestRedraw();
}

function updateEditUI() {
  const u = state.undo[state.undo.length - 1], r = state.redo[state.redo.length - 1];
  if (!$('#undo')) return;
  $('#undo').disabled = !u;
  $('#redo').disabled = !r;
  $('#undo').title = u ? `Annulla: ${u.label} (Ctrl+Z)` : 'Niente da annullare';
  $('#redo').title = r ? `Ripeti: ${r.label} (Ctrl+Y)` : 'Niente da ripetere';
  const sel = [...state.selTracks];
  const groups = new Set(sel.map((n) => groupOf(n)).filter(Boolean));
  const oneGroup = groups.size === 1 && [...groups][0].tracks.every((n) => state.selTracks.has(n)) && sel.every((n) => groupOf(n));
  $('#group-btn').disabled = sel.length < 2 || oneGroup;
  $('#ungroup-btn').disabled = !groups.size;
  $('#sel-tracks').textContent = sel.length ? `${sel.length} ${sel.length === 1 ? 'traccia selezionata' : 'tracce selezionate'}` : '';
}

// ------------------------------------------------------------------------ gruppi

function groupSelected() {
  const names = engine.tracks.map((t) => t.name).filter((n) => state.selTracks.has(n));
  if (names.length < 2) return;
  pushUndo('Raggruppa');
  state.groups.forEach((g) => { g.tracks = g.tracks.filter((n) => !names.includes(n)); });
  const n = state.groups.filter((g) => !g.anchored).length + 1;
  state.groups.push({ id: `g${newClipId()}`, name: `Gruppo ${n}`, tracks: names, anchored: false });
  cleanGroups();
  saveLayout();
  buildTracks();
  toast(`Creato il ${state.groups[state.groups.length - 1].name}`);
}

function ungroupSelected() {
  const groups = new Set([...state.selTracks].map((n) => groupOf(n)).filter(Boolean));
  if (!groups.size) return;
  pushUndo('Separa gruppo');
  state.groups = state.groups.filter((g) => !groups.has(g));
  saveLayout();
  buildTracks();
  toast('Gruppo separato: le tracce ora si modificano singolarmente');
}

// ------------------------------------------------------------------------ ordine

function moveSelectedTracks(dir) {
  const sel = engine.tracks.filter((t) => state.selTracks.has(t.name));
  if (!sel.length) return;
  const list = engine.tracks;
  const idx = sel.map((t) => list.indexOf(t));
  if ((dir < 0 && Math.min(...idx) === 0) || (dir > 0 && Math.max(...idx) === list.length - 1)) return;
  pushUndo('Sposta traccia');
  const order = dir < 0 ? idx.sort((a, b) => a - b) : idx.sort((a, b) => b - a);
  for (const i of order) [list[i], list[i + dir]] = [list[i + dir], list[i]];
  saveLayout();
  buildTracks();
}

function moveTrackTo(t, index) {
  const list = engine.tracks;
  const from = list.indexOf(t);
  if (from < 0 || index === from || index === from + 1) return;
  pushUndo('Sposta traccia');
  list.splice(from, 1);
  list.splice(index > from ? index - 1 : index, 0, t);
  saveLayout();
  buildTracks();
}

function scrollTrackIntoView(t) {
  if (!t.row) return;
  const tl = tlEl(), rr = t.row.getBoundingClientRect(), tr = tl.getBoundingClientRect();
  if (rr.bottom > tr.bottom) tl.scrollTop += rr.bottom - tr.bottom + 20;
  else if (rr.top < tr.top + 92) tl.scrollTop -= tr.top + 92 - rr.top;
}

/** Riordino trascinando la maniglia ⠿ dell'intestazione. */
function setupGrip(t, row) {
  const grip = row.querySelector('.grip');
  if (!grip) return;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    row.classList.add('dragging');
    let target = null;
    const marker = $('#reorder-line');
    const move = (ev) => {
      const rows = engine.tracks.map((x) => x.row).filter(Boolean);
      let idx = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { idx = i; break; }
      }
      target = idx;
      const ref = rows[Math.min(idx, rows.length - 1)].getBoundingClientRect();
      const inner = $('#tl-inner').getBoundingClientRect();
      marker.style.top = `${(idx < rows.length ? ref.top : ref.bottom) - inner.top - 1}px`;
      marker.classList.remove('hidden');
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      row.classList.remove('dragging');
      marker.classList.add('hidden');
      if (target != null) moveTrackTo(t, target);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}

// ------------------------------------------------------------------ clip

/** Clip delle altre tracce del gruppo che corrispondono a `c` (stessi confini, o sovrapposte). */
function alignedClips(t, c) {
  const out = [];
  const end = c.start + c.duration;
  for (const p of peersOf(t)) {
    if (p === t) continue;
    let m = p.clips.filter((x) => Math.abs(x.start - c.start) < 0.002 && Math.abs(x.start + x.duration - end) < 0.002);
    if (!m.length) m = p.clips.filter((x) => x.start < end - 0.002 && x.start + x.duration > c.start + 0.002);
    for (const x of m) out.push({ t: p, c: x });
  }
  return out;
}

function clipsChanged(tracks) {
  let relayout = false;
  for (const t of new Set(tracks)) {
    t.clips.sort((a, b) => a.start - b.start);
    if (engine.setClips(t)) relayout = true;
  }
  saveLayout();
  if (relayout) layoutTimeline();
  requestRedraw();
}

function splitClip(t, c, at) {
  if (at <= c.start + 0.02 || at >= c.start + c.duration - 0.02) return false;
  t.clips.push({ id: newClipId(), start: at, offset: c.offset + (at - c.start), duration: c.start + c.duration - at });
  c.duration = at - c.start;
  return true;
}

/** Taglio (X): solo nelle tracce selezionate, nel punto della testina. */
function splitSelected() {
  const tracks = engine.tracks.filter((t) => state.selTracks.has(t.name));
  if (!tracks.length) { toast('Seleziona le tracce da tagliare (clic sul nome della traccia)'); return; }
  const at = engine.position() / ek();
  const hits = tracks.filter((t) => t.clips.some((c) => at > c.start + 0.02 && at < c.start + c.duration - 0.02));
  if (!hits.length) { toast('Nessuna clip sotto la testina nelle tracce selezionate'); return; }
  pushUndo('Taglia');
  for (const t of hits) for (const c of [...t.clips]) splitClip(t, c, at);
  clipsChanged(hits);
  toast(`Taglio su ${hits.length} ${hits.length === 1 ? 'traccia' : 'tracce'}`);
}

/** Canc: elimina la clip selezionata (e quelle corrispondenti nel gruppo). */
function deleteSelectedClip() {
  const sel = state.selClip;
  const t = sel && trackByName(sel.name);
  const c = t && t.clips.find((x) => x.id === sel.cid);
  if (!c) return false;
  pushUndo('Elimina parte');
  const victims = [{ t, c }, ...alignedClips(t, c)];
  for (const v of victims) v.t.clips = v.t.clips.filter((x) => x !== v.c);
  state.selClip = null;
  clipsChanged(victims.map((v) => v.t));
  return true;
}

function deleteTrack(t) {
  pushUndo('Elimina traccia');
  engine.removeTrack(t);
  state.selTracks.delete(t.name);
  if (state.selClip && state.selClip.name === t.name) state.selClip = null;
  cleanGroups();
  if (state.refTrack === t.name && engine.tracks.length) setReference(engine.tracks[0], true);
  saveLayout();
  layoutTimeline();
  buildTracks();
  toast(`Traccia "${trackLabel(t)}" eliminata — Ctrl+Z per annullare`);
}

function clipAt(t, clientX) {
  const time = timeAt(clientX) / ek();
  const pxPerSec = state.zoom * ek();
  for (const c of t.clips) {
    const left = (time - c.start) * pxPerSec, right = (c.start + c.duration - time) * pxPerSec;
    if (left >= -EDGE_PX && right >= -EDGE_PX) {
      return { c, time, mode: left <= EDGE_PX ? 'left' : right <= EDGE_PX ? 'right' : 'move' };
    }
  }
  return { c: null, time };
}

function snapEdit(t, free) {
  if (free || typeof hasGrid !== 'function' || !hasGrid()) return Math.max(0, t);
  const a = refAnchor();
  return Math.max(0, beatTime(Math.round(beatPos(t - a))) + a);
}

/** Tracce libere (non ancorate): trascina per spostare, bordi per accorciare, gruppo compreso. */
function setupClipCanvas(t) {
  const canvas = t.canvas;
  let drag = null;
  canvas.addEventListener('pointermove', (e) => {
    if (drag) return;
    const hit = clipAt(t, e.clientX);
    canvas.style.cursor = !hit.c ? 'pointer' : hit.mode === 'move' ? 'grab' : 'ew-resize';
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const hit = clipAt(t, e.clientX);
    if (!hit.c) return; // spazio vuoto: selezione dell'intervallo / posizionamento (timeline)
    e.stopPropagation();
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!additive || !state.selTracks.has(t.name)) selectTrack(t, additive);
    state.selClip = { name: t.name, cid: hit.c.id };
    const linked = hit.mode === 'move' ? alignedClips(t, hit.c) : alignedClips(t, hit.c).filter((v) =>
      Math.abs(v.c.start - hit.c.start) < 0.002 && Math.abs(v.c.duration - hit.c.duration) < 0.002);
    drag = { mode: hit.mode, t0: hit.time, items: [{ t, c: hit.c }, ...linked].map((v) => ({ ...v, orig: { ...v.c } })), moved: false, undone: false };
    canvas.setPointerCapture(e.pointerId);
    requestRedraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const time = timeAt(e.clientX) / ek();
    if (!drag.moved && Math.abs(time - drag.t0) * state.zoom * ek() < 3) return;
    if (!drag.undone) { pushUndo(drag.mode === 'move' ? 'Sposta clip' : 'Accorcia clip'); drag.undone = true; }
    const free = e.shiftKey;
    const main = drag.items[0];
    if (drag.mode === 'move') {
      const delta = snapEdit(main.orig.start + (time - drag.t0), free) - main.orig.start;
      const minStart = Math.min(...drag.items.map((v) => v.orig.start));
      const d = Math.max(delta, -minStart);
      for (const v of drag.items) v.c.start = +(v.orig.start + d).toFixed(3);
    } else if (drag.mode === 'left') {
      const end = main.orig.start + main.orig.duration;
      let s = snapEdit(time, free);
      s = Math.min(end - 0.05, Math.max(s, ...drag.items.map((v) => v.orig.start - v.orig.offset)));
      for (const v of drag.items) {
        const d = s - v.orig.start;
        v.c.start = +s.toFixed(3);
        v.c.offset = +(v.orig.offset + d).toFixed(3);
        v.c.duration = +(v.orig.duration - d).toFixed(3);
      }
    } else {
      let e2 = snapEdit(time, free);
      const maxEnd = Math.min(...drag.items.map((v) => v.orig.start + (srcLength(v.t) - v.orig.offset)));
      e2 = Math.max(main.orig.start + 0.05, Math.min(e2, maxEnd));
      for (const v of drag.items) v.c.duration = +(e2 - v.orig.start).toFixed(3);
    }
    drag.moved = true;
    for (const v of drag.items) engine.setClips(v.t);
    requestRedraw();
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) clipsChanged(d.items.map((v) => v.t));
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

/** Durata del file sorgente della traccia. */
function srcLength(t) {
  return t.srcDuration;
}

// --------------------------------------------------------------------- disegno

/** Traccia a clip: sfondo e contorno per clip, forma d'onda della parte di file usata. */
function drawClipTrack(t) {
  const [ctx, w, h, dpr] = fitCanvas(t.canvas);
  const sl = tlEl().scrollLeft, z = state.zoom, k = ek();
  const bps = engine.sr / PEAK_BLOCK;
  const mid = h / 2;
  const color = trackColor(t);
  for (const c of t.clips) {
    const x0 = (c.start * k * z - sl) * dpr;
    const x1 = ((c.start + c.duration) * k * z - sl) * dpr;
    if (x1 < 0 || x0 > w) continue;
    const sel = state.selClip && state.selClip.name === t.name && state.selClip.cid === c.id;
    ctx.fillStyle = sel ? '#ffffff26' : '#ffffff10';
    ctx.fillRect(x0, 2 * dpr, x1 - x0, h - 4 * dpr);
    ctx.fillStyle = color;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
      const t0 = (sl + x / dpr) / z / k, t1 = (sl + (x + 1) / dpr) / z / k;
      const b0 = Math.max(0, Math.floor((t0 - c.start + c.offset) * bps));
      const b1 = Math.max(b0 + 1, Math.floor((t1 - c.start + c.offset) * bps));
      let peak = 0;
      const stride = Math.max(1, Math.floor((b1 - b0) / 64));
      for (let i = b0; i < b1 && i < t.peaks.length; i += stride) if (t.peaks[i] > peak) peak = t.peaks[i];
      const y = Math.max(dpr * 0.5, peak * (mid - 4 * dpr) * 0.95);
      ctx.fillRect(x, mid - y, 1, y * 2);
    }
    ctx.strokeStyle = sel ? '#fff' : '#9aa3b5aa';
    ctx.lineWidth = (sel ? 2 : 1) * dpr;
    ctx.strokeRect(x0 + 0.5 * dpr, 2 * dpr, x1 - x0 - dpr, h - 4 * dpr);
    ctx.fillStyle = sel ? '#fff' : '#9aa3b5'; // maniglie per accorciare
    ctx.fillRect(x0, mid - 8 * dpr, 3 * dpr, 16 * dpr);
    ctx.fillRect(x1 - 3 * dpr, mid - 8 * dpr, 3 * dpr, 16 * dpr);
  }
}

function drawTrack(t) {
  drawClipTrack(t);
}

// ------------------------------------------------------------- righe e comandi

/** Aggiunge alla riga: selezione, maniglia di riordino, colore del gruppo, editing delle clip. */
function decorateRow(t, row) {
  const g = groupOf(t.name);
  row.classList.toggle('grouped', !!g);
  row.classList.toggle('selected', state.selTracks.has(t.name));
  if (g) {
    row.style.setProperty('--gcolor', groupColor(g));
    row.querySelector('.track-head').title = `Gruppo: ${g.name}`;
  }
  row.querySelector('.track-head').addEventListener('pointerdown', (e) => {
    // il campo del nome seleziona la traccia e resta modificabile; pulsanti e cursori no
    if (e.target.closest('button, a, select, .grip, input[type=range]')) return;
    selectTrack(t, e.ctrlKey || e.metaKey || e.shiftKey);
  });
  setupGrip(t, row);
  setupClipCanvas(t);
}

/** Clic sullo spazio vuoto di una traccia (gestito dalla timeline): seleziona la traccia. */
function trackClick(canvas, e) {
  const t = engine.tracks.find((x) => x.canvas === canvas);
  if (!t) return;
  selectTrack(t, e.ctrlKey || e.metaKey || e.shiftKey);
  state.selClip = null;
  requestRedraw();
}

function setupEditor() {
  Object.assign(state, { selTracks: new Set(), groups: [], removed: [], undo: [], redo: [], selClip: null });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#group-btn').addEventListener('click', groupSelected);
  $('#ungroup-btn').addEventListener('click', ungroupSelected);
  document.addEventListener('keydown', (e) => {
    if (!state.current || e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (e.target.matches('canvas.roll')) return; // il piano roll gestisce i propri tasti
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); }
    else if (mod && e.code === 'KeyG') { e.preventDefault(); if (e.shiftKey) ungroupSelected(); else groupSelected(); }
    else if (e.altKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) { e.preventDefault(); moveSelectedTracks(e.code === 'ArrowUp' ? -1 : 1); }
    else if (e.code === 'KeyX' && !mod) { e.preventDefault(); splitSelected(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selClip) { e.preventDefault(); deleteSelectedClip(); }
    else if (e.code === 'Escape' && state.selTracks.size) clearTrackSelection();
  });
}

// ------------------------------------------------------------ menu ⋯ della traccia

function closeTrackMenu() {
  $('#track-menu').classList.add('hidden');
}

function openTrackMenu(t, anchor, isRefStem, song) {
  const menu = $('#track-menu');
  const waiting = state.pendingSplits.has(t.name);
  const items = [];
  if (t.part === 'original') {
    items.push({ icon: '⑂', label: waiting ? 'Separazione in corso…' : 'Separa traccia', disabled: waiting || !song, run: () => splitTrack(t) });
  }
  if (isRefStem) {
    items.push({ icon: '♪', label: state.showNotes.has(t.part) ? 'Nascondi note' : 'Mostra note', run: () => toggleNotesLane(t.part) });
    items.push({ icon: '𝄞', label: 'Spartito e tablatura', disabled: !state.notes, run: () => openScore(t.part) });
  }
  items.push({ icon: '✎', label: 'Rinomina', run: () => { const n = t.row.querySelector('.tname'); n.focus(); n.select(); } });
  items.push({ icon: '⧉', label: 'Duplica', run: () => duplicateTrack(t) });
  items.push({ icon: '⤓', label: 'Esporta', run: () => openExport(t) });
  items.push({ sep: true });
  items.push({ icon: '🗑', label: 'Elimina', danger: true, run: () => deleteTrack(t) });
  menu.innerHTML = `<div class="menu-title">${esc(trackTitle(t))}</div>` + items.map((it, i) => it.sep
    ? '<div class="menu-sep"></div>'
    : `<button class="menu-item ${it.danger ? 'danger' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}><span class="mi">${it.icon}</span>${esc(it.label)}</button>`).join('');
  menu.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
    closeTrackMenu();
    items[Number(b.dataset.i)].run();
  }));
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  const below = r.bottom + 4;
  menu.style.top = `${below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 4) : below}px`;
}

document.addEventListener('pointerdown', (e) => {
  const m = document.getElementById('track-menu');
  if (m && !m.classList.contains('hidden') && !m.contains(e.target) && !e.target.closest('.tmenu')) closeTrackMenu();
});
document.addEventListener('keydown', (e) => { if (e.code === 'Escape') { const m = document.getElementById('track-menu'); if (m) m.classList.add('hidden'); } });
