//! Autenticazione: account locali (registrazione, verifica email, reset password) e SSO Google.
//!
//! * Password con Argon2id; sessioni con token casuale in cookie HttpOnly (nel DB solo l'hash SHA-256).
//! * Token monouso per verifica email e reset password, anch'essi salvati solo come hash.
//! * Google: OAuth 2.0 / OpenID Connect con PKCE; l'account viene collegato per email verificata.
//! * Email via SMTP; senza SMTP configurato i link vengono scritti nel log del server.

use std::{
    collections::HashMap,
    path::Path,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
    Extension, Json,
};
use base64::Engine;
use lettre::{
    message::{header::ContentType, Mailbox, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use rand::RngCore;
use deadpool_postgres::Pool;
use tokio_postgres::Row;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::{
    bad_request,
    db::{ts, u, Params},
    AppError, AppState,
};

const SESSION_COOKIE: &str = "noises_session";
const OAUTH_COOKIE: &str = "noises_oauth";
const SESSION_TTL: u64 = 30 * 24 * 3600;
const VERIFY_TTL: u64 = 48 * 3600;
const RESET_TTL: u64 = 3600;
const MAX_FAILURES: u32 = 8;
const LOCKOUT_SECS: u64 = 15 * 60;

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

pub(crate) fn random_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    hex(&b)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub(crate) fn sha256_hex(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}

// ---------------------------------------------------------------- configurazione

pub struct AuthConfig {
    pub public_url: String,
    pub google: Option<(String, String)>,
    pub email_verification: bool,
    pub allow_registration: bool,
    /// Link "Richiedi un invito" nella pagina di accesso (ALLOW_INVITE_REQUESTS)
    pub invite_requests: bool,
    secure_cookie: bool,
}

impl AuthConfig {
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let public_url = env("PUBLIC_URL")
            .unwrap_or_else(|| "http://localhost:8080".into())
            .trim_end_matches('/')
            .to_owned();
        let flag = |k: &str, d: bool| env(k).map_or(d, |v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"));
        AuthConfig {
            secure_cookie: public_url.starts_with("https://"),
            google: env("GOOGLE_CLIENT_ID").zip(env("GOOGLE_CLIENT_SECRET")),
            email_verification: flag("EMAIL_VERIFICATION", true),
            allow_registration: flag("ALLOW_REGISTRATION", true),
            invite_requests: flag("ALLOW_INVITE_REQUESTS", false),
            public_url,
        }
    }
}

// ------------------------------------------------------------------------ email

pub struct Mailer {
    transport: Option<AsyncSmtpTransport<Tokio1Executor>>,
    from: Mailbox,
}

impl Mailer {
    pub fn from_env() -> anyhow::Result<Self> {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let from: Mailbox = env("SMTP_FROM")
            .unwrap_or_else(|| "Noises <noreply@localhost>".into())
            .parse()
            .context("SMTP_FROM non valido")?;
        let Some(host) = env("SMTP_HOST") else {
            warn!("SMTP non configurato: i link di verifica/reset verranno scritti nel log");
            return Ok(Mailer { transport: None, from });
        };
        let port: u16 = env("SMTP_PORT").and_then(|p| p.parse().ok()).unwrap_or(587);
        let mut builder = match env("SMTP_TLS").as_deref().unwrap_or("starttls") {
            "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(&host)?,
            "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host),
            _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)?,
        }
        .port(port)
        .timeout(Some(Duration::from_secs(30))); // un server che non risponde non blocca la richiesta
        if let (Some(u), Some(p)) = (env("SMTP_USER"), env("SMTP_PASSWORD")) {
            builder = builder.credentials(Credentials::new(u, p));
        }
        info!("email via SMTP {host}:{port}");
        Ok(Mailer { transport: Some(builder.build()), from })
    }

    /// All'avvio: prova la connessione al server SMTP e scrive l'esito nel log.
    pub async fn check(&self) {
        let Some(t) = &self.transport else { return };
        match t.test_connection().await {
            Ok(true) => info!("SMTP raggiungibile, email da {}", self.from),
            Ok(false) => warn!("SMTP: il server non risponde correttamente: le email potrebbero non partire"),
            Err(e) => warn!("SMTP non raggiungibile: {e:#} — le email non partiranno (controlla SMTP_HOST, SMTP_PORT, SMTP_TLS, SMTP_USER, SMTP_PASSWORD)"),
        }
    }

    pub(crate) fn configured(&self) -> bool {
        self.transport.is_some()
    }

    pub(crate) async fn send(&self, to: &str, subject: &str, text: &str, link: &str, en: bool) -> anyhow::Result<()> {
        let Some(t) = &self.transport else {
            warn!("[email non inviata — SMTP assente] a {to}: {subject} → {link}");
            return Ok(());
        };
        let html = format!(
            "<div style=\"font-family:system-ui,sans-serif;max-width:520px\">\
             <h2 style=\"color:#7c5cff\">Noises</h2><p>{}</p>\
             <p><a href=\"{link}\" style=\"display:inline-block;padding:10px 18px;background:#7c5cff;\
             color:#fff;border-radius:8px;text-decoration:none\">{subject}</a></p>\
             <p style=\"color:#888;font-size:12px\">{}<br>{link}</p></div>",
            html_escape(text).replace('\n', "<br>"),
            if en { "If the button doesn't work, copy this address:" } else { "Se il pulsante non funziona copia questo indirizzo:" }
        );
        let msg = Message::builder()
            .from(self.from.clone())
            .to(to.parse().context("destinatario non valido")?)
            .subject(subject)
            .multipart(
                MultiPart::alternative()
                    .singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(format!("{text}\n\n{link}\n")))
                    .singlepart(SinglePart::builder().header(ContentType::TEXT_HTML).body(html)),
            )?;
        t.send(msg).await.context("invio email (controlla SMTP_HOST, SMTP_PORT, SMTP_TLS e le credenziali)")?;
        info!("email '{subject}' inviata a {to}");
        Ok(())
    }
}

