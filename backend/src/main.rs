//! Noises — stem separation server.
//!
//! Il server Rust gestisce upload, coda dei job, persistenza e streaming audio.
//! Il lavoro pesante è delegato a motori nativi specializzati:
//!   * Demucs (PyTorch, kernel C++) per la separazione delle tracce
//!   * Rubber Band (C++) per pitch-shift e time-stretch di alta qualità

mod auth;

use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context};
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path as UrlPath, Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{mpsc, Semaphore},
};
use tower::ServiceExt;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{error, info, warn};

const MODELS: &[&str] = &["htdemucs", "htdemucs_ft", "htdemucs_6s"];
const STEM_ORDER: &[&str] = &["vocals", "drums", "bass", "guitar", "piano", "other"];
const CHORD_QUALITIES: &[&str] = &[
    "min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7", "maj7", "7", "dim7", "hdim7",
    "sus2", "sus4",
];
const MAX_UPLOAD: usize = 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Downloading,
    /// caricato, in attesa che l'utente avvii l'elaborazione
    New,
    Queued,
    Processing,
    Ready,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Song {
    id: String,
    name: String,
    model: String,
    status: Status,
    #[serde(default)]
    progress: f32,
    #[serde(default)]
    stems: Vec<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    /// Fase corrente dell'elaborazione (per la UI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
    /// Utente proprietario (None = dati precedenti all'autenticazione, adottati dal primo utente).
    #[serde(default)]
    owner: Option<String>,
    /// Analisi richieste dall'utente all'avvio dell'elaborazione.
    #[serde(default)]
    tasks: Tasks,
    /// Metro e correzioni della griglia ritmica scelti dall'utente.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rhythm: Option<Rhythm>,
    /// Impostazioni del mixer salvate dall'utente (pitch, tempo, volumi, selezione, loop…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<serde_json::Value>,
    created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Playlist {
    id: String,
    #[serde(default)]
    owner: Option<String>,
    name: String,
    /// Id dei brani, nell'ordine di inserimento.
    songs: Vec<String>,
    created_at: u64,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct Tasks {
    chords: bool,
    notes: bool,
}

impl Default for Tasks {
    fn default() -> Self {
        Tasks { chords: true, notes: true }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
struct Rhythm {
    /// metro, es. [3, 4] o [6, 8]
    time_signature: [u8; 2],
    /// spostamento del primo tempo della battuta, in battiti
    offset: i32,
    /// correzione del battito rilevato: 0.5 = metà, 2 = doppio
    multiplier: f32,
}

const METERS: &[[u8; 2]] = &[[2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [12, 8]];

/// Battiti per battuta e durata del battito in quarti (6/8 → 2 battiti da un quarto puntato).
fn meter_info(ts: [u8; 2]) -> (u32, f64) {
    if ts[1] == 8 && ts[0] % 3 == 0 {
        ((ts[0] / 3) as u32, 1.5)
    } else {
        (ts[0] as u32, 4.0 / ts[1] as f64)
    }
}

/// Griglia effettiva: battiti rilevati + correzioni dell'utente (doppio/metà, primo tempo, metro).
fn effective_grid(raw: &serde_json::Value, rhythm: Option<Rhythm>) -> serde_json::Value {
    let r = rhythm.unwrap_or(Rhythm { time_signature: [4, 4], offset: 0, multiplier: 1.0 });
    let mut beats: Vec<f64> = raw["beats"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_f64()).collect())
        .unwrap_or_default();
    let mut downbeat = raw["downbeat"].as_i64().unwrap_or(0);
    let mut bpm = raw["bpm"].as_f64().unwrap_or(120.0);
    if r.multiplier >= 2.0 && beats.len() > 1 {
        let mut b2 = Vec::with_capacity(beats.len() * 2);
        for w in beats.windows(2) {
            b2.push(w[0]);
            b2.push((w[0] + w[1]) / 2.0);
        }
        b2.push(*beats.last().unwrap());
        beats = b2;
        downbeat *= 2;
        bpm *= 2.0;
    } else if r.multiplier <= 0.5 && beats.len() > 3 {
        let phase = downbeat.rem_euclid(2) as usize;
        beats = beats.iter().skip(phase).step_by(2).cloned().collect();
        downbeat = (downbeat - phase as i64) / 2;
        bpm /= 2.0;
    }
    let (bpb, bq) = meter_info(r.time_signature);
    let downbeat = (downbeat + r.offset as i64).rem_euclid(bpb as i64);
    serde_json::json!({
        "bpm": bpm,
        "beats": beats,
        "downbeat": downbeat,
        "time_signature": r.time_signature,
        "beats_per_bar": bpb,
        "beat_quarters": bq,
        "rhythm": r,
    })
}

struct Inner {
    auth: auth::Auth,
    data_dir: PathBuf,
    analysis_dir: PathBuf,
    playlists: RwLock<Vec<Playlist>>,
    device: String,
    rubberband_args: Vec<String>,
    songs: RwLock<HashMap<String, Song>>,
    queue: mpsc::UnboundedSender<String>,
    render_locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    render_sem: Semaphore,
}

#[derive(Clone)]
struct AppState(Arc<Inner>);

impl AppState {
    fn song_dir(&self, id: &str) -> PathBuf {
        self.0.data_dir.join("songs").join(id)
    }

    fn get(&self, id: &str) -> Option<Song> {
        self.0.songs.read().unwrap().get(id).cloned()
    }

    /// Applica una modifica alla canzone; se `persist` salva anche meta.json.
    fn update(&self, id: &str, persist: bool, f: impl FnOnce(&mut Song)) -> Option<Song> {
        let song = {
            let mut songs = self.0.songs.write().unwrap();
            let s = songs.get_mut(id)?;
            f(s);
            s.clone()
        };
        if persist {
            if let Err(e) = self.save_meta(&song) {
                warn!("salvataggio meta {id}: {e:#}");
            }
        }
        Some(song)
    }

    fn save_meta(&self, song: &Song) -> anyhow::Result<()> {
        let dir = self.song_dir(&song.id);
        if !dir.exists() {
            return Ok(()); // canzone eliminata nel frattempo
        }
        let tmp = dir.join("meta.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(song)?)?;
        std::fs::rename(tmp, dir.join("meta.json"))?;
        Ok(())
    }

    /// Modifica le playlist e le salva su disco (sotto lock, per serializzare le scritture).
    fn edit_playlists<R>(
        &self,
        f: impl FnOnce(&mut Vec<Playlist>) -> Result<R, AppError>,
    ) -> Result<R, AppError> {
        let mut pls = self.0.playlists.write().unwrap();
        let r = f(&mut pls)?;
        let path = self.0.data_dir.join("playlists.json");
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&*pls)?)?;
        std::fs::rename(tmp, path)?;
        Ok(r)
    }

    fn render_lock(&self, key: &Path) -> Arc<tokio::sync::Mutex<()>> {
        self.0
            .render_locks
            .lock()
            .unwrap()
            .entry(key.to_path_buf())
            .or_default()
            .clone()
    }
}

// ------------------------------------------------------------ multi-utente

/// Le risorse indicate nel percorso (/api/songs/:id…, /api/playlists/:id[/songs/:song]) sono dell'utente?
fn owns_path(st: &AppState, user: &auth::User, path: &str) -> bool {
    let seg: Vec<&str> = path.trim_matches('/').split('/').collect();
    let song_ok = |id: &str| {
        st.0.songs
            .read()
            .unwrap()
            .get(id)
            .is_some_and(|s| s.owner.as_deref() == Some(user.id.as_str()))
    };
    match seg.as_slice() {
        ["api", "songs", id, ..] => song_ok(id),
        ["api", "playlists", id, rest @ ..] => {
            let pl_ok = st.0.playlists
                .read()
                .unwrap()
                .iter()
                .any(|p| p.id == *id && p.owner.as_deref() == Some(user.id.as_str()));
            pl_ok && match rest {
                ["songs", song, ..] => song_ok(song),
                _ => true,
            }
        }
        _ => true,
    }
}

/// Il primo utente registrato riceve brani e playlist creati prima dell'autenticazione.
fn adopt_orphans(st: &AppState, user_id: &str) {
    let orphans: Vec<String> = st
        .0
        .songs
        .read()
        .unwrap()
        .values()
        .filter(|s| s.owner.is_none())
        .map(|s| s.id.clone())
        .collect();
    for id in &orphans {
        st.update(id, true, |s| s.owner = Some(user_id.to_owned()));
    }
    let _ = st.edit_playlists(|pls| {
        pls.iter_mut().filter(|p| p.owner.is_none()).for_each(|p| p.owner = Some(user_id.to_owned()));
        Ok(())
    });
    if !orphans.is_empty() {
        info!("{} brani esistenti assegnati al primo utente", orphans.len());
    }
}

// ---------------------------------------------------------------- errori HTTP

struct AppError(StatusCode, String);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        let e = e.into();
        error!("{e:#}");
        AppError(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
    }
}

fn not_found() -> AppError {
    AppError(StatusCode::NOT_FOUND, "non trovato".into())
}

fn bad_request(msg: impl Into<String>) -> AppError {
    AppError(StatusCode::BAD_REQUEST, msg.into())
}

// ------------------------------------------------------------------- handlers

async fn list_songs(State(st): State<AppState>, Extension(user): Extension<auth::User>) -> Json<Vec<Song>> {
    let mut v: Vec<Song> = st
        .0
        .songs
        .read()
        .unwrap()
        .values()
        .filter(|s| s.owner.as_deref() == Some(user.id.as_str()))
        .cloned()
        .collect();
    v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(v)
}

async fn get_song(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Song>, AppError> {
    st.get(&id).map(Json).ok_or_else(not_found)
}

async fn delete_song(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<StatusCode, AppError> {
    if st.0.songs.write().unwrap().remove(&id).is_none() {
        return Err(not_found());
    }
    st.edit_playlists(|pls| {
        pls.iter_mut().for_each(|p| p.songs.retain(|s| s != &id));
        Ok(())
    })?;
    let dir = st.song_dir(&id);
    if dir.exists() {
        tokio::fs::remove_dir_all(dir).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn upload(
    State(st): State<AppState>,
    Extension(user): Extension<auth::User>,
    mut mp: Multipart,
) -> Result<Json<Song>, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let dir = st.song_dir(&id);
    tokio::fs::create_dir_all(&dir).await?;

    let result = receive_upload(&dir, &mut mp).await;
    let (name, model) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(e);
        }
    };

    let song = Song {
        id: id.clone(),
        name,
        model,
        status: Status::New,
        progress: 0.0,
        stems: vec![],
        error: None,
        source_url: None,
        owner: Some(user.id.clone()),
        phase: None,
        tasks: Tasks::default(),
        rhythm: None,
        settings: None,
        created_at: now_secs(),
    };
    st.0.songs.write().unwrap().insert(id.clone(), song.clone());
    st.save_meta(&song)?;
    info!("caricato '{}' ({}) modello {}", song.name, song.id, song.model);
    Ok(Json(song))
}

async fn receive_upload(dir: &Path, mp: &mut Multipart) -> Result<(String, String), AppError> {
    let mut model = MODELS[0].to_string();
    let mut name = None;
    while let Some(mut field) = mp.next_field().await? {
        let field_name = field.name().unwrap_or_default().to_owned();
        match field_name.as_str() {
            "model" => model = field.text().await?,
            "file" => {
                let fname = field.file_name().unwrap_or("audio").to_owned();
                let p = Path::new(&fname);
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
                    .unwrap_or("bin")
                    .to_lowercase();
                let mut f = tokio::fs::File::create(dir.join(format!("input.{ext}"))).await?;
                while let Some(chunk) = field.chunk().await? {
                    f.write_all(&chunk).await?;
                }
                f.flush().await?;
                name = Some(
                    p.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Senza titolo")
                        .to_owned(),
                );
            }
            _ => {}
        }
    }
    if !MODELS.contains(&model.as_str()) {
        return Err(bad_request(format!("modello non valido: {model}")));
    }
    let name = name.ok_or_else(|| bad_request("nessun file inviato"))?;
    Ok((name, model))
}

async fn save_settings(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
    Json(v): Json<serde_json::Value>,
) -> Result<StatusCode, AppError> {
    if !v.is_object() || serde_json::to_vec(&v)?.len() > 64 * 1024 {
        return Err(bad_request("impostazioni non valide"));
    }
    st.update(&id, true, |s| s.settings = Some(v))
        .ok_or_else(not_found)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reset_settings(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<StatusCode, AppError> {
    st.update(&id, true, |s| s.settings = None)
        .ok_or_else(not_found)?;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------- elaborazione

#[derive(Deserialize)]
struct ProcessRequest {
    model: String,
    chords: bool,
    notes: bool,
}

/// Avvia (o ripete dopo un errore) separazione e analisi scelte dall'utente.
async fn start_processing(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
    Json(req): Json<ProcessRequest>,
) -> Result<Json<Song>, AppError> {
    if !MODELS.contains(&req.model.as_str()) {
        return Err(bad_request(format!("modello non valido: {}", req.model)));
    }
    let song = st.get(&id).ok_or_else(not_found)?;
    if !matches!(song.status, Status::New | Status::Error) {
        return Err(AppError(StatusCode::CONFLICT, "elaborazione già avviata o completata".into()));
    }
    let dir = st.song_dir(&id);
    for sub in ["stems", "sep", "render"] {
        let _ = tokio::fs::remove_dir_all(dir.join(sub)).await;
    }
    for f in ["chords.json", "notes.json"] {
        let _ = tokio::fs::remove_file(dir.join(f)).await;
    }
    let song = st
        .update(&id, true, |s| {
            s.model = req.model.clone();
            s.tasks = Tasks { chords: req.chords, notes: req.notes };
            s.status = Status::Queued;
            s.progress = 0.0;
            s.error = None;
            s.stems.clear();
        })
        .ok_or_else(not_found)?;
    st.0.queue.send(id).map_err(|_| anyhow!("coda chiusa"))?;
    info!("elaborazione richiesta per '{}' ({})", song.name, song.model);
    Ok(Json(song))
}

/// Errore "analisi non eseguita": l'interfaccia mostra il pulsante per avviarla.
fn not_analyzed(what: &str) -> AppError {
    AppError(StatusCode::CONFLICT, format!("{what} non ancora eseguita"))
}

// ------------------------------------------------------------------- accordi

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Chord {
    start: f64,
    end: f64,
    /// Fondamentale 0..11 (0 = Do), `None` = nessun accordo.
    root: Option<u8>,
    quality: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChordSheet {
    chords: Vec<Chord>,
    /// true se l'utente ha corretto gli accordi rilevati.
    #[serde(default)]
    edited: bool,
}

/// Esegue il riconoscimento accordi (una volta sola) e restituisce il percorso del risultato.
async fn analyze_chords(st: &AppState, id: &str, stems: &[String]) -> anyhow::Result<PathBuf> {
    let dir = st.song_dir(id);
    let out = dir.join("chords.json");
    let lock = st.render_lock(&out);
    let _guard = lock.lock().await;
    if out.exists() {
        return Ok(out);
    }
    // Solo le parti armoniche: voce e batteria peggiorano il riconoscimento.
    let harmonic: Vec<&String> = stems
        .iter()
        .filter(|s| *s != "vocals" && *s != "drums")
        .collect();
    let used = if harmonic.is_empty() { stems.iter().collect() } else { harmonic };
    let tmp = dir.join("chords.json.tmp");
    let t0 = std::time::Instant::now();
    let output = Command::new("python3")
        .arg(st.0.analysis_dir.join("chords.py"))
        .arg(&tmp)
        .args(used.iter().map(|s| dir.join("stems").join(format!("{s}.flac"))))
        .stdin(Stdio::null())
        .output()
        .await
        .context("avvio analisi accordi")?;
    if !output.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        let err = String::from_utf8_lossy(&output.stderr);
        bail!(
            "analisi accordi fallita: {}",
            err.lines().last().unwrap_or("errore sconosciuto")
        );
    }
    tokio::fs::rename(&tmp, &out).await?;
    info!("accordi {id} analizzati in {:.1}s", t0.elapsed().as_secs_f32());
    Ok(out)
}

/// Accordi del brano; con `run` esegue l'analisi se manca, altrimenti risponde "non eseguita".
async fn load_chords(st: &AppState, song: &Song, run: bool) -> Result<ChordSheet, AppError> {
    let dir = st.song_dir(&song.id);
    let edited = dir.join("chords.edited.json");
    let auto = dir.join("chords.json");
    let analyzing = st.0.render_locks.lock().unwrap().get(&auto).is_some_and(|l| l.try_lock().is_err());
    let (path, is_edited) = if edited.exists() {
        (edited, true)
    } else if auto.exists() || run || analyzing {
        (analyze_chords(st, &song.id, &song.stems).await?, false)
    } else {
        return Err(not_analyzed("analisi accordi"));
    };
    let mut sheet: ChordSheet = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
    sheet.edited = is_edited;
    Ok(sheet)
}

fn ready_song(st: &AppState, id: &str) -> Result<Song, AppError> {
    st.get(id)
        .filter(|s| s.status == Status::Ready)
        .ok_or_else(not_found)
}

async fn get_chords(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<ChordSheet>, AppError> {
    let song = ready_song(&st, &id)?;
    Ok(Json(load_chords(&st, &song, false).await?))
}

async fn analyze_chords_now(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<ChordSheet>, AppError> {
    let song = ready_song(&st, &id)?;
    Ok(Json(load_chords(&st, &song, true).await?))
}

/// Salva gli accordi corretti dall'utente (quelli rilevati restano per il ripristino).
async fn put_chords(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
    Json(mut sheet): Json<ChordSheet>,
) -> Result<Json<ChordSheet>, AppError> {
    ready_song(&st, &id)?;
    if sheet.chords.len() > 10_000 {
        return Err(bad_request("troppi accordi"));
    }
    for c in &sheet.chords {
        let valid = c.start.is_finite()
            && c.end.is_finite()
            && c.start >= 0.0
            && c.end > c.start
            && c.root.map_or(true, |r| r < 12)
            && c.quality.as_deref().map_or(true, |q| CHORD_QUALITIES.contains(&q))
            && c.root.is_some() == c.quality.is_some();
        if !valid {
            return Err(bad_request("accordo non valido"));
        }
    }
    sheet.chords.sort_by(|a, b| a.start.total_cmp(&b.start));
    sheet.edited = true;
    let path = st.song_dir(&id).join("chords.edited.json");
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, serde_json::to_vec(&sheet)?).await?;
    tokio::fs::rename(&tmp, &path).await?;
    Ok(Json(sheet))
}

/// Elimina le correzioni e torna agli accordi rilevati automaticamente.
async fn reset_chords(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<ChordSheet>, AppError> {
    let song = ready_song(&st, &id)?;
    let path = st.song_dir(&id).join("chords.edited.json");
    if path.exists() {
        tokio::fs::remove_file(path).await?;
    }
    Ok(Json(load_chords(&st, &song, false).await?))
}

// ---------------------------------------------------------------------- note

#[derive(Clone, Debug, Serialize, Deserialize)]
struct NoteEvent {
    start: f64,
    end: f64,
    pitch: u8,
    velocity: u8,
}

#[derive(Serialize, Deserialize)]
struct Transcription {
    tracks: HashMap<String, Vec<NoteEvent>>,
    grid: serde_json::Value,
    /// tracce corrette a mano
    #[serde(default)]
    edited: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct NotesBody {
    notes: Vec<NoteEvent>,
}

/// Trascrive tutte le tracce (una volta sola) e restituisce il percorso di notes.json.
async fn transcribe(st: &AppState, id: &str, stems: &[String]) -> anyhow::Result<PathBuf> {
    let dir = st.song_dir(id);
    let out = dir.join("notes.json");
    let lock = st.render_lock(&out);
    let _guard = lock.lock().await;
    if out.exists() {
        return Ok(out);
    }
    let tmp = dir.join("notes.json.tmp");
    let t0 = std::time::Instant::now();
    let output = Command::new("python3")
        .arg(st.0.analysis_dir.join("transcribe.py"))
        .arg(&tmp)
        .arg(dir.join("stems"))
        .args(stems)
        .stdin(Stdio::null())
        .output()
        .await
        .context("avvio trascrizione")?;
    if !output.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        let err = String::from_utf8_lossy(&output.stderr);
        bail!(
            "trascrizione fallita: {}",
            err.lines().last().unwrap_or("errore sconosciuto")
        );
    }
    tokio::fs::rename(&tmp, &out).await?;
    info!("note {id} trascritte in {:.1}s", t0.elapsed().as_secs_f32());
    Ok(out)
}

async fn refine_grid(st: &AppState, id: &str, stems: &[String], path: &Path) -> anyhow::Result<()> {
    let lock = st.render_lock(path);
    let _guard = lock.lock().await;
    let current: serde_json::Value = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    if current["grid"]["version"].as_u64().unwrap_or(1) >= 2 {
        return Ok(()); // già fatto da una richiesta concorrente
    }
    let t0 = std::time::Instant::now();
    let output = Command::new("python3")
        .arg(st.0.analysis_dir.join("transcribe.py"))
        .arg("--refine-grid")
        .arg(path)
        .arg(st.song_dir(id).join("stems"))
        .args(stems)
        .stdin(Stdio::null())
        .output()
        .await
        .context("avvio riallineamento battiti")?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        bail!("riallineamento battiti fallito: {}", err.lines().last().unwrap_or("errore sconosciuto"));
    }
    info!("battiti {id} riallineati in {:.1}s", t0.elapsed().as_secs_f32());
    Ok(())
}

fn edited_notes_path(st: &AppState, id: &str, stem: &str) -> PathBuf {
    st.song_dir(id).join("notes.edited").join(format!("{stem}.json"))
}

/// Note e griglia ritmica; con `run` esegue la trascrizione se manca.
async fn load_notes(st: &AppState, song: &Song, run: bool) -> Result<Transcription, AppError> {
    let auto = st.song_dir(&song.id).join("notes.json");
    let busy = st.0.render_locks.lock().unwrap().get(&auto).is_some_and(|l| l.try_lock().is_err());
    if !auto.exists() && !run && !busy {
        return Err(not_analyzed("trascrizione note"));
    }
    let path = transcribe(st, &song.id, &song.stems).await?;
    let mut t: Transcription = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
    if t.grid["version"].as_u64().unwrap_or(1) < 2 {
        // trascrizione di una versione precedente: riallinea i battiti ai colpi reali (una volta sola)
        refine_grid(st, &song.id, &song.stems, &path).await?;
        t = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
    }
    t.edited.clear();
    for stem in &song.stems {
        let p = edited_notes_path(st, &song.id, stem);
        if let Ok(b) = tokio::fs::read(&p).await {
            let body: NotesBody = serde_json::from_slice(&b)?;
            t.tracks.insert(stem.clone(), body.notes);
            t.edited.push(stem.clone());
        }
    }
    t.grid = effective_grid(&t.grid, song.rhythm);
    Ok(t)
}

async fn get_notes(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Transcription>, AppError> {
    let song = ready_song(&st, &id)?;
    Ok(Json(load_notes(&st, &song, false).await?))
}

async fn transcribe_now(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Transcription>, AppError> {
    let song = ready_song(&st, &id)?;
    Ok(Json(load_notes(&st, &song, true).await?))
}

/// Imposta metro e correzioni della griglia; restituisce la griglia aggiornata.
async fn put_rhythm(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
    Json(r): Json<Rhythm>,
) -> Result<Json<serde_json::Value>, AppError> {
    ready_song(&st, &id)?;
    if !METERS.contains(&r.time_signature)
        || !(-16..=16).contains(&r.offset)
        || ![0.5f32, 1.0, 2.0].contains(&r.multiplier)
    {
        return Err(bad_request("impostazioni ritmiche non valide"));
    }
    let song = st.update(&id, true, |s| s.rhythm = Some(r)).ok_or_else(not_found)?;
    Ok(Json(load_notes(&st, &song, false).await?.grid))
}

async fn put_notes(
    State(st): State<AppState>,
    UrlPath((id, stem)): UrlPath<(String, String)>,
    Json(mut body): Json<NotesBody>,
) -> Result<StatusCode, AppError> {
    let song = ready_song(&st, &id)?;
    if !song.stems.contains(&stem) {
        return Err(not_found());
    }
    if body.notes.len() > 50_000 {
        return Err(bad_request("troppe note"));
    }
    for n in &body.notes {
        let ok = n.start.is_finite()
            && n.end.is_finite()
            && n.start >= 0.0
            && n.end > n.start
            && n.pitch <= 127
            && (1..=127).contains(&n.velocity);
        if !ok {
            return Err(bad_request("nota non valida"));
        }
    }
    body.notes.sort_by(|a, b| a.start.total_cmp(&b.start));
    let path = edited_notes_path(&st, &id, &stem);
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, serde_json::to_vec(&body)?).await?;
    tokio::fs::rename(&tmp, &path).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reset_notes(
    State(st): State<AppState>,
    UrlPath((id, stem)): UrlPath<(String, String)>,
) -> Result<Json<Transcription>, AppError> {
    let song = ready_song(&st, &id)?;
    let path = edited_notes_path(&st, &id, &stem);
    if path.exists() {
        tokio::fs::remove_file(path).await?;
    }
    Ok(Json(load_notes(&st, &song, false).await?))
}

#[derive(Deserialize)]
struct ScoreRequest {
    pitch: Option<i32>,
    tempo: Option<u32>,
    key: Option<serde_json::Value>,
    title: Option<String>,
    grid_div: Option<u32>,
}

/// Spartito MusicXML + eventi quantizzati (per la tablatura) di una traccia.
async fn get_score(
    State(st): State<AppState>,
    UrlPath((id, stem)): UrlPath<(String, String)>,
    Json(req): Json<ScoreRequest>,
) -> Result<Response, AppError> {
    let song = ready_song(&st, &id)?;
    if !song.stems.contains(&stem) {
        return Err(not_found());
    }
    let notes = load_notes(&st, &song, false).await?;
    let input = serde_json::json!({
        "notes": notes.tracks.get(&stem).cloned().unwrap_or_default(),
        "grid": notes.grid,
        "stem": stem,
        "title": req.title.unwrap_or_else(|| song.name.clone()),
        "pitch": req.pitch.unwrap_or(0).clamp(-12, 12),
        "tempo": req.tempo.unwrap_or(100).clamp(25, 200),
        "key": req.key,
        "grid_div": req.grid_div.unwrap_or(4).clamp(1, 8),
    });
    let mut child = Command::new("python3")
        .arg(st.0.analysis_dir.join("score.py"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("avvio generazione spartito")?;
    let mut stdin = child.stdin.take().unwrap();
    let payload = serde_json::to_vec(&input)?;
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&payload).await;
    });
    let output = child.wait_with_output().await?;
    let _ = writer.await;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "generazione spartito fallita: {}",
            err.lines().last().unwrap_or("errore sconosciuto")
        )
        .into());
    }
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        output.stdout,
    )
        .into_response())
}

// ------------------------------------------------------------------ playlist

#[derive(Deserialize)]
struct PlaylistBody {
    name: String,
}

fn playlist_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad_request("nome playlist non valido (1-100 caratteri)"));
    }
    Ok(name.to_owned())
}

