'use strict';
// Trascinamento nell'editor: brani dalla libreria o file audio dal disco.
// I file dal disco vengono prima caricati nella libreria, poi aggiunti al progetto come brano intero.

const USER_COLOR = '#d9dde6';

async function decodeToArrays(arrayBuffer) {
  const buf = await engine.ctx.decodeAudioData(arrayBuffer);
  const l = new Float32Array(buf.getChannelData(0));
  const r = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : l;
  return { l, r, peaks: computePeaks(l, r) };
}

const AUDIO_RE = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|aiff?|wma|webm|mp4|caf)$/i;

/** File audio dal disco: nella libreria, poi nella timeline da `startDisplay` (null = testina). */
async function addAudioFiles(files, startDisplay) {
  const audio = files.filter((f) => f.type.startsWith('audio/') || AUDIO_RE.test(f.name));
  const rejected = files.filter((f) => !audio.includes(f));
  if (rejected.length) alert(`Non sono file audio: ${rejected.map((f) => f.name).join(', ')}`);
  let at = startDisplay;
  for (const f of audio) {
    try {
      setLoader(`Caricamento di "${f.name}" nella libreria…`, '', null);
      const song = await uploadFile(f);
      await addToCurrentPlaylist(song);
      await refreshSongs();
      await addSongToProject(song.id, at);
      at = null; // i file successivi partono dalla testina
    } catch (e) {
      alert(`Caricamento di "${f.name}" fallito: ${e.message}`);
    } finally {
      setLoader(null);
    }
  }
}

function setupUserTracks() {
  const player = $('#player'), main = $('#main'), tl = $('#timeline');
  const kind = (e) => {
    const types = e.dataTransfer ? [...e.dataTransfer.types] : [];
    if (types.includes('application/x-noises-song')) return 'song';
    if (types.includes('Files')) return 'files';
    return null;
  };
  /** Sopra le corsie della timeline il brano parte dal punto indicato, altrove dalla testina. */
  const overLanes = (e) => {
    const r = tl.getBoundingClientRect();
    return !player.classList.contains('hidden') && e.clientY >= r.top && e.clientY <= r.bottom
      && e.clientX >= r.left + headWidth() && e.clientX <= r.right;
  };
  // fuori dall'editor il browser non deve aprire il file al posto dell'app
  window.addEventListener('dragover', (e) => { if (kind(e) === 'files') e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (kind(e) === 'files') e.preventDefault(); });
  let leaveTimer = null;
  main.addEventListener('dragover', (e) => {
    const k = kind(e);
    if (!k) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    clearTimeout(leaveTimer);
    main.classList.add('drop-target');
    $('#drop-label').textContent = k === 'song'
      ? (state.current ? 'Rilascia per aggiungere il brano al progetto' : 'Rilascia per creare un progetto con questo brano')
      : 'Rilascia: il file va nella libreria e nel progetto';
    const lanes = overLanes(e) && engine.tracks.length;
    tl.classList.toggle('drop-lanes', !!lanes);
    if (lanes) $('#drop-hint').style.left = `${headWidth() + Math.max(0, timeAt(e.clientX)) * state.zoom}px`;
  });
  main.addEventListener('dragleave', () => {
    // dragleave scatta anche passando sopra gli elementi interni: si chiude solo se non riprende
    leaveTimer = setTimeout(() => { main.classList.remove('drop-target'); tl.classList.remove('drop-lanes'); }, 80);
  });
  main.addEventListener('drop', async (e) => {
    const k = kind(e);
    if (!k) return;
    e.preventDefault();
    const start = overLanes(e) && engine.tracks.length ? timeAt(e.clientX) : null;
    main.classList.remove('drop-target');
    tl.classList.remove('drop-lanes');
    if (k === 'song') await addSongToProject(e.dataTransfer.getData('application/x-noises-song'), start);
    else await addAudioFiles([...e.dataTransfer.files], start);
  });
  $('#add-track-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await addAudioFiles(files, null);
  });
}
