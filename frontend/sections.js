'use strict';
// Sezioni salvate: porzioni del progetto con un nome (es. "Assolo 1") da richiamare e ripetere in loop
// per esercitarsi. Inizio e fine in secondi originali, come i segnalibri: restano giuste a ogni velocità.
// Ogni salvataggio ha le sue sezioni: una sezione appartiene al salvataggio in uso quando viene creata
// (`preset`; null = nessun salvataggio in uso) e si vede solo lì, a meno che sia segnata 📌 "in tutti
// i salvataggi" (`all`).

const regionVisible = (r) => !!r.all || (r.preset || null) === (state.presetId || null);
/** Sezioni del salvataggio in uso, più quelle comuni a tutti. */
const visibleRegions = () => (state.regions || []).filter(regionVisible);

const rk = () => 100 / engine.tempo; // secondi originali → timeline corrente
const newRegionId = () => Math.random().toString(36).slice(2, 10);

/** Sezione salvata che coincide con la selezione corrente, se c'è. */
function regionOfSelection() {
  const s = state.sel;
  if (!s || !state.regions) return null;
  const k = rk();
  return visibleRegions().find((r) => Math.abs(r.start * k - s.start) < 0.02 && Math.abs(Math.min(r.end * k, engine.duration) - s.end) < 0.02) || null;
}

async function askRegionName(def, title = 'Nome della sezione') {
  const name = (await uiPrompt(title, def, { ok: 'Salva', max: 60 }) || '').trim().slice(0, 60);
  return name || null;
}

async function saveSelectionAsRegion() {
  const s0 = state.sel;
  if (!s0 || !state.current) return;
  const cur = regionOfSelection();
  if (cur) { renameRegion(cur); return; }
  const name = await askRegionName(`${T('Sezione')} ${visibleRegions().length + 1}`);
  const s = state.sel;
  if (!name || !s) return;
  pushUndo('Salva sezione');
  const k = rk();
  state.regions.push({ id: newRegionId(), name, start: +(s.start / k).toFixed(3), end: +(s.end / k).toFixed(3), preset: state.presetId || null, all: false });
  state.regions.sort((a, b) => a.start - b.start);
  regionsChanged();
  toast(`Sezione "${name}" salvata`);
}

async function renameRegion(r) {
  const name = await askRegionName(r.name, 'Rinomina sezione');
  if (!name || name === r.name) return;
  pushUndo('Rinomina sezione');
  r.name = name;
  regionsChanged();
}

function deleteRegion(r) {
  pushUndo('Elimina sezione');
  state.regions = state.regions.filter((x) => x !== r);
  regionsChanged();
  toast(`Sezione "${r.name}" eliminata (Ctrl+Z per annullare)`);
}

/** 📌: la sezione si vede in tutti i salvataggi, oppure torna solo di quello in uso. */
function toggleRegionAll(r) {
  pushUndo('Sezione in tutti i salvataggi');
  r.all = !r.all;
  if (!r.all) r.preset = state.presetId || null;
  regionsChanged();
  toast(r.all ? `Sezione "${r.name}" visibile in tutti i salvataggi` : `Sezione "${r.name}" solo in questo salvataggio`);
}

/** Cambio del salvataggio in uso: cambiano le sezioni che si vedono. */
function regionsPresetChanged() {
  updateRegionsUI(regionOfSelection());
  if (!$('#regions-menu').classList.contains('hidden')) renderRegionsMenu();
}

function regionsChanged() {
  saveProject();
  if (typeof scheduleSharesRefresh === 'function') scheduleSharesRefresh(); // i link pubblici mostrano le sezioni
  updateSelectionUI();
  if (!$('#regions-menu').classList.contains('hidden')) renderRegionsMenu();
}

/** Richiama una sezione: la seleziona, attiva il loop e porta la testina all'inizio. */
function goRegion(r) {
  const k = rk();
  const start = r.start * k, end = Math.min(r.end * k, engine.duration);
  if (end <= start) return;
  state.loopOn = true;
  setSelection({ start, end });
  engine.seek(start);
  const tl = tlEl(), viewW = tl.clientWidth - headWidth();
  const x0 = start * state.zoom, x1 = end * state.zoom;
  if (x0 < tl.scrollLeft || x1 > tl.scrollLeft + viewW) tl.scrollLeft = Math.max(0, x0 - viewW * 0.1);
}