/// Testo semplice dentro l'HTML delle email: nomi e messaggi arrivano dagli utenti.
pub(crate) fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// Indirizzo della connessione diretta, aggiunto dal middleware (ogni valore dal client viene scartato).
const PEER_HEADER: &str = "x-noises-peer";

/// Da dove arriva una richiesta: indirizzo IP (anche dietro proxy o tunnel) e browser.
#[derive(Clone, Debug, Default)]
pub struct Client {
    pub ip: String,
    pub ua: String,
}

impl Client {
    pub fn from_headers(h: &HeaderMap) -> Self {
        let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        let ip = get("cf-connecting-ip")
            .or_else(|| get("x-forwarded-for").map(|v| v.split(',').next().unwrap_or("").trim().to_owned()))
            .or_else(|| get("x-real-ip"))
            .or_else(|| get(PEER_HEADER))
            .unwrap_or_default();
        let ua = get("user-agent").unwrap_or_default().chars().take(300).collect();
        Client { ip: ip.chars().take(64).collect(), ua }
    }
}

// --------------------------------------------------------------------- database

#[derive(Clone, Debug, Serialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub email_verified: bool,
    pub is_admin: bool,
    pub has_password: bool,
    pub google: bool,
}

pub struct Auth {
    pub(crate) db: Pool,
    pub config: AuthConfig,
    pub(crate) mailer: Mailer,
    pub(crate) http: reqwest::Client,
    failures: Mutex<HashMap<String, (u32, u64)>>,
    /// richieste d'invito per IP (e in totale, chiave "*"): (numero, inizio della finestra)
    requests: Mutex<HashMap<String, (u32, u64)>>,
}

const USER_COLS: &str = "id, email::text, name, email_verified, is_admin, password_hash IS NOT NULL, google_sub IS NOT NULL";

fn row_user(r: &Row) -> User {
    User {
        id: r.get(0),
        email: r.get(1),
        name: r.get(2),
        email_verified: r.get(3),
        is_admin: r.get(4),
        has_password: r.get(5),
        google: r.get(6),
    }
}

impl Auth {
    /// Verifica in background che il server SMTP sia raggiungibile (esito nel log).
    pub async fn check_mail(&self) {
        self.mailer.check().await;
    }

    pub async fn open(data_dir: &Path) -> anyhow::Result<Self> {
        let db = crate::db::connect(data_dir).await?;
        let auth = Auth {
            db,
            config: AuthConfig::from_env(),
            mailer: Mailer::from_env()?,
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?,
            failures: Mutex::default(),
            requests: Mutex::default(),
        };
        // registro: 180 giorni
        auth.exec("DELETE FROM events WHERE at < $1", &[&ts(now().saturating_sub(180 * 24 * 3600))]).await?;
        auth.exec("DELETE FROM sessions WHERE expires_at < $1", &[&ts(now())]).await?;
        auth.exec("DELETE FROM tokens WHERE expires_at < $1", &[&ts(now())]).await?;
        let config = &auth.config;
        info!(
            "autenticazione: url pubblico {}, Google SSO {}, verifica email {}, registrazione {}, richieste d'invito {}",
            config.public_url,
            if config.google.is_some() { "attivo" } else { "non configurato" },
            config.email_verification,
            config.allow_registration,
            config.invite_requests
        );
        Ok(auth)
    }

    // ------------------------------------------------------------ accesso al database

    pub(crate) async fn exec(&self, sql: &str, p: Params<'_>) -> anyhow::Result<u64> {
        Ok(self.db.get().await?.execute(sql, p).await?)
    }

    pub(crate) async fn query(&self, sql: &str, p: Params<'_>) -> anyhow::Result<Vec<Row>> {
        Ok(self.db.get().await?.query(sql, p).await?)
    }

    pub(crate) async fn query_opt(&self, sql: &str, p: Params<'_>) -> anyhow::Result<Option<Row>> {
        Ok(self.db.get().await?.query_opt(sql, p).await?)
    }

    pub(crate) async fn query_one(&self, sql: &str, p: Params<'_>) -> anyhow::Result<Row> {
        Ok(self.db.get().await?.query_one(sql, p).await?)
    }

    async fn user_where(&self, cond: &str, value: &str) -> anyhow::Result<Option<User>> {
        Ok(self
            .query_opt(&format!("SELECT {USER_COLS} FROM users WHERE {cond} = $1"), &[&value])
            .await?
            .map(|r| row_user(&r)))
    }

    async fn password_hash(&self, user_id: &str) -> anyhow::Result<Option<String>> {
        Ok(self
            .query_opt("SELECT password_hash FROM users WHERE id = $1", &[&user_id])
            .await?
            .and_then(|r| r.get(0)))
    }

    /// Crea un utente; il primo diventa amministratore. Restituisce (utente, è_il_primo).
    /// Gli altri utenti sono amministratori se `admin` (invito come amministratore).
    pub(crate) async fn create_user_as(
        &self,
        email: &str,
        name: &str,
        password_hash: Option<&str>,
        verified: bool,
        google_sub: Option<&str>,
        admin: bool,
    ) -> anyhow::Result<(User, bool)> {
        let mut c = self.db.get().await?;
        let tx = c.transaction().await?;
        // due registrazioni contemporanee non devono diventare entrambe "il primo utente"
        tx.batch_execute("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE").await?;
        let count: i64 = tx.query_one("SELECT COUNT(*) FROM users", &[]).await?.get(0);
        let first = count == 0;
        let id = uuid::Uuid::new_v4().to_string();
        let is_admin = first || admin;
        tx.execute(
            "INSERT INTO users (id, email, name, password_hash, email_verified, google_sub, is_admin, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            &[&id, &email, &name, &password_hash, &verified, &google_sub, &is_admin, &ts(now())],
        )
        .await?;
        let user = row_user(&tx.query_one(&format!("SELECT {USER_COLS} FROM users WHERE id = $1"), &[&id]).await?);
        tx.commit().await?;
        Ok((user, first))
    }

