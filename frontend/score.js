'use strict';
// Spartito (MusicXML generato dal server, mostrato con OpenSheetMusicDisplay) e tablatura (SVG).

const TUNINGS = {
  guitar: { label: 'Chitarra (E A D G B E)', strings: [40, 45, 50, 55, 59, 64], frets: 22 },
  bass4: { label: 'Basso 4 corde (E A D G)', strings: [28, 33, 38, 43], frets: 20 },
  bass5: { label: 'Basso 5 corde (B E A D G)', strings: [23, 28, 33, 38, 43], frets: 20 },
  drop_d: { label: 'Chitarra Drop D (D A D G B E)', strings: [38, 45, 50, 55, 59, 64], frets: 22 },
};
const sc = { stem: null, data: null, osmd: null, seq: 0, mode: 'score', stamps: null, idx: -1, tabBars: null, lastSys: -1 };

function openScore(stem) {
  if (!state.notes) return;
  const sel = $('#score-stem');
  const parts = (state.refSong && state.refSong.stems) || [];
  sel.innerHTML = parts.map((p) => `<option value="${p}">${esc(LABELS[p] || p)}</option>`).join('');
  sel.value = stem;
  setScoreStem(stem, true);
  $('#score-view').classList.remove('hidden');
  document.body.classList.add('score-open');
}

function setScoreStem(stem, resetMode) {
  sc.stem = stem;
  if (resetMode) {
    sc.mode = ['bass', 'guitar', 'other'].includes(stem) ? 'both' : 'score';
    $('#score-tuning').value = stem === 'bass' ? 'bass4' : 'guitar';
  }
  updateScoreControls();
  loadScore();
}

function updateScoreControls() {
  const drums = sc.stem === 'drums';
  if (drums) sc.mode = 'score';
  document.querySelectorAll('#score-mode button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === sc.mode);
    b.disabled = drums && b.dataset.mode !== 'score';
  });
  $('#score-tuning').classList.toggle('hidden', sc.mode === 'score');
  $('#score-osmd').classList.toggle('hidden', sc.mode === 'tab');
  $('#score-tab').classList.toggle('hidden', sc.mode === 'score');
}

function closeScore() {
  $('#score-view').classList.add('hidden');
  document.body.classList.remove('score-open');
  sc.seq++;
}

