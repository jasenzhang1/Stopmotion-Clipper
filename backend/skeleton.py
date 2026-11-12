"""Skeleton notation: a text view of the build-up you can read and edit.

One line per bar, four beat tokens per line:

    F1  F1  F2  B1           # quarter notes; F1 repeats the exact same clip
    F3  -   -   -            # "-" holds the previous clip (whole-bar clip)
    [F4 F5] [B2 B3] F6 -     # [a b] splits a beat into eighths ([a b c d] = sixteenths, if enabled)
    F7  .   -   B4           # "." is black (no clip); "-" after it keeps it black

Tokens: F forehand, B backhand, V volley, A approach, S serve/overhead. A number names one specific clip
everywhere in the reel (F7 is always the same forehand). No number = "any forehand not used yet", and
* = any shot. Lines starting with # are comments; RALLY / DROP lines are ignored (the drop is always the rally).

Positions and lengths are stored in sixteenths of a bar (16 per bar) so a finer grid can be switched on
later without changing the data. Clips can start and end on any grid step (eighths, or sixteenths when the
grid allows it), and a bar doesn't have to be full: uncovered time is black.
"""
from __future__ import annotations

import re

from .learning import type_group

BAR = 16
GRIDS = (8, 16)  # finest subdivision per bar: eighths (default) or sixteenths
LETTER = {"forehand": "F", "backhand": "B", "volley": "V", "approach": "A", "serve": "S"}
GROUP = {v: k for k, v in LETTER.items()}
LABEL_RE = re.compile(r"^([FBVAS])(\d+)$")
CELL_RE = re.compile(r"^(?:([FBVAS])(\d+)?|\*|-|\.)$")
GAP = "."


class SkeletonError(ValueError):
    pass


def letter_for(shot: dict) -> str:
    return LETTER.get(type_group(shot["type"]), "F")


def unit(grid: int) -> int:
    """Smallest step, in sixteenths, that clips can start, end or move by."""
    return 1 if grid >= 16 else 2


def allowed_lengths(grid: int) -> set[int]:
    """Any whole number of grid steps up to a bar (dotted and odd lengths included)."""
    u = unit(grid)
    return set(range(u, BAR + 1, u))


def uniform(d: int) -> list[tuple[int, int]]:
    """Layout (pos, len) of d equal clips in a bar."""
    return [(j * BAR // d, BAR // d) for j in range(d)]


# ---------------------------------------------------------------- text out

def _beat_token(cells: list[str | None]) -> str:
    c = [x or "-" for x in cells]
    if all(x is None for x in cells[1:]):
        return c[0]
    if cells[1] is None and cells[3] is None:
        return f"[{c[0]} {c[2]}]"
    return "[" + " ".join(c) + "]"


def serialize(tl: dict) -> str:
    bars = tl["bars"]
    rows: list[tuple[str, str]] = []
    phrase_no = 0
    for i, b in enumerate(bars):
        if i == 0 or b["k"] % 8 == 0:
            phrase_no += 1
            end_k = min(b["k"] + 7 - b["k"] % 8, -1)  # phrases are 8 bars, counted back from the drop
            rows.append((f"# ── Phrase {phrase_no} (bars {b['k']} to {end_k}) ──", ""))
        covered = [False] * BAR
        cells: list[str | None] = [None] * BAR
        for s in b["slots"]:
            cells[s["pos"]] = s.get("label") or "*"
            for q in range(s["pos"], min(BAR, s["pos"] + s["len"])):
                covered[q] = True
        for q in range(BAR):  # black stretch: "." at its start, holds after
            if not covered[q] and (q == 0 or covered[q - 1]):
                cells[q] = GAP
        beats = [_beat_token(cells[q * 4:q * 4 + 4]) for q in range(4)]
        line = " ".join(t.ljust(4) for t in beats).rstrip()
        rows.append((line, f"# bar {b['k']}" + ("  → drop" if b["k"] == -1 else "")))
    width = max((len(a) for a, c in rows if c), default=0) + 3
    out = [a if not c else a.ljust(width) + c for a, c in rows]
    out.append("")
    out.append("RALLY   # the drop: a real rally until the point ends")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- text in

def parse(text: str, n_bars: int, grid: int) -> list[list[dict]]:
    """Returns, per bar, a list of slot specs {pos, len, label|None, group}. Raises SkeletonError."""
    lengths = allowed_lengths(grid)
    bars: list[list[dict]] = []
    for ln, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line or line.upper() in ("RALLY", "DROP"):
            continue
        tokens = re.findall(r"\[[^\]]*\]|[^\s\[\]]+", line)
        if len(tokens) != 4:
            raise SkeletonError(f"Line {ln}: a bar needs exactly 4 beats, found {len(tokens)} (\"{line}\").")
        cells: list[str] = []
        for t in tokens:
            if t.startswith("["):
                inner = t[1:-1].split()
                if len(inner) == 4 and grid < 16:
                    raise SkeletonError(f"Line {ln}: {t} uses sixteenth notes. Turn on the 1/16 grid to use them.")
                if len(inner) not in (2, 4):
                    raise SkeletonError(f"Line {ln}: {t} must split the beat into 2 (eighths)"
                                        f"{' or 4 (sixteenths)' if grid >= 16 else ''}.")
                step = 4 // len(inner)
                for x in inner:
                    cells += [x] + ["-"] * (step - 1)
            else:
                cells += [t, "-", "-", "-"]
        for c in cells:
            if not CELL_RE.match(c):
                raise SkeletonError(f"Line {ln}: \"{c}\" isn't a clip. Use F, B, V, A, S (optionally numbered, "
                                    f"e.g. F3), * for any shot, . for black, or - to hold.")
        if cells[0] == "-":
            raise SkeletonError(f"Line {ln}: a bar has to start with a clip or . (holds can't cross a bar line).")
        slots: list[dict] = []
        black = False
        for pos, c in enumerate(cells):
            if c == GAP:
                black = True
                continue
            if c == "-":
                if not black:
                    slots[-1]["len"] += 1
                continue
            black = False
            m = CELL_RE.match(c)
            letter, num = m.group(1), m.group(2)
            slots.append({"pos": pos, "len": 1, "label": f"{letter}{num}" if num else None,
                          "group": GROUP[letter] if letter else "*"})
        u = unit(grid)
        for s in slots:
            if s["len"] not in lengths or s["pos"] % u:
                raise SkeletonError(f"Line {ln}: clips can only start and end on eighth notes. Turn on the 1/16 "
                                    f"grid to use sixteenths.")
        bars.append(slots)
    if len(bars) != n_bars:
        raise SkeletonError(f"The build-up has {n_bars} bars, but the skeleton has {len(bars)}. "
                            f"Change the song section to change the number of bars.")
    return bars
