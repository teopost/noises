'use strict';

const $ = (s) => document.querySelector(s);
const COLORS = { vocals: '#ff6b9a', drums: '#ffb547', bass: '#4fd1c5', guitar: '#7cc4ff', piano: '#c49bff', other: '#9be36b' };
const LABELS = { vocals: 'Voce', drums: 'Batteria', bass: 'Basso', guitar: 'Chitarra', piano: 'Piano', other: 'Altro' };
const MODEL_LABELS = { htdemucs: '4 tracce', htdemucs_ft: '4 tracce HQ', htdemucs_6s: '6 tracce' };

const state = { zoom: 40, follow: true, notes: null, showNotes: new Set(), synth: new Set(), selNote: null,
  songs: [], playlists: [], view: 'all', query: '', current: null, pitch: 0, tempo: 100, loadSeq: 0, debounce: null, sel: null, loopOn: false };

const fmt = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch {}
    const err = new Error(msg);
    err.status = r.status;
    if (r.status === 401 && !path.startsWith('/api/auth/') && typeof showAuth === 'function') showAuth('login');
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

// =================================================================== audio engine

// Le tracce restano alla velocità e tonalità originali: il motore in tempo reale
// (stretch-worklet.js) le mixa e applica velocità/tonalità mentre suona.
// Le posizioni esposte (offset, duration, loop, stopAt) sono nella "timeline corrente",
// cioè già scalate per la velocità: 1 secondo di timeline = 1 secondo reale di ascolto.
const engine = {
  ctx: null, master: null, node: null, ready: null,
  tracks: [],          // { name, peaks, muted, solo, volume, row, canvas, color }
  sr: 44100,
  origDuration: 0,     // durata originale (s)
  playing: false, offset: 0, duration: 0, t0: 0,
  tempo: 100,          // velocità corrente (%)
  pitch: 0,            // tonalità corrente (semitoni)
  loop: null,          // { start, end } quando il loop è attivo
  stopAt: null,        // fine di "riproduci selezione"
  rep: null,           // ultima posizione comunicata dal motore { src, frame }
  repMinFrame: 0,

  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.sr = this.ctx.sampleRate;
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.ready = this.ctx.audioWorklet.addModule('stretch-worklet.js').then(() => {
      this.node = new AudioWorkletNode(this.ctx, 'stretch-player', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      this.node.connect(this.master);
      this.node.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'pos') {
          if (this.playing && m.frame >= this.repMinFrame) this.rep = m;
        } else if (m.type === 'ended' && this.playing) {
          this.stop();
        }
      };
    });
  },

  post(msg, transfer) {
    this.node.port.postMessage(msg, transfer || []);
  },

  /** secondi della timeline corrente ↔ campioni del brano originale */
  k() { return 100 / this.tempo; },
  toSrc(t) { return (t / this.k()) * this.sr; },

  /** list: [{ name, l, r, peaks }] con canali già alla stessa lunghezza. */
  setTracks(list, keepMix, initialMix) {
    const prev = keepMix ? Object.fromEntries(this.tracks.map((t) => [t.name, t])) : (initialMix || {});
    this.tracks = list.map(({ name, peaks }) => {
      const p = prev[name];
      return { name, peaks, muted: !!(p && p.muted), solo: !!(p && p.solo), volume: p && p.volume != null ? p.volume : 1 };
    });
    const length = Math.max(0, ...list.map((t) => t.l.length));
    this.origDuration = length / this.sr;
    this.duration = this.origDuration * this.k();
    this.post({
      type: 'load', length,
      stems: list.map((t, i) => ({ l: t.l, r: t.r, gain: this.gainOf(this.tracks[i]) })),
    }, list.flatMap((t) => (t.r && t.r !== t.l ? [t.l.buffer, t.r.buffer] : [t.l.buffer])));
  },

  clear() {
    this.stop();
    if (this.node) this.post({ type: 'load', length: 0, stems: [] });
    this.tracks = [];
    this.duration = 0;
    this.origDuration = 0;
  },

  position() {
    if (!this.playing) return this.offset;
    const now = this.ctx.currentTime;
    if (now < this.t0) return this.offset; // durante il pre-conteggio
    let p;
    if (this.rep) {
      // posizione esatta comunicata dal motore + tempo trascorso da allora
      const orig = this.rep.src / this.sr + Math.max(0, now - this.rep.frame / this.sr) * (this.tempo / 100);
      p = orig * this.k();
    } else {
      p = this.offset + (now - this.t0);
    }
    const L = this.loop;
    if (L && p >= L.end) p = L.start + ((p - L.start) % (L.end - L.start));
    return Math.min(Math.max(0, p), this.duration);
  },

  /** Attiva/disattiva il loop (sample-accurate nel motore). */
  setLoop(range) {
    this.loop = range;
    if (this.node) {
      this.post({ type: 'loop', loop: range ? { s: Math.round(this.toSrc(range.start)), e: Math.round(this.toSrc(range.end)) } : null });
    }
    if (range && this.playing) {
      const pos = this.position();
      if (pos < range.start || pos >= range.end) this.seek(range.start);
    }
  },

  /** Posizione effettiva da cui partirà la riproduzione (inizio brano/loop se fuori). */
  startOffset() {
    let o = this.offset >= this.duration - 0.05 ? 0 : this.offset;
    const L = this.loop;
    if (L && (o < L.start || o >= L.end)) o = L.start;
    return o;
  },

  play(delay = 0) {
    if (!this.tracks.length || this.playing || !this.node) return;
    this.ctx.resume();
    this.offset = this.startOffset();
    this.t0 = this.ctx.currentTime + 0.05 + delay;
    this.rep = null;
    this.repMinFrame = Math.round(this.t0 * this.sr);
    this.post({ type: 'play', at: this.t0, pos: this.toSrc(this.offset) });
    this.playing = true;
  },

  pause() {
    if (!this.playing) return;
    this.offset = this.position();
    this.post({ type: 'pause' });
    this.playing = false;
    synthStopAll();
    countInStop();
  },

  stop() {
    this.pause();
    this.offset = this.loop ? this.loop.start : 0;
    this.stopAt = null;
  },

  seek(t) {
    this.offset = Math.min(Math.max(0, t), this.duration);
    if (typeof setFixedAnchor === 'function') setFixedAnchor(this.offset); // click regolare riallineato
    if (!this.playing) return;
    if (this.ctx.currentTime < this.t0) { // durante il pre-conteggio: cambia solo il punto di partenza
      this.post({ type: 'play', at: this.t0, pos: this.toSrc(this.offset) });
      return;
    }
    this.post({ type: 'seek', pos: this.toSrc(this.offset) });
    this.t0 = this.ctx.currentTime;
    this.rep = null;
    this.repMinFrame = Math.round(this.t0 * this.sr);
    synthStopAll();
  },

  /** Cambia velocità (%) e tonalità (semitoni) all'istante, senza interrompere l'ascolto. */
  setRate(tempo, pitch) {
    if (tempo === this.tempo && pitch === this.pitch) return 1;
    const pos = this.position();
    const ratio = (100 / tempo) / this.k(); // fattore di scala della timeline
    this.tempo = tempo;
    this.pitch = pitch;
    this.duration = this.origDuration * this.k();
    this.offset = Math.min(pos * ratio, this.duration);
    if (this.stopAt != null) this.stopAt *= ratio;
    if (this.loop) this.loop = { start: this.loop.start * ratio, end: this.loop.end * ratio };
    if (this.node) {
      this.post({ type: 'rate', rate: tempo / 100, pitch: Math.pow(2, pitch / 12) });
      if (this.loop) this.setLoop(this.loop);
    }
    if (this.playing) {
      this.t0 = this.ctx.currentTime;
      this.rep = null;
      this.repMinFrame = Math.round(this.t0 * this.sr);
      synthStopAll();
    }
    return ratio;
  },

  isAudible(t) {
    const anySolo = this.tracks.some((x) => x.solo);
    return anySolo ? t.solo : !t.muted;
  },

  gainOf(t) {
    return this.isAudible(t) ? t.volume : 0;
  },

  updateGains() {
    if (this.node) this.post({ type: 'gains', gains: this.tracks.map((t) => this.gainOf(t)) });
  },
};

// ======================================================================= library

let pollTimer;
async function refreshSongs() {
  clearTimeout(pollTimer);
  try {
    state.songs = await api('/api/songs');
    renderPlaylists();
    renderSongs();
  } catch (e) {
    console.error(e);
  }
  const pending = state.songs.some((s) => ['downloading', 'queued', 'processing'].includes(s.status) || s.phase);
  pollTimer = setTimeout(refreshSongs, pending ? 1500 : 10000);
}

function statusText(s) {
  switch (s.status) {
    case 'downloading': return `Download ${Math.round(s.progress * 100)}%`;
    case 'new': return 'Da elaborare';
    case 'queued': return 'In coda…';
    case 'processing': return `Separazione ${Math.round(s.progress * 100)}%`;
    case 'ready': return `Pronto · ${s.stems.length} tracce${s.phase ? ` · ${s.phase}…` : ''}`;
    default: return `Errore: ${s.error || 'sconosciuto'}`;
  }
}

