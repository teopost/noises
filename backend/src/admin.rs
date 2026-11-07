//! Amministrazione: utenti e ruoli, inviti, registro di accessi e attività, aggiornamenti.
//!
//! Ruoli: `admin` (gestisce utenti e inviti, vede il registro) e `user`. Il primo utente registrato
//! è amministratore. Un utente disattivato non può accedere e le sue sessioni non valgono più.

use std::{
    collections::HashMap,
    path::Path,
    sync::{OnceLock, RwLock},
};

use axum::{
    extract::{Path as UrlPath, Query, State},
    http::{Method, StatusCode},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::{
    auth::{now, random_token, sha256_hex, Client, User},
    db::{ts, u},
    bad_request, not_found, AppError, AppState,
};

const INVITE_TTL: u64 = 7 * 24 * 3600;

fn require_admin(user: &User) -> Result<(), AppError> {
    if user.is_admin {
        Ok(())
    } else {
        Err(AppError(StatusCode::FORBIDDEN, "riservato agli amministratori".into()))
    }
}

// ------------------------------------------------------------------ registro delle azioni

/// Descrizione leggibile di una richiesta che modifica qualcosa (None = da non registrare).
pub fn describe(st: &AppState, method: &Method, path: &str) -> Option<String> {
    let seg: Vec<&str> = path.trim_matches('/').split('/').collect();
    let song = |id: &str| st.get(id).map(|s| s.name).unwrap_or_default();
    let project = |id: &str| st.0.projects.read().unwrap().get(id).map(|p| p.name.clone()).unwrap_or_default();
    let with = |what: &str, name: String| if name.is_empty() { what.to_owned() } else { format!("{what}: {name}") };
    let m = method.as_str();
    let d = match (m, seg.as_slice()) {
        ("GET", ["api", "projects", id, "backup"]) => with("Backup del progetto", project(id)),
        ("GET", ..) | ("HEAD", ..) | ("OPTIONS", ..) => return None,
        ("POST", ["api", "songs"]) => "Brano caricato".into(),
        ("POST", ["api", "import"]) => "Brano importato da un link".into(),
        ("DELETE", ["api", "songs", id]) => with("Brano eliminato", song(id)),
        ("POST", ["api", "songs", id, "process"]) => with("Elaborazione avviata", song(id)),
        ("POST", ["api", "songs", id, "chords", ..]) => with("Analisi degli accordi", song(id)),
        ("POST", ["api", "songs", id, "notes", ..]) => with("Trascrizione delle note", song(id)),
        ("POST", ["api", "songs", _, "score", ..]) => return None, // solo lettura
        (_, ["api", "songs", id, "chords", ..]) => with("Accordi corretti", song(id)),
        (_, ["api", "songs", id, "notes", ..]) => with("Note corrette", song(id)),
        (_, ["api", "songs", id, "rhythm"]) => with("Ritmo modificato", song(id)),
        ("POST", ["api", "projects"]) => "Progetto creato".into(),
        ("PUT", ["api", "projects", id]) => with("Progetto modificato", project(id)),
        (_, ["api", "projects", id, "settings"]) => with("Impostazioni del progetto", project(id)),
        ("DELETE", ["api", "projects", id]) => with("Progetto eliminato", project(id)),
        ("POST", ["api", "projects", id, "export"]) => with("Esportazione", project(id)),
        ("POST", ["api", "projects", id, "shares"]) => with("Link pubblico creato o aggiornato", project(id)),
        ("DELETE", ["api", "projects", id, "shares", _]) => with("Link pubblico disattivato", project(id)),
        ("POST", ["api", "backup", "restore"]) => "Progetto ripristinato da un backup".into(),
        ("POST", ["api", "setlists"]) => "Scaletta creata".into(),
        ("PUT", ["api", "setlists", _]) => "Scaletta modificata".into(),
        ("DELETE", ["api", "setlists", _]) => "Scaletta eliminata".into(),
        (_, ["api", "playlists", ..]) => "Playlist modificata".into(),
        ("POST", ["api", "account", "password"]) => "Password cambiata".into(),
        (_, ["api", "admin", ..]) => return None, // registrate in dettaglio dagli handler
        _ => format!("{m} {path}"),
    };
    Some(d)
}

// ------------------------------------------------------------------------------ utenti

#[derive(Serialize)]
pub struct AdminUser {
    id: String,
    email: String,
    name: String,
    role: &'static str,
    disabled: bool,
    email_verified: bool,
    google: bool,
    has_password: bool,
    created_at: u64,
    last_login: Option<u64>,
    last_seen: Option<u64>,
    songs: usize,
    projects: usize,
    setlists: usize,
    shares: usize,
    bytes: u64,
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.filter_map(Result::ok)
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

/// Brani, progetti, scalette, link e spazio occupato di ogni utente.
fn usage(st: &AppState) -> HashMap<String, (usize, usize, usize, usize, u64)> {
    let mut m: HashMap<String, (usize, usize, usize, usize, u64)> = HashMap::new();
    let songs: Vec<(String, String)> = st
        .0
        .songs
        .read()
        .unwrap()
        .values()
        .filter_map(|s| s.owner.clone().map(|o| (o, s.id.clone())))
        .collect();
    for (owner, id) in songs {
        let e = m.entry(owner).or_default();
        e.0 += 1;
        e.4 += dir_size(&st.song_dir(&id));
    }
    for p in st.0.projects.read().unwrap().values() {
        if let Some(o) = &p.owner {
            m.entry(o.clone()).or_default().1 += 1;
        }
    }
    for s in st.0.setlists.read().unwrap().iter() {
        m.entry(s.owner.clone()).or_default().2 += 1;
    }
    for s in st.0.shares.read().unwrap().iter() {
        m.entry(s.owner.clone()).or_default().3 += 1;
    }
    m
}

async fn list_users_db(st: &AppState) -> anyhow::Result<Vec<AdminUser>> {
    let rows = st
        .0
        .auth
        .query(
            "SELECT id, email::text, name, is_admin, disabled, email_verified, google_sub IS NOT NULL, password_hash IS NOT NULL,
                    created_at, last_login, last_seen
             FROM users ORDER BY created_at",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| AdminUser {
            id: r.get(0),
            email: r.get(1),
            name: r.get(2),
            role: if r.get::<_, bool>(3) { "admin" } else { "user" },
            disabled: r.get(4),
            email_verified: r.get(5),
            google: r.get(6),
            has_password: r.get(7),
            created_at: u(r.get(8)),
            last_login: r.get::<_, Option<i64>>(9).map(u),
            last_seen: r.get::<_, Option<i64>>(10).map(u),
            songs: 0,
            projects: 0,
            setlists: 0,
            shares: 0,
            bytes: 0,
        })
        .collect())
}

