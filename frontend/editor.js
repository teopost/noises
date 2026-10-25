'use strict';
// Editor multitraccia: selezione delle tracce, gruppi, ordine, modifica delle clip, annulla/ripeti.
//
// Ogni traccia è un insieme di clip sulla timeline (secondi alla velocità originale).
// Le tracce separate nascono nel gruppo "Brano", ancorato: si possono tagliare ed eliminare
// a pezzi, ma restano al loro posto (accordi, note e click restano allineati). Separando il
// gruppo diventano tracce audio libere come quelle aggiunte.

const SONG_GROUP = 'song';
const EDGE_PX = 7;
const GROUP_COLORS = ['#7c5cff', '#2bd47d', '#ff8a3d', '#4fc3f7', '#ff5c7a', '#c49bff', '#f5c542'];
let layoutTimer = null;
let toastTimer = null;


const deep = (x) => JSON.parse(JSON.stringify(x));
const ek = () => 100 / engine.tempo;
const trackByName = (n) => engine.tracks.find((t) => t.name === n);
const groupOf = (name) => state.groups.find((g) => g.tracks.includes(name)) || null;
const isAnchored = (t) => !!(groupOf(t.name) && groupOf(t.name).anchored);
const trackLabel = (t) => t.label || LABELS[t.name] || t.name;
const groupColor = (g) => GROUP_COLORS[[...g.id].reduce((a, c) => a + c.charCodeAt(0), 0) % GROUP_COLORS.length];

/** Tracce che si muovono insieme a `t` (il suo gruppo, o solo lei). */
function peersOf(t) {
  const g = groupOf(t.name);
  return g ? g.tracks.map(trackByName).filter(Boolean) : [t];
}

function defaultClips(name) {
  return [{ id: `${name}-0`, start: 0, offset: 0, duration: engine.songDuration }];
}

/** La traccia separata è intera e al suo posto (nessun taglio o spostamento). */
function isDefaultClips(t) {
  if (t.user || t.clips.length !== 1) return false;
  const c = t.clips[0];
  return c.start === 0 && c.offset === 0 && Math.abs(c.duration - engine.songDuration) < 0.01;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ------------------------------------------------------------------ disposizione

/** Prepara gruppi e tracce eliminate all'apertura di un brano. */
function initLayout(song) {
  const l = song.layout || {};
  state.groups = l.groups && l.groups.length
    ? deep(l.groups)
    : [{ id: SONG_GROUP, name: 'Brano', tracks: [...song.stems], anchored: true }];
  state.layoutOrder = l.order || [];
  state.removed = [];
  state.undo = [];
  state.redo = [];
  state.selTracks = new Set();
  state.selClip = null;
  // tracce eliminate in una sessione precedente: l'annulla non c'è più, si cancellano davvero
  for (const name of l.removed || []) purgeUserTrack(song, name);
  updateEditUI();
}

function purgeUserTrack(song, name) {
  const tid = name.replace(/^user:/, '');
  song.user_tracks = (song.user_tracks || []).filter((u) => u.id !== tid);
  api(`/api/songs/${song.id}/tracks/${tid}`, { method: 'DELETE' }).catch(() => {});
}

/** All'uscita dal brano le tracce eliminate (non più annullabili) vengono cancellate dal server. */
function purgeRemoved() {
  const song = state.current;
  if (!song || !state.removed.length) return;
  for (const name of state.removed) purgeUserTrack(song, name);
  state.removed = [];
}

function applyOrder() {
  const pos = new Map(state.layoutOrder.map((n, i) => [n, i]));
  const orig = new Map(engine.tracks.map((t, i) => [t.name, i]));
  engine.tracks.sort((a, b) => (pos.get(a.name) ?? 1e6 + orig.get(a.name)) - (pos.get(b.name) ?? 1e6 + orig.get(b.name)));
}

function cleanGroups() {
  const live = new Set([...engine.tracks.map((t) => t.name), ...state.removed]);
  state.groups = state.groups
    .map((g) => ({ ...g, tracks: g.tracks.filter((n) => live.has(n)) }))
    .filter((g) => g.tracks.length >= 2 || (g.anchored && g.tracks.length >= 1));
}

function saveLayout() {
  const song = state.current;
  if (!song || !engine.tracks.length) return;
  cleanGroups();
  const stemClips = {};
  for (const t of engine.tracks) if (!t.user && !isDefaultClips(t)) stemClips[t.name] = t.clips;
  const layout = { order: engine.tracks.map((t) => t.name), groups: state.groups, stem_clips: stemClips, removed: state.removed };
  song.layout = deep(layout);
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    api(`/api/songs/${song.id}/layout`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout),
    }).catch((e) => toast(`Salvataggio non riuscito: ${e.message}`));
  }, 400);
}

