"""Trascrizione delle note di ogni traccia separata + griglia delle battute.

* Strumenti intonati: Basic Pitch (Spotify, Apache-2.0), modello ONNX (niente TensorFlow).
  Voce e basso sono monofonici: le sovrapposizioni vengono risolte tenendo la nota più forte.
* Batteria: rilevamento degli attacchi per bande di frequenza → cassa / rullante / hi-hat (GM 36/38/42).
* Battute: beat tracking di librosa su batteria + basso; fase della battuta (4/4) stimata dalla cassa.

Uso: python3 transcribe.py <output.json> <stems_dir> <stem> [stem ...]
"""

import glob
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import librosa  # noqa: E402
import numpy as np  # noqa: E402

# (frequenza minima, massima, monofonico, soglia onset, soglia frame, durata minima ms)
PROFILES = {
    "vocals": (75.0, 1100.0, True, 0.5, 0.3, 90),
    "bass": (28.0, 400.0, True, 0.45, 0.3, 80),
    "guitar": (75.0, 1400.0, False, 0.5, 0.3, 70),
    "piano": (27.0, 4200.0, False, 0.5, 0.3, 60),
    "other": (50.0, 3000.0, False, 0.55, 0.35, 80),
}
DRUM_SR = 22050


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def basic_pitch_model():
    from basic_pitch.inference import Model
    import basic_pitch

    path = glob.glob(os.path.join(os.path.dirname(basic_pitch.__file__), "saved_models", "icassp_2022", "*.onnx"))[0]
    return Model(path)


def transcribe_pitched(model, path, stem):
    from basic_pitch.inference import predict

    fmin, fmax, mono, onset_t, frame_t, min_ms = PROFILES.get(stem, PROFILES["other"])
    _, _, events = predict(
        path, model,
        onset_threshold=onset_t, frame_threshold=frame_t, minimum_note_length=min_ms,
        minimum_frequency=fmin, maximum_frequency=fmax, melodia_trick=True,
    )
    notes = [
        {"start": float(s), "end": float(e), "pitch": int(p), "velocity": int(np.clip(a * 127, 1, 127))}
        for s, e, p, a, *_ in events
    ]
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    if mono:
        notes = monophonic(notes)
    return [round_note(n) for n in notes if n["end"] - n["start"] >= 0.04]


def monophonic(notes):
    """Una nota alla volta: nelle sovrapposizioni vince la nota con più energia (velocity × durata)."""
    out = []
    for n in notes:
        if out and n["start"] < out[-1]["end"] - 0.03:
            prev = out[-1]
            w_prev = prev["velocity"] * (prev["end"] - prev["start"])
            w_new = n["velocity"] * (n["end"] - n["start"])
            if w_new > w_prev:
                prev["end"] = n["start"]
                if prev["end"] - prev["start"] < 0.05:
                    out.pop()
                out.append(n)
            # altrimenti la nuova nota viene scartata
        else:
            if out and n["start"] < out[-1]["end"]:
                out[-1]["end"] = n["start"]
            out.append(n)
    return out


def round_note(n):
    return {**n, "start": round(n["start"], 3), "end": round(n["end"], 3)}


DRUM_BANDS = {"kick": (30, 120), "snare": (1000, 5000), "hat": (7000, 11000)}
GM = {"kick": 36, "snare": 38, "hat": 42}


