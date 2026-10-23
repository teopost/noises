"""Genera lo spartito (MusicXML) e gli eventi quantizzati per la tablatura.

Input (stdin, JSON):
  {"notes": [...], "grid": {...}, "stem": "bass", "title": "...",
   "pitch": 0, "tempo": 100, "key": {"root": 0..11, "minor": bool} | null, "grid_div": 4}
Output (stdout, JSON):
  {"musicxml": "...", "bpm": 120.0, "bar0": 0.0, "events": [{"o", "d", "p": [nuove note], "c": [note legate]}]}

Le posizioni sono in quarti a partire dalla prima battuta, nel metro scelto; la griglia viene dal beat tracking,
quindi il ritmo resta allineato anche se l'esecuzione accelera o rallenta.
"""

import json
import math
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
from music21 import (clef, duration, instrument, key, layout, metadata, meter, note,  # noqa: E402
                     percussion, stream, tempo)
from music21.musicxml.m21ToXml import GeneralObjectExporter  # noqa: E402

# Metro corrente (impostato in main dalla griglia): battiti per battuta, quarti per battito, quarti per battuta.
BPB, BQ, BAR = 4, 1.0, 4.0
TS = (4, 4)
DRUM_DISPLAY = {36: ("F4", None), 38: ("C5", None), 42: ("G5", "x")}  # cassa, rullante, hi-hat
STEM_NAMES = {"vocals": "Voce", "drums": "Batteria", "bass": "Basso", "guitar": "Chitarra",
              "piano": "Pianoforte", "other": "Altro"}
MAJOR_TONIC = ["C", "D-", "D", "E-", "E", "F", "F#", "G", "A-", "A", "B-", "B"]
MINOR_TONIC = ["C", "C#", "D", "E-", "E", "F", "F#", "G", "G#", "A", "B-", "B"]


def beat_positions(times, grid):
    beats = np.asarray(grid["beats"], float)
    if len(beats) < 2:
        period = 60.0 / max(grid.get("bpm") or 120.0, 1.0)
        return np.asarray(times) / period
    period = float(np.median(np.diff(beats)))
    idx = np.arange(len(beats), dtype=float)
    t = np.asarray(times, float)
    pos = np.interp(t, beats, idx)
    pos = np.where(t < beats[0], (t - beats[0]) / period, pos)
    pos = np.where(t > beats[-1], idx[-1] + (t - beats[-1]) / period, pos)
    return pos - grid.get("downbeat", 0)


def quantize(notes, grid, q, drums):
    """Note → (inizio, fine, altezza, velocity) in quarti, sulla griglia di passo q."""
    if not notes:
        return [], 0.0
    on = beat_positions([n["start"] for n in notes], grid)
    off = beat_positions([n["end"] for n in notes], grid)
    # battuta 1 = quella che contiene l'inizio del brano: uguale per tutte le tracce (in battiti)
    bar0 = math.floor(float(beat_positions([0.0], grid)[0]) / BPB) * BPB
    out = []
    for n, a, b in zip(notes, (on - bar0) * BQ, (off - bar0) * BQ):
        s = round(a / q) * q
        e = s + q if drums else max(s + q, round(b / q) * q)
        out.append([s, e, n["pitch"], n.get("velocity", 80)])
    out.sort(key=lambda x: (x[0], x[2]))
    onsets = sorted({x[0] for x in out})
    for x in out:
        # prossimo attacco dopo questa nota
        i = np.searchsorted(onsets, x[0], side="right")
        nxt = onsets[i] if i < len(onsets) else None
        if drums:
            # batteria: ogni colpo dura fino al successivo (max 1 tempo), come nella scrittura usuale
            x[1] = x[0] + min(BQ, (nxt - x[0]) if nxt is not None else BQ)
        elif nxt is not None and x[1] < nxt and nxt - x[1] <= max(0.5, 2 * q):
            x[1] = nxt
    return [tuple(x) for x in out], float(bar0)


