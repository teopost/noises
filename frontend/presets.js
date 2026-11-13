'use strict';
// Salvataggi: fotografie con un nome delle impostazioni del progetto (tonalità, velocità, volumi,
// muto/solo di tracce e cartelle, master, selezione e loop), es. "Assolo in loop" o "Solo voce".
// Si richiamano con un clic; ognuno può diventare un link pubblico da condividere.

const newPresetId = () => Math.random().toString(36).slice(2, 10);

/** Stato delle cartelle (muto/solo/volume): fa parte di un salvataggio come quello delle tracce. */
function folderSettings() {
  const out = {};
  for (const g of state.groups || []) {
    if (g.folder && (g.muted || g.solo || (g.volume ?? 1) !== 1 || r3(g.pan || 0))) {
      out[g.id] = { muted: !!g.muted, solo: !!g.solo, volume: r3(g.volume ?? 1) };
      if (r3(g.pan || 0)) out[g.id].pan = r3(g.pan);
    }
  }
  return out;
}

function presetSnapshot() {
  return { ...currentSettings(), groups: folderSettings() };
}

function presetKey(c) {
  const g = c.groups || {};
  const groups = Object.fromEntries(Object.keys(g).sort().map((k) => [k, g[k]]));
  const n = normalizeSettings(c);
  n.tracks = Object.fromEntries(Object.keys(n.tracks).sort().map((k) => [k, n.tracks[k]]));
  return JSON.stringify({ ...n, groups });
}

// Salvataggio in uso: richiamato o appena creato, resta attivo finché non se ne sceglie un altro
// (o si esce). Le modifiche a loop, sezioni, volumi, muto/solo, tonalità e velocità finiscono lì.
const presetStoreKey = (pid) => `noises.preset.${pid}`;
let applyingPreset = false, presetShareTimer = null, presetShareFor = null;

function activePreset() {
  if (!state.current || !state.presetId) return null;
  return (state.presets || []).find((p) => p.id === state.presetId) || null;
}

function setActivePreset(p) {
  state.presetId = p ? p.id : null;
  if (!state.current) return;
  try {
    if (p) localStorage.setItem(presetStoreKey(state.current.id), p.id);
    else localStorage.removeItem(presetStoreKey(state.current.id));
  } catch {}
}

/** All'apertura del progetto: torna nel salvataggio in uso l'ultima volta (chiamata a tracce caricate). */
function restoreActivePreset() {
  const id = state.presetRestore;
  if (!id || !state.current || !engine.tracks.length || state.pending) return;
  state.presetRestore = null;
  const p = (state.presets || []).find((x) => x.id === id);
  if (!p) { setActivePreset(null); return; }
  if (presetKey(p.settings || {}) === presetKey(presetSnapshot())) state.presetId = p.id;
  else {
    const proj = state.current; // fuori dal caricamento in corso
    setTimeout(() => { if (state.current === proj) applyPreset(p); });
  }
}

/** Copia lo stato attuale nel salvataggio in uso; true se è cambiato. */
function syncPresetNow() {
  const p = activePreset();
  if (!p || applyingPreset || !engine.tracks.length || state.pending) return false;
  const snap = presetSnapshot();
  if (presetKey(snap) === presetKey(p.settings || {})) return false;
  p.settings = snap;
  p.updated_at = Math.floor(Date.now() / 1000);
  if ((state.shares || []).some((sh) => sh.preset === p.id || (sh.extra || []).includes(p.id))) {
    // il mix del link si rigenera sul server: si aspetta che le modifiche si fermino
    clearTimeout(presetShareTimer);
    presetShareFor = p;
    presetShareTimer = setTimeout(flushPresetShares, 4000);
  }
  return true;
}

/** Aggiorna subito i link in attesa (cambio progetto o di salvataggio). */
function flushPresetShares() {
  clearTimeout(presetShareTimer);
  presetShareTimer = null;
  const p = presetShareFor;
  presetShareFor = null;
  if (p) refreshSharesWith(p);
}

