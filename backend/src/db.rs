//! Database PostgreSQL: connessione (pool), schema e import una tantum del vecchio `noises.db` (SQLite).
//!
//! Configurazione con `DATABASE_URL` (es. `postgres://noises:password@db:5432/noises`).
//! Lo schema si crea all'avvio se manca. Se il database è vuoto e nella cartella dati c'è ancora
//! `noises.db` delle versioni precedenti, il suo contenuto viene copiato in PostgreSQL e il file
//! rinominato in `noises.db.migrated` (resta come copia di sicurezza).

use std::{path::Path, str::FromStr, time::Duration};

use anyhow::Context;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use tokio_postgres::{types::ToSql, NoTls};
use tracing::{info, warn};

pub type Params<'a> = &'a [&'a (dyn ToSql + Sync)];

const SCHEMA: &str = "
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  google_sub TEXT UNIQUE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_login BIGINT,
  last_seen BIGINT);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id, kind);
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  user_id TEXT,
  email TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 1,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, at);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email CITEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  used_by TEXT);
CREATE TABLE IF NOT EXISTS invite_requests (
  id TEXT PRIMARY KEY,
  email CITEXT NOT NULL,
  name TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'it',
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at BIGINT,
  invite_id TEXT);
-- una sola richiesta in attesa per indirizzo
CREATE UNIQUE INDEX IF NOT EXISTS invite_requests_pending ON invite_requests(email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS invite_requests_created ON invite_requests(created_at);
";

/// Crea il pool, aspetta che il database risponda (al primo avvio il container può essere ancora
/// in preparazione), applica lo schema e importa il vecchio database SQLite se serve.
pub async fn connect(data_dir: &Path) -> anyhow::Result<Pool> {
    let url = std::env::var("DATABASE_URL").context("DATABASE_URL non impostata (es. postgres://noises:password@db:5432/noises)")?;
    let cfg = tokio_postgres::Config::from_str(&url).context("DATABASE_URL non valida")?;
    let mgr = Manager::from_config(cfg, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
    let pool = Pool::builder(mgr).max_size(16).build()?;
    let mut tries = 0;
    let mut client = loop {
        match pool.get().await {
            Ok(c) => break c,
            Err(e) if tries < 30 => {
                tries += 1;
                warn!("database non raggiungibile ({e}), nuovo tentativo tra 2 s");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => return Err(e).context("connessione al database"),
        }
    };
    client.batch_execute(SCHEMA).await.context("creazione dello schema")?;
    let sqlite = data_dir.join("noises.db");
    if sqlite.exists() {
        let users: i64 = client.query_one("SELECT COUNT(*) FROM users", &[]).await?.get(0);
        if users == 0 {
            import_sqlite(&mut client, &sqlite).await.context("import di noises.db")?;
        } else {
            warn!("{} presente ma il database PostgreSQL ha già utenti: import saltato", sqlite.display());
        }
    }
    info!("database PostgreSQL pronto");
    Ok(pool)
}

/// Righe del vecchio database, lette in modo sincrono (rusqlite) prima di scriverle in PostgreSQL.
#[allow(clippy::type_complexity)] // tuple usate solo qui, una per tabella
#[derive(Default)]
struct Old {
    users: Vec<(String, String, String, Option<String>, bool, Option<String>, bool, i64, bool, Option<i64>, Option<i64>)>,
    sessions: Vec<(String, String, i64)>,
    tokens: Vec<(String, String, String, i64)>,
    events: Vec<(i64, i64, Option<String>, String, String, String, String, i64, i64, String, String)>,
    invites: Vec<(String, String, String, String, Option<String>, i64, i64, Option<i64>, Option<String>)>,
}

fn read_sqlite(path: &Path) -> anyhow::Result<Old> {
    use rusqlite::{Connection, OpenFlags};
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let cols: Vec<String> =
        c.prepare("SELECT name FROM pragma_table_info('users')")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let col = |name: &str, fallback: &str| if cols.iter().any(|x| x == name) { name.to_owned() } else { fallback.to_owned() };
    let mut o = Old::default();
    let sql = format!(
        "SELECT id, email, name, password_hash, email_verified, google_sub, is_admin, created_at, {}, {}, {} FROM users",
        col("disabled", "0"),
        col("last_login", "NULL"),
        col("last_seen", "NULL")
    );
    o.users = c
        .prepare(&sql)?
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?))
        })?
        .collect::<Result<_, _>>()?;
    let has = |t: &str| -> bool {
        c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [t], |r| r.get::<_, i64>(0))
            .unwrap_or(0)
            > 0
    };
    if has("sessions") {
        o.sessions = c
            .prepare("SELECT token_hash, user_id, expires_at FROM sessions")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
    }
    if has("tokens") {
        o.tokens = c
            .prepare("SELECT token_hash, user_id, kind, expires_at FROM tokens")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<_, _>>()?;
    }
    if has("events") {
        o.events = c
            .prepare("SELECT id, at, user_id, email, kind, detail, path, status, count, ip, ua FROM events ORDER BY id")?
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?))
            })?
            .collect::<Result<_, _>>()?;
    }
    if has("invites") {
        o.invites = c
            .prepare("SELECT id, token_hash, email, role, invited_by, created_at, expires_at, used_at, used_by FROM invites")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)))?
            .collect::<Result<_, _>>()?;
    }
    Ok(o)
}

