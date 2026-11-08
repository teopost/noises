'use strict';
// Effetti per traccia: equalizzatore, definizione (exciter), compressore e mandata al riverbero.
// L'elaborazione audio è in fx-worklet.js (ascolto) e nel backend (esportazione e link condivisi);
// qui ci sono i valori salvati nel progetto, i preset e il pannello.

const FX_SLOTS = 16; // tracce con effetti contemporaneamente (uscite del motore)

const FX_DEFAULT = { on: true, lowcut: 0, low: 0, mid: 0, midf: 1000, high: 0, exc: 0, excf: 2000, comp: 0, att: 10, rev: 0 };

const clampNum = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);

/** Effetti validi (stessi limiti del server) oppure null se la traccia non ne ha. */
function normFx(fx) {
  if (!fx || typeof fx !== 'object') return null;
  const lowcut = clampNum(fx.lowcut, 0, 400, 0);
  return {
    on: fx.on !== false,
    lowcut: lowcut < 20 ? 0 : lowcut,
    low: clampNum(fx.low, -12, 12, 0),
    mid: clampNum(fx.mid, -12, 12, 0),
    midf: clampNum(fx.midf, 150, 6000, 1000),
    high: clampNum(fx.high, -12, 12, 0),
    exc: clampNum(fx.exc, 0, 1, 0),
    excf: clampNum(fx.excf, 500, 8000, 2000),
    comp: clampNum(fx.comp, 0, 1, 0),
    att: clampNum(fx.att, 1, 50, 10),
    rev: clampNum(fx.rev, 0, 1, 0),
  };
}

const FX_PRESETS = [
  { name: 'Basso: più definizione', parts: ['bass'], fx: { lowcut: 30, low: 1, mid: 3, midf: 900, high: 2, exc: 0.45, excf: 1500, comp: 0.35, att: 25 } },
  { name: 'Basso: più attacco', parts: ['bass'], fx: { lowcut: 30, mid: 4, midf: 1800, exc: 0.25, excf: 2500, comp: 0.5, att: 35 } },
  { name: 'Voce: presenza e riverbero', parts: ['vocals'], fx: { lowcut: 100, mid: 3, midf: 3000, high: 2, comp: 0.4, att: 5, rev: 0.25 } },
  { name: 'Voce: solo riverbero', parts: ['vocals'], fx: { rev: 0.3 } },
  { name: 'Batteria: più punch', parts: ['drums'], fx: { lowcut: 30, low: 3, mid: -2, midf: 400, high: 3, comp: 0.45, att: 30 } },
  { name: 'Chitarra: più chiara', parts: ['guitar', 'other'], fx: { lowcut: 90, mid: -2, midf: 300, high: 3, exc: 0.2, excf: 3000 } },
  { name: 'Piano: più chiaro', parts: ['piano'], fx: { lowcut: 60, mid: 1.5, midf: 2500, high: 2 } },
  { name: 'Pulisci registrazione dal vivo', parts: [], fx: { lowcut: 80, mid: -2, midf: 300, high: 1, comp: 0.25, att: 10 } },
];

// cursori: valore salvato ↔ posizione del cursore (0…1000) e testo mostrato
const logMap = (lo, hi) => ({
  to: (v) => Math.round((1000 * Math.log(v / lo)) / Math.log(hi / lo)),
  from: (x) => Math.round(lo * Math.pow(hi / lo, x / 1000)),
});
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);
const db = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const pct = (v) => `${Math.round(v * 100)}%`;
const lin = (lo, hi) => ({ to: (v) => Math.round(((v - lo) / (hi - lo)) * 1000), from: (x) => lo + ((hi - lo) * x) / 1000 });
const LOWCUT = logMap(30, 400);
const FX_CONTROLS = [
  { sec: 'Equalizzatore' },
  { k: 'lowcut', label: 'Taglio bassi', hint: 'Toglie rimbombo e fruscio sotto la frequenza scelta',
    to: (v) => (v ? 40 + Math.round(LOWCUT.to(v) * 0.96) : 0), from: (x) => (x < 40 ? 0 : LOWCUT.from((x - 40) / 0.96)), fmt: (v) => (v ? hz(v) : T('Spento')) },
  { k: 'low', label: 'Bassi', hint: 'Sotto i 120 Hz', ...lin(-12, 12), step: 0.5, fmt: db },
  { k: 'mid', label: 'Medi', hint: 'Intorno alla frequenza qui sotto', ...lin(-12, 12), step: 0.5, fmt: db },
  { k: 'midf', label: 'Frequenza medi', ...logMap(150, 6000), fmt: hz },
  { k: 'high', label: 'Alti', hint: 'Sopra i 4 kHz', ...lin(-12, 12), step: 0.5, fmt: db },
  { sec: 'Definizione' },
  { k: 'exc', label: 'Quantità', hint: 'Ricrea le armoniche acute perse: dà chiarezza a una traccia ovattata (es. il basso)', ...lin(0, 1), step: 0.01, fmt: pct },
  { k: 'excf', label: 'Sopra i', ...logMap(500, 8000), fmt: hz },
  { sec: 'Compressore' },
  { k: 'comp', label: 'Compressione', hint: 'Livello più costante e suono più presente', ...lin(0, 1), step: 0.01, fmt: pct },
  { k: 'att', label: 'Attacco', hint: 'Più lungo = l’attacco di ogni nota passa prima che il compressore intervenga: suono più incisivo', ...lin(1, 50), step: 1, fmt: (v) => `${Math.round(v)} ms` },
  { sec: 'Riverbero' },
  { k: 'rev', label: 'Quantità', hint: 'Ambiente, ad esempio sulla voce', ...lin(0, 1), step: 0.01, fmt: pct },
];

