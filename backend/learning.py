"""User preferences, learned per mood from the difference between the app's draft and my final export."""
from __future__ import annotations

import json
import threading
import time
import warnings
from copy import deepcopy

import numpy as np

from . import config
from .shots import DEFAULT_WEIGHTS, QUALITY_FEATURES

_lock = threading.Lock()

DEFAULT_PROFILE = {
    "n": 0,
    "density_bias": 0.0,          # + = busier cutting
    "type_mix": {"forehand": 0.55, "backhand": 0.3, "volley": 0.07, "approach": 0.04, "serve": 0.04},
    "reuse_per_phrase": 1.5,       # repeated-note shot reuses per 8 bars
    "showcase_rate": 0.25,         # chance a calm bar becomes one long clip
    "rally_hits": None,            # preferred rally window length (hits)
    "quality_weights": dict(DEFAULT_WEIGHTS),
}


def _load() -> dict:
    if config.PREFS_FILE.exists():
        try:
            return json.loads(config.PREFS_FILE.read_text())
        except Exception:
            pass
    return {"handed": "right", "profiles": {}, "label_examples": [], "star_examples": [], "history": []}


def _defaults(p: dict) -> dict:
    for k in ("reject_examples", "accept_examples", "complaints"):
        p.setdefault(k, [])
    return p


def _save(p: dict) -> None:
    tmp = config.PREFS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(p, indent=1))
    tmp.replace(config.PREFS_FILE)


def load() -> dict:
    with _lock:
        return _defaults(_load())


def update(fn) -> dict:
    with _lock:
        p = _defaults(_load())
        fn(p)
        _save(p)
        return p


# ---------------------------------------------------------------- where a rally ends
# A rally (point) ends when the ball doesn't come back for a while. The app starts at POINT_GAP seconds and learns
# from your corrections in the rally tab: each "the rally ended here" (a break) or "this is the same rally"
# (a join) is remembered with how long the pause was, and the threshold moves to fit them, across projects.

POINT_GAP = 5.5
POINT_GAP_RANGE = (2.5, 10.0)  # never so short that ordinary rallies get chopped up, nor absurdly long


def record_break(key: str, gap: float | None, is_break: bool | None) -> None:
    """Remember (or with is_break=None, forget) your verdict on the pause before a contact. `key` names the
    contact (project/video/time) so changing your mind replaces the old verdict."""
    def fn(p: dict) -> None:
        ex = p.setdefault("break_examples", {})
        if is_break is None or gap is None:
            ex.pop(key, None)
        else:
            ex[key] = {"gap": round(float(gap), 3), "break": bool(is_break)}
        if len(ex) > 3000:  # keep the most recent
            for k in list(ex)[:len(ex) - 3000]:
                ex.pop(k)
    update(fn)


def point_gap(prefs: dict | None = None) -> float:
    """The pause (seconds) after which a rally counts as over, fitted to your corrections: the threshold that
    gets the most of them right (ties: the one closest to the default)."""
    ex = list(((prefs or load()).get("break_examples") or {}).values())
    if not ex:
        return POINT_GAP
    lo, hi = POINT_GAP_RANGE
    gaps = sorted({e["gap"] for e in ex})
    cands = {POINT_GAP, lo, hi} | {g - 0.05 for g in gaps} | {g + 0.05 for g in gaps} | {(a + b) / 2 for a, b in zip(gaps, gaps[1:])}
    cands = [c for c in cands if lo <= c <= hi]
    # A pause longer than the threshold ends the rally.
    wrong = lambda T: sum(1 for e in ex if (e["gap"] > T) != e["break"])
    return round(min(cands, key=lambda T: (wrong(T), abs(T - POINT_GAP))), 3)


def profile(mood: str | None) -> dict:
    """Effective profile: the mood's profile blended with the global one by experience."""
    prefs = load()
    g = {**deepcopy(DEFAULT_PROFILE), **prefs["profiles"].get("_global", {})}
    if not mood or mood not in prefs["profiles"]:
        return g
    m = {**deepcopy(DEFAULT_PROFILE), **prefs["profiles"][mood]}
    a = m["n"] / (m["n"] + 2.0)
    out = deepcopy(g)
    out["density_bias"] = a * m["density_bias"] + (1 - a) * g["density_bias"]
    out["reuse_per_phrase"] = a * m["reuse_per_phrase"] + (1 - a) * g["reuse_per_phrase"]
    out["showcase_rate"] = a * m["showcase_rate"] + (1 - a) * g["showcase_rate"]
    out["rally_hits"] = m["rally_hits"] if m["rally_hits"] else g["rally_hits"]
    keys = set(g["type_mix"]) | set(m["type_mix"])
    out["type_mix"] = {k: a * m["type_mix"].get(k, 0) + (1 - a) * g["type_mix"].get(k, 0) for k in keys}
    out["quality_weights"] = {k: a * m["quality_weights"].get(k, 0) + (1 - a) * g["quality_weights"].get(k, 0)
                              for k in QUALITY_FEATURES}
    out["n"] = m["n"]
    return out


