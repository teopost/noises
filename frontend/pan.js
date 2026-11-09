'use strict';
// Pan (posizione sinistra/destra) di tracce e gruppi, e divisione di una traccia stereo nei suoi
// due canali (due tracce legate in un gruppo, ognuna con il suo volume, pan, effetti e linea).
//
// Il motore (stretch-worklet.js) e l'esportazione (ffmpeg `pan`) ricevono la stessa matrice 2×2
// calcolata qui: [daSx→Sx, daDx→Sx, daSx→Dx, daDx→Dx].
//  - traccia stereo: il pan è un bilanciamento (al centro la traccia resta com'è);
//  - traccia di un solo canale (S o D): pan a potenza costante (al centro −3 dB per lato,
//    tutto a sinistra o a destra il canale esce intero da quel lato);
//  - il pan del gruppo è un bilanciamento applicato dopo quello della traccia.

const PAN_ID = [1, 0, 0, 1];

const clampPan = (p) => (Number.isFinite(Number(p)) ? Math.max(-1, Math.min(1, Number(p))) : 0);

/** Matrice di una traccia: `ch` 'L' / 'R' / null, `pan` della traccia, `gpan` del gruppo. */
function panMatrix(ch, pan, gpan) {
  const p = clampPan(pan), g = clampPan(gpan);
  let m;
  if (ch === 'L' || ch === 'R') {
    const th = ((p + 1) * Math.PI) / 4;
    const l = Math.cos(th), r = Math.sin(th);
    m = ch === 'L' ? [l, 0, r, 0] : [0, l, 0, r];
  } else {
    m = [p > 0 ? 1 - p : 1, 0, 0, p < 0 ? 1 + p : 1];
  }
  const gl = g > 0 ? 1 - g : 1, gr = g < 0 ? 1 + g : 1;
  return [m[0] * gl, m[1] * gl, m[2] * gr, m[3] * gr].map((x) => Math.round(x * 1e6) / 1e6);
}

/** Testo del pan: "centro", "30% a sinistra"… */
function panLabel(p) {
  p = clampPan(p);
  if (Math.abs(p) < 0.005) return T('centro');
  const n = Math.round(Math.abs(p) * 100);
  return p < 0 ? tr(`${n}% a sinistra`) : tr(`${n}% a destra`);
}

/** Cambia il canale di una traccia (anche la forma d'onda mostrata). */
function setTrackCh(t, ch) {
  t.ch = ch === 'L' || ch === 'R' ? ch : null;
  if (t.peakSet) t.peaks = t.peakSet[t.ch || 'S'];
}

/** Controllo del pan (cursore piccolo): doppio clic per tornare al centro. */
function panControl(get, set, title) {
  const el = document.createElement('input');
  el.type = 'range';
  el.className = 'pan';
  el.min = '-1'; el.max = '1'; el.step = '0.01';
  el.value = String(get());
  const upd = () => { el.title = `${title}: ${panLabel(get())} — doppio clic per il centro`; el.style.setProperty('--p', String(get())); };
  el.addEventListener('input', () => {
    let v = Number(el.value);
    if (Math.abs(v) < 0.04) v = 0; // il centro "aggancia"
    set(v);
    upd();
  });
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); el.value = '0'; set(0); upd(); });
  upd();
  return el;
}

/** Traccia gemella (l'altro canale dello stesso audio). */
function lrPartner(t) {
  if (!t.ch) return null;
  const want = t.ch === 'L' ? 'R' : 'L';
  const g = groupOf(t.name);
  const same = (x) => x !== t && x.ch === want && x.song === t.song && x.part === t.part;
  return (g && engine.tracks.find((x) => same(x) && g.tracks.includes(x.name))) || engine.tracks.find(same) || null;
}

/** Divide una traccia stereo in due tracce (sinistro e destro) legate in un gruppo. */
async function splitStereo(t) {
  if (t.ch || isEmptyTrack(t)) return;
  setLoader(`Divisione di "${trackTitle(t)}"…`, '', null);
  try {
    const r = await fetch(sourceUrl(t.song, t.part));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const audio = await decodeToArrays(await r.arrayBuffer());
    if (!engine.tracks.includes(t)) return;
    pushUndo('Dividi sinistro/destro');
    const base = t.label || trackTitle(t);
    const right = engine.addTrack({
      name: newTrackName(), song: t.song, part: t.part, rec: t.rec, ch: 'R', label: `${base} · D`,
      fx: t.fx ? { ...t.fx } : null, env: t.env ? t.env.map((p) => ({ ...p })) : null,
      clips: t.clips.map((c) => ({ ...c, id: newClipId() })), ...audio,
    });
    engine.tracks.splice(engine.tracks.indexOf(right), 1);
    engine.tracks.splice(engine.tracks.indexOf(t) + 1, 0, right);
    Object.assign(right, { muted: t.muted, solo: t.solo, volume: t.volume, pan: 1 });
    setTrackCh(t, 'L');
    t.pan = -1;
    t.label = `${base} · S`;
    // le due metà stanno in un gruppo: si spostano e si tagliano insieme
    const g = groupOf(t.name);
    if (g) {
      g.tracks.splice(g.tracks.indexOf(t.name) + 1, 0, right.name);
    } else {
      state.groups.push({ id: `g${newClipId()}`, name: base, tracks: [t.name, right.name], anchored: false,
        folder: true, collapsed: false, muted: false, solo: false, volume: 1, pan: 0, lr: true });
    }
    engine.updateGains();
    selectTracks([t.name, right.name]);
    saveProject();
    buildTracks();
    toast('Traccia divisa in sinistro (S) e destro (D): regola il pan di ognuna — Ctrl+Z per annullare');
  } catch (e) {
    uiAlert(`Divisione non riuscita: ${e.message}`);
  } finally {
    setLoader(null);
  }
}

/** Riunisce le due metà in una traccia stereo (tiene la sinistra, con pan al centro). */
function joinStereo(t) {
  const other = lrPartner(t);
  const keep = t.ch === 'L' ? t : other || t;
  const drop = keep === t ? other : t;
  pushUndo('Riunisci in stereo');
  const g = groupOf(keep.name);
  if (drop) {
    engine.removeTrack(drop);
    state.selTracks.delete(drop.name);
  }
  setTrackCh(keep, null);
  keep.pan = 0;
  keep.label = (keep.label || '').replace(/ · [SD]$/, '');
  if (g && g.lr) state.groups = state.groups.filter((x) => x !== g); // gruppo creato dalla divisione
  cleanGroups();
  engine.updateGains();
  saveProject();
  buildTracks();
  toast('Canali riuniti in una traccia stereo');
}
