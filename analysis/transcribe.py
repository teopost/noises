"""Trascrizione delle note di ogni traccia separata + griglia delle battute.

* Strumenti intonati: Basic Pitch (Spotify, Apache-2.0), modello ONNX (niente TensorFlow).
  Voce e basso sono monofonici: le sovrapposizioni vengono risolte tenendo la nota più forte.
* Batteria: rilevamento degli attacchi per bande di frequenza → cassa / rullante / hi-hat (GM 36/38/42).
* Battute: beat tracking di librosa su batteria + basso; fase della battuta (4/4) stimata dalla cassa.

Uso: python3 transcribe.py <output.json> <stems_dir> <stem> [stem ...]
     python3 transcribe.py --refine-grid <notes.json> <stems_dir> <stem> [stem ...]
       (riallinea ai colpi reali i battiti di una trascrizione esistente, senza toccare le note)
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


# ------------------------------------------------------- allineamento battiti
#
# Il beat tracker lavora a bassa risoluzione e misura il picco dell'energia: i battiti risultano
# in ritardo di ~40 ms rispetto all'inizio dei colpi e oscillano di ±25 ms. Qui ogni battito viene
# agganciato all'attacco reale più vicino (rilevato a ~1,5 ms) e la griglia viene levigata con una
# regressione lineare robusta su finestre di ±16 battiti, che segue i cambi di tempo graduali.

REFINE_SR, REFINE_HOP = 44100, 64
GRID_VERSION = 3


def attacks(y, lo, hi):
    """Inizi degli attacchi (risalendo al minimo di energia) e loro forza, nella banda [lo, hi) Hz."""
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=REFINE_HOP)) ** 2
    f = librosa.fft_frequencies(sr=REFINE_SR, n_fft=1024)
    band = S[(f >= lo) & (f < hi)]
    env = librosa.onset.onset_strength(S=librosa.power_to_db(band), sr=REFINE_SR, hop_length=REFINE_HOP)
    peaks = librosa.onset.onset_detect(onset_envelope=env, sr=REFINE_SR, hop_length=REFINE_HOP, delta=0.08, wait=40)
    starts = librosa.onset.onset_backtrack(peaks, band.sum(axis=0))
    t = librosa.frames_to_time(starts, sr=REFINE_SR, hop_length=REFINE_HOP)
    return t, env[peaks] / max(env.max(), 1e-9)


def refine_beats(beats, stems_dir, stems, win=0.07, half=16):
    """Restituisce (griglia levigata, griglia aderente).

    La levigata è stabile come un metronomo; l'aderente aggancia ogni battito al colpo reale
    e segue le irregolarità dell'esecuzione (click "quantizzato" sulla base).
    """
    beats = np.asarray(beats, float)
    if len(beats) < 8:
        return beats, beats.copy()
    # riferimento ritmico: la cassa se c'è la batteria, altrimenti tutti gli attacchi di basso + altro
    if "drums" in stems:
        y, _ = librosa.load(os.path.join(stems_dir, "drums.flac"), sr=REFINE_SR, mono=True)
        on, strength = attacks(y, 30, 150)
        if len(on) < len(beats) // 4:
            on, strength = attacks(y, 30, 11000)
    else:
        mix = None
        for s in [x for x in ("bass", "other", "guitar", "piano") if x in stems] or stems:
            y, _ = librosa.load(os.path.join(stems_dir, f"{s}.flac"), sr=REFINE_SR, mono=True)
            n = len(y) if mix is None else min(len(mix), len(y))
            mix = y if mix is None else mix[:n] + y[:n]
        on, strength = attacks(mix, 30, 11000)
    if len(on) == 0:
        return beats, beats.copy()

    snapped = np.full(len(beats), np.nan)
    for i, b in enumerate(beats):
        lo, hi = np.searchsorted(on, b - win), np.searchsorted(on, b + win)
        if hi > lo:
            snapped[i] = on[lo + np.argmax(strength[lo:hi])]
    # dove non ci sono attacchi vicini si corregge almeno il ritardo medio del tracker
    shift = np.nanmedian(snapped - beats) if np.isfinite(snapped).any() else 0.0
    out = beats + shift
    idx = np.arange(len(beats))
    for i in idx:
        s, e = max(0, i - half), min(len(beats), i + half + 1)
        x, y = idx[s:e], snapped[s:e]
        ok = np.isfinite(y)
        if ok.sum() < 6:
            continue
        for _ in range(4):  # scarta i colpi fuori tempo (fill, sincopi) e rifà il fit
            c1, c0 = np.polyfit(x[ok], y[ok], 1)
            ok2 = ok & (np.abs(y - (c0 + c1 * x)) < 0.025)
            if ok2.sum() < 6 or (ok2 == ok).all():
                break
            ok = ok2
        c1, c0 = np.polyfit(x[ok], y[ok], 1)
        out[i] = c0 + c1 * i
    # la griglia deve restare strettamente crescente
    for i in range(1, len(out)):
        if out[i] <= out[i - 1] + 0.05:
            out[i] = out[i - 1] + max(0.05, np.median(np.diff(beats)))
    return out, tight_beats(out, on, strength)


def tight_beats(smooth, on, strength):
    """Aggancia ogni battito al colpo reale vicino, in una finestra stretta attorno alla griglia
    levigata (così fill, ghost note e sincopi non vengono scambiati per battiti)."""
    period = float(np.median(np.diff(smooth)))
    w = min(0.06, period * 0.2)
    tight = smooth.copy()
    for i, b in enumerate(smooth):
        lo, hi = np.searchsorted(on, b - w), np.searchsorted(on, b + w)
        if hi <= lo:
            continue
        j = max(range(lo, hi), key=lambda k: strength[k] - 0.5 * abs(on[k] - b) / w)
        if strength[j] >= 0.12:
            tight[i] = on[j]
    # la deriva di un musicista è graduale: uno spostamento isolato, diverso da quello dei
    # battiti vicini, è un colpo sbagliato (fill, ghost note) e viene annullato
    dev = tight - smooth
    for i in range(len(dev)):
        nb = [dev[j] for j in range(max(0, i - 2), min(len(dev), i + 3)) if j != i]
        if nb and abs(dev[i] - np.median(nb)) > 0.03:
            tight[i] = smooth[i] + np.median(nb)
    for i in range(1, len(tight)):
        if tight[i] <= tight[i - 1] + 0.5 * period:
            tight[i] = smooth[i]
    return tight


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
    beats, tight = refine_beats(beats, stems_dir, stems)
    if len(beats) > 1:
        bpm = 60.0 / float(np.median(np.diff(beats)))
    return {"bpm": round(bpm, 2), "beats": [round(float(b), 4) for b in beats],
            "beats_tight": [round(float(b), 4) for b in tight], "downbeat": downbeat,
            "time_signature": [4, 4], "version": GRID_VERSION}


def refine_existing(path, stems_dir, stems):
    data = json.load(open(path))
    grid = data["grid"]
    smooth, tight = refine_beats(grid["beats"], stems_dir, stems)
    grid["beats"] = [round(float(b), 4) for b in smooth]
    grid["beats_tight"] = [round(float(b), 4) for b in tight]
    if len(grid["beats"]) > 1:
        grid["bpm"] = round(60.0 / float(np.median(np.diff(grid["beats"]))), 2)
    grid["version"] = GRID_VERSION
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)
    log(f"griglia riallineata: {len(grid['beats'])} battiti, {grid['bpm']} BPM")


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "--refine-grid":
        refine_existing(sys.argv[2], sys.argv[3], sys.argv[4:])
        return
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
