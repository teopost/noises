'use strict';
// Segnalibri del brano: posizioni con un nome (es. "Assolo", "Ritornello").
// Salvati in secondi originali, quindi restano al loro posto anche cambiando velocità.

let markerSaveTimer = null;
let markerMenuId = null;
const mk = () => 100 / engine.tempo; // secondi originali → timeline corrente

function loadMarkers(project) {
  state.markers = (project.markers || []).map((m) => ({ ...m }));
  closeMarkerMenu();
  renderMarkers();
}

function saveMarkers() {
  saveProject(); // i segnalibri fanno parte del progetto
}

/** Aggancia un tempo (secondi originali) al battito più vicino, se il ritmo è stato analizzato. */
function snapMarker(t) {
  if (typeof hasGrid !== 'function' || !hasGrid()) return t;
  const a = refAnchor();
  return Math.max(0, beatTime(Math.round(beatPos(t - a))) + a);
}

function addMarker(atDisplay) {
  if (!state.current || !engine.tracks.length) return;
  const t = +((atDisplay ?? engine.position()) / mk()).toFixed(3);
  const near = state.markers.find((m) => Math.abs(m.t - t) < 0.05);
  if (near) { openMarkerMenu(near.id, true); return; }
  const m = { id: Math.random().toString(36).slice(2, 10), t, name: `Segnalibro ${state.markers.length + 1}` };
  pushUndo('Aggiungi segnalibro');
  state.markers.push(m);
  saveMarkers();
  renderMarkers();
  openMarkerMenu(m.id, true);
}

function renderMarkers() {
  const lane = $('#marker-lane'), lines = $('#marker-lines'), ov = $('#ov-markers');
  if (!state.current || !engine.duration || !state.markers) {
    lane.innerHTML = '<div class="placeholder">Nessun segnalibro: premi 🔖+ o M durante l\'ascolto</div>';
    lines.innerHTML = '';
    ov.innerHTML = '';
    return;
  }
  const k = mk(), z = state.zoom, hw = headWidth();
  lane.innerHTML = state.markers.length
    ? state.markers.map((m) => `
      <div class="marker ${m.id === markerMenuId ? 'editing' : ''} ${m.t * k * z < 50 ? 'edge' : ''}" data-id="${m.id}" style="left:${m.t * k * z}px"
        title="${esc(m.name)} — ${fmt(m.t * k)} · clic: vai e modifica · trascina: sposta (Shift: senza griglia)">
        <span class="flag">${esc(m.name || '—')}</span>
      </div>`).join('')
    : '<div class="placeholder">Nessun segnalibro: premi 🔖+ o M durante l\'ascolto · doppio clic qui per aggiungerne uno</div>';
  lines.innerHTML = state.markers.map((m) => `<div class="mline" style="left:${hw + m.t * k * z}px"></div>`).join('');
  const W = ovW();
  ov.innerHTML = state.markers.map((m) =>
    `<div class="ov-marker" style="left:${hw + ((m.t * k) / engine.duration) * W}px" title="${esc(m.name)}"></div>`).join('');
}

/** Nome della sezione in cui si trova la posizione (ultimo segnalibro prima di essa). */
function currentSection(pos) {
  if (!state.markers || !state.markers.length) return '';
  const t = pos / mk() + 0.01;
  let name = '';
  for (const m of state.markers) { if (m.t <= t) name = m.name; else break; }
  return name;
}

function goMarker(m) {
  engine.stopAt = null;
  engine.seek(m.t * mk());
  const tl = tlEl(), x = m.t * mk() * state.zoom, viewW = tl.clientWidth - headWidth();
  if (x < tl.scrollLeft || x > tl.scrollLeft + viewW * 0.9) tl.scrollLeft = Math.max(0, x - viewW * 0.1);
}

function prevMarker() {
  if (!state.markers.length) return;
  // durante l'ascolto un piccolo margine permette di risalire oltre il segnalibro appena superato
  const t = engine.position() / mk() - (engine.playing ? 0.6 : 0.01);
  const prev = state.markers.filter((m) => m.t < t);
  if (prev.length) goMarker(prev[prev.length - 1]);
  else goMarker({ t: 0 });
}