    /// Annota un evento (accesso, registrazione, azione). Le azioni uguali e ravvicinate dello stesso
    /// utente (es. il salvataggio automatico) si sommano in una riga sola.
    pub(crate) async fn log_event(&self, user_id: Option<&str>, email: &str, kind: &str, detail: &str, path: &str, status: u16, client: &Client) {
        let t = now();
        let status = status as i32;
        if kind == "action" {
            let merged = self
                .exec(
                    "UPDATE events SET at = $1, count = count + 1, status = $2
                     WHERE id = (SELECT id FROM events WHERE user_id IS NOT DISTINCT FROM $3 ORDER BY id DESC LIMIT 1)
                       AND kind = 'action' AND detail = $4 AND path = $5 AND at > $6",
                    &[&ts(t), &status, &user_id, &detail, &path, &ts(t.saturating_sub(600))],
                )
                .await
                .unwrap_or(0);
            if merged > 0 {
                return;
            }
        }
        let r = self
            .exec(
                "INSERT INTO events (at, user_id, email, kind, detail, path, status, ip, ua) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                &[&ts(t), &user_id, &email, &kind, &detail, &path, &status, &client.ip, &client.ua],
            )
            .await;
        if let Err(e) = r {
            warn!("registro eventi: {e:#}");
        }
    }

    /// Ultima attività dell'utente (al massimo una scrittura al minuto).
    pub(crate) async fn touch(&self, user_id: &str) {
        let t = now();
        let _ = self
            .exec(
                "UPDATE users SET last_seen = $1 WHERE id = $2 AND (last_seen IS NULL OR last_seen < $3)",
                &[&ts(t), &user_id, &ts(t.saturating_sub(60))],
            )
            .await;
    }

    /// Nessun utente ancora: il primo può registrarsi anche se la registrazione è chiusa.
    async fn no_users(&self) -> bool {
        self.query_one("SELECT NOT EXISTS (SELECT 1 FROM users)", &[]).await.map(|r| r.get(0)).unwrap_or(false)
    }

    async fn is_disabled(&self, user_id: &str) -> bool {
        self.query_opt("SELECT disabled FROM users WHERE id = $1", &[&user_id])
            .await
            .ok()
            .flatten()
            .is_some_and(|r| r.get(0))
    }

    /// Invito valido (non usato, non scaduto) per un indirizzo: (id, ruolo).
    pub(crate) async fn invite_for_email(&self, email: &str) -> Option<(String, String)> {
        self.query_opt(
            "SELECT id, role FROM invites WHERE email = $1 AND used_at IS NULL AND expires_at > $2 ORDER BY created_at DESC LIMIT 1",
            &[&email, &ts(now())],
        )
        .await
        .ok()
        .flatten()
        .map(|r| (r.get(0), r.get(1)))
    }

    /// Invito dal token del link: (id, email, ruolo).
    pub(crate) async fn invite_by_token(&self, token: &str) -> Option<(String, String, String)> {
        self.query_opt(
            "SELECT id, email::text, role FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2",
            &[&sha256_hex(token), &ts(now())],
        )
        .await
        .ok()
        .flatten()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
    }

    async fn use_invite(&self, id: &str, user_id: &str) {
        let _ = self.exec("UPDATE invites SET used_at = $1, used_by = $2 WHERE id = $3", &[&ts(now()), &user_id, &id]).await;
    }

    async fn logged_in(&self, user: &User, how: &str, client: &Client) {
        let _ = self.exec("UPDATE users SET last_login = $1, last_seen = $1 WHERE id = $2", &[&ts(now()), &user.id]).await;
        self.log_event(Some(&user.id), &user.email, "login", how, "", 200, client).await;
    }

    async fn new_session(&self, user_id: &str) -> anyhow::Result<String> {
        let token = random_token();
        self.exec(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
            &[&sha256_hex(&token), &user_id, &ts(now() + SESSION_TTL)],
        )
        .await?;
        Ok(token)
    }

    pub async fn session_user(&self, token: &str) -> Option<User> {
        self.query_opt(
            &format!(
                "SELECT {} FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = $1 AND s.expires_at > $2 AND NOT u.disabled",
                USER_COLS.split(", ").map(|c| format!("u.{c}")).collect::<Vec<_>>().join(", ")
            ),
            &[&sha256_hex(token), &ts(now())],
        )
        .await
        .ok()
        .flatten()
        .map(|r| row_user(&r))
    }

    async fn new_token(&self, user_id: &str, kind: &str, ttl: u64) -> anyhow::Result<String> {
        let token = random_token();
        self.exec("DELETE FROM tokens WHERE user_id = $1 AND kind = $2", &[&user_id, &kind]).await?;
        self.exec(
            "INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES ($1, $2, $3, $4)",
            &[&sha256_hex(&token), &user_id, &kind, &ts(now() + ttl)],
        )
        .await?;
        Ok(token)
    }

    /// Consuma un token monouso e restituisce l'utente a cui appartiene.
    async fn take_token(&self, token: &str, kind: &str) -> anyhow::Result<Option<String>> {
        // DELETE ... RETURNING: il token si può usare una volta sola anche con richieste contemporanee
        let row = self
            .query_opt(
                "DELETE FROM tokens WHERE token_hash = $1 RETURNING user_id, kind, expires_at",
                &[&sha256_hex(token)],
            )
            .await?;
        Ok(row.and_then(|r| {
            let (uid, k, exp): (String, String, i64) = (r.get(0), r.get(1), r.get(2));
            (k == kind && u(exp) > now()).then_some(uid)
        }))
    }