function renderRegionsMenu() {
  const menu = $('#regions-menu');
  const k = rk(), cur = regionOfSelection();
  const list = visibleRegions();
  const save = typeof activePreset === 'function' ? activePreset() : null;
  menu.innerHTML = `<div class="menu-title">${esc(save ? `${T('Sezioni di')} "${save.name}"` : T('Sezioni salvate'))}${list.length ? ` (${list.length})` : ''}</div>` + (list.length
    ? list.map((r) => `
      <div class="region-item ${r === cur ? 'active' : ''}" data-id="${r.id}">
        <button class="rg-go" title="Seleziona la sezione e ripetila in loop">
          <span class="rg-name">${esc(r.name)}</span>
          <span class="rg-time">${fmtPrecise(r.start * k)} – ${fmtPrecise(r.end * k)}</span>
        </button>
        <button class="rg-all ghost ${r.all ? 'on' : ''}" title="${r.all ? 'Visibile in tutti i salvataggi: clic per tenerla solo in questo' : 'Solo in questo salvataggio: clic per mostrarla in tutti'}" aria-pressed="${!!r.all}">📌</button>
        <button class="rg-ren ghost" title="Rinomina">✎</button>
        <button class="rg-del ghost" title="Elimina">🗑</button>
      </div>`).join('')
    : '<div class="menu-empty">Nessuna sezione: trascina sulla timeline per selezionare una porzione, poi premi “Salva sezione”.</div>');
  menu.querySelectorAll('.region-item').forEach((row) => {
    const r = list.find((x) => x.id === row.dataset.id);
    row.querySelector('.rg-go').addEventListener('click', () => { closeRegionsMenu(); goRegion(r); });
    row.querySelector('.rg-all').addEventListener('click', () => toggleRegionAll(r));
    row.querySelector('.rg-ren').addEventListener('click', () => renameRegion(r));
    row.querySelector('.rg-del').addEventListener('click', () => deleteRegion(r));
  });
}

function openRegionsMenu() {
  const menu = $('#regions-menu');
  if (!menu.classList.contains('hidden')) { closeRegionsMenu(); return; }
  renderRegionsMenu();
  menu.classList.remove('hidden');
  placeMenu(menu, $('#regions-split').getBoundingClientRect());
}

function closeRegionsMenu() {
  $('#regions-menu').classList.add('hidden');
}

/** Aggiorna i comandi delle sezioni (chiamata da updateSelectionUI). */
function updateRegionsUI(reg) {
  const save = $('#sel-save');
  // una sezione già salvata si rinomina dall'elenco ☰ Sezioni
  save.classList.toggle('hidden', !state.sel || !!reg);
  save.title = 'Salva la selezione come sezione con un nome, da richiamare in seguito';
  $('#sel-nudge').classList.toggle('hidden', !state.sel);
  const grid = typeof hasGrid === 'function' && hasGrid();
  document.querySelectorAll('#sel-nudge .beat').forEach((b) => {
    b.disabled = !grid;
    b.title = grid ? b.title.replace(/ \(.*\)$/, '') : `${b.title.replace(/ \(.*\)$/, '')} (serve l'analisi del ritmo)`;
  });
  // il pulsante è un campo col suo valore: la sezione in uso, oppure "nessuna" (in grigio); ▾ apre
  // l'elenco, e il numero delle sezioni sta nel titolo dell'elenco
  const btn = $('#regions-btn');
  btn.textContent = reg ? `${T('Sezione')}: ${reg.name}` : T('Sezione: nessuna');
  btn.classList.toggle('on', !!reg);
  btn.classList.toggle('none', !reg);
  btn.title = reg ? `Sezione "${reg.name}": clic per ricominciare dall'inizio` : 'Nessuna sezione in uso: clic per scegliere una sezione salvata e ripeterla in loop';
  $('#selection').dataset.name = reg ? reg.name : '';
}

// ------------------------------------------------ regolazione fine del loop

let nudgeUndoAt = 0;

/**
 * Sposta di poco l'inizio o la fine della selezione (e del loop). Se la selezione è una sezione
 * salvata, anche la sezione segue: così la si rifinisce mentre la si ascolta.
 */