pub async fn users(State(st): State<AppState>, Extension(me): Extension<User>) -> Result<Json<Vec<AdminUser>>, AppError> {
    require_admin(&me)?;
    let st2 = st.clone();
    let use_ = tokio::task::spawn_blocking(move || usage(&st2)).await?;
    let mut list = list_users_db(&st).await?;
    for u in &mut list {
        if let Some(x) = use_.get(&u.id) {
            (u.songs, u.projects, u.setlists, u.shares, u.bytes) = *x;
        }
    }
    Ok(Json(list))
}

#[derive(Deserialize)]
pub struct UserPatch {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    disabled: Option<bool>,
}

/// Amministratori attivi, escluso `except`.
async fn other_admins(st: &AppState, except: &str) -> anyhow::Result<i64> {
    Ok(st
        .0
        .auth
        .query_one("SELECT COUNT(*) FROM users WHERE is_admin AND NOT disabled AND id != $1", &[&except])
        .await?
        .get(0))
}

pub async fn update_user(
    State(st): State<AppState>,
    Extension(me): Extension<User>,
    UrlPath(id): UrlPath<String>,
    headers: axum::http::HeaderMap,
    Json(b): Json<UserPatch>,
) -> Result<StatusCode, AppError> {
    require_admin(&me)?;
    let auth = &st.0.auth;
    let target = auth_user(&st, &id).await?;
    let losing_admin = (b.role.as_deref() == Some("user") && target.is_admin) || (b.disabled == Some(true) && target.is_admin);
    if losing_admin && other_admins(&st, &id).await? == 0 {
        return Err(bad_request("deve restare almeno un amministratore attivo"));
    }
    if b.disabled == Some(true) && id == me.id {
        return Err(bad_request("non puoi disattivare il tuo account"));
    }
    let client = Client::from_headers(&headers);
    if let Some(r) = &b.role {
        let admin = match r.as_str() {
            "admin" => true,
            "user" => false,
            _ => return Err(bad_request("ruolo non valido")),
        };
        auth.exec("UPDATE users SET is_admin = $1 WHERE id = $2", &[&admin, &id]).await?;
        auth.log_event(Some(&me.id), &me.email, "admin", &format!("Ruolo di {} → {}", target.email, if admin { "amministratore" } else { "utente" }), "", 200, &client).await;
    }
    if let Some(d) = b.disabled {
        auth.exec("UPDATE users SET disabled = $1 WHERE id = $2", &[&d, &id]).await?;
        if d {
            auth.exec("DELETE FROM sessions WHERE user_id = $1", &[&id]).await?; // esce subito
        }
        auth.log_event(Some(&me.id), &me.email, "admin", &format!("{} {}", if d { "Disattivato" } else { "Riattivato" }, target.email), "", 200, &client).await;
    }
    info!("amministrazione: {} ha modificato {}", me.email, target.email);
    Ok(StatusCode::NO_CONTENT)
}

