'use strict';

const $ = (s) => document.querySelector(s);
const COLORS = { vocals: '#ff6b9a', drums: '#ffb547', bass: '#4fd1c5', guitar: '#7cc4ff', piano: '#c49bff', other: '#9be36b' };
const LABELS = { vocals: T('Voce'), drums: T('Batteria'), bass: T('Basso'), guitar: T('Chitarra'), piano: T('Piano'), other: T('Altro') };
const MODEL_LABELS = { htdemucs: T('4 tracce'), htdemucs_ft: T('4 tracce HQ'), htdemucs_6s: T('6 tracce'), roformer: T('4 tracce RoFormer'), roformer_ft: T('4 tracce RoFormer HQ'), roformer_6s: T('6 tracce RoFormer') };

const state = { zoom: 40, follow: true, notes: null, showNotes: new Set(), synth: new Set(), selNote: null,
  songs: [], playlists: [], view: 'all', query: '', current: null, pitch: 0, tempo: 100, loadSeq: 0, debounce: null, sel: null, loopOn: false,
  loopIn: null }; // loopIn: inizio del loop fissato con I, in attesa della fine (O)

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
    const err = new Error(tr(msg));
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
    if (!window.isSecureContext || typeof AudioWorkletNode === 'undefined') {
      // il motore audio (AudioWorklet) esiste solo in pagine sicure: HTTPS o localhost
      showInsecureNotice();
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.sr = this.ctx.sampleRate;
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    if (!this.ctx.audioWorklet) {
      // senza motore l'interfaccia resta utilizzabile (tracce, accordi, note): l'audio no
      this.ready = Promise.resolve();
      return;
    }
    this.ready = Promise.all([
      this.ctx.audioWorklet.addModule('stretch-worklet.js'),
      this.ctx.audioWorklet.addModule('fx-worklet.js'),
    ]).then(() => {
      // uscita 0: tracce senza effetti; 1…FX_SLOTS: una per ogni traccia con effetti
      this.node = new AudioWorkletNode(this.ctx, 'stretch-player', {
        numberOfInputs: 0, numberOfOutputs: FX_SLOTS + 1, outputChannelCount: Array(FX_SLOTS + 1).fill(2),
      });
      this.node.connect(this.master, 0, 0);
      this.node.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'pos') {
          if (this.playing && m.frame >= this.repMinFrame) this.rep = m;
        } else if (m.type === 'ended' && this.playing) {
          this.stop();
          if (typeof onPlaybackEnded === 'function') onPlaybackEnded();
        }
      };
    });
  },

  post(msg, transfer) {
    if (!this.node) return; // pagina non sicura: motore audio non disponibile
    this.node.port.postMessage(msg, transfer || []);
  },

  /** secondi della timeline corrente ↔ campioni del brano originale */
  k() { return 100 / this.tempo; },
  toSrc(t) { return (t / this.k()) * this.sr; },

  /** list: [{ name, song, part, label, clips, fx, l, r, peaks }] — ogni traccia è un insieme di clip. */
  setTracks(list, keepMix, initialMix) {
    const prev = keepMix ? Object.fromEntries(this.tracks.map((t) => [t.name, t])) : (initialMix || {});
    this.releaseAllFx();
    this.songDuration = 0;
    this.tracks = list.map((t) => this.trackObject(t, prev[t.name]));
    this.origDuration = 0;
    this.post({
      type: 'load', length: 0,
      stems: list.map((t, i) => ({ name: t.name, l: t.l, r: t.r, gain: this.gainOf(this.tracks[i]), clips: this.clipSamples(t.clips) })),
    }, list.flatMap((t) => (t.r && t.r !== t.l ? [t.l.buffer, t.r.buffer] : [t.l.buffer])));
    this.updateLength(true);
    for (const t of this.tracks) if (t.fx) this.applyFx(t);
  },

  trackObject(t, p) {
    return {
      name: t.name, song: t.song, part: t.part, label: t.label || '', peaks: t.peaks, rec: !!t.rec,
      clips: t.clips.map((c) => ({ ...c })), srcDuration: t.l.length / this.sr, fx: normFx(t.fx),
      muted: !!(p && p.muted), solo: !!(p && p.solo), volume: p && p.volume != null ? p.volume : 1,
    };
  },

  clipSamples(clips) {
    return clips.map((c) => ({ s: Math.round(c.start * this.sr), o: Math.round(c.offset * this.sr), d: Math.round(c.duration * this.sr) }));
  },

  /** Durata della timeline: fine dell'ultima clip (almeno 20 s). true se è cambiata. */
  updateLength(force) {
    let end = 20;
    for (const t of this.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
    if (!force && Math.abs(end - this.origDuration) < 1e-6) return false;
    this.origDuration = end;
    this.duration = end * this.k();
    if (this.node) this.post({ type: 'length', length: Math.round(end * this.sr) });
    return true;
  },

  addTrack(t) {
    const o = this.trackObject(t, null);
    this.tracks.push(o);
    this.post({ type: 'add', name: o.name, l: t.l, r: t.r, clips: this.clipSamples(o.clips), gain: this.gainOf(o) },
      t.r && t.r !== t.l ? [t.l.buffer, t.r.buffer] : [t.l.buffer]);
    this.updateLength();
    if (o.fx) this.applyFx(o);
    return o;
  },

  /** Comunica al motore le clip modificate; true se la durata complessiva è cambiata. */
  setClips(t) {
    this.post({ type: 'clips', name: t.name, clips: this.clipSamples(t.clips) });
    return this.updateLength();
  },

  removeTrack(t) {
    const i = this.tracks.indexOf(t);
    if (i < 0) return;
    this.post({ type: 'remove', name: t.name });
    this.releaseFx(t.name);
    this.tracks.splice(i, 1);
    this.updateLength();
  },

  clear() {
    this.stop();
    if (this.node) this.post({ type: 'load', length: 0, stems: [] });
    this.releaseAllFx();
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
    previewStop();
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
    const f = (x) => (typeof folderOf === 'function' ? folderOf(x.name) : null);
    const solo = (x) => x.solo || !!(f(x) && f(x).solo);
    const anySolo = this.tracks.some(solo);
    return anySolo ? solo(t) : !(t.muted || (f(t) && f(t).muted));
  },

  volumeOf(t) {
    const f = typeof folderOf === 'function' ? folderOf(t.name) : null;
    return t.volume * (f ? f.volume : 1);
  },

  gainOf(t) {
    return this.isAudible(t) ? this.volumeOf(t) : 0;
  },

  updateGains() {
    if (!this.node) return;
    // le tracce con effetti entrano nella catena a livello pieno: il volume si applica dopo gli
    // effetti (come un fader dopo gli insert), così non cambia quanto lavora il compressore
    const gains = {};
    for (const t of this.tracks) {
      const slot = this.fxSlots.get(t.name);
      if (!slot) { gains[t.name] = this.gainOf(t); continue; }
      gains[t.name] = this.isAudible(t) ? 1 : 0;
      slot.post.gain.setTargetAtTime(this.volumeOf(t), this.ctx.currentTime, 0.01);
    }
    this.post({ type: 'gains', gains });
  },

  // ------------------------------------------------------------------ effetti

  fxSlots: new Map(),   // nome traccia → { k, node, post, send }
  reverb: null,

  /** Riverbero condiviso: le tracce ci mandano una parte del loro segnale (mandata). */
  ensureReverb() {
    if (this.reverb) return this.reverb;
    const conv = this.ctx.createConvolver();
    conv.normalize = false; // come sul server (ffmpeg afir senza guadagno automatico)
    conv.connect(this.master);
    this.reverb = conv;
    fetch('reverb.wav').then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b))
      .then((buf) => { conv.buffer = buf; })
      .catch((e) => console.warn('riverbero non disponibile', e));
    return conv;
  },

  /** Collega (o scollega) la catena di effetti della traccia e le passa i parametri. */
  applyFx(t) {
    if (!this.node) return true;
    let slot = this.fxSlots.get(t.name);
    if (!t.fx) {
      if (slot) { this.releaseFx(t.name); this.updateGains(); }
      return true;
    }
    if (!slot) {
      const used = new Set([...this.fxSlots.values()].map((x) => x.k));
      let k = 1;
      while (used.has(k)) k++;
      if (k > FX_SLOTS) return false;
      const node = new AudioWorkletNode(this.ctx, 'noises-fx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      const post = this.ctx.createGain();
      const send = this.ctx.createGain();
      send.gain.value = 0;
      this.node.connect(node, k, 0);
      node.connect(post);
      post.connect(this.master);
      post.connect(send);
      send.connect(this.ensureReverb());
      slot = { k, node, post, send };
      this.fxSlots.set(t.name, slot);
      this.post({ type: 'bus', name: t.name, bus: k });
    }
    slot.node.port.postMessage({ type: 'params', fx: t.fx });
    slot.send.gain.setTargetAtTime(t.fx.on === false ? 0 : t.fx.rev, this.ctx.currentTime, 0.02);
    this.updateGains();
    return true;
  },

  releaseFx(name) {
    const slot = this.fxSlots.get(name);
    if (!slot) return;
    this.fxSlots.delete(name);
    this.post({ type: 'bus', name, bus: 0 });
    // si scollega dopo un attimo, quando il motore ha già spostato la traccia
    setTimeout(() => { slot.node.disconnect(); slot.post.disconnect(); slot.send.disconnect(); try { this.node.disconnect(slot.node); } catch {} }, 200);
  },

  releaseAllFx() {
    for (const name of [...this.fxSlots.keys()]) this.releaseFx(name);
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
    onSongsUpdated();
  } catch (e) {
    console.error(e);
  }
  const pending = state.songs.some((s) => ['downloading', 'queued', 'processing'].includes(s.status) || s.phase);
  const downloading = state.songs.some((s) => s.status === 'downloading');
  pollTimer = setTimeout(refreshSongs, downloading ? 600 : pending ? 1500 : 10000);
}