const fxUi = { track: null, undoPushed: false };

/** Valore arrotondato al passo del controllo. */
function fxRound(c, v) {
  if (!c.step) return v;
  return Math.round(v / c.step) * c.step;
}

function hasFx(t) { return !!(t && t.fx); }

/** Azione singola (preset, azzera, rimuovi): un passo di annullamento tutto suo. */
function fxStep(fn) {
  fxUi.undoPushed = false;
  const ok = fn();
  fxUi.undoPushed = false;
  return ok;
}

/** Imposta gli effetti di una traccia (null = nessuno) e aggiorna motore, riga e salvataggio.
 *  Una serie di regolazioni consecutive dei cursori è un solo passo di annullamento. */
function setTrackFx(t, fx, { undo = true } = {}) {
  if (undo && !fxUi.undoPushed) { pushUndo('Effetti'); fxUi.undoPushed = true; }
  const prev = t.fx;
  t.fx = normFx(fx);
  if (!engine.applyFx(t)) {
    t.fx = prev;
    toast(`Al massimo ${FX_SLOTS} tracce con effetti nello stesso progetto`);
    return false;
  }
  syncFxBadge(t);
  saveProject();
  return true;
}

/** Pulsante "FX" nella riga della traccia: visibile quando la traccia ha effetti. */
function syncFxBadge(t) {
  const b = t.row && t.row.querySelector('.fxb');
  if (!b) return;
  b.classList.toggle('hidden', !t.fx);
  b.classList.toggle('off', !!t.fx && t.fx.on === false);
  b.title = !t.fx ? '' : t.fx.on === false ? 'Effetti disattivati: clic per regolarli' : 'Effetti attivi: clic per regolarli';
}

function closeFxPanel() {
  $('#fx-panel').classList.add('hidden');
  fxUi.track = null;
}

function openFxPanel(t, anchor) {
  const panel = $('#fx-panel');
  const wasOpen = !panel.classList.contains('hidden');
  fxUi.track = t;
  fxUi.undoPushed = false;
  renderFxPanel();
  panel.classList.remove('hidden');
  if (!wasOpen || anchor) {
    const r = anchor ? anchor.getBoundingClientRect() : (t.row ? t.row.getBoundingClientRect() : { left: 80, bottom: 80, top: 80 });
    placeMenu(panel, r);
  }
}

