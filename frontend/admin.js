'use strict';
// Amministrazione (solo per gli amministratori): utenti e ruoli, inviti, accessi, attività,
// stato del sistema e avviso quando su GitHub c'è una versione più recente.

const adm = { tab: 'users', users: [], update: null, filter: '' };

const admDate = (t) => (t ? new Date(t * 1000).toLocaleString(LANG, { dateStyle: 'short', timeStyle: 'short' }) : '–');

function admAgo(t) {
  if (!t) return T('mai');
  const s = Math.round(Date.now() / 1000 - t);
  const rtf = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto' });
  if (s < 60) return rtf.format(0, 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 30 * 86400) return rtf.format(-Math.round(s / 86400), 'day');
  return admDate(t);
}

function admBytes(n) {
  if (n == null) return '–';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** "Chrome · Windows" dalla stringa del browser. */
function admBrowser(ua) {
  if (!ua) return '–';
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /TelegramBot|bot|curl/i.test(ua) ? ua.split(/[ /]/)[0] : '?';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} · ${os}` : b;
}

// ---------------------------------------------------------------- avviso aggiornamenti

/** All'avvio: mostra la voce del menu agli amministratori e controlla gli aggiornamenti. */
async function adminInit() {
  const u = authState.user;
  const item = $('#admin-open');
  item.classList.toggle('hidden', !(u && u.is_admin));
  if (!u || !u.is_admin) return;
  try {
    adm.update = await api('/api/admin/update');
  } catch { adm.update = null; }
  const upd = !!(adm.update && adm.update.update_available);
  $('#admin-badge').classList.toggle('hidden', !upd);
  $('#user-btn').classList.toggle('has-update', upd);
  $('#adm-sys-dot').classList.toggle('hidden', !upd);
  if (upd) {
    const v = adm.update.latest.version;
    $('#admin-badge').title = `${T('Disponibile la versione')} ${v}`;
    $('#user-btn').title = `${T('Account')} · ${T('Disponibile la versione')} ${v}`;
  }
}

// ---------------------------------------------------------------------------- finestra

function openAdmin(tab = adm.tab) {
  $('#user-menu').classList.add('hidden');
  $('#admin-dlg').showModal();
  admTab(tab);
}

function admTab(tab) {
  adm.tab = tab;
  document.querySelectorAll('#admin-dlg .adm-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const body = $('#adm-body');
  body.innerHTML = `<div class="adm-loading">${esc(T('Caricamento…'))}</div>`;
  ({ users: admUsers, invites: admInvites, access: () => admEvents('access'), activity: () => admEvents('action'), system: admSystem })[tab]()
    .catch((e) => { body.innerHTML = `<p class="adm-error">${esc(e.message)}</p>`; });
}

// ------------------------------------------------------------------------------ utenti

async function admUsers() {
  adm.users = await api('/api/admin/users');
  const me = authState.user;
  const rows = adm.users.map((u) => {
    const state = u.disabled ? ['off', 'Disattivato'] : !u.email_verified ? ['wait', 'Da confermare'] : ['on', 'Attivo'];
    const how = [u.has_password ? 'password' : '', u.google ? 'Google' : ''].filter(Boolean).join(' · ');
    return `<tr data-id="${u.id}" class="${u.disabled ? 'dim' : ''}">
      <td><div class="adm-user"><span class="avatar sm">${esc((u.name || u.email).charAt(0).toUpperCase())}</span>
        <div><b>${esc(u.name)}</b>${u.id === me.id ? ` <small class="tag">${esc(T('tu'))}</small>` : ''}<br><small>${esc(u.email)}</small></div></div></td>
      <td><select class="adm-role" ${u.disabled ? 'disabled' : ''}>
        <option value="user" ${u.role === 'user' ? 'selected' : ''}>${esc(T('Utente'))}</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>${esc(T('Amministratore'))}</option></select></td>
      <td><span class="pill ${state[0]}">${esc(T(state[1]))}</span><br><small>${esc(how)}</small></td>
      <td title="${esc(admDate(u.last_login))}">${esc(admAgo(u.last_login))}</td>
      <td title="${esc(admDate(u.last_seen))}">${esc(admAgo(u.last_seen))}</td>
      <td class="num">${u.songs} · ${u.projects}${u.shares ? ` · ${u.shares} 🔗` : ''}</td>
      <td class="num">${admBytes(u.bytes)}</td>
      <td title="${esc(admDate(u.created_at))}">${esc(new Date(u.created_at * 1000).toLocaleDateString(LANG))}</td>
      <td class="adm-acts">
        <button class="ghost adm-act" title="${esc(T('Attività di questo utente'))}">${esc(T('Attività'))}</button>
        ${u.id === me.id ? '' : `<button class="ghost adm-toggle ${u.disabled ? '' : 'danger'}">${esc(T(u.disabled ? 'Riattiva' : 'Disattiva'))}</button>`}
      </td></tr>`;
  }).join('');
  $('#adm-body').innerHTML = `
    <div class="adm-bar"><span class="adm-count">${adm.users.length} ${esc(T(adm.users.length === 1 ? 'utente' : 'utenti'))}</span>
      <span class="grow"></span><button class="primary adm-go-invite">＋ ${esc(T('Invita'))}</button></div>
    <div class="adm-scroll"><table class="adm-table">
      <thead><tr><th>${esc(T('Utente'))}</th><th>${esc(T('Ruolo'))}</th><th>${esc(T('Stato'))}</th><th>${esc(T('Ultimo accesso'))}</th>
        <th>${esc(T('Ultima attività'))}</th><th title="${esc(T('Brani · progetti · link pubblici'))}">${esc(T('Contenuti'))}</th><th>${esc(T('Spazio'))}</th>
        <th>${esc(T('Iscritto'))}</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  $('#adm-body .adm-go-invite').addEventListener('click', () => admTab('invites'));
  $('#adm-body').querySelectorAll('tr[data-id]').forEach((tr) => {
    const u = adm.users.find((x) => x.id === tr.dataset.id);
    tr.querySelector('.adm-role').addEventListener('change', async (e) => {
      const role = e.target.value;
      const ok = await uiConfirm(role === 'admin'
        ? `${u.name} (${u.email}) ${T('diventerà amministratore: potrà gestire utenti e inviti e vedere il registro.')}`
        : `${u.name} (${u.email}) ${T('non sarà più amministratore.')}`, { title: T('Cambia ruolo'), ok: T('Conferma') });
      if (!ok) { e.target.value = u.role; return; }
      await admPatch(u, { role });
    });
    tr.querySelector('.adm-act').addEventListener('click', () => { adm.filter = u.id; admTab('activity'); });
    const tg = tr.querySelector('.adm-toggle');
    if (tg) tg.addEventListener('click', async () => {
      const off = !u.disabled;
      if (off && !(await uiConfirm(`${T('Disattivare')} ${u.name} (${u.email})? ${T('Esce subito e non potrà più accedere; i suoi brani e progetti restano.')}`,
        { title: T('Disattiva utente'), ok: T('Disattiva'), danger: true }))) return;
      await admPatch(u, { disabled: off });
    });
  });
}

