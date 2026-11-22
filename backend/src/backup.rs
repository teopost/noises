//! Backup completo di un progetto e ripristino, anche su un'altra installazione di Noises.
//!
//! Il backup è uno zip con:
//! ```text
//! manifest.json            formato, versione, progetto e brani contenuti (con l'elenco dei file)
//! project.json             il progetto così com'è (tracce, clip, gruppi, segnalibri, sezioni, salvataggi)
//! songs/<id>/meta.json     ogni brano usato dal progetto
//! songs/<id>/…             audio originale, tracce separate, accordi, note e modifiche manuali
//! ```
//! La cache delle tonalità/velocità (`render/`) non c'è: si ricrea da sola.
//! Al ripristino i brani entrano nella libreria dell'utente e il progetto nei suoi progetti.

use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use axum::{
    body::Body,
    extract::{Multipart, Path as UrlPath, State},
    http::header,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

use crate::{bad_request, now_secs, projects, AppError, AppState, Song, Status};

const FORMAT: &str = "noises-project-backup";
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct ManifestSong {
    id: String,
    name: String,
    #[serde(default)]
    stems: Vec<String>,
    #[serde(default)]
    files: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    #[serde(default)]
    app_version: String,
    #[serde(default)]
    created_at: u64,
    project: ManifestProject,
    songs: Vec<ManifestSong>,
}

#[derive(Serialize, Deserialize)]
struct ManifestProject {
    id: String,
    name: String,
    tracks: usize,
}

fn tmp_dir(st: &AppState) -> PathBuf {
    st.0.data_dir.join("tmp")
}

/// File di un brano da mettere nel backup (percorsi relativi alla sua cartella), senza cache.
fn song_files(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.filter_map(Result::ok) {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                if rel != "render" {
                    walk(base, &p, out);
                }
            } else if !rel.ends_with(".tmp") && rel != "meta.json" {
                out.push(rel);
            }
        }
    }
    let mut out = vec![];
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// Nome del file scaricato: il nome del progetto senza caratteri problematici.
fn file_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.()".contains(c) { c } else { '_' })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    format!("{}.noises.zip", if s.is_empty() { "progetto" } else { &s })
}

fn write_zip(path: &Path, project: &projects::Project, songs: &[Song], song_root: &Path) -> anyhow::Result<()> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zw = ZipWriter::new(File::create(path)?);
    // audio già compresso (FLAC, MP3…): si archivia senza ricomprimere
    let opts = |size: u64| {
        SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(size >= u32::MAX as u64)
    };
    let mut entries = vec![];
    for s in songs {
        let files = song_files(&song_root.join(&s.id));
        entries.push(ManifestSong { id: s.id.clone(), name: s.name.clone(), stems: s.stems.clone(), files });
    }
    let manifest = Manifest {
        format: FORMAT.into(),
        version: VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
        created_at: now_secs(),
        project: ManifestProject { id: project.id.clone(), name: project.name.clone(), tracks: project.tracks.len() },
        songs: entries,
    };
    let json = |zw: &mut ZipWriter<File>, name: &str, v: &[u8]| -> anyhow::Result<()> {
        zw.start_file(name, opts(v.len() as u64))?;
        zw.write_all(v)?;
        Ok(())
    };
    json(&mut zw, "manifest.json", &serde_json::to_vec_pretty(&manifest)?)?;
    json(&mut zw, "project.json", &serde_json::to_vec_pretty(project)?)?;
    for (s, m) in songs.iter().zip(&manifest.songs) {
        let mut meta = s.clone();
        meta.owner = None; // si assegna a chi ripristina
        json(&mut zw, &format!("songs/{}/meta.json", s.id), &serde_json::to_vec_pretty(&meta)?)?;
        for rel in &m.files {
            let src = song_root.join(&s.id).join(rel);
            let size = std::fs::metadata(&src)?.len();
            zw.start_file(format!("songs/{}/{rel}", s.id), opts(size))?;
            std::io::copy(&mut File::open(&src)?, &mut zw)?;
        }
    }
    zw.finish()?;
    Ok(())
}

