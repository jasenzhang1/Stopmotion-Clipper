"""Timeline generation and editing.

All times in a timeline are *song* times (seconds into the song file). Each build-up slot is a span of the
grid: it starts at `pos` and lasts `len` (sixteenths), so its cuts are on notes and its length is a whole
note value. Racket contact is on the grid too, `hit` sixteenths after the start (0 = the clip opens on the
contact); `lead` = how long it plays before the contact.
"""
from __future__ import annotations

import random
from copy import deepcopy

import numpy as np

from . import config
from . import rallies as rallies_mod
from . import skeleton as sk
from .learning import type_group
from .music import beat_index

RALLY_LEAD = 0.25
END_TAIL = 0.12

# ---------------------------------------------------------------- serves
# A serve that didn't go in is still usable on a quarter note or shorter: the clip cuts away right after
# contact, so the audience can't tell whether it would have cleared the net. Longer clips show the ball's
# flight, so they only get serves that went in.
QUARTER = sk.BAR // 4


def usable(shot: dict) -> bool:
    """Shown to the user and allowed in drafts (not hidden, not parked without a preview)."""
    return not shot.get("hidden") and not shot.get("parked")

SECOND_SERVE_WINDOW = 25.0  # a serve this soon after a missed one is the second serve


def serve_flags(project: dict) -> dict[str, dict]:
    """{shot_id: {"in": bool, "first": bool, "source": "auto"|"user"}} for every serve/overhead.
    A serve went in when it started a rally (my next hit means the ball came back). The user can override."""
    starts = set()
    for r in project.get("rallies", []):
        mine = next((h for h in r["hits"] if h["player"] == "me" and h.get("shot_id")), None)
        if mine:
            starts.add(mine["shot_id"])
    serves = sorted((s for s in project["shots"] if type_group(s["type"]) == "serve"),
                    key=lambda s: (s["video_id"], s["t"]))
    out: dict[str, dict] = {}
    prev = None
    for s in serves:
        user = s.get("user_serve_in")
        went_in = bool(user) if user is not None else s["id"] in starts
        # Second serve: shortly after a missed first serve in the same video.
        second = (prev is not None and prev["video_id"] == s["video_id"] and s["t"] - prev["t"] < SECOND_SERVE_WINDOW
                  and not out[prev["id"]]["in"] and out[prev["id"]]["first"])
        out[s["id"]] = {"in": went_in, "first": not second, "source": "user" if user is not None else "auto"}
        prev = s
    return out


def fits_slot(shot: dict, length: int, flags: dict[str, dict]) -> bool:
    """Can the draft put this shot on a slot `length` sixteenths long?"""
    f = flags.get(shot["id"])
    return f is None or f["in"] or length <= QUARTER


def _serve_penalty(shot: dict, flags: dict[str, dict]) -> float:
    """Among missed serves, prefer first serves (a double fault reads as a miss more easily)."""
    f = flags.get(shot["id"])
    return 0.15 if f and not f["in"] and not f["first"] else 0.0


# ---------------------------------------------------------------- structure

