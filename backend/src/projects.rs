//! Progetti: timeline multitraccia salvate, separate dalla libreria dei brani.
//!
//! Ogni traccia di un progetto punta a un brano della libreria: intero (`part = "original"`)
//! oppure a una sua traccia separata (`part = "vocals"`, `"drums"`…), con le sue clip sulla
//! timeline. Segnalibri, gruppi e impostazioni del mixer appartengono al progetto.

use std::path::{Path, PathBuf};

use axum::{
    extract::{Path as UrlPath, State},
    http::StatusCode,
    response::Response,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::{
    bad_request, ensure_original, not_found, now_secs, render_file, run_export, valid_clips, AppError,
    AppState, Clip, ExportRequest, Marker, MixInput, Song, Status, TrackGroup,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PTrack {
    pub name: String,
    #[serde(default)]
    pub label: String,
    pub song: String,
    /// "original" = brano intero, altrimenti il nome della traccia separata
    pub part: String,
    pub clips: Vec<Clip>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    #[serde(default)]
    pub owner: Option<String>,
    pub name: String,
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub tracks: Vec<PTrack>,
    #[serde(default)]
    pub groups: Vec<TrackGroup>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct ProjectSummary {
    id: String,
    name: String,
    updated_at: u64,
    songs: Vec<String>,
}

fn project_path(st: &AppState, id: &str) -> PathBuf {
    st.0.data_dir.join("projects").join(format!("{id}.json"))
}

pub fn save_project(st: &AppState, p: &Project) -> anyhow::Result<()> {
    let path = project_path(st, &p.id);
    std::fs::create_dir_all(path.parent().unwrap())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(p)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

pub fn load_projects(data_dir: &Path) -> std::collections::HashMap<String, Project> {
    let mut map = std::collections::HashMap::new();
    let Ok(rd) = std::fs::read_dir(data_dir.join("projects")) else { return map };
    for e in rd.filter_map(Result::ok) {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read(&p).map_err(anyhow::Error::from).and_then(|b| Ok(serde_json::from_slice::<Project>(&b)?)) {
            Ok(pr) => {
                map.insert(pr.id.clone(), pr);
            }
            Err(err) => warn!("ignoro {}: {err:#}", p.display()),
        }
    }
    map
}

pub fn owns(st: &AppState, user_id: &str, pid: &str) -> bool {
    st.0.projects
        .read()
        .unwrap()
        .get(pid)
        .is_some_and(|p| p.owner.as_deref() == Some(user_id))
}

fn get(st: &AppState, pid: &str) -> Result<Project, AppError> {
    st.0.projects.read().unwrap().get(pid).cloned().ok_or_else(not_found)
}

fn store(st: &AppState, mut p: Project) -> Result<Project, AppError> {
    p.updated_at = now_secs();
    save_project(st, &p)?;
    st.0.projects.write().unwrap().insert(p.id.clone(), p.clone());
    Ok(p)
}

/// Quando un brano viene eliminato dalla libreria, le sue tracce spariscono dai progetti.
pub fn forget_song(st: &AppState, song_id: &str) {
    let ids: Vec<String> = st
        .0
        .projects
        .read()
        .unwrap()
        .values()
        .filter(|p| p.tracks.iter().any(|t| t.song == song_id))
        .map(|p| p.id.clone())
        .collect();
    for id in ids {
        let Some(mut p) = st.0.projects.read().unwrap().get(&id).cloned() else { continue };
        let gone: Vec<String> = p.tracks.iter().filter(|t| t.song == song_id).map(|t| t.name.clone()).collect();
        p.tracks.retain(|t| t.song != song_id);
        p.groups.iter_mut().for_each(|g| g.tracks.retain(|n| !gone.contains(n)));
        p.groups.retain(|g| g.tracks.len() >= if g.folder { 1 } else { 2 });
        let _ = store(st, p);
    }
}

// ------------------------------------------------------------------- handler

pub async fn list(
    State(st): State<AppState>,
    Extension(user): Extension<crate::auth::User>,
) -> Json<Vec<ProjectSummary>> {
    let songs = st.0.songs.read().unwrap();
    let mut v: Vec<ProjectSummary> = st
        .0
        .projects
        .read()
        .unwrap()
        .values()
        .filter(|p| p.owner.as_deref() == Some(user.id.as_str()))
        .map(|p| {
            let mut names: Vec<String> = vec![];
            for t in &p.tracks {
                if let Some(s) = songs.get(&t.song) {
                    if !names.contains(&s.name) {
                        names.push(s.name.clone());
                    }
                }
            }
            ProjectSummary { id: p.id.clone(), name: p.name.clone(), updated_at: p.updated_at, songs: names }
        })
        .collect();
    v.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Json(v)
}

#[derive(Deserialize)]
pub struct CreateBody {
    name: String,
}

fn clean_name(s: &str) -> Result<String, AppError> {
    let n: String = s.trim().chars().take(80).collect();
    if n.is_empty() {
        return Err(bad_request("il progetto deve avere un nome"));
    }
    Ok(n)
}

pub async fn create(
    State(st): State<AppState>,
    Extension(user): Extension<crate::auth::User>,
    Json(b): Json<CreateBody>,
) -> Result<Json<Project>, AppError> {
    let p = Project {
        id: uuid::Uuid::new_v4().to_string(),
        owner: Some(user.id.clone()),
        name: clean_name(&b.name)?,
        created_at: now_secs(),
        updated_at: now_secs(),
        tracks: vec![],
        groups: vec![],
        markers: vec![],
        settings: None,
    };
    Ok(Json(store(&st, p)?))
}

pub async fn get_one(State(st): State<AppState>, UrlPath(pid): UrlPath<String>) -> Result<Json<Project>, AppError> {
    Ok(Json(get(&st, &pid)?))
}

#[derive(Deserialize)]
pub struct StateBody {
    name: String,
    tracks: Vec<PTrack>,
    #[serde(default)]
    groups: Vec<TrackGroup>,
    #[serde(default)]
    markers: Vec<Marker>,
}

/// Salva lo stato dell'editor (tracce con le loro clip, gruppi, segnalibri, nome).
pub async fn put_state(
    State(st): State<AppState>,
    UrlPath(pid): UrlPath<String>,
    Extension(user): Extension<crate::auth::User>,
    Json(b): Json<StateBody>,
) -> Result<StatusCode, AppError> {
    let mut p = get(&st, &pid)?;
    if b.tracks.len() > 200 || b.groups.len() > 100 || b.markers.len() > 500 {
        return Err(bad_request("progetto troppo grande"));
    }
    {
        let songs = st.0.songs.read().unwrap();
        for t in &b.tracks {
            let Some(s) = songs.get(&t.song) else {
                return Err(bad_request(format!("brano sconosciuto: {}", t.song)));
            };
            let ok = s.owner.as_deref() == Some(user.id.as_str())
                && (t.part == "original" || s.stems.contains(&t.part))
                && !t.name.is_empty()
                && t.name.len() <= 64
                && valid_clips(&t.clips, 24.0 * 3600.0);
            if !ok {
                return Err(bad_request(format!("traccia non valida: {}", t.name)));
            }
        }
    }
    let names: Vec<&String> = b.tracks.iter().map(|t| &t.name).collect();
    if !b.groups.iter().all(|g| g.tracks.iter().all(|n| names.contains(&n)) && g.name.chars().count() <= 300) {
        return Err(bad_request("gruppi non validi"));
    }
    if !b.markers.iter().all(|m| m.t.is_finite() && m.t >= 0.0) {
        return Err(bad_request("segnalibri non validi"));
    }
    p.name = clean_name(&b.name)?;
    p.tracks = b.tracks;
    // nomi lunghi (titoli da YouTube) accorciati invece di rifiutare il salvataggio
    p.groups = b.groups.into_iter().map(|mut g| { g.name = g.name.chars().take(120).collect(); g }).collect();
    p.markers = b.markers.into_iter().map(|mut m| { m.name = m.name.trim().chars().take(60).collect(); m }).collect();
    p.markers.sort_by(|a, c| a.t.total_cmp(&c.t));
    store(&st, p)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn put_settings(
    State(st): State<AppState>,
    UrlPath(pid): UrlPath<String>,
    Json(v): Json<serde_json::Value>,
) -> Result<StatusCode, AppError> {
    if !v.is_object() || serde_json::to_vec(&v)?.len() > 64 * 1024 {
        return Err(bad_request("impostazioni non valide"));
    }
    let mut p = get(&st, &pid)?;
    p.settings = Some(v);
    store(&st, p)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reset_settings(State(st): State<AppState>, UrlPath(pid): UrlPath<String>) -> Result<StatusCode, AppError> {
    let mut p = get(&st, &pid)?;
    p.settings = None;
    store(&st, p)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete(State(st): State<AppState>, UrlPath(pid): UrlPath<String>) -> Result<StatusCode, AppError> {
    if st.0.projects.write().unwrap().remove(&pid).is_none() {
        return Err(not_found());
    }
    let _ = tokio::fs::remove_file(project_path(&st, &pid)).await;
    let _ = tokio::fs::remove_dir_all(st.0.data_dir.join("projects").join(&pid)).await;
    crate::setlists::forget_project(&st, &pid);
    Ok(StatusCode::NO_CONTENT)
}

/// Esporta il mix del progetto: tracce attive con le loro clip, tonalità e velocità.
pub async fn export(
    State(st): State<AppState>,
    UrlPath(pid): UrlPath<String>,
    Json(req): Json<ExportRequest>,
) -> Result<Response, AppError> {
    let p = get(&st, &pid)?;
    let mut items = vec![];
    for e in req.stems.iter().filter(|e| e.gain > 0.0) {
        let t = p
            .tracks
            .iter()
            .find(|t| t.name == e.name)
            .ok_or_else(|| bad_request(format!("traccia sconosciuta: {}", e.name)))?;
        if t.clips.is_empty() {
            continue;
        }
        let song: Song = st.get(&t.song).ok_or_else(not_found)?;
        let dir = st.song_dir(&t.song);
        let src = if t.part == "original" {
            ensure_original(&st, &t.song).await?
        } else {
            if song.status != Status::Ready || !song.stems.contains(&t.part) {
                return Err(bad_request(format!("traccia separata non disponibile: {}", t.part)));
            }
            dir.join("stems").join(format!("{}.flac", t.part))
        };
        let pitch = req.pitch.unwrap_or(0).clamp(-12, 12);
        let tempo = req.tempo.unwrap_or(100).clamp(25, 200);
        let path = if pitch == 0 && tempo == 100 {
            src
        } else {
            render_file(&st, &dir.join("render"), &t.part, &src, pitch, tempo).await?
        };
        items.push(MixInput { path, clips: t.clips.clone(), gain: e.gain });
    }
    let work = st.0.data_dir.join("projects").join(&pid).join("exports");
    run_export(&work, items, &req, &p.name).await
}

// ------------------------------------------------------------------ migrazione

fn probe_duration(path: &Path) -> Option<f64> {
    let out = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Ogni brano già separato (modello precedente: brano = timeline) diventa un progetto con le
/// stesse tracce, tagli, gruppi, segnalibri e impostazioni. Le tracce aggiunte diventano brani
/// della libreria. Eseguita una volta sola per brano.
pub fn migrate(st: &AppState) {
    let todo: Vec<Song> = st
        .0
        .songs
        .read()
        .unwrap()
        .values()
        .filter(|s| s.status == Status::Ready && !s.migrated)
        .cloned()
        .collect();
    for song in todo {
        let dir = st.song_dir(&song.id);
        let Some(first) = song.stems.first() else { continue };
        let duration = probe_duration(&dir.join("stems").join(format!("{first}.flac"))).unwrap_or(0.0);
        let layout = song.layout.clone().unwrap_or_default();
        let removed: Vec<String> = layout.removed.clone();
        let mut tracks: Vec<PTrack> = vec![];
        for stem in &song.stems {
            let clips = layout.stem_clips.get(stem).cloned().unwrap_or_else(|| {
                vec![Clip { id: format!("{stem}-0"), start: 0.0, offset: 0.0, duration }]
            });
            tracks.push(PTrack { name: stem.clone(), label: String::new(), song: song.id.clone(), part: stem.clone(), clips });
        }
        for ut in &song.user_tracks {
            let tname = format!("user:{}", ut.id);
            let src = dir.join("user").join(format!("{}.flac", ut.id));
            if removed.contains(&tname) || !src.exists() {
                let _ = std::fs::remove_file(&src);
                continue;
            }
            // il file aggiunto diventa un brano della libreria
            let new_id = uuid::Uuid::new_v4().to_string();
            let ndir = st.song_dir(&new_id);
            if std::fs::create_dir_all(&ndir).is_err() || std::fs::rename(&src, ndir.join("original.flac")).is_err() {
                continue;
            }
            let _ = std::fs::copy(ndir.join("original.flac"), ndir.join("input.flac"));
            let mut ns = song.clone();
            ns.id = new_id.clone();
            ns.name = ut.name.clone();
            ns.status = Status::New;
            ns.progress = 0.0;
            ns.stems = vec![];
            ns.error = None;
            ns.source_url = None;
            ns.phase = None;
            ns.markers = vec![];
            ns.user_tracks = vec![];
            ns.layout = None;
            ns.rhythm = None;
            ns.settings = None;
            ns.migrated = true;
            ns.duration = Some(ut.duration);
            ns.created_at = now_secs();
            st.0.songs.write().unwrap().insert(new_id.clone(), ns.clone());
            let _ = st.save_meta(&ns);
            tracks.push(PTrack { name: tname, label: ut.name.clone(), song: new_id, part: "original".into(), clips: ut.clips.clone() });
        }
        if !layout.order.is_empty() {
            let pos = |n: &String| layout.order.iter().position(|x| x == n).unwrap_or(usize::MAX);
            tracks.sort_by_key(|t| pos(&t.name));
        }
        let names: Vec<String> = tracks.iter().map(|t| t.name.clone()).collect();
        let mut groups: Vec<TrackGroup> = if layout.groups.is_empty() {
            vec![TrackGroup {
                id: "song".into(),
                name: song.name.clone(),
                tracks: song.stems.clone(),
                anchored: false,
                folder: true,
                collapsed: false,
                muted: false,
                solo: false,
                volume: 1.0,
            }]
        } else {
            layout.groups.clone()
        };
        for g in &mut groups {
            g.tracks.retain(|n| names.contains(n));
            if g.anchored {
                g.anchored = false;
                g.name = song.name.clone();
            }
        }
        groups.retain(|g| g.tracks.len() >= 2);
        let p = Project {
            id: uuid::Uuid::new_v4().to_string(),
            owner: song.owner.clone(),
            name: song.name.clone(),
            created_at: song.created_at,
            updated_at: now_secs(),
            tracks,
            groups,
            markers: song.markers.clone(),
            settings: song.settings.clone(),
        };
        if save_project(st, &p).is_ok() {
            info!("brano '{}' migrato nel progetto {}", song.name, p.id);
            st.0.projects.write().unwrap().insert(p.id.clone(), p);
            st.update(&song.id, true, |s| {
                s.migrated = true;
                s.duration = s.duration.or(Some(duration));
            });
        }
    }
}