function nextMarker() {
  const t = engine.position() / mk() + 0.01;
  const next = state.markers.find((m) => m.t > t);
  if (next) goMarker(next);
}

// ------------------------------------------------------------------ menu

function closeMarkerMenu() {
  markerMenuId = null;
  const menu = $('#marker-menu');
  if (menu) menu.classList.add('hidden');
  document.querySelectorAll('.marker.editing').forEach((el) => el.classList.remove('editing'));
}

function openMarkerMenu(id, focusName) {
  const m = state.markers.find((x) => x.id === id);
  if (!m) return;
  markerMenuId = id;
  const menu = $('#marker-menu');
  const i = state.markers.indexOf(m);
  const next = state.markers[i + 1];
  menu.innerHTML = `
    <div class="menu-title">Segnalibro · ${fmtPrecise(m.t * mk())}</div>
    <input id="mk-name" type="text" maxlength="60" value="${esc(m.name)}" placeholder="Nome (es. Assolo)">
    <div class="ce-actions">
      <button data-act="go">▶ Vai</button>
      <button data-act="loop" title="Seleziona e ripete la sezione fino al ${next ? `segnalibro "${esc(next.name)}"` : 'fine del brano'}">⟳ Loop sezione</button>
      <button data-act="del" class="danger">Elimina</button>
    </div>`;
  const input = menu.querySelector('#mk-name');
  let renamed = false;
  input.addEventListener('input', () => {
    if (!renamed && !focusName) { pushUndo('Rinomina segnalibro'); renamed = true; }
    m.name = input.value;
    renderMarkers();
    saveMarkers();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); closeMarkerMenu(); }
    e.stopPropagation();
  });
  menu.querySelector('[data-act=go]').addEventListener('click', () => goMarker(m));
  menu.querySelector('[data-act=loop]').addEventListener('click', () => {
    const k = mk();
    const end = next ? next.t * k : engine.duration;
    setSelection({ start: m.t * k, end });
    if (!state.loopOn) toggleLoop();
    goMarker(m);
    if (!engine.playing) playWithCountIn();
    closeMarkerMenu();
  });
  menu.querySelector('[data-act=del]').addEventListener('click', () => {
    pushUndo('Elimina segnalibro');
    state.markers = state.markers.filter((x) => x.id !== m.id);
    saveMarkers();
    closeMarkerMenu();
    renderMarkers();
  });
  renderMarkers();
  menu.classList.remove('hidden');
  const el = $(`#marker-lane .marker[data-id="${id}"]`);
  const r = (el || $('#marker-lane')).getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6}px`;
  if (focusName) setTimeout(() => { input.focus(); input.select(); }, 20);
}

function setupMarkers() {
  $('#mk-add').addEventListener('click', () => addMarker());
  $('#mk-prev').addEventListener('click', prevMarker);
  $('#mk-next').addEventListener('click', nextMarker);
  $('#mk-add-lane').addEventListener('click', () => addMarker());

  const lane = $('#marker-lane');
  let drag = null;
  lane.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.marker');
    if (!el || e.button !== 0) return;
    e.preventDefault();
    drag = { id: el.dataset.id, x0: e.clientX, moved: false };
    lane.setPointerCapture(e.pointerId);
  });
  lane.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
    if (!drag.moved) pushUndo('Sposta segnalibro');
    drag.moved = true;
    const m = state.markers.find((x) => x.id === drag.id);
    let t = timeAt(e.clientX) / mk();
    if (!e.shiftKey) t = snapMarker(t);
    m.t = +Math.max(0, t).toFixed(3);
    renderMarkers();
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) { saveMarkers(); return; }
    const m = state.markers.find((x) => x.id === d.id);
    if (m) { goMarker(m); openMarkerMenu(m.id); }
  };
  lane.addEventListener('pointerup', end);
  lane.addEventListener('pointercancel', end);
  lane.addEventListener('dblclick', (e) => {
    if (e.target.closest('.marker') || !engine.tracks.length) return;
    let t = timeAt(e.clientX) / mk();
    if (!e.shiftKey) t = snapMarker(t);
    addMarker(t * mk());
  });
  document.addEventListener('pointerdown', (e) => {
    const menu = $('#marker-menu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !e.target.closest('.marker')) closeMarkerMenu();
  });
}
