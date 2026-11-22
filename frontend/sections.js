'use strict';
// Sezioni salvate: porzioni del progetto con un nome (es. "Assolo 1") da richiamare e ripetere in loop
// per esercitarsi. Inizio e fine in secondi originali, come i segnalibri: restano giuste a ogni velocità.
// Le sezioni si vedono in tutti i salvataggi. Ognuna ricorda il salvataggio in uso quando è stata creata
// (`preset`; null = nessuno): serve ai salvataggi con l'opzione "solo le sue sezioni" (`own_loops`),
// che mostrano soltanto quelle create mentre erano in uso.

/** Il salvataggio in uso mostra soltanto le proprie sezioni? */
const ownLoopsOnly = () => { const p = typeof activePreset === 'function' ? activePreset() : null; return !!(p && p.own_loops); };
const regionVisible = (r) => !ownLoopsOnly() || (r.preset || null) === (state.presetId || null);
/** Sezioni che si vedono ora: tutte, oppure solo quelle del salvataggio in uso se lo chiede. */
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
  state.regions.push({ id: newRegionId(), name, start: +(s.start / k).toFixed(3), end: +(s.end / k).toFixed(3), preset: state.presetId || null });
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

/** Opzione del salvataggio in uso: mostrare soltanto le sezioni create mentre era in uso. */
function toggleOwnLoops() {
  const p = activePreset();
  if (!p) return;
  p.own_loops = !p.own_loops;
  if (!p.own_loops) delete p.own_loops;
  presetsChanged();
  if (typeof refreshSharesWith === 'function') refreshSharesWith(p); // i suoi link mostrano altre sezioni
  updateRegionsUI(regionOfSelection());
  if (!$('#regions-menu').classList.contains('hidden')) renderRegionsMenu();
  toast(p.own_loops ? `"${p.name}" mostra solo le sue sezioni` : `"${p.name}" mostra tutte le sezioni`);
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
  const own = !!(save && save.own_loops);
  menu.innerHTML = `<div class="menu-title">${esc(own ? `${T('Sezioni di')} "${save.name}"` : T('Sezioni salvate'))}${list.length ? ` (${list.length})` : ''}</div>`
    // opzione del salvataggio in uso: tutte le sezioni del progetto (normale) o solo le sue
    + (save ? `<label class="menu-check" title="${esc(T('Con questa opzione il salvataggio mostra soltanto le sezioni create mentre era in uso, anche nei suoi link pubblici'))}"><input type="checkbox" class="rg-own" ${own ? 'checked' : ''}> ${esc(T('Solo le sezioni di questo salvataggio'))}</label>` : '')
    + (list.length
    ? list.map((r) => `
      <div class="region-item ${r === cur ? 'active' : ''}" data-id="${r.id}">
        <button class="rg-go" title="Seleziona la sezione e ripetila in loop">
          <span class="rg-name">${esc(r.name)}</span>
          <span class="rg-time">${fmtPrecise(r.start * k)} – ${fmtPrecise(r.end * k)}</span>
        </button>
        <button class="rg-ren ghost" title="Rinomina">✎</button>
        <button class="rg-del ghost" title="Elimina">🗑</button>
      </div>`).join('')
    : `<div class="menu-empty">${own ? 'Nessuna sezione creata in questo salvataggio: togli la spunta qui sopra per vedere quelle del progetto, oppure seleziona un tratto e salvalo.' : 'Nessuna sezione: trascina sulla timeline per selezionare una porzione, poi salvala da qui con un nome.'}</div>`)
    // come nel menu dei salvataggi: l'ultima voce salva ciò che c'è ora (qui, la selezione)
    + '<div class="menu-sep"></div>'
    + (cur ? `<div class="menu-hint">${esc(T('La selezione è già la sezione'))} "${esc(cur.name)}"</div>`
      : !state.sel && list.length ? '<div class="menu-hint">Per salvare una sezione seleziona prima un tratto trascinando sulla timeline</div>' : '')
    + `<button class="menu-item rg-new" ${state.sel && !cur ? '' : 'disabled'}>＋ Salva la selezione come sezione…</button>`
    // come "Esci dal salvataggio": toglie la selezione (e il loop); la sezione resta nell'elenco
    + (state.sel ? `<button class="menu-item rg-leave" title="Toglie la selezione dalla timeline (Esc)">${cur ? 'Esci dalla sezione' : 'Togli la selezione'}</button>` : '');
  menu.querySelector('.rg-new').addEventListener('click', () => { closeRegionsMenu(); saveSelectionAsRegion(); });
  menu.querySelector('.rg-leave')?.addEventListener('click', () => { closeRegionsMenu(); setSelection(null); });
  menu.querySelector('.rg-own')?.addEventListener('change', toggleOwnLoops);
  menu.querySelectorAll('.region-item').forEach((row) => {
    const r = list.find((x) => x.id === row.dataset.id);
    row.querySelector('.rg-go').addEventListener('click', () => { closeRegionsMenu(); goRegion(r); });
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
  $('#sel-nudge').classList.toggle('hidden', !state.sel);
  const grid = typeof hasGrid === 'function' && hasGrid();
  document.querySelectorAll('#sel-nudge .beat').forEach((b) => {
    b.disabled = !grid;
    b.title = grid ? b.title.replace(/ \(.*\)$/, '') : `${b.title.replace(/ \(.*\)$/, '')} (serve l'analisi del ritmo)`;
  });
  // il pulsante è un campo col suo valore: la sezione in uso, oppure "nessuna" (in grigio); ▾ apre
  // l'elenco, e il numero delle sezioni sta nel titolo dell'elenco
  const btn = $('#regions-btn');
  btn.textContent = reg ? reg.name : T('Sezione: nessuna');
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