def type_group(t: str) -> str:
    if t == "fh_slice":
        return "forehand"
    if t == "bh_slice":
        return "backhand"
    if t in ("fh_volley", "bh_volley"):
        return "volley"
    if t in ("serve", "overhead"):
        return "serve"
    if t == "unknown":
        return "forehand"
    return t


def _summary(tl: dict, shots: dict[str, dict]) -> dict:
    # Only the build-up is generated, so only it is learned from (after the drop is the user's own region).
    tl = {**tl, "bars": [b for b in tl["bars"] if b["k"] < 0]}
    slots = [s for b in tl["bars"] for s in b["slots"]]
    mix: dict[str, float] = {}
    for s in slots:
        sh = shots.get(s["shot_id"])
        if sh:
            g = type_group(sh["type"])
            mix[g] = mix.get(g, 0) + 1
    tot = sum(mix.values()) or 1
    reuses = sum(1 for b in tl["bars"] for i, s in enumerate(b["slots"])
                 if i and s["shot_id"] == b["slots"][i - 1]["shot_id"])
    phrases = max(1.0, len(tl["bars"]) / 8)
    rally = tl.get("rally") or {}
    return {
        "densities": {b["k"]: b["density"] for b in tl["bars"]},
        "mix": {k: v / tot for k, v in mix.items()},
        "reuse_per_phrase": reuses / phrases,
        "shot_ids": sorted({s["shot_id"] for s in slots}),
        "rally_hits": rally.get("n_hits"),
        "n_slots": len(slots),
    }


def learn_from_export(draft: dict, final: dict, shots: dict[str, dict], moods: list[str], rating: str | None,
                      project_id: str) -> dict:
    d, f = _summary(draft, shots), _summary(final, shots)
    w = {"up": 1.0, "down": 0.2}.get(rating or "", 0.6)
    # Density change in "levels" (log2 of clips per bar)
    diffs = [np.log2(f["densities"][k]) - np.log2(d["densities"][k]) for k in f["densities"] if k in d["densities"]]
    dens_shift = float(np.mean(diffs)) if diffs else 0.0
    added = [shots[i] for i in set(f["shot_ids"]) - set(d["shot_ids"]) if i in shots]
    removed = [shots[i] for i in set(d["shot_ids"]) - set(f["shot_ids"]) if i in shots]

    def apply(p: dict) -> None:
        p.setdefault("n", 0)
        for k, v in DEFAULT_PROFILE.items():
            p.setdefault(k, deepcopy(v))
        p["density_bias"] = float(np.clip(p["density_bias"] + w * 0.5 * dens_shift * 0.3, -0.6, 0.6))
        a = 0.35 * w
        keys = set(p["type_mix"]) | set(f["mix"])
        p["type_mix"] = {k: (1 - a) * p["type_mix"].get(k, 0) + a * f["mix"].get(k, 0) for k in keys}
        p["reuse_per_phrase"] = float((1 - a) * p["reuse_per_phrase"] + a * f["reuse_per_phrase"])
        if f["rally_hits"]:
            p["rally_hits"] = f["rally_hits"] if not p["rally_hits"] else (1 - a) * p["rally_hits"] + a * f["rally_hits"]
        if added and removed:
            qw = p["quality_weights"]
            for k in QUALITY_FEATURES:
                da = np.mean([s["components"].get(k, 0) for s in added])
                dr = np.mean([s["components"].get(k, 0) for s in removed])
                qw[k] = max(0.02, qw.get(k, 0.2) + 0.15 * w * (da - dr))
            tot = sum(qw.values())
            p["quality_weights"] = {k: v / tot for k, v in qw.items()}
        p["n"] += 1

    def fn(prefs: dict) -> None:
        for key in ["_global", *moods]:
            prof = prefs["profiles"].setdefault(key, deepcopy(DEFAULT_PROFILE))
            apply(prof)
        prefs["history"].append({
            "time": time.time(), "project": project_id, "moods": moods, "rating": rating,
            "draft": {k: v for k, v in d.items() if k != "shot_ids"},
            "final": {k: v for k, v in f.items() if k != "shot_ids"},
            "added": len(added), "removed": len(removed),
        })

    return update(fn)