const norm = (x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const currentPlaylist = () => state.playlists.find((p) => p.id === state.view) || null;

/** Brani da mostrare: filtrati per playlist selezionata e testo di ricerca. */
function visibleSongs() {
  const pl = currentPlaylist();
  let list = state.songs;
  if (pl) {
    const byId = Object.fromEntries(state.songs.map((s) => [s.id, s]));
    list = pl.songs.map((id) => byId[id]).filter(Boolean);
  }
  const q = norm(state.query.trim());
  return q ? list.filter((s) => norm(s.name).includes(q)) : list;
}

function renderSongs() {
  const pl = currentPlaylist();
  $('#lib-title').textContent = pl ? pl.name : 'Libreria';
  const list = visibleSongs();
  $('#lib-count').textContent = list.length ? `${list.length}` : '';
  const waiting = list.filter((x) => x.status === 'new');
  $('#process-all').classList.toggle('hidden', waiting.length < 2);
  $('#process-all').textContent = `▶ Elabora tutti (${waiting.length})`;
  const ul = $('#songs');
  ul.innerHTML = '';
  if (!list.length) {
    const msg = state.query.trim() ? 'Nessun brano corrisponde alla ricerca'
      : pl ? 'Playlist vuota: aggiungi brani con ⋯ o trascinandoli sulla playlist'
      : 'Nessun brano caricato';
    ul.innerHTML = `<li class="disabled"><span class="song-status">${msg}</span></li>`;
    return;
  }
  for (const s of list) {
    const li = document.createElement('li');
    li.className = (state.current && state.current.id === s.id ? 'active ' : '') + (s.status !== 'ready' ? 'disabled' : '');
    li.draggable = true;
    const inPl = state.playlists.filter((p) => p.songs.includes(s.id)).length;
    li.innerHTML = `
      <div class="song-row">
        <span class="song-name" title="${esc(s.name)}">${esc(s.name)}</span>
        ${s.status === 'new' ? '<button class="go" title="Avvia separazione e analisi">▶ Elabora</button>' : ''}
        ${s.status === 'error' ? '<button class="go" title="Riprova l\'elaborazione">↻ Riprova</button>' : ''}
        <button class="more" title="Playlist…">⋯</button>
        <button class="del" title="${pl ? 'Elimina dalla libreria' : 'Elimina'}">✕</button>
      </div>
      <span class="song-status ${s.status === 'error' ? 'error' : s.status === 'new' ? 'new' : ''}">${esc(statusText(s))}${s.status === 'new' ? '' : ` · ${MODEL_LABELS[s.model] || s.model}`}${inPl ? ` · ♫ ${inPl}` : ''}</span>
      ${['downloading', 'queued', 'processing'].includes(s.status) ? `<div class="bar"><div style="width:${s.progress * 100}%"></div></div>` : ''}`;
    li.addEventListener('click', () => {
      if (s.status === 'ready') selectSong(s);
      else if (s.status === 'new' || s.status === 'error') openProcess([s]);
    });
    const go = li.querySelector('.go');
    if (go) go.addEventListener('click', (ev) => { ev.stopPropagation(); openProcess([s]); });
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-noises-song', s.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    li.querySelector('.more').addEventListener('click', (ev) => {
      ev.stopPropagation();
      openPlaylistMenu(s, ev.currentTarget);
    });
    li.querySelector('.del').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Eliminare definitivamente "${s.name}"?${inPl ? '\nVerrà rimosso anche dalle playlist.' : ''}`)) return;
      await api(`/api/songs/${s.id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
      if (state.current && state.current.id === s.id) closePlayer();
      await refreshPlaylists();
      refreshSongs();
    });
    ul.appendChild(li);
  }
}

// ====================================================================== playlist

async function refreshPlaylists() {
  try {
    state.playlists = await api('/api/playlists');
  } catch (e) {
    console.error(e);
  }
  if (state.view !== 'all' && !currentPlaylist()) setView('all');
  renderPlaylists();
  renderSongs();
}

function setView(v) {
  state.view = v;
  try { localStorage.setItem('noises.view', v); } catch {}
  renderPlaylists();
  renderSongs();
}

function renderPlaylists() {
  const ul = $('#playlists');
  ul.innerHTML = '';
  const item = (id, name, count, editable) => {
    const li = document.createElement('li');
    li.className = state.view === id ? 'active' : '';
    li.innerHTML = `<span class="pl-icon">${editable ? '♫' : '▤'}</span>
      <span class="pl-name" title="${esc(name)}">${esc(name)}</span>
      ${editable ? '<button class="ren" title="Rinomina">✎</button><button class="del" title="Elimina playlist">✕</button>' : ''}
      <span class="count">${count}</span>`;
    li.addEventListener('click', () => setView(id));
    if (editable) {
      li.querySelector('.ren').addEventListener('click', (e) => { e.stopPropagation(); renamePlaylist(id); });
      li.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deletePlaylist(id); });
      // trascina un brano sulla playlist per aggiungerlo
      li.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-noises-song')) return;
        e.preventDefault();
        li.classList.add('drop');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drop');
        const songId = e.dataTransfer.getData('application/x-noises-song');
        if (songId) setMembership(id, songId, true);
      });
    }
    ul.appendChild(li);
  };
  item('all', 'Tutti i brani', state.songs.length, false);
  for (const p of state.playlists) item(p.id, p.name, p.songs.length, true);
}