async fn list_playlists(State(st): State<AppState>, Extension(user): Extension<auth::User>) -> Json<Vec<Playlist>> {
    Json(
        st.0.playlists
            .read()
            .unwrap()
            .iter()
            .filter(|p| p.owner.as_deref() == Some(user.id.as_str()))
            .cloned()
            .collect(),
    )
}

async fn create_playlist(
    State(st): State<AppState>,
    Extension(user): Extension<auth::User>,
    Json(b): Json<PlaylistBody>,
) -> Result<Json<Playlist>, AppError> {
    let pl = Playlist {
        id: uuid::Uuid::new_v4().to_string(),
        owner: Some(user.id.clone()),
        name: playlist_name(&b.name)?,
        songs: vec![],
        created_at: now_secs(),
    };
    st.edit_playlists(|pls| {
        pls.push(pl.clone());
        Ok(())
    })?;
    Ok(Json(pl))
}

async fn rename_playlist(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
    Json(b): Json<PlaylistBody>,
) -> Result<Json<Playlist>, AppError> {
    let name = playlist_name(&b.name)?;
    st.edit_playlists(|pls| {
        let p = pls.iter_mut().find(|p| p.id == id).ok_or_else(not_found)?;
        p.name = name;
        Ok(Json(p.clone()))
    })
}