/// GET /api/projects/:pid/backup - zip del progetto con tutti i suoi brani.
pub async fn download(State(st): State<AppState>, UrlPath(pid): UrlPath<String>) -> Result<Response, AppError> {
    let project = projects::get(&st, &pid)?;
    let songs: Vec<Song> = {
        let all = st.0.songs.read().unwrap();
        let mut seen = vec![];
        for t in &project.tracks {
            if !seen.contains(&t.song) {
                seen.push(t.song.clone());
            }
        }
        seen.iter().filter_map(|id| all.get(id).cloned()).collect()
    };
    if let Some(s) = songs.iter().find(|s| matches!(s.status, Status::Downloading | Status::Queued | Status::Processing)) {
        return Err(bad_request(format!("aspetta che finisca l'elaborazione di \"{}\"", s.name)));
    }
    let dir = tmp_dir(&st);
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(format!("backup-{}.zip", uuid::Uuid::new_v4()));
    let root = st.0.data_dir.join("songs");
    {
        let (out, proj) = (path.clone(), project.clone());
        let res = tokio::task::spawn_blocking(move || write_zip(&out, &proj, &songs, &root)).await?;
        if let Err(e) = res {
            let _ = std::fs::remove_file(&path);
            return Err(e.into());
        }
    }
    let file = tokio::fs::File::open(&path).await?;
    let len = file.metadata().await?.len();
    let _ = std::fs::remove_file(&path); // il file aperto resta leggibile fino alla fine dell'invio
    info!("backup del progetto '{}' ({} MB)", project.name, len / 1_000_000);
    let name = file_name(&project.name);
    let ascii: String = name.chars().map(|c| if c.is_ascii() && c != '"' { c } else { '_' }).collect();
    let utf8: String = name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{utf8}")),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response())
}

#[derive(Serialize)]
pub struct Restored {
    id: String,
    name: String,
    songs_added: usize,
    songs_reused: usize,
}

/// Percorso sicuro dentro una cartella (niente `..` o percorsi assoluti).
fn safe_rel(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || p.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::Normal(s) => out.push(s),
            _ => return None,
        }
    }
    Some(out)
}

struct Unpacked {
    project: projects::Project,
    /// id nel backup → brano (meta) e cartella estratta
    songs: Vec<(Song, PathBuf)>,
}

fn unpack(zip_path: &Path, work: &Path) -> anyhow::Result<Unpacked> {
    let mut za = zip::ZipArchive::new(File::open(zip_path)?).map_err(|_| anyhow::anyhow!("il file non è uno zip valido"))?;
    let mut read_json = |name: &str| -> anyhow::Result<Vec<u8>> {
        let mut f = za.by_name(name).map_err(|_| anyhow::anyhow!("nel backup manca {name}"))?;
        let mut v = vec![];
        f.read_to_end(&mut v)?;
        Ok(v)
    };
    let manifest: Manifest = serde_json::from_slice(&read_json("manifest.json")?)
        .map_err(|e| anyhow::anyhow!("manifest.json non valido: {e}"))?;
    if manifest.format != FORMAT {
        anyhow::bail!("non è un backup di un progetto Noises");
    }
    if manifest.version > VERSION {
        anyhow::bail!("backup creato con una versione più recente di Noises ({}): aggiorna questa installazione", manifest.app_version);
    }
    let project: projects::Project = serde_json::from_slice(&read_json("project.json")?)
        .map_err(|e| anyhow::anyhow!("project.json non valido: {e}"))?;
    let mut songs = vec![];
    for ms in &manifest.songs {
        safe_rel(&ms.id).filter(|p| p.components().count() == 1).ok_or_else(|| anyhow::anyhow!("id di brano non valido"))?;
        let meta: Song = serde_json::from_slice(&read_json(&format!("songs/{}/meta.json", ms.id))?)
            .map_err(|e| anyhow::anyhow!("meta.json di \"{}\" non valido: {e}", ms.name))?;
        let dir = work.join(&ms.id);
        std::fs::create_dir_all(&dir)?;
        songs.push((meta, dir));
    }
    // estrae i file dei brani elencati nel manifest
    let wanted: HashMap<String, ()> = manifest
        .songs
        .iter()
        .flat_map(|s| s.files.iter().map(move |f| (format!("songs/{}/{f}", s.id), ())))
        .collect();
    for i in 0..za.len() {
        let mut f = za.by_index(i)?;
        let name = f.name().to_string();
        if f.is_dir() || !wanted.contains_key(&name) {
            continue;
        }
        let rel = safe_rel(name.strip_prefix("songs/").unwrap_or(""))
            .ok_or_else(|| anyhow::anyhow!("percorso non valido nel backup: {name}"))?;
        let out = work.join(rel);
        std::fs::create_dir_all(out.parent().unwrap())?;
        std::io::copy(&mut f, &mut File::create(&out)?)?;
    }
    Ok(Unpacked { project, songs })
}