async function createPlaylist(name) {
  name = (name ?? prompt('Nome della nuova playlist:') ?? '').trim();
  if (!name) return null;
  try {
    const pl = await api('/api/playlists', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    await refreshPlaylists();
    return pl;
  } catch (e) {
    alert(e.message);
    return null;
  }
}

async function renamePlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  const name = (prompt('Nuovo nome della playlist:', pl.name) || '').trim();
  if (!name || name === pl.name) return;
  await api(`/api/playlists/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }).catch((e) => alert(e.message));
  refreshPlaylists();
}

async function deletePlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!confirm(`Eliminare la playlist "${pl.name}"?\nI brani restano nella libreria.`)) return;
  await api(`/api/playlists/${id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
  refreshPlaylists();
}

async function setMembership(plId, songId, on) {
  try {
    await api(`/api/playlists/${plId}/songs/${songId}`, { method: on ? 'PUT' : 'DELETE' });
  } catch (e) {
    alert(e.message);
  }
  await refreshPlaylists();
}

/** Aggiunge un brano appena caricato/importato alla playlist aperta. */
function addToCurrentPlaylist(song) {
  const pl = currentPlaylist();
  return pl && song ? setMembership(pl.id, song.id, true) : null;
}

function openPlaylistMenu(song, anchor) {
  const menu = $('#pl-menu');
  const build = () => {
    menu.innerHTML = `<div class="menu-title">Aggiungi a playlist</div>
      ${state.playlists.map((p) => `
        <label class="menu-item"><input type="checkbox" data-pl="${p.id}" ${p.songs.includes(song.id) ? 'checked' : ''}>
        <span>${esc(p.name)}</span></label>`).join('') || '<div class="menu-empty">Nessuna playlist</div>'}
      <button class="menu-item new">＋ Nuova playlist…</button>`;
    menu.querySelectorAll('[data-pl]').forEach((cb) =>
      cb.addEventListener('change', async () => { await setMembership(cb.dataset.pl, song.id, cb.checked); build(); }));
    menu.querySelector('.new').addEventListener('click', async () => {
      const pl = await createPlaylist();
      if (pl) await setMembership(pl.id, song.id, true);
      build();
    });
  };
  build();
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
  const top = r.bottom + menu.offsetHeight > window.innerHeight - 8 ? r.top - menu.offsetHeight - 4 : r.bottom + 4;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function setupPlaylists() {
  try { state.view = localStorage.getItem('noises.view') || 'all'; } catch {}
  $('#pl-new').addEventListener('click', async () => {
    const pl = await createPlaylist();
    if (pl) setView(pl.id);
  });
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderSongs(); });
  document.addEventListener('pointerdown', (e) => {
    const menu = $('#pl-menu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !e.target.matches('.more')) {
      menu.classList.add('hidden');
    }
  });
  document.addEventListener('keydown', (e) => { if (e.code === 'Escape') $('#pl-menu').classList.add('hidden'); });
}

// =================================================================== elaborazione

let processTargets = [];

function openProcess(songs) {
  processTargets = songs;
  $('#proc-names').textContent = songs.length === 1 ? songs[0].name : `${songs.length} brani in attesa`;
  const first = songs[0];
  if (first.status === 'error') {
    $('#proc-model').value = first.model;
    $('#proc-chords').checked = first.tasks ? first.tasks.chords : true;
    $('#proc-notes').checked = first.tasks ? first.tasks.notes : true;
  } else {
    try {
      const p = JSON.parse(localStorage.getItem('noises.process') || 'null');
      if (p) { $('#proc-model').value = p.model; $('#proc-chords').checked = p.chords; $('#proc-notes').checked = p.notes; }
    } catch {}
  }
  $('#process-dlg').showModal();
}

async function startProcess() {
  const body = { model: $('#proc-model').value, chords: $('#proc-chords').checked, notes: $('#proc-notes').checked };
  try { localStorage.setItem('noises.process', JSON.stringify(body)); } catch {}
  for (const s of processTargets) {
    try {
      await api(`/api/songs/${s.id}/process`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) {
      alert(`"${s.name}": ${e.message}`);
    }
  }
  processTargets = [];
  refreshSongs();
}

function setupProcess() {
  $('#process-dlg').addEventListener('close', () => {
    if ($('#process-dlg').returnValue === 'ok') startProcess();
  });
  $('#process-all').addEventListener('click', () => {
    const waiting = visibleSongs().filter((x) => x.status === 'new');
    if (waiting.length) openProcess(waiting);
  });
}

// ======================================================================== upload

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/songs');
    const bar = $('#upload-progress');
    bar.classList.remove('hidden');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) bar.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`;
    };
    xhr.onload = () => {
      bar.classList.add('hidden');
      bar.firstElementChild.style.width = '0';
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else {
        let msg = xhr.statusText;
        try { msg = JSON.parse(xhr.responseText).error; } catch {}
        reject(new Error(msg || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => { bar.classList.add('hidden'); reject(new Error('errore di rete')); };
    xhr.send(fd);
  });
}

async function uploadFiles(files) {
  for (const f of files) {
    try {
      const song = await uploadFile(f);
      await addToCurrentPlaylist(song);
      refreshSongs();
    } catch (e) {
      alert(`Caricamento di "${f.name}" fallito: ${e.message}`);
    }
  }
}

function setupImport() {
  const form = $('#yt'), input = $('#yt-url'), btn = $('#yt-btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      const song = await api('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: input.value.trim() }),
      });
      input.value = '';
      await addToCurrentPlaylist(song);
      refreshSongs();
    } catch (err) {
      alert(`Import fallito: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

function setupUpload() {
  const dz = $('#upload'), input = $('#file');
  $('#pick').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { uploadFiles([...input.files]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));
}

// ======================================================================== player

function selectSong(song) {
  if (state.current && state.current.id === song.id) return;
  if (state.current) flushAutosave();
  state.ab = 'custom';
  state.customSnap = null;
  engine.init();
  engine.clear();
  state.current = song;
  const cfg = song.settings || {};
  state.pitch = cfg.pitch || 0;
  state.tempo = cfg.tempo || 100;
  state.sel = null;
  state.loopOn = false;
  // selezione e mix vengono applicati quando le tracce sono caricate
  state.pending = { tracks: cfg.tracks || null, selection: cfg.selection || null, loop: !!cfg.loop };
  state.saved = JSON.stringify(normalizeSettings(cfg));
  setMaster(cfg.master ?? 1);
  engine.loop = null;
  engine.stopAt = null;
  updateKnobs();
  updateSelectionUI();
  $('#empty').classList.add('hidden');
  $('#player').classList.remove('hidden');
  $('#title').textContent = song.name;
  showSkeleton(song.stems.length);
  renderSongs();
  loadStems(false);
  loadChords(song);
  loadNotes(song);
}

function closePlayer() {
  engine.clear();
  state.chords = null;
  state.notes = null;
  closeChordMenu();
  state.current = null;
  state.loadSeq++;
  setLoader(null);
  $('#player').classList.add('hidden');
  $('#empty').classList.remove('hidden');
}

/** Mostra il pannello di caricamento. `frac` = 0..1, oppure null per una barra indeterminata. */
function setLoader(text, detail = '', frac = null) {
  $('#loader').classList.toggle('hidden', !text);
  if (!text) return;
  $('#loader-text').textContent = text;
  $('#loader-detail').textContent = detail;
  const bar = $('#loader-bar');
  bar.parentElement.classList.toggle('indeterminate', frac === null);
  bar.style.width = frac === null ? '' : `${Math.round(frac * 100)}%`;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/** Scarica un URL in streaming, notificando i byte ricevuti. */
async function fetchWithProgress(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('Content-Length')) || 0;
  onProgress(0, total);
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

function showSkeleton(n) {
  $('#tracks').innerHTML = Array.from({ length: n }, () =>
    '<div class="track skeleton"><div class="track-head"><span></span></div><div class="wave-ph"></div></div>').join('');
}

function stemUrl(song, name) {
  return `/api/songs/${song.id}/stems/${encodeURIComponent(name)}?pitch=${state.pitch}&tempo=${state.tempo}`;
}

/** Scarica (ed eventualmente fa elaborare al server) le tracce per la tonalità/velocità correnti. */
/** Scarica e decodifica le tracce originali del brano (una volta sola per brano). */
async function loadStems(keepMix) {
  const seq = ++state.loadSeq;
  const song = state.current;
  const n = song.stems.length;
  const prog = song.stems.map(() => ({ started: false, got: 0, total: 0 }));
  let decoded = 0;
  const report = () => {
    if (seq !== state.loadSeq) return;
    const started = prog.filter((p) => p.started).length;
    const got = prog.reduce((a, p) => a + p.got, 0);
    const total = prog.reduce((a, p) => a + p.total, 0);
    if (decoded > 0 || (started === n && got >= total && total > 0)) {
      setLoader('Preparazione delle tracce…', `${decoded}/${n}`, 0.85 + 0.15 * (decoded / n));
    } else if (total > 0 && started === n) {
      setLoader('Caricamento tracce…', `${mb(got)} / ${mb(total)}`, 0.85 * (got / total));
    } else {
      setLoader('Caricamento tracce…', `${started}/${n}`, null);
    }
  };
  report();
  try {
    await engine.ready;
    const list = await Promise.all(song.stems.map(async (name, i) => {
      const data = await fetchWithProgress(`/api/songs/${song.id}/stems/${encodeURIComponent(name)}`, (got, total) => {
        Object.assign(prog[i], { started: true, got, total });
        report();
      }).catch((e) => { throw new Error(`${name}: ${e.message}`); });
      const buffer = await engine.ctx.decodeAudioData(data);
      decoded++;
      report();
      return { name, buffer };
    }));
    if (seq !== state.loadSeq) return;

    // canali copiati in array propri (stessa lunghezza) da passare al motore audio
    const length = Math.max(...list.map((t) => t.buffer.length));
    const stems = list.map(({ name, buffer }) => {
      const l = new Float32Array(length);
      l.set(buffer.getChannelData(0));
      let r = l;
      if (buffer.numberOfChannels > 1) {
        r = new Float32Array(length);
        r.set(buffer.getChannelData(1));
      }
      return { name, l, r, peaks: computePeaks(l, r) };
    });

    const pending = state.pending;
    state.pending = null;
    engine.setTracks(stems, keepMix, pending && pending.tracks);
    engine.setRate(state.tempo, state.pitch);
    engine.offset = 0;
    if (pending && pending.selection) {
      // la selezione è salvata in tempo originale (velocità 100%)
      const k = 100 / state.tempo;
      state.sel = { start: pending.selection.start * k, end: Math.min(pending.selection.end * k, engine.duration) };
      state.loopOn = pending.loop;
    }
    engine.setLoop(state.loopOn && state.sel ? { ...state.sel } : null);
    updateSelectionUI();
    buildTracks();
    setLoader(null);
  } catch (e) {
    if (seq !== state.loadSeq) return;
    setLoader(null);
    if (!engine.tracks.length) $('#tracks').innerHTML = '';
    alert(`Errore nel caricamento delle tracce: ${e.message}`);
  }
}

/** Applica subito tonalità e velocità correnti (motore in tempo reale). */
function applyRate() {
  updateKnobs();
  if (!engine.tracks.length) return;
  const tl = tlEl();
  const ratio = engine.setRate(state.tempo, state.pitch);
  schedHorizon = null;
  if (typeof layoutRoll === 'function') for (const stem of Object.keys(rolls)) layoutRoll(stem);
  for (const t of engine.tracks) { // i download delle tracce usano tonalità/velocità correnti
    const a = t.row && t.row.querySelector('a[download]');
    if (a) a.href = stemUrl(state.current, t.name);
  }
  if (ratio === 1) { requestRedraw(); return; }
  if (state.sel) state.sel = { start: state.sel.start * ratio, end: Math.min(state.sel.end * ratio, engine.duration) };
  const centre = tl.scrollLeft + (tl.clientWidth - headWidth()) / 2;
  layoutTimeline();
  tl.scrollLeft = Math.max(0, centre * ratio - (tl.clientWidth - headWidth()) / 2);
  updateSelectionUI();
  if (typeof updateRhythmControls === 'function') updateRhythmControls();
}

function updateKnobs() {
  const p = state.pitch;
  $('#pitch').textContent = p > 0 ? `+${p}` : `${p}`;
  $('#tempo').textContent = `${state.tempo}%`;
  $('#tempo-range').value = state.tempo;
}

function setupControls() {
  $('#play').addEventListener('click', togglePlay);
  $('#stop').addEventListener('click', () => engine.stop());
  $('#to-start').addEventListener('click', goToStart);
  $('#back').addEventListener('click', () => engine.seek(engine.position() - 5));
  $('#fwd').addEventListener('click', () => engine.seek(engine.position() + 5));

  document.querySelectorAll('[data-pitch]').forEach((b) => b.addEventListener('click', () => {
    const v = Math.max(-12, Math.min(12, state.pitch + Number(b.dataset.pitch)));
    if (v !== state.pitch) { state.pitch = v; applyRate(); }
  }));
  document.querySelectorAll('[data-tempo]').forEach((b) => b.addEventListener('click', () => {
    const v = Math.max(50, Math.min(150, state.tempo + Number(b.dataset.tempo)));
    if (v !== state.tempo) { state.tempo = v; applyRate(); }
  }));
  $('#tempo-range').addEventListener('input', (e) => {
    state.tempo = Number(e.target.value);
    applyRate();
  });
  $('#reset').addEventListener('click', () => {
    if (state.pitch === 0 && state.tempo === 100) return;
    state.pitch = 0;
    state.tempo = 100;
    applyRate();
  });
  $('#master').addEventListener('input', (e) => setMaster(Number(e.target.value)));
  document.querySelectorAll('#ab button').forEach((b) => b.addEventListener('click', () => setAB(b.dataset.ab)));
  $('#reset-all').addEventListener('click', resetSettings);

  document.addEventListener('keydown', (e) => {
    if (!state.current || e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') engine.seek(engine.position() - 5);
    else if (e.code === 'ArrowRight') engine.seek(engine.position() + 5);
    else if (e.code === 'Home') { e.preventDefault(); goToStart(); }
    else if (e.code === 'KeyL') toggleLoop();
    else if (e.code === 'Escape') setSelection(null);
  });

  $('#loop').addEventListener('click', toggleLoop);
  $('#play-sel').addEventListener('click', playSelection);
  $('#sel-clear').addEventListener('click', () => setSelection(null));
  $('#export').addEventListener('click', openExport);
  $('#export-dlg').addEventListener('close', () => {
    if ($('#export-dlg').returnValue === 'ok') doExport();
  });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layoutTimeline, 120); });
}