    // limitazione dei tentativi di accesso falliti (per email)
    fn locked(&self, key: &str) -> bool {
        let f = self.failures.lock().unwrap();
        f.get(key).is_some_and(|(n, since)| *n >= MAX_FAILURES && now() - since < LOCKOUT_SECS)
    }

    fn record_failure(&self, key: &str) {
        let mut f = self.failures.lock().unwrap();
        let e = f.entry(key.to_owned()).or_insert((0, now()));
        if now() - e.1 >= LOCKOUT_SECS {
            *e = (0, now());
        }
        e.0 += 1;
    }

    fn clear_failures(&self, key: &str) {
        self.failures.lock().unwrap().remove(key);
    }

    async fn send_verification(&self, user: &User, en: bool) -> anyhow::Result<()> {
        let token = self.new_token(&user.id, "verify", VERIFY_TTL).await?;
        let link = format!("{}/api/auth/verify?token={token}", self.config.public_url);
        let (subject, text) = if en {
            ("Confirm your account", format!("Hi {},\nto activate your Noises account please confirm your email address.\nThe link expires in 48 hours.", user.name))
        } else {
            ("Conferma il tuo account", format!("Ciao {},\nper attivare il tuo account Noises conferma l'indirizzo email.\nIl link scade tra 48 ore.", user.name))
        };
        self.mailer.send(&user.email, subject, &text, &link, en).await
    }

    async fn send_reset(&self, user: &User, en: bool) -> anyhow::Result<()> {
        let token = self.new_token(&user.id, "reset", RESET_TTL).await?;
        let link = format!("{}/?reset={token}", self.config.public_url);
        let (subject, text) = if en {
            ("Reset your password", format!("Hi {},\nwe received a request to reset your password.\nThe link expires in one hour. If this wasn't you, ignore this message.", user.name))
        } else {
            ("Reimposta la password", format!("Ciao {},\nabbiamo ricevuto una richiesta di reimpostazione della password.\nIl link scade tra un'ora. Se non sei stato tu, ignora questo messaggio.", user.name))
        };
        self.mailer.send(&user.email, subject, &text, &link, en).await
    }
}

/// Lingua dell'interfaccia comunicata dal browser (intestazione X-Noises-Lang): true = inglese.
fn wants_en(headers: &HeaderMap) -> bool {
    headers.get("x-noises-lang").and_then(|v| v.to_str().ok()) == Some("en")
}

async fn hash_password(pw: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(pw.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| anyhow::anyhow!("hash password: {e}"))
    })
    .await?
}

async fn verify_password(pw: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

// ----------------------------------------------------------------------- cookie

/// Tutti i valori di un cookie: il browser può inviarne più d'uno con lo stesso nome
/// (es. altre app su `localhost`, che condivide i cookie tra le porte).
fn cookies(headers: &HeaderMap, name: &str) -> Vec<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .filter(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
        .collect()
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    cookies(headers, name).into_iter().next()
}

/// Utente della sessione: prova tutti i cookie di sessione ricevuti e usa quello valido.
async fn current_user(st: &AppState, headers: &HeaderMap) -> Option<User> {
    let all = cookies(headers, SESSION_COOKIE);
    let mut user = None;
    for t in &all {
        if let Some(u) = st.0.auth.session_user(t).await {
            user = Some(u);
            break;
        }
    }
    if user.is_none() && !all.is_empty() {
        warn!("richiesta con {} cookie di sessione, nessuno valido (scaduto o di un'altra istanza)", all.len());
    } else if all.len() > 1 {
        info!("ricevuti {} cookie di sessione: usato quello valido", all.len());
    }
    user
}

fn set_cookie(cfg: &AuthConfig, name: &str, value: &str, max_age: u64, path: &str) -> HeaderValue {
    let secure = if cfg.secure_cookie { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={value}; Path={path}; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}"
    ))
    .unwrap()
}

async fn with_session(st: &AppState, user: &User, mut resp: Response) -> Result<Response, AppError> {
    let token = st.0.auth.new_session(&user.id).await?;
    resp.headers_mut()
        .append(header::SET_COOKIE, set_cookie(&st.0.auth.config, SESSION_COOKIE, &token, SESSION_TTL, "/"));
    Ok(resp)
}

// ------------------------------------------------------------------- middleware

/// Protegge le API: richiede una sessione valida e verifica che le risorse appartengano all'utente.
pub async fn require_user(State(st): State<AppState>, mut req: Request, next: Next) -> Response {
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|c| c.0.ip().to_string());
    req.headers_mut().remove(PEER_HEADER);
    if let Some(ip) = peer.and_then(|p| HeaderValue::from_str(&p).ok()) {
        req.headers_mut().insert(PEER_HEADER, ip);
    }
    let path = req.uri().path().to_owned();
    if !path.starts_with("/api/") || path.starts_with("/api/auth/") || path.starts_with("/api/public/") || path == "/api/health" {
        return next.run(req).await;
    }
    let Some(user) = current_user(&st, req.headers()).await else {
        return AppError(StatusCode::UNAUTHORIZED, "accesso richiesto".into()).into_response();
    };
    if !crate::owns_path(&st, &user, &path) {
        return AppError(StatusCode::NOT_FOUND, "non trovato".into()).into_response();
    }
    st.0.auth.touch(&user.id).await;
    let method = req.method().clone();
    // la descrizione si calcola prima: dopo un'eliminazione il nome non c'è più
    let action = crate::admin::describe(&st, &method, &path);
    let client = Client::from_headers(req.headers());
    req.extensions_mut().insert(user.clone());
    let resp = next.run(req).await;
    if let Some(detail) = action {
        let status = resp.status().as_u16();
        st.0.auth.log_event(Some(&user.id), &user.email, "action", &detail, &format!("{method} {path}"), status, &client).await;
    }
    resp
}