async fn auth_user(st: &AppState, id: &str) -> Result<User, AppError> {
    let r = st
        .0
        .auth
        .query_opt("SELECT id, email::text, name, email_verified, is_admin FROM users WHERE id = $1", &[&id])
        .await?
        .ok_or_else(not_found)?;
    Ok(User {
        id: r.get(0),
        email: r.get(1),
        name: r.get(2),
        email_verified: r.get(3),
        is_admin: r.get(4),
        has_password: false,
        google: false,
    })
}

// ------------------------------------------------------------------------------ inviti

#[derive(Serialize)]
pub struct Invite {
    id: String,
    email: String,
    role: String,
    invited_by: Option<String>,
    created_at: u64,
    expires_at: u64,
    used_at: Option<u64>,
    used_by: Option<String>,
}

pub async fn invites(State(st): State<AppState>, Extension(me): Extension<User>) -> Result<Json<Vec<Invite>>, AppError> {
    require_admin(&me)?;
    let rows = st
        .0
        .auth
        .query(
            "SELECT i.id, i.email::text, i.role, a.email::text, i.created_at, i.expires_at, i.used_at, u.email::text
             FROM invites i LEFT JOIN users a ON a.id = i.invited_by LEFT JOIN users u ON u.id = i.used_by
             ORDER BY i.created_at DESC LIMIT 200",
            &[],
        )
        .await?;
    let list = rows
        .iter()
        .map(|r| Invite {
            id: r.get(0),
            email: r.get(1),
            role: r.get(2),
            invited_by: r.get(3),
            created_at: u(r.get(4)),
            expires_at: u(r.get(5)),
            used_at: r.get::<_, Option<i64>>(6).map(u),
            used_by: r.get(7),
        })
        .collect();
    Ok(Json(list))
}

#[derive(Deserialize)]
pub struct InviteBody {
    email: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    en: bool,
}

#[derive(Serialize)]
pub struct InviteCreated {
    id: String,
    link: String,
    emailed: bool,
    email_error: Option<String>,
}