def notation_pieces(o, d):
    """Spezza (offset, durata) in valori leggibili nel metro corrente.

    Dentro un battito restano le suddivisioni; dai battiti si usano valori interi senza
    attraversare il centro della battuta (salvo note che iniziano sul primo tempo).
    """
    pieces, t, end = [], o, o + d
    while t < end - 1e-6:
        beat = math.floor(t / BQ + 1e-6)
        start = beat * BQ
        if abs(t - start) < 1e-6:
            pos = beat % BPB
            whole = math.floor((end - t) / BQ + 1e-6)
            if whole >= 1:
                half = BPB // 2 if BPB % 2 == 0 else None
                limit = BPB if pos == 0 else (half if pos == half else 1)
                w = min(whole, limit) * BQ
                pieces.append((t, float(w)))
                t += w
                continue
            pieces.append((t, end - t))
            break
        nxt = min(start + BQ, end)
        pieces.append((t, nxt - t))
        t = nxt
    return pieces


def segments(qnotes, q):
    """Divide in segmenti senza sovrapposizioni (accordi), spezzati anche alle stanghette.

    Ogni segmento: (offset, durata, note che iniziano, note che continuano da prima).
    """
    if not qnotes:
        return []
    end = max(e for _, e, _, _ in qnotes)
    points = {0.0, end}
    for s, e, _, _ in qnotes:
        points.update((s, e))
    points.update(np.arange(0, end, BAR).tolist())
    points = sorted(p for p in points if 0 <= p <= end)
    starts = {}
    for s, e, p, _ in qnotes:
        starts.setdefault(round(s, 4), set()).add(p)
    segs = []
    for a, b in zip(points, points[1:]):
        if b - a < q / 2:
            continue
        active = {p for s, e, p, _ in qnotes if s <= a + 1e-6 and e >= b - 1e-6}
        new = starts.get(round(a, 4), set()) & active
        for i, (po, pd) in enumerate(notation_pieces(a, b - a)):
            if i == 0:
                segs.append((po, pd, sorted(new), sorted(active - new)))
            else:  # i pezzi successivi sono legati al precedente
                segs.append((po, pd, [], sorted(active)))
    return segs


def respell(p, sharps):
    """Diesis nelle tonalità con diesis, bemolli in quelle con bemolli (music21 usa Mi♭/Si♭ di default)."""
    if p.accidental is None or p.accidental.name not in ("sharp", "flat"):
        return p
    if sharps < 0 and p.accidental.name == "sharp":
        return p.getEnharmonic()
    if sharps > 0 and p.accidental.name == "flat":
        return p.getEnharmonic()
    return p


def build_part(segs, sharps, drums=False, part_cls=stream.Part):
    part = part_cls()
    prev_active = set()
    for o, d, new, cont in segs:
        active = new if drums else new + cont  # batteria: nessuna legatura, solo i colpi
        if not active:
            el = note.Rest()
        elif drums:
            heads = []
            for midi in active:
                disp, head = DRUM_DISPLAY.get(midi, ("C5", "x"))
                u = note.Unpitched(displayName=disp)
                if head:
                    u.notehead = head
                heads.append(u)
            el = heads[0] if len(heads) == 1 else percussion.PercussionChord(heads)
        else:
            pitches = [respell(note.Note(midi=m).pitch, sharps) for m in active]
            el = note.Note(pitches[0]) if len(pitches) == 1 else _chord(pitches)
            # legature per le note che proseguono dal segmento precedente
            notes_ = [el] if isinstance(el, note.Note) else list(el.notes)
            for n_, m in zip(notes_, active):
                if m in cont and m in prev_active:
                    n_.tie = _tie("stop")
        el.duration = duration.Duration(d)
        part.insert(o, el)
        prev_active = set(active) if not drums else set()
    # completa le legature: "start" sulle note seguite da una continuazione
    _link_ties(part)
    return part


def _chord(pitches):
    from music21 import chord
    return chord.Chord(pitches)


def _tie(kind):
    from music21 import tie
    return tie.Tie(kind)