async fn delete_playlist(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<StatusCode, AppError> {
    st.edit_playlists(|pls| {
        let n = pls.len();
        pls.retain(|p| p.id != id);
        if pls.len() == n {
            return Err(not_found());
        }
        Ok(StatusCode::NO_CONTENT)
    })
}

async fn add_to_playlist(
    State(st): State<AppState>,
    UrlPath((id, song)): UrlPath<(String, String)>,
) -> Result<Json<Playlist>, AppError> {
    if st.get(&song).is_none() {
        return Err(not_found());
    }
    st.edit_playlists(|pls| {
        let p = pls.iter_mut().find(|p| p.id == id).ok_or_else(not_found)?;
        if !p.songs.contains(&song) {
            p.songs.push(song);
        }
        Ok(Json(p.clone()))
    })
}

async fn remove_from_playlist(
    State(st): State<AppState>,
    UrlPath((id, song)): UrlPath<(String, String)>,
) -> Result<Json<Playlist>, AppError> {
    st.edit_playlists(|pls| {
        let p = pls.iter_mut().find(|p| p.id == id).ok_or_else(not_found)?;
        p.songs.retain(|s| s != &song);
        Ok(Json(p.clone()))
    })
}

#[derive(Deserialize)]
struct ImportRequest {
    url: String,
    model: Option<String>,
}

/// Importa un brano da un URL (YouTube o qualsiasi sito supportato da yt-dlp).
async fn import_url(
    State(st): State<AppState>,
    Extension(user): Extension<auth::User>,
    Json(req): Json<ImportRequest>,
) -> Result<Json<Song>, AppError> {
    let url = req.url.trim().to_owned();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(bad_request("URL non valido"));
    }
    let model = req.model.unwrap_or_else(|| MODELS[0].to_owned());
    if !MODELS.contains(&model.as_str()) {
        return Err(bad_request(format!("modello non valido: {model}")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    tokio::fs::create_dir_all(st.song_dir(&id)).await?;
    let song = Song {
        id: id.clone(),
        name: url.clone(),
        model,
        status: Status::Downloading,
        progress: 0.0,
        stems: vec![],
        error: None,
        source_url: Some(url),
        owner: Some(user.id.clone()),
        phase: None,
        tasks: Tasks::default(),
        rhythm: None,
        settings: None,
        created_at: now_secs(),
    };
    st.0.songs.write().unwrap().insert(id.clone(), song.clone());
    st.save_meta(&song)?;
    info!("import da {} ({id})", song.name);
    tokio::spawn(download_task(st, id));
    Ok(Json(song))
}

async fn download_task(st: AppState, id: String) {
    match download(&st, &id).await {
        Ok(title) => {
            info!("download completato {id}: {title}");
            let done = st.update(&id, true, |s| {
                s.name = title;
                s.status = Status::New;
                s.progress = 0.0;
            });
            if done.is_none() {
                // eliminato durante il download: yt-dlp potrebbe aver ricreato la cartella
                let _ = tokio::fs::remove_dir_all(st.song_dir(&id)).await;
            }
        }
        Err(e) => {
            error!("download {id}: {e:#}");
            let gone = st
                .update(&id, true, |s| {
                    s.status = Status::Error;
                    s.error = Some(format!("{e:#}"));
                })
                .is_none();
            if gone {
                let _ = tokio::fs::remove_dir_all(st.song_dir(&id)).await;
            }
        }
    }
}

/// Scarica l'audio con yt-dlp in `input.<ext>` e restituisce il titolo.
async fn download(st: &AppState, id: &str) -> anyhow::Result<String> {
    let url = st
        .get(id)
        .and_then(|s| s.source_url)
        .ok_or_else(|| anyhow!("URL mancante"))?;
    let dir = st.song_dir(id);
    tokio::fs::create_dir_all(&dir).await?;
    for e in std::fs::read_dir(&dir)?.filter_map(Result::ok) {
        if e.file_name().to_string_lossy().starts_with("input.") {
            let _ = std::fs::remove_file(e.path());
        }
    }

    let mut child = Command::new("yt-dlp")
        .args([
            "--no-playlist",
            "--newline",
            "--no-part",
            "--no-mtime",
            "--write-info-json",
            "--max-filesize",
            "1G",
            "-f",
            "bestaudio/best",
            "-o",
        ])
        .arg(dir.join("input.%(ext)s"))
        .arg("--")
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("avvio yt-dlp")?;

    let mut stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });
    for_each_line(child.stdout.take().unwrap(), |line| {
        if line.starts_with("[download]") {
            if let Some(pct) = parse_percent(&line) {
                st.update(id, false, |s| s.progress = (pct / 100.0).min(0.99));
            }
        }
    })
    .await?;
    let status = child.wait().await?;
    let stderr = err_task.await.unwrap_or_default();
    if !status.success() {
        let msg = stderr
            .lines()
            .filter(|l| l.starts_with("ERROR"))
            .last()
            .unwrap_or_else(|| stderr.lines().last().unwrap_or("errore sconosciuto"))
            .trim_start_matches("ERROR: ")
            .to_owned();
        bail!("download fallito: {msg}");
    }

    let info_path = dir.join("input.info.json");
    let title = std::fs::read(&info_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(str::to_owned))
        .unwrap_or_else(|| "Brano importato".to_owned());
    let _ = tokio::fs::remove_file(info_path).await;
    find_input(&dir)?;
    Ok(title)
}

#[derive(Deserialize)]
struct RenderParams {
    pitch: Option<i32>,
    tempo: Option<u32>,
}

/// Restituisce una traccia, eventualmente trasposta (`pitch` in semitoni)
/// e/o rallentata/accelerata (`tempo` in percentuale) senza alterarne l'altro parametro.
async fn get_stem(
    State(st): State<AppState>,
    UrlPath((id, stem)): UrlPath<(String, String)>,
    Query(q): Query<RenderParams>,
    req: Request,
) -> Result<Response, AppError> {
    let song = st.get(&id).ok_or_else(not_found)?;
    if song.status != Status::Ready || !song.stems.contains(&stem) {
        return Err(not_found());
    }
    let path = stem_path(&st, &id, &stem, q.pitch, q.tempo).await?;
    Ok(ServeFile::new(path).oneshot(req).await?.into_response())
}

/// Percorso della traccia per la tonalità/velocità richieste (renderizzata se necessario).
async fn stem_path(
    st: &AppState,
    id: &str,
    stem: &str,
    pitch: Option<i32>,
    tempo: Option<u32>,
) -> anyhow::Result<PathBuf> {
    let pitch = pitch.unwrap_or(0).clamp(-12, 12);
    let tempo = tempo.unwrap_or(100).clamp(25, 200);
    let src = st.song_dir(id).join("stems").join(format!("{stem}.flac"));
    if pitch == 0 && tempo == 100 {
        Ok(src)
    } else {
        render(st, id, stem, &src, pitch, tempo).await
    }
}

#[derive(Deserialize)]
struct ExportStem {
    name: String,
    gain: f32,
}

#[derive(Deserialize)]
struct ExportRequest {
    stems: Vec<ExportStem>,
    pitch: Option<i32>,
    tempo: Option<u32>,
    /// Inizio/fine in secondi, nella timeline già adattata al tempo.
    start: Option<f64>,
    end: Option<f64>,
    master: Option<f32>,
    format: String,
    /// Secondi di silenzio (pre-conteggio) prima della musica.
    pre_roll: Option<f64>,
    /// Click del metronomo da aggiungere, con tempi relativi all'inizio del file esportato.
    click: Option<ClickSpec>,
}

#[derive(Deserialize)]
struct ClickSpec {
    times: Vec<f64>,
    accents: Vec<bool>,
    gain: f32,
}

/// Traccia di click (WAV stereo 16 bit): un breve "tic" sinusoidale smorzato per ogni battito,
/// più acuto e forte sul primo tempo della battuta.
fn write_click_wav(path: &Path, c: &ClickSpec) -> anyhow::Result<()> {
    const SR: u32 = 44_100;
    let last = c.times.iter().cloned().fold(0.0, f64::max);
    let len = ((last + 0.2) * SR as f64) as usize;
    let mut buf = vec![0f32; len];
    let burst = (0.05 * SR as f64) as usize;
    for (i, &t) in c.times.iter().enumerate() {
        let accent = c.accents.get(i).copied().unwrap_or(false);
        let (freq, amp) = if accent { (1760.0f32, 0.75f32) } else { (1175.0, 0.5) };
        let start = (t * SR as f64) as usize;
        for n in 0..burst {
            let Some(v) = buf.get_mut(start + n) else { break };
            let tt = n as f32 / SR as f32;
            *v += amp * c.gain * (std::f32::consts::TAU * freq * tt).sin() * (-tt * 70.0).exp();
        }
    }
    let data_len = (len * 4) as u32;
    let mut out = Vec::with_capacity(44 + len * 4);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&2u16.to_le_bytes()); // stereo
    out.extend_from_slice(&SR.to_le_bytes());
    out.extend_from_slice(&(SR * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for v in buf {
        let s = (v.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&s.to_le_bytes());
        out.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// Mixa le tracce indicate (es. tutte tranne la voce = base) e restituisce il file audio.
async fn export_mix(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
    Json(req): Json<ExportRequest>,
) -> Result<Response, AppError> {
    let song = st.get(&id).ok_or_else(not_found)?;
    if song.status != Status::Ready {
        return Err(not_found());
    }
    let (ext, content_type, codec): (&str, &str, &[&str]) = match req.format.as_str() {
        "mp3" => ("mp3", "audio/mpeg", &["-c:a", "libmp3lame", "-b:a", "320k"]),
        "wav" => ("wav", "audio/wav", &["-c:a", "pcm_s16le"]),
        "flac" => ("flac", "audio/flac", &["-c:a", "flac"]),
        f => return Err(bad_request(format!("formato non valido: {f}"))),
    };
    let stems: Vec<&ExportStem> = req.stems.iter().filter(|s| s.gain > 0.0).collect();
    if stems.is_empty() {
        return Err(bad_request("nessuna traccia attiva da esportare"));
    }

    let mut inputs = vec![];
    let mut filter = String::new();
    for (i, s) in stems.iter().enumerate() {
        if !song.stems.contains(&s.name) {
            return Err(bad_request(format!("traccia sconosciuta: {}", s.name)));
        }
        inputs.push(stem_path(&st, &id, &s.name, req.pitch, req.tempo).await?);
        filter += &format!("[{i}:a]volume={:.4}[a{i}];", s.gain.clamp(0.0, 2.0));
    }
    for i in 0..stems.len() {
        filter += &format!("[a{i}]");
    }
    if stems.len() > 1 {
        filter += &format!("amix=inputs={}:normalize=0:duration=longest,", stems.len());
    } else {
        filter += "anull,";
    }
    filter += &format!("volume={:.4}", req.master.unwrap_or(1.0).clamp(0.0, 2.0));
    let start = req.start.unwrap_or(0.0).max(0.0);
    match req.end {
        Some(end) if end > start => {
            filter += &format!(",atrim=start={start:.4}:end={end:.4},asetpts=PTS-STARTPTS")
        }
        Some(_) => return Err(bad_request("selezione non valida")),
        None if start > 0.0 => {
            filter += &format!(",atrim=start={start:.4},asetpts=PTS-STARTPTS")
        }
        None => {}
    }
    // pre-conteggio: la musica parte dopo `pre_roll` secondi
    let pre_roll = req.pre_roll.unwrap_or(0.0);
    if !(0.0..=30.0).contains(&pre_roll) {
        return Err(bad_request("pre-conteggio non valido"));
    }
    if pre_roll > 0.0 {
        filter += &format!(",adelay=delays={}:all=1", (pre_roll * 1000.0).round() as u64);
    }

    let dir = st.song_dir(&id).join("exports");
    tokio::fs::create_dir_all(&dir).await?;
    let job = uuid::Uuid::new_v4();
    let out = dir.join(format!("{job}.{ext}"));
    let click_path = dir.join(format!("{job}.click.wav"));
    match &req.click {
        Some(c) if !c.times.is_empty() => {
            let valid = c.times.len() <= 50_000
                && c.gain.is_finite()
                && c.times.iter().all(|t| t.is_finite() && (0.0..=7200.0).contains(t));
            if !valid {
                return Err(bad_request("click non valido"));
            }
            write_click_wav(&click_path, c)?;
            inputs.push(click_path.clone());
            filter += &format!(
                "[mus];[mus][{}:a]amix=inputs=2:normalize=0:duration=longest[out]",
                inputs.len() - 1
            );
        }
        _ => filter += "[out]",
    }

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    for p in &inputs {
        cmd.arg("-i").arg(p);
    }
    let t0 = std::time::Instant::now();
    let output = cmd
        .args(["-filter_complex", &filter, "-map", "[out]"])
        .args(codec)
        .arg(&out)
        .stdin(Stdio::null())
        .output()
        .await
        .context("avvio ffmpeg")?;
    if !output.status.success() {
        let _ = tokio::fs::remove_file(&out).await;
        let _ = tokio::fs::remove_file(&click_path).await;
        return Err(anyhow!(
            "ffmpeg fallito: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let data = tokio::fs::read(&out).await?;
    let _ = tokio::fs::remove_file(&out).await;
    let _ = tokio::fs::remove_file(&click_path).await;
    info!(
        "export {id}: {} tracce, {ext}, {:.1} MB in {:.1}s",
        stems.len(),
        data.len() as f64 / 1048576.0,
        t0.elapsed().as_secs_f32()
    );
    Ok(([(axum::http::header::CONTENT_TYPE, content_type)], data).into_response())
}

async fn render(
    st: &AppState,
    id: &str,
    stem: &str,
    src: &Path,
    pitch: i32,
    tempo: u32,
) -> anyhow::Result<PathBuf> {
    let dir = st.song_dir(id).join("render");
    let out = dir.join(format!("{stem}_p{pitch}_t{tempo}.flac"));
    let lock = st.render_lock(&out);
    let _guard = lock.lock().await;
    if out.exists() {
        return Ok(out);
    }
    let _permit = st.0.render_sem.acquire().await?;
    tokio::fs::create_dir_all(&dir).await?;
    let tmp = dir.join(format!("{stem}_p{pitch}_t{tempo}.tmp.flac"));

    let t0 = std::time::Instant::now();
    let output = Command::new("rubberband")
        .args(&st.0.rubberband_args)
        .arg("-q")
        .arg("-p")
        .arg(pitch.to_string())
        .arg("-T")
        .arg(format!("{:.4}", tempo as f64 / 100.0))
        .arg(src)
        .arg(&tmp)
        .stdin(Stdio::null())
        .output()
        .await
        .context("avvio rubberband")?;
    if !output.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        bail!(
            "rubberband fallito: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    tokio::fs::rename(&tmp, &out).await?;
    info!(
        "render {id}/{stem} pitch={pitch} tempo={tempo}% in {:.1}s",
        t0.elapsed().as_secs_f32()
    );
    Ok(out)
}

// --------------------------------------------------------------------- worker

async fn worker(st: AppState, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(id) = rx.recv().await {
        if st.get(&id).is_none() {
            continue;
        }
        match separate(&st, &id).await {
            Ok(stems) => {
                info!("separazione completata {id}: {stems:?}");
                let tasks = st.get(&id).map(|s| s.tasks).unwrap_or_default();
                if tasks.chords {
                    st.update(&id, false, |s| s.phase = Some("Analisi accordi".into()));
                    if let Err(e) = analyze_chords(&st, &id, &stems).await {
                        warn!("{id}: {e:#}");
                    }
                }
                st.update(&id, true, |s| {
                    s.status = Status::Ready;
                    s.progress = 1.0;
                    s.stems = stems.clone();
                    s.error = None;
                    s.phase = tasks.notes.then(|| "Trascrizione note".into());
                });
                // Il brano è già utilizzabile; la trascrizione prosegue (chi la chiede attende il lock).
                if tasks.notes {
                    if let Err(e) = transcribe(&st, &id, &stems).await {
                        warn!("{id}: {e:#}");
                    }
                    st.update(&id, true, |s| s.phase = None);
                }
            }
            Err(e) => {
                error!("separazione {id}: {e:#}");
                st.update(&id, true, |s| {
                    s.status = Status::Error;
                    s.error = Some(format!("{e:#}"));
                    s.phase = None;
                });
            }
        }
    }
}

async fn separate(st: &AppState, id: &str) -> anyhow::Result<Vec<String>> {
    let song = st
        .update(id, true, |s| {
            s.status = Status::Processing;
            s.progress = 0.0;
        })
        .ok_or_else(|| anyhow!("canzone eliminata"))?;
    let dir = st.song_dir(id);
    let input = find_input(&dir)?;
    let sep_dir = dir.join("sep");
    let _ = tokio::fs::remove_dir_all(&sep_dir).await;

    info!("avvio demucs {} su {}", song.model, input.display());
    let mut child = Command::new("python3")
        .args(["-m", "demucs", "-n", &song.model, "-d", &st.0.device, "--flac"])
        .arg("-o")
        .arg(&sep_dir)
        .args(["--filename", "{stem}.{ext}"])
        .arg(&input)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("avvio demucs")?;

    // Demucs scrive l'avanzamento (tqdm) su stderr: lo usiamo per la barra di progresso.
    // I modelli "bag" (htdemucs_ft) eseguono 4 passate, ognuna da 0 a 100%.
    let passes = if song.model == "htdemucs_ft" { 4.0 } else { 1.0 };
    let mut tail: VecDeque<String> = VecDeque::new();
    let (mut pass, mut last_pct) = (0.0f32, 0.0f32);
    for_each_line(child.stderr.take().unwrap(), |s| {
        if let Some(pct) = parse_percent(&s) {
            if pct + 50.0 < last_pct {
                pass += 1.0;
            }
            last_pct = pct;
            let p = ((pass + pct / 100.0) / passes).min(0.99);
            st.update(id, false, |s| s.progress = p);
        } else {
            tail.push_back(s);
            if tail.len() > 12 {
                tail.pop_front();
            }
        }
    })
    .await?;
    let status = child.wait().await?;
    if st.get(id).is_none() {
        bail!("canzone eliminata durante l'elaborazione");
    }
    if !status.success() {
        bail!(
            "demucs fallito ({status}): {}",
            tail.into_iter().collect::<Vec<_>>().join(" | ")
        );
    }

    let out_dir = sep_dir.join(&song.model);
    let stems_dir = dir.join("stems");
    tokio::fs::create_dir_all(&stems_dir).await?;
    let mut stems = vec![];
    let mut rd = tokio::fs::read_dir(&out_dir).await.context("output demucs mancante")?;
    while let Some(e) = rd.next_entry().await? {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) == Some("flac") {
            let name = p.file_stem().unwrap().to_string_lossy().into_owned();
            tokio::fs::rename(&p, stems_dir.join(format!("{name}.flac"))).await?;
            stems.push(name);
        }
    }
    let _ = tokio::fs::remove_dir_all(&sep_dir).await;
    if stems.is_empty() {
        bail!("demucs non ha prodotto tracce");
    }
    stems.sort_by_key(|s| STEM_ORDER.iter().position(|o| o == s).unwrap_or(usize::MAX));
    Ok(stems)
}

fn find_input(dir: &Path) -> anyhow::Result<PathBuf> {
    std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| {
            p.file_stem().and_then(|s| s.to_str()) == Some("input")
                && p.extension().is_some_and(|e| e != "json")
        })
        .ok_or_else(|| anyhow!("file di input mancante"))
}

/// Legge l'output di un processo riga per riga (separatori `\n` e `\r`, usato dalle barre di progresso).
async fn for_each_line<R: AsyncRead + Unpin>(
    mut r: R,
    mut f: impl FnMut(String),
) -> std::io::Result<()> {
    let mut buf = [0u8; 4096];
    let mut line = Vec::new();
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if b != b'\r' && b != b'\n' {
                line.push(b);
                continue;
            }
            let s = String::from_utf8_lossy(&line).trim().to_owned();
            line.clear();
            if !s.is_empty() {
                f(s);
            }
        }
    }
    Ok(())
}

fn parse_percent(s: &str) -> Option<f32> {
    let idx = s.find('%')?;
    let head = &s[..idx];
    let start = head
        .rfind(|c: char| !c.is_ascii_digit() && c != '.')
        .map_or(0, |i| i + 1);
    head[start..].parse().ok()
}

// ----------------------------------------------------------------------- main

fn load_songs(data_dir: &Path) -> HashMap<String, Song> {
    let mut map = HashMap::new();
    let Ok(rd) = std::fs::read_dir(data_dir.join("songs")) else {
        return map;
    };
    for e in rd.filter_map(Result::ok) {
        let meta = e.path().join("meta.json");
        match std::fs::read(&meta)
            .map_err(anyhow::Error::from)
            .and_then(|b| Ok(serde_json::from_slice::<Song>(&b)?))
        {
            Ok(s) => {
                map.insert(s.id.clone(), s);
            }
            Err(err) => warn!("ignoro {}: {err:#}", meta.display()),
        }
    }
    map
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("handler SIGTERM");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = term.recv() => {},
    }
    info!("arresto in corso");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_owned());
    let data_dir = PathBuf::from(env("DATA_DIR", "/data"));
    let static_dir = PathBuf::from(env("STATIC_DIR", "/app/static"));
    let port: u16 = env("PORT", "8080").parse()?;
    let render_jobs: usize = env("RENDER_JOBS", "0").parse().unwrap_or(0);
    let render_jobs = if render_jobs == 0 {
        std::thread::available_parallelism().map_or(4, |n| n.get())
    } else {
        render_jobs
    };
    std::fs::create_dir_all(data_dir.join("songs"))?;

    let mut songs = load_songs(&data_dir);
    // una fase rimasta da un'esecuzione interrotta non è più valida (le analisi ripartono su richiesta)
    songs
        .values_mut()
        .filter(|s| s.status == Status::Ready)
        .for_each(|s| s.phase = None);
    let playlists: Vec<Playlist> = std::fs::read(data_dir.join("playlists.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .map(|mut pls: Vec<Playlist>| {
            // scarta riferimenti a brani non più presenti
            pls.iter_mut().for_each(|p| p.songs.retain(|s| songs.contains_key(s)));
            pls
        })
        .unwrap_or_default();
    let (tx, rx) = mpsc::unbounded_channel();
    let st = AppState(Arc::new(Inner {
        auth: auth::Auth::open(&data_dir)?,
        data_dir,
        analysis_dir: env("ANALYSIS_DIR", "/app/analysis").into(),
        playlists: RwLock::new(playlists),
        device: env("DEMUCS_DEVICE", "cpu"),
        rubberband_args: env("RUBBERBAND_ARGS", "")
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        songs: RwLock::new(songs),
        queue: tx,
        render_locks: Mutex::default(),
        render_sem: Semaphore::new(render_jobs),
    }));

    // Rimette in coda i lavori interrotti da un riavvio.
    let mut pending: Vec<Song> = st
        .0
        .songs
        .read()
        .unwrap()
        .values()
        .filter(|s| matches!(s.status, Status::Queued | Status::Processing))
        .cloned()
        .collect();
    pending.sort_by_key(|s| s.created_at);
    for s in pending {
        info!("rimetto in coda {}", s.id);
        st.0.queue.send(s.id)?;
    }
    let downloads: Vec<String> = st
        .0
        .songs
        .read()
        .unwrap()
        .values()
        .filter(|s| s.status == Status::Downloading)
        .map(|s| s.id.clone())
        .collect();
    for id in downloads {
        info!("riprendo download {id}");
        tokio::spawn(download_task(st.clone(), id));
    }
    tokio::spawn(worker(st.clone(), rx));

    let app = Router::new()
        .route(
            "/api/songs",
            get(list_songs)
                .post(upload)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD)),
        )
        .route("/api/playlists", get(list_playlists).post(create_playlist))
        .route(
            "/api/playlists/:id",
            axum::routing::patch(rename_playlist).delete(delete_playlist),
        )
        .route(
            "/api/playlists/:id/songs/:song",
            axum::routing::put(add_to_playlist).delete(remove_from_playlist),
        )
        .route("/api/import", axum::routing::post(import_url))
        .route("/api/songs/:id", get(get_song).delete(delete_song))
        .route("/api/songs/:id/stems/:stem", get(get_stem))
        .route(
            "/api/songs/:id/settings",
            axum::routing::put(save_settings).delete(reset_settings),
        )
        .route("/api/songs/:id/process", axum::routing::post(start_processing))
        .route("/api/songs/:id/chords", get(get_chords).put(put_chords))
        .route("/api/songs/:id/chords/analyze", axum::routing::post(analyze_chords_now))
        .route("/api/songs/:id/notes/analyze", axum::routing::post(transcribe_now))
        .route("/api/songs/:id/rhythm", axum::routing::put(put_rhythm))
        .route("/api/songs/:id/notes", get(get_notes))
        .route("/api/songs/:id/notes/:stem", axum::routing::put(put_notes))
        .route(
            "/api/songs/:id/notes/:stem/edits",
            axum::routing::delete(reset_notes),
        )
        .route("/api/songs/:id/score/:stem", axum::routing::post(get_score))
        .route(
            "/api/songs/:id/chords/edits",
            axum::routing::delete(reset_chords),
        )
        .route("/api/songs/:id/export", axum::routing::post(export_mix))
        .route("/api/health", get(|| async { "ok" }))
        // autenticazione (pubbliche, tranne il cambio password)
        .route("/api/auth/config", get(auth::config))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/verify", get(auth::verify))
        .route("/api/auth/resend", post(auth::resend))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/forgot", post(auth::forgot))
        .route("/api/auth/reset", post(auth::reset))
        .route("/api/auth/google/login", get(auth::google_login))
        .route("/api/auth/google/callback", get(auth::google_callback))
        .route("/api/account/password", post(auth::change_password))
        .fallback_service(ServeDir::new(static_dir))
        .layer(axum::middleware::from_fn_with_state(st.clone(), auth::require_user))
        .layer(TraceLayer::new_for_http())
        .with_state(st);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("in ascolto su http://{addr} (render paralleli: {render_jobs})");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}