async function admPatch(u, body) {
  try {
    await api(`/api/admin/users/${u.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (u.id === authState.user.id && body.role) authState.user.is_admin = body.role === 'admin';
    toast(T('Utente aggiornato'));
  } catch (e) {
    uiAlert(e.message);
  }
  if (!authState.user.is_admin) { $('#admin-dlg').close(); adminInit(); renderUserBox(); return; }
  admUsers();
}

// ------------------------------------------------------------------------------ inviti

async function admInvites() {
  const list = await api('/api/admin/invites');
  const now = Date.now() / 1000;
  const rows = list.map((i) => {
    const st = i.used_at ? `<span class="pill on">${esc(T('Accettato'))}</span><br><small>${esc(i.used_by || '')} · ${esc(admDate(i.used_at))}</small>`
      : i.expires_at < now ? `<span class="pill off">${esc(T('Scaduto'))}</span>`
      : `<span class="pill wait">${esc(T('In attesa'))}</span><br><small>${esc(T('fino al'))} ${esc(admDate(i.expires_at))}</small>`;
    return `<tr data-id="${i.id}"><td>${esc(i.email)}</td><td>${esc(T(i.role === 'admin' ? 'Amministratore' : 'Utente'))}</td>
      <td>${esc(i.invited_by || '–')}<br><small>${esc(admDate(i.created_at))}</small></td><td>${st}</td>
      <td class="adm-acts">${!i.used_at && i.expires_at > now ? `<button class="ghost danger adm-revoke">${esc(T('Revoca'))}</button>` : ''}</td></tr>`;
  }).join('');
  $('#adm-body').innerHTML = `
    <form class="adm-invite" autocomplete="off">
      <label>${esc(T('Email'))}<input id="adm-inv-email" type="email" required placeholder="${esc(T('nome@esempio.it'))}"></label>
      <label>${esc(T('Ruolo'))}<select id="adm-inv-role"><option value="user">${esc(T('Utente'))}</option><option value="admin">${esc(T('Amministratore'))}</option></select></label>
      <button class="primary" type="submit">${esc(T('Invia invito'))}</button>
    </form>
    <p class="hint">${esc(T("L'invito vale 7 giorni. Chi lo riceve crea il suo account anche se la registrazione è chiusa, e l'indirizzo è già confermato."))}</p>
    <div id="adm-inv-result"></div>
    <div class="adm-scroll"><table class="adm-table">
      <thead><tr><th>${esc(T('Email'))}</th><th>${esc(T('Ruolo'))}</th><th>${esc(T('Invitato da'))}</th><th>${esc(T('Stato'))}</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="empty-hint">${esc(T('Nessun invito'))}</td></tr>`}</tbody></table></div>`;
  $('#adm-body .adm-invite').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button');
    btn.disabled = true;
    try {
      const email = $('#adm-inv-email').value.trim();
      const r = await api('/api/admin/invites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: $('#adm-inv-role').value, en: LANG === 'en' }),
      });
      await admInvites();
      const msg = r.emailed ? `${T('Invito inviato a')} ${email}.`
        : r.email_error ? `${T("L'email non è partita")} (${r.email_error}). ${T('Copia il link e mandalo tu:')}`
        : `${T('SMTP non configurato: copia il link e mandalo tu.')}`;
      $('#adm-inv-result').innerHTML = `<div class="adm-note ${r.emailed ? 'ok' : 'warn'}"><p>${esc(msg)}</p>
        <div class="share-url"><input readonly value="${esc(r.link)}"><button class="primary adm-copy">${esc(T('Copia'))}</button></div></div>`;
      $('#adm-inv-result .adm-copy').addEventListener('click', async () => {
        const inp = $('#adm-inv-result input');
        try { await navigator.clipboard.writeText(inp.value); } catch { inp.select(); document.execCommand('copy'); }
        toast(T('Link copiato'));
      });
    } catch (err) {
      uiAlert(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $('#adm-body').querySelectorAll('.adm-revoke').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('tr').dataset.id;
    if (!(await uiConfirm(T('Revocare questo invito? Il link smetterà di funzionare.'), { ok: T('Revoca'), danger: true }))) return;
    await api(`/api/admin/invites/${id}`, { method: 'DELETE' }).catch((e) => uiAlert(e.message));
    admInvites();
  }));
}

