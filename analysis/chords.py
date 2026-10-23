"""Riconoscimento accordi con BTC (Bi-directional Transformer for Chord recognition).

Modello: Park et al., ISMIR 2019 — https://github.com/jayg996/BTC-ISMIR19 (MIT),
vocabolario esteso da 170 classi (12 fondamentali x 14 qualità + N + X).

Uso: python3 chords.py <output.json> <traccia1> [traccia2 ...]
Le tracce (già allineate) vengono sommate: passando solo le parti armoniche
(basso, altro, chitarra, piano) si evita il disturbo di voce e batteria.
"""

import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import librosa  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

# Il codice BTC (2019) usa alias rimossi da NumPy recenti.
for _alias, _type in (("float", float), ("int", int)):
    if not hasattr(np, _alias):
        setattr(np, _alias, _type)

BTC_DIR = os.environ.get("BTC_DIR", "/opt/btc")
sys.path.insert(0, BTC_DIR)
from btc_model import BTC_model  # noqa: E402

QUALITIES = ["min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7",
             "maj7", "7", "dim7", "hdim7", "sus2", "sus4"]

SR = 22050          # frequenza usata in addestramento
INST_LEN = 10.0     # secondi per blocco di CQT
TIMESTEP = 108      # frame per finestra del transformer
FRAME = INST_LEN / TIMESTEP
MIN_SEGMENT = 0.3   # segmenti più brevi vengono assorbiti dai vicini
MERGE_FAMILY = 1.0  # segmenti brevi uniti a un vicino con stessa fondamentale e stessa terza

FAMILY = {"min": "m", "min7": "m", "min6": "m", "minmaj7": "m",
          "maj": "M", "maj7": "M", "7": "M", "maj6": "M"}

CONFIG = {
    "feature_size": 144, "timestep": TIMESTEP, "num_chords": 170,
    "input_dropout": 0.2, "layer_dropout": 0.2, "attention_dropout": 0.2, "relu_dropout": 0.2,
    "num_layers": 8, "num_heads": 4, "hidden_size": 128, "total_key_depth": 128,
    "total_value_depth": 128, "filter_size": 128, "loss": "ce", "probs_out": False,
}


def load_mix(paths):
    mix = None
    for p in paths:
        y, _ = librosa.load(p, sr=SR, mono=True)
        if mix is None:
            mix = y
        else:
            n = min(len(mix), len(y))
            mix = mix[:n] + y[:n]
    return mix


def features(y):
    """CQT log-magnitude calcolata a blocchi di 10 s, come nell'implementazione originale."""
    step = int(SR * INST_LEN)
    blocks = []
    for start in range(0, max(len(y), 1), step):
        seg = y[start:start + step]
        if len(seg) < 2048:
            break
        blocks.append(librosa.cqt(seg, sr=SR, n_bins=144, bins_per_octave=24, hop_length=2048))
    feat = np.concatenate(blocks, axis=1)
    return np.log(np.abs(feat) + 1e-6).T  # (frame, 144)


def predict(feat):
    ckpt = torch.load(os.path.join(BTC_DIR, "btc_model_large_voca.pt"), map_location="cpu")
    model = BTC_model(config=CONFIG)
    model.load_state_dict(ckpt["model"])
    model.eval()

    feat = (feat - ckpt["mean"]) / ckpt["std"]
    n = feat.shape[0]
    pad = (TIMESTEP - n % TIMESTEP) % TIMESTEP
    feat = np.pad(feat, ((0, pad), (0, 0)))
    x = torch.tensor(feat, dtype=torch.float32).unsqueeze(0)
    out = []
    with torch.no_grad():
        for t in range(feat.shape[0] // TIMESTEP):
            h, _ = model.self_attn_layers(x[:, t * TIMESTEP:(t + 1) * TIMESTEP, :])
            pred, _ = model.output_layer(h)
            out.extend(pred.squeeze(0).tolist())
    return out[:n]


def label(idx):
    if idx >= 168:  # 168 = X (sconosciuto), 169 = N (nessun accordo)
        return None, None
    return idx // 14, QUALITIES[idx % 14]


def segments(frames, duration):
    segs = []
    for i, idx in enumerate(frames):
        if segs and segs[-1]["idx"] == idx:
            segs[-1]["end"] = (i + 1) * FRAME
        else:
            segs.append({"idx": idx, "start": i * FRAME, "end": (i + 1) * FRAME})

    # Assorbe i segmenti troppo brevi (spesso note di passaggio) nel vicino più lungo.
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for i, s in enumerate(segs):
            if s["end"] - s["start"] >= MIN_SEGMENT:
                continue
            prev = segs[i - 1] if i > 0 else None
            nxt = segs[i + 1] if i + 1 < len(segs) else None
            target = prev if (nxt is None or (prev and prev["end"] - prev["start"] >= nxt["end"] - nxt["start"])) else nxt
            if target is prev:
                prev["end"] = s["end"]
            else:
                nxt["start"] = s["start"]
            del segs[i]
            changed = True
            break
        # unisce vicini divenuti uguali
        merged = []
        for s in segs:
            if merged and merged[-1]["idx"] == s["idx"]:
                merged[-1]["end"] = s["end"]
            else:
                merged.append(s)
        segs = merged

    # Em (0.3 s) + Em7 (2 s) → Em7: varianti della stessa armonia, non un vero cambio.
    def family(idx):
        if idx >= 168:
            return None
        f = FAMILY.get(QUALITIES[idx % 14])
        return (idx // 14, f) if f else None

    i = 0
    while i + 1 < len(segs):
        a, b = segs[i], segs[i + 1]
        fa = family(a["idx"])
        la, lb = a["end"] - a["start"], b["end"] - b["start"]
        if fa and fa == family(b["idx"]) and min(la, lb) < MERGE_FAMILY:
            keep = a["idx"] if la >= lb else b["idx"]
            segs[i] = {"idx": keep, "start": a["start"], "end": b["end"]}
            del segs[i + 1]
            if i > 0 and segs[i - 1]["idx"] == keep:
                segs[i - 1]["end"] = segs[i]["end"]
                del segs[i]
                i -= 1
        else:
            i += 1

    result = []
    for s in segs:
        root, quality = label(s["idx"])
        end = min(s["end"], duration)
        if end - s["start"] <= 0:
            continue
        result.append({"start": round(s["start"], 3), "end": round(end, 3), "root": root, "quality": quality})
    return result


def main():
    if len(sys.argv) < 3:
        sys.exit("uso: chords.py <output.json> <traccia> [traccia ...]")
    out, paths = sys.argv[1], sys.argv[2:]
    y = load_mix(paths)
    duration = len(y) / SR
    chords = segments(predict(features(y)), duration)
    with open(out, "w") as f:
        json.dump({"model": "btc-large-voca", "duration": round(duration, 3), "chords": chords}, f)
    print(f"{len(chords)} accordi in {duration:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
