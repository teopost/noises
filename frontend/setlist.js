'use strict';
// Scalette: elenchi ordinati di progetti da suonare uno dopo l'altro.
// Alla fine di un progetto si apre il successivo e, dopo la pausa impostata, parte da solo
// (oppure attende il Play).

const PAUSES = [
  [-1, 'Attendi il Play'], [0, 'Nessuna pausa'], [3, '3 secondi'], [5, '5 secondi'],
  [10, '10 secondi'], [15, '15 secondi'], [30, '30 secondi'], [60, '1 minuto'],
];

const setlistById = (id) => state.setlists.find((s) => s.id === id);
const projectName = (pid) => (state.projects.find((p) => p.id === pid) || {}).name;

async function refreshSetlists() {
  try {
    state.setlists = await api('/api/setlists');
  } catch (e) {
    console.error(e);
  }
  renderSetlists();
}

function saveSetlist(sl) {
  return api(`/api/setlists/${sl.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sl.name, projects: sl.projects, pause: sl.pause }),
  }).catch((e) => toast(`Scaletta non salvata: ${e.message}`));
}

// ------------------------------------------------------------------ pannello

function renderSetlists() {
  const open = state.openSetlist && setlistById(state.openSetlist);
  $('#setlist-list').classList.toggle('hidden', !!open);
  $('#setlist-detail').classList.toggle('hidden', !open);
  if (open) { renderSetlistDetail(open); return; }
  const ul = $('#setlists');
  ul.innerHTML = state.setlists.length ? ''
    : '<li class="empty-hint">Nessuna scaletta: premi ＋ per crearne una e mettere in fila i progetti da suonare</li>';
  for (const sl of state.setlists) {
    const li = document.createElement('li');
    li.className = state.setlist && state.setlist.id === sl.id ? 'active' : '';
    li.innerHTML = `<span class="pl-icon">≣</span><span class="pl-name">${esc(sl.name)}</span>
      <button class="play-sl" title="Suona la scaletta dall'inizio" ${sl.projects.length ? '' : 'disabled'}>▶</button>
      <span class="count">${sl.projects.length || ''}</span>`;
    li.addEventListener('click', () => { state.openSetlist = sl.id; renderSetlists(); });
    li.querySelector('.play-sl').addEventListener('click', (e) => { e.stopPropagation(); startSetlist(sl, 0); });
    ul.appendChild(li);
  }
}

function renderSetlistDetail(sl) {
  $('#sl-name').value = sl.name;
  $('#sl-pause').value = String(sl.pause);
  $('#sl-play').disabled = !sl.projects.length;
  const ul = $('#sl-projects');
  ul.innerHTML = sl.projects.length ? ''
    : '<li class="empty-hint">Scaletta vuota: aggiungi i progetti qui sotto, nell\'ordine in cui li suonerai</li>';
  sl.projects.forEach((pid, i) => {
    const li = document.createElement('li');
    const playing = state.setlist && state.setlist.id === sl.id && state.setlist.idx === i;
    li.className = `sl-item${playing ? ' active' : ''}`;
    li.draggable = true;
    li.innerHTML = `<span class="grip" title="Trascina per cambiare l'ordine">⠿</span><span class="sl-num">${i + 1}</span>
      <span class="pl-name">${esc(projectName(pid) || 'Progetto eliminato')}</span>
      <button class="play-from" title="Suona da qui">▶</button><button class="del" title="Togli dalla scaletta">✕</button>`;
    li.querySelector('.play-from').addEventListener('click', () => startSetlist(sl, i));
    li.querySelector('.del').addEventListener('click', () => {
      sl.projects.splice(i, 1);
      if (state.setlist && state.setlist.id === sl.id && state.setlist.idx >= i) state.setlist.idx = Math.max(0, state.setlist.idx - 1);
      saveSetlist(sl);
      renderSetlists();
      updateSetlistBar();
    });
    li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-noises-sl', String(i)); li.classList.add('dragging'); });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('application/x-noises-sl')) return;
      e.preventDefault();
      e.stopPropagation();
    });
    li.addEventListener('drop', (e) => {
      const from = Number(e.dataTransfer.getData('application/x-noises-sl'));
      if (Number.isNaN(from) || from === i) return;
      e.preventDefault();
      e.stopPropagation();
      const [moved] = sl.projects.splice(from, 1);
      sl.projects.splice(i, 0, moved);
      if (state.setlist && state.setlist.id === sl.id) {
        // l'indice in riproduzione segue il proprio progetto
        const cur = state.setlist.idx;
        if (cur === from) state.setlist.idx = i;
        else if (from < cur && i >= cur) state.setlist.idx--;
        else if (from > cur && i <= cur) state.setlist.idx++;
      }
      saveSetlist(sl);
      renderSetlists();
      updateSetlistBar();
    });
    ul.appendChild(li);
  });
  const sel = $('#sl-add');
  sel.innerHTML = '<option value="">＋ Aggiungi progetto…</option>'
    + state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('#sl-add-current').classList.toggle('hidden', !state.current);
}

async function newSetlist() {
  const name = (prompt('Nome della scaletta:', 'Nuova scaletta') || '').trim();
  if (!name) return;
  try {
    const sl = await api('/api/setlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    state.setlists.push(sl);
    state.openSetlist = sl.id;
    renderSetlists();
  } catch (e) {
    alert(`Creazione non riuscita: ${e.message}`);
  }
}

// ------------------------------------------------------------- riproduzione

/** Suona la scaletta a partire dal progetto in posizione `idx`. */
async function startSetlist(sl, idx) {
  if (!sl.projects.length) return;
  state.setlist = { id: sl.id, idx, countdown: null };
  closeDrawer();
  await goToSetlistItem(idx, 0);
}

/** Apre il progetto `idx` della scaletta e lo avvia dopo `pause` secondi (-1 = attende il Play). */
async function goToSetlistItem(idx, pause) {
  const sl = state.setlist && setlistById(state.setlist.id);
  if (!sl) return;
  cancelCountdown();
  state.setlist.idx = idx;
  const pid = sl.projects[idx];
  updateSetlistBar();
  if (engine.playing) engine.pause();
  if (!state.current || state.current.id !== pid) await openProject(pid);
  // attende la fine del caricamento (tracce e impostazioni)
  while (state.setlist && state.current && state.current.id === pid && (state.pending || !engine.tracks.length)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!state.setlist || !state.current || state.current.id !== pid) return;
  engine.seek(state.sel ? state.sel.start : 0);
  renderSetlists();
  if (pause < 0) { updateSetlistBar(); return; }
  if (pause === 0) { setlistPlay(); return; }
  let left = pause;
  state.setlist.countdown = left;
  updateSetlistBar();
  state.setlist.timer = setInterval(() => {
    left--;
    if (!state.setlist) return;
    if (left <= 0) { cancelCountdown(); setlistPlay(); return; }
    state.setlist.countdown = left;
    updateSetlistBar();
  }, 1000);
}

function setlistPlay() {
  cancelCountdown();
  if (!engine.playing) togglePlay();
  updateSetlistBar();
}

function cancelCountdown() {
  if (!state.setlist) return;
  clearInterval(state.setlist.timer);
  state.setlist.timer = null;
  state.setlist.countdown = null;
}

/** Fine naturale della riproduzione (non Stop/Pausa): passa al progetto successivo. */
function onPlaybackEnded() {
  const sl = state.setlist && setlistById(state.setlist.id);
  if (!sl) return;
  // aperto a mano un progetto diverso: la scaletta resta in attesa, senza saltare
  if (!state.current || state.current.id !== sl.projects[state.setlist.idx]) return;
  const next = state.setlist.idx + 1;
  if (next >= sl.projects.length) {
    toast(`Scaletta "${sl.name}" finita`);
    stopSetlist();
    return;
  }
  goToSetlistItem(next, sl.pause);
}

function stopSetlist() {
  cancelCountdown();
  state.setlist = null;
  updateSetlistBar();
  renderSetlists();
}

function updateSetlistBar() {
  const bar = $('#setlist-bar');
  const sl = state.setlist && setlistById(state.setlist.id);
  bar.classList.toggle('hidden', !sl);
  if (!sl) return;
  const { idx, countdown } = state.setlist;
  const next = sl.projects[idx + 1];
  $('#slb-name').textContent = sl.name;
  $('#slb-pos').textContent = `${Math.min(idx + 1, sl.projects.length)}/${sl.projects.length}`;
  const waiting = sl.pause < 0 && !engine.playing && state.current && state.current.id === sl.projects[idx];
  $('#slb-status').textContent = countdown != null ? `"${projectName(sl.projects[idx]) || ''}" parte tra ${countdown} s`
    : waiting ? 'Premi ▶ quando sei pronto'
    : next ? `Prossimo: ${projectName(next) || '—'}` : 'Ultimo brano della scaletta';
  $('#slb-now').classList.toggle('hidden', countdown == null);
  $('#slb-prev').disabled = idx <= 0;
  $('#slb-next').disabled = idx >= sl.projects.length - 1;
}

function setupSetlists() {
  Object.assign(state, { setlists: [], setlist: null, openSetlist: null });
  $('#sl-new').addEventListener('click', newSetlist);
  $('#sl-back').addEventListener('click', () => { state.openSetlist = null; renderSetlists(); });
  $('#sl-pause').innerHTML = PAUSES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('#sl-name').addEventListener('change', () => {
    const sl = setlistById(state.openSetlist);
    const name = $('#sl-name').value.trim();
    if (!sl || !name) { if (sl) $('#sl-name').value = sl.name; return; }
    sl.name = name;
    saveSetlist(sl);
    updateSetlistBar();
  });
  $('#sl-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); });
  $('#sl-pause').addEventListener('change', () => {
    const sl = setlistById(state.openSetlist);
    if (!sl) return;
    sl.pause = Number($('#sl-pause').value);
    saveSetlist(sl);
  });
  $('#sl-add').addEventListener('change', () => {
    const sl = setlistById(state.openSetlist);
    const pid = $('#sl-add').value;
    if (!sl || !pid) return;
    sl.projects.push(pid);
    saveSetlist(sl);
    renderSetlists();
    updateSetlistBar();
  });
  $('#sl-add-current').addEventListener('click', () => {
    const sl = setlistById(state.openSetlist);
    if (!sl || !state.current) return;
    sl.projects.push(state.current.id);
    saveSetlist(sl);
    renderSetlists();
    updateSetlistBar();
  });
  $('#sl-play').addEventListener('click', () => { const sl = setlistById(state.openSetlist); if (sl) startSetlist(sl, 0); });
  $('#sl-delete').addEventListener('click', async () => {
    const sl = setlistById(state.openSetlist);
    if (!sl || !confirm(`Eliminare la scaletta "${sl.name}"?\nI progetti non vengono eliminati.`)) return;
    try {
      await api(`/api/setlists/${sl.id}`, { method: 'DELETE' });
    } catch (e) {
      alert(e.message);
      return;
    }
    if (state.setlist && state.setlist.id === sl.id) stopSetlist();
    state.setlists = state.setlists.filter((x) => x !== sl);
    state.openSetlist = null;
    renderSetlists();
  });
  $('#slb-prev').addEventListener('click', () => state.setlist && goToSetlistItem(state.setlist.idx - 1, -1));
  $('#slb-next').addEventListener('click', () => state.setlist && goToSetlistItem(state.setlist.idx + 1, -1));
  $('#slb-now').addEventListener('click', setlistPlay);
  $('#slb-exit').addEventListener('click', stopSetlist);
  $('#slb-name').addEventListener('click', () => {
    if (!state.setlist) return;
    state.openSetlist = state.setlist.id;
    renderSetlists();
    openDrawer('setlists');
  });
  refreshSetlists();
}