// ------------------------------------------------------------------- accessi e attività

const ACCESS_TEXT = {
  login: 'Accesso', login_failed: 'Accesso non riuscito', logout: 'Uscita', register: 'Registrazione',
  verify: 'Email confermata', reset: 'Password reimpostata',
};

async function admEvents(kind) {
  if (!adm.users.length) adm.users = await api('/api/admin/users').catch(() => []);
  const opts = `<option value="">${esc(T('Tutti gli utenti'))}</option>` + adm.users
    .map((u) => `<option value="${u.id}" ${adm.filter === u.id ? 'selected' : ''}>${esc(u.name)} · ${esc(u.email)}</option>`).join('');
  $('#adm-body').innerHTML = `
    <div class="adm-bar"><select id="adm-ev-user">${opts}</select><span class="grow"></span>
      <button class="ghost" id="adm-ev-reload" title="${esc(T('Aggiorna'))}">⟳</button></div>
    <div class="adm-scroll"><table class="adm-table adm-events">
      <thead><tr><th>${esc(T('Quando'))}</th><th>${esc(T('Utente'))}</th><th>${esc(T(kind === 'access' ? 'Evento' : 'Azione'))}</th>
        <th>${esc(T(kind === 'access' ? 'Indirizzo IP' : 'Esito'))}</th>${kind === 'access' ? `<th>${esc(T('Browser'))}</th>` : ''}</tr></thead>
      <tbody></tbody></table>
      <button class="ghost wide hidden" id="adm-ev-more">${esc(T('Mostra altri'))}</button></div>`;
  let before = null;
  const load = async () => {
    const q = new URLSearchParams({ kind, limit: '100' });
    if (adm.filter) q.set('user', adm.filter);
    if (before) q.set('before', before);
    const list = await api(`/api/admin/events?${q}`);
    const tb = $('#adm-body tbody');
    tb.insertAdjacentHTML('beforeend', list.map((e) => {
      const who = `${esc(e.email || '–')}`;
      if (kind === 'access') {
        const what = `${T(ACCESS_TEXT[e.kind] || e.kind)}${e.detail ? ` · ${T(e.detail)}` : ''}`;
        return `<tr class="${e.kind === 'login_failed' ? 'bad' : ''}"><td title="${esc(admDate(e.at))}">${esc(admDate(e.at))}</td><td>${who}</td>
          <td>${esc(what)}</td><td class="num">${esc(e.ip || '–')}</td><td title="${esc(e.ua)}">${esc(admBrowser(e.ua))}</td></tr>`;
      }
      const err = e.status >= 400;
      return `<tr class="${err ? 'bad' : ''}"><td>${esc(admDate(e.at))}</td><td>${who}</td>
        <td>${e.kind === 'admin' ? '🛡 ' : ''}${esc(T(e.detail))}${e.count > 1 ? ` <small class="tag">×${e.count}</small>` : ''}</td>
        <td>${err ? `<span class="pill off">${esc(T('Errore'))} ${e.status}</span>` : e.kind === 'admin' ? '' : '<span class="pill on">OK</span>'}</td></tr>`;
    }).join('') || (before ? '' : `<tr><td colspan="5" class="empty-hint">${esc(T('Nessun evento'))}</td></tr>`));
    if (list.length) before = list[list.length - 1].id;
    $('#adm-ev-more').classList.toggle('hidden', list.length < 100);
  };
  $('#adm-ev-user').addEventListener('change', (e) => { adm.filter = e.target.value; admEvents(kind); });
  $('#adm-ev-reload').addEventListener('click', () => admEvents(kind));
  $('#adm-ev-more').addEventListener('click', () => load().catch((e) => uiAlert(e.message)));
  await load();
}