def _link_ties(part):
    els = list(part.notes)
    for a, b in zip(els, els[1:]):
        na = [a] if isinstance(a, note.Note) else list(getattr(a, "notes", []))
        nb = [b] if isinstance(b, note.Note) else list(getattr(b, "notes", []))
        for x in nb:
            if x.tie is None or x.tie.type != "stop":
                continue
            for y in na:
                if getattr(y, "pitch", None) is not None and y.pitch.midi == x.pitch.midi:
                    if y.tie is not None and y.tie.type == "stop":
                        y.tie = _tie("continue")
                    elif y.tie is None:
                        y.tie = _tie("start")


def finish(part, ks, mm, first=True):
    part.insert(0, meter.TimeSignature(f"{TS[0]}/{TS[1]}"))
    if ks is not None:
        part.insert(0, ks)
    if first and mm is not None:
        part.insert(0, mm)
    return part.makeNotation()


def main():
    req = json.load(sys.stdin)
    stem = req.get("stem", "other")
    drums = stem == "drums"
    q = 1.0 / max(int(req.get("grid_div", 4)), 1)
    shift = int(req.get("pitch", 0))
    notes = [{**n, "pitch": n["pitch"] + (0 if drums else shift)} for n in req["notes"]]
    grid = req["grid"]
    global BPB, BQ, BAR, TS
    ts = grid.get("time_signature") or [4, 4]
    TS = (int(ts[0]), int(ts[1]))
    BPB = int(grid.get("beats_per_bar") or 4)
    BQ = float(grid.get("beat_quarters") or 1.0)
    BAR = BPB * BQ

    qnotes, bar0 = quantize(notes, grid, q, drums)
    segs = segments(qnotes, q)

    ks, sharps = None, 0
    k = req.get("key")
    if k and not drums:
        root = (k["root"] + shift) % 12
        ks = key.Key(MINOR_TONIC[(root + 9) % 12].lower(), "minor") if k.get("minor") else key.Key(MAJOR_TONIC[root])
        sharps = ks.sharps
    bpm = (grid.get("bpm") or 120.0) * req.get("tempo", 100) / 100.0
    mm = tempo.MetronomeMark(number=round(bpm), referent=duration.Duration(BQ))

    score = stream.Score()
    score.insert(0, metadata.Metadata())
    score.metadata.title = req.get("title", "")
    score.metadata.movementName = STEM_NAMES.get(stem, stem)

    if stem == "piano":
        # pianoforte su doppio pentagramma, divisione al Do centrale
        rh = build_part(segments([n for n in qnotes if n[2] >= 60], q), sharps, part_cls=stream.PartStaff)
        lh = build_part(segments([n for n in qnotes if n[2] < 60], q), sharps, part_cls=stream.PartStaff)
        rh.insert(0, instrument.Piano())
        rh.insert(0, clef.TrebleClef())
        lh.insert(0, clef.BassClef())
        rh, lh = finish(rh, ks, mm), finish(lh, ks, mm, first=False)
        score.insert(0, rh)
        score.insert(0, lh)
        score.insert(0, layout.StaffGroup([rh, lh], symbol="brace", barTogether=True))
    else:
        part = build_part(segs, sharps, drums=drums)
        if drums:
            part.insert(0, instrument.Percussion())
            part.insert(0, clef.PercussionClef())
        elif stem == "bass":
            part.insert(0, instrument.ElectricBass())
            part.insert(0, clef.BassClef())
        else:
            part.insert(0, clef.bestClef(part, recurse=True))
        part.partName = STEM_NAMES.get(stem, stem)
        score.insert(0, finish(part, ks, mm))

    xml = GeneralObjectExporter(score).parse().decode("utf-8")
    events = [{"o": round(o, 4), "d": round(d, 4), "p": new, "c": cont} for o, d, new, cont in segs if new or cont]
    json.dump({"musicxml": xml, "bpm": round(bpm, 2), "bar0": bar0, "events": events,
               "bar_q": BAR, "beat_q": BQ, "beats_per_bar": BPB, "time_signature": list(TS)}, sys.stdout)


if __name__ == "__main__":
    main()
