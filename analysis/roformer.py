#!/usr/bin/env python3
"""Separazione della voce con Mel-Band RoFormer (pesi di Kimberley Jensen, MIT).

    python3 roformer.py INGRESSO CARTELLA_USCITA PESI.ckpt

Se il file dei pesi non c'è lo scarica (una volta sola, ~900 MB) e ne verifica l'impronta; durante il
download scrive su stderr "download NN%".

Scrive nella cartella `vocals.flac` (voce) e `instrumental.wav` (tutto il resto, cioè mix − voce,
in virgola mobile così Demucs lo può dividere senza perdite). L'avanzamento va su stderr come
"NN%" (lo legge il server per la barra di progresso).

Il brano si elabora a blocchi di 8 s che si sovrappongono di 1 s, con una dissolvenza incrociata
nel tratto in comune: rispetto alla sovrapposizione a metà dell'inferenza di riferimento il
risultato è quasi identico e il tempo si dimezza (sulla CPU il modello è pesante).
"""
import hashlib
import os
import subprocess
import sys
import urllib.request

import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from msst.mel_band_roformer import MelBandRoformer  # noqa: E402

SR = 44100
CHUNK = 352800  # 8 s
FADE = SR       # 1 s in comune tra un blocco e il successivo

WEIGHTS_URL = "https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt"
WEIGHTS_SHA256 = "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e"

# configs/KimberleyJensen/config_vocals_mel_band_roformer_kj.yaml
CONFIG = dict(
    dim=384, depth=6, stereo=True, num_stems=1, time_transformer_depth=1, freq_transformer_depth=1,
    num_bands=60, dim_head=64, heads=8, attn_dropout=0, ff_dropout=0, flash_attn=True,
    dim_freqs_in=1025, sample_rate=SR, stft_n_fft=2048, stft_hop_length=441, stft_win_length=2048,
    stft_normalized=False, mask_estimator_depth=2, multi_stft_resolution_loss_weight=1.0,
    multi_stft_resolutions_window_sizes=(4096, 2048, 1024, 512, 256), multi_stft_hop_size=147,
    multi_stft_normalized=False,
)


def load_audio(path):
    """Decodifica qualunque formato con ffmpeg: stereo, 44,1 kHz, float32 → (2, n)."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        check=True, stdout=subprocess.PIPE,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def ensure_weights(path):
    """Scarica i pesi a pezzi (senza tenerli tutti in memoria) e ne verifica l'impronta."""
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    part = path + ".part"
    h = hashlib.sha256()
    with urllib.request.urlopen(WEIGHTS_URL, timeout=60) as r, open(part, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got, last = 0, -1
        while True:
            buf = r.read(1 << 20)
            if not buf:
                break
            f.write(buf)
            h.update(buf)
            got += len(buf)
            pct = got * 100 // total if total else 0
            if pct != last:
                print(f"download {pct}%", file=sys.stderr, flush=True)
                last = pct
    if h.hexdigest() != WEIGHTS_SHA256:
        os.remove(part)
        sys.exit(f"pesi RoFormer: impronta {h.hexdigest()} diversa da quella attesa")
    os.replace(part, path)


def window(size, fade):
    """Finestra piatta con dissolvenze lineari ai bordi per sommare i blocchi sovrapposti."""
    w = np.ones(size, dtype=np.float32)
    w[:fade] = np.linspace(0, 1, fade, dtype=np.float32)
    w[-fade:] = np.linspace(1, 0, fade, dtype=np.float32)
    return w


def main():
    src, out_dir, ckpt = sys.argv[1:4]
    torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS", "4")))
    device = os.environ.get("ROFORMER_DEVICE", "cpu")
    if device.startswith("cuda") and not torch.cuda.is_available():
        device = "cpu"
    ensure_weights(ckpt)
    model = MelBandRoformer(**CONFIG)
    state = torch.load(ckpt, map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    model.load_state_dict(state)
    model.eval().to(device)

    mix = load_audio(src)
    n = mix.shape[1]
    overlap = int(os.environ.get("ROFORMER_OVERLAP", FADE))  # campioni in comune tra due blocchi
    overlap = min(max(overlap, 4410), CHUNK // 2)
    step = CHUNK - overlap
    border = overlap
    # bordi riflessi: anche l'inizio e la fine del brano stanno al centro di un blocco
    padded = np.pad(mix, ((0, 0), (border, border)), mode="reflect") if n > 2 * border else np.pad(mix, ((0, 0), (border, border)))
    total = padded.shape[1]
    out = np.zeros_like(padded)
    weight = np.zeros(total, dtype=np.float32)
    win = window(CHUNK, overlap)
    starts = list(range(0, max(total - CHUNK, 0) + 1, step))
    if starts[-1] + CHUNK < total:
        starts.append(total - CHUNK)
    with torch.inference_mode():
        for k, s in enumerate(starts):
            part = padded[:, s:s + CHUNK]
            length = part.shape[1]
            if length < CHUNK:
                part = np.pad(part, ((0, 0), (0, CHUNK - length)))
            y = model(torch.from_numpy(part)[None].to(device))  # (1, 2, CHUNK)
            y = y[0].float().cpu().numpy()[:, :length]
            w = win[:length]
            out[:, s:s + length] += y * w
            weight[s:s + length] += w
            print(f"{(k + 1) * 100 // len(starts)}%", file=sys.stderr, flush=True)
    vocals = (out / np.maximum(weight, 1e-6))[:, border:border + n]
    instrumental = mix - vocals
    os.makedirs(out_dir, exist_ok=True)
    sf.write(os.path.join(out_dir, "vocals.flac"), vocals.T, SR, subtype="PCM_24")
    sf.write(os.path.join(out_dir, "instrumental.wav"), instrumental.T, SR, subtype="FLOAT")


if __name__ == "__main__":
    main()