def make_bars(music: dict, start: float, drop: float) -> list[dict]:
    beats = music["beats"]
    period = music["period"]
    di = beat_index(music, drop)
    si = beat_index(music, start)
    # first downbeat at or after start, aligned so the drop is a downbeat
    i0 = si + ((di - si) % 4)
    energy = music["energy"]
    bars = []
    for i in range(i0, di, 4):
        if i + 4 > len(beats):
            break
        e = float(np.mean(energy[i:i + 4]))
        bars.append({"k": (i - di) // 4, "beat": i, "t0": beats[i], "t1": beats[i] + 4 * period, "energy": e})
    return bars


def pos_time(bar: dict, pos: int) -> float:
    return bar["t0"] + pos * (bar["t1"] - bar["t0"]) / sk.BAR


def lead_for(slot_dur: float) -> float:
    return float(np.clip(0.35 * slot_dur, 0.07, 0.5))


def _repeat_flag(music: dict, t: float) -> bool:
    e = music["eighths"]
    half = music["period"] / 2
    j = int(round((t - e[0]) / half))
    return 0 <= j < len(music["repeat"]) and bool(music["repeat"][j])


# ---------------------------------------------------------------- density

def choose_densities(bars: list[dict], profile: dict, rng: random.Random) -> None:
    n = len(bars)
    if not n:
        return
    es = np.array([b["energy"] for b in bars])
    lo, hi = es.min(), es.max()
    rel = (es - lo) / (hi - lo + 1e-9)
    for i, b in enumerate(bars):
        progress = (i + 1) / n
        s = 0.55 * rel[i] + 0.45 * progress + profile.get("density_bias", 0) + rng.uniform(-0.1, 0.1)
        if s < 0.2:
            d = 2
        elif s < 0.5:
            d = 2 if rng.random() < 0.4 else 4
        elif s < 0.85:
            d = 4
        else:
            d = 8
        # Heterogeneity: occasionally hold a calm bar on one long clip (a "showcase").
        if s < 0.55 and i < n - 2 and rng.random() < profile.get("showcase_rate", 0.25) * (1 - progress):
            d = 1
        b["density"] = d
    # Build into the drop with eighth-note bursts.
    bars[-1]["density"] = 8
    if n >= 2 and bars[-2]["density"] < 4:
        bars[-2]["density"] = 4


# ---------------------------------------------------------------- type planning

TEMPLATES4 = [("AAAB", 3), ("AABA", 1), ("ABAB", 1), ("AABB", 1)]


def _pick_template(rng: random.Random) -> str:
    names, weights = zip(*TEMPLATES4)
    return rng.choices(names, weights=weights)[0]


def plan_types(bars: list[dict], pools: dict[str, list[dict]], profile: dict, rng: random.Random,
               flags: dict[str, dict] | None = None) -> None:
    mix = profile.get("type_mix", {})
    avail = {g: len(p) for g, p in pools.items()}
    flags = flags or {}
    serves = pools.get("serve", [])

    def serve_fits(length: int) -> bool:
        return any(fits_slot(s, length, flags) for s in serves)
    # A/B = the two most wanted groundstroke-ish groups that exist.
    ranked = sorted((g for g in avail if avail[g] and g not in ("serve",)),
                    key=lambda g: -(mix.get(g, 0.01) * (1 + 0.02 * avail[g])))
    A = ranked[0] if ranked else "forehand"
    B = ranked[1] if len(ranked) > 1 else A
    spice = [g for g in ("volley", "approach") if avail.get(g)]
    spice_p = sum(mix.get(g, 0) for g in spice)
    for bi, b in enumerate(bars):
        d = len(b["_layout"])
        if d == 1:
            pattern = ["*"]
        elif d == 2:
            pattern = ["A", "B"] if rng.random() < 0.6 else ["A", "A"]
        else:
            t = _pick_template(rng)
            while len(t) < d:
                t = t + (t[:4] if rng.random() < 0.6 else _pick_template(rng))
            pattern = list(t[:d])
        types = [A if c == "A" else B if c == "B" else "*" for c in pattern]
        if spice and d >= 2 and rng.random() < spice_p * 2.5:
            types[-1] = rng.choice(spice)
        # A quick serve on a quarter note (or shorter) mid-bar; it doesn't need to have gone in.
        if d >= 4 and serves and rng.random() < mix.get("serve", 0) * 2.5:
            j = rng.randrange(d - 1)
            if serve_fits(b["_layout"][j][1]):
                types[j] = "serve"
        b["_types"] = types
    # Going forward into the drop: approach then volley, if I have them.
    last = bars[-1] if bars else None
    if last and len(last["_layout"]) >= 4:
        if avail.get("approach"):
            last["_types"][-2] = "approach"
        if avail.get("volley"):
            last["_types"][-1] = "volley"
    # Open with a serve.
    if bars and bars[0]["_layout"] and serves and rng.random() < 0.7 and serve_fits(bars[0]["_layout"][0][1]):
        bars[0]["_types"][0] = "serve"


# ---------------------------------------------------------------- assignment

def _pools(shots: list[dict], exclude: set[str]) -> dict[str, list[dict]]:
    pools: dict[str, list[dict]] = {}
    for s in shots:
        if not usable(s) or s["id"] in exclude:
            continue
        pools.setdefault(type_group(s["type"]), []).append(s)
    for g in pools:
        pools[g].sort(key=lambda s: -s["quality"])
    return pools


def assign_shots(bars: list[dict], shots: list[dict], exclude: set[str], profile: dict, rng: random.Random,
                 music: dict, locked: dict[str, str], flags: dict[str, dict] | None = None) -> None:
    flags = flags or {}
    pools = _pools(shots, exclude)
    by_id = {s["id"]: s for s in shots}
    use_count: dict[str, int] = {}
    n = len(bars)
    reuse_budget = {}
    slots_all = []
    for bi, b in enumerate(bars):
        layout = b["_layout"]
        d = len(layout)
        phrase = bi // 8
        if phrase not in reuse_budget:
            base = profile.get("reuse_per_phrase", 1.5)
            reuse_budget[phrase] = int(base) + (1 if rng.random() < base - int(base) else 0)
        b["slots"] = []
        for j, (pos, ln) in enumerate(layout):
            c = pos_time(b, pos)
            sid = f"b{b['k']}s{j}"
            slot = {"id": sid, "pos": pos, "len": ln, "contact": c,
                    "type_want": b["_types"][j] if j < len(b["_types"]) else "*",
                    "shot_id": None, "repeat": False, "locked": False}
            if sid in locked and locked[sid] in by_id:
                slot["shot_id"], slot["locked"] = locked[sid], True
                use_count[slot["shot_id"]] = use_count.get(slot["shot_id"], 0) + 1
            elif j > 0 and d >= 4 and reuse_budget[phrase] > 0 and _repeat_flag(music, c):
                slot["repeat"] = True
                reuse_budget[phrase] -= 1
            importance = 0.5 * b["energy"] + 0.5 * (bi + 1) / n + (0.6 if ln == sk.BAR else 0) + (0.3 if bi == n - 1 else 0)
            slot["_imp"] = importance + rng.uniform(0, 0.05)
            b["slots"].append(slot)
            slots_all.append(slot)

    all_shots = [s for g in pools for s in pools[g]]

    def take(group: str, length: int) -> str | None:
        everything = [s for s in all_shots if fits_slot(s, length, flags)]
        if not everything:
            return None
        unused = [s for s in everything if s["id"] not in use_count]
        cands = [s for s in unused if type_group(s["type"]) == group] if group != "*" else unused
        if not cands:
            cands = [s for s in unused if type_group(s["type"]) in ("forehand", "backhand", "approach")] or unused
        if cands:
            best = max(cands, key=lambda s: s["quality"] - _serve_penalty(s, flags))
        else:  # every shot is used already: reuse the least-used good ones
            best = min(everything, key=lambda s: (use_count.get(s["id"], 0), -s["quality"]))
        use_count[best["id"]] = use_count.get(best["id"], 0) + 1
        return best["id"]

    for slot in sorted(slots_all, key=lambda s: -s["_imp"]):
        if slot["shot_id"] or slot["repeat"]:
            continue
        slot["shot_id"] = take(slot["type_want"], slot["len"])
    for b in bars:
        for j, slot in enumerate(b["slots"]):
            if slot["repeat"]:
                slot["shot_id"] = b["slots"][j - 1]["shot_id"]
            slot.pop("_imp", None)
            slot.pop("type_want", None)
        b.pop("_types", None)
        b.pop("_layout", None)


# ---------------------------------------------------------------- rally

def make_rally(project: dict, rally_id: str | None, start_hit: int | None, profile: dict) -> dict | None:
    rallies = [r for r in project.get("rallies", []) if not r.get("parked") or r["id"] == rally_id]
    if not rallies:
        return None
    if rally_id is None:
        r = max(rallies, key=lambda r: r["score"])
    else:
        r = next((x for x in rallies if x["id"] == rally_id), None) or max(rallies, key=lambda r: r["score"])
    if start_hit is None:
        quality = {s["id"]: s["quality"] for s in project["shots"]}
        start_hit, _ = rallies_mod.best_window(r, quality, profile.get("rally_hits"))
    start_hit = int(np.clip(start_hit, 0, len(r["hits"]) - 2))
    return {"rally_id": r["id"], "start_hit": start_hit, "video_id": r["video_id"],
            "n_hits": len(r["hits"]) - start_hit}


# ---------------------------------------------------------------- timing

def recompute(tl: dict, project: dict) -> dict:
    """Derive every visible interval and source range from the structure."""
    music = project["music"]
    shots = {s["id"]: s for s in project["shots"]}
    videos = {v["id"]: v for v in project["videos"]}
    drop = tl["drop"]
    tl.setdefault("grid", 8)
    for b in tl["bars"]:
        b["slots"].sort(key=lambda s: s.get("pos", 0))
    slots = [s for b in tl["bars"] for s in b["slots"]]
    for b in tl["bars"]:
        d = len(b["slots"])
        b["density"] = d
        if any("pos" not in s for s in b["slots"]):  # timelines saved before skeletons existed
            for s, (pos, ln) in zip(b["slots"], sk.uniform(d)):
                s["pos"], s["len"] = pos, ln
        b["uniform"] = [(s["pos"], s["len"]) for s in b["slots"]] == sk.uniform(d)
        for s in b["slots"]:
            s.pop("lead_user", None)  # older builds: an off-grid lead-in
            s["off"] = float(s.get("off") or 0.0)  # free shift of the frame (Ctrl+drag), in sixteenths
            # The contact is a grid line inside the frame [off, off + len] (relative to pos).
            s["hit"] = int(max(np.ceil(s["off"] - 1e-6), min(s.get("hit") or 0, np.floor(s["off"] + s["len"] + 1e-6))))
            s["contact"] = pos_time(b, s["pos"] + s["hit"])
            s["lead"] = s["contact"] - pos_time(b, s["pos"] + s["off"])
    sync_labels(tl, shots, project)
    prev = None
    for s in slots:
        s["repeat"] = bool(prev and s["shot_id"] == prev)
        prev = s["shot_id"]
    # The rally starts an eighth note before the drop (a cut on the grid), unless that would cut off the last
    # build-up clip's contact.
    eighth = (tl["bars"][-1]["t1"] - tl["bars"][-1]["t0"]) / 8 if tl["bars"] else RALLY_LEAD
    rally_lead = eighth if not slots or drop - slots[-1]["contact"] > eighth + 1e-3 else 0.0
    tl["rally_lead"] = rally_lead
    # Absolute grid position (sixteenths from the first bar) tells whether two clips touch or have black between.
    k0 = tl["bars"][0]["k"] if tl["bars"] else 0
    flat = [(b, s) for b in tl["bars"] for s in b["slots"]]
    a_of = lambda b, s: (b["k"] - k0) * sk.BAR + s["pos"]
    total = len(tl["bars"]) * sk.BAR
    for b in tl["bars"]:
        for s in b["slots"]:
            s["start"] = pos_time(b, s["pos"] + s["off"])
    for i, (b, s) in enumerate(flat):
        a_end = a_of(b, s) + s["len"]
        nxt = flat[i + 1] if i + 1 < len(flat) else None
        limit = nxt[1]["start"] if nxt else drop - rally_lead
        touches = (a_of(*nxt) == a_end) if nxt else a_end >= total
        # Touching clips cut straight into each other; otherwise the clip keeps its own length and black follows.
        s["end"] = min(limit, pos_time(b, s["pos"] + s["off"] + s["len"]))
        s["gap_after"] = not touches
    for s in slots:
        sh = shots.get(s["shot_id"])
        if sh:
            dur = s["end"] - s["start"]
            vdur = videos[sh["video_id"]]["duration"]
            # The user's nudge slides which footage plays in the (beat-locked) slot.
            src = sh["t"] + sh.get("nudge", 0.0) - s["lead"]
            lo, hi = 0.0, vdur - dur
            if sh.get("proxy"):  # stay inside the preview clip so the preview shows what will export
                lo = max(lo, sh["proxy"]["start"])
                hi = min(hi, sh["proxy"].get("end", sh["t"] + config.SHOT_PROXY_WINDOW[1]) - dur)
            src = float(np.clip(src, lo, max(lo, hi)))
            s["src_start"] = src
            s["video_id"] = sh["video_id"]
    rally = tl.get("rally")
    if rally:
        r = next((x for x in project["rallies"] if x["id"] == rally["rally_id"]), None)
        if r:
            hit = r["hits"][rally["start_hit"]]
            vdur = videos[r["video_id"]]["duration"]
            rally["start"] = drop - rally_lead
            rally["src_start"] = max(0.0, hit["t"] - rally_lead)
            point_len = r["point_end"] - hit["t"]
            target = drop + point_len + END_TAIL
            beats = music["beats"]
            nxt = next((bt for bt in beats if bt >= target), target)
            # Prefer a downbeat if one is very close.
            di = beat_index(music, drop)
            for bt_i in range(beat_index(music, target), min(len(beats), beat_index(music, target) + 3)):
                if (bt_i - di) % 4 == 0 and beats[bt_i] >= target and beats[bt_i] - target < 0.35:
                    nxt = beats[bt_i]
                    break
            end = min(nxt, drop + (vdur - hit["t"]) - 0.02, music["duration"])
            rally["end"] = end
            rally["src_end"] = rally["src_start"] + (end - rally["start"])
            rally["point_end"] = drop + point_len
            rally["n_hits"] = len(r["hits"]) - rally["start_hit"]
    # The reel starts with the first bar even if it opens on black.
    first_bar = tl["bars"][0]["t0"] if tl["bars"] else drop - rally_lead
    tl["reel_start"] = min(first_bar, slots[0]["start"]) if slots else first_bar
    tl["reel_end"] = rally["end"] if rally and "end" in rally else drop + 2.0
    tl["duration"] = tl["reel_end"] - tl["reel_start"]
    tl["skeleton"] = sk.serialize(tl)
    return tl


def ensure_names(project: dict, tl: dict | None = None) -> dict[str, str]:
    """Every shot's name: letter = kind (F, B, V, A, S), number = its rank within that kind by stars (then
    quality), so F1 is your best forehand. Names follow re-ranking: change a shot's stars and the numbers
    (and the reel's labels) update. Shots not shown yet are numbered after the shown ones.
    Returns {shot_id: name}."""
    project.pop("shot_names", None)  # older builds stored fixed names
    order = sorted(project.get("shots", []),
                   key=lambda s: (bool(s.get("parked")), -(s.get("stars") or 0), -s.get("quality", 0), s["id"]))
    names: dict[str, str] = {}
    count: dict[str, int] = {}
    for s in order:
        L = sk.letter_for(s)
        count[L] = count.get(L, 0) + 1
        names[s["id"]] = f"{L}{count[L]}"
    return names


def sync_labels(tl: dict, shots: dict[str, dict], project: dict | None = None) -> None:
    if project is not None:
        names = ensure_names(project, tl)
        used: dict[str, str] = {}
        for b in tl["bars"]:
            for s in b["slots"]:
                lab = names.get(s.get("shot_id")) if s.get("shot_id") in shots else None
                s["label"] = lab
                if lab:
                    used[lab] = s["shot_id"]
        tl["labels"] = used
        return
    _sync_labels_local(tl, shots)


def _sync_labels_local(tl: dict, shots: dict[str, dict]) -> None:
    """Give every slot a label (F1, B2, ...) such that same label <=> same shot, across the whole reel.
    Existing labels are kept where still valid; new shots get the next free number for their letter."""
    old: dict[str, str] = tl.get("labels") or {}
    by_shot = {sid: lab for lab, sid in old.items()}
    new: dict[str, str] = {}
    rev: dict[str, str] = {}

    def fresh(letter: str) -> str:
        nums = [int(x[1:]) for x in (*old, *new) if x[0] == letter and x[1:].isdigit()]
        return f"{letter}{max(nums, default=0) + 1}"

    for b in tl["bars"]:
        for s in b["slots"]:
            sid = s.get("shot_id")
            sh = shots.get(sid)
            if not sh:
                s["label"] = None
                continue
            L = sk.letter_for(sh)
            if sid in rev:
                lab = rev[sid]
            else:
                lab = None
                for cand in (s.get("label"), by_shot.get(sid)):
                    if cand and cand[0] == L and old.get(cand) == sid and cand not in new:
                        lab = cand
                        break
                lab = lab or fresh(L)
                new[lab], rev[sid] = sid, lab
            s["label"] = lab
    tl["labels"] = new


# ---------------------------------------------------------------- top level

def generate(project: dict, profile: dict, seed: int | None = None, keep: dict | None = None,
             overrides: dict | None = None) -> dict:
    """Generate a draft. `keep` = previous timeline whose locked slots / user densities / rally persist."""
    overrides = overrides or {}
    prof = deepcopy(profile)
    if "density_bias" in overrides:
        prof["density_bias"] = prof.get("density_bias", 0) + float(overrides["density_bias"])
    if overrides.get("type_mix"):
        prof["type_mix"] = {**prof.get("type_mix", {}), **overrides["type_mix"]}
    if "reuse_per_phrase" in overrides:
        prof["reuse_per_phrase"] = float(overrides["reuse_per_phrase"])
    if "showcase_rate" in overrides:
        prof["showcase_rate"] = float(overrides["showcase_rate"])
    seed = seed if seed is not None else random.randrange(1 << 30)
    rng = random.Random(seed)
    music = project["music"]
    sec = project["section"]
    bars = make_bars(music, sec["start"], sec["drop"])
    choose_densities(bars, prof, rng)
    locked: dict[str, str] = {}
    rally_keep = None
    if keep:
        old = {b["k"]: b for b in keep.get("bars", [])}
        for b in bars:
            ob = old.get(b["k"])
            if ob and ob.get("user_density"):
                b["density"], b["user_density"] = ob["density"], True
                if all("pos" in s for s in ob["slots"]):
                    b["_layout"] = [(s["pos"], s["len"]) for s in ob["slots"]]
            if ob:
                for s in ob["slots"]:
                    if s.get("locked"):
                        locked[s["id"]] = s["shot_id"]
        if keep.get("rally") and keep["rally"].get("locked"):
            rally_keep = keep["rally"]
    for k, d in (overrides.get("bar_density") or {}).items():
        for b in bars:
            if b["k"] == int(k):
                b["density"], b["user_density"] = int(d), True
                b.pop("_layout", None)
    for b in bars:
        b.setdefault("_layout", sk.uniform(b["density"]))
    if rally_keep:
        rally = {k: rally_keep[k] for k in ("rally_id", "start_hit", "video_id", "n_hits", "locked")}
    else:
        rally = make_rally(project, overrides.get("rally_id"), overrides.get("start_hit"), prof)
    # Keep rally footage out of the build-up so the drop feels fresh.
    exclude = set()
    if rally:
        r = next(x for x in project["rallies"] if x["id"] == rally["rally_id"])
        exclude = {h["shot_id"] for h in r["hits"] if h.get("shot_id")}
    flags = serve_flags(project)
    plan_types(bars, _pools(project["shots"], exclude), prof, rng, flags)
    assign_shots(bars, project["shots"], exclude, prof, rng, music, locked, flags)
    for b in bars:
        b.setdefault("user_density", False)
    tl = {"seed": seed, "drop": sec["drop"], "bars": bars, "rally": rally, "mood": project.get("mood"),
          "grid": (keep or {}).get("grid", overrides.get("grid", 8)), "labels": {}}
    return recompute(tl, project)


# ---------------------------------------------------------------- edits

def _find_slot(tl: dict, slot_id: str) -> dict:
    for b in tl["bars"]:
        for s in b["slots"]:
            if s["id"] == slot_id:
                return s
    raise KeyError(f"No slot {slot_id}")


def set_slot_shot(tl: dict, project: dict, slot_id: str, shot_id: str) -> dict:
    if shot_id not in {s["id"] for s in project["shots"]}:
        raise KeyError(f"No shot {shot_id}")
    s = _find_slot(tl, slot_id)
    s["shot_id"], s["locked"], s["repeat"] = shot_id, True, False
    return recompute(tl, project)


def swap_slots(tl: dict, project: dict, a: str, b: str) -> dict:
    sa, sb = _find_slot(tl, a), _find_slot(tl, b)
    sa["shot_id"], sb["shot_id"] = sb["shot_id"], sa["shot_id"]
    sa["locked"] = sb["locked"] = True
    return recompute(tl, project)


def _rally_shots(tl: dict, project: dict) -> set[str]:
    if not tl.get("rally"):
        return set()
    r = next((x for x in project["rallies"] if x["id"] == tl["rally"]["rally_id"]), None)
    return {h["shot_id"] for h in r["hits"] if h.get("shot_id")} if r else set()


def _spare_shots(tl: dict, project: dict, exclude_bar: dict | None = None) -> list[dict]:
    """Unused, visible shots (best first). Shots of `exclude_bar` count as free."""
    used = {s["shot_id"] for b in tl["bars"] if b is not exclude_bar for s in b["slots"]}
    used |= _rally_shots(tl, project)
    return sorted((s for s in project["shots"] if s["id"] not in used and usable(s)),
                  key=lambda s: -s["quality"])


def _rebuild_bar(tl: dict, project: dict, bar: dict, layout: list[tuple[int, int]]) -> None:
    """Re-cut a bar into `layout` (pos, len in sixteenths). A new slot that starts where an old one did keeps
    its shot; the rest get unused shots in a FH FH FH BH feel."""
    old = {s["pos"]: s for s in bar["slots"]}
    keep_ids = {old[p]["shot_id"] for p, _ in layout if p in old}
    spare = [s for s in _spare_shots(tl, project, exclude_bar=bar) if s["id"] not in keep_ids]
    by_id = {s["id"]: s for s in project["shots"]}
    flags = serve_flags(project)
    new_slots = []
    for j, (pos, ln) in enumerate(layout):
        same = old.get(pos)
        fit = [s for s in spare if fits_slot(s, ln, flags)]
        if same is not None:
            shot_id, locked = same["shot_id"], same.get("locked", False)
        elif fit:
            prev = by_id.get(new_slots[-1]["shot_id"]) if new_slots else None
            prev_g = type_group(prev["type"]) if prev else None
            if pos == 12:  # last beat of the bar: switch sides
                pick = next((s for s in fit if type_group(s["type"]) != prev_g), fit[0])
            else:
                pick = next((s for s in fit if type_group(s["type"]) == prev_g), fit[0])
            spare.remove(pick)
            shot_id, locked = pick["id"], False
        else:
            raise ValueError("Every shot is already in the reel, so there's no unused clip for the new slot. "
                             "Reuse a clip by typing its label (e.g. F1) in the skeleton instead.")
        new_slots.append({"id": f"b{bar['k']}s{j}", "pos": pos, "len": ln, "shot_id": shot_id,
                          "repeat": False, "locked": locked})
    bar["slots"] = new_slots
    bar["user_density"] = True


def set_bar_density(tl: dict, project: dict, k: int, density: int) -> dict:
    grid = tl.get("grid", 8)
    allowed = [d for d in (1, 2, 4, 8, 16) if d <= grid]
    if density not in allowed:
        raise ValueError(f"A bar can hold {', '.join(map(str, allowed))} equal clips on this grid.")
    bar = next((b for b in tl["bars"] if b["k"] == k), None)
    if bar is None:
        raise KeyError(f"No bar {k}")
    _rebuild_bar(tl, project, bar, sk.uniform(density))
    return recompute(tl, project)


def _fill(a: int, b: int, allowed: set[int]) -> list[tuple[int, int]]:
    """Cover [a, b) with standard note lengths, each aligned to its own length (e.g. 2..8 = eighth, quarter, ...)."""
    out = []
    while a < b:
        ln = max(L for L in allowed if L <= b - a and a % L == 0)
        out.append((a, ln))
        a += ln
    return out


# ---------------------------------------------------------------- free placement
# Clips can sit anywhere on the grid. Placing one overwrites what it covers: a clip it fully covers is
# deleted, one it partly covers is trimmed to the part that's left. Time no clip covers is black.

def _bar_of(tl: dict, slot_id: str) -> dict:
    bar = next((b for b in tl["bars"] if any(s["id"] == slot_id for s in b["slots"])), None)
    if bar is None:
        raise KeyError(f"No slot {slot_id}")
    return bar


def _reid(tl: dict) -> dict[str, str]:
    """Renumber slot ids as b{k}s{j} in time order (what reshuffle's locked-slot matching expects)."""
    mapping = {}
    for b in tl["bars"]:
        b["slots"].sort(key=lambda s: s["pos"])
        for j, s in enumerate(b["slots"]):
            new = f"b{b['k']}s{j}"
            mapping[s["id"]] = new
        for s in b["slots"]:
            s["id"] = mapping[s["id"]]
    return mapping


def _overwrite(bar: dict, pos: int, length: int, keep: dict | None = None) -> None:
    """Clear [pos, pos+length) in `bar` (except the slot `keep`), trimming or deleting what's there."""
    end = pos + length
    out = []
    for s in bar["slots"]:
        if s is keep:
            out.append(s)
            continue
        s0, s1 = s["pos"], s["pos"] + s["len"]
        if s1 <= pos or s0 >= end:
            out.append(s)
        elif s0 < pos:  # starts before: keep its head (a clip landing mid-way cuts off its tail)
            s["len"] = pos - s0
            s["hit"] = min(s.get("hit") or 0, s["len"])  # the contact stays inside the clip
            out.append(s)
        elif s1 > end:  # starts inside: keep its tail; the contact stays put unless it was cut off
            s["hit"] = max(0, (s.get("hit") or 0) - (end - s0))
            s["pos"], s["len"], s["off"] = end, s1 - end, 0.0
            s["locked"] = True
            out.append(s)
        # else: fully covered -> deleted
    bar["slots"] = out
    bar["user_density"] = True


def _check_span(tl: dict, pos: int, length: int) -> None:
    u = sk.unit(tl.get("grid", 8))
    if length < u or length % u or pos % u:
        raise ValueError("Clips start and end on eighth notes" + (" or sixteenths." if u == 1 else
                         ". Turn on the 1/16 grid for sixteenths."))
    if pos < 0 or pos + length > sk.BAR:
        raise ValueError("A clip has to fit inside one bar.")


def move_slot(tl: dict, project: dict, slot_id: str, k: int, pos: int) -> tuple[dict, str]:
    """Move a clip to bar `k`, position `pos` (sixteenths). Returns (timeline, the clip's new id)."""
    src = _bar_of(tl, slot_id)
    slot = next(s for s in src["slots"] if s["id"] == slot_id)
    dst = next((b for b in tl["bars"] if b["k"] == k), None)
    if dst is None:
        raise KeyError(f"No bar {k}")
    _check_span(tl, pos, slot["len"])
    src["slots"].remove(slot)
    src["user_density"] = True
    _overwrite(dst, pos, slot["len"])
    slot["pos"], slot["locked"] = pos, True
    dst["slots"].append(slot)
    marker = slot["id"] = "_moved"
    new_id = _reid(tl)[marker]
    return recompute(tl, project), new_id


def insert_slot(tl: dict, project: dict, k: int, pos: int, length: int, shot_id: str) -> tuple[dict, str]:
    """Put `shot_id` at bar `k`, `pos` for `length` sixteenths, overwriting whatever is there."""
    if shot_id not in {s["id"] for s in project["shots"]}:
        raise KeyError(f"No shot {shot_id}")
    bar = next((b for b in tl["bars"] if b["k"] == k), None)
    if bar is None:
        raise KeyError(f"No bar {k}")
    _check_span(tl, pos, length)
    _overwrite(bar, pos, length)
    bar["slots"].append({"id": "_new", "pos": pos, "len": length, "shot_id": shot_id, "repeat": False, "locked": True})
    new_id = _reid(tl)["_new"]
    return recompute(tl, project), new_id


def _place(tl: dict, items: list[tuple[int, dict]]) -> list[str]:
    """Put each (absolute position in sixteenths, slot) on the timeline, overwriting what's there.
    Items must not overlap each other. Returns their new ids, in order."""
    bars = tl["bars"]
    for a, s in items:
        bi, pos = divmod(a, sk.BAR)
        if not 0 <= bi < len(bars):
            raise ValueError("That would go past the end of the build-up.")
        _check_span(tl, pos, s["len"])
    for i, (a, s) in enumerate(items):
        bi, pos = divmod(a, sk.BAR)
        _overwrite(bars[bi], pos, s["len"])
        s.update(pos=pos, locked=True, id=f"_g{i}")
        bars[bi]["slots"].append(s)
    m = _reid(tl)
    return [m[f"_g{i}"] for i in range(len(items))]


def _abs_slots(tl: dict, ids: list[str]) -> list[tuple[int, dict, dict]]:
    out = [(bi * sk.BAR + s["pos"], s, b) for bi, b in enumerate(tl["bars"]) for s in b["slots"] if s["id"] in set(ids)]
    if len(out) != len(set(ids)):
        raise KeyError("Some of those clips no longer exist.")
    return sorted(out, key=lambda x: x[0])


def move_slots(tl: dict, project: dict, ids: list[str], delta: int) -> tuple[dict, list[str]]:
    """Move several clips together by `delta` sixteenths (they overwrite what they land on)."""
    found = _abs_slots(tl, ids)
    for _, s, b in found:
        b["slots"].remove(s)
        b["user_density"] = True
    new_ids = _place(tl, [(a + delta, s) for a, s, _ in found])
    return recompute(tl, project), new_ids


def _fits(tl: dict, items: list[tuple[int, int]]) -> bool:
    u = sk.unit(tl.get("grid", 8))
    n = len(tl["bars"]) * sk.BAR
    return all(a >= 0 and a + ln <= n and a % u == 0 and (a % sk.BAR) + ln <= sk.BAR for a, ln in items)


def paste_slots(tl: dict, project: dict, items: list[dict], at: int) -> tuple[dict, list[str]]:
    """Paste copied clips ({shot_id, len, off}) starting at the first spot from `at` (sixteenths) where they
    all fit without crossing a bar line, overwriting what's there."""
    shot_ids = {s["id"] for s in project["shots"]}
    items = [{"shot_id": str(i["shot_id"]), "len": int(i["len"]), "off": int(i["off"]),
              "hit": int(max(0, min(int(i.get("hit") or 0), int(i["len"])))),
              "shift": float(i.get("shift") or 0.0)} for i in items]
    if not items or any(i["shot_id"] not in shot_ids for i in items):
        raise KeyError("Nothing to paste.")
    u = sk.unit(tl.get("grid", 8))
    start = -(-at // u) * u
    n = len(tl["bars"]) * sk.BAR
    while start < n and not _fits(tl, [(start + i["off"], i["len"]) for i in items]):
        start += u
    if start >= n:
        raise ValueError("No room after the selection to paste into.")
    slots = [(start + i["off"], {"len": i["len"], "shot_id": i["shot_id"], "hit": i["hit"], "off": i["shift"], "repeat": False})
             for i in items]
    new_ids = _place(tl, slots)
    return recompute(tl, project), new_ids


def delete_slots(tl: dict, project: dict, ids: list[str]) -> dict:
    for _, s, b in _abs_slots(tl, ids):
        b["slots"].remove(s)
        b["user_density"] = True
    _reid(tl)
    return recompute(tl, project)


def delete_slot(tl: dict, project: dict, slot_id: str) -> dict:
    """Remove a clip, leaving black where it was."""
    bar = _bar_of(tl, slot_id)
    bar["slots"] = [s for s in bar["slots"] if s["id"] != slot_id]
    bar["user_density"] = True
    _reid(tl)
    return recompute(tl, project)


def set_hit(tl: dict, project: dict, slot_id: str, hit: int) -> dict:
    """Move only the contact inside a clip: to grid line `pos + hit`. The clip's frame stays put; its footage
    re-aligns so the contact frame lands on the new beat."""
    bar = _bar_of(tl, slot_id)
    slot = next(s for s in bar["slots"] if s["id"] == slot_id)
    u = sk.unit(tl.get("grid", 8))
    off = float(slot.get("off") or 0.0)
    lo, hi = int(np.ceil((off - 1e-6) / u) * u), int(np.floor((off + slot["len"] + 1e-6) / u) * u)
    slot["hit"] = int(max(lo, min(hi, round(int(hit) / u) * u)))
    slot["locked"] = True
    return recompute(tl, project)


def slide_span(tl: dict, project: dict, slot_id: str, start: float) -> tuple[dict, str]:
    """Ctrl+drag: slide a clip's frame so it starts at `start` (sixteenths into its bar, any value) while its
    contact stays on the same beat: right = the contact nears the clip's start, left = its end. The frame's
    grid footprint (for overwriting neighbours) is the nearest grid position."""
    bar = _bar_of(tl, slot_id)
    slot = next(s for s in bar["slots"] if s["id"] == slot_id)
    contact = slot["pos"] + (slot.get("hit") or 0)
    start = float(max(contact - slot["len"], min(contact, start)))
    u = sk.unit(tl.get("grid", 8))
    L = slot["len"]
    others = [o for o in bar["slots"] if o is not slot]
    # Grid footprint: the grid position nearest the frame's real start that doesn't overlap a neighbour, so
    # sliding up against a clip (or snapping to it) never trims it. Only a real overlap overwrites.
    cands = [p for p in range(0, sk.BAR - L + 1, u) if contact - L <= p <= contact]
    free = [p for p in cands if all(p + L <= o["pos"] or p >= o["pos"] + o["len"] for o in others)]
    vis = lambda o: (o["pos"] + (o.get("off") or 0), o["pos"] + (o.get("off") or 0) + o["len"])
    overlaps = any(min(start + L, vis(o)[1]) - max(start, vis(o)[0]) > 1e-3 for o in others)
    pick = free if (free and not overlaps) else cands
    if not pick:
        raise ValueError("That clip can't slide there.")
    pos = min(pick, key=lambda p: (abs(p - start), p))
    bar["slots"].remove(slot)
    if overlaps or pos not in free:
        _overwrite(bar, pos, L)
    slot["pos"], slot["hit"], slot["off"], slot["locked"] = pos, contact - pos, round(start - pos, 4), True
    bar["slots"].append(slot)
    slot["id"] = "_slid"
    new_id = _reid(tl)["_slid"]
    return recompute(tl, project), new_id

def resize_left(tl: dict, project: dict, slot_id: str, pos: int) -> tuple[dict, str]:
    """Move a clip's left edge to grid position `pos` in its bar: earlier shows more before the contact
    (overwriting what's there), later shows less. The contact and the right edge stay put."""
    bar = _bar_of(tl, slot_id)
    slot = next(s for s in bar["slots"] if s["id"] == slot_id)
    contact, end = slot["pos"] + (slot.get("hit") or 0), slot["pos"] + slot["len"]
    pos = int(max(0, min(pos, contact)))
    _check_span(tl, pos, end - pos)
    if pos < slot["pos"]:
        _overwrite(bar, pos, slot["pos"] - pos, keep=slot)
    slot["pos"], slot["len"], slot["hit"], slot["off"], slot["locked"] = pos, end - pos, contact - pos, 0.0, True
    slot["id"] = "_resized"
    new_id = _reid(tl)["_resized"]
    return recompute(tl, project), new_id


def resize_slot(tl: dict, project: dict, slot_id: str, length: int) -> tuple[dict, str]:
    """Make a clip `length` sixteenths long. Growing overwrites what it runs into; shrinking leaves black.
    Returns (timeline, the clip's new id)."""
    bar = _bar_of(tl, slot_id)
    slot = next(s for s in bar["slots"] if s["id"] == slot_id)
    length = max(length, slot.get("hit") or 0, sk.unit(tl.get("grid", 8)))  # keep the contact inside
    _check_span(tl, slot["pos"], length)
    _overwrite(bar, slot["pos"], length, keep=slot)
    slot["len"], slot["locked"] = length, True
    slot["id"] = "_resized"
    new_id = _reid(tl)["_resized"]
    return recompute(tl, project), new_id


def set_grid(tl: dict, project: dict, grid: int) -> dict:
    if grid not in sk.GRIDS:
        raise ValueError("Grid must be 8 (eighth notes) or 16 (sixteenth notes).")
    if grid < 16:
        fine = [str(b["k"]) for b in tl["bars"] if any(s["len"] % 2 or s["pos"] % 2 for s in b["slots"])]
        if fine:
            raise ValueError(f"Bar{'s' if len(fine) > 1 else ''} {', '.join(fine)} still "
                             f"use{'' if len(fine) > 1 else 's'} sixteenth notes. Change "
                             f"{'them' if len(fine) > 1 else 'it'} first.")
    tl["grid"] = grid
    return recompute(tl, project)


def apply_skeleton(tl: dict, project: dict, text: str) -> dict:
    """Rebuild the build-up from skeleton text (see skeleton.py). Numbered labels that already exist keep their
    clip; new numbers and unnumbered letters get the best unused clip of that type."""
    specs = sk.parse(text, len(tl["bars"]), tl.get("grid", 8))
    shots = {s["id"]: s for s in project["shots"]}
    # A numbered label names a shot: its own name (F7 = the library's F7), or a name the reel used before.
    labels = {**(tl.get("labels") or {}), **{n: sid for sid, n in ensure_names(project, tl).items()}}
    exclude = _rally_shots(tl, project)
    bind: dict[str, str] = {}
    for bar_specs in specs:
        for sp in bar_specs:
            lab = sp["label"]
            sid = labels.get(lab) if lab else None
            if sid and sid in shots and usable(shots[sid]) and sk.letter_for(shots[sid]) == lab[0]:
                bind[lab] = sid
    used = set(bind.values())
    flags = serve_flags(project)
    pool = sorted((s for s in project["shots"] if usable(s) and s["id"] not in exclude),
                  key=lambda s: -s["quality"])
    # New picks go closest-to-the-drop first, so the best unused shots land where the energy is highest.
    for bar_specs in reversed(specs):
        for sp in bar_specs:
            if sp["label"] in bind:
                sp["shot_id"] = bind[sp["label"]]
                continue
            g = sp["group"]
            pick = next((s for s in pool if s["id"] not in used and (g == "*" or sk.group_of(s) == g)
                         and fits_slot(s, sp["len"], flags)), None)
            if pick is None:
                have = sum(1 for s in pool if (g == "*" or sk.group_of(s) == g) and fits_slot(s, sp["len"], flags))
                name = "shots" if g == "*" else f"{g} clips"
                example = sp["label"] or (sk.LETTER.get(g, "F") + "1")
                hint = (" Serves that didn't go in only fit quarter notes or shorter; name one (e.g. S2) to use it "
                        "on a longer clip anyway." if g == "serve" and sp["len"] > QUARTER else "")
                raise ValueError(f"Not enough {name}: the skeleton needs more unique ones than the {have} you have. "
                                 f"Repeat a numbered label (e.g. {example}) to reuse a clip.{hint}")
            used.add(pick["id"])
            sp["shot_id"] = pick["id"]
            if sp["label"]:
                bind[sp["label"]] = pick["id"]
    tl["labels"] = dict(bind)
    for b, bar_specs in zip(tl["bars"], specs):
        old = {s["pos"]: s for s in b["slots"]}
        layout_changed = [(s["pos"], s["len"]) for s in b["slots"]] != [(sp["pos"], sp["len"]) for sp in bar_specs]
        b["slots"] = []
        for j, sp in enumerate(bar_specs):
            o = old.get(sp["pos"])
            same = o is not None and o["len"] == sp["len"] and o["shot_id"] == sp["shot_id"]
            b["slots"].append({"id": f"b{b['k']}s{j}", "pos": sp["pos"], "len": sp["len"], "shot_id": sp["shot_id"],
                               "label": sp["label"], "repeat": False,
                               "locked": o.get("locked", False) if same else True})
        b["user_density"] = b.get("user_density", False) or layout_changed
    return recompute(tl, project)


def set_rally(tl: dict, project: dict, rally_id: str, start_hit: int | None) -> dict:
    prof = {}
    r = next((x for x in project.get("rallies", []) if x["id"] == rally_id), None)
    if r is None or r.get("parked"):
        raise ValueError(f"Rally {rally_id} isn't loaded. Load more rallies at the bottom of the rally picker first.")
    tl["rally"] = make_rally(project, rally_id, start_hit, prof)
    if tl["rally"]:
        tl["rally"]["locked"] = True
    return recompute(tl, project)


def summarize(tl: dict, project: dict) -> dict:
    """Compact view for the LLM."""
    shots = {s["id"]: s for s in project["shots"]}
    flags = serve_flags(project)
    return {
        "serve_rule": "Serves marked serve_in=false may only go on slots of 1 beat or less.",
        "bpm": round(project["music"]["bpm"], 1),
        "reel_seconds": round(tl["duration"], 2),
        "bars": [{
            "k": b["k"], "energy": round(b["energy"], 2), "clips": b["density"],
            "slots": [{"id": s["id"], "label": s.get("label"), "shot": s["shot_id"],
                       "beat": s["pos"] / 4 + 1, "beats": s["len"] / 4,
                       "type": shots[s["shot_id"]]["type"] if s["shot_id"] in shots else None,
                       "stars": shots[s["shot_id"]]["stars"] if s["shot_id"] in shots else None,
                       **({"serve_in": flags[s["shot_id"]]["in"]} if s["shot_id"] in flags else {}),
                       **({"repeat": True} if s.get("repeat") else {}),
                       **({"locked": True} if s.get("locked") else {})} for s in b["slots"]],
        } for b in tl["bars"]],
        "rally": tl.get("rally") and {k: tl["rally"].get(k) for k in ("rally_id", "start_hit", "n_hits")},
        "grid": tl.get("grid", 8),
        "skeleton": tl.get("skeleton"),
    }