/** Torna all'inizio del brano (o del loop, se attivo) e riporta la vista all'inizio. */
function goToStart() {
  engine.stopAt = null;
  engine.seek(engine.loop ? engine.loop.start : 0);
  const tl = tlEl();
  tl.scrollLeft = Math.max(0, engine.position() * state.zoom - 40);
}

function togglePlay() {
  if (engine.playing) engine.pause();
  else playWithCountIn();
}

// ====================================================================== timeline
//
// La timeline ha un'unità fissa (state.zoom = pixel al secondo) e scorre orizzontalmente.
// Le intestazioni delle tracce sono "sticky" a sinistra; ogni corsia contiene un canvas
// sticky largo quanto l'area visibile, ridisegnato a ogni scroll: si disegna solo ciò che si vede.

const tlEl = () => $('#timeline');
const headWidth = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--head-w')) || 230;
const ZOOM_MIN = 2, ZOOM_MAX = 400;

function buildTracks() {
  const root = $('#tracks');
  root.innerHTML = '';
  const song = state.current;
  for (const t of engine.tracks) {
    const label = LABELS[t.name] || t.name;
    const color = COLORS[t.name] || '#aaa';
    const row = document.createElement('div');
    row.className = 'track audio-row';
    row.innerHTML = `
      <div class="track-head">
        <div class="track-title"><span class="swatch" style="background:${color}"></span>${esc(label)}</div>
        <div class="track-btns">
          <button class="m" title="Muto">M</button>
          <button class="s" title="Solo">S</button>
          <input type="range" min="0" max="1.5" step="0.01" value="${t.volume}" title="Volume">
          <button class="n" title="Mostra le note trascritte">♪</button>
          <a title="Scarica traccia" download="${esc(`${song.name} - ${label}.flac`)}" href="${stemUrl(song, t.name)}">⤓</a>
        </div>
      </div>
      <div class="lane"><canvas class="wave vcanvas"></canvas></div>`;
    const m = row.querySelector('.m'), s = row.querySelector('.s');
    m.addEventListener('click', () => { t.muted = !t.muted; syncTrackButtons(); });
    s.addEventListener('click', () => { t.solo = !t.solo; syncTrackButtons(); });
    row.querySelector('input').addEventListener('input', (e) => { t.volume = Number(e.target.value); engine.updateGains(); });
    row.querySelector('.n').addEventListener('click', () => toggleNotesLane(t.name));
    t.row = row;
    t.canvas = row.querySelector('canvas');
    t.color = color;
    root.appendChild(row);
    root.appendChild(buildNotesRow(t));
  }
  syncTrackButtons();
  layoutTimeline();
  renderChords();
  updateRhythmControls();
}

function syncTrackButtons() {
  engine.updateGains();
  for (const tr of engine.tracks) {
    if (!tr.row) continue;
    tr.row.querySelector('.m').classList.toggle('on', tr.muted);
    tr.row.querySelector('.s').classList.toggle('on', tr.solo);
    tr.row.querySelector('.n').classList.toggle('on', state.showNotes.has(tr.name));
    tr.row.classList.toggle('silent', !engine.isAudible(tr));
  }
  drawOverview();
}

/** Ricalcola larghezze (contenuto, area visibile) e ridisegna. */
function layoutTimeline() {
  const tl = tlEl();
  const contentW = Math.max(1, Math.ceil(engine.duration * state.zoom));
  const viewW = Math.max(1, Math.min(tl.clientWidth - headWidth(), contentW));
  tl.style.setProperty('--content-w', `${contentW}px`);
  tl.style.setProperty('--view-w', `${viewW}px`);
  $('#tl-inner').style.width = `${headWidth() + contentW}px`;
  renderChords();
  positionSelection();
  drawOverview();
  requestRedraw();
}

let redrawPending = false;
function requestRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => {
    redrawPending = false;
    drawAll();
  });
}

function setZoom(z, anchorTime) {
  const tl = tlEl();
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const t = anchorTime ?? (tl.scrollLeft + (tl.clientWidth - headWidth()) / 2) / state.zoom;
  const screenX = t * state.zoom - tl.scrollLeft;
  state.zoom = z;
  try { localStorage.setItem('noises.zoom', String(z)); } catch {}
  $('#zoom').value = Math.round(Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN) * 1000);
  $('#zoom-val').textContent = `${z < 10 ? z.toFixed(1) : Math.round(z)} px/s`;
  layoutTimeline();
  tl.scrollLeft = Math.max(0, t * z - screenX);
}

function fitZoom() {
  if (!engine.duration) return;
  setZoom((tlEl().clientWidth - headWidth() - 2) / engine.duration, 0);
}

function setupZoom() {
  let z = 40;
  try { z = Number(localStorage.getItem('noises.zoom')) || 40; } catch {}
  try { state.follow = localStorage.getItem('noises.follow') !== '0'; } catch {}
  $('#follow').checked = state.follow;
  $('#follow').addEventListener('change', (e) => {
    state.follow = e.target.checked;
    try { localStorage.setItem('noises.follow', state.follow ? '1' : '0'); } catch {}
  });
  setZoom(z, 0);
  $('#zoom').addEventListener('input', (e) => {
    const z2 = ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, Number(e.target.value) / 1000);
    setZoom(z2, engine.playing ? engine.position() : undefined);
  });
  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.5, engine.position()));
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.5, engine.position()));
  $('#zoom-fit').addEventListener('click', fitZoom);
  const tl = tlEl();
  tl.addEventListener('scroll', () => { positionOverview(); requestRedraw(); }, { passive: true });
  // Ctrl/⌘ + rotella (o pinch sul trackpad) = zoom attorno al puntatore
  const zoomWheel = (e, anchor) => {
    if (!(e.ctrlKey || e.metaKey) || !engine.duration) return false;
    e.preventDefault();
    const step = Math.min(1.5, Math.pow(1.0018, Math.abs(e.deltaY) * (e.deltaMode === 1 ? 33 : 1)));
    setZoom(state.zoom * (e.deltaY < 0 ? step : 1 / step), anchor);
    return true;
  };
  tl.addEventListener('wheel', (e) => zoomWheel(e, timeAt(e.clientX)), { passive: false });
  setupOverview(zoomWheel);
}

// ==================================================================== panoramica
//
// Striscia con la forma d'onda dell'intero brano e un riquadro = parte visibile della timeline.
// Trascina il riquadro per scorrere, i bordi per lo zoom; clic altrove per spostare la vista.

const ovW = () => Math.max(1, $('#overview').clientWidth - headWidth());
const contentWidth = () => Math.max(1, engine.duration * state.zoom);
const viewWidth = () => Math.max(1, Math.min(tlEl().clientWidth - headWidth(), contentWidth()));

function drawOverview() {
  const c = $('#ov-canvas');
  const [ctx, w, h] = fitCanvas(c);
  if (!engine.tracks.length || !engine.duration) return;
  const mid = h / 2;
  // forma d'onda complessiva (massimo tra le tracce udibili, in grigio quelle mute)
  const cols = new Float32Array(w), colsAll = new Float32Array(w);
  for (const t of engine.tracks) {
    const bps = engine.sr / PEAK_BLOCK / engine.k(), p = t.peaks;
    const audible = engine.isAudible(t);
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * engine.duration * bps), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * engine.duration * bps));
      let m = 0;
      const stride = Math.max(1, Math.floor((b1 - b0) / 48));
      for (let i = b0; i < b1 && i < p.length; i += stride) if (p[i] > m) m = p[i];
      if (m > colsAll[x]) colsAll[x] = m;
      if (audible && m > cols[x]) cols[x] = m;
    }
  }
  ctx.fillStyle = '#3a4050';
  for (let x = 0; x < w; x++) { const y = Math.max(0.5, colsAll[x] * mid * 0.9); ctx.fillRect(x, mid - y, 1, y * 2); }
  ctx.fillStyle = '#8b7bff';
  for (let x = 0; x < w; x++) { const y = cols[x] * mid * 0.9; if (y > 0) ctx.fillRect(x, mid - y, 1, y * 2); }
  positionOverview();
}

