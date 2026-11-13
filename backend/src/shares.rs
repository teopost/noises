//! Link pubblici: uno o più salvataggi di un progetto condivisi con chiunque abbia il link, senza
//! accesso. Ogni salvataggio diventa un mix già pronto (tracce con i loro volumi, tonalità e
//! velocità) con il suo loop; la pagina permette di passare dall'uno all'altro. Al momento della
//! condivisione si fotografa tutto ciò che serve: le modifiche successive al progetto non cambiano
//! quello che sentono gli altri finché il salvataggio non viene condiviso di nuovo (il nome del
//! progetto invece è sempre quello attuale).

use std::path::{Path, PathBuf};

use axum::{
    extract::{Path as UrlPath, Query, Request, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    Extension, Json,
};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tower::ServiceExt;
use tracing::{info, warn};

use crate::{
    bad_request, ensure_original, mix_to_file, not_found, now_secs, render_file, AppError, AppState, Clip,
    ExportRequest, MixInput,
};

/// Salvataggi in più che si possono includere in un link.
const MAX_EXTRA: usize = 20;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShareTrack {
    song: String,
    part: String,
    clips: Vec<Clip>,
    gain: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fx: Option<crate::fx::Fx>,
    /// linee del volume (della traccia e del suo gruppo)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    envs: Vec<Vec<crate::env::EnvPoint>>,
    /// matrice dei canali (pan), vedi clean_mix
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mix: Option<[f32; 4]>,
}

/// Un mix condiviso: tracce con il loro volume, tonalità, velocità, master e loop.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mix {
    tracks: Vec<ShareTrack>,
    pitch: i32,
    tempo: u32,
    master: f32,
    /// porzione in loop, in secondi alla velocità originale
    #[serde(default)]
    selection: Option<Span>,
    #[serde(default)]
    loop_on: bool,
    #[serde(default)]
    songs: Vec<String>,
}

/// Salvataggio in più incluso nel link.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Variant {
    preset: String,
    name: String,
    #[serde(flatten)]
    mix: Mix,
    /// sezioni (loop) di questo salvataggio; assente nei link di prima: valgono quelle del link
    #[serde(default, skip_serializing_if = "Option::is_none")]
    regions: Option<Vec<Named>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Share {
    pub token: String,
    pub owner: String,
    pub project: String,
    /// salvataggio condiviso (ricondividendolo il link resta lo stesso)
    #[serde(default)]
    pub preset: Option<String>,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(flatten)]
    mix: Mix,
    /// altri salvataggi da scegliere nella pagina
    #[serde(default)]
    extra: Vec<Variant>,
    #[serde(default)]
    regions: Vec<Named>,
    #[serde(default)]
    markers: Vec<Named>,
    /// la pagina offre i pulsanti per accendere e spegnere le tracce separate (un file per traccia)
    #[serde(default)]
    stem_toggles: bool,
    /// la pagina offre l'elenco dei loop tra cui scegliere (le sezioni del progetto);
    /// i link creati prima di questa opzione lo mostravano sempre
    #[serde(default = "yes")]
    loop_choice: bool,
    /// la pagina offre il comando per cambiare la velocità (in tempo reale, nel browser)
    #[serde(default)]
    speed_choice: bool,
}

fn yes() -> bool {
    true
}

/// Tracce udibili di un mix raggruppate per i pulsanti della pagina: un gruppo per tipo di traccia
/// separata (voce, batteria…, nell'ordine solito) e in fondo "rest", tutto ciò che non è separato.
fn stem_groups(m: &Mix) -> Vec<(String, Vec<&ShareTrack>)> {
    let mut out: Vec<(String, Vec<&ShareTrack>)> = vec![];
    for t in m.tracks.iter().filter(|t| t.gain > 0.0 && !t.clips.is_empty()) {
        let key = if t.part == "original" { "rest" } else { t.part.as_str() };
        match out.iter_mut().find(|(k, _)| k == key) {
            Some((_, v)) => v.push(t),
            None => out.push((key.to_owned(), vec![t])),
        }
    }
    out.sort_by_key(|(k, _)| match k.as_str() {
        "rest" => usize::MAX,
        k => crate::STEM_ORDER.iter().position(|o| *o == k).unwrap_or(usize::MAX - 1),
    });
    out
}

