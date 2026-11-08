'use strict';
// Linea del volume (automazione) di tracce e gruppi: punti { t: secondi alla velocità originale,
// v: dB } uniti da rampe lineari in dB; prima del primo punto e dopo l'ultimo il valore resta
// costante. È relativa al cursore del volume (volume effettivo = cursore × linea) e la linea di un
// gruppo si somma a quella delle sue tracce. Il calcolo audio è nel motore (stretch-worklet.js) e
// nel backend (env.rs) con la stessa formula.

const ENV_MIN = -60;  // dB: a questo valore (o sotto) la traccia è muta
const ENV_MAX = 6;
const ENV_HIT = 7;    // px: distanza per prendere un punto
const ENV_COLOR = '#ffd166';

const envUi = { mode: false, sel: null, drag: null };

const envGainOfDb = (v) => (v <= ENV_MIN ? 0 : Math.pow(10, v / 20));

/** Valore (dB) della linea al tempo `t`. */
function envValueAt(env, t) {
  if (!env || !env.length) return 0;
  if (t <= env[0].t) return env[0].v;
  const n = env.length;
  if (t >= env[n - 1].t) return env[n - 1].v;
  let i = 0;
  while (i < n - 2 && env[i + 1].t <= t) i++;
  const a = env[i], b = env[i + 1];
  return a.v + ((t - a.t) / (b.t - a.t)) * (b.v - a.v);
}

/** Guadagno complessivo di una traccia al tempo `t` (sua linea × linea del gruppo). */
function trackEnvGain(t, time) {
  const f = folderOf(t.name);
  let g = 1;
  if (t.env) g *= envGainOfDb(envValueAt(t.env, time));
  if (f && f.env) g *= envGainOfDb(envValueAt(f.env, time));
  return g;
}

/** Linea valida (ordinata, nei limiti) oppure null. */
function normEnv(env) {
  if (!Array.isArray(env)) return null;
  const out = env
    .filter((p) => p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.v)))
    .map((p) => ({ t: Math.max(0, Math.round(Number(p.t) * 1000) / 1000), v: Math.min(ENV_MAX, Math.max(ENV_MIN, Math.round(Number(p.v) * 10) / 10)) }))
    .sort((a, b) => a.t - b.t)
    .slice(0, 2000);
  return out.length ? out : null;
}