function syncActivePreset() {
  if (!syncPresetNow()) return;
  saveProject();
  if (!$('#presets-menu').classList.contains('hidden')) renderPresetsMenu();
}

const shareOf = (p) => (state.shares || []).find((s) => s.preset === p.id) || null;
const shareUrl = (s) => `${location.origin}/s/${s.token}`;

function presetsChanged() {
  saveProject();
  updatePresetsUI();
  if (!$('#presets-menu').classList.contains('hidden')) renderPresetsMenu();
}

async function askPresetName(def, title = 'Nome del salvataggio') {
  const name = (await uiPrompt(title, def, { ok: 'Salva', max: 60 }) || '').trim().slice(0, 60);
  return name || null;
}

async function savePreset() {
  if (!state.current || !engine.tracks.length) return null;
  syncPresetNow();
  const snap = presetSnapshot(); // lo stato al momento della richiesta
  const name = await askPresetName(`${T('Salvataggio')} ${(state.presets || []).length + 1}`);
  if (!name) return null;
  const now = Math.floor(Date.now() / 1000);
  const p = { id: newPresetId(), name, created_at: now, updated_at: now, settings: snap };
  state.presets = [...(state.presets || []), p];
  setActivePreset(p); // da qui le modifiche vanno nel nuovo salvataggio
  presetsChanged();
  toast(`Salvataggio "${name}" creato: le modifiche ora vengono salvate qui`);
  return p;
}

/** Richiama un salvataggio: applica volumi, muto/solo, tonalità, velocità, selezione e loop. */
function applyPreset(p) {
  if (syncPresetNow()) saveProject(); // le ultime modifiche restano nel salvataggio che si lascia
  flushPresetShares();
  applyingPreset = true;
  try { applyPresetSettings(p); } finally { applyingPreset = false; }
  setActivePreset(p);
  presetsUiKey = '';
  updatePresetsUI();
}

function applyPresetSettings(p) {
  const c = p.settings || {};
  const tr = c.tracks || {}, gr = c.groups || {};
  for (const t of engine.tracks) {
    const s = tr[t.name];
    t.muted = !!(s && s.muted);
    t.solo = !!(s && s.solo);
    t.volume = s && s.volume != null ? s.volume : 1;
    t.pan = clampPan(s && s.pan);
  }
  for (const g of state.groups || []) {
    if (!g.folder) continue;
    const s = gr[g.id];
    g.muted = !!(s && s.muted);
    g.solo = !!(s && s.solo);
    g.volume = s && s.volume != null ? s.volume : 1;
    g.pan = clampPan(s && s.pan);
  }
  engine.updateGains();
  buildTracks();
  saveProject(); // lo stato delle cartelle fa parte del progetto
  setMaster(c.master ?? 1);
  const pitch = c.pitch || 0, tempo = c.tempo || 100;
  if (pitch !== state.pitch || tempo !== state.tempo) {
    state.pitch = pitch;
    state.tempo = tempo;
    applyRate();
  }
  const sel = c.selection;
  if (sel) {
    const k = rk();
    const s = { start: sel.start * k, end: Math.min(sel.end * k, engine.duration) };
    state.loopOn = !!c.loop;
    setSelection(s.end > s.start ? s : null);
    if (state.sel) {
      engine.seek(s.start);
      const tl = tlEl(), viewW = tl.clientWidth - headWidth();
      const x0 = s.start * state.zoom, x1 = s.end * state.zoom;
      if (x0 < tl.scrollLeft || x1 > tl.scrollLeft + viewW) tl.scrollLeft = Math.max(0, x0 - viewW * 0.1);
    }
  } else {
    setSelection(null);
  }
  updateSaveUI();
}

/** Esce dal salvataggio: le modifiche successive non toccano più nessun salvataggio. */
function leavePreset() {
  if (syncPresetNow()) saveProject();
  flushPresetShares();
  setActivePreset(null);
  presetsUiKey = '';
  updatePresetsUI();
}