// ------------------------------------------------------------ annulla / ripeti

function snapshot() {
  return JSON.stringify({
    tracks: engine.tracks.map((t) => ({ name: t.name, label: t.label || null, clips: t.clips })),
    groups: state.groups, removed: state.removed, markers: state.markers || [],
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
  const song = state.current;
  const wanted = new Set(s.tracks.map((t) => t.name));
  // tracce aggiunte dopo lo stato da ripristinare: tolte (restano annullabili)
  for (const t of [...engine.tracks]) {
    if (!wanted.has(t.name) && t.user) {
      engine.removeTrack(t);
      if (!s.removed.includes(t.name)) s.removed.push(t.name);
    }
  }
  // tracce eliminate dopo: rimesse (l'audio è ancora sul server)
  for (const st of s.tracks) {
    if (trackByName(st.name) || !st.name.startsWith('user:')) continue;
    const tid = st.name.slice(5);
    try {
      const audio = await fetchUserAudio(song, tid);
      if (state.current !== song) return;
      engine.addUserTrack({ name: st.name, user: true, tid, label: st.label, clips: st.clips, ...audio });
      if (!userTrackMeta({ tid })) (song.user_tracks = song.user_tracks || []).push({ id: tid, name: st.label, clips: st.clips });
    } catch (e) {
      toast(`Impossibile ripristinare "${st.label}": ${e.message}`);
    }
  }
  for (const st of s.tracks) {
    const t = trackByName(st.name);
    if (!t) continue;
    t.clips = deep(st.clips);
    if (st.label != null) t.label = st.label;
    engine.setClips(t);
    if (t.user) saveUserTrack(t);
  }
  const order = new Map(s.tracks.map((t, i) => [t.name, i]));
  engine.tracks.sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
  state.groups = s.groups;
  state.removed = s.removed.filter((n) => !trackByName(n));
  state.markers = s.markers;
  if (typeof saveMarkers === 'function') saveMarkers();
  state.selClip = null;
  engine.updateLength();
  saveLayout();
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

/** Clic su una traccia: seleziona lei e il suo gruppo (Ctrl/Shift: aggiunge o toglie). */
function selectTrack(t, additive) {
  selectTracks(peersOf(t).map((x) => x.name), additive);
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
  const anchored = names.some((n) => groupOf(n) && groupOf(n).anchored);
  state.groups.forEach((g) => { g.tracks = g.tracks.filter((n) => !names.includes(n)); });
  const n = state.groups.filter((g) => !g.anchored).length + 1;
  state.groups.push({ id: anchored ? SONG_GROUP : `g${ukid()}`, name: anchored ? 'Brano' : `Gruppo ${n}`, tracks: names, anchored });
  cleanGroups();
  saveLayout();
  buildTracks();
  toast(anchored ? 'Tracce unite al gruppo Brano (ancorato)' : `Creato il ${state.groups[state.groups.length - 1].name}`);
}

function ungroupSelected() {
  const groups = new Set([...state.selTracks].map((n) => groupOf(n)).filter(Boolean));
  if (!groups.size) return;
  pushUndo('Separa gruppo');
  state.groups = state.groups.filter((g) => !groups.has(g));
  saveLayout();
  buildTracks();
  toast([...groups].some((g) => g.anchored)
    ? 'Tracce del brano separate: ora sono tracce audio libere'
    : 'Gruppo separato');
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
    if (t.user) saveUserTrack(t);
  }
  saveLayout();
  if (relayout) layoutTimeline();
  requestRedraw();
}

function splitClip(t, c, at) {
  if (at <= c.start + 0.02 || at >= c.start + c.duration - 0.02) return false;
  t.clips.push({ id: ukid(), start: at, offset: c.offset + (at - c.start), duration: c.start + c.duration - at });
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

function deleteUserTrack(t) {
  pushUndo('Elimina traccia');
  engine.removeTrack(t);
  state.removed.push(t.name);
  state.selTracks.delete(t.name);
  if (state.selClip && state.selClip.name === t.name) state.selClip = null;
  saveLayout();
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
  return Math.max(0, beatTime(Math.round(beatPos(t))));
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
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!additive || !state.selTracks.has(t.name)) selectTrack(t, additive);
    const hit = clipAt(t, e.clientX);
    if (!hit.c) {
      state.selClip = null;
      engine.stopAt = null;
      engine.seek(timeAt(e.clientX));
      requestRedraw();
      return;
    }
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

/** Durata del file sorgente della traccia (le separate: il brano). */
function srcLength(t) {
  return t.user ? t.srcDuration : engine.songDuration;
}

// --------------------------------------------------------------------- disegno

/** Traccia a clip: sfondo e contorno per clip, forma d'onda della parte di file usata. */
function drawClipTrack(t) {
  const [ctx, w, h, dpr] = fitCanvas(t.canvas);
  const sl = tlEl().scrollLeft, z = state.zoom, k = ek();
  const bps = engine.sr / PEAK_BLOCK;
  const mid = h / 2;
  const color = t.user ? USER_COLOR : t.color;
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
    if (!isAnchored(t)) { // maniglie per accorciare
      ctx.fillStyle = sel ? '#fff' : '#9aa3b5';
      ctx.fillRect(x0, mid - 8 * dpr, 3 * dpr, 16 * dpr);
      ctx.fillRect(x1 - 3 * dpr, mid - 8 * dpr, 3 * dpr, 16 * dpr);
    }
  }
}

function drawTrack(t) {
  if (t.user || !isAnchored(t) || !isDefaultClips(t)) drawClipTrack(t);
  else drawWave(t);
}

// ------------------------------------------------------------- righe e comandi

/** Aggiunge alla riga: selezione, maniglia di riordino, colore del gruppo, editing delle clip. */
function decorateRow(t, row) {
  const g = groupOf(t.name);
  row.classList.toggle('grouped', !!g);
  row.classList.toggle('selected', state.selTracks.has(t.name));
  if (g) {
    row.style.setProperty('--gcolor', groupColor(g));
    row.querySelector('.track-head').title = `${g.name}${g.anchored ? ' (ancorato al brano)' : ''}`;
  }
  row.querySelector('.track-head').addEventListener('pointerdown', (e) => {
    // il campo del nome seleziona la traccia e resta modificabile; pulsanti e cursori no
    if (e.target.closest('button, a, select, .grip, input[type=range]')) return;
    selectTrack(t, e.ctrlKey || e.metaKey || e.shiftKey);
  });
  setupGrip(t, row);
  if (!isAnchored(t)) {
    t.canvas.classList.remove('wave');
    t.canvas.classList.add('ucanvas');
    setupClipCanvas(t);
  }
}

/** Clic sulle tracce ancorate (gestito dalla selezione della timeline): seleziona traccia e clip. */
function anchoredClick(canvas, e) {
  const t = engine.tracks.find((x) => x.canvas === canvas);
  if (!t) return;
  selectTrack(t, e.ctrlKey || e.metaKey || e.shiftKey);
  const hit = clipAt(t, e.clientX);
  state.selClip = hit.c && !isDefaultClips(t) ? { name: t.name, cid: hit.c.id } : null;
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