async fn import_sqlite(client: &mut deadpool_postgres::Object, path: &Path) -> anyhow::Result<()> {
    let p = path.to_owned();
    let o = tokio::task::spawn_blocking(move || read_sqlite(&p)).await??;
    let tx = client.transaction().await?;
    for u in &o.users {
        tx.execute(
            "INSERT INTO users (id, email, name, password_hash, email_verified, google_sub, is_admin, created_at, disabled, last_login, last_seen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            &[&u.0, &u.1, &u.2, &u.3, &u.4, &u.5, &u.6, &u.7, &u.8, &u.9, &u.10],
        )
        .await?;
    }
    // sessioni e token di utenti che non esistono più vengono scartati (in SQLite le FK potevano mancare)
    for s in &o.sessions {
        tx.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2)",
            &[&s.0, &s.1, &s.2],
        )
        .await?;
    }
    for t in &o.tokens {
        tx.execute(
            "INSERT INTO tokens (token_hash, user_id, kind, expires_at) SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2)",
            &[&t.0, &t.1, &t.2, &t.3],
        )
        .await?;
    }
    for e in &o.events {
        let (status, count) = (e.7 as i32, e.8 as i32);
        tx.execute(
            "INSERT INTO events (id, at, user_id, email, kind, detail, path, status, count, ip, ua)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            &[&e.0, &e.1, &e.2, &e.3, &e.4, &e.5, &e.6, &status, &count, &e.9, &e.10],
        )
        .await?;
    }
    tx.execute("SELECT setval('events_id_seq', GREATEST((SELECT MAX(id) FROM events), 1))", &[]).await?;
    for i in &o.invites {
        tx.execute(
            "INSERT INTO invites (id, token_hash, email, role, invited_by, created_at, expires_at, used_at, used_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            &[&i.0, &i.1, &i.2, &i.3, &i.4, &i.5, &i.6, &i.7, &i.8],
        )
        .await?;
    }
    tx.commit().await?;
    // anche i file -wal/-shm di SQLite: il contenuto è già stato letto e importato
    for ext in ["", "-wal", "-shm"] {
        let from = path.with_file_name(format!("noises.db{ext}"));
        if from.exists() {
            let _ = std::fs::rename(&from, path.with_file_name(format!("noises.db{ext}.migrated")));
        }
    }
    info!(
        "importato noises.db in PostgreSQL: {} utenti, {} sessioni, {} token, {} eventi, {} inviti (file rinominato in noises.db.migrated)",
        o.users.len(),
        o.sessions.len(),
        o.tokens.len(),
        o.events.len(),
        o.invites.len()
    );
    Ok(())
}

/// Istante Unix (secondi) nel tipo usato dalle colonne BIGINT.
pub fn ts(t: u64) -> i64 {
    t.min(i64::MAX as u64) as i64
}

/// Lettura di un BIGINT come istante Unix.
pub fn u(t: i64) -> u64 {
    t.max(0) as u64
}