// --------------------------------------------------------------------- handler

#[derive(Serialize)]
pub struct AuthInfo {
    google: bool,
    email_verification: bool,
    allow_registration: bool,
    invite_requests: bool,
}

pub async fn config(State(st): State<AppState>) -> Json<AuthInfo> {
    let c = &st.0.auth.config;
    Json(AuthInfo {
        google: c.google.is_some(),
        email_verification: c.email_verification,
        allow_registration: c.allow_registration || st.0.auth.no_users().await,
        invite_requests: c.invite_requests,
    })
}

pub async fn me(State(st): State<AppState>, headers: HeaderMap) -> Result<Json<User>, AppError> {
    current_user(&st, &headers)
        .await
        .map(Json)
        .ok_or_else(|| AppError(StatusCode::UNAUTHORIZED, "accesso richiesto".into()))
}

fn valid_email(e: &str) -> bool {
    let Some((local, domain)) = e.split_once('@') else { return false };
    e.len() <= 254
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !e.chars().any(|c| c.is_whitespace() || c == '<' || c == '>')
        && !domain.contains('@')
}

fn check_password(pw: &str) -> Result<(), AppError> {
    let n = pw.chars().count();
    if !(8..=128).contains(&n) {
        return Err(bad_request("la password deve avere tra 8 e 128 caratteri"));
    }
    if !pw.chars().any(|c| c.is_alphabetic()) || !pw.chars().any(|c| !c.is_alphabetic()) {
        return Err(bad_request("la password deve contenere lettere e almeno un numero o simbolo"));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Msg {
    message: String,
}

fn msg(m: impl Into<String>) -> Json<Msg> {
    Json(Msg { message: m.into() })
}

#[derive(Deserialize)]
pub struct RegisterBody {
    email: String,
    password: String,
    name: Option<String>,
    /// token del link d'invito: registrazione permessa anche se chiusa, email già verificata
    #[serde(default)]
    invite: Option<String>,
}

pub async fn register(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<RegisterBody>) -> Result<Response, AppError> {
    let auth = &st.0.auth;
    let client = Client::from_headers(&headers);
    let email = b.email.trim().to_lowercase();
    let invite = match b.invite.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => {
            let Some(inv) = auth.invite_by_token(t).await else {
                return Err(bad_request("invito scaduto o già usato: chiedine uno nuovo"));
            };
            if !inv.1.eq_ignore_ascii_case(&email) {
                return Err(bad_request(format!("l'invito è per {}", inv.1)));
            }
            Some(inv)
        }
        None => None,
    };
    if invite.is_none() && !auth.config.allow_registration && !auth.no_users().await {
        return Err(AppError(StatusCode::FORBIDDEN, "la registrazione è disabilitata".into()));
    }
    if !valid_email(&email) {
        return Err(bad_request("indirizzo email non valido"));
    }
    check_password(&b.password)?;
    let name = b
        .name
        .map(|n| n.trim().chars().take(80).collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| email.split('@').next().unwrap_or("utente").to_owned());
    if let Some(u) = auth.user_where("email", &email).await? {
        // Messaggio neutro: non rivela se l'indirizzo è già registrato.
        if u.email_verified {
            info!("registrazione: {email} è già registrato e confermato, nessuna email inviata");
        } else {
            info!("registrazione: {email} è già registrato ma non confermato, rinvio il link");
            if let Err(e) = auth.send_verification(&u, wants_en(&headers)).await {
                warn!("invio verifica a {}: {e:#}", u.email);
            }
        }
        return Ok(msg("Se l'indirizzo è valido riceverai un'email per confermare l'account.").into_response());
    }
    let hash = hash_password(b.password).await?;
    // con l'invito l'indirizzo è quello a cui l'amministratore l'ha mandato
    let verified = !auth.config.email_verification || invite.is_some();
    let admin = invite.as_ref().is_some_and(|i| i.2 == "admin");
    let (user, first) = auth.create_user_as(&email, &name, Some(&hash), verified, None, admin).await?;
    info!("nuovo utente {} ({})", user.email, if user.is_admin { "amministratore" } else { "utente" });
    if let Some(inv) = &invite {
        auth.use_invite(&inv.0, &user.id).await;
    }
    auth.log_event(Some(&user.id), &user.email, "register", if invite.is_some() { "invito" } else { "" }, "", 200, &client).await;
    if first {
        crate::adopt_orphans(&st, &user.id);
    }
    if verified {
        auth.logged_in(&user, "registrazione", &client).await;
        return with_session(&st, &user, Json(&user).into_response()).await;
    }
    if let Err(e) = auth.send_verification(&user, wants_en(&headers)).await {
        warn!("invio verifica a {}: {e:#}", user.email);
    }
    Ok(msg("Se l'indirizzo è valido riceverai un'email per confermare l'account.").into_response())
}

#[derive(Deserialize)]
pub struct TokenQuery {
    token: String,
}

#[derive(Serialize)]
pub struct InviteInfo {
    email: String,
}

/// GET /api/auth/invite?token= — l'invito è valido? (per precompilare la registrazione)
pub async fn invite_info(State(st): State<AppState>, Query(q): Query<TokenQuery>) -> Result<Json<InviteInfo>, AppError> {
    let (_, email, _) = st
        .0
        .auth
        .invite_by_token(&q.token)
        .await
        .ok_or_else(|| bad_request("invito scaduto o già usato: chiedine uno nuovo"))?;
    Ok(Json(InviteInfo { email }))
}

pub async fn verify(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<TokenQuery>) -> Result<Response, AppError> {
    let auth = &st.0.auth;
    let Some(uid) = auth.take_token(&q.token, "verify").await? else {
        return Ok(Redirect::to("/?auth_error=link_scaduto").into_response());
    };
    auth.exec("UPDATE users SET email_verified = TRUE WHERE id = $1", &[&uid]).await?;
    let user = auth.user_where("id", &uid).await?.ok_or_else(crate::not_found)?;
    info!("email verificata: {}", user.email);
    let client = Client::from_headers(&headers);
    auth.log_event(Some(&user.id), &user.email, "verify", "", "", 200, &client).await;
    auth.logged_in(&user, "conferma email", &client).await;
    with_session(&st, &user, Redirect::to("/?verified=1").into_response()).await
}

#[derive(Deserialize)]
pub struct EmailBody {
    email: String,
}

pub async fn resend(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<EmailBody>) -> Result<Json<Msg>, AppError> {
    let auth = &st.0.auth;
    let email = b.email.trim().to_lowercase();
    match auth.user_where("email", &email).await? {
        Some(u) if !u.email_verified => {
            if let Err(e) = auth.send_verification(&u, wants_en(&headers)).await {
                warn!("invio verifica a {}: {e:#}", u.email);
            }
        }
        Some(_) => info!("nuovo link di verifica: {email} è già confermato, nessuna email inviata"),
        None => info!("nuovo link di verifica: nessun account per {email}"),
    }
    Ok(msg("Se l'account esiste e non è ancora confermato, ti abbiamo inviato un nuovo link."))
}

#[derive(Deserialize)]
pub struct LoginBody {
    email: String,
    password: String,
}

pub async fn login(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<LoginBody>) -> Result<Response, AppError> {
    let auth = &st.0.auth;
    let client = Client::from_headers(&headers);
    let key = b.email.trim().to_lowercase();
    if auth.locked(&key) {
        return Err(AppError(StatusCode::TOO_MANY_REQUESTS, "troppi tentativi: riprova tra qualche minuto".into()));
    }
    let wrong = || AppError(StatusCode::UNAUTHORIZED, "email o password non corretti".into());
    let user = auth.user_where("email", &key).await?;
    let hash = match &user {
        Some(u) => auth.password_hash(&u.id).await?,
        None => None,
    };
    let ok = match hash {
        Some(h) => verify_password(b.password, h).await,
        None => {
            // tempo costante anche per utenti inesistenti
            let _ = hash_password(b.password).await;
            false
        }
    };
    if !ok {
        auth.record_failure(&key);
        auth.log_event(user.as_ref().map(|u| u.id.as_str()), &key, "login_failed", "password errata", "", 401, &client).await;
        return Err(wrong());
    }
    let user = user.unwrap();
    if auth.is_disabled(&user.id).await {
        auth.log_event(Some(&user.id), &user.email, "login_failed", "account disattivato", "", 423, &client).await;
        return Err(AppError(StatusCode::LOCKED, "account disattivato: contatta l'amministratore".into()));
    }
    if !user.email_verified {
        auth.log_event(Some(&user.id), &user.email, "login_failed", "email non confermata", "", 403, &client).await;
        return Err(AppError(StatusCode::FORBIDDEN, "email non ancora confermata: controlla la posta".into()));
    }
    auth.clear_failures(&key);
    info!("accesso: {}", user.email);
    auth.logged_in(&user, "password", &client).await;
    with_session(&st, &user, Json(&user).into_response()).await
}

pub async fn logout(State(st): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    if let Some(u) = current_user(&st, &headers).await {
        st.0.auth.log_event(Some(&u.id), &u.email, "logout", "", "", 200, &Client::from_headers(&headers)).await;
    }
    for t in cookies(&headers, SESSION_COOKIE) {
        st.0.auth.exec("DELETE FROM sessions WHERE token_hash = $1", &[&sha256_hex(&t)]).await?;
    }
    let mut resp = StatusCode::NO_CONTENT.into_response();
    resp.headers_mut()
        .append(header::SET_COOKIE, set_cookie(&st.0.auth.config, SESSION_COOKIE, "", 0, "/"));
    Ok(resp)
}

pub async fn forgot(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<EmailBody>) -> Result<Json<Msg>, AppError> {
    let auth = &st.0.auth;
    let email = b.email.trim().to_lowercase();
    match auth.user_where("email", &email).await? {
        Some(u) => {
            if let Err(e) = auth.send_reset(&u, wants_en(&headers)).await {
                warn!("invio reset a {}: {e:#}", u.email);
            }
        }
        None => info!("password dimenticata: nessun account per {email}"),
    }
    Ok(msg("Se l'indirizzo è registrato riceverai un'email con il link per reimpostare la password."))
}

#[derive(Deserialize)]
pub struct ResetBody {
    token: String,
    password: String,
}

pub async fn reset(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<ResetBody>) -> Result<Response, AppError> {
    check_password(&b.password)?;
    let auth = &st.0.auth;
    let Some(uid) = auth.take_token(&b.token, "reset").await? else {
        return Err(bad_request("link scaduto o già usato: richiedine uno nuovo"));
    };
    let hash = hash_password(b.password).await?;
    // il link è arrivato via email: l'indirizzo è verificato; le altre sessioni vengono chiuse
    auth.exec("UPDATE users SET password_hash = $1, email_verified = TRUE WHERE id = $2", &[&hash, &uid]).await?;
    auth.exec("DELETE FROM sessions WHERE user_id = $1", &[&uid]).await?;
    let user = auth.user_where("id", &uid).await?.ok_or_else(crate::not_found)?;
    auth.clear_failures(&user.email);
    info!("password reimpostata: {}", user.email);
    let client = Client::from_headers(&headers);
    auth.log_event(Some(&user.id), &user.email, "reset", "", "", 200, &client).await;
    if auth.is_disabled(&user.id).await {
        return Err(AppError(StatusCode::LOCKED, "account disattivato: contatta l'amministratore".into()));
    }
    auth.logged_in(&user, "nuova password", &client).await;
    with_session(&st, &user, Json(&user).into_response()).await
}

#[derive(Deserialize)]
pub struct ChangePasswordBody {
    current: Option<String>,
    password: String,
}

/// Cambio password da utente autenticato (gli account solo-Google possono impostarne una).
pub async fn change_password(
    State(st): State<AppState>,
    Extension(user): Extension<User>,
    Json(b): Json<ChangePasswordBody>,
) -> Result<Json<Msg>, AppError> {
    check_password(&b.password)?;
    let auth = &st.0.auth;
    if let Some(h) = auth.password_hash(&user.id).await? {
        if !verify_password(b.current.unwrap_or_default(), h).await {
            return Err(AppError(StatusCode::UNAUTHORIZED, "password attuale non corretta".into()));
        }
    }
    let hash = hash_password(b.password).await?;
    auth.exec("UPDATE users SET password_hash = $1 WHERE id = $2", &[&hash, &user.id]).await?;
    Ok(msg("Password aggiornata."))
}

// ------------------------------------------------------------- richieste d'invito

/// Richieste d'invito accettate per IP e in totale in un'ora (protegge la casella degli amministratori).
const REQUESTS_PER_IP: u32 = 3;
const REQUESTS_TOTAL: u32 = 20;
const REQUESTS_WINDOW: u64 = 3600;
/// Dopo un rifiuto, per 30 giorni le nuove richieste dallo stesso indirizzo vengono ignorate.
const REJECTED_COOLDOWN: u64 = 30 * 24 * 3600;

impl Auth {
    /// true se la richiesta rientra nei limiti (e la conta).
    fn allow_request(&self, ip: &str) -> bool {
        let mut m = self.requests.lock().unwrap();
        let t = now();
        for (key, max) in [(format!("ip:{ip}"), REQUESTS_PER_IP), ("*".to_owned(), REQUESTS_TOTAL)] {
            let e = m.entry(key).or_insert((0, t));
            if t - e.1 >= REQUESTS_WINDOW {
                *e = (0, t);
            }
            if e.0 >= max {
                return false;
            }
        }
        for key in [format!("ip:{ip}"), "*".to_owned()] {
            if let Some(e) = m.get_mut(&key) {
                e.0 += 1;
            }
        }
        m.retain(|_, (_, since)| t - *since < REQUESTS_WINDOW);
        true
    }

    /// Email a tutti gli amministratori attivi: c'è una nuova richiesta d'invito da valutare.
    async fn notify_admins(&self, name: &str, email: &str, message: &str, en: bool) {
        let admins = match self.query("SELECT email::text FROM users WHERE is_admin AND NOT disabled", &[]).await {
            Ok(r) => r.iter().map(|r| r.get::<_, String>(0)).collect::<Vec<_>>(),
            Err(e) => {
                warn!("richiesta d'invito: elenco amministratori: {e:#}");
                return;
            }
        };
        let link = format!("{}/?admin=requests", self.config.public_url);
        let note = if message.is_empty() { String::new() } else { format!("\n\n“{message}”") };
        let (subject, text) = if en {
            ("Review the invite request", format!("{name} <{email}> asked for an invite to Noises.{note}\n\nOpen the administration to approve or reject the request (you need to be signed in)."))
        } else {
            ("Valuta la richiesta d'invito", format!("{name} <{email}> ha chiesto un invito a Noises.{note}\n\nApri l'amministrazione per approvare o rifiutare la richiesta (serve l'accesso)."))
        };
        for a in admins {
            if let Err(e) = self.mailer.send(&a, subject, &text, &link, en).await {
                warn!("richiesta d'invito: email a {a}: {e:#}");
            }
        }
    }
}

#[derive(Deserialize)]
pub struct InviteRequestBody {
    email: String,
    name: String,
    #[serde(default)]
    message: String,
}

/// POST /api/auth/request-invite — chi non ha un account chiede di essere invitato (ALLOW_INVITE_REQUESTS).
/// La risposta è sempre la stessa: non rivela se l'indirizzo è già registrato o ha già una richiesta.
pub async fn request_invite(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<InviteRequestBody>) -> Result<Json<Msg>, AppError> {
    let auth = &st.0.auth;
    if !auth.config.invite_requests {
        return Err(AppError(StatusCode::NOT_FOUND, "richieste d'invito non attive".into()));
    }
    let email = b.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(bad_request("indirizzo email non valido"));
    }
    let name: String = b.name.trim().chars().take(80).collect();
    if name.is_empty() {
        return Err(bad_request("inserisci il tuo nome"));
    }
    let message: String = b.message.trim().chars().take(1000).collect();
    let client = Client::from_headers(&headers);
    if !auth.allow_request(&client.ip) {
        return Err(AppError(StatusCode::TOO_MANY_REQUESTS, "troppe richieste: riprova più tardi".into()));
    }
    let done = || Ok(msg("Richiesta inviata. Se verrà approvata riceverai un'email con il link per creare l'account."));
    if auth.user_where("email", &email).await?.is_some() {
        info!("richiesta d'invito: {email} ha già un account, nessuna email");
        return done();
    }
    // rifiutata di recente: niente nuova richiesta né email agli amministratori (risposta identica)
    let rejected = auth
        .query_opt(
            "SELECT 1 FROM invite_requests WHERE email = $1 AND status = 'rejected' AND decided_at > $2 LIMIT 1",
            &[&email, &ts(now().saturating_sub(REJECTED_COOLDOWN))],
        )
        .await?
        .is_some();
    if rejected {
        info!("richiesta d'invito: {email} è stata rifiutata da meno di 30 giorni, ignorata");
        return done();
    }
    let en = wants_en(&headers);
    let id = uuid::Uuid::new_v4().to_string();
    let lang = if en { "en" } else { "it" };
    // ON CONFLICT: se c'è già una richiesta in attesa per l'indirizzo non se ne crea un'altra (né altre email)
    let inserted = auth
        .exec(
            "INSERT INTO invite_requests (id, email, name, message, lang, ip, ua, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (email) WHERE status = 'pending' DO NOTHING",
            &[&id, &email, &name, &message, &lang, &client.ip, &client.ua, &ts(now())],
        )
        .await?;
    if inserted == 0 {
        info!("richiesta d'invito: {email} ne ha già una in attesa");
        return done();
    }
    info!("richiesta d'invito da {name} <{email}>");
    auth.log_event(None, &email, "invite_request", &name, "", 200, &client).await;
    // in background: la risposta non deve aspettare l'SMTP (né far capire dai tempi se l'indirizzo esiste)
    let st2 = st.clone();
    tokio::spawn(async move { st2.0.auth.notify_admins(&name, &email, &message, en).await });
    done()
}

