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
    time::{SystemTime, UNIX_EPOCH},
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
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::{bad_request, AppError, AppState};

const SESSION_COOKIE: &str = "noises_session";
const OAUTH_COOKIE: &str = "noises_oauth";
const SESSION_TTL: u64 = 30 * 24 * 3600;
const VERIFY_TTL: u64 = 48 * 3600;
const RESET_TTL: u64 = 3600;
const MAX_FAILURES: u32 = 8;
const LOCKOUT_SECS: u64 = 15 * 60;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn random_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    hex(&b)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn sha256_hex(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}

// ---------------------------------------------------------------- configurazione

pub struct AuthConfig {
    pub public_url: String,
    pub google: Option<(String, String)>,
    pub email_verification: bool,
    pub allow_registration: bool,
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
        .port(port);
        if let (Some(u), Some(p)) = (env("SMTP_USER"), env("SMTP_PASSWORD")) {
            builder = builder.credentials(Credentials::new(u, p));
        }
        info!("email via SMTP {host}:{port}");
        Ok(Mailer { transport: Some(builder.build()), from })
    }

    async fn send(&self, to: &str, subject: &str, text: &str, link: &str) -> anyhow::Result<()> {
        let Some(t) = &self.transport else {
            warn!("[email non inviata — SMTP assente] a {to}: {subject} → {link}");
            return Ok(());
        };
        let html = format!(
            "<div style=\"font-family:system-ui,sans-serif;max-width:520px\">\
             <h2 style=\"color:#7c5cff\">Noises</h2><p>{}</p>\
             <p><a href=\"{link}\" style=\"display:inline-block;padding:10px 18px;background:#7c5cff;\
             color:#fff;border-radius:8px;text-decoration:none\">{subject}</a></p>\
             <p style=\"color:#888;font-size:12px\">Se il pulsante non funziona copia questo indirizzo:<br>{link}</p></div>",
            text.replace('\n', "<br>")
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
        t.send(msg).await.context("invio email")?;
        info!("email '{subject}' inviata a {to}");
        Ok(())
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
    db: Mutex<Connection>,
    pub config: AuthConfig,
    mailer: Mailer,
    http: reqwest::Client,
    failures: Mutex<HashMap<String, (u32, u64)>>,
}

const USER_COLS: &str = "id, email, name, email_verified, is_admin, password_hash IS NOT NULL, google_sub IS NOT NULL";

fn row_user(r: &rusqlite::Row) -> rusqlite::Result<User> {
    Ok(User {
        id: r.get(0)?,
        email: r.get(1)?,
        name: r.get(2)?,
        email_verified: r.get(3)?,
        is_admin: r.get(4)?,
        has_password: r.get(5)?,
        google: r.get(6)?,
    })
}

impl Auth {
    pub fn open(data_dir: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(data_dir.join("noises.db"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS users (
               id TEXT PRIMARY KEY,
               email TEXT NOT NULL UNIQUE COLLATE NOCASE,
               name TEXT NOT NULL,
               password_hash TEXT,
               email_verified INTEGER NOT NULL DEFAULT 0,
               google_sub TEXT UNIQUE,
               is_admin INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS sessions (
               token_hash TEXT PRIMARY KEY,
               user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
               expires_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS tokens (
               token_hash TEXT PRIMARY KEY,
               user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
               kind TEXT NOT NULL,
               expires_at INTEGER NOT NULL);",
        )?;
        conn.execute("DELETE FROM sessions WHERE expires_at < ?1", params![now()])?;
        conn.execute("DELETE FROM tokens WHERE expires_at < ?1", params![now()])?;
        let config = AuthConfig::from_env();
        info!(
            "autenticazione: url pubblico {}, Google SSO {}, verifica email {}, registrazione {}",
            config.public_url,
            if config.google.is_some() { "attivo" } else { "non configurato" },
            config.email_verification,
            config.allow_registration
        );
        Ok(Auth {
            db: Mutex::new(conn),
            config,
            mailer: Mailer::from_env()?,
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?,
            failures: Mutex::default(),
        })
    }

    fn user_where(&self, cond: &str, value: &str) -> anyhow::Result<Option<User>> {
        let db = self.db.lock().unwrap();
        Ok(db
            .query_row(&format!("SELECT {USER_COLS} FROM users WHERE {cond} = ?1"), params![value], row_user)
            .optional()?)
    }

    fn password_hash(&self, user_id: &str) -> anyhow::Result<Option<String>> {
        let db = self.db.lock().unwrap();
        Ok(db
            .query_row("SELECT password_hash FROM users WHERE id = ?1", params![user_id], |r| r.get(0))
            .optional()?
            .flatten())
    }

    /// Crea un utente; il primo diventa amministratore. Restituisce (utente, è_il_primo).
    fn create_user(
        &self,
        email: &str,
        name: &str,
        password_hash: Option<&str>,
        verified: bool,
        google_sub: Option<&str>,
    ) -> anyhow::Result<(User, bool)> {
        let db = self.db.lock().unwrap();
        let first: i64 = db.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO users (id, email, name, password_hash, email_verified, google_sub, is_admin, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, email, name, password_hash, verified, google_sub, first == 0, now()],
        )?;
        let user = db.query_row(&format!("SELECT {USER_COLS} FROM users WHERE id = ?1"), params![id], row_user)?;
        Ok((user, first == 0))
    }

    fn exec(&self, sql: &str, p: impl rusqlite::Params) -> anyhow::Result<usize> {
        Ok(self.db.lock().unwrap().execute(sql, p)?)
    }

    fn new_session(&self, user_id: &str) -> anyhow::Result<String> {
        let token = random_token();
        self.exec(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
            params![sha256_hex(&token), user_id, now() + SESSION_TTL],
        )?;
        Ok(token)
    }

    pub fn session_user(&self, token: &str) -> Option<User> {
        let db = self.db.lock().unwrap();
        db.query_row(
            &format!(
                "SELECT {} FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ?1 AND s.expires_at > ?2",
                USER_COLS.split(", ").map(|c| format!("u.{c}")).collect::<Vec<_>>().join(", ")
            ),
            params![sha256_hex(token), now()],
            row_user,
        )
        .optional()
        .ok()
        .flatten()
    }

    fn new_token(&self, user_id: &str, kind: &str, ttl: u64) -> anyhow::Result<String> {
        let token = random_token();
        self.exec("DELETE FROM tokens WHERE user_id = ?1 AND kind = ?2", params![user_id, kind])?;
        self.exec(
            "INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?1, ?2, ?3, ?4)",
            params![sha256_hex(&token), user_id, kind, now() + ttl],
        )?;
        Ok(token)
    }

    /// Consuma un token monouso e restituisce l'utente a cui appartiene.
    fn take_token(&self, token: &str, kind: &str) -> anyhow::Result<Option<String>> {
        let db = self.db.lock().unwrap();
        let h = sha256_hex(token);
        let uid: Option<String> = db
            .query_row(
                "SELECT user_id FROM tokens WHERE token_hash = ?1 AND kind = ?2 AND expires_at > ?3",
                params![h, kind, now()],
                |r| r.get(0),
            )
            .optional()?;
        db.execute("DELETE FROM tokens WHERE token_hash = ?1", params![h])?;
        Ok(uid)
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

    async fn send_verification(&self, user: &User) -> anyhow::Result<()> {
        let token = self.new_token(&user.id, "verify", VERIFY_TTL)?;
        let link = format!("{}/api/auth/verify?token={token}", self.config.public_url);
        self.mailer
            .send(
                &user.email,
                "Conferma il tuo account",
                &format!("Ciao {},\nper attivare il tuo account Noises conferma l'indirizzo email.\nIl link scade tra 48 ore.", user.name),
                &link,
            )
            .await
    }

    async fn send_reset(&self, user: &User) -> anyhow::Result<()> {
        let token = self.new_token(&user.id, "reset", RESET_TTL)?;
        let link = format!("{}/?reset={token}", self.config.public_url);
        self.mailer
            .send(
                &user.email,
                "Reimposta la password",
                &format!("Ciao {},\nabbiamo ricevuto una richiesta di reimpostazione della password.\nIl link scade tra un'ora. Se non sei stato tu, ignora questo messaggio.", user.name),
                &link,
            )
            .await
    }
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

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
}

fn set_cookie(cfg: &AuthConfig, name: &str, value: &str, max_age: u64, path: &str) -> HeaderValue {
    let secure = if cfg.secure_cookie { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={value}; Path={path}; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}"
    ))
    .unwrap()
}

fn with_session(st: &AppState, user: &User, mut resp: Response) -> Result<Response, AppError> {
    let token = st.0.auth.new_session(&user.id)?;
    resp.headers_mut()
        .append(header::SET_COOKIE, set_cookie(&st.0.auth.config, SESSION_COOKIE, &token, SESSION_TTL, "/"));
    Ok(resp)
}

// ------------------------------------------------------------------- middleware

/// Protegge le API: richiede una sessione valida e verifica che le risorse appartengano all'utente.
pub async fn require_user(State(st): State<AppState>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    if !path.starts_with("/api/") || path.starts_with("/api/auth/") || path == "/api/health" {
        return next.run(req).await;
    }
    let user = cookie(req.headers(), SESSION_COOKIE).and_then(|t| st.0.auth.session_user(&t));
    let Some(user) = user else {
        return AppError(StatusCode::UNAUTHORIZED, "accesso richiesto".into()).into_response();
    };
    if !crate::owns_path(&st, &user, &path) {
        return AppError(StatusCode::NOT_FOUND, "non trovato".into()).into_response();
    }
    req.extensions_mut().insert(user);
    next.run(req).await
}

// --------------------------------------------------------------------- handler

#[derive(Serialize)]
pub struct AuthInfo {
    google: bool,
    email_verification: bool,
    allow_registration: bool,
}

pub async fn config(State(st): State<AppState>) -> Json<AuthInfo> {
    let c = &st.0.auth.config;
    Json(AuthInfo {
        google: c.google.is_some(),
        email_verification: c.email_verification,
        allow_registration: c.allow_registration,
    })
}

pub async fn me(State(st): State<AppState>, headers: HeaderMap) -> Result<Json<User>, AppError> {
    cookie(&headers, SESSION_COOKIE)
        .and_then(|t| st.0.auth.session_user(&t))
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
}

pub async fn register(State(st): State<AppState>, Json(b): Json<RegisterBody>) -> Result<Response, AppError> {
    let auth = &st.0.auth;
    if !auth.config.allow_registration {
        return Err(AppError(StatusCode::FORBIDDEN, "la registrazione è disabilitata".into()));
    }
    let email = b.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(bad_request("indirizzo email non valido"));
    }
    check_password(&b.password)?;
    let name = b
        .name
        .map(|n| n.trim().chars().take(80).collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| email.split('@').next().unwrap_or("utente").to_owned());
    if auth.user_where("email", &email)?.is_some() {
        // Messaggio neutro: non rivela se l'indirizzo è già registrato.
        return Ok(msg("Se l'indirizzo è valido riceverai un'email per confermare l'account.").into_response());
    }
    let hash = hash_password(b.password).await?;
    let verified = !auth.config.email_verification;
    let (user, first) = auth.create_user(&email, &name, Some(&hash), verified, None)?;
    info!("nuovo utente {} ({})", user.email, if first { "amministratore" } else { "utente" });
    if first {
        crate::adopt_orphans(&st, &user.id);
    }
    if verified {
        return with_session(&st, &user, Json(&user).into_response());
    }
    if let Err(e) = auth.send_verification(&user).await {
        warn!("invio verifica a {}: {e:#}", user.email);
    }
    Ok(msg("Se l'indirizzo è valido riceverai un'email per confermare l'account.").into_response())
}

#[derive(Deserialize)]
pub struct TokenQuery {
    token: String,
}

pub async fn verify(State(st): State<AppState>, Query(q): Query<TokenQuery>) -> Result<Response, AppError> {
    let auth = &st.0.auth;
    let Some(uid) = auth.take_token(&q.token, "verify")? else {
        return Ok(Redirect::to("/?auth_error=link_scaduto").into_response());
    };
    auth.exec("UPDATE users SET email_verified = 1 WHERE id = ?1", params![uid])?;
    let user = auth.user_where("id", &uid)?.ok_or_else(crate::not_found)?;
    info!("email verificata: {}", user.email);
    with_session(&st, &user, Redirect::to("/?verified=1").into_response())
}

#[derive(Deserialize)]
pub struct EmailBody {
    email: String,
}

pub async fn resend(State(st): State<AppState>, Json(b): Json<EmailBody>) -> Result<Json<Msg>, AppError> {
    let auth = &st.0.auth;
    if let Some(u) = auth.user_where("email", b.email.trim())? {
        if !u.email_verified {
            if let Err(e) = auth.send_verification(&u).await {
                warn!("invio verifica a {}: {e:#}", u.email);
            }
        }
    }
    Ok(msg("Se l'account esiste e non è ancora confermato, ti abbiamo inviato un nuovo link."))
}

#[derive(Deserialize)]
pub struct LoginBody {
    email: String,
    password: String,
}

pub async fn login(State(st): State<AppState>, Json(b): Json<LoginBody>) -> Result<Response, AppError> {
    let auth = &st.0.auth;
    let key = b.email.trim().to_lowercase();
    if auth.locked(&key) {
        return Err(AppError(StatusCode::TOO_MANY_REQUESTS, "troppi tentativi: riprova tra qualche minuto".into()));
    }
    let wrong = || AppError(StatusCode::UNAUTHORIZED, "email o password non corretti".into());
    let user = auth.user_where("email", &key)?;
    let hash = match &user {
        Some(u) => auth.password_hash(&u.id)?,
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
        return Err(wrong());
    }
    let user = user.unwrap();
    if !user.email_verified {
        return Err(AppError(StatusCode::FORBIDDEN, "email non ancora confermata: controlla la posta".into()));
    }
    auth.clear_failures(&key);
    info!("accesso: {}", user.email);
    with_session(&st, &user, Json(&user).into_response())
}

pub async fn logout(State(st): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    if let Some(t) = cookie(&headers, SESSION_COOKIE) {
        st.0.auth.exec("DELETE FROM sessions WHERE token_hash = ?1", params![sha256_hex(&t)])?;
    }
    let mut resp = StatusCode::NO_CONTENT.into_response();
    resp.headers_mut()
        .append(header::SET_COOKIE, set_cookie(&st.0.auth.config, SESSION_COOKIE, "", 0, "/"));
    Ok(resp)
}

pub async fn forgot(State(st): State<AppState>, Json(b): Json<EmailBody>) -> Result<Json<Msg>, AppError> {
    let auth = &st.0.auth;
    if let Some(u) = auth.user_where("email", b.email.trim())? {
        if let Err(e) = auth.send_reset(&u).await {
            warn!("invio reset a {}: {e:#}", u.email);
        }
    }
    Ok(msg("Se l'indirizzo è registrato riceverai un'email con il link per reimpostare la password."))
}

#[derive(Deserialize)]
pub struct ResetBody {
    token: String,
    password: String,
}

pub async fn reset(State(st): State<AppState>, Json(b): Json<ResetBody>) -> Result<Response, AppError> {
    check_password(&b.password)?;
    let auth = &st.0.auth;
    let Some(uid) = auth.take_token(&b.token, "reset")? else {
        return Err(bad_request("link scaduto o già usato: richiedine uno nuovo"));
    };
    let hash = hash_password(b.password).await?;
    // il link è arrivato via email: l'indirizzo è verificato; le altre sessioni vengono chiuse
    auth.exec("UPDATE users SET password_hash = ?1, email_verified = 1 WHERE id = ?2", params![hash, uid])?;
    auth.exec("DELETE FROM sessions WHERE user_id = ?1", params![uid])?;
    let user = auth.user_where("id", &uid)?.ok_or_else(crate::not_found)?;
    auth.clear_failures(&user.email);
    info!("password reimpostata: {}", user.email);
    with_session(&st, &user, Json(&user).into_response())
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
    if let Some(h) = auth.password_hash(&user.id)? {
        if !verify_password(b.current.unwrap_or_default(), h).await {
            return Err(AppError(StatusCode::UNAUTHORIZED, "password attuale non corretta".into()));
        }
    }
    let hash = hash_password(b.password).await?;
    auth.exec("UPDATE users SET password_hash = ?1 WHERE id = ?2", params![hash, user.id])?;
    Ok(msg("Password aggiornata."))
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
        Ok(user) => {
            let mut resp = match with_session(&st, &user, Redirect::to("/").into_response()) {
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
    if let Some(u) = auth.user_where("google_sub", &gu.sub)? {
        return Ok(u);
    }
    if let Some(u) = auth.user_where("email", &email)? {
        // stesso indirizzo (verificato da Google): collega l'account esistente
        auth.exec(
            "UPDATE users SET google_sub = ?1, email_verified = 1 WHERE id = ?2",
            params![gu.sub, u.id],
        )?;
        info!("account Google collegato a {}", u.email);
        return Ok(auth.user_where("id", &u.id)?.context("utente")?);
    }
    if !auth.config.allow_registration {
        anyhow::bail!("registrazione disabilitata");
    }
    let name = gu.name.unwrap_or_else(|| email.split('@').next().unwrap_or("utente").to_owned());
    let (user, first) = auth.create_user(&email, &name, None, true, Some(&gu.sub))?;
    info!("nuovo utente Google {}", user.email);
    if first {
        crate::adopt_orphans(st, &user.id);
    }
    Ok(user)
}
