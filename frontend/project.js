'use strict';
// Progetti: timeline salvate che usano i brani della libreria.
// Ogni traccia punta a un brano: intero (part = "original") o a una sua traccia separata.
// Accordi, note, click e spartito seguono il "brano di riferimento" (quello della traccia
// selezionata), allineati alla posizione della sua prima clip nella timeline.

const STEMS_SORT = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
let projectSaveTimer = null;
let projectSeq = 0;


const songById = (id) => state.songs.find((s) => s.id === id);
const newTrackName = () => `t${Math.random().toString(36).slice(2, 10)}`;
const newClipId = () => Math.random().toString(36).slice(2, 14);

/** Nome mostrato della traccia: "Brano" per il brano intero, "Voce · Brano" per le separate. */
function trackTitle(t) {
  if (t.label) return t.label;
  const s = songById(t.song);
  const name = s ? s.name : 'Brano rimosso';
  return t.part === 'original' ? name : `${LABELS[t.part] || t.part} · ${name}`;
}

function trackColor(t) {
  return t.part === 'original' ? USER_COLOR : COLORS[t.part] || '#aaa';
}

function sourceUrl(songId, part) {
  return part === 'original' ? `/api/songs/${songId}/original` : `/api/songs/${songId}/stems/${encodeURIComponent(part)}`;
}

// ------------------------------------------------------- brano di riferimento

/** Inizio del brano di riferimento sulla timeline (secondi originali). */
function refAnchor() {
  const t = state.refTrack && engine.tracks.find((x) => x.name === state.refTrack);
  if (!t || !t.clips.length) return 0;
  const c = t.clips.reduce((a, b) => (b.start < a.start ? b : a));
  return c.start - c.offset;
}

/** Le analisi passano al brano della traccia indicata. */
function setReference(t, force) {
  if (!t || !t.song) return;
  state.refTrack = t.name;
  const song = songById(t.song) || { id: t.song, name: '', status: 'new' };
  if (!force && state.refSong && state.refSong.id === song.id) {
    renderChords();
    requestRedraw();
    return;
  }
  state.refSong = song;
  state.chords = null;
  state.chordsMissing = false;
  state.notes = null;
  state.selNote = null;
  $('#chord-song').textContent = song.name ? `· ${song.name}` : '';
  if (song.status === 'ready') {
    loadChords(song);
    loadNotes(song);
  } else {
    // accordi anche sul brano intero; note e ritmo richiedono le tracce separate
    if (['new', 'error'].includes(song.status)) loadChords(song);
    else renderChords('Separazione in corso: gli accordi arrivano al termine');
    state.notesMissing = false;
    updateRhythmControls();
  }
  buildTracks();
}

// ------------------------------------------------------------------- elenco

async function refreshProjects() {
  try {
    state.projects = await api('/api/projects');
  } catch (e) {
    console.error(e);
  }
  renderProjects();
}

function renderProjects() {
  const ul = $('#projects');
  ul.innerHTML = '';
  if (!state.projects.length) {
    ul.innerHTML = '<li class="empty-hint">Nessun progetto: premi ＋ o trascina un brano nell\'editor</li>';
    return;
  }
  for (const p of state.projects) {
    const li = document.createElement('li');
    li.className = state.current && state.current.id === p.id ? 'active' : '';
    li.innerHTML = `<span class="pl-icon">◧</span>
      <span class="pl-name" title="${esc(p.songs.join(', ') || 'vuoto')}">${esc(p.name)}</span>
      <button class="ren" title="Rinomina">✎</button><button class="del" title="Elimina progetto">✕</button>
      <span class="count">${p.songs.length || ''}</span>`;
    li.addEventListener('click', () => openProject(p.id));
    li.querySelector('.ren').addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = (prompt('Nuovo nome del progetto:', p.name) || '').trim();
      if (!name || name === p.name) return;
      if (state.current && state.current.id === p.id) { state.current.name = name; $('#title').value = name; saveProject(); }
      else {
        const full = await api(`/api/projects/${p.id}`);
        await api(`/api/projects/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, tracks: full.tracks, groups: full.groups, markers: full.markers }) });
      }
      p.name = name;
      renderProjects();
    });
    li.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Eliminare il progetto "${p.name}"?\nI brani restano nella libreria.`)) return;
      await api(`/api/projects/${p.id}`, { method: 'DELETE' }).catch((err) => alert(err.message));
      if (state.current && state.current.id === p.id) closePlayer();
      refreshProjects();
    });
    ul.appendChild(li);
  }
}