async function loadScore() {
  const seq = ++sc.seq;
  const song = state.refSong, stem = sc.stem;
  $('#score-status').innerHTML = '<span class="spinner"></span> Generazione dello spartito…';
  $('#score-status').classList.remove('hidden');
  $('#score-osmd').innerHTML = '';
  $('#score-tab').innerHTML = '';
  try {
    const data = await api(`/api/songs/${song.id}/score/${stem}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pitch: engine.pitch, tempo: engine.tempo, key: state.chordKey || null,
        title: song.name, grid_div: Number($('#score-div').value),
      }),
    });
    if (seq !== sc.seq) return;
    sc.data = data;
    const bars = data.events.length ? Math.floor(data.events[data.events.length - 1].o / (data.bar_q || 4)) + 1 : 0;
    $('#score-info').textContent = `${bars} battute · ${(data.time_signature || [4, 4]).join('/')} · ${data.beat_q === 1.5 ? '♩.' : '♩'} = ${Math.round(data.bpm)}`;
    await renderScore(seq);
  } catch (e) {
    if (seq === sc.seq) $('#score-status').textContent = `Errore: ${e.message}`;
  }
}

async function renderScore(seq) {
  const data = sc.data;
  if (!data) return;
  if (sc.mode !== 'tab') {
    $('#score-status').innerHTML = '<span class="spinner"></span> Impaginazione…';
    await new Promise((r) => setTimeout(r, 20));
    const el = $('#score-osmd');
    el.innerHTML = '';
    sc.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(el, {
      backend: 'svg', autoResize: true, drawTitle: true, drawComposer: false, drawCredits: false,
      drawPartNames: false, drawingParameters: 'default',
      cursorsOptions: [{ type: 0, color: '#7c5cff', alpha: 0.45, follow: false }],
    });
    await sc.osmd.load(data.musicxml);
    if (seq !== sc.seq) return;
    sc.osmd.render();
    prepareCursor();
  } else {
    sc.stamps = null;
  }
  if (sc.mode !== 'score') renderTab();
  $('#score-status').classList.add('hidden');
}

// ------------------------------------------------------------------- cursore

/** Posizione nello spartito (in quarti dalla battuta 1) di un istante della timeline. */
function scoreQuarter(pos) {
  const grid = state.notes.grid;
  return (beatPos(pos * engine.tempo / 100 - anc()) - grid.downbeat - sc.data.bar0) * (sc.data.beat_q || 1);
}

/** Elenca le posizioni (in quarti) di tutti i passi del cursore OSMD, una volta sola. */
function prepareCursor() {
  const c = sc.osmd.cursor;
  sc.stamps = [];
  c.reset();
  c.hide();
  let guard = 0;
  while (!c.Iterator.EndReached && guard++ < 20000) {
    sc.stamps.push(c.Iterator.currentTimeStamp.RealValue * 4);
    c.next();
  }
  c.reset();
  c.show();
  sc.idx = 0;
}

function updateScoreCursor(pos) {
  if (!sc.data || $('#score-view').classList.contains('hidden') || !state.notes) return;
  const q = scoreQuarter(pos);
  $('#score-pos').textContent = `${fmt(pos)} · battuta ${Math.max(1, Math.floor(q / (sc.data.bar_q || 4)) + 1)}`;
  $('#score-play').textContent = engine.playing ? '❚❚' : '▶';
  const body = $('.score-body');
  // spartito: ultimo passo del cursore con posizione ≤ q
  if (sc.osmd && sc.stamps && sc.stamps.length && sc.mode !== 'tab') {
    let lo = 0, hi = sc.stamps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sc.stamps[mid] <= q + 1e-3) lo = mid; else hi = mid - 1;
    }
    if (lo !== sc.idx) {
      const c = sc.osmd.cursor;
      if (lo < sc.idx) { c.reset(); sc.idx = 0; }
      while (sc.idx < lo) { c.next(); sc.idx++; }
      // scorre solo se il cursore esce dalla zona centrale
      const el = c.cursorElement;
      if (el && engine.playing) followInView(body, el);
    }
  }
  // tablatura: linea verticale nella posizione esatta
  const line = document.getElementById('tab-cursor');
  if (line && sc.tabBars && sc.mode !== 'score') {
    const barQ = sc.data.bar_q || 4;
    const bar = Math.floor(q / barQ);
    const b = sc.tabBars[bar];
    if (b) {
      const x = b.x + 12 + ((q - bar * barQ) / barQ) * (b.w - 20);
      line.setAttribute('x1', x); line.setAttribute('x2', x);
      line.setAttribute('y1', b.y0 - 6); line.setAttribute('y2', b.y0 + b.h + 6);
      line.style.display = '';
      if (engine.playing && sc.mode === 'tab' && b.sys !== sc.lastSys) {
        sc.lastSys = b.sys;
        followInView(body, line);
      }
    } else {
      line.style.display = 'none';
    }
  }
}

function followInView(container, el) {
  const r = el.getBoundingClientRect(), c = container.getBoundingClientRect();
  if (r.top < c.top + c.height * 0.15 || r.bottom > c.top + c.height * 0.75) {
    container.scrollBy({ top: r.top - c.top - c.height * 0.3, behavior: 'smooth' });
  }
}

// ---------------------------------------------------------------- tablatura

/** Assegna corda/tasto a ogni nota minimizzando gli spostamenti della mano. */
function assignFrets(events, tuning) {
  const { strings, frets } = TUNINGS[tuning];
  const lo = strings[0], hi = strings[strings.length - 1] + frets;
  const fit = (p) => {
    while (p < lo) p += 12;
    while (p > hi) p -= 12;
    return p;
  };
  const options = (p) => strings.map((s, i) => ({ s: i, f: p - s })).filter((o) => o.f >= 0 && o.f <= frets);
  let hand = 3; // posizione media della mano (tasto)
  const held = new Map(); // nota legata → posizione precedente
  return events.map((ev) => {
    const used = new Set();
    const out = [];
    for (const p of ev.c) {
      const pos = held.get(fit(p));
      if (pos) { out.push({ ...pos, tie: true }); used.add(pos.s); }
    }
    const pitches = [...new Set(ev.p.map(fit))].sort((a, b) => b - a).slice(0, strings.length - used.size);
    // ricerca delle combinazioni (corde distinte), limitata
    let best = null;
    const search = (i, acc, usedS) => {
      if (best && best.n > 400) return;
      if (i === pitches.length) {
        const fr = acc.map((a) => a.f).filter((f) => f > 0);
        const span = fr.length ? Math.max(...fr) - Math.min(...fr) : 0;
        const avg = fr.length ? fr.reduce((a, b) => a + b, 0) / fr.length : hand;
        const cost = (span > 4 ? 10 * (span - 4) : span) + Math.abs(avg - hand) * 0.6 + avg * 0.05;
        if (!best || cost < best.cost) best = { cost, acc: [...acc], n: (best ? best.n : 0) + 1 };
        else best.n++;
        return;
      }
      for (const o of options(pitches[i])) {
        if (usedS.has(o.s)) continue;
        usedS.add(o.s);
        acc.push({ ...o, p: pitches[i] });
        search(i + 1, acc, usedS);
        acc.pop();
        usedS.delete(o.s);
      }
    };
    search(0, [], used);
    held.clear();
    for (const o of out) held.set(strings[o.s] + o.f, o);
    if (best) {
      for (const a of best.acc) {
        out.push({ s: a.s, f: a.f });
        held.set(a.p, { s: a.s, f: a.f });
      }
      const fr = best.acc.map((a) => a.f).filter((f) => f > 0);
      if (fr.length) hand = fr.reduce((a, b) => a + b, 0) / fr.length;
    }
    return { o: ev.o, d: ev.d, notes: out };
  });
}

function chordMarks() {
  // posizione (in quarti dello spartito) dei cambi di accordo
  const sheet = state.chords, data = sc.data, grid = state.notes && state.notes.grid;
  if (!sheet || !data || !grid) return [];
  return sheet.chords
    .filter((c) => c.root != null)
    .map((c) => ({ o: (beatPos(c.start) - grid.downbeat - data.bar0) * (data.beat_q || 1), name: chordName(c) }))
    .filter((m) => m.o >= 0);
}

function renderTab() {
  const tuning = $('#score-tuning').value;
  const { strings } = TUNINGS[tuning];
  const events = assignFrets(sc.data.events, tuning);
  const box = $('#score-tab');
  const W = Math.max(600, box.clientWidth - 40);
  const LINE = 13, top = 46, staffH = (strings.length - 1) * LINE;
  const BARQ = sc.data.bar_q || 4, BQ = sc.data.beat_q || 1, BPB = sc.data.beats_per_bar || 4;
  const nBars = events.length ? Math.floor(events[events.length - 1].o / BARQ) + 1 : 1;
  // larghezza di ogni battuta in base al numero di attacchi
  const onsets = new Array(nBars).fill(0);
  for (const e of events) if (e.notes.some((n) => !n.tie)) onsets[Math.floor(e.o / BARQ)]++;
  const barW = onsets.map((n) => Math.max(120, 30 + n * 22));
  const systems = [];
  let cur = [], w = 0;
  barW.forEach((bw, i) => {
    if (cur.length && w + bw > W - 40) { systems.push(cur); cur = []; w = 0; }
    cur.push(i);
    w += bw;
  });
  if (cur.length) systems.push(cur);

  const marks = chordMarks();
  const sysH = top + staffH + 34;
  const names = strings.map((s) => NOTE_NAMES[s % 12].replace('♯', '#'));
  const parts = [];
  const byBar = new Map();
  for (const e of events) {
    const b = Math.floor(e.o / BARQ);
    if (!byBar.has(b)) byBar.set(b, []);
    byBar.get(b).push(e);
  }
  sc.tabBars = [];
  sc.lastSys = -1;
  systems.forEach((bars, si) => {
    const y0 = si * sysH + top;
    const used = bars.reduce((a, b) => a + barW[b], 0);
    const scale = (W - 40) / used; // giustifica il rigo
    let x = 30;
    parts.push(`<g>`);
    strings.forEach((_, i) => {
      const y = y0 + staffH - i * LINE;
      parts.push(`<line x1="30" x2="${W - 10}" y1="${y}" y2="${y}" class="tl"/>`);
      if (si === 0 || true) parts.push(`<text x="18" y="${y + 4}" class="tn">${names[i]}</text>`);
    });
    for (const b of bars) {
      const bw = barW[b] * scale;
      sc.tabBars[b] = { x, w: bw, y0, h: staffH, sys: si };
      parts.push(`<line x1="${x}" x2="${x}" y1="${y0}" y2="${y0 + staffH}" class="bl"/>`);
      parts.push(`<text x="${x + 3}" y="${y0 - 26}" class="bn">${b + 1}</text>`);
      const inner = (o) => x + 12 + ((o - b * BARQ) / BARQ) * (bw - 20);
      // tempi della battuta
      for (let q = 0; q < BPB; q++) parts.push(`<line x1="${inner(b * BARQ + q * BQ)}" x2="${inner(b * BARQ + q * BQ)}" y1="${y0 + staffH + 6}" y2="${y0 + staffH + (q ? 10 : 14)}" class="bt"/>`);
      for (const m of marks) {
        if (m.o >= b * BARQ && m.o < (b + 1) * BARQ) parts.push(`<text x="${inner(m.o)}" y="${y0 - 10}" class="ch">${esc(m.name)}</text>`);
      }
      for (const e of byBar.get(b) || []) {
        const ex = inner(e.o);
        for (const n of e.notes) {
          if (n.tie) continue; // le note legate non si ripetono in tablatura
          const y = y0 + staffH - n.s * LINE;
          const label = n.tie ? `(${n.f})` : `${n.f}`;
          const tw = label.length * 7 + 2;
          parts.push(`<rect x="${ex - tw / 2}" y="${y - 6}" width="${tw}" height="12" class="fb"/>`);
          parts.push(`<text x="${ex}" y="${y + 4}" class="fn${n.tie ? ' tie' : ''}">${label}</text>`);
        }
      }
      x += bw;
    }
    parts.push(`<line x1="${x}" x2="${x}" y1="${y0}" y2="${y0 + staffH}" class="bl"/>`);
    parts.push(`</g>`);
  });
  const H = systems.length * sysH + 10;
  box.innerHTML = `<h2 class="tab-title">${esc(state.refSong.name)} — ${esc(LABELS[sc.stem] || sc.stem)} · ${esc(TUNINGS[tuning].label)}</h2>
    <svg class="tab-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}
      <line id="tab-cursor" class="tab-cursor" x1="0" x2="0" y1="0" y2="0" style="display:none"/></svg>`;
}

function setupScore() {
  const tsel = $('#score-tuning');
  tsel.innerHTML = Object.entries(TUNINGS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#score-stem').addEventListener('change', (e) => setScoreStem(e.target.value, true));
  document.querySelectorAll('#score-mode button').forEach((b) => b.addEventListener('click', () => {
    sc.mode = b.dataset.mode;
    updateScoreControls();
    renderScore(sc.seq);
  }));
  tsel.addEventListener('change', () => sc.data && renderTab());
  $('#score-div').addEventListener('change', loadScore);
  $('#score-close').addEventListener('click', closeScore);
  $('#score-play').addEventListener('click', togglePlay);
  $('#score-print').addEventListener('click', () => window.print());
  $('#score-xml').addEventListener('click', () => {
    if (!sc.data) return;
    downloadBlob(new Blob([sc.data.musicxml], { type: 'application/vnd.recordare.musicxml+xml' }),
      `${state.refSong.name} - ${LABELS[sc.stem] || sc.stem}.musicxml`);
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !$('#score-view').classList.contains('hidden')) closeScore();
  });
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (sc.data && sc.mode !== 'score' && !$('#score-view').classList.contains('hidden')) renderTab(); }, 200);
  });
}