/** Posizione (timeline) del click precedente (dir -1) o successivo (dir 1) rispetto a x. */
function beatNeighbor(x, dir) {
  const k = rk(), a = refAnchor(), n = clickNudge(); // stesso punto in cui suona il click
  const bp = beatPos((x - n) / k - a);
  const b = dir > 0 ? Math.floor(bp + 1e-4) + 1 : Math.ceil(bp - 1e-4) - 1;
  return (beatTime(b) + a) * k + n;
}

/** Posizione (timeline) del click più vicino a x; senza griglia del ritmo restituisce x. */
function nearestBeat(x) {
  if (!(typeof hasGrid === 'function' && hasGrid())) return x;
  const n = clickNudge();
  const near = clickTimes(Math.max(0, x - n - 4), x - n + 4);
  let best = x, d = Infinity;
  for (const b of near) if (Math.abs(b.t + n - x) < d) { d = Math.abs(b.t + n - x); best = b.t + n; }
  return best;
}

/** mode: 'step' (0,1 s), 'fine' (0,01 s) o 'beat' (click precedente/successivo). */
function nudgeSelection(edge, dir, mode) {
  const s = state.sel;
  if (!s) return;
  if (mode === 'beat' && !(typeof hasGrid === 'function' && hasGrid())) return;
  const MIN = 0.05;
  const reg = regionOfSelection();
  const next = { ...s };
  const to = mode === 'beat' ? beatNeighbor(s[edge], dir) : s[edge] + dir * (mode === 'fine' ? 0.01 : 0.1);
  if (edge === 'start') next.start = Math.max(0, Math.min(s.end - MIN, to));
  else next.end = Math.min(engine.duration, Math.max(s.start + MIN, to));
  if (next.start === s.start && next.end === s.end) return;
  if (reg) {
    // una sola voce di annullamento per una serie di ritocchi ravvicinati
    if (performance.now() - nudgeUndoAt > 1500) pushUndo('Regola sezione');
    nudgeUndoAt = performance.now();
    const k = rk();
    reg.start = +(next.start / k).toFixed(3);
    reg.end = +(next.end / k).toFixed(3);
    saveProject();
    if (typeof scheduleSharesRefresh === 'function') scheduleSharesRefresh();
  }
  const pos = engine.position();
  state.sel = next;
  engine.stopAt = null;
  if (state.loopOn) engine.setLoop({ ...next }); // in ascolto: il loop cambia senza interruzioni
  // ritoccando l'inizio da fermi si riascolta subito dal nuovo punto
  if (edge === 'start' && !engine.playing) engine.seek(next.start);
  else if (edge === 'start' && engine.playing && pos < next.start) engine.seek(next.start);
  updateSelectionUI();
  if (!$('#regions-menu').classList.contains('hidden')) renderRegionsMenu();
}

function setupNudgeButtons() {
  document.querySelectorAll('#sel-nudge [data-edge]').forEach((b) => {
    let delay = null, rep = null;
    const stop = () => { clearTimeout(delay); clearInterval(rep); delay = rep = null; };
    const step = (e) => nudgeSelection(b.dataset.edge, Number(b.dataset.dir), b.hasAttribute('data-beat') ? 'beat' : e.shiftKey ? 'fine' : 'step');
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      step(e);
      // tenendo premuto il punto scorre
      delay = setTimeout(() => { rep = setInterval(() => step(e), 70); }, 400);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
    b.addEventListener('click', (e) => { if (e.detail === 0) step(e); }); // tastiera (Invio/spazio)
  });
}

function setupSections() {
  setupNudgeButtons();
  state.regions = [];
  $('#sel-save').addEventListener('click', saveSelectionAsRegion);
  $('#regions-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const reg = regionOfSelection();
    if (reg) { closeRegionsMenu(); goRegion(reg); } else openRegionsMenu();
  });
  $('#regions-cfg').addEventListener('click', (e) => { e.stopPropagation(); openRegionsMenu(); });
  document.addEventListener('pointerdown', (e) => {
    const m = $('#regions-menu');
    if (!m.classList.contains('hidden') && !m.contains(e.target) && !e.target.closest('#regions-split')) closeRegionsMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.code === 'Escape') closeRegionsMenu(); });
}