async function createProject(name) {
  name = (name ?? prompt('Nome del nuovo progetto:', 'Nuovo progetto') ?? '').trim();
  if (!name) return null;
  const p = await api('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  await refreshProjects();
  return p;
}

// ------------------------------------------------------------------ apertura

async function openProject(id) {
  if (state.current && state.current.id === id) return;
  const seq = ++projectSeq;
  if (state.current) { flushAutosave(); flushProject(); }
  const p = await api(`/api/projects/${id}`);
  if (seq !== projectSeq) return;
  state.ab = 'custom';
  state.customSnap = null;
  engine.init();
  engine.clear();
  state.current = p;
  state.refSong = null;
  state.refTrack = null;
  state.chords = null;
  state.notes = null;
  state.pendingSplits = new Set();
  const cfg = p.settings || {};
  state.pitch = cfg.pitch || 0;
  state.tempo = cfg.tempo || 100;
  state.sel = null;
  state.loopOn = false;
  state.pending = { tracks: cfg.tracks || null, selection: cfg.selection || null, loop: !!cfg.loop };
  state.saved = JSON.stringify(normalizeSettings(cfg));
  setMaster(cfg.master ?? 1);
  engine.loop = null;
  engine.stopAt = null;
  updateKnobs();
  updateSelectionUI();
  $('#empty').classList.add('hidden');
  $('#player').classList.remove('hidden');
  $('#title').value = p.name;
  $('#chord-song').textContent = '';
  initLayout(p);
  state.markers = (p.markers || []).map((m) => ({ ...m }));
  closeMarkerMenu();
  renderProjects();
  closeDrawer();
  showSkeleton(p.tracks.length);
  await loadProjectTracks(p);
}

/** Scarica e decodifica l'audio di tutte le tracce del progetto. */
async function loadProjectTracks(p) {
  const seq = ++state.loadSeq;
  await engine.ready; // il motore audio (worklet) deve essere pronto anche per un progetto vuoto
  if (seq !== state.loadSeq) return;
  const n = p.tracks.length;
  if (!n) {
    state.pending = null;
    engine.setTracks([], false, null);
    engine.setRate(state.tempo, state.pitch);
    buildTracks();
    renderChords('Trascina un brano dalla libreria nella timeline');
    setLoader(null);
    return;
  }
  const prog = Array.from({ length: n }, () => ({ started: false, got: 0, total: 0 }));
  let decoded = 0;
  const report = () => {
    if (seq !== state.loadSeq) return;
    const got = prog.reduce((a, x) => a + x.got, 0), total = prog.reduce((a, x) => a + x.total, 0);
    if (decoded > 0) setLoader('Preparazione delle tracce…', `${decoded}/${n}`, 0.85 + 0.15 * (decoded / n));
    else if (total > 0) setLoader('Caricamento tracce…', `${mb(got)} / ${mb(total)}`, 0.85 * (got / total));
    else setLoader('Caricamento tracce…', `0/${n}`, null);
  };
  report();
  try {
    await engine.ready;
    const valid = p.tracks.filter((t) => songById(t.song));
    if (valid.length < p.tracks.length) toast('Alcune tracce puntano a brani eliminati dalla libreria e sono state tolte');
    const list = await Promise.all(valid.map(async (t, i) => {
      const data = await fetchWithProgress(sourceUrl(t.song, t.part), (got, total) => {
        Object.assign(prog[i], { started: true, got, total });
        report();
      }).catch((e) => { throw new Error(`${trackTitle(t)}: ${e.message}`); });
      const audio = await decodeToArrays(data);
      decoded++;
      report();
      return { name: t.name, song: t.song, part: t.part, label: t.label, clips: t.clips, ...audio };
    }));
    if (seq !== state.loadSeq) return;
    const pending = state.pending;
    state.pending = null;
    engine.setTracks(list, false, pending && pending.tracks);
    engine.setRate(state.tempo, state.pitch);
    engine.offset = 0;
    if (pending && pending.selection) {
      const k = 100 / state.tempo;
      state.sel = { start: pending.selection.start * k, end: Math.min(pending.selection.end * k, engine.duration) };
      state.loopOn = pending.loop;
    }
    engine.setLoop(state.loopOn && state.sel ? { ...state.sel } : null);
    updateSelectionUI();
    // riferimento iniziale: la prima traccia separata, altrimenti la prima traccia
    const ref = engine.tracks.find((t) => t.part !== 'original') || engine.tracks[0];
    if (ref) setReference(ref, true);
    else buildTracks();
    setLoader(null);
  } catch (e) {
    if (seq !== state.loadSeq) return;
    setLoader(null);
    alert(`Errore nel caricamento delle tracce: ${e.message}`);
  }
}

// ----------------------------------------------------------------- salvataggio

function projectState() {
  return {
    name: (state.current && state.current.name) || 'Progetto',
    tracks: engine.tracks.map((t) => ({ name: t.name, label: t.label || '', song: t.song, part: t.part, clips: t.clips })),
    groups: deep(state.groups),
    markers: state.markers || [],
  };
}

function saveProject() {
  const p = state.current;
  if (!p || state.pending) return;
  cleanGroups();
  clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(() => {
    projectSaveTimer = null;
    const body = projectState();
    api(`/api/projects/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(() => {
        const s = state.projects.find((x) => x.id === p.id);
        if (s) {
          s.name = body.name;
          s.songs = [...new Set(body.tracks.map((t) => (songById(t.song) || {}).name).filter(Boolean))];
          renderProjects();
        }
      })
      .catch((e) => toast(`Salvataggio del progetto non riuscito: ${e.message}`));
  }, 500);
}

/** Salva subito le modifiche in sospeso (cambio progetto, uscita). */
function flushProject(keepalive) {
  if (!projectSaveTimer || !state.current) return;
  clearTimeout(projectSaveTimer);
  projectSaveTimer = null;
  fetch(`/api/projects/${state.current.id}`, {
    method: 'PUT', keepalive: !!keepalive, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(projectState()),
  }).catch(() => {});
}

// ---------------------------------------------------- brani nella timeline

/** Aggiunge un brano della libreria come traccia intera, da `startDisplay` (null = testina). */
async function addSongToProject(songId, startDisplay) {
  let song = songById(songId);
  if (!song) return;
  if (!state.current) {
    const p = await createProject(song.name);
    if (!p) return;
    await openProject(p.id);
  }
  if (state.pending) await new Promise((r) => { const w = setInterval(() => { if (!state.pending) { clearInterval(w); r(); } }, 100); });
  const project = state.current;
  const start = +(Math.max(0, startDisplay ?? engine.position()) / (100 / engine.tempo)).toFixed(3);
  setLoader(`Aggiunta di "${song.name}"…`, 'preparazione del brano', null);
  try {
    const data = await fetchWithProgress(sourceUrl(song.id, 'original'), (got, total) => {
      if (total) setLoader(`Aggiunta di "${song.name}"…`, `${mb(got)} / ${mb(total)}`, got / total);
    });
    const audio = await decodeToArrays(data);
    if (state.current !== project) return;
    pushUndo('Aggiungi brano');
    const duration = audio.l.length / engine.sr;
    const t = engine.addTrack({ name: newTrackName(), song: song.id, part: 'original', label: '',
      clips: [{ id: newClipId(), start, offset: 0, duration }], ...audio });
    selectTracks([t.name]);
    setReference(t, true);
    saveProject();
    scrollTrackIntoView(t);
  } catch (e) {
    alert(`Impossibile aggiungere "${song.name}": ${e.message}`);
  } finally {
    setLoader(null);
  }
}

// ------------------------------------------------------------ separazione

/** "Separa tracce": sostituisce la traccia del brano intero con le sue tracce separate, raggruppate. */
async function splitTrack(t) {
  const song = songById(t.song);
  if (!song) return;
  if (song.status === 'ready') { await replaceWithStems(t); return; }
  state.pendingSplits.add(t.name);
  if (['queued', 'processing'].includes(song.status)) { toast('Separazione già in corso: la traccia verrà sostituita al termine'); updateSplitBadges(); return; }
  openProcess([song], (started) => {
    if (!started) state.pendingSplits.delete(t.name);
    else toast(`Separazione di "${song.name}" avviata: la traccia verrà sostituita al termine`);
    updateSplitBadges();
  });
}

async function replaceWithStems(t) {
  const song = songById(t.song);
  const stems = [...song.stems].sort((a, b) => STEMS_SORT.indexOf(a) - STEMS_SORT.indexOf(b));
  setLoader(`Tracce separate di "${song.name}"…`, '', null);
  try {
    const audios = await Promise.all(stems.map(async (part) => {
      const r = await fetch(sourceUrl(song.id, part));
      if (!r.ok) throw new Error(`${part}: HTTP ${r.status}`);
      return decodeToArrays(await r.arrayBuffer());
    }));
    if (!engine.tracks.includes(t)) return;
    pushUndo('Separa tracce');
    const at = engine.tracks.indexOf(t);
    const old = groupOf(t.name);
    engine.removeTrack(t);
    const created = stems.map((part, i) => engine.addTrack({
      name: newTrackName(), song: song.id, part, label: '',
      clips: t.clips.map((c) => ({ ...c, id: newClipId() })), ...audios[i],
    }));
    // le nuove tracce prendono il posto di quella originale
    engine.tracks = engine.tracks.filter((x) => !created.includes(x));
    engine.tracks.splice(at, 0, ...created);
    if (old) old.tracks = old.tracks.filter((n) => n !== t.name);
    // le tracce separate stanno in una cartella (apribile/chiudibile), come in Moises
    state.groups.push({ id: `g${newClipId()}`, name: song.name, tracks: created.map((x) => x.name), anchored: false,
      folder: true, collapsed: false, muted: false, solo: false, volume: 1 });
    cleanGroups();
    selectTracks(created.map((x) => x.name));
    setReference(created[0], true);
    saveProject();
    toast(`"${song.name}" separato in ${created.length} tracce (raggruppate) — Ctrl+Z per annullare`);
  } catch (e) {
    alert(`Separazione non riuscita: ${e.message}`);
  } finally {
    setLoader(null);
  }
}

/** Avanzamento della separazione sulle tracce in attesa; sostituzione al termine. */
function updateSplitBadges() {
  for (const t of engine.tracks) {
    const b = t.row && t.row.querySelector('.split-badge');
    if (!b) continue;
    const s = songById(t.song);
    const waiting = state.pendingSplits.has(t.name) && s && ['queued', 'processing'].includes(s.status);
    b.classList.toggle('hidden', !waiting);
    if (waiting) b.textContent = s.status === 'queued' ? '⏳' : `⑂ ${Math.round(s.progress * 100)}%`;
  }
}

/** Duplica la traccia (stesso audio e stesse clip), subito sotto l'originale. */
async function duplicateTrack(t) {
  setLoader(`Duplicazione di "${trackTitle(t)}"…`, '', null);
  try {
    const r = await fetch(sourceUrl(t.song, t.part));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const audio = await decodeToArrays(await r.arrayBuffer());
    pushUndo('Duplica traccia');
    const copy = engine.addTrack({ name: newTrackName(), song: t.song, part: t.part,
      label: `${trackTitle(t)} (copia)`, clips: t.clips.map((c) => ({ ...c, id: newClipId() })), ...audio });
    engine.tracks.splice(engine.tracks.indexOf(copy), 1);
    engine.tracks.splice(engine.tracks.indexOf(t) + 1, 0, copy);
    Object.assign(copy, { muted: t.muted, solo: t.solo, volume: t.volume });
    selectTracks([copy.name]);
    saveProject();
    buildTracks();
  } catch (e) {
    alert(`Duplicazione non riuscita: ${e.message}`);
  } finally {
    setLoader(null);
  }
}

function onSongsUpdated() {
  if (state.pendingAdds && state.pendingAdds.size) addPendingImports();
  if ($('#addtrack-dlg').open) renderAddTrackList();
  if (!state.current) return;
  for (const name of [...state.pendingSplits]) {
    const t = engine.tracks.find((x) => x.name === name);
    const s = t && songById(t.song);
    if (!t || !s) { state.pendingSplits.delete(name); continue; }
    if (s.status === 'ready' && !s.phase) { state.pendingSplits.delete(name); replaceWithStems(t); }
    else if (s.status === 'error') { state.pendingSplits.delete(name); toast(`Separazione di "${s.name}" non riuscita`); }
  }
  // il brano di riferimento può essere appena diventato separato
  if (state.refSong) {
    const s = songById(state.refSong.id);
    if (s && s.status === 'ready' && state.refSong.status !== 'ready') {
      const t = engine.tracks.find((x) => x.name === state.refTrack);
      if (t) setReference(t, true);
    } else if (s) state.refSong = s;
  }
  updateSplitBadges();
}

// --------------------------------------------- trascinamento nell'editor

function setupProjects() {
  Object.assign(state, { projects: [], refSong: null, refTrack: null, pendingSplits: new Set() });
  $('#project-new').addEventListener('click', async () => {
    const p = await createProject();
    if (p) openProject(p.id);
  });
  $('#title').addEventListener('change', () => {
    if (!state.current) return;
    state.current.name = $('#title').value.trim() || state.current.name;
    $('#title').value = state.current.name;
    saveProject();
  });
  $('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); });
  window.addEventListener('pagehide', () => flushProject(true));
  setupShell();
  refreshProjects().then(() => { if (!state.current) openDrawer('projects'); });
}

// ------------------------------------------------- pannello laterale (a scomparsa)

/** La barra di icone apre Progetti o Libreria in un pannello sovrapposto: la timeline resta larga. */
function openDrawer(panel) {
  const d = $('#sidebar');
  if (d.classList.contains('open') && d.dataset.panel === panel) { closeDrawer(); return; }
  d.dataset.panel = panel;
  document.querySelectorAll('#sidebar .panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== panel));
  document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('on', b.dataset.panel === panel));
  d.classList.add('open');
  document.body.classList.add('drawer-open');
}

function closeDrawer() {
  $('#sidebar').classList.remove('open');
  document.body.classList.remove('drawer-open');
  document.querySelectorAll('.rail-btn').forEach((b) => b.classList.remove('on'));
}

// ------------------------------------------------------ "Aggiungi traccia"

function renderAddTrackList() {
  const q = norm($('#at-search').value.trim());
  const list = state.songs.filter((s) => !q || norm(s.name).includes(q));
  const ul = $('#at-songs');
  ul.innerHTML = list.length ? '' : '<li class="empty-hint">Nessun brano: caricane uno dalla scheda "Dal computer" o da YouTube</li>';
  for (const s of list) {
    const li = document.createElement('li');
    const usable = !['downloading'].includes(s.status);
    li.className = usable ? '' : 'disabled';
    li.innerHTML = `<span class="at-name">${esc(s.name)}</span><span class="song-status ${s.status === 'new' ? 'new' : ''}">${esc(statusText(s))}</span>`;
    if (usable) li.addEventListener('click', () => { $('#addtrack-dlg').close(); addSongToProject(s.id, null); });
    ul.appendChild(li);
  }
}

function openAddTrack(tab = 'lib') {
  setAddTrackTab(tab);
  $('#at-search').value = '';
  renderAddTrackList();
  $('#addtrack-dlg').showModal();
  if (tab === 'lib') setTimeout(() => $('#at-search').focus(), 30);
}

function setAddTrackTab(tab) {
  document.querySelectorAll('.at-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.at-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
}

function setupShell() {
  state.pendingAdds = new Set();
  document.querySelectorAll('.rail-btn').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.panel)));
  document.querySelectorAll('.drawer-close').forEach((b) => b.addEventListener('click', closeDrawer));
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.code === 'Escape' && $('#sidebar').classList.contains('open')) closeDrawer(); });
  // trascinando un brano dalla libreria il pannello si toglie di mezzo e lascia vedere la timeline
  $('#songs').addEventListener('dragstart', () => setTimeout(closeDrawer, 0));
  $('#empty-projects').addEventListener('click', () => openDrawer('projects'));
  $('#empty-library').addEventListener('click', () => openDrawer('library'));
  $('#empty-new').addEventListener('click', async () => { const p = await createProject(); if (p) openProject(p.id); });

  document.querySelectorAll('.at-tabs button').forEach((b) => b.addEventListener('click', () => setAddTrackTab(b.dataset.tab)));
  $('#at-search').addEventListener('input', renderAddTrackList);
  $('#at-pick').addEventListener('click', () => { $('#addtrack-dlg').close(); $('#add-track-file').click(); });
  const drop = $('#at-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('over');
    $('#addtrack-dlg').close();
    addAudioFiles([...e.dataTransfer.files], null);
  });
  $('#at-yt-go').addEventListener('click', async () => {
    const url = $('#at-yt-url').value.trim();
    if (!url) return;
    try {
      const song = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      state.pendingAdds.add(song.id);
      $('#at-yt-url').value = '';
      $('#addtrack-dlg').close();
      await refreshSongs();
      const row = $('#pending-imports');
      if (row) row.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      alert(`Import fallito: ${e.message}`);
    }
  });
}

/** Righe di avanzamento dei download in corso, in fondo alle tracce. */
function renderPendingImports() {
  const box = $('#pending-imports');
  if (!box) return;
  const ids = state.current && state.pendingAdds ? [...state.pendingAdds] : [];
  box.innerHTML = ids.map((id) => {
    const s = songById(id);
    if (!s) return '';
    const pct = Math.round((s.progress || 0) * 100);
    const name = s.name && !/^https?:\/\//.test(s.name) ? s.name : 'Lettura del video…';
    const what = s.status === 'downloading' ? (pct ? `Download ${pct}%` : 'Preparazione del download…') : 'Aggiunta al progetto…';
    return `<div class="pending-row" data-id="${esc(id)}"><div class="track-head">
        <div class="pending-title" title="${esc(s.source_url || '')}"><span class="spinner"></span><span class="pending-name">${esc(name)}</span></div>
        <div class="pending-bar ${pct || s.status !== 'downloading' ? '' : 'indeterminate'}"><div style="width:${s.status === 'downloading' ? pct : 100}%"></div></div>
        <div class="pending-what">${esc(what)}</div>
      </div><div class="lane"></div></div>`;
  }).join('');
}

/** Brani importati da "Aggiungi traccia": entrano nel progetto appena scaricati. */
function addPendingImports() {
  for (const id of [...state.pendingAdds]) {
    const s = songById(id);
    if (!s) { state.pendingAdds.delete(id); continue; }
    if (s.status === 'error') { state.pendingAdds.delete(id); toast(`Download non riuscito: ${s.error || ''}`); continue; }
    if (s.status !== 'downloading' && state.current) { state.pendingAdds.delete(id); addSongToProject(id, null); }
  }
  renderPendingImports();
}