async function overwritePreset(p) {
  if (!(await uiConfirm(`Sostituire "${p.name}" con lo stato attuale?`, { ok: 'Sostituisci' }))) return;
  p.settings = presetSnapshot();
  p.updated_at = Math.floor(Date.now() / 1000);
  presetsChanged();
  toast(`Salvataggio "${p.name}" aggiornato`);
  refreshSharesWith(p); // i link pubblici seguono il salvataggio
}

async function renamePreset(p) {
  const name = await askPresetName(p.name, 'Rinomina salvataggio');
  if (!name || name === p.name) return;
  p.name = name;
  presetsChanged();
  refreshSharesWith(p);
}

async function deletePreset(p) {
  const sh = shareOf(p);
  const msg = sh
    ? `Eliminare il salvataggio "${p.name}"?\n\nAnche il suo link pubblico smetterà di funzionare.`
    : `Eliminare il salvataggio "${p.name}"?`;
  if (!(await uiConfirm(msg, { title: 'Elimina salvataggio', ok: 'Elimina', danger: true }))) return;
  if (sh) await unshare(sh, true);
  state.presets = state.presets.filter((x) => x !== p);
  if (state.presetId === p.id) setActivePreset(null);
  presetsChanged();
  refreshSharesWith(p); // sparisce dai link in cui era incluso
}

/** Ricondivide i link che contengono il salvataggio `p` (come principale o incluso). */
function refreshSharesWith(p) {
  for (const sh of [...(state.shares || [])]) {
    if (sh.preset !== p.id && !(sh.extra || []).includes(p.id)) continue;
    const main = (state.presets || []).find((x) => x.id === sh.preset);
    if (main) sharePreset(main, { silent: true, extra: sh.extra || [] });
  }
}

function presetDescription(p) {
  const c = p.settings || {};
  const bits = [];
  const sel = c.selection;
  if (sel) bits.push(`${c.loop ? '⟳ ' : ''}${fmt(sel.start)}–${fmt(sel.end)}`);
  const tr = Object.entries(c.tracks || {});
  const solo = tr.filter(([, s]) => s.solo).map(([n]) => presetTrackName(n));
  const muted = tr.filter(([, s]) => s.muted).length;
  if (solo.length) bits.push(`${T('solo')} ${solo.join(', ')}`);
  else if (muted) bits.push(`${muted} ${T('in muto')}`);
  if (c.pitch) bits.push(`${c.pitch > 0 ? '+' : ''}${c.pitch} st`);
  if ((c.tempo || 100) !== 100) bits.push(`${c.tempo}%`);
  return bits.join(' · ');
}

function presetTrackName(name) {
  const t = engine.tracks.find((x) => x.name === name);
  if (!t) return name;
  // nome breve: la parte ("Voce"), senza il titolo del brano
  if (t.label) return t.label;
  if (t.part && t.part !== 'original' && typeof LABELS !== 'undefined') return LABELS[t.part] || t.part;
  return typeof trackTitle === 'function' ? trackTitle(t) : t.name;
}