pub async fn create_invite(
    State(st): State<AppState>,
    Extension(me): Extension<User>,
    headers: axum::http::HeaderMap,
    Json(b): Json<InviteBody>,
) -> Result<Json<InviteCreated>, AppError> {
    require_admin(&me)?;
    let role = b.role.as_deref().unwrap_or("user").to_owned();
    Ok(Json(make_invite(&st, &me, &b.email, &role, b.en, &Client::from_headers(&headers)).await?))
}

/// Crea un invito e lo spedisce via email (se c'è l'SMTP); usato anche per approvare una richiesta.
async fn make_invite(st: &AppState, me: &User, email: &str, role: &str, en: bool, client: &Client) -> Result<InviteCreated, AppError> {
    let auth = &st.0.auth;
    let email = email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 || email.contains(char::is_whitespace) {
        return Err(bad_request("indirizzo email non valido"));
    }
    let role = match role {
        r @ ("admin" | "user") => r.to_owned(),
        _ => return Err(bad_request("ruolo non valido")),
    };
    let exists = auth.query_opt("SELECT 1 FROM users WHERE email = $1", &[&email]).await?.is_some();
    if exists {
        return Err(bad_request("esiste già un account con questo indirizzo"));
    }
    // un nuovo invito sostituisce quelli non ancora usati per lo stesso indirizzo
    auth.exec("DELETE FROM invites WHERE email = $1 AND used_at IS NULL", &[&email]).await?;
    let token = random_token();
    let id = uuid::Uuid::new_v4().to_string();
    auth.exec(
        "INSERT INTO invites (id, token_hash, email, role, invited_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        &[&id, &sha256_hex(&token), &email, &role, &me.id, &ts(now()), &ts(now() + INVITE_TTL)],
    )
    .await?;
    let link = format!("{}/?invite={token}", auth.config.public_url);
    let (subject, text) = if en {
        ("You're invited to Noises", format!("Hi,\n{} invited you to Noises: split tracks, practise with loops and play your songs.\nCreate your account with this link (valid for 7 days).", me.name))
    } else {
        ("Invito a Noises", format!("Ciao,\n{} ti ha invitato su Noises: separa le tracce, studia con i loop e suona i tuoi brani.\nCrea il tuo account con questo link (vale 7 giorni).", me.name))
    };
    let (emailed, email_error) = if auth.mailer.configured() {
        match auth.mailer.send(&email, subject, &text, &link, en).await {
            Ok(()) => (true, None),
            Err(e) => {
                warn!("invito a {email}: {e:#}");
                (false, Some(format!("{e:#}")))
            }
        }
    } else {
        (false, None)
    };
    auth.log_event(Some(&me.id), &me.email, "admin", &format!("Invitato {email} ({role})"), "", 200, client).await;
    info!("invito per {email} ({role}) da {}", me.email);
    Ok(InviteCreated { id, link, emailed, email_error })
}

// ------------------------------------------------------------------ richieste d'invito

#[derive(Serialize)]
pub struct InviteRequest {
    id: String,
    email: String,
    name: String,
    message: String,
    lang: String,
    ip: String,
    created_at: u64,
    status: String,
    decided_by: Option<String>,
    decided_at: Option<u64>,
}

/// GET /api/admin/requests — prima quelle in attesa, poi le ultime decise.
pub async fn requests(State(st): State<AppState>, Extension(me): Extension<User>) -> Result<Json<Vec<InviteRequest>>, AppError> {
    require_admin(&me)?;
    let rows = st
        .0
        .auth
        .query(
            "SELECT r.id, r.email::text, r.name, r.message, r.lang, r.ip, r.created_at, r.status, a.email::text, r.decided_at
             FROM invite_requests r LEFT JOIN users a ON a.id = r.decided_by
             ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200",
            &[],
        )
        .await?;
    Ok(Json(
        rows.iter()
            .map(|r| InviteRequest {
                id: r.get(0),
                email: r.get(1),
                name: r.get(2),
                message: r.get(3),
                lang: r.get(4),
                ip: r.get(5),
                created_at: u(r.get(6)),
                status: r.get(7),
                decided_by: r.get(8),
                decided_at: r.get::<_, Option<i64>>(9).map(u),
            })
            .collect(),
    ))
}