/// Gruppi con un pulsante nella pagina; vuoto = mix unico (opzione spenta, o niente da scegliere).
fn toggle_groups<'a>(sh: &Share, m: &'a Mix) -> Vec<(String, Vec<&'a ShareTrack>)> {
    if !sh.stem_toggles {
        return vec![];
    }
    let g = stem_groups(m);
    // servono almeno due gruppi, di cui uno di tracce separate ("rest" è al massimo uno)
    if g.len() < 2 { vec![] } else { g }
}

impl Share {
    /// Mix numero `i`: 0 = salvataggio principale, poi quelli in più.
    fn mix(&self, i: usize) -> Option<&Mix> {
        if i == 0 { Some(&self.mix) } else { self.extra.get(i - 1).map(|v| &v.mix) }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Span {
    start: f64,
    end: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Named {
    name: String,
    start: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    end: Option<f64>,
}

pub fn load(data_dir: &Path) -> Vec<Share> {
    std::fs::read(data_dir.join("shares.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn audio_dir(st: &AppState) -> PathBuf {
    st.0.data_dir.join("shares")
}

/// Modifica i link e li salva su disco (sotto lock, per serializzare le scritture).
fn edit<R>(st: &AppState, f: impl FnOnce(&mut Vec<Share>) -> Result<R, AppError>) -> Result<R, AppError> {
    let mut all = st.0.shares.write().unwrap();
    let r = f(&mut all)?;
    let path = st.0.data_dir.join("shares.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&*all)?)?;
    std::fs::rename(tmp, path)?;
    Ok(r)
}

/// Elimina i file audio di un link, tranne quelli della versione `keep` (updated_at).
/// Dopo aver preparato l'audio di una versione del link: elimina solo i file delle versioni
/// **precedenti**. Un lavoro lento su una versione vecchia, che finisce dopo una modifica del link,
/// non deve cancellare i file appena preparati per la versione nuova (l'anteprima per i social
/// falliva con "No such file or directory" e mostrava l'immagine generica).
fn drop_older_audio(st: &AppState, token: &str, current: u64) {
    let Ok(rd) = std::fs::read_dir(audio_dir(st)) else { return };
    let prefix = format!("{token}-");
    for e in rd.filter_map(Result::ok) {
        let p = e.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        // nome: <token>-<versione>-<indice>.mp3 oppure <token>-<versione>-og-<impronta>.jpg
        let Some(rest) = name.strip_prefix(&prefix) else { continue };
        let Some(version) = rest.split('-').next().and_then(|v| v.parse::<u64>().ok()) else { continue };
        if version < current {
            let _ = std::fs::remove_file(&p);
        }
    }
}

fn drop_audio(st: &AppState, token: &str, keep: Option<u64>) {
    let Ok(rd) = std::fs::read_dir(audio_dir(st)) else { return };
    let keep = keep.map(|v| format!("{token}-{v}-"));
    for e in rd.filter_map(Result::ok) {
        let p = e.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        let mine = name.starts_with(&format!("{token}-"));
        if mine && !keep.as_ref().is_some_and(|k| name.starts_with(k.as_str())) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Un progetto eliminato porta con sé i suoi link pubblici.
pub fn forget_project(st: &AppState, pid: &str) {
    let gone: Vec<String> =
        st.0.shares.read().unwrap().iter().filter(|s| s.project == pid).map(|s| s.token.clone()).collect();
    if gone.is_empty() {
        return;
    }
    let _ = edit(st, |all| {
        all.retain(|s| s.project != pid);
        Ok(())
    });
    for t in gone {
        drop_audio(st, &t, None);
    }
}

/// Link con il nome attuale del progetto (se è stato rinominato dopo la condivisione).
fn find(st: &AppState, token: &str) -> Option<Share> {
    let mut sh = st.0.shares.read().unwrap().iter().find(|s| s.token == token).cloned()?;
    if let Some(p) = st.0.projects.read().unwrap().get(&sh.project) {
        sh.title = p.name.clone();
    }
    Some(sh)
}

fn new_token() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Mix numero `i` del link (MP3), preparato una volta sola e poi riusato. Con `stem` solo il gruppo
/// di tracce numero `stem` (vedi toggle_groups): la pagina li somma e li accende o spegne.
async fn ensure_audio(st: &AppState, sh: &Share, i: usize, stem: Option<usize>) -> Result<PathBuf, AppError> {
    let m = sh.mix(i).ok_or_else(not_found)?;
    let dir = audio_dir(st);
    let (tracks, out, format): (Vec<&ShareTrack>, PathBuf, &str) = match stem {
        None => (m.tracks.iter().collect(), dir.join(format!("{}-{}-{i}.mp3", sh.token, sh.updated_at)), "mp3"),
        Some(k) => {
            let (_, tracks) = toggle_groups(sh, m).into_iter().nth(k).ok_or_else(not_found)?;
            (tracks, dir.join(format!("{}-{}-{i}-s{k}.mp3", sh.token, sh.updated_at)), "mp3-192")
        }
    };
    let lock = st.render_lock(&out);
    let _guard = lock.lock().await;
    if out.exists() {
        return Ok(out);
    }
    let pitch = m.pitch.clamp(-12, 12);
    let tempo = m.tempo.clamp(25, 200);
    let mut items = vec![];
    for t in tracks.into_iter().filter(|t| t.gain > 0.0 && !t.clips.is_empty()) {
        let song = st.get(&t.song).ok_or_else(not_found)?;
        let sdir = st.song_dir(&t.song);
        let src = if t.part == "original" {
            ensure_original(st, &t.song).await?
        } else {
            if !song.has_stems() || !song.stems.contains(&t.part) {
                return Err(not_found());
            }
            sdir.join("stems").join(format!("{}.flac", t.part))
        };
        let path = if pitch == 0 && tempo == 100 {
            src
        } else {
            render_file(st, &sdir.join("render"), &t.part, &src, pitch, tempo).await?
        };
        items.push(MixInput { path, clips: t.clips.clone(), gain: t.gain, fx: t.fx.clone(), envs: t.envs.clone(), mix: crate::clean_mix(t.mix) });
    }
    let req = ExportRequest {
        stems: vec![],
        pitch: Some(pitch),
        tempo: Some(tempo),
        start: None,
        end: None,
        master: Some(m.master),
        format: format.into(),
        pre_roll: None,
        click: None,
    };
    let label = match stem {
        None => format!("link {} #{i}", sh.title),
        Some(k) => format!("link {} #{i} traccia {k}", sh.title),
    };
    let (tmp, _) = mix_to_file(&dir.join("tmp"), items, &req, &label).await?;
    tokio::fs::rename(&tmp, &out).await?;
    drop_older_audio(st, &sh.token, sh.updated_at);
    Ok(out)
}

// ------------------------------------------------------------- immagine di anteprima

/// Impronta breve del testo dell'immagine: cambia se si rinomina il progetto o il salvataggio.
fn og_key(sh: &Share) -> String {
    use sha2::Digest;
    let h = sha2::Sha256::digest(format!("{}\n{}\n{}", sh.title, sh.subtitle, sh.extra.len()).as_bytes());
    h.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

fn og_path(st: &AppState, sh: &Share) -> PathBuf {
    audio_dir(st).join(format!("{}-{}-og-{}.jpg", sh.token, sh.updated_at, og_key(sh)))
}

fn mmss(t: f64) -> String {
    let t = t.max(0.0).round() as u64;
    format!("{}:{:02}", t / 60, t % 60)
}

/// Testo su una riga: al massimo `max` caratteri, con i puntini se è più lungo.
fn clip_text(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        format!("{}…", s.chars().take(max - 1).collect::<String>().trim_end())
    }
}

/// Immagine per l'anteprima sui social (1200×630): titolo, salvataggio, dettagli e forma d'onda del
/// mix con il loop evidenziato, nello stile della pagina condivisa. Si prepara una volta sola.
async fn ensure_og(st: &AppState, sh: &Share) -> Result<PathBuf, AppError> {
    let out = og_path(st, sh);
    let lock = st.render_lock(&out);
    let _guard = lock.lock().await;
    if out.exists() {
        return Ok(out);
    }
    let audio = ensure_audio(st, sh, 0, None).await?;
    let probe = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(&audio)
        .output()
        .await?;
    let dur: f64 = String::from_utf8_lossy(&probe.stdout).trim().parse().unwrap_or(0.0);

    let m = &sh.mix;
    let k = 100.0 / m.tempo.clamp(25, 200) as f64; // secondi originali → secondi del mix
    let mut facts = vec![];
    if let (Some(sel), true) = (m.selection, m.loop_on) {
        facts.push(format!("Loop {} – {}", mmss(sel.start * k), mmss(sel.end * k)));
    }
    if m.tempo != 100 {
        facts.push(format!("tempo {}%", m.tempo));
    }
    if m.pitch != 0 {
        facts.push(format!("{}{} st", if m.pitch > 0 { "+" } else { "−" }, m.pitch.abs()));
    }
    if !sh.extra.is_empty() {
        facts.push(format!("{} mix", sh.extra.len() + 1));
    }
    let title = clip_text(&sh.title, 40);
    // titolo lungo: carattere più piccolo, per restare dentro il riquadro
    let n = title.chars().count().max(1);
    let title_size = if n <= 26 { 62 } else { (62 * 26 / n).max(38) as u32 };

    let tmp = audio_dir(st).join("tmp").join(format!("og-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&tmp).await?;
    let write = |name: &str, text: String| {
        let p = tmp.join(name);
        std::fs::write(&p, text).map(|_| p)
    };
    let t_title = write("title.txt", title)?;
    let t_sub = write("sub.txt", clip_text(&sh.subtitle, 50))?;
    let t_facts = write("facts.txt", facts.join("  ·  "))?;
    let t_brand = write("brand.txt", "◉ Noises".into())?;
    let t_cta = write("cta.txt", "▶  Play".into())?;

    const FONTS: &str = "/usr/share/fonts/truetype/dejavu";
    const WX: u32 = 110;
    const WY: u32 = 380;
    const WW: u32 = 980;
    const WH: u32 = 150;
    let text = |file: &Path, font: &str, size: u32, color: &str, x: &str, y: u32, extra: &str| {
        format!(
            "drawtext=fontfile={FONTS}/{font}:textfile={}:expansion=none:fontsize={size}:fontcolor={color}:x={x}:y={y}{extra}",
            file.display()
        )
    };
    let bg = "drawbox=x=60:y=50:w=1080:h=530:color=0x14151c@0.70:t=fill";
    // il loop si disegna sopra la forma d'onda (sotto sarebbe coperto)
    let mut lp: Vec<String> = vec![];
    if let (Some(sel), true, true) = (m.selection, m.loop_on, dur > 0.0) {
        let x0 = WX + ((sel.start * k / dur).clamp(0.0, 1.0) * WW as f64) as u32;
        let x1 = WX + ((sel.end * k / dur).clamp(0.0, 1.0) * WW as f64) as u32;
        if x1 > x0 + 4 {
            lp.push(format!("drawbox=x={x0}:y={}:w={}:h={}:color=0x2bd47d@0.45:t=fill", WY - 8, x1 - x0, WH + 16));
            lp.push(format!("drawbox=x={x0}:y={}:w=3:h={}:color=0x2bd47d:t=fill", WY - 8, WH + 16));
            lp.push(format!("drawbox=x={}:y={}:w=3:h={}:color=0x2bd47d:t=fill", x1 - 3, WY - 8, WH + 16));
        }
    }
    let fg = [
        text(&t_brand, "DejaVuSans-Bold.ttf", 26, "0xb6a4ff", &WX.to_string(), 88, ""),
        text(&t_title, "DejaVuSans-Bold.ttf", title_size, "white", &WX.to_string(), 150, ""),
        text(&t_sub, "DejaVuSans.ttf", 34, "0xb6a4ff", &WX.to_string(), 236, ""),
        text(&t_facts, "DejaVuSans.ttf", 24, "0x9a9cb4", &WX.to_string(), 296, ""),
        text(&t_cta, "DejaVuSans-Bold.ttf", 26, "white", "w-126-tw", 88, ":box=1:boxcolor=0x7c5cff:boxborderw=16"),
    ];
    let graph = format!(
        "[1:a]aformat=channel_layouts=mono,showwavespic=s={WW}x{WH}:colors=0xb6a4ff:draw=full:filter=peak:scale=sqrt[w];\
         [0:v]{bg}[bg];[bg][w]overlay={WX}:{WY},{}{}",
        lp.iter().map(|x| format!("{x},")).collect::<String>(),
        fg.join(",")
    );
    let part = tmp.join("og.jpg");
    let res = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
        .arg("gradients=s=1200x630:c0=0x2a1d6b:c1=0x0b0c10:c2=0x0b2f2c:nb_colors=3:x0=0:y0=0:x1=1200:y1=630:speed=0.00001:d=1")
        .arg("-i")
        .arg(&audio)
        .args(["-filter_complex", &graph, "-frames:v", "1", "-q:v", "3"])
        .arg(&part)
        .kill_on_drop(true)
        .output()
        .await;
    let done = match res {
        Ok(o) if o.status.success() => tokio::fs::rename(&part, &out).await.map_err(AppError::from),
        Ok(o) => Err(AppError(StatusCode::INTERNAL_SERVER_ERROR, format!("ffmpeg: {}", String::from_utf8_lossy(&o.stderr).trim()))),
        Err(e) => Err(e.into()),
    };
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    done?;
    // le immagini con un testo precedente della stessa versione non servono più
    if let Ok(rd) = std::fs::read_dir(audio_dir(st)) {
        let prefix = format!("{}-{}-og-", sh.token, sh.updated_at);
        for e in rd.filter_map(Result::ok) {
            if e.file_name().to_string_lossy().starts_with(&prefix) && e.path() != out {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(out)
}

/// GET /api/public/:token/og.jpg — anteprima per i social; se non si può preparare, quella generica.
pub async fn public_og(State(st): State<AppState>, UrlPath(token): UrlPath<String>, req: Request) -> Response {
    let generic = st.0.static_dir.join("share-og.jpg");
    let path = match find(&st, &token) {
        // un secondo tentativo copre un errore momentaneo (es. audio del mix rifatto nel frattempo)
        Some(sh) => match ensure_og(&st, &sh).await {
            Ok(p) => Some(p),
            Err(e) => {
                warn!("anteprima del link {token}: {}, nuovo tentativo", e.1);
                match ensure_og(&st, &sh).await {
                    Ok(p) => Some(p),
                    Err(e) => {
                        warn!("anteprima del link {token}: {}, uso quella generica", e.1);
                        None
                    }
                }
            }
        },
        None => None,
    };
    let ok = path.is_some();
    let mut res = match tower_http::services::ServeFile::new(path.unwrap_or(generic)).oneshot(req).await {
        Ok(r) => r.into_response(),
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    // l'immagine generica non va tenuta in cache: alla richiesta successiva arriva quella vera
    let cache = if ok { "public, max-age=3600" } else { "no-cache, max-age=0" };
    res.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static(cache));
    res
}

// ------------------------------------------------------------- handler (proprietario)

#[derive(Serialize)]
pub struct ShareSummary {
    token: String,
    preset: Option<String>,
    /// salvataggi in più inclusi nella pagina
    extra: Vec<String>,
    title: String,
    subtitle: String,
    created_at: u64,
    updated_at: u64,
    /// pulsanti delle tracce separate nella pagina
    stem_buttons: bool,
    /// elenco dei loop (sezioni) tra cui scegliere nella pagina
    loop_buttons: bool,
    /// comando della velocità nella pagina
    speed_buttons: bool,
}

impl From<&Share> for ShareSummary {
    fn from(s: &Share) -> Self {
        ShareSummary {
            token: s.token.clone(),
            preset: s.preset.clone(),
            extra: s.extra.iter().map(|v| v.preset.clone()).collect(),
            title: s.title.clone(),
            subtitle: s.subtitle.clone(),
            created_at: s.created_at,
            updated_at: s.updated_at,
            stem_buttons: s.stem_toggles,
            loop_buttons: s.loop_choice,
            speed_buttons: s.speed_choice,
        }
    }
}

pub async fn list(State(st): State<AppState>, UrlPath(pid): UrlPath<String>) -> Json<Vec<ShareSummary>> {
    let name = st.0.projects.read().unwrap().get(&pid).map(|p| p.name.clone());
    Json(
        st.0.shares
            .read()
            .unwrap()
            .iter()
            .filter(|s| s.project == pid)
            .map(|s| {
                let mut x = ShareSummary::from(s);
                if let Some(n) = &name {
                    x.title = n.clone();
                }
                x
            })
            .collect(),
    )
}

#[derive(Deserialize)]
pub struct StemGain {
    name: String,
    gain: f32,
    #[serde(default)]
    mix: Option<[f32; 4]>,
}

/// Mix inviato dal browser: volumi effettivi delle tracce e impostazioni del salvataggio.
#[derive(Deserialize)]
pub struct MixBody {
    stems: Vec<StemGain>,
    pitch: i32,
    tempo: u32,
    master: f32,
    #[serde(default)]
    selection: Option<Span>,
    #[serde(default)]
    r#loop: bool,
}

#[derive(Deserialize)]
pub struct ExtraBody {
    preset: String,
    name: String,
    #[serde(flatten)]
    mix: MixBody,
}

#[derive(Deserialize)]
pub struct CreateBody {
    #[serde(default)]
    preset: Option<String>,
    #[serde(default)]
    subtitle: String,
    #[serde(flatten)]
    mix: MixBody,
    #[serde(default)]
    extra: Vec<ExtraBody>,
    /// pulsanti delle tracce separate nella pagina; se manca: come prima per un link che esiste
    /// già, accesi per un link nuovo
    #[serde(default)]
    stem_buttons: Option<bool>,
    /// elenco dei loop (sezioni) tra cui scegliere nella pagina; se manca, come `stem_buttons`
    #[serde(default)]
    loop_buttons: Option<bool>,
    /// comando della velocità nella pagina; se manca, come `stem_buttons`
    #[serde(default)]
    speed_buttons: Option<bool>,
}

/// Sezioni (loop) che si vedono nel salvataggio `preset`: le sue e quelle comuni a tutti.
fn regions_of(p: &crate::projects::Project, preset: Option<&str>) -> Vec<Named> {
    p.regions
        .iter()
        .filter(|r| r.visible_in(preset))
        .map(|r| Named { name: r.name.clone(), start: r.start, end: Some(r.end) })
        .collect()
}

/// Fotografa le tracce del progetto con i volumi del salvataggio.
fn build_mix(st: &AppState, p: &crate::projects::Project, b: &MixBody) -> Result<Mix, AppError> {
    if b.stems.len() > 200 || !(-12..=12).contains(&b.pitch) || !(25..=200).contains(&b.tempo) || !b.master.is_finite() {
        return Err(bad_request("condivisione non valida"));
    }
    let mut tracks = vec![];
    for e in b.stems.iter().filter(|e| e.gain.is_finite() && e.gain > 0.0) {
        let Some(t) = p.tracks.iter().find(|t| t.name == e.name) else {
            return Err(bad_request(format!("traccia sconosciuta: {}", e.name)));
        };
        if t.song.is_empty() || t.clips.is_empty() {
            continue;
        }
        tracks.push(ShareTrack { song: t.song.clone(), part: t.part.clone(), clips: t.clips.clone(), gain: e.gain.min(2.0), fx: t.fx.clone(), envs: crate::projects::track_envs(&p, t), mix: Some(crate::clean_mix(e.mix)).filter(|m| *m != [1.0, 0.0, 0.0, 1.0]) });
    }
    if tracks.is_empty() {
        return Err(bad_request("nessuna traccia udibile da condividere"));
    }
    let selection = b.selection.filter(|s| s.start.is_finite() && s.end.is_finite() && s.start >= 0.0 && s.end > s.start);
    let songs: Vec<String> = {
        let all = st.0.songs.read().unwrap();
        let mut v: Vec<String> = vec![];
        for t in &tracks {
            if let Some(s) = all.get(&t.song) {
                if !v.contains(&s.name) {
                    v.push(s.name.clone());
                }
            }
        }
        v
    };
    Ok(Mix {
        tracks,
        pitch: b.pitch,
        tempo: b.tempo,
        master: b.master.clamp(0.0, 2.0),
        selection,
        loop_on: b.r#loop && selection.is_some(),
        songs,
    })
}

pub async fn create(
    State(st): State<AppState>,
    UrlPath(pid): UrlPath<String>,
    Extension(user): Extension<crate::auth::User>,
    Json(b): Json<CreateBody>,
) -> Result<Json<ShareSummary>, AppError> {
    let p = crate::projects::get(&st, &pid)?;
    if b.extra.len() > MAX_EXTRA {
        return Err(bad_request("troppi salvataggi nello stesso link"));
    }
    let mix = build_mix(&st, &p, &b.mix)?;
    let mut extra = vec![];
    for e in &b.extra {
        if e.preset.is_empty() || e.preset.len() > 32 || Some(&e.preset) == b.preset.as_ref() {
            continue;
        }
        extra.push(Variant {
            preset: e.preset.clone(),
            name: e.name.trim().chars().take(60).collect(),
            mix: build_mix(&st, &p, &e.mix)?,
            regions: Some(regions_of(&p, Some(&e.preset))),
        });
    }
    let now = now_secs();
    let main_regions = regions_of(&p, b.preset.as_deref());
    let mut sh = Share {
        token: new_token(),
        owner: user.id.clone(),
        project: pid.clone(),
        preset: b.preset.filter(|x| !x.is_empty() && x.len() <= 32),
        title: p.name.clone(),
        subtitle: b.subtitle.trim().chars().take(60).collect(),
        created_at: now,
        updated_at: now,
        mix,
        extra,
        regions: main_regions,
        markers: p.markers.iter().map(|m| Named { name: m.name.clone(), start: m.t, end: None }).collect(),
        stem_toggles: b.stem_buttons.unwrap_or(true),
        loop_choice: b.loop_buttons.unwrap_or(true),
        speed_choice: b.speed_buttons.unwrap_or(true),
    };
    let (stem_buttons, loop_buttons, speed_buttons) = (b.stem_buttons, b.loop_buttons, b.speed_buttons);
    // lo stesso salvataggio ricondiviso tiene il suo link
    let sh = edit(&st, |all| {
        if let Some(old) = sh.preset.as_ref().and_then(|id| all.iter_mut().find(|x| x.project == pid && x.preset.as_ref() == Some(id))) {
            sh.token = old.token.clone();
            sh.created_at = old.created_at;
            sh.updated_at = now.max(old.updated_at + 1);
            sh.stem_toggles = stem_buttons.unwrap_or(old.stem_toggles);
            sh.loop_choice = loop_buttons.unwrap_or(old.loop_choice);
            sh.speed_choice = speed_buttons.unwrap_or(old.speed_choice);
            *old = sh.clone();
        } else {
            all.push(sh.clone());
        }
        Ok(sh)
    })?;
    info!("link pubblico {} per il progetto '{}' ({} salvataggi)", sh.token, sh.title, 1 + sh.extra.len());
    // i mix si preparano subito, uno alla volta, così chi apre il link non aspetta
    let (st2, sh2) = (st.clone(), sh.clone());
    tokio::spawn(async move {
        for i in 0..=sh2.extra.len() {
            if let Err(e) = ensure_audio(&st2, &sh2, i, None).await {
                warn!("preparazione del link {} (#{i}) non riuscita: {}", sh2.token, e.1);
            }
            if i == 0 {
                if let Err(e) = ensure_og(&st2, &sh2).await {
                    warn!("anteprima del link {}: {}", sh2.token, e.1);
                }
            }
        }
        // poi le tracce separate per i pulsanti della pagina
        for i in 0..=sh2.extra.len() {
            let n = sh2.mix(i).map_or(0, |m| toggle_groups(&sh2, m).len());
            for k in 0..n {
                if let Err(e) = ensure_audio(&st2, &sh2, i, Some(k)).await {
                    warn!("preparazione del link {} (#{i}, traccia {k}) non riuscita: {}", sh2.token, e.1);
                }
            }
        }
    });
    Ok(Json(ShareSummary::from(&sh)))
}

pub async fn delete(
    State(st): State<AppState>,
    UrlPath((pid, token)): UrlPath<(String, String)>,
) -> Result<StatusCode, AppError> {
    edit(&st, |all| {
        let n = all.len();
        all.retain(|s| !(s.project == pid && s.token == token));
        if all.len() == n {
            return Err(not_found());
        }
        Ok(())
    })?;
    drop_audio(&st, &token, None);
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ handler pubblici

#[derive(Serialize)]
pub struct PublicVariant {
    name: String,
    songs: Vec<String>,
    pitch: i32,
    tempo: u32,
    /// tempi nel file audio (già adattati alla velocità)
    selection: Option<Span>,
    loop_on: bool,
    regions: Vec<Named>,
    markers: Vec<Named>,
    /// tracce da accendere e spegnere (vocals, drums…, "rest" = il resto del mix): l'audio di
    /// ognuna si chiede con `stem` = posizione in questo elenco. Vuoto = un solo mix.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    stems: Vec<String>,
}

#[derive(Serialize)]
pub struct PublicInfo {
    title: String,
    /// il primo è il salvataggio condiviso, gli altri sono quelli inclusi in più
    variants: Vec<PublicVariant>,
    updated_at: u64,
    /// la pagina può offrire il comando della velocità
    speed: bool,
}

fn public_variant(sh: &Share, name: &str, m: &Mix, regions: &[Named]) -> PublicVariant {
    let k = 100.0 / m.tempo.clamp(25, 200) as f64;
    let scale = |n: &Named| Named { name: n.name.clone(), start: n.start * k, end: n.end.map(|e| e * k) };
    PublicVariant {
        name: name.to_owned(),
        songs: m.songs.clone(),
        pitch: m.pitch,
        tempo: m.tempo,
        selection: m.selection.map(|s| Span { start: s.start * k, end: s.end * k }),
        loop_on: m.loop_on,
        // senza la scelta dei loop la pagina ha solo il loop del salvataggio
        regions: if sh.loop_choice { regions.iter().map(scale).collect() } else { vec![] },
        markers: sh.markers.iter().map(scale).collect(),
        stems: toggle_groups(sh, m).into_iter().map(|(k, _)| k).collect(),
    }
}

pub async fn public_info(State(st): State<AppState>, UrlPath(token): UrlPath<String>) -> Result<Json<PublicInfo>, AppError> {
    let sh = find(&st, &token).ok_or_else(not_found)?;
    let mut variants = vec![public_variant(&sh, &sh.subtitle, &sh.mix, &sh.regions)];
    variants.extend(sh.extra.iter().map(|v| public_variant(&sh, &v.name, &v.mix, v.regions.as_deref().unwrap_or(&sh.regions))));
    Ok(Json(PublicInfo { title: sh.title.clone(), variants, updated_at: sh.updated_at, speed: sh.speed_choice }))
}

#[derive(Deserialize)]
pub struct AudioQuery {
    #[serde(default)]
    mix: usize,
    /// traccia separata numero… (vedi PublicVariant::stems); senza, il mix intero
    #[serde(default)]
    stem: Option<usize>,
}

pub async fn public_audio(
    State(st): State<AppState>,
    UrlPath(token): UrlPath<String>,
    Query(q): Query<AudioQuery>,
    req: Request,
) -> Result<Response, AppError> {
    let sh = find(&st, &token).ok_or_else(not_found)?;
    let path = ensure_audio(&st, &sh, q.mix, q.stem).await?;
    let mut res = tower_http::services::ServeFile::new(path)
        .oneshot(req)
        .await
        .map_err(|e| AppError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, header::HeaderValue::from_static("public, max-age=86400"));
    Ok(res)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Pagina del link: l'HTML statico con titolo e anteprima per i social già compilati.
pub async fn page(State(st): State<AppState>, UrlPath(token): UrlPath<String>) -> Response {
    let Ok(tpl) = tokio::fs::read_to_string(st.0.static_dir.join("share.html")).await else {
        return (StatusCode::NOT_FOUND, "non trovato").into_response();
    };
    let base = st.0.auth.config.public_url.clone();
    let sh = find(&st, &token);
    let (title, desc) = match &sh {
        Some(s) => {
            let what = if s.subtitle.is_empty() { s.title.clone() } else { format!("{} · {}", s.title, s.subtitle) };
            let songs = if s.mix.songs.is_empty() { String::new() } else { format!(" — {}", s.mix.songs.join(", ")) };
            (what, format!("Ascolta e ripeti in loop su Noises{songs}"))
        }
        None => ("Link non disponibile".to_owned(), "Questo link non è più attivo.".to_owned()),
    };
    let html = tpl
        .replace("{{TITLE}}", &esc(&title))
        .replace("{{DESC}}", &esc(&desc))
        .replace("{{URL}}", &esc(&format!("{base}/s/{token}")))
        .replace(
            "{{IMAGE}}",
            &esc(&match &sh {
                // la versione nell'indirizzo fa riscaricare l'immagine quando il link cambia
                Some(s) => format!("{base}/api/public/{token}/og.jpg?v={}-{}", s.updated_at, og_key(s)),
                None => format!("{base}/share-og.jpg"),
            }),
        );
    let status = if sh.is_some() { StatusCode::OK } else { StatusCode::NOT_FOUND };
    (status, [(header::CACHE_CONTROL, "no-cache")], Html(html)).into_response()
}
