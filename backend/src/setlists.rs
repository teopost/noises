//! Scalette: elenchi ordinati di progetti da suonare uno dopo l'altro (prove, concerti).

use std::path::Path;

use axum::{
    extract::{Path as UrlPath, State},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};

use crate::{bad_request, not_found, now_secs, AppError, AppState};

/// Pausa massima tra un progetto e l'altro, in secondi.
const MAX_PAUSE: i32 = 120;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Setlist {
    pub id: String,
    pub owner: String,
    pub name: String,
    /// id dei progetti, nell'ordine in cui si suonano (lo stesso progetto può ripetersi)
    pub projects: Vec<String>,
    /// secondi di pausa prima del progetto successivo; -1 = attende il Play
    #[serde(default = "default_pause")]
    pub pause: i32,
    pub created_at: u64,
}

fn default_pause() -> i32 {
    5
}

pub fn load(data_dir: &Path) -> Vec<Setlist> {
    std::fs::read(data_dir.join("setlists.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Modifica le scalette e le salva su disco (sotto lock, per serializzare le scritture).
fn edit<R>(st: &AppState, f: impl FnOnce(&mut Vec<Setlist>) -> Result<R, AppError>) -> Result<R, AppError> {
    let mut all = st.0.setlists.write().unwrap();
    let r = f(&mut all)?;
    let path = st.0.data_dir.join("setlists.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&*all)?)?;
    std::fs::rename(tmp, path)?;
    Ok(r)
}

pub fn owns(st: &AppState, user_id: &str, id: &str) -> bool {
    st.0.setlists.read().unwrap().iter().any(|s| s.id == id && s.owner == user_id)
}

/// Un progetto eliminato sparisce dalle scalette.
pub fn forget_project(st: &AppState, pid: &str) {
    if !st.0.setlists.read().unwrap().iter().any(|s| s.projects.iter().any(|p| p == pid)) {
        return;
    }
    let _ = edit(st, |all| {
        all.iter_mut().for_each(|s| s.projects.retain(|p| p != pid));
        Ok(())
    });
}

fn clean_name(s: &str) -> Result<String, AppError> {
    let n: String = s.trim().chars().take(80).collect();
    if n.is_empty() {
        return Err(bad_request("la scaletta deve avere un nome"));
    }
    Ok(n)
}

// ------------------------------------------------------------------- handler

pub async fn list(State(st): State<AppState>, Extension(user): Extension<crate::auth::User>) -> Json<Vec<Setlist>> {
    let mut v: Vec<Setlist> = st.0.setlists.read().unwrap().iter().filter(|s| s.owner == user.id).cloned().collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Json(v)
}

#[derive(Deserialize)]
pub struct CreateBody {
    name: String,
}

pub async fn create(
    State(st): State<AppState>,
    Extension(user): Extension<crate::auth::User>,
    Json(b): Json<CreateBody>,
) -> Result<Json<Setlist>, AppError> {
    let s = Setlist {
        id: uuid::Uuid::new_v4().to_string(),
        owner: user.id.clone(),
        name: clean_name(&b.name)?,
        projects: vec![],
        pause: default_pause(),
        created_at: now_secs(),
    };
    edit(&st, |all| {
        all.push(s.clone());
        Ok(())
    })?;
    Ok(Json(s))
}

#[derive(Deserialize)]
pub struct UpdateBody {
    name: String,
    projects: Vec<String>,
    pause: i32,
}

/// Salva nome, ordine dei progetti e pausa.
pub async fn update(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
    Extension(user): Extension<crate::auth::User>,
    Json(b): Json<UpdateBody>,
) -> Result<Json<Setlist>, AppError> {
    let name = clean_name(&b.name)?;
    if b.projects.len() > 500 {
        return Err(bad_request("troppi progetti"));
    }
    if !(-1..=MAX_PAUSE).contains(&b.pause) {
        return Err(bad_request("pausa non valida"));
    }
    if !b.projects.iter().all(|p| crate::projects::owns(&st, &user.id, p)) {
        return Err(bad_request("progetto sconosciuto"));
    }
    edit(&st, |all| {
        let s = all.iter_mut().find(|s| s.id == id).ok_or_else(not_found)?;
        s.name = name;
        s.projects = b.projects;
        s.pause = b.pause;
        Ok(Json(s.clone()))
    })
}

pub async fn delete(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> Result<StatusCode, AppError> {
    edit(&st, |all| {
        let n = all.len();
        all.retain(|s| s.id != id);
        if all.len() == n {
            return Err(not_found());
        }
        Ok(StatusCode::NO_CONTENT)
    })
}
