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
    failed: 'The audio could not be loaded. Try again in a moment.', sections: 'Loops', loop: 'Loop', full: 'Full mix',
    semis: (n) => `${n > 0 ? '+' : ''}${n} semitone${Math.abs(n) === 1 ? '' : 's'}`, speed: (n) => `${n}% speed`,
    made: 'Made with', tagline: 'separated tracks, loops and speed control for practice', saves: 'Saves',
    restart: 'From the start', play: 'Play / pause (space)', loopT: 'Loop (L)', wave: 'Waveform: click to seek',
    tracks: 'Tracks', stemT: (n) => `${n}: click to turn it on or off`, speedL: 'Speed', speedReset: (n) => `Back to ${n}%`,
    parts: { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', guitar: 'Guitar', piano: 'Piano', other: 'Other', rest: 'Rest of the mix' },
  } : {
    preparing: "Preparazione dell'audio…", loading: 'Caricamento', gone: 'Questo link non è più attivo.',
    failed: "Non è stato possibile caricare l'audio. Riprova tra poco.", sections: 'Loop', loop: 'Loop', full: 'Mix completo',
    semis: (n) => `${n > 0 ? '+' : ''}${n} semiton${Math.abs(n) === 1 ? 'o' : 'i'}`, speed: (n) => `velocità ${n}%`,
    made: 'Creato con', tagline: 'tracce separate, loop e velocità per esercitarsi', saves: 'Salvataggi',
    restart: "Dall'inizio", play: 'Play / pausa (spazio)', loopT: 'Ripeti in loop (L)', wave: "Forma d'onda: clic per spostarsi",
    tracks: 'Tracce', stemT: (n) => `${n}: clic per accenderla o spegnerla`, speedL: 'Velocità', speedReset: (n) => `Torna a ${n}%`,
    parts: { vocals: 'Voce', drums: 'Batteria', bass: 'Basso', guitar: 'Chitarra', piano: 'Piano', other: 'Altro', rest: 'Resto del mix' },
  };
  const PART_COLORS = { vocals: '#ff8a95', drums: '#ffd166', bass: '#5fe0a8', guitar: '#6cc4ff', piano: '#c79bff', other: '#b9bcc8', rest: '#8f93a3' };
  $('#sections .sec-label').textContent = L.sections;
  $('#speed-label').textContent = L.speedL;
  if (EN) {
    document.documentElement.lang = 'en';
    $('#loader-text').textContent = L.preparing;
    $('.foot span').innerHTML = `${L.made} <a href="/">Noises</a> · ${L.tagline}`;
    $('#restart').title = L.restart;
    $('#play').title = L.play;
    $('#loop').title = L.loopT;
    $('#wave').setAttribute('aria-label', L.wave);
    $('#variants').setAttribute('aria-label', L.saves);
    $('#stems').setAttribute('aria-label', L.tracks);
  }

  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
  const fmt = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  let info = null, ctx = null;
  let vi = 0, v = null;            // salvataggio scelto
  const cache = new Map();         // indice → Promise<{ bufs, energy }>
  // Un salvataggio è un solo file (il mix) oppure, con i pulsanti delle tracce, un file per traccia
  // separata: suonano insieme, ognuno col suo volume (1 = accesa, 0 = spenta).
  let bufs = [], energy = [];      // audio ed energia (per la forma d'onda) di ogni file
  let buf = null, peaks = null;    // buf: il primo file (tutti hanno la stessa durata)
  const stemOff = new Set();       // tracce spente (vocals, drums…): vale per tutti i salvataggi
  let srcs = [], gains = [];
  // Velocità regolabile: al posto dei lettori del browser suona il motore dell'app (stretch-worklet.js),
  // che cambia la velocità mentre suona senza toccare la tonalità. Solo se il link lo prevede e il
  // browser lo permette (HTTPS); altrimenti la pagina resta quella di sempre, senza il comando.
  const canSpeed = () => !!(info && info.speed) && window.isSecureContext && typeof AudioWorkletNode !== 'undefined';
  let wk = null, wkOn = false;     // motore e stato (sta suonando)
  let rate = 1, speed = 100;       // rate: rispetto al file del mix; speed: % rispetto al brano originale
  let rep = null, repMin = 0;      // ultima posizione comunicata dal motore
  let src = null, playing = false, startedAt = 0, startOffset = 0, pos = 0;
  let loopOn = false, loop = null; // { start, end } in secondi del file
  // loop tra cui scegliere: quello del salvataggio e le sezioni del progetto; activeSec = quello in uso
  let loops = [], activeSec = -1, loadSeq = 0;

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

  const stemsOf = (i) => (info.variants[i] && info.variants[i].stems) || [];

  async function setupWorklet() {
    if (wk || !canSpeed() || !ctx.audioWorklet) return;
    try {
      await ctx.audioWorklet.addModule('/stretch-worklet.js');
      const node = new AudioWorkletNode(ctx, 'stretch-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.connect(ctx.destination);
      node.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'pos') { if (wkOn && m.frame >= repMin) rep = m; }
        else if (m.type === 'ended' && wkOn) { wkOn = false; src = null; playing = false; pos = 0; updatePlayUI(); }
      };
      wk = node;
    } catch (e) { console.warn(e); }
  }

  /** Passa l'audio al motore (una copia per canale, ceduta al motore). */
  function loadWorklet(list) {
    const stems = list.map((b, k) => {
      const l = b.getChannelData(0).slice();
      const r = b.numberOfChannels > 1 ? b.getChannelData(1).slice() : l;
      return { name: `s${k}`, l, r, gain: stemIsOn(k) ? 1 : 0 };
    });
    wkOn = false;
    wk.port.postMessage({ type: 'load', length: list[0].length, stems }, stems.flatMap((s) => (s.r !== s.l ? [s.l.buffer, s.r.buffer] : [s.l.buffer])));
  }

  /** Velocità in % rispetto al brano originale (il file del mix è già a quella del salvataggio). */
  function setSpeed(val) {
    const r = $('#speed-range');
    speed = Math.max(Number(r.min), Math.min(Number(r.max), Math.round(val)));
    r.value = speed;
    $('#speed-val').textContent = `${speed}%`;
    $('#speed-reset').disabled = speed === v.tempo;
    if (!wk) return;
    const p = position(); // con la velocità di prima
    rate = speed / v.tempo;
    wk.port.postMessage({ type: 'rate', rate, pitch: 1 });
    if (playing) { startOffset = p; startedAt = ctx.currentTime; rep = null; repMin = Math.round(ctx.currentTime * ctx.sampleRate); }
  }

  function renderSpeed() {
    $('#speed').classList.toggle('hidden', !wk);
    if (!wk) return;
    const r = $('#speed-range');
    r.min = Math.min(50, v.tempo);
    r.max = Math.max(150, v.tempo);
    $('#speed-reset').title = L.speedReset(v.tempo);
    setSpeed(v.tempo);
  }

  function audioOf(i) {
    if (!cache.has(i)) {
      const p = (async () => {
        const base = `/api/public/${encodeURIComponent(token)}/audio?mix=${i}&v=${info.updated_at}`;
        const urls = stemsOf(i).length ? stemsOf(i).map((_, k) => `${base}&stem=${k}`) : [base];
        // avanzamento: somma di tutti i file
        const prog = urls.map(() => ({ got: 0, total: 0 }));
        const report = () => {
          if (i !== vi) return;
          const got = prog.reduce((a, x) => a + x.got, 0), total = prog.reduce((a, x) => a + x.total, 0);
          if (!total) return;
          $('#loader-text').textContent = `${L.loading}…`;
          $('#progress-fill').style.width = `${Math.min(100, (got / total) * 100)}%`;
        };
        const datas = await Promise.all(urls.map((u, k) => fetchAudio(u, (got, total) => { prog[k] = { got, total }; report(); })));
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        let list = [];
        for (const d of datas) list.push(await new Promise((ok, ko) => ctx.decodeAudioData(d, ok, ko)));
        // stessa durata per tutti: il loop deve chiudersi nello stesso punto in ogni file
        const len = Math.max(...list.map((b) => b.length));
        list = list.map((b) => (b.length === len ? b : padded(b, len)));
        return { bufs: list, energy: list.map((b) => computeEnergy(b, 1400)) };
      })();
      p.catch(() => cache.delete(i)); // al prossimo tentativo si riprova
      cache.set(i, p);
    }
    return cache.get(i);
  }

  function padded(b, len) {
    const out = ctx.createBuffer(b.numberOfChannels, len, b.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) out.copyToChannel(b.getChannelData(c), c);
    return out;
  }

  async function fetchAudio(url, onProgress) {
    // il mix può essere ancora in preparazione: il server risponde quando è pronto
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.statusText);
    const total = Number(r.headers.get('content-length')) || 0;
    if (!r.body || !total) return r.arrayBuffer();
    onProgress(0, total);
    const reader = r.body.getReader();
    const out = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, got);
      got += value.length;
      onProgress(got, total);
    }
    return out.buffer;
  }

  /** Energia media (quadrato del segnale) di un file in `n` punti: le forme d'onda si sommano così. */
  function computeEnergy(b, n) {
    const chans = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
    const len = b.length, step = len / n, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), z = Math.min(len, Math.floor((i + 1) * step));
      let s = 0, cnt = 0;
      for (let j = a; j < z; j += 16) for (const c of chans) { s += c[j] * c[j]; cnt++; }
      out[i] = s / Math.max(1, cnt);
    }
    return out;
  }

  const stemIsOn = (k) => !stemOff.has((v.stems || [])[k]);

  /** Forma d'onda di ciò che si sente: la somma delle tracce accese. */
  function updatePeaks() {
    if (!energy.length) { peaks = null; return; }
    const n = energy[0].length, out = new Float32Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < energy.length; k++) if (stemIsOn(k)) s += energy[k][i];
      out[i] = Math.sqrt(s);
      if (out[i] > max) max = out[i];
    }
    for (let i = 0; i < n; i++) out[i] = max ? Math.pow(out[i] / max, 0.8) : 0;
    peaks = out;
  }

  function renderStems() {
    const keys = v.stems || [];
    const box = $('#stems');
    box.classList.toggle('hidden', !keys.length);
    box.innerHTML = keys.map((key, k) => {
      const name = L.parts[key] || key;
      return `<button class="stem" data-k="${k}" style="--c:${PART_COLORS[key] || '#aaa'}" aria-pressed="${!stemOff.has(key)}" title="${esc(L.stemT(name))}">${esc(name)}</button>`;
    }).join('');
    box.querySelectorAll('.stem').forEach((b) => b.addEventListener('click', () => {
      const k = Number(b.dataset.k), key = keys[k];
      if (stemOff.has(key)) stemOff.delete(key); else stemOff.add(key);
      b.setAttribute('aria-pressed', String(!stemOff.has(key)));
      // dissolvenza breve, per non sentire uno scatto
      if (gains[k]) gains[k].gain.setTargetAtTime(stemOff.has(key) ? 0 : 1, ctx.currentTime, 0.02);
      if (wk) wk.port.postMessage({ type: 'gains', gains: { [`s${k}`]: stemOff.has(key) ? 0 : 1 } });
      updatePeaks();
      draw();
    }));
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
    // le tracce separate occupano molta memoria: si tiene pronto un solo salvataggio che le usa
    if (stemsOf(i).length) for (const j of [...cache.keys()]) if (j !== i && stemsOf(j).length) cache.delete(j);
    renderVariant();
    renderStems();
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
    await setupWorklet();
    if (seq !== loadSeq) return;
    bufs = a.bufs;
    energy = a.energy;
    buf = bufs[0];
    if (wk) {
      loadWorklet(bufs);
      // l'audio ora è nel motore: con le tracce separate (pesanti) non se ne tiene una seconda copia
      buf = { duration: bufs[0].duration };
      bufs = [];
      if (stemsOf(i).length) cache.delete(i);
    }
    renderSpeed();
    updatePeaks();
    $('#dur').textContent = fmt(buf.duration);
    loop = null;
    if (v.selection) {
      loop = { start: Math.max(0, v.selection.start), end: Math.min(buf.duration, v.selection.end) };
      if (!(loop.end - loop.start > 0.05)) loop = null;
    }
    loopOn = !!(loop && v.loop_on);
    // il loop del salvataggio è il primo dell'elenco (o la sezione che gli corrisponde)
    activeSec = loop ? loops.findIndex((r) => Math.abs(r.start - v.selection.start) < 0.05 && Math.abs(r.end - v.selection.end) < 0.05) : -1;
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
    // (non quelli con le tracce separate: troppi file e troppa memoria)
    (async () => { for (let j = 0; j < info.variants.length; j++) if (j !== i && !stemsOf(j).length) await audioOf(j).catch(() => {}); })();
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
    // con un solo salvataggio non c'è niente da scegliere: il suo nome non serve
    const named = vs.length > 1;
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
    // nome del salvataggio come sottotitolo
    $('#subtitle').textContent = v.name && v.name !== title ? v.name : '';
    $('#songs').textContent = (v.songs || []).filter((s) => s !== title).join(' · ');
    const facts = [];
    if (v.selection && v.loop_on) facts.push(`⟳ ${L.loop} ${fmt(v.selection.start)} – ${fmt(v.selection.end)}`);
    if (v.pitch) facts.push(L.semis(v.pitch));
    if (v.tempo && v.tempo !== 100 && !canSpeed()) facts.push(L.speed(v.tempo)); // con il comando della velocità si legge lì
    $('#facts').innerHTML = facts.map((f) => `<span class="fact">${esc(f)}</span>`).join('');
    // loop tra cui scegliere: quello del salvataggio (se non è già una sezione) e le sezioni del progetto;
    // l'elenco compare solo se ce n'è più di uno, oppure se sono sezioni (il salvataggio non ha un loop suo)
    const secs = (v.regions || []).filter((r) => r.end > r.start);
    const own = v.selection && v.selection.end > v.selection.start ? v.selection : null;
    const same = (r) => own && Math.abs(r.start - own.start) < 0.05 && Math.abs(r.end - own.end) < 0.05;
    const regs = own && !secs.some(same) ? [{ name: L.loop, start: own.start, end: own.end }, ...secs] : secs;
    loops = regs;
    $('#sections').classList.toggle('hidden', !(regs.length > 1 || (regs.length === 1 && !own)));
    $('#sec-list').innerHTML = regs.map((r, i) =>
      `<button class="sec" data-i="${i}">${esc(r.name)} <small>${fmt(r.start)}–${fmt(r.end)}</small></button>`).join('');
    document.querySelectorAll('#sec-list .sec').forEach((b) => b.addEventListener('click', () => {
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
    if (wk) {
      const now = ctx.currentTime, sr = ctx.sampleRate;
      let p = rep ? rep.src / sr + Math.max(0, now - rep.frame / sr) * rate : startOffset + Math.max(0, now - startedAt) * rate;
      if (loopOn && loop && p >= loop.end) p = loop.start + ((p - loop.start) % (loop.end - loop.start));
      return Math.max(0, Math.min(p, buf.duration));
    }
    let p = startOffset + Math.max(0, ctx.currentTime - startedAt);
    if (loopOn && loop && startOffset < loop.end && p >= loop.end) {
      p = loop.start + ((p - loop.end) % (loop.end - loop.start));
    }
    return Math.min(p, buf.duration);
  }

  function startSource(from) {
    if (wk) {
      const sr = ctx.sampleRate, at = ctx.currentTime + 0.05;
      wk.port.postMessage({ type: 'loop', loop: loopOn && loop ? { s: Math.round(loop.start * sr), e: Math.round(loop.end * sr) } : null });
      wk.port.postMessage({ type: 'play', at, pos: Math.round(from * sr) });
      startOffset = from;
      startedAt = at;
      rep = null;
      repMin = Math.round(at * sr);
      wkOn = true;
      src = wk;
      return;
    }
    // un lettore per file, avviati nello stesso istante: restano allineati al campione
    srcs = bufs.map((b) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      if (loopOn && loop) {
        s.loop = true;
        s.loopStart = loop.start;
        s.loopEnd = loop.end;
      }
      return s;
    });
    gains = srcs.map((s, k) => {
      const g = ctx.createGain();
      g.gain.value = stemIsOn(k) ? 1 : 0;
      s.connect(g);
      g.connect(ctx.destination);
      return g;
    });
    src = srcs[0];
    const me = src;
    src.onended = () => {
      if (src !== me) return;
      playing = false;
      pos = 0;
      updatePlayUI();
    };
    startOffset = from;
    startedAt = ctx.currentTime;
    const when = srcs.length > 1 ? ctx.currentTime + 0.03 : 0;
    if (when) startedAt = when;
    for (const s of srcs) s.start(when, from);
  }

  function stopSource() {
    if (!src) return;
    if (wk) {
      wk.port.postMessage({ type: 'pause' });
      wkOn = false;
      src = null;
      return;
    }
    const old = srcs, oldGains = gains;
    src = null;
    srcs = [];
    gains = [];
    for (const s of old) { try { s.stop(); } catch {} s.disconnect(); }
    for (const g of oldGains) g.disconnect();
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
    if (loopOn && loop && (t < loop.start || t >= loop.end)) { loopOn = false; updateLoopUI(); }
    if (playing) { stopSource(); startSource(t); } else pos = t;
    draw();
  }

  function toggleLoop() {
    if (!loop) return;
    const p = position();
    loopOn = !loopOn;
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
    document.querySelectorAll('#sec-list .sec').forEach((b) => b.classList.toggle('on', loopOn && Number(b.dataset.i) === activeSec));
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
  $('#speed-range').addEventListener('input', (e) => setSpeed(Number(e.target.value)));
  $('#speed-down').addEventListener('click', () => setSpeed(speed - 5));
  $('#speed-up').addEventListener('click', () => setSpeed(speed + 5));
  $('#speed-reset').addEventListener('click', () => setSpeed(v.tempo));
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