// ------------------------------------------------------------------- Google SSO

fn b64url(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

pub async fn google_login(State(st): State<AppState>) -> Result<Response, AppError> {
    let cfg = &st.0.auth.config;
    let Some((client_id, _)) = &cfg.google else {
        return Err(AppError(StatusCode::NOT_FOUND, "accesso con Google non configurato".into()));
    };
    let state = random_token();
    let verifier = random_token(); // 64 caratteri esadecimali: valido come code_verifier PKCE
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let url = reqwest::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", &format!("{}/api/auth/google/callback", cfg.public_url)),
            ("response_type", "code"),
            ("scope", "openid email profile"),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("prompt", "select_account"),
        ],
    )
    .map_err(anyhow::Error::from)?;
    let mut resp = Redirect::to(url.as_str()).into_response();
    resp.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(cfg, OAUTH_COOKIE, &format!("{state}.{verifier}"), 600, "/api/auth/google"),
    );
    Ok(resp)
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct GoogleUser {
    sub: String,
    email: String,
    #[serde(default)]
    email_verified: bool,
    name: Option<String>,
}

pub async fn google_callback(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Response {
    let fail = |code: &str| Redirect::to(&format!("/?auth_error={code}")).into_response();
    if q.error.is_some() {
        return fail("google_annullato");
    }
    let (Some(code), Some(state)) = (q.code, q.state) else { return fail("google_errore") };
    let Some((exp_state, verifier)) = cookie(&headers, OAUTH_COOKIE)
        .and_then(|c| c.split_once('.').map(|(a, b)| (a.to_owned(), b.to_owned())))
    else {
        return fail("google_sessione_scaduta");
    };
    if exp_state != state {
        return fail("google_stato_non_valido");
    }
    match google_finish(&st, &code, &verifier).await {
        Ok(user) if st.0.auth.is_disabled(&user.id).await => {
            st.0.auth.log_event(Some(&user.id), &user.email, "login_failed", "account disattivato (Google)", "", 423, &Client::from_headers(&headers)).await;
            fail("account_disattivato")
        }
        Ok(user) => {
            st.0.auth.logged_in(&user, "Google", &Client::from_headers(&headers)).await;
            let mut resp = match with_session(&st, &user, Redirect::to("/").into_response()).await {
                Ok(r) => r,
                Err(_) => return fail("google_errore"),
            };
            resp.headers_mut()
                .append(header::SET_COOKIE, set_cookie(&st.0.auth.config, OAUTH_COOKIE, "", 0, "/api/auth/google"));
            resp
        }
        Err(e) => {
            warn!("accesso Google fallito: {e:#}");
            fail("google_errore")
        }
    }
}

async fn google_finish(st: &AppState, code: &str, verifier: &str) -> anyhow::Result<User> {
    let auth = &st.0.auth;
    let (client_id, secret) = auth.config.google.as_ref().context("Google non configurato")?;
    let token: TokenResponse = auth
        .http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", secret),
            ("redirect_uri", &format!("{}/api/auth/google/callback", auth.config.public_url)),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
        ])
        .send()
        .await?
        .error_for_status()
        .context("scambio del codice")?
        .json()
        .await?;
    let gu: GoogleUser = auth
        .http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&token.access_token)
        .send()
        .await?
        .error_for_status()
        .context("lettura profilo")?
        .json()
        .await?;
    if !gu.email_verified {
        anyhow::bail!("email Google non verificata");
    }
    let email = gu.email.to_lowercase();
    if let Some(u) = auth.user_where("google_sub", &gu.sub).await? {
        return Ok(u);
    }
    if let Some(u) = auth.user_where("email", &email).await? {
        // stesso indirizzo (verificato da Google): collega l'account esistente
        auth.exec("UPDATE users SET google_sub = $1, email_verified = TRUE WHERE id = $2", &[&gu.sub, &u.id]).await?;
        info!("account Google collegato a {}", u.email);
        return Ok(auth.user_where("id", &u.id).await?.context("utente")?);
    }
    let invite = auth.invite_for_email(&email).await;
    if invite.is_none() && !auth.config.allow_registration && !auth.no_users().await {
        anyhow::bail!("registrazione disabilitata");
    }
    let name = gu.name.unwrap_or_else(|| email.split('@').next().unwrap_or("utente").to_owned());
    let admin = invite.as_ref().is_some_and(|i| i.1 == "admin");
    let (user, first) = auth.create_user_as(&email, &name, None, true, Some(&gu.sub), admin).await?;
    if let Some(inv) = &invite {
        auth.use_invite(&inv.0, &user.id).await;
    }
    auth.log_event(Some(&user.id), &user.email, "register", if invite.is_some() { "invito, Google" } else { "Google" }, "", 200, &Client::default()).await;
    info!("nuovo utente Google {}", user.email);
    if first {
        crate::adopt_orphans(st, &user.id);
    }
    Ok(user)
}