function positionOverview() {
  if (!engine.duration) return;
  const W = ovW(), cw = contentWidth(), tl = tlEl();
  const win = $('#ov-win');
  const w = Math.max(10, (viewWidth() / cw) * W);
  win.style.width = `${w}px`;
  win.style.left = `${headWidth() + Math.min(W - w, (tl.scrollLeft / cw) * W)}px`;
  const sel = state.sel, ovSel = $('#ov-sel');
  ovSel.classList.toggle('hidden', !sel);
  if (sel) {
    ovSel.style.left = `${headWidth() + (sel.start / engine.duration) * W}px`;
    ovSel.style.width = `${Math.max(2, ((sel.end - sel.start) / engine.duration) * W)}px`;
    ovSel.classList.toggle('loop', state.loopOn);
  }
}

function setupOverview(zoomWheel) {
  const ov = $('#overview'), win = $('#ov-win');
  let drag = null;
  const xToTime = (clientX) => Math.min(engine.duration, Math.max(0,
    ((clientX - ov.getBoundingClientRect().left - headWidth()) / ovW()) * engine.duration));
  ov.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !engine.duration) return;
    e.preventDefault();
    const W = ovW(), cw = contentWidth(), tl = tlEl();
    const mode = e.target.classList.contains('l') ? 'left' : e.target.classList.contains('r') ? 'right'
      : e.target === win ? 'move' : 'jump';
    if (mode === 'jump') {
      // porta il centro della vista nel punto cliccato, poi continua come trascinamento
      const t = xToTime(e.clientX);
      tl.scrollLeft = t * state.zoom - viewWidth() / 2;
    }
    const viewT = viewWidth() / state.zoom;
    drag = {
      mode: mode === 'jump' ? 'move' : mode, x0: e.clientX, scroll0: tl.scrollLeft,
      t0: tl.scrollLeft / state.zoom, t1: tl.scrollLeft / state.zoom + viewT, W, cw,
    };
    ov.setPointerCapture(e.pointerId);
    ov.classList.add('dragging');
  });
  ov.addEventListener('pointermove', (e) => {
    if (!drag) {
      ov.style.cursor = e.target.matches('.ov-h') ? 'ew-resize' : e.target === win ? 'grab' : 'pointer';
      return;
    }
    const tl = tlEl();
    if (drag.mode === 'move') {
      const dx = e.clientX - drag.x0;
      tl.scrollLeft = drag.scroll0 + (dx / drag.W) * contentWidth();
      return;
    }
    // bordi: la nuova larghezza del riquadro determina lo zoom; il bordo opposto resta fermo
    const t = xToTime(e.clientX);
    const minSpan = (tl.clientWidth - headWidth()) / ZOOM_MAX;
    let t0 = drag.t0, t1 = drag.t1;
    if (drag.mode === 'left') t0 = Math.min(t, t1 - minSpan); else t1 = Math.max(t, t0 + minSpan);
    const z = (tl.clientWidth - headWidth()) / (t1 - t0);
    setZoom(z, t0);
    tl.scrollLeft = t0 * state.zoom;
  });
  const end = () => {
    drag = null;
    ov.classList.remove('dragging');
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
  // rotella sulla panoramica: Ctrl = zoom, altrimenti scorre in orizzontale
  ov.addEventListener('wheel', (e) => {
    if (zoomWheel(e, xToTime(e.clientX))) return;
    e.preventDefault();
    tlEl().scrollLeft += (e.deltaX || e.deltaY) * (contentWidth() / ovW()) * 0.25;
  }, { passive: false });
}

// ===================================================== selezione, loop, esportazione

/** Tempo (timeline corrente) corrispondente a una coordinata X dello schermo. */
function timeAt(clientX) {
  const tl = tlEl();
  const x = clientX - tl.getBoundingClientRect().left - headWidth() + tl.scrollLeft;
  return Math.min(Math.max(0, x / state.zoom), engine.duration);
}

/** Click = sposta la posizione; trascinamento = seleziona una porzione. */
function setupTimeline() {
  const tl = $('#timeline');
  let drag = null;
  tl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !engine.tracks.length) return;
    if (!e.target.matches('canvas.wave, #ruler')) return;
    e.preventDefault();
    drag = { x0: e.clientX, t0: timeAt(e.clientX), moved: false };
    tl.setPointerCapture(e.pointerId);
  });
  tl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 5) return;
    drag.moved = true;
    const t = timeAt(e.clientX);
    state.sel = { start: Math.min(drag.t0, t), end: Math.max(drag.t0, t) };
    updateSelectionUI();
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      engine.stopAt = null;
      engine.seek(d.t0);
      return;
    }
    const sel = state.sel;
    setSelection(sel && sel.end - sel.start >= 0.2 ? sel : null);
  };
  tl.addEventListener('pointerup', end);
  tl.addEventListener('pointercancel', end);
}

function setSelection(sel) {
  state.sel = sel;
  engine.stopAt = null;
  if (!sel) state.loopOn = false;
  engine.setLoop(state.loopOn && sel ? { ...sel } : null);
  updateSelectionUI();
}

function toggleLoop() {
  if (!state.sel) return;
  state.loopOn = !state.loopOn;
  engine.stopAt = null;
  engine.setLoop(state.loopOn ? { ...state.sel } : null);
  if (state.loopOn && !engine.playing) engine.seek(state.sel.start);
  updateSelectionUI();
}

function playSelection() {
  if (!state.sel) return;
  engine.pause();
  engine.offset = state.sel.start;
  engine.stopAt = state.loopOn ? null : state.sel.end;
  playWithCountIn();
}

const fmtPrecise = (t) => `${fmt(t)}.${Math.floor((t % 1) * 10)}`;

function updateSelectionUI() {
  const sel = state.sel;
  $('#loop').disabled = !sel;
  $('#play-sel').disabled = !sel;
  $('#sel-clear').classList.toggle('hidden', !sel);
  $('#loop').classList.toggle('on', state.loopOn);
  $('#sel-info').textContent = sel
    ? `${fmtPrecise(sel.start)} – ${fmtPrecise(sel.end)} (${(sel.end - sel.start).toFixed(1)} s)`
    : 'Trascina sulla timeline per selezionare';
  $('#selection').classList.toggle('loop', state.loopOn);
  positionSelection();
  positionOverview();
}

function positionSelection() {
  const el = $('#selection'), sel = state.sel;
  el.classList.toggle('hidden', !sel || !engine.duration);
  if (!sel || !engine.duration) return;
  el.style.left = `${headWidth() + sel.start * state.zoom}px`;
  el.style.width = `${Math.max(2, (sel.end - sel.start) * state.zoom)}px`;
}

// ============================================================ impostazioni brano

function setMaster(v) {
  $('#master').value = v;
  if (engine.master) engine.master.gain.setTargetAtTime(Number(v), engine.ctx.currentTime, 0.015);
}

const r3 = (x) => Math.round(x * 1000) / 1000;

/** Forma canonica delle impostazioni, usata sia per salvare sia per rilevare modifiche. */
function normalizeSettings(c) {
  const tracks = {};
  for (const [name, t] of Object.entries(c.tracks || {})) {
    if (t.muted || t.solo || (t.volume ?? 1) !== 1) {
      tracks[name] = { muted: !!t.muted, solo: !!t.solo, volume: r3(t.volume ?? 1) };
    }
  }
  const sel = c.selection;
  return {
    pitch: c.pitch || 0,
    tempo: c.tempo || 100,
    master: r3(c.master ?? 1),
    tracks,
    selection: sel ? { start: r3(sel.start), end: r3(sel.end) } : null,
    loop: !!(sel && c.loop),
  };
}

/** Impostazioni correnti del mixer (selezione convertita a velocità 100%). */
function currentSettings() {
  const tracks = {};
  if (engine.tracks.length) {
    for (const t of engine.tracks) tracks[t.name] = { muted: t.muted, solo: t.solo, volume: t.volume };
  } else if (state.pending && state.pending.tracks) {
    Object.assign(tracks, state.pending.tracks);
  }
  const k = engine.tempo / 100;
  let selection = state.sel ? { start: state.sel.start * k, end: state.sel.end * k } : null;
  let loop = state.loopOn;
  if (state.pending && state.pending.selection) ({ selection, loop } = state.pending);
  return normalizeSettings({
    pitch: state.pitch, tempo: state.tempo, master: Number($('#master').value), tracks, selection, loop,
  });
}

const isDirty = () => !!state.current && JSON.stringify(currentSettings()) !== state.saved;

// ------------------------------------------------ salvataggio automatico + confronto A/B
//
// Le impostazioni si salvano da sole. Il selettore "Le mie impostazioni | Originale" permette di
// ascoltare il brano originale (tonalità, velocità, mix) senza perdere le proprie impostazioni.
// Posizione, selezione e loop restano invariati, per confrontare lo stesso passaggio.

state.ab = 'custom';
state.customSnap = null;
let autosaveTimer = null, autosaveStatus = 'idle', autosaveRetryAt = 0;

/** Solo la parte "sonora" delle impostazioni: è quella che cambia nel confronto A/B. */
function soundOf(cfg) {
  const n = normalizeSettings(cfg || {});
  return JSON.stringify({ pitch: n.pitch, tempo: n.tempo, master: n.master, tracks: n.tracks });
}