def transcribe_drums(path):
    """Rileva gli attacchi una volta sola, poi classifica ogni colpo per energia relativa di banda.

    (Il rilevamento banda per banda vede ogni colpo di cassa anche nelle altre bande.)
    """
    y, _ = librosa.load(path, sr=DRUM_SR, mono=True)
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=256)) ** 2
    freqs = librosa.fft_frequencies(sr=DRUM_SR, n_fft=2048)
    env = librosa.onset.onset_strength(y=y, sr=DRUM_SR, hop_length=256)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=DRUM_SR, hop_length=256, delta=0.05, wait=3)
    if len(frames) == 0:
        return [], {"times": np.array([]), "snare": np.array([], bool)}
    times = librosa.frames_to_time(frames, sr=DRUM_SR, hop_length=256)
    level = {}
    for name, (lo, hi) in DRUM_BANDS.items():
        band = S[(freqs >= lo) & (freqs < hi)].sum(axis=0)
        e = np.array([band[f:f + 5].max() for f in frames])  # ~60 ms dopo l'attacco
        level[name] = e / max(np.percentile(e, 95), 1e-12)
    hits = {
        "kick": level["kick"] > 0.3,
        "snare": level["snare"] > 0.3,
    }
    # l'hi-hat non deve essere la coda rumorosa del rullante
    hits["hat"] = (level["hat"] > 0.2) & (~hits["snare"] | (level["hat"] > 2.0 * level["snare"]))
    notes = []
    for name, mask in hits.items():
        for t, lv in zip(times[mask], level[name][mask]):
            notes.append({"start": round(float(t), 3), "end": round(float(t) + 0.1, 3), "pitch": GM[name],
                          "velocity": int(np.clip(lv * 100, 20, 127))})
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes, {"times": times, "snare": hits["snare"]}


def beat_grid(stems_dir, stems, drum_info, bass_notes):
    paths = [os.path.join(stems_dir, f"{s}.flac") for s in ("drums", "bass") if s in stems]
    if not paths:
        paths = [os.path.join(stems_dir, f"{s}.flac") for s in stems]
    mix = None
    for p in paths:
        y, _ = librosa.load(p, sr=DRUM_SR, mono=True)
        n = len(y) if mix is None else min(len(mix), len(y))
        mix = y if mix is None else mix[:n] + y[:n]
    tempo, frames = librosa.beat.beat_track(y=mix, sr=DRUM_SR, hop_length=256, units="frames")
    beats = librosa.frames_to_time(frames, sr=DRUM_SR, hop_length=256)
    bpm = float(np.atleast_1d(tempo)[0])

    # Primo tempo della battuta (4/4):
    #  1. il rullante cade sul 2 e sul 4 → individua la coppia di fasi {1,3}
    #  2. tra 1 e 3 sceglie quella dove partono più note del basso
    def phase_counts(times):
        idx = np.searchsorted(beats, np.asarray(times) + 0.06) - 1
        idx = idx[idx >= 0]
        return np.array([np.sum(idx % 4 == ph) for ph in range(4)], float)

    score = np.zeros(4)
    if drum_info is not None and drum_info["snare"].any():
        sp = phase_counts(drum_info["times"][drum_info["snare"]])
        score += [sp[(p + 1) % 4] + sp[(p + 3) % 4] - sp[p] - sp[(p + 2) % 4] for p in range(4)]
    if bass_notes:
        bp = phase_counts([n["start"] for n in bass_notes])
        score += 0.5 * bp
    downbeat = int(np.argmax(score)) if len(beats) >= 8 else 0
    return {"bpm": round(bpm, 2), "beats": [round(float(b), 3) for b in beats], "downbeat": downbeat,
            "time_signature": [4, 4]}


def main():
    if len(sys.argv) < 4:
        sys.exit("uso: transcribe.py <output.json> <stems_dir> <stem> [stem ...]")
    out, stems_dir, stems = sys.argv[1], sys.argv[2], sys.argv[3:]
    tracks, drum_info = {}, None
    model = None
    for stem in stems:
        path = os.path.join(stems_dir, f"{stem}.flac")
        if stem == "drums":
            tracks[stem], drum_info = transcribe_drums(path)
        else:
            model = model or basic_pitch_model()
            tracks[stem] = transcribe_pitched(model, path, stem)
        log(f"{stem}: {len(tracks[stem])} note")
    result = {"model": "basic-pitch-0.4+drum-bands", "tracks": tracks, "grid": beat_grid(stems_dir, stems, drum_info, tracks.get("bass"))}
    with open(out, "w") as f:
        json.dump(result, f)
    log(f"griglia: {result['grid']['bpm']} BPM, {len(result['grid']['beats'])} battiti")


if __name__ == "__main__":
    main()