def add_label_example(features: dict, label: str) -> None:
    keep = {k: features.get(k) for k in ("side", "side_both", "overhead", "depth_ratio", "forward", "swing", "lift")}

    def fn(p: dict) -> None:
        p["label_examples"].append({"features": keep, "label": label})
        p["label_examples"] = p["label_examples"][-2000:]
    update(fn)


def add_star_example(components: dict, stars: int) -> None:
    """A manual star rating teaches the global quality weights (non-negative least squares)."""
    from scipy.optimize import nnls

    def fn(p: dict) -> None:
        p["star_examples"].append({"components": components, "stars": stars})
        p["star_examples"] = p["star_examples"][-1000:]
        ex = p["star_examples"]
        if len(ex) >= 6:
            A = np.array([[e["components"].get(k, 0) for k in QUALITY_FEATURES] for e in ex])
            b = np.array([(e["stars"] - 1) / 4 for e in ex])
            wts, _ = nnls(A, b)
            if wts.sum() > 0:
                wts = wts / wts.sum()
                g = p["profiles"].setdefault("_global", deepcopy(DEFAULT_PROFILE))
                cur = g.get("quality_weights", dict(DEFAULT_WEIGHTS))
                g["quality_weights"] = {k: 0.5 * cur.get(k, 0.2) + 0.5 * float(wv) for k, wv in zip(QUALITY_FEATURES, wts)}
    update(fn)


# ---------------------------------------------------------------- complaints and "not a real shot"

REJECT_KEYS = ["near_speed", "loud_pct", "sharp", "rise", "swing", "side", "overhead", "depth_ratio", "forward", "lift"]


def add_accept_example(features: dict) -> None:
    """A shot the user treated as real (rated it well, relabelled it, or kept it after a complaint)."""
    def fn(p: dict) -> None:
        p["accept_examples"] = (p["accept_examples"] + [{k: features.get(k) for k in REJECT_KEYS}])[-2000:]
    update(fn)


def add_complaint(shot: dict, reason: str, note: str) -> None:
    feats = {k: (shot.get("features") or {}).get(k) for k in REJECT_KEYS}

    def fn(p: dict) -> None:
        p["complaints"] = (p["complaints"] + [{
            "time": time.time(), "reason": reason, "note": note, "type": shot.get("type"),
            "stars": shot.get("stars"), "features": feats, "components": shot.get("components"),
        }])[-2000:]
        if reason in config.REJECT_REASONS:
            p["reject_examples"] = (p["reject_examples"] + [feats])[-2000:]
        elif reason in config.RANK_REASONS:
            # Rated too high for a reason the score under-weighs: lean on the parts that were low here.
            g = p["profiles"].setdefault("_global", deepcopy(DEFAULT_PROFILE))
            qw = dict(g.get("quality_weights", DEFAULT_WEIGHTS))
            comps = shot.get("components") or {}
            for k in config.RANK_REASONS[reason]:
                qw[k] = qw.get(k, 0.2) + 0.04 * (1 - comps.get(k, 0.5))
            tot = sum(qw.values()) or 1
            g["quality_weights"] = {k: v / tot for k, v in qw.items()}
    update(fn)


def suspect_model():
    """Returns f(features) -> True when a shot looks like the ones the user said weren't real shots,
    or None until there are enough examples of both kinds."""
    prefs = load()
    rej = prefs["reject_examples"]
    acc = prefs["accept_examples"] + [x["features"] for x in prefs["label_examples"]]
    if len(rej) < 8 or len(acc) < 8:
        return None

    def vec(r: dict) -> list[float]:
        return [np.nan if r.get(k) is None else float(r[k]) for k in REJECT_KEYS]

    X = np.array([vec(r) for r in rej + acc])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mu = np.nanmean(X, axis=0)
        sd = np.nanstd(X, axis=0)
    mu = np.where(np.isnan(mu), 0, mu)
    sd = np.where(np.isnan(sd) | (sd < 1e-6), 1, sd)
    Z = np.where(np.isnan(X), 0, (X - mu) / sd)
    y = np.array([1] * len(rej) + [0] * len(acc))
    # Balance the classes so many accepts don't drown out a handful of rejects.
    wts = np.where(y == 1, len(acc) / len(rej), 1.0)
    k = min(9, len(y))

    def f(features: dict) -> bool:
        v = np.array(vec(features))
        z = np.where(np.isnan(v), 0, (v - mu) / sd)
        nn = np.linalg.norm(Z - z, axis=1).argsort()[:k]
        return bool((wts[nn] * y[nn]).sum() / wts[nn].sum() > 0.7)
    return f