function statusText(s) {
  switch (s.status) {
    case 'downloading': return `Download ${Math.round(s.progress * 100)}%`;
    case 'new': return 'Non separato';
    case 'queued': return 'In coda…';
    case 'processing': return `Separazione ${Math.round(s.progress * 100)}%${s.phase ? ` · ${T(s.phase)}` : ''}`;
    case 'ready': return `Separato${s.phase ? ` · ${s.phase}…` : ''}`;
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
  $('#process-all').textContent = `⑂ Separa tutti (${waiting.length})`;
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
    const used = state.current && engine.tracks.some((t) => t.song === s.id);
    li.className = `song-item${used ? ' used' : ''}`;
    li.title = 'Trascina nella timeline di un progetto (doppio clic: aggiungi alla testina)';
    li.draggable = true;
    const inPl = state.playlists.filter((p) => p.songs.includes(s.id)).length;
    li.innerHTML = `
      <div class="song-row">
        ${s.status === 'downloading' ? '' : `<button class="preview" data-preview="${s.id}">${PREVIEW_ICON.play}</button>`}
        <span class="song-name" title="${esc(s.name)}">${esc(s.name)}</span>
        <button class="more" title="Altre azioni…" aria-label="Altre azioni…" aria-haspopup="menu">⋯</button>
      </div>
      <span class="song-status ${s.status === 'error' ? 'error' : s.status === 'new' ? 'new' : ''}">${esc(statusText(s))}${s.status === 'new' ? '' : ` · ${MODEL_LABELS[s.model] || s.model}`}${inPl ? ` · ♫ ${inPl}` : ''}</span>
      ${['downloading', 'queued', 'processing'].includes(s.status) ? `<div class="bar"><div style="width:${s.progress * 100}%"></div></div>` : ''}`;
    li.addEventListener('dblclick', () => addSongToProject(s.id, null));
    const pv = li.querySelector('.preview');
    if (pv) {
      pv.addEventListener('click', (ev) => { ev.stopPropagation(); previewToggle(s); });
      pv.addEventListener('dblclick', (ev) => ev.stopPropagation());
      pv.draggable = false;
    }
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-noises-song', s.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    li.querySelector('.more').addEventListener('click', (ev) => {
      ev.stopPropagation();
      openSongMenu(s, ev.currentTarget);
    });
    ul.appendChild(li);
  }
  previewSync();
}

// ============================================================ ascolto dalla libreria

const PREVIEW_ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor"/></svg>',
};

/** Un solo lettore per l'ascolto veloce dei brani della libreria (audio originale). */
const preview = { audio: null, id: null };

function previewToggle(s) {
  if (preview.id === s.id && preview.audio) {
    if (preview.audio.paused) preview.audio.play().catch(() => {});
    else preview.audio.pause();
    previewSync();
    return;
  }
  previewStop();
  if (engine.playing) engine.pause();
  const a = new Audio(`/api/songs/${s.id}/original`);
  a.preload = 'auto';
  preview.audio = a;
  preview.id = s.id;
  a.addEventListener('ended', previewStop);
  a.addEventListener('pause', previewSync);
  a.addEventListener('playing', previewSync);
  a.addEventListener('timeupdate', previewSync);
  a.addEventListener('error', () => {
    if (preview.audio !== a) return;
    previewStop();
    uiAlert(T('Impossibile ascoltare il brano: il file audio non è ancora pronto o non è valido.'));
  });
  a.play().catch(() => {});
  previewSync();
}

function previewStop() {
  const a = preview.audio;
  preview.audio = null;
  preview.id = null;
  if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
  previewSync();
}