function renderFxPanel() {
  const t = fxUi.track;
  const panel = $('#fx-panel');
  if (!t) return;
  if (!engine.tracks.includes(t)) { closeFxPanel(); return; }
  const fx = t.fx || { ...FX_DEFAULT };
  const recommended = FX_PRESETS.filter((p) => p.parts.includes(t.part));
  const others = FX_PRESETS.filter((p) => !p.parts.includes(t.part));
  const opt = (p) => `<option value="${FX_PRESETS.indexOf(p)}">${esc(T(p.name))}</option>`;
  panel.innerHTML = `
    <div class="fx-head"><span class="fx-title">${esc(T('Effetti'))} · <b>${esc(trackTitle(t))}</b></span>
      <button class="fx-close" title="Chiudi (Esc)" aria-label="Chiudi (Esc)">✕</button></div>
    <div class="fx-top">
      <label class="fx-on" title="Togli la spunta per ascoltare la traccia senza effetti e confrontare"><input type="checkbox" ${fx.on !== false ? 'checked' : ''} ${t.fx ? '' : 'disabled'}> Attivi</label>
      <select class="fx-preset" title="Punto di partenza: poi regola a orecchio">
        <option value="">Preset…</option>
        ${recommended.length ? `<optgroup label="${esc(T('Per questa traccia'))}">${recommended.map(opt).join('')}</optgroup><optgroup label="${esc(T('Altri'))}">${others.map(opt).join('')}</optgroup>` : FX_PRESETS.map(opt).join('')}
      </select>
    </div>
    <div class="fx-body">${FX_CONTROLS.map((c) => (c.sec
      ? `<div class="fx-sec">${esc(T(c.sec))}</div>`
      : `<label class="fx-row" ${c.hint ? `title="${esc(T(c.hint))}"` : ''}><span class="fx-l">${esc(T(c.label))}</span>
          <input type="range" min="0" max="1000" step="1" data-k="${c.k}" value="${c.to(fx[c.k])}">
          <output>${esc(c.fmt(fx[c.k]))}</output></label>`)).join('')}</div>
    <div class="fx-foot">
      <button class="fx-reset" ${t.fx ? '' : 'disabled'} title="Riporta tutti i controlli a zero (gli effetti restano sulla traccia)">Azzera</button>
      <button class="fx-remove" ${t.fx ? '' : 'disabled'} title="Toglie gli effetti dalla traccia (sparisce il pulsante FX)">Rimuovi effetti</button>
    </div>`;
  panel.querySelector('.fx-close').addEventListener('click', closeFxPanel);
  panel.querySelector('.fx-on input').addEventListener('change', (e) => {
    // il confronto con l'originale non entra nella cronologia degli annullamenti
    setTrackFx(t, { ...(t.fx || FX_DEFAULT), on: e.target.checked }, { undo: false });
    panel.classList.toggle('bypass', !e.target.checked);
  });
  panel.classList.toggle('bypass', fx.on === false);
  panel.querySelector('.fx-preset').addEventListener('change', (e) => {
    const p = FX_PRESETS[Number(e.target.value)];
    if (!p) return;
    if (fxStep(() => setTrackFx(t, { ...FX_DEFAULT, ...p.fx }))) renderFxPanel();
  });
  panel.querySelectorAll('input[type=range]').forEach((inp) => {
    const c = FX_CONTROLS.find((x) => x.k === inp.dataset.k);
    const out = inp.nextElementSibling;
    inp.addEventListener('input', () => {
      const v = fxRound(c, c.from(Number(inp.value)));
      out.textContent = c.fmt(v);
      // regolando un controllo gli effetti si riaccendono
      setTrackFx(t, { ...(t.fx || FX_DEFAULT), [c.k]: v, on: true });
      const on = panel.querySelector('.fx-on input');
      on.checked = true;
      on.disabled = !t.fx;
      panel.classList.remove('bypass');
      panel.querySelector('.fx-remove').disabled = !t.fx;
      panel.querySelector('.fx-reset').disabled = !t.fx;
    });
    // le frecce regolano il cursore senza spostare la riproduzione; doppio clic = zero
    inp.addEventListener('keydown', (e) => { if (e.code.startsWith('Arrow')) e.stopPropagation(); });
    inp.addEventListener('dblclick', () => {
      inp.value = c.to(FX_DEFAULT[c.k]);
      inp.dispatchEvent(new Event('input'));
    });
  });
  panel.querySelector('.fx-reset').addEventListener('click', () => {
    if (fxStep(() => setTrackFx(t, { ...FX_DEFAULT }))) renderFxPanel();
  });
  panel.querySelector('.fx-remove').addEventListener('click', () => {
    fxStep(() => setTrackFx(t, null));
    renderFxPanel();
  });
  // il pannello si sposta trascinandone l'intestazione
  const head = panel.querySelector('.fx-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const z = uiZoom();
    const sx = e.clientX, sy = e.clientY, l0 = panel.offsetLeft, t0 = panel.offsetTop;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      panel.style.left = `${Math.max(0, l0 + (ev.clientX - sx) / z)}px`;
      panel.style.top = `${Math.max(0, t0 + (ev.clientY - sy) / z)}px`;
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !$('#fx-panel').classList.contains('hidden')) closeFxPanel();
});