/// Segna una richiesta in attesa come decisa; restituisce (email, nome, lingua) o 404 se non è più in attesa.
async fn decide(st: &AppState, me: &User, id: &str, status: &str) -> Result<(String, String, String), AppError> {
    let row = st
        .0
        .auth
        .query_opt(
            "UPDATE invite_requests SET status = $1, decided_by = $2, decided_at = $3
             WHERE id = $4 AND status = 'pending' RETURNING email::text, name, lang",
            &[&status, &me.id, &ts(now()), &id],
        )
        .await?
        .ok_or_else(|| AppError(StatusCode::NOT_FOUND, "richiesta non trovata o già gestita".into()))?;
    Ok((row.get(0), row.get(1), row.get(2)))
}

#[derive(Deserialize, Default)]
pub struct ApproveBody {
    #[serde(default)]
    role: Option<String>,
}

/// POST /api/admin/requests/:id/approve — crea l'invito e lo manda a chi l'ha chiesto, nella sua lingua.
pub async fn approve_request(
    State(st): State<AppState>,
    Extension(me): Extension<User>,
    UrlPath(id): UrlPath<String>,
    headers: axum::http::HeaderMap,
    body: Option<Json<ApproveBody>>,
) -> Result<Json<InviteCreated>, AppError> {
    require_admin(&me)?;
    let role = body.and_then(|b| b.0.role).unwrap_or_else(|| "user".into());
    let (email, name, lang) = decide(&st, &me, &id, "approved").await?;
    let client = Client::from_headers(&headers);
    match make_invite(&st, &me, &email, &role, lang == "en", &client).await {
        Ok(inv) => {
            st.0.auth.exec("UPDATE invite_requests SET invite_id = $1 WHERE id = $2", &[&inv.id, &id]).await?;
            st.0.auth
                .log_event(Some(&me.id), &me.email, "admin", &format!("Richiesta d'invito approvata: {name} <{email}>"), "", 200, &client)
                .await;
            Ok(Json(inv))
        }
        Err(e) => {
            // invito non creato (es. l'utente si è registrato nel frattempo): la richiesta torna in attesa
            let _ = st.0.auth.exec("UPDATE invite_requests SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = $1", &[&id]).await;
            Err(e)
        }
    }
}