function renderPresetsMenu() {
  const menu = $('#presets-menu');
  const list = state.presets || [], cur = activePreset();
  menu.innerHTML = `<div class="menu-title">Salvataggi</div>` + (list.length
    ? list.map((p) => {
      const sh = shareOf(p);
      return `
      <div class="region-item preset-item ${p === cur ? 'active' : ''}" data-id="${p.id}">
        <button class="rg-go" title="Richiama questo salvataggio">
          <span class="rg-name">${esc(p.name)}</span>
          <span class="rg-time">${esc(presetDescription(p))}</span>
        </button>
        ${p === cur ? '<span class="ps-over ghost ph" aria-hidden="true">⟳</span>' : '<button class="ps-over ghost" title="Sostituisci con lo stato attuale">⟳</button>'}
        <button class="ps-share ghost ${sh ? 'on' : ''}" title="${sh ? 'Link pubblico attivo: clic per copiarlo o gestirlo' : 'Crea un link pubblico da condividere'}">🔗</button>
        <button class="rg-ren ghost" title="Rinomina">✎</button>
        <button class="rg-del ghost" title="Elimina">🗑</button>
      </div>`;
    }).join('')
    : '<div class="menu-empty">Nessun salvataggio: imposta volumi, muto/solo, velocità e loop, poi salva lo stato con un nome per richiamarlo in seguito.</div>')
    + `<div class="menu-sep"></div>`
    + (cur ? `<div class="menu-hint">Le modifiche a loop, sezioni, volumi e velocità vengono salvate in "${esc(cur.name)}"</div>` : '')
    + `<button class="menu-item ps-new">＋ ${cur ? 'Nuovo salvataggio dallo stato attuale…' : 'Salva lo stato attuale…'}</button>`
    + (cur ? `<button class="menu-item ps-leave" title="Le modifiche successive non cambiano nessun salvataggio">Esci dal salvataggio</button>` : '');
  menu.querySelectorAll('.preset-item').forEach((row) => {
    const p = list.find((x) => x.id === row.dataset.id);
    row.querySelector('.rg-go').addEventListener('click', () => { closePresetsMenu(); applyPreset(p); });
    row.querySelector('.ps-share').addEventListener('click', () => { closePresetsMenu(); const sh = shareOf(p); if (sh) openShareDialog(p, sh); else sharePreset(p); });
    row.querySelector('button.ps-over')?.addEventListener('click', () => overwritePreset(p));
    row.querySelector('.rg-ren').addEventListener('click', () => renamePreset(p));
    row.querySelector('.rg-del').addEventListener('click', () => deletePreset(p));
  });
  menu.querySelector('.ps-new').addEventListener('click', () => { closePresetsMenu(); savePreset(); });
  menu.querySelector('.ps-leave')?.addEventListener('click', () => { closePresetsMenu(); leavePreset(); });
}

function openPresetsMenu() {
  const menu = $('#presets-menu');
  if (!menu.classList.contains('hidden')) { closePresetsMenu(); return; }
  renderPresetsMenu();
  menu.classList.remove('hidden');
  placeMenu(menu, $('#presets-split').getBoundingClientRect());
}

function closePresetsMenu() {
  $('#presets-menu').classList.add('hidden');
}

let presetsUiKey = '';
/** Il pulsante mostra il salvataggio in uso (chiamata quando cambiano le impostazioni). */
function updatePresetsUI() {
  const btn = $('#presets-btn');
  if (!btn) return;
  restoreActivePreset();
  syncActivePreset();
  const cur = activePreset(), n = (state.presets || []).length;
  const key = `${cur ? cur.id + cur.name : ''}|${n}`;
  if (key === presetsUiKey) return;
  presetsUiKey = key;
  btn.textContent = cur ? `💾 ${cur.name}` : n ? `💾 ${T('Salvataggi')} (${n})` : `💾 ${T('Salvataggi')}`;
  btn.classList.toggle('on', !!cur);
  btn.title = cur ? `In uso il salvataggio "${cur.name}": le modifiche vengono salvate qui. Clic per tornare all'inizio del suo loop, ▾ per l'elenco` : 'Salvataggi: stati del progetto con un nome da richiamare (loop, solo voce…)';
}

// ------------------------------------------------------------------ link pubblici

/** Volume effettivo di ogni traccia con le impostazioni del salvataggio (muto/solo/cartelle). */
function presetGains(c) {
  const tr = (n) => (c.tracks || {})[n] || { muted: false, solo: false, volume: 1 };
  const gr = (n) => {
    const g = typeof folderOf === 'function' ? folderOf(n) : null;
    return g ? (c.groups || {})[g.id] || { muted: false, solo: false, volume: 1 } : null;
  };
  const solo = (n) => tr(n).solo || !!(gr(n) && gr(n).solo);
  const anySolo = engine.tracks.some((t) => solo(t.name));
  return engine.tracks.map((t) => {
    const g = gr(t.name);
    const audible = anySolo ? solo(t.name) : !(tr(t.name).muted || (g && g.muted));
    return { name: t.name, gain: audible ? (tr(t.name).volume ?? 1) * (g ? g.volume ?? 1 : 1) : 0, mix: panMatrix(t.ch, tr(t.name).pan, g ? g.pan : 0) };
  }).filter((x) => x.gain > 0);
}

