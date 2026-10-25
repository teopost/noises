'use strict';
// Tracce utente: file audio aggiunti trascinandoli sull'editor o con "+ Traccia audio".
// La modifica delle clip (comune a tutte le tracce) è in editor.js.

const USER_COLOR = '#d9dde6';
const userSaveTimers = {};
const ukid = () => Math.random().toString(36).slice(2, 14);

function userTrackMeta(t) {
  return (state.current.user_tracks || []).find((u) => u.id === t.tid);
}

/** Salva nome e clip di una traccia utente (con un piccolo ritardo per raggruppare le modifiche). */
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

async function decodeToArrays(arrayBuffer) {
  const buf = await engine.ctx.decodeAudioData(arrayBuffer);
  const l = new Float32Array(buf.getChannelData(0));
  const r = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : l;
  return { l, r, peaks: computePeaks(l, r) };
}

/** Scarica e decodifica l'audio di una traccia utente già presente sul server. */
async function fetchUserAudio(song, tid) {
  const r = await fetch(`/api/songs/${song.id}/tracks/${tid}/audio`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return decodeToArrays(await r.arrayBuffer());
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
  const start = +(Math.max(0, startDisplay) / (100 / engine.tempo)).toFixed(3);
  setLoader(`Aggiunta di "${file.name}"…`, '', null);
  try {
    const meta = await uploadTrackFile(song, file, start);
    setLoader(`Aggiunta di "${file.name}"…`, 'decodifica', null);
    let audio;
    try {
      audio = await decodeToArrays(await file.arrayBuffer());
    } catch {
      audio = await fetchUserAudio(song, meta.id); // formato non decodificabile dal browser
    }
    if (state.current !== song) return;
    pushUndo('Aggiungi traccia');
    (song.user_tracks = song.user_tracks || []).push(meta);
    const t = engine.addUserTrack({ name: `user:${meta.id}`, user: true, tid: meta.id, label: meta.name, clips: meta.clips, ...audio });
    selectTracks([t.name]);
    state.selClip = { name: t.name, cid: t.clips[0].id };
    buildTracks();
    saveLayout();
    scrollTrackIntoView(t);
  } catch (e) {
    alert(`Impossibile aggiungere "${file.name}": ${e.message}`);
  } finally {
    setLoader(null);
  }
}

function userRowHtml(t) {
  return `
    <div class="track-head">
      <div class="track-title"><span class="grip" title="Trascina per cambiare l'ordine (Alt+↑/↓)">⠿</span><span class="swatch" style="background:${USER_COLOR}"></span>
        <input class="tname" value="${esc(t.label)}" maxlength="60" title="Nome della traccia (clic per modificare)"></div>
      <div class="track-btns">
        <button class="m" title="Muto">M</button>
        <button class="s" title="Solo">S</button>
        <input type="range" class="vol" min="0" max="1.5" step="0.01" value="${t.volume}" title="Volume">
        <button class="cut" title="Taglia le tracce selezionate nel punto della testina (X)">✂</button>
        <button class="deltrack" title="Elimina la traccia (Ctrl+Z per annullare)">🗑</button>
      </div>
    </div>
    <div class="lane"><canvas class="ucanvas vcanvas"></canvas></div>`;
}

function setupUserRow(t, row) {
  const name = row.querySelector('.tname');
  let renaming = false;
  name.addEventListener('focus', () => { renaming = false; });
  name.addEventListener('input', () => {
    if (!renaming) { pushUndo('Rinomina traccia'); renaming = true; }
    t.label = name.value;
    saveUserTrack(t);
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
  row.querySelector('.cut').addEventListener('click', () => {
    if (!state.selTracks.has(t.name)) selectTrack(t, false);
    splitSelected();
  });
  row.querySelector('.deltrack').addEventListener('click', () => deleteUserTrack(t));
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
  $('#add-track').addEventListener('click', () => $('#add-track-file').click());
  $('#add-track-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await addAudioFiles(files, null);
  });
}