// posizione verticale: scala come un fader (radice dell'ampiezza), +6 dB in alto, silenzio in basso
const envU = (v) => (v <= ENV_MIN ? 0 : Math.sqrt(envGainOfDb(v) / 2));
const envVofU = (u) => {
  const g = 2 * Math.max(0, Math.min(1, u)) ** 2;
  return g <= 0.001 ? ENV_MIN : Math.min(ENV_MAX, Math.max(ENV_MIN, 20 * Math.log10(g)));
};
const ENV_PAD = 5;
const envY = (v, h) => ENV_PAD + (1 - envU(v)) * (h - 2 * ENV_PAD);
const envUofY = (y, h) => 1 - (y - ENV_PAD) / (h - 2 * ENV_PAD);
const envFmt = (v) => (v <= ENV_MIN ? T('muto') : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`);

/** Linea della riga: traccia o gruppo. */
function envOwnerOf(canvas) {
  const g = state.groups.find((x) => x.folder && x._canvas === canvas);
  if (g) return { group: g, get: () => g.env || null, set: (e) => { g.env = e; } };
  const t = engine.tracks.find((x) => x.canvas === canvas);
  if (t) return { track: t, get: () => t.env || null, set: (e) => { t.env = e; } };
  return null;
}

/** Disegna la linea sopra la forma d'onda (in modalità volume con i punti). */
function drawEnvelope(ctx, w, h, dpr, env, selected) {
  if (!envUi.mode && !env) return;
  const sl = tlEl().scrollLeft, z = state.zoom, k = ek();
  const X = (t) => (t * k * z - sl) * dpr;
  const H = h / dpr;
  ctx.save();
  ctx.strokeStyle = ENV_COLOR;
  ctx.lineWidth = (envUi.mode ? 2 : 1.5) * dpr;
  ctx.globalAlpha = envUi.mode ? 1 : 0.55;
  if (!env) ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.beginPath();
  const pts = env || [{ t: 0, v: 0 }];
  ctx.moveTo(0, envY(pts[0].v, H) * dpr);
  for (const p of pts) ctx.lineTo(Math.max(-10, Math.min(w + 10, X(p.t))), envY(p.v, H) * dpr);
  ctx.lineTo(w, envY(pts[pts.length - 1].v, H) * dpr);
  ctx.stroke();
  if (envUi.mode && env) {
    ctx.setLineDash([]);
    env.forEach((p, i) => {
      const x = X(p.t);
      if (x < -10 || x > w + 10) return;
      ctx.beginPath();
      ctx.arc(x, envY(p.v, H) * dpr, (selected === i ? 5 : 4) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = selected === i ? '#fff' : ENV_COLOR;
      ctx.fill();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#0f1115';
      ctx.stroke();
    });
  }
  ctx.restore();
}

/** Indice del punto selezionato se appartiene a questa linea. */
function envSelectedIn(owner) {
  const s = envUi.sel;
  if (!s) return -1;
  if (owner.group ? s.group !== owner.group : s.track !== owner.track) return -1;
  return s.i;
}

function envChanged() {
  engine.syncEnvs();
  requestRedraw();
}

function setEnvMode(on) {
  envUi.mode = on;
  envUi.sel = null;
  document.body.classList.toggle('env-mode', on);
  const b = $('#env-btn');
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  hideEnvTip();
  requestRedraw();
}

function showEnvTip(clientX, clientY, t, v) {
  const tip = $('#env-tip');
  if (!tip) return;
  tip.textContent = `${fmt(t * ek())} · ${envFmt(v)}`;
  tip.classList.remove('hidden');
  const z = uiZoom();
  tip.style.left = `${clientX / z + 12}px`;
  tip.style.top = `${clientY / z - 28}px`;
}
function hideEnvTip() { const tip = $('#env-tip'); if (tip) tip.classList.add('hidden'); }

/** Gesti sulla riga in modalità volume. Agganciato in fase di cattura: ha la precedenza sui pezzi. */
function setupEnvCanvas(canvas) {
  const local = (e) => {
    const r = canvas.getBoundingClientRect(), z = uiZoom();
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z, h: r.height / z };
  };
  const xOf = (t) => t * ek() * state.zoom - tlEl().scrollLeft;
  const hit = (owner, e) => {
    const env = owner.get();
    const { x, y, h } = local(e);
    if (env) {
      let best = -1, bd = ENV_HIT;
      env.forEach((p, i) => { const d = Math.hypot(xOf(p.t) - x, envY(p.v, h) - y); if (d <= bd) { bd = d; best = i; } });
      if (best >= 0) return { node: best };
    }
    const t = timeAt(e.clientX) / ek();
    if (Math.abs(envY(envValueAt(env, t), h) - y) <= 6) return { line: true, t };
    return { t };
  };

  canvas.addEventListener('pointermove', (e) => {
    if (!envUi.mode || envUi.drag) return;
    const owner = envOwnerOf(canvas);
    if (!owner) return;
    const h = hit(owner, e);
    canvas.style.cursor = h.node != null ? 'move' : h.line && owner.get() ? 'ns-resize' : 'copy';
    if (h.node != null) { const p = owner.get()[h.node]; showEnvTip(e.clientX, e.clientY, p.t, p.v); } else hideEnvTip();
  }, true);
  canvas.addEventListener('pointerleave', () => { if (!envUi.drag) hideEnvTip(); });

  canvas.addEventListener('pointerdown', (e) => {
    if (!envUi.mode || e.button !== 0) return;
    const owner = envOwnerOf(canvas);
    if (!owner) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const h = hit(owner, e);
    let env = owner.get() ? owner.get().map((p) => ({ ...p })) : [];
    const { y, h: H } = local(e);
    let drag;
    if (h.node != null) {
      drag = { kind: 'node', i: h.node };
    } else if (h.line && env.length) {
      // tratto tra due punti: si alza o abbassa tutto (prima del primo / dopo l'ultimo: quel punto)
      let i = env.findIndex((p) => p.t > h.t);
      const idx = i < 0 ? [env.length - 1] : i === 0 ? [0] : [i - 1, i];
      drag = { kind: 'segment', idx };
    } else {
      // nuovo punto dove si clicca
      pushUndo('Linea del volume');
      const p = { t: Math.max(0, h.t), v: Math.round(envVofU(envUofY(y, H)) * 10) / 10 };
      env.push(p);
      env.sort((a, b) => a.t - b.t);
      owner.set(env);
      drag = { kind: 'node', i: env.indexOf(p), undone: true, moved: true };
      envChanged();
    }
    envUi.sel = { track: owner.track, group: owner.group, i: drag.kind === 'node' ? drag.i : null };
    envUi.drag = { ...drag, owner, y0: y, u0: envUofY(y, H), orig: (owner.get() || []).map((p) => ({ ...p })), x0: e.clientX };
    canvas.setPointerCapture(e.pointerId);
    requestRedraw();
  }, true);

  canvas.addEventListener('pointermove', (e) => {
    const d = envUi.drag;
    if (!d) return;
    e.stopImmediatePropagation();
    const { y, h: H } = local(e);
    if (!d.moved && Math.abs(y - d.y0) < 2 && Math.abs(e.clientX - d.x0) < 2) return;
    if (!d.undone) { pushUndo('Linea del volume'); d.undone = true; }
    d.moved = true;
    const env = d.orig.map((p) => ({ ...p }));
    if (d.kind === 'node') {
      const p = env[d.i];
      if (!e.shiftKey) { // Shift: solo in verticale
        let t = timeAt(e.clientX) / ek();
        if (e.ctrlKey || e.metaKey) t = snapEdit(t, false);
        const lo = d.i > 0 ? env[d.i - 1].t + 0.001 : 0;
        const hi = d.i < env.length - 1 ? env[d.i + 1].t - 0.001 : Infinity;
        p.t = Math.round(Math.min(hi, Math.max(lo, t)) * 1000) / 1000;
      }
      p.v = Math.round(envVofU(envUofY(y, H)) * 10) / 10;
      showEnvTip(e.clientX, e.clientY, p.t, p.v);
    } else {
      const du = envUofY(y, H) - d.u0;
      for (const i of d.idx) env[i].v = Math.round(envVofU(envU(d.orig[i].v) + du) * 10) / 10;
      const p = env[d.idx[0]];
      showEnvTip(e.clientX, e.clientY, timeAt(e.clientX) / ek(), p.v);
    }
    d.owner.set(env);
    envChanged();
  }, true);

  const end = (e) => {
    const d = envUi.drag;
    if (!d) return;
    e.stopImmediatePropagation();
    envUi.drag = null;
    hideEnvTip();
    if (d.moved) { d.owner.set(normEnv(d.owner.get())); envChanged(); saveProject(); }
  };
  canvas.addEventListener('pointerup', end, true);
  canvas.addEventListener('pointercancel', end, true);

  // doppio clic su un punto: lo toglie
  canvas.addEventListener('dblclick', (e) => {
    if (!envUi.mode) return;
    const owner = envOwnerOf(canvas);
    if (!owner) return;
    e.stopImmediatePropagation();
    const h = hit(owner, e);
    if (h.node == null) return;
    deleteEnvNode(owner, h.node);
  }, true);
}

function deleteEnvNode(owner, i) {
  const env = owner.get();
  if (!env || !env[i]) return;
  pushUndo('Linea del volume');
  owner.set(normEnv(env.filter((_, j) => j !== i)));
  envUi.sel = null;
  envChanged();
  saveProject();
}

/** Canc in modalità volume: toglie il punto selezionato. true se l'ha gestito. */
function envDeleteSelected() {
  const s = envUi.sel;
  if (!envUi.mode || !s || s.i == null) return false;
  const owner = s.group ? { group: s.group, get: () => s.group.env || null, set: (e) => { s.group.env = e; } }
    : { track: s.track, get: () => s.track.env || null, set: (e) => { s.track.env = e; } };
  deleteEnvNode(owner, s.i);
  return true;
}

/** Abbassa di 10 dB la porzione selezionata, con brevi rampe ai bordi. */
function lowerSelection(owner) {
  if (!state.sel || state.sel.end - state.sel.start < 0.05) { toast('Seleziona prima una porzione della timeline'); return; }
  const s = state.sel.start / ek(), e = state.sel.end / ek();
  const ramp = Math.min(0.15, (e - s) / 4);
  const env = owner.get() || [];
  const a = Math.max(0, s - ramp), b = e + ramp;
  const va = envValueAt(env, a), vb = envValueAt(env, b);
  const vs = Math.max(ENV_MIN, envValueAt(env, s) - 10), ve = Math.max(ENV_MIN, envValueAt(env, e) - 10);
  pushUndo('Abbassa il volume nella selezione');
  const keep = env.filter((p) => p.t < a - 0.0005 || p.t > b + 0.0005);
  const added = s - a > 0.0005 ? [{ t: a, v: va }, { t: s, v: vs }] : [{ t: s, v: vs }];
  owner.set(normEnv([...keep, ...added, { t: e, v: ve }, { t: b, v: vb }]));
  envChanged();
  saveProject();
  if (!envUi.mode) setEnvMode(true);
  toast('Volume abbassato di 10 dB nella selezione: trascina la linea per regolarlo');
}

function clearEnvelope(owner) {
  if (!owner.get()) return;
  pushUndo('Cancella la linea del volume');
  owner.set(null);
  envUi.sel = null;
  envChanged();
  saveProject();
}

/** Voci per il menu ⋯ di una traccia o di un gruppo. */
function envMenuItems(owner) {
  const has = !!owner.get();
  return [
    { icon: '📈', label: envUi.mode ? 'Chiudi la linea del volume (V)' : 'Linea del volume (V)', run: () => setEnvMode(!envUi.mode) },
    { icon: '↘', label: 'Abbassa il volume nella selezione', disabled: !state.sel || state.sel.end - state.sel.start < 0.05, run: () => lowerSelection(owner) },
    { icon: '⌫', label: 'Cancella la linea del volume', disabled: !has, run: () => clearEnvelope(owner) },
  ];
}