/** Aggiorna icona, stato e barra di avanzamento dei pulsanti di ascolto nella lista. */
function previewSync() {
  const a = preview.audio;
  document.querySelectorAll('#songs .preview').forEach((b) => {
    const on = !!a && b.dataset.preview === preview.id;
    const playing = on && !a.paused;
    b.innerHTML = playing ? PREVIEW_ICON.pause : PREVIEW_ICON.play;
    const label = T(playing ? 'Pausa' : 'Ascolta il brano');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.classList.toggle('on', on);
    const li = b.closest('li');
    li.classList.toggle('previewing', on);
    const frac = on && a.duration ? a.currentTime / a.duration : 0;
    li.style.setProperty('--pv', `${(frac * 100).toFixed(2)}%`);
  });
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
  name = (name ?? await uiPrompt('Nome della nuova playlist', '', { ok: 'Crea' }) ?? '').trim();
  if (!name) return null;
  try {
    const pl = await api('/api/playlists', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    await refreshPlaylists();
    return pl;
  } catch (e) {
    uiAlert(e.message);
    return null;
  }
}

async function renamePlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  const name = (await uiPrompt('Rinomina playlist', pl.name, { ok: 'Rinomina' }) || '').trim();
  if (!name || name === pl.name) return;
  await api(`/api/playlists/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }).catch((e) => uiAlert(e.message));
  refreshPlaylists();
}

async function deletePlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!(await uiConfirm(`Eliminare la playlist "${pl.name}"?\nI brani restano nella libreria.`, { title: 'Elimina playlist', ok: 'Elimina', danger: true }))) return;
  await api(`/api/playlists/${id}`, { method: 'DELETE' }).catch((e) => uiAlert(e.message));
  refreshPlaylists();
}

async function setMembership(plId, songId, on) {
  try {
    await api(`/api/playlists/${plId}/songs/${songId}`, { method: on ? 'PUT' : 'DELETE' });
  } catch (e) {
    uiAlert(e.message);
  }
  await refreshPlaylists();
}

/** Aggiunge un brano appena caricato/importato alla playlist aperta. */
function addToCurrentPlaylist(song) {
  const pl = currentPlaylist();
  return pl && song ? setMembership(pl.id, song.id, true) : null;
}

/** Elimina un brano dalla libreria (dopo conferma): esce anche dalle playlist e dai progetti. */
async function deleteSong(s) {
  const inPl = state.playlists.filter((p) => p.songs.includes(s.id)).length;
  if (!(await uiConfirm(`Eliminare definitivamente "${s.name}" dalla libreria?${inPl ? '\nVerrà rimosso anche dalle playlist.' : ''}\nLe sue tracce verranno tolte dai progetti che lo usano.`, { title: 'Elimina brano', ok: 'Elimina', danger: true }))) return;
  if (preview.id === s.id) previewStop();
  const usedHere = state.current && engine.tracks.some((t) => t.song === s.id);
  await api(`/api/songs/${s.id}`, { method: 'DELETE' }).catch((e) => uiAlert(e.message));
  await refreshPlaylists();
  await refreshSongs();
  refreshProjects();
  if (usedHere) { const id = state.current.id; state.current = null; openProject(id); }
}

/** Crea un progetto (nome proposto: quello del brano), lo apre e ci mette il brano dall'inizio. */
async function newProjectWithSong(s) {
  const name = await uiPrompt('Nome del nuovo progetto', s.name, { ok: 'Crea', max: 200 });
  if (!name) return;
  try {
    const p = await createProject(name);
    if (!p) return;
    await openProject(p.id);
    await addSongToProject(s.id, 0);
  } catch (e) {
    uiAlert(e.message);
  }
}

async function renameSong(s) {
  const name = await uiPrompt('Rinomina brano', s.name, { ok: 'Rinomina', max: 200 });
  if (name == null || !name.trim() || name.trim() === s.name) return;
  try {
    await api(`/api/songs/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
  } catch (e) {
    uiAlert(e.message);
  }
  await refreshSongs();
}

/** Menu ⋯ di un brano della libreria: separazione, playlist (sottomenu), rinomina, elimina. */
function openSongMenu(song, anchor) {
  const menu = $('#pl-menu');
  const close = () => menu.classList.add('hidden');
  const main = () => {
    const items = [];
    if (song.status !== 'downloading') items.push({ icon: '＋', label: T('Nuovo progetto con questo brano…'), act: () => { close(); newProjectWithSong(song); } });
    if (song.status === 'new') items.push({ icon: '⑂', label: T('Separa le tracce…'), act: () => { close(); openProcess([song]); } });
    if (song.status === 'error') items.push({ icon: '↻', label: T('Riprova la separazione…'), act: () => { close(); openProcess([song]); } });
    const n = state.playlists.filter((p) => p.songs.includes(song.id)).length;
    items.push({ icon: '♫', label: T('Aggiungi a playlist'), extra: `${n ? `<span class="mi-count">${n}</span>` : ''}<span class="mi-sub">›</span>`, act: playlists });
    if (song.status !== 'downloading') items.push({ icon: '✎', label: T('Rinomina…'), act: () => { close(); renameSong(song); } });
    items.push({ sep: true });
    items.push({ icon: '✕', label: T('Elimina…'), danger: true, act: () => { close(); deleteSong(song); } });
    menu.innerHTML = items.map((it, i) => it.sep ? '<div class="menu-sep"></div>'
      : `<button class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}"><span class="mi">${it.icon}</span><span class="mi-label">${esc(it.label)}</span>${it.extra || ''}</button>`).join('');
    menu.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => items[b.dataset.i].act()));
  };
  const playlists = () => {
    menu.innerHTML = `<button class="menu-item menu-back"><span class="mi">‹</span><span>${esc(T('Aggiungi a playlist'))}</span></button>
      ${state.playlists.map((p) => `
        <label class="menu-item"><input type="checkbox" data-pl="${p.id}" ${p.songs.includes(song.id) ? 'checked' : ''}>
        <span>${esc(p.name)}</span></label>`).join('') || '<div class="menu-empty">Nessuna playlist</div>'}
      <button class="menu-item new">＋ Nuova playlist…</button>`;
    menu.querySelector('.menu-back').addEventListener('click', main);
    menu.querySelectorAll('[data-pl]').forEach((cb) =>
      cb.addEventListener('change', async () => { await setMembership(cb.dataset.pl, song.id, cb.checked); playlists(); }));
    menu.querySelector('.new').addEventListener('click', async () => {
      const pl = await createPlaylist();
      if (pl) await setMembership(pl.id, song.id, true);
      playlists();
    });
  };
  main();
  menu.classList.remove('hidden');
  placeMenu(menu, anchor.getBoundingClientRect());
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
let processDone = null;