function scheduleAutosave() {
  if (autosaveTimer || Date.now() < autosaveRetryAt) return;
  autosaveTimer = setTimeout(() => { autosaveTimer = null; saveSettings(); }, 800);
}

/** Salva subito, se c'è qualcosa in sospeso (cambio brano, uscita, chiusura pagina). */
function flushAutosave(keepalive = false) {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  if (state.ab !== 'custom' || state.pending || !isDirty()) return;
  if (keepalive) {
    fetch(`/api/songs/${state.current.id}/settings`, {
      method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentSettings()),
    }).catch(() => {});
  } else {
    saveSettings();
  }
}

function updateSaveUI() {
  if (!state.current) return;
  const custom = state.ab === 'custom';
  if (custom && !state.pending && engine.tracks.length && isDirty()) scheduleAutosave();
  const mine = custom ? currentSettings() : state.customSnap;
  const differs = soundOf(mine) !== soundOf({});
  document.querySelectorAll('#ab button').forEach((b) => b.classList.toggle('on', b.dataset.ab === state.ab));
  $('#ab').classList.toggle('original', !custom);
  $('#ab [data-ab=original]').disabled = custom && !differs;
  $('#ab [data-ab=original]').title = custom && !differs
    ? 'Le tue impostazioni coincidono con l\'originale'
    : 'Ascolta il brano originale senza perdere le tue impostazioni';
  const st = $('#autosave');
  if (!custom) {
    st.textContent = 'Stai ascoltando l\'originale';
    st.className = 'autosave orig';
  } else if (autosaveStatus === 'error') {
    st.textContent = '⚠ Non salvato';
    st.className = 'autosave err';
  } else {
    const pending = isDirty() || autosaveStatus === 'saving';
    st.textContent = pending ? 'Salvataggio…' : '✓ Salvato';
    st.className = `autosave ${pending ? 'busy' : ''}`;
  }
  const isDefault = JSON.stringify(currentSettings()) === JSON.stringify(normalizeSettings({}));
  $('#reset-all').disabled = custom && isDefault && !(state.current && state.current.settings);
}

function storeSongSettings(settings) {
  state.current.settings = settings;
  const s = state.songs.find((x) => x.id === state.current.id);
  if (s) s.settings = settings;
  state.saved = JSON.stringify(normalizeSettings(settings || {}));
}

