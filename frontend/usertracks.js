'use strict';
// Tracce utente: file audio trascinati sulla timeline. A differenza delle tracce separate
// (un blocco unico, non spostabile) le loro clip si possono spostare, tagliare e accorciare.
// Tempi in secondi alla velocità originale del brano.

const USER_COLOR = '#d9dde6';
const EDGE_PX = 7;
const userSaveTimers = {};

const ukid = () => Math.random().toString(36).slice(2, 14);
const uk = () => 100 / engine.tempo;

function snapUser(t, free) {
  if (free || typeof hasGrid !== 'function' || !hasGrid()) return Math.max(0, t);
  return Math.max(0, beatTime(Math.round(beatPos(t))));
}

function userTrackMeta(t) {
  return (state.current.user_tracks || []).find((u) => u.id === t.tid);
}

/** Salva nome e clip sul server (con un piccolo ritardo per raggruppare le modifiche). */
function saveUserTrack(t) {
  const song = state.current;
  const meta = userTrackMeta(t);
  if (meta) { meta.name = t.label; meta.clips = t.clips.map((c) => ({ ...c })); }
  clearTimeout(userSaveTimers[t.tid]);
  userSaveTimers[t.tid] = setTimeout(async () => {
    try {
      await api(`/api/songs/${song.id}/tracks/${t.tid}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: t.label, clips: t.clips }),
      });
    } catch (e) {
      alert(`Salvataggio della traccia fallito: ${e.message}`);
    }
  }, 400);
}

/** Dopo ogni modifica alle clip: aggiorna motore audio, durata, disegno e salvataggio. */
function clipsChanged(t) {
  t.clips.sort((a, b) => a.start - b.start);
  if (engine.setClips(t)) layoutTimeline();
  requestRedraw();
  saveUserTrack(t);
}

// ------------------------------------------------------------------- aggiunta

async function decodeToArrays(arrayBuffer) {
  const buf = await engine.ctx.decodeAudioData(arrayBuffer);
  const l = new Float32Array(buf.getChannelData(0));
  const r = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : l;
  return { l, r, peaks: computePeaks(l, r) };
}

function uploadTrackFile(song, file, start) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('start', String(start));
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/songs/${song.id}/tracks`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setLoader(`Aggiunta di "${file.name}"…`, `${mb(e.loaded)} / ${mb(e.total)}`, e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else {
        let msg = xhr.statusText;
        try { msg = JSON.parse(xhr.responseText).error; } catch {}
        reject(new Error(msg || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('errore di rete'));
    xhr.send(fd);
  });
}

async function addUserTrackFromFile(file, startDisplay) {
  const song = state.current;
  if (!song || !engine.tracks.length) return;
  const start = +(Math.max(0, startDisplay) / uk()).toFixed(3);
  setLoader(`Aggiunta di "${file.name}"…`, '', null);
  try {
    const meta = await uploadTrackFile(song, file, start);
    setLoader(`Aggiunta di "${file.name}"…`, 'decodifica', null);
    let audio;
    try {
      audio = await decodeToArrays(await file.arrayBuffer());
    } catch {
      // formato non decodificabile dal browser: si usa la versione convertita dal server
      const r = await fetch(`/api/songs/${song.id}/tracks/${meta.id}/audio`);
      audio = await decodeToArrays(await r.arrayBuffer());
    }
    if (state.current !== song) return;
    (song.user_tracks = song.user_tracks || []).push(meta);
    const s = state.songs.find((x) => x.id === song.id);
    if (s && s !== song) s.user_tracks = song.user_tracks;
    const t = engine.addUserTrack({ name: `user:${meta.id}`, user: true, tid: meta.id, label: meta.name, clips: meta.clips, ...audio });
    buildTracks();
    // la nuova traccia è in fondo: la porta in vista e seleziona la sua clip
    state.selClip = { tid: t.tid, cid: t.clips[0].id };
    const tl = tlEl(), rr = t.row.getBoundingClientRect(), tr = tl.getBoundingClientRect();
    if (rr.bottom > tr.bottom || rr.top < tr.top) tl.scrollTop += rr.bottom - tr.bottom + 20;
    requestRedraw();
  } catch (e) {
    alert(`Impossibile aggiungere "${file.name}": ${e.message}`);
  } finally {
    setLoader(null);
  }
}

// -------------------------------------------------------------------- disegno

function drawUserTrack(t) {
  const [ctx, w, h, dpr] = fitCanvas(t.canvas);
  const sl = tlEl().scrollLeft, z = state.zoom, k = uk();
  const bps = engine.sr / PEAK_BLOCK;
  const mid = h / 2;
  for (const c of t.clips) {
    const x0 = (c.start * k * z - sl) * dpr;
    const x1 = ((c.start + c.duration) * k * z - sl) * dpr;
    if (x1 < 0 || x0 > w) continue;
    const sel = state.selClip && state.selClip.cid === c.id;
    ctx.fillStyle = sel ? '#ffffff26' : '#ffffff12';
    ctx.fillRect(x0, 2 * dpr, x1 - x0, h - 4 * dpr);
    ctx.fillStyle = USER_COLOR;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
      const t0 = (sl + x / dpr) / z / k, t1 = (sl + (x + 1) / dpr) / z / k;
      const s0 = t0 - c.start + c.offset, s1 = t1 - c.start + c.offset;
      const b0 = Math.max(0, Math.floor(s0 * bps)), b1 = Math.max(b0 + 1, Math.floor(s1 * bps));
      let peak = 0;
      const stride = Math.max(1, Math.floor((b1 - b0) / 64));
      for (let i = b0; i < b1 && i < t.peaks.length; i += stride) if (t.peaks[i] > peak) peak = t.peaks[i];
      const y = Math.max(dpr * 0.5, peak * (mid - 4 * dpr) * 0.95);
      ctx.fillRect(x, mid - y, 1, y * 2);
    }
    ctx.strokeStyle = sel ? '#fff' : '#9aa3b5';
    ctx.lineWidth = (sel ? 2 : 1) * dpr;
    ctx.strokeRect(x0 + 0.5 * dpr, 2 * dpr, x1 - x0 - dpr, h - 4 * dpr);
    // maniglie per accorciare
    ctx.fillStyle = sel ? '#fff' : '#9aa3b5';
    ctx.fillRect(x0, mid - 8 * dpr, 3 * dpr, 16 * dpr);
    ctx.fillRect(x1 - 3 * dpr, mid - 8 * dpr, 3 * dpr, 16 * dpr);
  }
}

// ------------------------------------------------------------------ modifica

function clipAt(t, clientX) {
  const time = timeAt(clientX) / uk();
  const pxPerSec = state.zoom * uk();
  for (const c of t.clips) {
    const left = (time - c.start) * pxPerSec, right = (c.start + c.duration - time) * pxPerSec;
    if (left >= -EDGE_PX && right >= -EDGE_PX) {
      const mode = left <= EDGE_PX ? 'left' : right <= EDGE_PX ? 'right' : 'move';
      return { c, mode, time };
    }
  }
  return { c: null, time };
}

/** Divide una clip nel punto `at` (secondi originali). */
function splitClip(t, c, at) {
  if (at <= c.start + 0.02 || at >= c.start + c.duration - 0.02) return false;
  const tail = { id: ukid(), start: at, offset: c.offset + (at - c.start), duration: c.start + c.duration - at };
  c.duration = at - c.start;
  t.clips.push(tail);
  return true;
}

function splitAtPlayhead(onlyTrack) {
  const at = engine.position() / uk();
  let done = false;
  for (const t of engine.tracks.filter((x) => x.user && (!onlyTrack || x === onlyTrack))) {
    const targets = t.clips.filter((c) => at > c.start && at < c.start + c.duration
      && (!state.selClip || state.selClip.tid !== t.tid || state.selClip.cid === c.id));
    let changed = false;
    for (const c of targets) changed = splitClip(t, c, at) || changed;
    if (changed) { clipsChanged(t); done = true; }
  }
  return done;
}

function deleteSelectedClip() {
  const sel = state.selClip;
  if (!sel) return false;
  const t = engine.tracks.find((x) => x.tid === sel.tid);
  if (!t) return false;
  t.clips = t.clips.filter((c) => c.id !== sel.cid);
  state.selClip = null;
  clipsChanged(t);
  return true;
}

function setupUserCanvas(t) {
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
    if (!hit.c) {
      state.selClip = null;
      engine.stopAt = null;
      engine.seek(timeAt(e.clientX));
      requestRedraw();
      return;
    }
    state.selClip = { tid: t.tid, cid: hit.c.id };
    drag = { c: hit.c, mode: hit.mode, t0: hit.time, orig: { ...hit.c }, moved: false };
    canvas.setPointerCapture(e.pointerId);
    requestRedraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { c, orig } = drag;
    const time = timeAt(e.clientX) / uk();
    const free = e.shiftKey;
    if (drag.mode === 'move') {
      c.start = +snapUser(orig.start + (time - drag.t0), free).toFixed(3);
    } else if (drag.mode === 'left') {
      const end = orig.start + orig.duration;
      let s = snapUser(time, free);
      s = Math.min(end - 0.05, Math.max(s, orig.start - orig.offset)); // non prima dell'inizio del file
      c.offset = +(orig.offset + (s - orig.start)).toFixed(3);
      c.start = +s.toFixed(3);
      c.duration = +(end - s).toFixed(3);
    } else {
      let e2 = snapUser(time, free);
      e2 = Math.max(orig.start + 0.05, Math.min(e2, orig.start + (t.srcDuration - orig.offset)));
      c.duration = +(e2 - orig.start).toFixed(3);
    }
    drag.moved = true;
    engine.setClips(t);
    requestRedraw();
  });
  const end = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) clipsChanged(t);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function userRowHtml(t) {
  return `
    <div class="track-head">
      <div class="track-title"><span class="swatch" style="background:${USER_COLOR}"></span>
        <input class="tname" value="${esc(t.label)}" maxlength="60" title="Nome della traccia (clic per modificare)"></div>
      <div class="track-btns">
        <button class="m" title="Muto">M</button>
        <button class="s" title="Solo">S</button>
        <input type="range" class="vol" min="0" max="1.5" step="0.01" value="${t.volume}" title="Volume">
        <button class="cut" title="Taglia la clip nel punto della testina (X)">✂</button>
        <button class="deltrack" title="Elimina la traccia">🗑</button>
      </div>
    </div>
    <div class="lane"><canvas class="ucanvas vcanvas"
      title="Trascina: sposta · bordi: accorcia · Shift: senza griglia · ✂ o X: taglia alla testina · Canc: elimina la clip selezionata"></canvas></div>`;
}

function setupUserRow(t, row) {
  const name = row.querySelector('.tname');
  name.addEventListener('input', () => { t.label = name.value; saveUserTrack(t); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
  row.querySelector('.cut').addEventListener('click', () => splitAtPlayhead(t));
  row.querySelector('.deltrack').addEventListener('click', async () => {
    if (!confirm(`Eliminare la traccia "${t.label}"?`)) return;
    try {
      await api(`/api/songs/${state.current.id}/tracks/${t.tid}`, { method: 'DELETE' });
      state.current.user_tracks = (state.current.user_tracks || []).filter((u) => u.id !== t.tid);
      engine.removeTrack(t);
      buildTracks();
    } catch (e) {
      alert(e.message);
    }
  });
  setupUserCanvas(t);
}

// --------------------------------------------------- trascinamento dal disco

const AUDIO_RE = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|aiff?|wma|webm|mp4|caf)$/i;

/** Aggiunge i file audio come nuove tracce; `startDisplay` = posizione (null → testina). */
async function addAudioFiles(files, startDisplay) {
  if (!state.current || !engine.tracks.length) {
    alert('Apri prima un brano: le tracce audio si aggiungono al brano aperto nell\'editor.');
    return;
  }
  const audio = files.filter((f) => f.type.startsWith('audio/') || AUDIO_RE.test(f.name));
  const rejected = files.filter((f) => !audio.includes(f));
  if (rejected.length) alert(`Non sono file audio: ${rejected.map((f) => f.name).join(', ')}`);
  for (const f of audio) await addUserTrackFromFile(f, startDisplay ?? engine.position());
}

function setupUserTracks() {
  const player = $('#player'), tl = $('#timeline');
  const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  /** Sopra le corsie della timeline il file parte dal punto indicato, altrove dalla testina. */
  const overLanes = (e) => {
    const r = tl.getBoundingClientRect();
    return e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left + headWidth() && e.clientX <= r.right;
  };
  // fuori dall'editor il browser non deve aprire il file al posto dell'app
  window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (isFiles(e)) e.preventDefault(); });
  let leaveTimer = null;
  player.addEventListener('dragover', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    clearTimeout(leaveTimer);
    player.classList.add('drop-target');
    const lanes = overLanes(e) && engine.tracks.length;
    tl.classList.toggle('drop-lanes', !!lanes);
    if (lanes) $('#drop-hint').style.left = `${headWidth() + Math.max(0, timeAt(e.clientX)) * state.zoom}px`;
  });
  player.addEventListener('dragleave', () => {
    // dragleave scatta anche passando sopra gli elementi interni: si chiude solo se non riprende
    leaveTimer = setTimeout(() => { player.classList.remove('drop-target'); tl.classList.remove('drop-lanes'); }, 80);
  });
  player.addEventListener('drop', async (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    const start = overLanes(e) && engine.tracks.length ? timeAt(e.clientX) : null;
    player.classList.remove('drop-target');
    tl.classList.remove('drop-lanes');
    await addAudioFiles([...e.dataTransfer.files], start);
  });
  // alternativa al trascinamento: scelta del file
  $('#add-track').addEventListener('click', () => $('#add-track-file').click());
  $('#add-track-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await addAudioFiles(files, null);
  });
  document.addEventListener('keydown', (e) => {
    if (!state.current || e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (e.target.matches('canvas.roll')) return; // il piano roll gestisce i propri tasti
    if (e.code === 'KeyX') { if (splitAtPlayhead()) e.preventDefault(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selClip) { e.preventDefault(); deleteSelectedClip(); }
  });
}
