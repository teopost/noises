# syntax=docker/dockerfile:1

# ---------- build del server Rust ----------
FROM rust:1-bookworm AS builder
# Architetture supportate: x86-64 e ARM a 64 bit (es. Raspberry Pi 4/5 con sistema a 64 bit).
# PyTorch non esiste per ARM a 32 bit: meglio fermarsi subito con un messaggio chiaro.
RUN case "$(dpkg --print-architecture)" in \
      amd64|arm64) ;; \
      *) echo "Noises richiede un sistema a 64 bit (amd64 o arm64): trovato $(dpkg --print-architecture)." \
              "Su Raspberry Pi installa Raspberry Pi OS a 64 bit." >&2; exit 1 ;; \
    esac
WORKDIR /src
# Cache delle dipendenze: compila prima un main vuoto.
COPY backend/Cargo.toml backend/Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release && rm -rf src target/release/deps/noises*
COPY backend/src ./src
RUN cargo build --release

# ---------- runtime ----------
FROM python:3.11-slim-bookworm
ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    TORCH_HOME=/models \
    DATA_DIR=/data \
    STATIC_DIR=/app/static \
    PORT=8080

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg rubberband-cli \
 && rm -rf /var/lib/apt/lists/*

# PyTorch CPU (molto più leggero della build CUDA) + Demucs.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchaudio==2.5.1 \
 && pip install "numpy<2" soundfile demucs==4.0.1

# Pre-scarica i modelli nell'immagine: funziona offline e il primo job non attende il download.
RUN python -c "from demucs.pretrained import get_model; [get_model(m) for m in ('htdemucs','htdemucs_ft','htdemucs_6s')]"

# yt-dlp per l'import da YouTube (+ Deno, il runtime JS che yt-dlp richiede per YouTube).
# YouTube cambia spesso: per aggiornare yt-dlp usare `make update-ytdlp`.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
ARG YTDLP_CACHEBUST=0
RUN pip install -U "yt-dlp[default]"

# Riconoscimento accordi: modello BTC (MIT, Park et al. ISMIR 2019), commit fissato.
RUN pip install "librosa==0.10.2.post1"
ARG BTC_URL=https://raw.githubusercontent.com/jayg996/BTC-ISMIR19/2682317be668032e6e4b269ded36adaa2ad57df0
ADD ${BTC_URL}/btc_model.py ${BTC_URL}/LICENSE /opt/btc/
ADD ${BTC_URL}/utils/__init__.py ${BTC_URL}/utils/hparams.py ${BTC_URL}/utils/transformer_modules.py /opt/btc/utils/
ADD ${BTC_URL}/test/btc_model_large_voca.pt /opt/btc/
RUN chmod -R a+rX /opt/btc
# Trascrizione note: Basic Pitch (Apache-2.0) col modello ONNX, senza TensorFlow (~500 MB risparmiati).
# Spartiti: music21 (BSD) per quantizzazione e MusicXML.
RUN pip install --no-deps basic-pitch==0.4.0 \
 && pip install "numpy<2" onnxruntime pretty-midi mir-eval "resampy<0.4.3" scikit-learn music21

COPY analysis /app/analysis

COPY --from=builder /src/target/release/noises /usr/local/bin/noises
COPY frontend /app/static
# OpenSheetMusicDisplay (BSD-3) per mostrare gli spartiti, incluso nell'immagine: funziona offline.
ADD https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.0/build/opensheetmusicdisplay.min.js /app/static/vendor/
RUN chmod -R a+rX /app/static

VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/health')" || exit 1
CMD ["noises"]