async function saveSettings() {
  const song = state.current;
  if (!song || state.ab !== 'custom') return;
  const cfg = currentSettings();
  autosaveStatus = 'saving';
  try {
    await api(`/api/songs/${song.id}/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
    });
    if (state.current === song) storeSongSettings(cfg);
    autosaveStatus = 'idle';
  } catch (e) {
    autosaveStatus = 'error';
    autosaveRetryAt = Date.now() + 5000; // nuovo tentativo tra 5 s
    $('#autosave').title = e.message;
  }
  updateSaveUI();
}

/** Applica tonalità, velocità, master e mix (non tocca posizione, selezione e loop). */
function applySound(cfg) {
  const n = normalizeSettings(cfg || {});
  for (const t of engine.tracks) {
    const v = n.tracks[t.name];
    Object.assign(t, { muted: v ? v.muted : false, solo: v ? v.solo : false, volume: v ? v.volume : 1 });
    const slider = t.row && t.row.querySelector('input[type=range]');
    if (slider) slider.value = t.volume;
  }
  syncTrackButtons();
  setMaster(n.master);
  if (n.pitch !== state.pitch || n.tempo !== state.tempo) {
    state.pitch = n.pitch;
    state.tempo = n.tempo;
    applyRate();
  } else {
    updateKnobs();
  }
}

function setAB(mode) {
  if (mode === state.ab || !engine.tracks.length || state.pending) return;
  if (mode === 'original') {
    flushAutosave();
    state.customSnap = currentSettings();
    state.ab = 'original';
    applySound({});
  } else {
    state.ab = 'custom';
    applySound(state.customSnap);
    state.customSnap = null;
  }
  updateSaveUI();
}

async function resetSettings() {
  const song = state.current;
  if (!song || !confirm('Ripristinare tutte le impostazioni originali del brano?\n(tonalità, velocità, volumi, muto/solo, selezione e loop; le impostazioni salvate verranno eliminate)')) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  state.ab = 'custom';
  state.customSnap = null;
  for (const t of engine.tracks) Object.assign(t, { muted: false, solo: false, volume: 1 });
  if (engine.tracks.length) buildTracks();
  state.pending = null;
  setMaster(1);
  setSelection(null);
  const reload = state.pitch !== 0 || state.tempo !== 100;
  state.pitch = 0;
  state.tempo = 100;
  if (reload) applyRate(); else updateKnobs();
  try {
    if (song.settings) await api(`/api/songs/${song.id}/settings`, { method: 'DELETE' });
    if (state.current === song) storeSongSettings(null);
  } catch (e) {
    alert(`Reset fallito: ${e.message}`);
  }
  updateSaveUI();
}

/** Tracce effettivamente udibili, con il loro volume. */
function activeStems() {
  return engine.tracks.filter((t) => engine.isAudible(t) && t.volume > 0);
}

function defaultExportName() {
  const song = state.current;
  const active = activeStems();
  const off = engine.tracks.filter((t) => !active.includes(t));
  const lbl = (t) => LABELS[t.name] || t.name;
  let name = song.name;
  if (off.length) {
    name += off.length <= active.length
      ? ` - senza ${off.map(lbl).join(', ')}`
      : ` - solo ${active.map(lbl).join(', ')}`;
  }
  if (state.pitch) name += ` (${state.pitch > 0 ? '+' : ''}${state.pitch} st)`;
  if (state.tempo !== 100) name += ` (${state.tempo}%)`;
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

function openExport() {
  if (!engine.tracks.length) return;
  const active = activeStems();
  $('#exp-tracks').innerHTML = engine.tracks.map((t) =>
    `<span class="chip ${active.includes(t) ? '' : 'off'}" style="--c:${t.color}">${esc(LABELS[t.name] || t.name)}</span>`).join('');
  const range = $('#exp-range');
  range.querySelector('[value=sel]').disabled = !state.sel;
  range.querySelector('[value=sel]').textContent = state.sel
    ? `Selezione (${fmtPrecise(state.sel.start)} – ${fmtPrecise(state.sel.end)})` : 'Selezione (nessuna)';
  range.value = state.sel ? 'sel' : 'all';
  $('#exp-name').value = defaultExportName();
  $('#exp-go').disabled = !active.length;
  const gridOk = !!(state.notes && state.notes.grid && state.notes.grid.beats.length > 1);
  $('#exp-click').checked = gridOk && state.click;
  $('#exp-countin').value = gridOk ? String(state.countIn) : '0';
  $('#exp-click').disabled = !gridOk;
  $('#exp-countin').disabled = !gridOk;
  $('#exp-warn').classList.toggle('hidden', active.length > 0);
  $('#export-dlg').showModal();
}

async function doExport() {
  const song = state.current;
  const format = $('#exp-format').value;
  const useSel = $('#exp-range').value === 'sel' && state.sel;
  if (format === 'mid') {
    exportMidi(`${$('#exp-name').value.trim() || song.name}.mid`, useSel ? state.sel : null);
    return;
  }
  const clickOpts = exportClickOptions(useSel ? state.sel : null);
  const body = {
    ...clickOpts,
    stems: activeStems().map((t) => ({ name: t.name, gain: t.volume })),
    pitch: state.pitch,
    tempo: engine.tempo,
    master: Number($('#master').value),
    format,
    ...(useSel ? { start: state.sel.start, end: state.sel.end } : {}),
  };
  const filename = `${$('#exp-name').value.trim() || song.name}.${format}`;
  setLoader('Esportazione in corso…', filename, null);
  try {
    const r = await fetch(`/api/songs/${song.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    alert(`Esportazione fallita: ${e.message}`);
  } finally {
    setLoader(null);
  }
}

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  c.width = w;
  c.height = h;
  return [c.getContext('2d'), w, h, dpr];
}

/** Picchi pre-calcolati (max assoluto ogni 128 campioni): il ridisegno a ogni zoom/scroll è immediato. */
const PEAK_BLOCK = 128;
function computePeaks(l, r) {
  const n = Math.ceil(l.length / PEAK_BLOCK);
  const peaks = new Float32Array(n);
  for (const d of r && r !== l ? [l, r] : [l]) {
    for (let i = 0; i < n; i++) {
      let m = peaks[i];
      const end = Math.min((i + 1) * PEAK_BLOCK, d.length);
      for (let j = i * PEAK_BLOCK; j < end; j++) {
        const v = d[j] < 0 ? -d[j] : d[j];
        if (v > m) m = v;
      }
      peaks[i] = m;
    }
  }
  return peaks;
}

function drawWave(t) {
  const [ctx, w, h, dpr] = fitCanvas(t.canvas);
  const peaks = t.peaks;
  // le tracce sono alla velocità originale: timeline corrente → tempo originale
  const bps = engine.sr / PEAK_BLOCK / engine.k();
  const sl = tlEl().scrollLeft, z = state.zoom;
  const mid = h / 2;
  ctx.fillStyle = t.color;
  for (let x = 0; x < w; x++) {
    const b0 = Math.floor(((sl + x / dpr) / z) * bps);
    if (b0 >= peaks.length) break;
    const b1 = Math.max(b0 + 1, Math.floor(((sl + (x + 1) / dpr) / z) * bps));
    let peak = 0;
    const stride = Math.max(1, Math.floor((b1 - b0) / 64));
    for (let i = b0; i < b1 && i < peaks.length; i += stride) if (peaks[i] > peak) peak = peaks[i];
    const y = Math.max(dpr * 0.5, peak * mid * 0.95);
    ctx.fillRect(x, mid - y, 1, y * 2);
  }
}

function drawRuler() {
  const c = $('#ruler');
  const [ctx, w, h, dpr] = fitCanvas(c);
  if (!engine.duration) return;
  const sl = tlEl().scrollLeft, z = state.zoom;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const stepSec = steps.find((s) => s * z >= 70) || 600;
  const minor = stepSec / (stepSec >= 1 && [1, 10, 60].includes(stepSec) ? 10 : 5);
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  const t0 = sl / z, t1 = (sl + w / dpr) / z;
  ctx.fillStyle = '#3a4050';
  for (let s = Math.floor(t0 / minor) * minor; s <= t1; s += minor) {
    ctx.fillRect(Math.round((s * z - sl) * dpr), h * 0.78, dpr, h * 0.22);
  }
  // battute (se il ritmo è stato analizzato): tacca viola e numero
  if (typeof hasGrid === 'function' && hasGrid()) {
    const g = state.notes.grid, k = 100 / engine.tempo, bpb = g.beats_per_bar || 4;
    const barPx = (g.beats[Math.min(bpb, g.beats.length - 1)] - g.beats[0]) * k * z;
    const every = barPx >= 28 ? 1 : barPx >= 7 ? 4 : barPx >= 2 ? 16 : 0;
    if (every) {
      ctx.fillStyle = '#a48bff';
      ctx.font = `${10 * dpr}px system-ui, sans-serif`;
      const first = Math.floor((beatPos(t0 / k) - g.downbeat) / bpb) - 1;
      for (let bar = Math.max(-1, first); ; bar++) {
        const t = beatTime(g.downbeat + bar * bpb) * k;
        if (t > t1) break;
        if (t < 0 || bar % every) continue;
        const x = Math.round((t * z - sl) * dpr);
        ctx.fillRect(x, 0, dpr, h * 0.3);
        ctx.fillText(String(bar - Math.floor((beatPos(0) - g.downbeat) / bpb) + 1), x + 3 * dpr, h * 0.16);
      }
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    }
  }
  ctx.fillStyle = '#8b93a5';
  for (let s = Math.floor(t0 / stepSec) * stepSec; s <= t1; s += stepSec) {
    const x = Math.round((s * z - sl) * dpr);
    ctx.fillRect(x, h * 0.55, dpr, h * 0.45);
    const label = stepSec < 1 ? `${fmt(s)}.${Math.round((s % 1) * 100).toString().padStart(2, '0')}` : fmt(s);
    ctx.fillText(label, x + 4 * dpr, h * 0.5);
  }
}

function drawAll() {
  if (!state.current || !engine.tracks.length) return;
  drawRuler();
  engine.tracks.forEach(drawWave);
  drawAllRolls();
}

function tick() {
  if (state.current && engine.tracks.length) {
    let pos = engine.position();
    if (engine.playing && engine.stopAt != null && pos >= engine.stopAt) {
      engine.pause();
      engine.offset = state.sel ? state.sel.start : 0;
      engine.stopAt = null;
      pos = engine.offset;
    } else if (engine.playing && pos >= engine.duration) {
      engine.stop();
      pos = engine.offset;
    }
    $('#pos').textContent = fmt(pos);
    $('#dur').textContent = fmt(engine.duration);
    $('#play').textContent = engine.playing ? '❚❚' : '▶';
    $('#playhead').style.left = `${headWidth() + pos * state.zoom}px`;
    // segue la testina: quando esce dall'area visibile, "gira pagina"
    if (engine.playing && state.follow) {
      const tl = tlEl();
      const viewW = tl.clientWidth - headWidth();
      const x = pos * state.zoom;
      if (x < tl.scrollLeft || x > tl.scrollLeft + viewW * 0.92) tl.scrollLeft = Math.max(0, x - viewW * 0.08);
    }
    $('#ov-head').style.left = `${headWidth() + (engine.duration ? pos / engine.duration : 0) * ovW()}px`;
    updateChordNow(pos);
    updateScoreCursor(pos);
  }
  requestAnimationFrame(tick);
}

// ======================================================================= accordi

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const SOLFEGE = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
const QUALITY = {
  maj: ['', 'maggiore'], min: ['m', 'minore'], 7: ['7', 'settima di dominante'],
  maj7: ['maj7', 'settima maggiore'], min7: ['m7', 'minore settima'], maj6: ['6', 'sesta'],
  min6: ['m6', 'minore sesta'], sus2: ['sus2', 'sospeso 2'], sus4: ['sus4', 'sospeso 4'],
  dim: ['dim', 'diminuito'], dim7: ['dim7', 'diminuito settima'], hdim7: ['m7♭5', 'semidiminuito'],
  aug: ['aug', 'aumentato'], minmaj7: ['m(maj7)', 'minore settima maggiore'],
};
const MINOR_FAMILY = new Set(['min', 'min7', 'min6', 'minmaj7', 'hdim7', 'dim', 'dim7']);
const FLAT_MAJOR_KEYS = new Set([5, 10, 3, 8, 1, 6]); // Fa, Si♭, Mi♭, La♭, Re♭, Sol♭
const mod12 = (n) => ((n % 12) + 12) % 12;

let chordSeq = 0, chordIdx = -1, chordSave = null;

/** Tonalità stimata dagli accordi (pesati per durata): serve per scegliere diesis o bemolli. */
function estimateKey(chords) {
  const dur = (c) => c.end - c.start;
  let best = { score: -1, root: 0 };
  for (let k = 0; k < 12; k++) {
    const scale = new Set([0, 2, 4, 5, 7, 9, 11].map((d) => (d + k) % 12));
    let score = 0;
    for (const c of chords) {
      if (c.root == null) continue;
      if (scale.has(c.root)) score += dur(c);
      if (c.root === k && !MINOR_FAMILY.has(c.quality)) score += dur(c) * 0.5;
      if (c.root === (k + 9) % 12 && MINOR_FAMILY.has(c.quality)) score += dur(c) * 0.5;
    }
    if (score > best.score) best = { score, root: k };
  }
  let maj = 0, min = 0;
  for (const c of chords) {
    if (c.root === best.root && !MINOR_FAMILY.has(c.quality)) maj += c.end - c.start;
    if (c.root === (best.root + 9) % 12 && MINOR_FAMILY.has(c.quality)) min += c.end - c.start;
  }
  return { root: best.root, minor: min > maj }; // root = tonalità maggiore relativa
}

function rootName(pc) {
  const key = state.chordKey;
  const flats = key ? FLAT_MAJOR_KEYS.has(mod12(key.root + engine.pitch)) : false;
  const n = (flats ? FLAT : SHARP)[mod12(pc)];
  return state.notation === 'it' ? SOLFEGE[n[0]] + n.slice(1) : n;
}

/** Nome dell'accordo trasposto della tonalità corrente. */
function chordName(c) {
  if (c.root == null) return 'N.C.';
  return rootName(c.root + engine.pitch) + (QUALITY[c.quality] || [''])[0];
}

async function loadChords(song) {
  const seq = ++chordSeq;
  state.chords = null;
  chordIdx = -1;
  renderChords('Analisi accordi…');
  try {
    const sheet = await api(`/api/songs/${song.id}/chords`);
    if (seq !== chordSeq || !state.current || state.current.id !== song.id) return;
    setChords(sheet);
  } catch (e) {
    if (seq !== chordSeq) return;
    if (e.status === 409) {
      const fresh = state.songs.find((x) => x.id === song.id);
      if (fresh && fresh.phase === 'Analisi accordi') runChordAnalysis(song);
      else showChordsMissing(song);
    } else {
      renderChords(`Accordi non disponibili: ${e.message}`);
    }
  }
}

function showChordsMissing(song) {
  renderChords('Accordi non ancora analizzati');
  const ph = $('#chord-lane .placeholder');
  const b = document.createElement('button');
  b.className = 'lane-action';
  b.textContent = '🎵 Riconosci accordi';
  b.addEventListener('click', () => runChordAnalysis(song));
  ph.appendChild(b);
}

async function runChordAnalysis(song) {
  const seq = ++chordSeq;
  renderChords('Analisi accordi in corso…');
  try {
    const sheet = await api(`/api/songs/${song.id}/chords/analyze`, { method: 'POST' });
    if (seq === chordSeq && state.current && state.current.id === song.id) setChords(sheet);
  } catch (e) {
    if (seq === chordSeq) renderChords(`Analisi accordi fallita: ${e.message}`);
  }
}

function setChords(sheet) {
  state.chords = sheet;
  state.chordKey = estimateKey(sheet.chords);
  chordIdx = -1;
  renderChords();
}

function renderChords(message) {
  const lane = $('#chord-lane');
  const sheet = state.chords;
  $('#chord-restore').classList.toggle('hidden', !(sheet && sheet.edited));
  const key = state.chordKey;
  $('#chord-key').textContent = sheet && key
    ? (key.minor ? `${rootName(key.root + 9 + engine.pitch)}m` : rootName(key.root + engine.pitch)) : '';
  $('#chord-now').classList.toggle('hidden', !sheet);
  if (!sheet || !engine.duration) {
    lane.innerHTML = `<div class="placeholder">${esc(message || (sheet ? '' : 'Caricamento accordi…'))}</div>`;
    return;
  }
  const scale = 100 / engine.tempo * state.zoom; // secondi originali → pixel
  lane.innerHTML = sheet.chords.map((c, i) => `
    <div class="chord-block ${c.root == null ? 'nc' : ''} ${i === chordIdx ? 'current' : ''}" data-i="${i}"
      style="left:${c.start * scale}px;width:${(c.end - c.start) * scale}px"
      title="${esc(chordName(c))}${c.quality ? ` — ${QUALITY[c.quality][1]}` : ''}">
      ${i > 0 ? '<span class="chord-handle" title="Trascina per spostare il cambio di accordo"></span>' : ''}${esc(chordName(c))}
    </div>`).join('');
  lastChordShown = null;
}

let lastChordShown = null;
function updateChordNow(pos) {
  const sheet = state.chords;
  if (!sheet || !sheet.chords.length) return;
  const t = pos * engine.tempo / 100; // posizione in secondi originali
  const list = sheet.chords;
  let i = chordIdx >= 0 && chordIdx < list.length && list[chordIdx].start <= t ? chordIdx : 0;
  while (i + 1 < list.length && list[i + 1].start <= t) i++;
  if (i !== chordIdx) {
    const lane = $('#chord-lane');
    const prev = lane.querySelector('.chord-block.current');
    if (prev) prev.classList.remove('current');
    const el = lane.querySelector(`.chord-block[data-i="${i}"]`);
    if (el) el.classList.add('current');
    chordIdx = i;
  }
  const cur = list[i] && list[i].start <= t ? list[i] : null;
  const next = list.slice(i + 1).find((c) => c.root != null);
  const shown = `${cur ? chordName(cur) : '–'}|${next ? chordName(next) : ''}`;
  if (shown !== lastChordShown) {
    lastChordShown = shown;
    $('#cn-cur').textContent = cur ? chordName(cur) : '–';
    $('#cn-next').textContent = next ? chordName(next) : '–';
  }
}

function saveChords() {
  clearTimeout(chordSave);
  const song = state.current, sheet = state.chords;
  sheet.edited = true;
  $('#chord-restore').classList.remove('hidden');
  chordSave = setTimeout(async () => {
    try {
      await api(`/api/songs/${song.id}/chords`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chords: sheet.chords }),
      });
    } catch (e) {
      alert(`Salvataggio accordi fallito: ${e.message}`);
    }
  }, 400);
}