async function loadShares() {
  const p = state.current;
  state.shares = [];
  if (!p) return;
  try {
    const list = await api(`/api/projects/${p.id}/shares`);
    if (state.current === p) state.shares = list;
  } catch {}
}

/** Mix di un salvataggio come lo vuole il server (null se non ha tracce udibili). */
function presetMix(p) {
  const c = p.settings || {};
  const stems = presetGains(c);
  if (!stems.length) return null;
  return { stems, pitch: c.pitch || 0, tempo: c.tempo || 100, master: c.master ?? 1, selection: c.selection || null, loop: !!c.loop };
}

/**
 * Crea o aggiorna il link del salvataggio `p`. `extra`: id di altri salvataggi da poter scegliere
 * nella pagina (se omesso restano quelli già inclusi).
 */
async function sharePreset(p, { silent = false, extra = null, stems = null, loops = null } = {}) {
  const proj = state.current;
  if (!proj) return null;
  const mix = presetMix(p);
  if (!mix) { toast('Nel salvataggio non ci sono tracce udibili da condividere'); return null; }
  const ids = extra ?? ((shareOf(p) || {}).extra || []);
  // pulsanti delle tracce separate nella pagina: accesi se non si è scelto altrimenti
  const stemButtons = stems ?? ((shareOf(p) || {}).stem_buttons ?? true);
  const loopButtons = loops ?? ((shareOf(p) || {}).loop_buttons ?? true);
  const extras = ids
    .map((id) => (state.presets || []).find((x) => x.id === id && x.id !== p.id))
    .filter(Boolean)
    .map((x) => { const m = presetMix(x); return m && { preset: x.id, name: x.name, ...m }; })
    .filter(Boolean);
  try {
    await saveProjectNow(); // il link usa le clip salvate del progetto
    const sh = await api(`/api/projects/${proj.id}/shares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: p.id, subtitle: p.name, ...mix, extra: extras, stem_buttons: stemButtons, loop_buttons: loopButtons }),
    });
    if (state.current !== proj) return null;
    state.shares = [...(state.shares || []).filter((x) => x.token !== sh.token), sh];
    if (silent) toast('Link pubblico aggiornato');
    else openShareDialog(p, sh);
    return sh;
  } catch (e) {
    toast(`Condivisione non riuscita: ${e.message}`);
    return null;
  }
}

async function unshare(sh, quiet) {
  const proj = state.current;
  if (!proj) return;
  try {
    await api(`/api/projects/${proj.id}/shares/${sh.token}`, { method: 'DELETE' });
    state.shares = (state.shares || []).filter((x) => x.token !== sh.token);
    if (!quiet) toast('Link pubblico disattivato');
  } catch (e) {
    toast(`Operazione non riuscita: ${e.message}`);
  }
}

/** Pulsante 🔗 Condividi: condivide il salvataggio in uso, oppure salva prima lo stato attuale. */
async function shareCurrent() {
  if (!state.current || !engine.tracks.length) return;
  let p = activePreset();
  if (!p) {
    p = await savePreset();
    if (!p) return;
  }
  const sh = shareOf(p);
  if (sh) openShareDialog(p, sh); else sharePreset(p);
}

let shareDlgPreset = null;
function openShareDialog(p, sh) {
  shareDlgPreset = p;
  const url = shareUrl(sh);
  const text = `${state.current.name} · ${p.name}`;
  $('#share-what').textContent = text;
  // l'opzione ha senso solo se nel progetto c'è almeno una traccia separata
  $('#share-stems-row').classList.toggle('hidden', !engine.tracks.some((t) => t.song && t.part !== 'original'));
  $('#share-stems').checked = !!sh.stem_buttons;
  $('#share-stems').disabled = false;
  $('#share-loops').checked = !!sh.loop_buttons;
  $('#share-loops').disabled = false;
  renderShareExtras(p, sh);
  $('#share-url').value = url;
  const enc = encodeURIComponent;
  const links = {
    whatsapp: `https://wa.me/?text=${enc(`${text} ${url}`)}`,
    telegram: `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    x: `https://twitter.com/intent/tweet?url=${enc(url)}&text=${enc(text)}`,
    email: `mailto:?subject=${enc(text)}&body=${enc(url)}`,
  };
  document.querySelectorAll('#share-dlg [data-net]').forEach((a) => { a.href = links[a.dataset.net]; });
  $('#share-native').classList.toggle('hidden', !navigator.share);
  $('#share-dlg').showModal();
  $('#share-url').select();
}

async function copyShareUrl() {
  const v = $('#share-url').value;
  try { await navigator.clipboard.writeText(v); } catch { $('#share-url').select(); document.execCommand('copy'); }
  toast('Link copiato');
}

function setupPresets() {
  state.presets = [];
  state.shares = [];
  state.presetId = null;
  // pulsante: richiama il salvataggio in uso (torna all'inizio del suo loop); freccia: elenco
  $('#presets-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = activePreset();
    if (cur) { closePresetsMenu(); applyPreset(cur); } else openPresetsMenu();
  });
  $('#presets-cfg').addEventListener('click', (e) => { e.stopPropagation(); openPresetsMenu(); });
  $('#share-btn').addEventListener('click', shareCurrent);
  document.addEventListener('pointerdown', (e) => {
    const m = $('#presets-menu');
    if (!m.classList.contains('hidden') && !m.contains(e.target) && !$('#presets-split').contains(e.target)) closePresetsMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.code === 'Escape') closePresetsMenu(); });
  $('#share-copy').addEventListener('click', copyShareUrl);
  // opzioni della pagina: pulsanti delle tracce separate, scelta dei loop
  for (const [sel, opt, field] of [['#share-stems', 'stems', 'stem_buttons'], ['#share-loops', 'loops', 'loop_buttons']]) {
    $(sel).addEventListener('change', async () => {
      const p = shareDlgPreset, cb = $(sel);
      if (!p) return;
      const want = cb.checked;
      cb.disabled = true;
      const res = await sharePreset(p, { silent: true, [opt]: want });
      if (shareDlgPreset === p) cb.checked = !!(res || shareOf(p) || { [field]: !want })[field];
      cb.disabled = false;
    });
  }
  $('#share-open').addEventListener('click', () => window.open($('#share-url').value, '_blank', 'noopener'));
  $('#share-native').addEventListener('click', () => {
    navigator.share({ title: $('#share-what').textContent, url: $('#share-url').value }).catch(() => {});
  });
  $('#share-off').addEventListener('click', async () => {
    const p = shareDlgPreset, sh = p && shareOf(p);
    if (!sh || !(await uiConfirm('Disattivare il link? Chi lo apre non potrà più ascoltare questo salvataggio.', { ok: 'Disattiva', danger: true }))) return;
    await unshare(sh);
    $('#share-dlg').close();
  });
}

/** Elenco degli altri salvataggi da includere nella pagina condivisa. */
function renderShareExtras(p, sh) {
  const others = (state.presets || []).filter((x) => x.id !== p.id);
  const box = $('#share-extra');
  box.classList.toggle('hidden', !others.length);
  const on = new Set(sh.extra || []);
  $('#share-extra-list').innerHTML = others.map((x) => {
    const ok = !!presetMix(x);
    return `<label class="check ${ok ? '' : 'off'}" title="${ok ? '' : esc(T('Nessuna traccia udibile'))}">
      <input type="checkbox" value="${x.id}" ${on.has(x.id) && ok ? 'checked' : ''} ${ok ? '' : 'disabled'}>
      <span>${esc(x.name)}</span><small>${esc(presetDescription(x))}</small></label>`;
  }).join('');
  $('#share-extra-list').querySelectorAll('input').forEach((cb) => cb.addEventListener('change', async () => {
    const ids = [...$('#share-extra-list').querySelectorAll('input:checked')].map((i) => i.value);
    $('#share-extra-list').querySelectorAll('input').forEach((i) => { i.disabled = true; });
    const res = await sharePreset(p, { silent: true, extra: ids });
    renderShareExtras(p, res || shareOf(p) || sh);
  }));
}
