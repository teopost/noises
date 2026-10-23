'use strict';
// Accesso: login, registrazione, verifica email, password dimenticata/reset, Google SSO, menu utente.

const AUTH_ERRORS = {
  link_scaduto: 'Il link di conferma è scaduto o già usato. Accedi per riceverne uno nuovo.',
  google_annullato: 'Accesso con Google annullato.',
  google_errore: 'Accesso con Google non riuscito. Riprova.',
  google_sessione_scaduta: 'Sessione di accesso scaduta, riprova.',
  google_stato_non_valido: 'Richiesta di accesso non valida, riprova.',
};

const authState = { user: null, config: null, pendingEmail: null };

function showAuthForm(name) {
  document.querySelectorAll('.auth-form').forEach((f) => f.classList.toggle('hidden', f.id !== `f-${name}`));
  $('#google-box').classList.toggle('hidden', !(authState.config && authState.config.google) || name === 'reset');
  $('#to-register').classList.toggle('hidden', !(authState.config && authState.config.allow_registration));
  const first = $(`#f-${name} input`);
  if (first) setTimeout(() => first.focus(), 30);
}

function authMessage(text, kind = 'info', action) {
  const el = $('#auth-msg');
  el.className = `auth-msg ${kind}`;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link';
    b.textContent = action.label;
    b.addEventListener('click', action.run);
    el.append(' ', b);
  }
}

function showAuth(form = 'login') {
  $('#auth').classList.remove('hidden');
  document.body.classList.add('auth-open');
  showAuthForm(form);
}

async function postJSON(url, body) {
  return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function busy(form, on) {
  form.querySelectorAll('button, input').forEach((el) => { el.disabled = on; });
}

function setupAuthForms() {
  const go = (name) => (e) => { e.preventDefault(); authMessage(''); showAuthForm(name); };
  $('#to-register').addEventListener('click', go('register'));
  $('#to-forgot').addEventListener('click', go('forgot'));
  document.querySelectorAll('.to-login').forEach((b) => b.addEventListener('click', go('login')));

  $('#f-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget, email = $('#l-email').value.trim();
    busy(f, true);
    try {
      authState.user = await postJSON('/api/auth/login', { email, password: $('#l-password').value });
      enterApp();
    } catch (err) {
      if (err.status === 403) {
        authMessage(err.message, 'warn', {
          label: 'Invia di nuovo il link',
          run: async () => {
            const r = await postJSON('/api/auth/resend', { email });
            authMessage(r.message, 'ok');
          },
        });
      } else {
        authMessage(err.message, 'error');
      }
    } finally {
      busy(f, false);
    }
  });

  $('#f-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if ($('#r-password').value !== $('#r-password2').value) {
      authMessage('Le due password non coincidono.', 'error');
      return;
    }
    busy(f, true);
    try {
      const r = await postJSON('/api/auth/register', {
        name: $('#r-name').value.trim(), email: $('#r-email').value.trim(), password: $('#r-password').value,
      });
      if (r && r.id) { // verifica email disattivata: già dentro
        authState.user = r;
        enterApp();
        return;
      }
      f.reset();
      showAuthForm('login');
      authMessage(`${r.message} Poi torna qui per accedere.`, 'ok');
    } catch (err) {
      authMessage(err.message, 'error');
    } finally {
      busy(f, false);
    }
  });

  $('#f-forgot').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    busy(f, true);
    try {
      const r = await postJSON('/api/auth/forgot', { email: $('#fg-email').value.trim() });
      showAuthForm('login');
      authMessage(r.message, 'ok');
    } catch (err) {
      authMessage(err.message, 'error');
    } finally {
      busy(f, false);
    }
  });

  $('#f-reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if ($('#rs-password').value !== $('#rs-password2').value) {
      authMessage('Le due password non coincidono.', 'error');
      return;
    }
    busy(f, true);
    try {
      authState.user = await postJSON('/api/auth/reset', { token: f.dataset.token, password: $('#rs-password').value });
      history.replaceState(null, '', '/');
      enterApp();
    } catch (err) {
      authMessage(err.message, 'error');
    } finally {
      busy(f, false);
    }
  });
}

// ----------------------------------------------------------------- menu utente

function renderUserBox() {
  const u = authState.user;
  if (!u) return;
  $('#user-avatar').textContent = (u.name || u.email).trim().charAt(0).toUpperCase();
  $('#user-name').textContent = u.name;
  $('#user-email').textContent = u.email;
  $('#user-badges').textContent = [u.is_admin ? 'amministratore' : '', u.google ? 'Google' : '', u.has_password ? 'password' : '']
    .filter(Boolean).join(' · ');
}

function setupUserMenu() {
  const menu = $('#user-menu');
  $('#user-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !e.target.closest('#user-btn')) menu.classList.add('hidden');
  });
  $('#logout').addEventListener('click', async () => {
    if (state.current) flushAutosave(true);
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  });
  $('#change-pw').addEventListener('click', () => {
    menu.classList.add('hidden');
    const has = authState.user.has_password;
    $('#cp-current-wrap').classList.toggle('hidden', !has);
    $('#cp-title').textContent = has ? 'Cambia password' : 'Imposta una password';
    $('#cp-form').reset();
    $('#cp-msg').textContent = '';
    $('#pw-dlg').showModal();
  });
  $('#cp-form').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    if ($('#cp-new').value !== $('#cp-new2').value) {
      $('#cp-msg').textContent = 'Le due password non coincidono.';
      return;
    }
    try {
      await postJSON('/api/account/password', { current: $('#cp-current').value || null, password: $('#cp-new').value });
      authState.user.has_password = true;
      renderUserBox();
      $('#pw-dlg').close();
    } catch (err) {
      $('#cp-msg').textContent = err.message;
    }
  });
}

// ------------------------------------------------------------------------ avvio

let appStarted = false;

function enterApp() {
  $('#auth').classList.add('hidden');
  document.body.classList.remove('auth-open');
  authMessage('');
  renderUserBox();
  if (!appStarted) {
    appStarted = true;
    startApp();
  }
}

async function boot() {
  setupAuthForms();
  setupUserMenu();
  try {
    authState.config = await api('/api/auth/config');
  } catch {
    authState.config = { google: false, allow_registration: true };
  }
  const params = new URLSearchParams(location.search);
  const reset = params.get('reset');
  if (reset) {
    $('#f-reset').dataset.token = reset;
    showAuth('reset');
    return;
  }
  const err = params.get('auth_error');
  const verified = params.get('verified');
  if (err || verified) history.replaceState(null, '', '/');
  try {
    authState.user = await api('/api/auth/me');
    enterApp();
    if (verified) setTimeout(() => alert('Email confermata: benvenuto in Noises!'), 300);
  } catch {
    showAuth('login');
    if (err) authMessage(AUTH_ERRORS[err] || 'Accesso non riuscito.', 'error');
  }
}