function closeChordMenu() {
  $('#chord-menu').classList.add('hidden');
  document.querySelectorAll('.chord-block.editing').forEach((b) => b.classList.remove('editing'));
}

/** Editor di un accordo: fondamentale, qualità, dividi, unisci, ascolta. */
function openChordMenu(i, clickT, anchor) {
  const menu = $('#chord-menu');
  const list = state.chords.chords;
  const toDisp = (t) => t * 100 / engine.tempo;
  const build = () => {
    const c = list[i];
    if (!c) return closeChordMenu();
    const curPc = c.root == null ? null : mod12(c.root + engine.pitch);
    menu.innerHTML = `
      <div class="menu-title">Accordo ${fmtPrecise(toDisp(c.start))} – ${fmtPrecise(toDisp(c.end))}: <b>${esc(chordName(c))}</b></div>
      <div class="ce-grid">
        ${Array.from({ length: 12 }, (_, pc) => `<button data-root="${pc}" class="${pc === curPc ? 'on' : ''}">${rootName(pc)}</button>`).join('')}
      </div>
      <div class="ce-grid q">
        ${Object.entries(QUALITY).map(([q, [sfx, desc]]) =>
          `<button data-q="${q}" title="${desc}" class="${c.quality === q ? 'on' : ''}" ${c.root == null ? 'disabled' : ''}>${sfx || 'magg.'}</button>`).join('')}
      </div>
      <div class="ce-actions">
        <button data-act="nc" class="${c.root == null ? 'on' : ''}" title="Nessun accordo">N.C.</button>
        <button data-act="split" title="Divide l'accordo nel punto cliccato">✂ Dividi qui</button>
        <button data-act="merge" ${i === 0 ? 'disabled' : ''} title="Unisce al precedente">⇤ Unisci</button>
        <button data-act="play" title="Ascolta questo accordo">▶ Ascolta</button>
      </div>`;
    menu.querySelectorAll('[data-root]').forEach((b) => b.addEventListener('click', () => {
      c.root = mod12(Number(b.dataset.root) - engine.pitch);
      if (!c.quality) c.quality = 'maj';
      changed();
    }));
    menu.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => { c.quality = b.dataset.q; changed(); }));
    menu.querySelector('[data-act=nc]').addEventListener('click', () => { c.root = null; c.quality = null; changed(); });
    menu.querySelector('[data-act=split]').addEventListener('click', () => {
      if (clickT - c.start < 0.1 || c.end - clickT < 0.1) return;
      list.splice(i + 1, 0, { ...c, start: clickT });
      c.end = clickT;
      changed(true);
    });
    menu.querySelector('[data-act=merge]').addEventListener('click', () => {
      list[i - 1].end = c.end;
      list.splice(i, 1);
      i -= 1;
      changed(true);
    });
    menu.querySelector('[data-act=play]').addEventListener('click', () => {
      engine.seek(toDisp(c.start));
      engine.play();
      engine.stopAt = toDisp(c.end);
    });
  };
  const changed = (structural) => {
    saveChords();
    if (structural) state.chordKey = estimateKey(list);
    renderChords();
    build();
    highlight();
  };
  const highlight = () => {
    document.querySelectorAll('.chord-block.editing').forEach((b) => b.classList.remove('editing'));
    const el = $(`#chord-lane .chord-block[data-i="${i}"]`);
    if (el) el.classList.add('editing');
  };
  build();
  highlight();
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  const below = r.bottom + 4;
  menu.style.top = `${below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 4) : below}px`;
}

function setupChords() {
  try { state.notation = localStorage.getItem('noises.notation') || 'en'; } catch { state.notation = 'en'; }
  $('#chord-notation').value = state.notation;
  $('#chord-notation').addEventListener('change', (e) => {
    state.notation = e.target.value;
    try { localStorage.setItem('noises.notation', state.notation); } catch {}
    renderChords();
    lastChordShown = null;
  });
  $('#chord-restore').addEventListener('click', async () => {
    const song = state.current;
    if (!confirm('Eliminare le correzioni e tornare agli accordi rilevati automaticamente?')) return;
    clearTimeout(chordSave);
    closeChordMenu();
    try {
      const sheet = await api(`/api/songs/${song.id}/chords/edits`, { method: 'DELETE' });
      if (state.current === song) setChords(sheet);
    } catch (e) {
      alert(e.message);
    }
  });

  const lane = $('#chord-lane');
  let drag = null;
  lane.addEventListener('pointerdown', (e) => {
    if (!state.chords || e.button !== 0) return;
    const block = e.target.closest('.chord-block');
    if (!block) return;
    const i = Number(block.dataset.i);
    if (e.target.classList.contains('chord-handle')) {
      // trascina il confine tra l'accordo i-1 e l'accordo i
      e.preventDefault();
      e.stopPropagation();
      closeChordMenu();
      drag = { i, moved: false };
      lane.setPointerCapture(e.pointerId);
      return;
    }
    const t = timeAt(e.clientX) * engine.tempo / 100;
    openChordMenu(i, t, block);
  });
  lane.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const list = state.chords.chords;
    const prev = list[drag.i - 1], cur = list[drag.i];
    const t = timeAt(e.clientX) * engine.tempo / 100;
    const b = Math.min(Math.max(t, prev.start + 0.1), cur.end - 0.1);
    prev.end = cur.start = b;
    drag.moved = true;
    const scale = 100 / engine.tempo * state.zoom;
    const pEl = lane.querySelector(`[data-i="${drag.i - 1}"]`), cEl = lane.querySelector(`[data-i="${drag.i}"]`);
    pEl.style.width = `${(prev.end - prev.start) * scale}px`;
    cEl.style.left = `${cur.start * scale}px`;
    cEl.style.width = `${(cur.end - cur.start) * scale}px`;
  });
  const end = () => {
    if (!drag) return;
    if (drag.moved) { saveChords(); chordIdx = -1; }
    drag = null;
  };
  lane.addEventListener('pointerup', end);
  lane.addEventListener('pointercancel', end);

  document.addEventListener('pointerdown', (e) => {
    const menu = $('#chord-menu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !e.target.closest('.chord-block')) closeChordMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.code === 'Escape') closeChordMenu(); });
}

/** Avviata dopo l'accesso (vedi auth.js). */
function startApp() {
  setupUpload();
  setupProcess();
  setupChords();
  setupImport();
  setupPlaylists();
  refreshPlaylists();
  setupControls();
  setupTimeline();
  setupZoom();
  setupNotes();
  setupScore();
  updateSelectionUI();
  setInterval(() => state.current && updateSaveUI(), 250);
  window.addEventListener('pagehide', () => state.current && flushAutosave(true));
  refreshSongs();
  requestAnimationFrame(tick);
}

boot();