/** `done(started)` viene chiamata alla chiusura del dialog. */
function openProcess(songs, done) {
  processTargets = songs;
  processDone = done || null;
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
  syncProcHint();
  $('#process-dlg').showModal();
}

/** Con RoFormer: spiegazione e tempi (molto più lento di Demucs). */
function syncProcHint() {
  $('#proc-rf-hint').classList.toggle('hidden', !$('#proc-model').value.startsWith('roformer'));
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
      uiAlert(`"${s.name}": ${e.message}`);
    }
  }
  processTargets = [];
  refreshSongs();
}

function setupProcess() {
  $('#proc-model').addEventListener('change', syncProcHint);
  $('#process-dlg').addEventListener('close', async () => {
    const ok = $('#process-dlg').returnValue === 'ok';
    const done = processDone;
    processDone = null;
    if (ok) await startProcess();
    if (done) done(ok);
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
        reject(new Error(tr(msg) || `HTTP ${xhr.status}`));
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
      uiAlert(`Caricamento di "${f.name}" fallito: ${e.message}`);
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
      uiAlert(`Import fallito: ${err.message}`);
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


/** Pagina non sicura (es. http://192.168.…): spiega come aprire l'app perché l'audio funzioni. */
function showInsecureNotice() {
  if (document.querySelector('#insecure-notice')) return;
  const host = location.hostname;
  const el = document.createElement('div');
  el.id = 'insecure-notice';
  el.className = 'insecure-notice';
  el.innerHTML = `<strong>L'audio non può funzionare in questa pagina.</strong>
    Il browser attiva il motore audio solo in pagine sicure: apri Noises in <b>HTTPS</b>
    (per esempio tramite Cloudflare Tunnel) oppure su <b>localhost</b> dal computer del server.`;
  document.body.appendChild(el);
}

if (!window.isSecureContext) showInsecureNotice();

function closePlayer() {
  flushProject();
  engine.clear();
  state.chords = null;
  state.notes = null;
  state.markers = [];
  state.regions = [];
  closeRegionsMenu();
  closeChordMenu();
  closeMarkerMenu();
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


/** Applica subito tonalità e velocità correnti (motore in tempo reale). */
function applyRate() {
  updateKnobs();
  if (!engine.tracks.length) return;
  const tl = tlEl();
  const pitchChanged = state.pitch !== engine.pitch;
  const ratio = engine.setRate(state.tempo, state.pitch);
  schedHorizon = null;
  if (typeof layoutRoll === 'function') for (const stem of Object.keys(rolls)) layoutRoll(stem);
  if (pitchChanged) {
    // accordi, tonalità del brano e spartito sono mostrati trasposti
    closeChordMenu();
    renderChords();
    lastChordShown = null;
    if (typeof sc !== 'undefined' && sc.data && !$('#score-view').classList.contains('hidden')) loadScore();
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
  $('#reset').addEventListener('click', () => {
    if (state.pitch === 0 && state.tempo === 100) return;
    state.pitch = 0;
    state.tempo = 100;
    applyRate();
  });
  $('#master').addEventListener('input', (e) => setMaster(Number(e.target.value)));
  $('#reset-all').addEventListener('click', resetSettings);

  document.addEventListener('keydown', (e) => {
    if (!state.current || e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') engine.seek(engine.position() - 5);
    else if (e.code === 'ArrowRight') engine.seek(engine.position() + 5);
    else if (e.code === 'Home') { e.preventDefault(); goToStart(); }
    else if (e.code === 'KeyL') toggleLoop();
    else if (e.code === 'KeyI' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setLoopIn(); }
    else if (e.code === 'KeyO' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setLoopOut(); }
    else if (e.code === 'KeyM') { e.preventDefault(); addMarker(); }
    else if (e.code === 'Comma') prevMarker();
    else if (e.code === 'Period') nextMarker();
    else if (e.code === 'Escape') setSelection(null);
  });

  $('#loop').addEventListener('click', toggleLoop);
  $('#loop-in').addEventListener('click', setLoopIn);
  $('#loop-out').addEventListener('click', setLoopOut);
  $('#play-sel').addEventListener('click', playSelection);
  $('#sel-clear').addEventListener('click', () => setSelection(null));
  $('#export').addEventListener('click', () => openExport());
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
  else {
    if (state.setlist) cancelCountdown(); // Play durante il conto alla rovescia: parte subito
    playWithCountIn();
  }
  if (state.setlist) updateSetlistBar();
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
  for (const k of Object.keys(rolls)) delete rolls[k];
  const ref = state.refSong;
  const done = new Set();
  const order = [];
  for (const t of engine.tracks) {
    if (done.has(t.name)) continue;
    const g = folderOf(t.name);
    if (g) {
      const kids = folderKids(g);
      kids.forEach((k) => done.add(k.name));
      order.push({ folder: g, kids });
      if (!g.collapsed) kids.forEach((k) => order.push({ track: k, child: true }));
      else kids.forEach((k) => { k.row = null; k.canvas = null; });
    } else {
      done.add(t.name);
      order.push({ track: t });
    }
  }
  for (const item of order) {
    if (item.folder) { root.appendChild(buildFolderRow(item.folder, item.kids)); continue; }
    const t = item.track;
    const color = trackColor(t);
    const title = trackTitle(t);
    const song = songById(t.song);
    const isRefStem = ref && t.song === ref.id && t.part !== 'original' && ref.status === 'ready';
    const row = document.createElement('div');
    row.className = `track audio-row${item.child ? ' child' : ''}${isRecTrack(t) ? ' rec-track' : ''}`;
    row.innerHTML = `
      <div class="track-head">
        <div class="track-title"><span class="grip" title="Trascina per cambiare l'ordine (Alt+↑/↓)">⠿</span><span class="swatch" style="background:${color}"></span>
          <input class="tname" value="${esc(t.label)}" placeholder="${esc(title)}" maxlength="60" title="${esc(title)} — clic per rinominare">
          <button class="fxb hidden" aria-label="Effetti">FX</button>
          <button class="tmenu" title="Altre azioni…" aria-label="Altre azioni…" aria-haspopup="menu">⋯</button></div>
        <div class="track-btns">
          ${isRecTrack(t) ? '<button class="arm" title="Registra su questa traccia: premi ⏺ nel trasporto (R)">⏺</button>' : ''}
          <button class="m" title="Muto">M</button>
          <button class="s" title="Solo">S</button>
          <input type="range" class="vol" min="0" max="1.5" step="0.01" value="${t.volume}" title="Volume">
          <span class="split-badge hidden" title="Separazione in corso"></span>
        </div>
        ${isRecTrack(t) ? `<div class="rec-line">
          <select class="rec-dev" title="Sorgente della registrazione"></select>
          <select class="rec-ch" title="Ingressi da registrare: 1 o 2 (traccia mono) oppure 1+2 (stereo)">
            <option value="stereo">1+2</option><option value="1">In 1</option><option value="2">In 2</option>
          </select>
          <div class="vu" title="Livello del segnale in ingresso (rosso: saturazione, abbassa il gain sulla scheda)"><div class="vu-fill"></div></div>
        </div>` : ''}
      </div>
      <div class="lane"><canvas class="ucanvas vcanvas"></canvas></div>`;
    row.querySelector('.m').addEventListener('click', () => { t.muted = !t.muted; syncTrackButtons(); });
    const arm = row.querySelector('.arm');
    if (arm) {
      arm.addEventListener('click', () => setRecTarget(state.recTarget === t.name ? null : t.name));
      setupRecLine(t, row);
    }
    row.querySelector('.s').addEventListener('click', () => { t.solo = !t.solo; syncTrackButtons(); });
    row.querySelector('.vol').addEventListener('input', (e) => { t.volume = Number(e.target.value); engine.updateGains(); });
    const name = row.querySelector('.tname');
    let renaming = false;
    name.addEventListener('focus', () => { renaming = false; });
    name.addEventListener('input', () => {
      if (!renaming) { pushUndo('Rinomina traccia'); renaming = true; }
      t.label = name.value.trim();
      saveProject();
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
    row.querySelector('.tmenu').addEventListener('click', (e) => { e.stopPropagation(); openTrackMenu(t, e.currentTarget, isRefStem, song); });
    row.querySelector('.fxb').addEventListener('click', (e) => { e.stopPropagation(); openFxPanel(t, e.currentTarget); });
    t.row = row;
    syncFxBadge(t);
    t.canvas = row.querySelector('canvas');
    t.color = color;
    root.appendChild(row);
    decorateRow(t, row);
    if (isRefStem) root.appendChild(buildNotesRow({ name: t.part, color }));
  }
  if (!engine.tracks.length && !(state.pendingAdds && state.pendingAdds.size)) {
    root.innerHTML = '<div class="tracks-empty">Il progetto è vuoto: aggiungi un brano con il pulsante qui sotto o trascinalo dalla <b>Libreria</b>.</div>';
  }
  // in fondo all'elenco, come in Moises
  const add = document.createElement('div');
  add.className = 'add-row';
  add.innerHTML = '<div class="track-head"><button class="add-track-btn">＋ Aggiungi traccia</button></div><div class="lane"></div>';
  add.querySelector('button').addEventListener('click', () => openAddTrack());
  const pend = document.createElement('div');
  pend.id = 'pending-imports';
  root.appendChild(pend);
  renderPendingImports();
  root.appendChild(add);
  if (fxUi.track) renderFxPanel(); // la traccia potrebbe non esserci più
  syncTrackButtons();
  updateSplitBadges();
  layoutTimeline();
  renderChords();
  updateRhythmControls();
}

function syncTrackButtons() {
  engine.updateGains();
  syncFolderRows();
  for (const tr of engine.tracks) {
    if (!tr.row) continue;
    tr.row.querySelector('.m').classList.toggle('on', tr.muted);
    tr.row.querySelector('.s').classList.toggle('on', tr.solo);
    const arm = tr.row.querySelector('.arm');
    if (arm) arm.classList.toggle('on', state.recTarget === tr.name);
    tr.row.classList.toggle('silent', !engine.isAudible(tr));
  }
  drawOverview();
  requestRedraw(); // le righe dei gruppi disegnano diverse le tracce che non si sentono
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
  renderMarkers();
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
  try { state.barLines = localStorage.getItem('noises.barLines') === '1'; } catch {}
  $('#bar-lines').checked = !!state.barLines;
  $('#bar-lines').addEventListener('change', (e) => {
    state.barLines = e.target.checked;
    try { localStorage.setItem('noises.barLines', state.barLines ? '1' : '0'); } catch {}
    drawAll();
  });
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
  const bps = engine.sr / PEAK_BLOCK, D = engine.origDuration;
  for (const t of engine.tracks) {
    const p = t.peaks, audible = engine.isAudible(t);
    for (const c of t.clips) {
      const x0 = Math.max(0, Math.floor((c.start / D) * w)), x1 = Math.min(w, Math.ceil(((c.start + c.duration) / D) * w));
      for (let x = x0; x < x1; x++) {
        const t0 = (x / w) * D, t1 = ((x + 1) / w) * D;
        const b0 = Math.max(0, Math.floor((t0 - c.start + c.offset) * bps)), b1 = Math.max(b0 + 1, Math.floor((t1 - c.start + c.offset) * bps));
        let m = 0;
        const stride = Math.max(1, Math.floor((b1 - b0) / 48));
        for (let i = b0; i < b1 && i < p.length; i += stride) if (p[i] > m) m = p[i];
        if (m > colsAll[x]) colsAll[x] = m;
        if (audible && m > cols[x]) cols[x] = m;
      }
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
  const sel = shownSel(), ovSel = $('#ov-sel');
  ovSel.classList.toggle('hidden', !sel);
  if (sel) {
    ovSel.style.left = `${headWidth() + (sel.start / engine.duration) * W}px`;
    ovSel.style.width = `${Math.max(2, ((sel.end - sel.start) / engine.duration) * W)}px`;
    ovSel.classList.toggle('loop', state.loopOn || state.loopIn != null);
  }
}

function setupOverview(zoomWheel) {
  const ov = $('#overview'), win = $('#ov-win');
  let drag = null;
  const xToTime = (clientX) => Math.min(engine.duration, Math.max(0,
    (((clientX - ov.getBoundingClientRect().left) / uiZoom() - headWidth()) / ovW()) * engine.duration));
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
      const dx = (e.clientX - drag.x0) / uiZoom();
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
/** Zoom dell'interfaccia (html { zoom }): le coordinate del mouse e di getBoundingClientRect
 *  sono già ridotte, le misure CSS (larghezze, scroll, left/top) no. */
function uiZoom() {
  return parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}

/** Posiziona un menu fisso sotto (o sopra, se non c'è spazio) il rettangolo `r`. */
function placeMenu(menu, r, { gap = 4, flip = true } = {}) {
  const z = uiZoom();
  const mw = menu.offsetWidth * z, mh = menu.offsetHeight * z;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
  let top = r.bottom + gap;
  if (flip && top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - gap);
  menu.style.left = `${left / z}px`;
  menu.style.top = `${top / z}px`;
}

function timeAt(clientX) {
  const tl = tlEl();
  const x = (clientX - tl.getBoundingClientRect().left) / uiZoom() - headWidth() + tl.scrollLeft;
  return Math.min(Math.max(0, x / state.zoom), engine.duration);
}

/** Click = sposta la posizione; trascinamento = seleziona una porzione. */
function setupTimeline() {
  const tl = $('#timeline');
  let drag = null;
  tl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !engine.tracks.length) return;
    if (!e.target.matches('canvas.ucanvas, #ruler')) return;
    e.preventDefault();
    drag = { x0: e.clientX, t0: timeAt(e.clientX), moved: false,
      canvas: e.target.matches('canvas.ucanvas') ? e.target : null,
      ev: { clientX: e.clientX, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey } };
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
      if (d.canvas) trackClick(d.canvas, d.ev);
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
  state.loopIn = null;
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

const LOOP_MIN = 0.2;

/** I: fissa l'inizio del loop dove si trova la testina (con il loop attivo lo sposta subito). */
function setLoopIn() {
  if (!engine.tracks.length) return;
  const t = engine.position();
  const s = state.sel;
  if (state.loopOn && s && t < s.end - LOOP_MIN) { setSelection({ start: t, end: s.end }); return; }
  state.loopIn = t;
  positionSelection();
  positionOverview();
  toast('Inizio del loop fissato: premi O per fissare la fine');
}

/** O: fissa la fine del loop alla testina e lo attiva (l'ascolto riparte dall'inizio del loop). */
function setLoopOut() {
  if (!engine.tracks.length) return;
  const t = engine.position();
  const start = state.loopIn ?? (state.loopOn && state.sel ? state.sel.start : null);
  if (start === null) { toast("Premi prima I per fissare l'inizio del loop"); return; }
  if (t - start < LOOP_MIN) { toast("La fine del loop deve venire dopo l'inizio"); return; }
  state.loopOn = true;
  setSelection({ start, end: t });
  if (!engine.playing) engine.seek(start);
}

/** Maniglie ai bordi della selezione: trascinandole si spostano inizio e fine (anche del loop). */
function setupSelectionHandles() {
  const el = $('#selection');
  for (const edge of ['start', 'end']) {
    const h = document.createElement('div');
    h.className = `sel-h ${edge === 'start' ? 'l' : 'r'}`;
    h.title = edge === 'start' ? 'Trascina per spostare l\'inizio (Ctrl: aggancia al click)' : 'Trascina per spostare la fine (Ctrl: aggancia al click)';
    el.appendChild(h);
    let drag = null;
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !state.sel || state.loopIn != null) return;
      e.preventDefault();
      e.stopPropagation();
      const reg = regionOfSelection();
      if (reg) pushUndo('Regola sezione');
      drag = { reg, dx: timeAt(e.clientX) - state.sel[edge] };
      h.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const s = state.sel, MIN = 0.05;
      let t = timeAt(e.clientX) - drag.dx;
      if (e.ctrlKey || e.metaKey) t = nearestBeat(t); // Ctrl: aggancio al click più vicino
      const next = { ...s };
      if (edge === 'start') next.start = Math.max(0, Math.min(s.end - MIN, t));
      else next.end = Math.min(engine.duration, Math.max(s.start + MIN, t));
      state.sel = next;
      engine.stopAt = null;
      if (state.loopOn) engine.setLoop({ ...next }); // il loop segue senza interruzioni
      if (drag.reg) {
        const k = rk();
        drag.reg.start = +(next.start / k).toFixed(3);
        drag.reg.end = +(next.end / k).toFixed(3);
      }
      updateSelectionUI();
    });
    const end = () => {
      if (!drag) return;
      const { reg } = drag;
      drag = null;
      el.classList.remove('dragging');
      const s = state.sel;
      if (s && !engine.playing && edge === 'start') engine.seek(s.start);
      else if (s && engine.playing && state.loopOn && (engine.position() < s.start || engine.position() > s.end)) engine.seek(s.start);
      if (reg) saveProject();
      if (!$('#regions-menu').classList.contains('hidden')) renderRegionsMenu();
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }
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
  const reg = regionOfSelection();
  $('#sel-info').textContent = sel
    ? `${fmtPrecise(sel.start)} – ${fmtPrecise(sel.end)} (${(sel.end - sel.start).toFixed(1)} s)`
    : '';
  updateRegionsUI(reg);
  if (typeof updatePresetsUI === 'function') updatePresetsUI();
  $('#selection').classList.toggle('loop', state.loopOn);
  positionSelection();
  positionOverview();
}

/** Porzione da disegnare: con l'inizio fissato (I) va dall'inizio alla testina, altrimenti la selezione. */
function shownSel() {
  if (state.loopIn == null) return state.sel;
  const p = engine.position();
  return { start: Math.min(state.loopIn, p), end: Math.max(state.loopIn, p) };
}

function positionSelection() {
  const el = $('#selection'), sel = shownSel();
  el.classList.toggle('hidden', !sel || !engine.duration);
  el.classList.toggle('pending', state.loopIn != null);
  $('#loop-in').classList.toggle('on', state.loopIn != null);
  el.classList.toggle('loop', state.loopOn || state.loopIn != null);
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

// ------------------------------------------------ salvataggio automatico
//
// Le impostazioni si salvano da sole; "Reimposta" torna a quelle originali.

state.ab = 'custom';
let autosaveTimer = null, autosaveStatus = 'idle', autosaveRetryAt = 0;

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
    fetch(`/api/projects/${state.current.id}/settings`, {
      method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentSettings()),
    }).catch(() => {});
  } else {
    saveSettings();
  }
}

function updateSaveUI() {
  if (!state.current) return;
  if (typeof updatePresetsUI === 'function') updatePresetsUI();
  const custom = state.ab === 'custom';
  if (custom && !state.pending && engine.tracks.length && isDirty()) scheduleAutosave();
  const isDefault = JSON.stringify(currentSettings()) === JSON.stringify(normalizeSettings({}));
  $('#reset-all').disabled = custom && isDefault && !(state.current && state.current.settings);
}

function storeSongSettings(settings) {
  state.current.settings = settings;
  state.saved = JSON.stringify(normalizeSettings(settings || {}));
}

async function saveSettings() {
  const song = state.current;
  if (!song || state.ab !== 'custom') return;
  const cfg = currentSettings();
  autosaveStatus = 'saving';
  try {
    await api(`/api/projects/${song.id}/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
    });
    if (state.current === song) storeSongSettings(cfg);
    autosaveStatus = 'idle';
  } catch (e) {
    autosaveStatus = 'error';
    autosaveRetryAt = Date.now() + 5000; // nuovo tentativo tra 5 s
    toast(`Impostazioni non salvate: ${e.message}`);
  }
  updateSaveUI();
}

async function resetSettings() {
  const song = state.current;
  if (!song || !(await uiConfirm('Reimpostare il progetto ai valori originali?\n\nSi perdono tonalità, velocità, volumi, muto/solo, master, selezione e loop.\nTracce, clip e segnalibri restano come sono.', { title: 'Reimposta', ok: 'Reimposta', danger: true }))) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  state.ab = 'custom';
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
    if (song.settings) await api(`/api/projects/${song.id}/settings`, { method: 'DELETE' });
    if (state.current === song) storeSongSettings(null);
  } catch (e) {
    uiAlert(`Reset fallito: ${e.message}`);
  }
  updateSaveUI();
}

/** Tracce da esportare: quelle udibili, oppure solo quella scelta dal menu ⋯ della traccia. */
function activeStems() {
  if (state.exportOnly) return engine.tracks.filter((t) => state.exportOnly.includes(t.name));
  return engine.tracks.filter((t) => engine.isAudible(t) && t.volume > 0);
}

function defaultExportName() {
  const song = state.current;
  if (state.exportOnly) {
    const ts = engine.tracks.filter((x) => state.exportOnly.includes(x.name));
    const f = ts.length > 1 && folderOf(ts[0].name);
    return `${song.name} - ${f ? f.name : ts.map(trackTitle).join(', ')}`.replace(/[\\/:*?"<>|]+/g, '_');
  }
  const active = activeStems();
  const off = engine.tracks.filter((t) => !active.includes(t));
  const lbl = (t) => trackTitle(t);
  let name = song.name;
  if (off.length) {
    name += off.length <= active.length
      ? tr(` - senza ${off.map(lbl).join(', ')}`)
      : tr(` - solo ${active.map(lbl).join(', ')}`);
  }
  if (state.pitch) name += ` (${state.pitch > 0 ? '+' : ''}${state.pitch} st)`;
  if (state.tempo !== 100) name += ` (${state.tempo}%)`;
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

function openExport(onlyTrack) {
  if (!engine.tracks.length) return;
  state.exportOnly = onlyTrack ? (Array.isArray(onlyTrack) ? onlyTrack : [onlyTrack]).map((t) => t.name) : null;
  const active = activeStems();
  $('#exp-tracks').innerHTML = engine.tracks.map((t) =>
    `<span class="chip ${active.includes(t) ? '' : 'off'}" style="--c:${t.color}">${esc(trackTitle(t))}</span>`).join('');
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
  // stesso suono del metronomo scelto per l'ascolto
  if (clickOpts.click) clickOpts.click.samples = await renderClickSamples();
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
    const r = await fetch(`/api/projects/${song.id}/export`, {
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
    uiAlert(`Esportazione fallita: ${e.message}`);
  } finally {
    setLoader(null);
  }
}

let uiZoomCache = 0;
function fitCanvas(c) {
  // un pixel del canvas per pixel dello schermo anche con lo zoom dell'interfaccia
  if (!uiZoomCache) uiZoomCache = uiZoom();
  const dpr = (window.devicePixelRatio || 1) * uiZoomCache;
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
    const g = state.notes.grid, k = 100 / engine.tempo, bpb = g.beats_per_bar || 4, a = refAnchor();
    const barPx = (g.beats[Math.min(bpb, g.beats.length - 1)] - g.beats[0]) * k * z;
    const every = barPx >= 28 ? 1 : barPx >= 7 ? 4 : barPx >= 2 ? 16 : 0;
    if (every) {
      ctx.fillStyle = '#a48bff';
      ctx.font = `${10 * dpr}px system-ui, sans-serif`;
      const first = Math.floor((beatPos(t0 / k - a) - g.downbeat) / bpb) - 1;
      for (let bar = Math.max(-1, first); ; bar++) {
        const t = (beatTime(g.downbeat + bar * bpb) + a) * k;
        if (t > t1) break;
        if (t < a * k || bar % every) continue;
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

/** Linee delle battute (e dei battiti, se c'è spazio) sullo sfondo di una corsia: seguono il click
 *  (battiti rilevati, stretti o BPM fisso, metro scelto e spostamento fine). */
function drawBarLines(ctx, w, h, dpr) {
  if (!state.barLines || !engine.duration || !(typeof hasGrid === 'function' && hasGrid())) return;
  const sl = tlEl().scrollLeft, z = state.zoom, n = clickNudge();
  const t0 = sl / z, t1 = (sl + w / dpr) / z;
  const beats = clickTimes(Math.max(0, t0 - n - 1), t1 - n + 1);
  if (beats.length > 3000) return; // troppo fitte per essere utili
  const bars = beats.filter((b) => b.accent);
  const barPx = bars.length > 1 ? (bars[1].t - bars[0].t) * z : Infinity;
  if (barPx < 5) return;
  const showBeats = beats.length > 1 && (beats[1].t - beats[0].t) * z >= 18;
  for (const b of beats) {
    if (!b.accent && !showBeats) continue;
    ctx.fillStyle = b.accent ? '#a48bff4d' : '#ffffff0f';
    ctx.fillRect(Math.round(((b.t + n) * z - sl) * dpr), 0, dpr, h);
  }
}

function drawAll() {
  if (!state.current || !engine.tracks.length) return;
  drawRuler();
  engine.tracks.forEach((t) => { if (t.canvas && t.canvas.isConnected) drawTrack(t); });
  state.groups.forEach((g) => { if (g.folder) drawFolder(g); });
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
      if (typeof onPlaybackEnded === 'function') onPlaybackEnded();
    }
    $('#pos').textContent = fmt(pos);
    const sec = currentSection(pos);
    if ($('#section').textContent !== (sec ? `· ${sec}` : '')) $('#section').textContent = sec ? `· ${sec}` : '';
    $('#dur').textContent = fmt(engine.duration);
    $('#play').textContent = engine.playing ? '❚❚' : '▶';
    $('#playhead').style.left = `${headWidth() + pos * state.zoom}px`;
    if (state.loopIn != null) { positionSelection(); positionOverview(); } // area verde che cresce con la testina
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
  maj: ['', T('maggiore')], min: ['m', T('minore')], 7: ['7', T('settima di dominante')],
  maj7: ['maj7', T('settima maggiore')], min7: ['m7', T('minore settima')], maj6: ['6', T('sesta')],
  min6: ['m6', T('minore sesta')], sus2: ['sus2', T('sospeso 2')], sus4: ['sus4', T('sospeso 4')],
  dim: ['dim', T('diminuito')], dim7: ['dim7', T('diminuito settima')], hdim7: ['m7♭5', T('semidiminuito')],
  aug: ['aug', T('aumentato')], minmaj7: ['m(maj7)', T('minore settima maggiore')],
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
    if (seq !== chordSeq || !state.refSong || state.refSong.id !== song.id) return;
    setChords(sheet);
  } catch (e) {
    if (seq !== chordSeq) return;
    if (e.status === 409) {
      const fresh = state.songs.find((x) => x.id === song.id) || song;
      if (fresh.phase === 'Analisi accordi') runChordAnalysis(song);
      else if (['queued', 'processing', 'downloading'].includes(fresh.status)) renderChords('Separazione in corso: gli accordi arrivano al termine');
      // brano non separato: gli accordi si calcolano subito sul brano intero
      else if (fresh.status !== 'ready') runChordAnalysis(song);
      else showChordsMissing(song);
    } else {
      renderChords(`Accordi non disponibili: ${e.message}`);
    }
  }
}

function showChordsMissing(song) {
  state.chordsMissing = true;
  renderChords('Accordi non ancora analizzati');
  const ph = $('#chord-lane .placeholder');
  const b = document.createElement('button');
  b.className = 'lane-action';
  b.innerHTML = '<span class="emo">🎵</span> Riconosci accordi';
  b.addEventListener('click', () => runChordAnalysis(song));
  ph.appendChild(b);
}

async function runChordAnalysis(song, redo) {
  const seq = ++chordSeq;
  state.chords = null;
  renderChords(song.status === 'ready' ? 'Analisi accordi in corso…' : 'Analisi accordi sul brano intero in corso…');
  try {
    const sheet = await api(`/api/songs/${song.id}/chords/analyze${redo ? '?redo=true' : ''}`, { method: 'POST' });
    if (seq === chordSeq && state.refSong && state.refSong.id === song.id) setChords(sheet);
  } catch (e) {
    if (seq === chordSeq) renderChords(`Analisi accordi fallita: ${e.message}`);
  }
}

/** Ripete il riconoscimento accordi del brano della traccia (scarta le correzioni). */
async function recomputeChords(t) {
  const song = songById(t.song);
  if (!song) return;
  if (state.refSong && state.refSong.id === song.id && state.chords && state.chords.edited
    && !(await uiConfirm('Le correzioni fatte a mano agli accordi andranno perse. Ricalcolare?', { ok: 'Ricalcola', danger: true }))) return;
  if (state.refTrack !== t.name) setReference(t);
  chordSeq++; // annulla un eventuale caricamento avviato da setReference
  await runChordAnalysis(song, true);
  if (state.refSong && state.refSong.id === song.id && state.chords) toast(`Accordi di "${song.name}" ricalcolati`);
}

function setChords(sheet) {
  state.chordsMissing = false;
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
  if (!sheet && !message && state.chordsMissing && state.refSong) { showChordsMissing(state.refSong); return; }
  if (!sheet || !engine.duration) {
    const idle = !engine.tracks.length ? 'Trascina un brano dalla libreria nella timeline'
      : state.refSong && ['queued', 'processing', 'downloading'].includes(state.refSong.status) ? 'Separazione in corso: gli accordi arrivano al termine'
      : 'Caricamento accordi…';
    lane.innerHTML = `<div class="placeholder">${esc(message || (sheet ? '' : idle))}</div>`;
    return;
  }
  const scale = 100 / engine.tempo * state.zoom; // secondi originali → pixel
  const a = refAnchor(); // il brano di riferimento inizia qui nella timeline
  lane.innerHTML = sheet.chords.map((c, i) => `
    <div class="chord-block ${c.root == null ? 'nc' : ''} ${i === chordIdx ? 'current' : ''}" data-i="${i}"
      style="left:${(c.start + a) * scale}px;width:${(c.end - c.start) * scale}px"
      title="${esc(chordName(c))}${c.quality ? ` — ${QUALITY[c.quality][1]}` : ''}">
      ${i > 0 ? '<span class="chord-handle" title="Trascina per spostare il cambio di accordo"></span>' : ''}${esc(chordName(c))}
    </div>`).join('');
  lastChordShown = null;
}

let lastChordShown = null;
function updateChordNow(pos) {
  const sheet = state.chords;
  if (!sheet || !sheet.chords.length) return;
  const t = pos * engine.tempo / 100 - refAnchor(); // posizione nel brano di riferimento
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
  const song = state.refSong, sheet = state.chords;
  sheet.edited = true;
  $('#chord-restore').classList.remove('hidden');
  chordSave = setTimeout(async () => {
    try {
      await api(`/api/songs/${song.id}/chords`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chords: sheet.chords }),
      });
    } catch (e) {
      uiAlert(`Salvataggio accordi fallito: ${e.message}`);
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
  const toDisp = (t) => (t + refAnchor()) * 100 / engine.tempo;
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
  placeMenu(menu, anchor.getBoundingClientRect());
}

function setupChords() {
  try { state.notation = localStorage.getItem('noises.notation') || 'en'; } catch { state.notation = 'en'; }
  // pulsante compatto: mostra la notazione attuale, un clic passa all'altra
  const showNotation = () => {
    const it = state.notation === 'it';
    $('#chord-notation').textContent = it ? 'Do' : 'C';
    $('#chord-notation').title = it ? 'Notazione italiana (Do Re Mi): clic per passare a C D E'
      : 'Notazione americana (C D E): clic per passare a Do Re Mi';
  };
  showNotation();
  $('#chord-notation').addEventListener('click', () => {
    state.notation = state.notation === 'it' ? 'en' : 'it';
    showNotation();
    try { localStorage.setItem('noises.notation', state.notation); } catch {}
    renderChords();
    lastChordShown = null;
  });
  $('#chord-restore').addEventListener('click', async () => {
    const song = state.refSong;
    if (!(await uiConfirm('Eliminare le correzioni e tornare agli accordi rilevati automaticamente?', { ok: 'Ripristina', danger: true }))) return;
    clearTimeout(chordSave);
    closeChordMenu();
    try {
      const sheet = await api(`/api/songs/${song.id}/chords/edits`, { method: 'DELETE' });
      if (state.refSong === song) setChords(sheet);
    } catch (e) {
      uiAlert(e.message);
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
    const t = timeAt(e.clientX) * engine.tempo / 100 - refAnchor();
    openChordMenu(i, t, block);
  });
  lane.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const list = state.chords.chords;
    const prev = list[drag.i - 1], cur = list[drag.i];
    const t = timeAt(e.clientX) * engine.tempo / 100 - refAnchor();
    const b = Math.min(Math.max(t, prev.start + 0.1), cur.end - 0.1);
    prev.end = cur.start = b;
    drag.moved = true;
    const scale = 100 / engine.tempo * state.zoom;
    const pEl = lane.querySelector(`[data-i="${drag.i - 1}"]`), cEl = lane.querySelector(`[data-i="${drag.i}"]`);
    pEl.style.width = `${(prev.end - prev.start) * scale}px`;
    cEl.style.left = `${(cur.start + refAnchor()) * scale}px`;
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
  setupSelectionHandles();
  setupZoom();
  setupNotes();
  setupScore();
  setupMarkers();
  setupUserTracks();
  setupRecorder();
  setupSections();
  setupPresets();
  setupEditor();
  setupProjects();
  updateSelectionUI();
  setInterval(() => state.current && updateSaveUI(), 250);
  window.addEventListener('pagehide', () => state.current && flushAutosave(true));
  // i brani li carica setupProjects (servono per riaprire l'ultimo progetto)
  requestAnimationFrame(tick);
}

boot();