/// POST /api/backup/restore (multipart, campo "file") - ripristina un progetto dal suo backup.
pub async fn restore(
    State(st): State<AppState>,
    Extension(user): Extension<crate::auth::User>,
    mut mp: Multipart,
) -> Result<Json<Restored>, AppError> {
    let tmp = tmp_dir(&st).join(format!("restore-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&tmp).await?;
    let res = restore_in(&st, &user, &mut mp, &tmp).await;
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    res.map(Json)
}

async fn restore_in(st: &AppState, user: &crate::auth::User, mp: &mut Multipart, tmp: &Path) -> Result<Restored, AppError> {
    let zip_path = tmp.join("backup.zip");
    let mut got = false;
    while let Some(mut field) = mp.next_field().await? {
        if field.name() != Some("file") {
            continue;
        }
        let mut f = tokio::fs::File::create(&zip_path).await?;
        while let Some(chunk) = field.chunk().await? {
            f.write_all(&chunk).await?;
        }
        f.flush().await?;
        got = true;
    }
    if !got {
        return Err(bad_request("nessun file inviato"));
    }
    let work = tmp.join("songs");
    let un = {
        let (z, w) = (zip_path.clone(), work.clone());
        tokio::task::spawn_blocking(move || unpack(&z, &w))
            .await?
            .map_err(|e| bad_request(format!("{e:#}")))?
    };
    let _ = tokio::fs::remove_file(&zip_path).await;

    // brani: lo stesso brano già presente nella libreria dell'utente si riusa, altrimenti si aggiunge
    // (con il suo id, se libero)
    let mut ids: HashMap<String, String> = HashMap::new();
    let (mut added, mut reused) = (0, 0);
    let root = st.0.data_dir.join("songs");
    for (mut song, dir) in un.songs {
        let old = song.id.clone();
        let existing = st.get(&old);
        if existing.as_ref().is_some_and(|s| s.owner.as_deref() == Some(user.id.as_str())) {
            ids.insert(old, song.id);
            reused += 1;
            continue;
        }
        if existing.is_some() || root.join(&old).exists() {
            song.id = uuid::Uuid::new_v4().to_string();
        }
        song.owner = Some(user.id.clone());
        song.progress = 0.0;
        song.phase = None;
        if matches!(song.status, Status::Downloading | Status::Queued | Status::Processing) {
            song.status = Status::New; // elaborazione interrotta al momento del backup
        }
        let dest = root.join(&song.id);
        tokio::fs::create_dir_all(&root).await?;
        if tokio::fs::rename(&dir, &dest).await.is_err() {
            copy_dir(&dir, &dest).await?; // cartella temporanea su un altro disco
        }
        st.0.songs.write().unwrap().insert(song.id.clone(), song.clone());
        if let Err(e) = st.save_meta(&song) {
            warn!("ripristino: meta di {}: {e:#}", song.id);
        }
        ids.insert(old, song.id.clone());
        added += 1;
    }

    // progetto: con il suo id se libero, i brani rimappati
    let mut p = un.project;
    let id_taken = st.0.projects.read().unwrap().contains_key(&p.id);
    if id_taken || safe_rel(&p.id).is_none() {
        p.id = uuid::Uuid::new_v4().to_string();
    }
    p.owner = Some(user.id.clone());
    for t in &mut p.tracks {
        if let Some(n) = ids.get(&t.song) {
            t.song = n.clone();
        }
    }
    p.tracks.retain(|t| st.get(&t.song).is_some());
    let taken: Vec<String> = st
        .0
        .projects
        .read()
        .unwrap()
        .values()
        .filter(|x| x.owner.as_deref() == Some(user.id.as_str()))
        .map(|x| x.name.clone())
        .collect();
    if taken.contains(&p.name) {
        // "Nome" → "Nome (2)", "Nome (2)" → "Nome (3)"…
        let base = match p.name.rsplit_once(" (") {
            Some((b, n)) if n.strip_suffix(')').is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit())) => b.to_string(),
            _ => p.name.clone(),
        };
        let mut n = 2;
        while taken.contains(&format!("{base} ({n})")) {
            n += 1;
        }
        p.name = format!("{base} ({n})");
    }
    let p = projects::store(st, p)?;
    info!("ripristinato il progetto '{}' ({added} brani aggiunti, {reused} già presenti)", p.name);
    Ok(Restored { id: p.id, name: p.name, songs_added: added, songs_reused: reused })
}

async fn copy_dir(src: &Path, dst: &Path) -> anyhow::Result<()> {
    let (src, dst) = (src.to_path_buf(), dst.to_path_buf());
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        fn rec(a: &Path, b: &Path) -> std::io::Result<()> {
            std::fs::create_dir_all(b)?;
            for e in std::fs::read_dir(a)? {
                let e = e?;
                let to = b.join(e.file_name());
                if e.file_type()?.is_dir() {
                    rec(&e.path(), &to)?;
                } else {
                    std::fs::copy(e.path(), to)?;
                }
            }
            Ok(())
        }
        rec(&src, &dst)?;
        Ok(())
    })
    .await??;
    Ok(())
}

/// Pulizia all'avvio di file temporanei rimasti da backup o ripristini interrotti.
pub fn clean_tmp(data_dir: &Path) {
    let dir = data_dir.join("tmp");
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(Result::ok) {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("backup-") || n.starts_with("restore-") {
                let _ = if e.path().is_dir() { std::fs::remove_dir_all(e.path()) } else { std::fs::remove_file(e.path()) };
            }
        }
    }
}