/// POST /api/admin/requests/:id/reject — nessuna email a chi l'ha chiesta.
pub async fn reject_request(
    State(st): State<AppState>,
    Extension(me): Extension<User>,
    UrlPath(id): UrlPath<String>,
    headers: axum::http::HeaderMap,
) -> Result<StatusCode, AppError> {
    require_admin(&me)?;
    let (email, name, _) = decide(&st, &me, &id, "rejected").await?;
    st.0.auth
        .log_event(Some(&me.id), &me.email, "admin", &format!("Richiesta d'invito rifiutata: {name} <{email}>"), "", 200, &Client::from_headers(&headers))
        .await;
    info!("richiesta d'invito di {email} rifiutata da {}", me.email);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_invite(
    State(st): State<AppState>,
    Extension(me): Extension<User>,
    UrlPath(id): UrlPath<String>,
) -> Result<StatusCode, AppError> {
    require_admin(&me)?;
    if st.0.auth.exec("DELETE FROM invites WHERE id = $1 AND used_at IS NULL", &[&id]).await? == 0 {
        return Err(not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------------------ registro

#[derive(Deserialize)]
pub struct EventsQuery {
    /// "access" (accessi e registrazioni), "action" (attività), "admin"; vuoto = tutto
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    user: Option<String>,
    /// solo eventi con id minore (pagina successiva)
    #[serde(default)]
    before: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Serialize)]
pub struct Event {
    id: i64,
    at: u64,
    user_id: Option<String>,
    email: String,
    kind: String,
    detail: String,
    path: String,
    status: u16,
    count: u32,
    ip: String,
    ua: String,
}

pub async fn events(
    State(st): State<AppState>,
    Extension(me): Extension<User>,
    Query(q): Query<EventsQuery>,
) -> Result<Json<Vec<Event>>, AppError> {
    require_admin(&me)?;
    let kinds: &[&str] = match q.kind.as_deref() {
        Some("access") => &["login", "login_failed", "logout", "register", "verify", "reset", "invite_request"],
        Some("action") => &["action", "admin"],
        Some("admin") => &["admin"],
        _ => &[],
    };
    let mut sql = String::from(
        "SELECT id, at, user_id, email, kind, detail, path, status, count, ip, ua FROM events WHERE id < $1",
    );
    if !kinds.is_empty() {
        sql += &format!(" AND kind IN ({})", kinds.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(","));
    }
    if q.user.as_deref().is_some_and(|u| !u.is_empty()) {
        sql += " AND user_id = $3";
    } else {
        sql += " AND $3::text IS NULL";
    }
    sql += " ORDER BY id DESC LIMIT $2";
    let user = q.user.filter(|u| !u.is_empty());
    let before = q.before.unwrap_or(i64::MAX);
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows = st.0.auth.query(&sql, &[&before, &limit, &user]).await?;
    let list = rows
        .iter()
        .map(|r| Event {
            id: r.get(0),
            at: u(r.get(1)),
            user_id: r.get(2),
            email: r.get(3),
            kind: r.get(4),
            detail: r.get(5),
            path: r.get(6),
            status: r.get::<_, i32>(7).clamp(0, u16::MAX as i32) as u16,
            count: r.get::<_, i32>(8).max(0) as u32,
            ip: r.get(9),
            ua: r.get(10),
        })
        .collect();
    Ok(Json(list))
}

// ------------------------------------------------------------------------------ sistema

#[derive(Clone, Serialize)]
pub struct Release {
    version: String,
    name: String,
    url: String,
    published_at: String,
    notes: String,
}

fn latest() -> &'static RwLock<Option<Release>> {
    static L: OnceLock<RwLock<Option<Release>>> = OnceLock::new();
    L.get_or_init(|| RwLock::new(None))
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let mut it = v.split(['.', '-', '+']).map(|x| x.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(a), Some(b)) if a > b)
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// Controlla ogni 6 ore l'ultima versione pubblicata su GitHub (UPDATE_CHECK=false per disattivare).
pub fn spawn_update_check(st: &AppState) {
    let flag = std::env::var("UPDATE_CHECK").unwrap_or_default().to_lowercase();
    if ["false", "0", "no", "off"].contains(&flag.as_str()) {
        info!("controllo degli aggiornamenti disattivato");
        return;
    }
    let repo = std::env::var("UPDATE_REPO").ok().filter(|r| !r.trim().is_empty()).unwrap_or_else(|| "teopost/noises".into());
    let http = st.0.auth.http.clone();
    tokio::spawn(async move {
        loop {
            match fetch_latest(&http, &repo).await {
                Ok(r) => {
                    if is_newer(&r.version, env!("CARGO_PKG_VERSION")) {
                        info!("nuova versione disponibile: {} ({})", r.version, r.url);
                    }
                    *latest().write().unwrap() = Some(r);
                }
                Err(e) => warn!("controllo degli aggiornamenti: {e:#}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
        }
    });
}

async fn fetch_latest(http: &reqwest::Client, repo: &str) -> anyhow::Result<Release> {
    let r: GhRelease = http
        .get(format!("https://api.github.com/repos/{repo}/releases/latest"))
        .header("User-Agent", concat!("noises/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if r.draft || r.prerelease {
        anyhow::bail!("ultima release non definitiva");
    }
    Ok(Release {
        version: r.tag_name.trim_start_matches('v').to_owned(),
        name: r.name.unwrap_or_else(|| r.tag_name.clone()),
        url: r.html_url,
        published_at: r.published_at.unwrap_or_default(),
        notes: r.body.unwrap_or_default().chars().take(20_000).collect(),
    })
}

#[derive(Serialize)]
pub struct System {
    version: &'static str,
    latest: Option<Release>,
    update_available: bool,
    users: usize,
    admins: usize,
    songs: usize,
    projects: usize,
    shares: usize,
    data_bytes: u64,
    disk_free: Option<u64>,
    smtp: bool,
    google: bool,
    allow_registration: bool,
    invite_requests: bool,
    email_verification: bool,
    public_url: String,
    pending_requests: i64,
}

/// GET /api/admin/update — solo la parte leggera (per il badge del menu).
#[derive(Serialize)]
pub struct UpdateInfo {
    version: &'static str,
    latest: Option<Release>,
    update_available: bool,
    /// richieste d'invito in attesa (badge nel menu)
    pending_requests: i64,
}

pub async fn update(State(st): State<AppState>, Extension(me): Extension<User>) -> Result<Json<UpdateInfo>, AppError> {
    require_admin(&me)?;
    let l = latest().read().unwrap().clone();
    let update_available = l.as_ref().is_some_and(|r| is_newer(&r.version, env!("CARGO_PKG_VERSION")));
    let pending_requests = pending_requests(&st).await?;
    Ok(Json(UpdateInfo { version: env!("CARGO_PKG_VERSION"), latest: l, update_available, pending_requests }))
}

async fn pending_requests(st: &AppState) -> anyhow::Result<i64> {
    Ok(st.0.auth.query_one("SELECT COUNT(*) FROM invite_requests WHERE status = 'pending'", &[]).await?.get(0))
}

fn disk_free(p: &Path) -> Option<u64> {
    let out = std::process::Command::new("df").args(["-Pk"]).arg(p).output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout).lines().nth(1)?.to_owned();
    line.split_whitespace().nth(3)?.parse::<u64>().ok().map(|k| k * 1024)
}

pub async fn system(State(st): State<AppState>, Extension(me): Extension<User>) -> Result<Json<System>, AppError> {
    require_admin(&me)?;
    let l = latest().read().unwrap().clone();
    let update_available = l.as_ref().is_some_and(|r| is_newer(&r.version, env!("CARGO_PKG_VERSION")));
    let r = st.0.auth.query_one("SELECT COUNT(*), COUNT(*) FILTER (WHERE is_admin) FROM users", &[]).await?;
    let (users, admins) = (r.get::<_, i64>(0) as usize, r.get::<_, i64>(1) as usize);
    let pending_requests = pending_requests(&st).await?;
    let data = st.0.data_dir.clone();
    let (data_bytes, free) = tokio::task::spawn_blocking(move || (dir_size(&data), disk_free(&data))).await?;
    let c = &st.0.auth.config;
    Ok(Json(System {
        version: env!("CARGO_PKG_VERSION"),
        latest: l,
        update_available,
        users,
        admins,
        songs: st.0.songs.read().unwrap().len(),
        projects: st.0.projects.read().unwrap().len(),
        shares: st.0.shares.read().unwrap().len(),
        data_bytes,
        disk_free: free,
        smtp: st.0.auth.mailer.configured(),
        google: c.google.is_some(),
        allow_registration: c.allow_registration,
        invite_requests: c.invite_requests,
        email_verification: c.email_verification,
        public_url: c.public_url.clone(),
        pending_requests,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(is_newer("1.3.0", "1.2.1"));
        assert!(is_newer("v1.2.10", "1.2.9"));
        assert!(!is_newer("1.2.1", "1.2.1"));
        assert!(!is_newer("1.1.0", "1.2.1"));
    }
}
