'use strict';
// Pagina pubblica di un link condiviso: riproduce il mix già pronto di uno o più salvataggi,
// con loop e sezioni; se il link ne contiene più d'uno si sceglie quale ascoltare.

(() => {
  const $ = (s) => document.querySelector(s);
  // prima lingua preferita tra italiano e inglese (come nell'app, vedi i18n.js)
  const EN = (() => {
    const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    for (const l of list) {
      if (/^it\b/i.test(l)) return false;
      if (/^en\b/i.test(l)) return true;
    }
    return true;
  })();
  const L = EN ? {
    preparing: 'Preparing the audio…', loading: 'Loading', gone: 'This link is no longer active.',
    failed: 'The audio could not be loaded. Try again in a moment.', sections: 'Sections', loop: 'Loop', full: 'Full mix',
    semis: (n) => `${n > 0 ? '+' : ''}${n} semitone${Math.abs(n) === 1 ? '' : 's'}`, speed: (n) => `${n}% speed`,
    made: 'Made with', tagline: 'separated tracks, loops and speed control for practice', saves: 'Saves',
    restart: 'From the start', play: 'Play / pause (space)', loopT: 'Loop (L)', wave: 'Waveform: click to seek',
  } : {
    preparing: "Preparazione dell'audio…", loading: 'Caricamento', gone: 'Questo link non è più attivo.',
    failed: "Non è stato possibile caricare l'audio. Riprova tra poco.", sections: 'Sezioni', loop: 'Loop', full: 'Mix completo',
    semis: (n) => `${n > 0 ? '+' : ''}${n} semiton${Math.abs(n) === 1 ? 'o' : 'i'}`, speed: (n) => `velocità ${n}%`,
    made: 'Creato con', tagline: 'tracce separate, loop e velocità per esercitarsi', saves: 'Salvataggi',
    restart: "Dall'inizio", play: 'Play / pausa (spazio)', loopT: 'Ripeti in loop (L)', wave: "Forma d'onda: clic per spostarsi",
  };
  if (EN) {
    document.documentElement.lang = 'en';
    $('#loader-text').textContent = L.preparing;
    $('.sec-label').textContent = L.sections;
    $('.foot span').innerHTML = `${L.made} <a href="/">Noises</a> · ${L.tagline}`;
    $('#restart').title = L.restart;
    $('#play').title = L.play;
    $('#loop').title = L.loopT;
    $('#wave').setAttribute('aria-label', L.wave);
    $('#variants').setAttribute('aria-label', L.saves);
  }

  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
  const fmt = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  let info = null, ctx = null;
  let vi = 0, v = null;            // salvataggio scelto
  const cache = new Map();         // indice → Promise<{ buf, peaks }>
  let buf = null, peaks = null;
  let src = null, playing = false, startedAt = 0, startOffset = 0, pos = 0;
  let loopOn = false, loop = null; // { start, end } in secondi del file
  let activeSec = -1, loadSeq = 0;

  function fail(msg) {
    $('#loader').classList.add('gone');
    const e = $('#error');
    e.textContent = msg;
    e.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ dati e audio

  async function load() {
    let r;
    try { r = await fetch(`/api/public/${encodeURIComponent(token)}`); } catch { fail(L.failed); return; }
    if (!r.ok) {
      ['#wave-wrap', '.times', '.controls'].forEach((s) => $(s).classList.add('hidden'));
      fail(L.gone);
      return;
    }
    info = await r.json();
    if (!info.variants || !info.variants.length) { fail(L.gone); return; }
    $('#title').textContent = info.title || 'Noises';
    renderVariants();
    await select(0, false);
    setupMediaSession();
  }

  function audioOf(i) {
    if (!cache.has(i)) {
      const p = (async () => {
        const data = await fetchAudio(`/api/public/${encodeURIComponent(token)}/audio?mix=${i}&v=${info.updated_at}`, i);
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        const b = await new Promise((ok, ko) => ctx.decodeAudioData(data, ok, ko));
        return { buf: b, peaks: computePeaks(b, 1400) };
      })();
      p.catch(() => cache.delete(i)); // al prossimo tentativo si riprova
      cache.set(i, p);
    }
    return cache.get(i);
  }

  async function fetchAudio(url, i) {
    // il mix può essere ancora in preparazione: il server risponde quando è pronto
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.statusText);
    const total = Number(r.headers.get('content-length')) || 0;
    if (!r.body || !total) return r.arrayBuffer();
    if (i === vi) $('#loader-text').textContent = `${L.loading}…`;
    const reader = r.body.getReader();
    const out = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, got);
      got += value.length;
      if (i === vi) $('#progress-fill').style.width = `${Math.min(100, (got / total) * 100)}%`;
    }
    return out.buffer;
  }

  function computePeaks(b, n) {
    const chans = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
    const len = b.length, step = len / n, out = new Float32Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), z = Math.min(len, Math.floor((i + 1) * step));
      let s = 0, cnt = 0;
      for (let j = a; j < z; j += 16) for (const c of chans) { s += c[j] * c[j]; cnt++; }
      out[i] = Math.sqrt(s / Math.max(1, cnt));
      if (out[i] > max) max = out[i];
    }
    for (let i = 0; i < n; i++) out[i] = max ? Math.pow(out[i] / max, 0.8) : 0;
    return out;
  }

  /** Passa a un altro salvataggio: stessa posizione se possibile, loop del salvataggio. */
  async function select(i, keepPlaying) {
    const seq = ++loadSeq;
    const wasPlaying = playing;
    const prevPos = position();
    const prevTempo = v ? v.tempo : null;
    if (playing) pause();
    vi = i;
    v = info.variants[i];
    renderVariant();
    document.querySelectorAll('.variant').forEach((b) => {
      const on = Number(b.dataset.i) === i;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    ['#play', '#restart', '#loop'].forEach((s) => { $(s).disabled = true; });
    const ready = cache.has(i);
    if (!ready || !buf) {
      $('#progress-fill').style.width = '0';
      $('#loader-text').textContent = L.preparing;
      $('#loader').classList.remove('gone');
      $('#error').classList.add('hidden');
    }
    markLoading(i, true);
    let a;
    try { a = await audioOf(i); } catch { if (seq === loadSeq) fail(L.failed); markLoading(i, false); return; }
    markLoading(i, false);
    if (seq !== loadSeq) return;
    buf = a.buf;
    peaks = a.peaks;
    $('#dur').textContent = fmt(buf.duration);
    loop = null;
    if (v.selection) {
      loop = { start: Math.max(0, v.selection.start), end: Math.min(buf.duration, v.selection.end) };
      if (!(loop.end - loop.start > 0.05)) loop = null;
    }
    loopOn = !!(loop && v.loop_on);
    activeSec = -1;
    // stessa posizione nel brano anche se la velocità è diversa
    let p = prevTempo ? prevPos * (prevTempo / v.tempo) : 0;
    if (loopOn && (p < loop.start || p >= loop.end)) p = loop.start;
    pos = Math.max(0, Math.min(buf.duration - 0.05, p));
    $('#loader').classList.add('gone');
    ['#play', '#restart'].forEach((s) => { $(s).disabled = false; });
    $('#loop').disabled = !loop;
    updateLoopUI();
    if (wasPlaying && keepPlaying) play();
    else draw();
    // gli altri salvataggi si caricano in sottofondo, così il cambio è immediato
    (async () => { for (let j = 0; j < info.variants.length; j++) if (j !== i) await audioOf(j).catch(() => {}); })();
  }

  function markLoading(i, on) {
    const b = document.querySelector(`.variant[data-i="${i}"]`);
    if (!b) return;
    const sp = b.querySelector('.spin');
    if (on && !sp && !cache.has(i)) b.insertAdjacentHTML('beforeend', '<span class="spin" aria-hidden="true"></span>');
    if (!on && sp) sp.remove();
  }

  function renderVariants() {
    const vs = info.variants;
    const box = $('#variants');
    // con un solo salvataggio resta visibile il suo nome (senza scelta)
    const named = vs.length > 1 || !!vs[0].name;
    box.classList.toggle('hidden', !named);
    box.classList.toggle('single', vs.length === 1);
    if (!named) return;
    box.innerHTML = vs.map((x, i) =>
      `<button class="variant" role="tab" data-i="${i}" aria-selected="false">${esc(x.name || L.full)}</button>`).join('');
    box.querySelectorAll('.variant').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      if (i !== vi) select(i, true);
    }));
  }

  function renderVariant() {
    const title = info.title || 'Noises';
    document.title = `${v.name ? `${title} · ${v.name}` : title} — Noises`;
    $('#songs').textContent = (v.songs || []).filter((s) => s !== title).join(' · ');
    const facts = [];
    if (v.selection && v.loop_on) facts.push(`⟳ ${L.loop} ${fmt(v.selection.start)} – ${fmt(v.selection.end)}`);
    if (v.pitch) facts.push(L.semis(v.pitch));
    if (v.tempo && v.tempo !== 100) facts.push(L.speed(v.tempo));
    $('#facts').innerHTML = facts.map((f) => `<span class="fact">${esc(f)}</span>`).join('');
    const regs = (v.regions || []).filter((r) => r.end > r.start);
    $('#sections').classList.toggle('hidden', !regs.length);
    $('#sec-list').innerHTML = regs.map((r, i) =>
      `<button class="sec" data-i="${i}">${esc(r.name)} <small>${fmt(r.start)}–${fmt(r.end)}</small></button>`).join('');
    document.querySelectorAll('.sec').forEach((b) => b.addEventListener('click', () => {
      if (!buf) return;
      const r = regs[Number(b.dataset.i)];
      loop = { start: r.start, end: Math.min(buf.duration, r.end) };
      loopOn = true;
      activeSec = Number(b.dataset.i);
      $('#loop').disabled = false;
      seek(loop.start);
      if (!playing) play();
      updateLoopUI();
    }));
  }

  // ------------------------------------------------------------------ riproduzione

  function position() {
    if (!playing) return pos;
    let p = startOffset + (ctx.currentTime - startedAt);
    if (loopOn && loop && startOffset < loop.end && p >= loop.end) {
      p = loop.start + ((p - loop.end) % (loop.end - loop.start));
    }
    return Math.min(p, buf.duration);
  }

  function startSource(from) {
    src = ctx.createBufferSource();
    src.buffer = buf;
    if (loopOn && loop) {
      src.loop = true;
      src.loopStart = loop.start;
      src.loopEnd = loop.end;
    }
    src.connect(ctx.destination);
    const me = src;
    src.onended = () => {
      if (src !== me) return;
      playing = false;
      pos = 0;
      updatePlayUI();
    };
    startOffset = from;
    startedAt = ctx.currentTime;
    src.start(0, from);
  }

  function stopSource() {
    if (!src) return;
    const s = src;
    src = null;
    try { s.stop(); } catch {}
    s.disconnect();
  }

  function play() {
    if (!buf) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (loopOn && loop && (pos < loop.start || pos >= loop.end)) pos = loop.start;
    if (pos >= buf.duration - 0.05) pos = 0;
    startSource(pos);
    playing = true;
    updatePlayUI();
    tick();
  }

  function pause() {
    pos = position();
    stopSource();
    playing = false;
    updatePlayUI();
  }

  function seek(t) {
    t = Math.max(0, Math.min(buf.duration - 0.01, t));
    // spostandosi fuori dal loop lo si lascia
    if (loopOn && loop && (t < loop.start || t >= loop.end)) { loopOn = false; activeSec = -1; updateLoopUI(); }
    if (playing) { stopSource(); startSource(t); } else pos = t;
    draw();
  }

  function toggleLoop() {
    if (!loop) return;
    const p = position();
    loopOn = !loopOn;
    if (!loopOn) activeSec = -1;
    if (playing) {
      stopSource();
      startSource(loopOn && (p < loop.start || p >= loop.end) ? loop.start : p);
    } else if (loopOn) {
      pos = loop.start;
    }
    updateLoopUI();
  }

  function updatePlayUI() {
    $('#play').classList.toggle('playing', playing);
    $('#play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    draw();
  }

  function updateLoopUI() {
    $('#loop').setAttribute('aria-pressed', String(loopOn));
    document.querySelectorAll('.sec').forEach((b) => b.classList.toggle('on', loopOn && Number(b.dataset.i) === activeSec));
    draw();
  }

  function tick() {
    draw();
    if (playing) requestAnimationFrame(tick);
  }

  function setupMediaSession() {
    if (!navigator.mediaSession) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: info.title, artist: (v && v.name) || 'Noises', album: 'Noises' });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', pause);
    } catch {}
  }

  // ------------------------------------------------------------------ disegno

  function draw() {
    const c = $('#wave');
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    if (!peaks || !buf) return;
    const dur = buf.duration, p = position();
    $('#pos').textContent = fmt(p);
    const X = (t) => (t / dur) * w;

    // porzione in loop
    if (loop) {
      const x0 = X(loop.start), x1 = X(loop.end);
      g.fillStyle = loopOn ? '#2bd47d1f' : '#ffffff08';
      roundRect(g, x0, 0, Math.max(2, x1 - x0), h, 10 * dpr);
      g.fill();
      g.fillStyle = loopOn ? '#2bd47d' : '#ffffff40';
      g.fillRect(x0, 0, 2 * dpr, h);
      g.fillRect(x1 - 2 * dpr, 0, 2 * dpr, h);
    }

    // barre della forma d'onda (simmetriche, arrotondate)
    const bw = 3 * dpr, gap = 2 * dpr, n = Math.floor(w / (bw + gap)), mid = h / 2;
    const played = X(p);
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#9c84ff');
    grad.addColorStop(1, '#5fe0a8');
    for (let i = 0; i < n; i++) {
      const x = i * (bw + gap);
      const a = Math.floor((i / n) * peaks.length), z = Math.max(a + 1, Math.floor(((i + 1) / n) * peaks.length));
      let val = 0;
      for (let j = a; j < z; j++) if (peaks[j] > val) val = peaks[j];
      const bh = Math.max(2 * dpr, val * (h * 0.86));
      g.fillStyle = x + bw <= played ? grad : '#ffffff2e';
      roundRect(g, x, mid - bh / 2, bw, bh, bw / 2);
      g.fill();
    }

    // segnalibri
    g.fillStyle = '#f5c542b0';
    for (const m of (v && v.markers) || []) {
      const x = X(m.start);
      if (x >= 0 && x <= w) { g.beginPath(); g.arc(x, 4 * dpr, 2.5 * dpr, 0, Math.PI * 2); g.fill(); }
    }

    // testina
    g.fillStyle = '#fff';
    g.shadowColor = '#ffffffaa';
    g.shadowBlur = 10 * dpr;
    g.fillRect(Math.round(played) - dpr, 0, 2 * dpr, h);
    g.shadowBlur = 0;
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ------------------------------------------------------------------ comandi

  $('#play').addEventListener('click', () => (playing ? pause() : play()));
  $('#restart').addEventListener('click', () => seek(loopOn && loop ? loop.start : 0));
  $('#loop').addEventListener('click', toggleLoop);
  let dragging = false;
  const seekAt = (e) => {
    if (!buf) return;
    const r = $('#wave').getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * buf.duration);
  };
  $('#wave').addEventListener('pointerdown', (e) => { dragging = true; $('#wave').setPointerCapture(e.pointerId); seekAt(e); });
  $('#wave').addEventListener('pointermove', (e) => { if (dragging) seekAt(e); });
  ['pointerup', 'pointercancel'].forEach((ev) => $('#wave').addEventListener(ev, () => { dragging = false; }));
  document.addEventListener('keydown', (e) => {
    if (!buf || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.code === 'KeyL') toggleLoop();
    else if (e.code === 'ArrowLeft') seek(position() - 5);
    else if (e.code === 'ArrowRight') seek(position() + 5);
    else if (/^Digit[1-9]$/.test(e.code) && info && info.variants.length > 1) {
      const i = Number(e.code.slice(5)) - 1;
      if (i < info.variants.length && i !== vi) select(i, true);
    }
  });
  window.addEventListener('resize', draw);

  load();
})();