// ------------------------------------------------------------------------------ sistema

async function admSystem() {
  const s = await api('/api/admin/system');
  const yes = (v) => `<span class="pill ${v ? 'on' : 'off'}">${esc(T(v ? 'sì' : 'no'))}</span>`;
  const l = s.latest;
  const upd = s.update_available
    ? `<div class="adm-note warn"><p><b>${esc(T('Disponibile la versione'))} ${esc(l.version)}</b> (${esc(T('installata'))}: ${esc(s.version)}).
        <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(T('Note di rilascio'))} ↗</a></p>
        <p>${esc(T('Per aggiornare, sul server:'))} <code>make pull</code> ${esc(T("con l'immagine della CI, oppure"))} <code>git pull &amp;&amp; make up</code>.</p>
        <details><summary>${esc(T('Novità'))}</summary><pre class="adm-notes">${esc(l.notes)}</pre></details></div>`
    : `<div class="adm-note ok"><p>${l ? `${esc(T('Noises è aggiornato'))} (${esc(s.version)}).` : `${esc(T('Versione installata'))}: ${esc(s.version)}. ${esc(T('Non è stato possibile controllare gli aggiornamenti.'))}`}</p></div>`;
  $('#adm-body').innerHTML = `${upd}
    <div class="adm-stats">
      <div><b>${s.users}</b><span>${esc(T('utenti'))} (${s.admins} ${esc(T('amministratori'))})</span></div>
      <div><b>${s.songs}</b><span>${esc(T('brani'))}</span></div>
      <div><b>${s.projects}</b><span>${esc(T('progetti'))}</span></div>
      <div><b>${s.shares}</b><span>${esc(T('link pubblici'))}</span></div>
      <div><b>${admBytes(s.data_bytes)}</b><span>${esc(T('dati'))}</span></div>
      <div><b>${admBytes(s.disk_free)}</b><span>${esc(T('liberi sul disco'))}</span></div>
    </div>
    <table class="adm-table adm-kv">
      <tr><td>${esc(T('Indirizzo pubblico'))} (PUBLIC_URL)</td><td><code>${esc(s.public_url)}</code></td></tr>
      <tr><td>${esc(T('Registrazione aperta'))} (ALLOW_REGISTRATION)</td><td>${yes(s.allow_registration)}</td></tr>
      <tr><td>${esc(T('Conferma via email'))} (EMAIL_VERIFICATION)</td><td>${yes(s.email_verification)}</td></tr>
      <tr><td>${esc(T('Invio email'))} (SMTP)</td><td>${yes(s.smtp)}</td></tr>
      <tr><td>${esc(T('Accesso con Google'))}</td><td>${yes(s.google)}</td></tr>
    </table>`;
}

function setupAdmin() {
  $('#admin-open').addEventListener('click', () => openAdmin(adm.update && adm.update.update_available ? 'system' : 'users'));
  $('#admin-dlg .adm-close').addEventListener('click', () => $('#admin-dlg').close());
  // il filtro per utente resta passando da Accessi ad Attività
  document.querySelectorAll('#admin-dlg .adm-tabs button').forEach((b) => b.addEventListener('click', () => admTab(b.dataset.tab)));
}
