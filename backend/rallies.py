"""Group hit events into rallies, find where each point ends, and score rallies."""
from __future__ import annotations

import numpy as np

POINT_END_AFTER_LAST_HIT = 1.2  # ball travels, the point is over


def build_rallies(events: list[dict], videos: dict[str, dict]) -> list[dict]:
    rallies: list[dict] = []
    by_video: dict[str, list[dict]] = {}
    for e in events:
        by_video.setdefault(e["video_id"], []).append(e)
    for vid, evs in by_video.items():
        # My hits are reliable (pose + sound); the opponent's come from sound only, so rallies are built
        # from my hits and the opponent's strikes are attached in the gaps between them.
        mine = sorted((e for e in evs if e["player"] == "me"), key=lambda e: e["t"])
        opp = sorted((e for e in evs if e["player"] == "opp"), key=lambda e: e["t"])

        def opp_between(a: float, b: float) -> dict | None:
            c = [o for o in opp if a < o["t"] < b]
            return max(c, key=lambda o: o["loud"] + 0.5 * o.get("sharp", 0)) if c else None

        groups: list[list[dict]] = []
        for e in mine:
            if groups and 1.2 <= e["t"] - groups[-1][-1]["t"] <= 5.5:
                groups[-1].append(e)
            else:
                groups.append([e])
        for g in groups:
            hits: list[dict] = []
            # The opponent's feed/serve/shot that started it
            first = opp_between(g[0]["t"] - 3.0, g[0]["t"] - 0.7)
            if first:
                hits.append(first)
            for a, b in zip(g, g[1:]):
                hits.append(a)
                o = opp_between(a["t"] + 0.6, b["t"] - 0.6)
                hits.append(o or {"t": (a["t"] + b["t"]) / 2, "player": "opp", "inferred": True, "video_id": vid})
            hits.append(g[-1])
            # Did the opponent get my last ball back (and then I missed / didn't play it)?
            last_opp = opp_between(g[-1]["t"] + 0.7, g[-1]["t"] + 3.0)
            if last_opp:
                hits.append(last_opp)
            if len(g) >= 2 and len(hits) >= 3:
                rallies.append(_make_rally(vid, hits, videos[vid]["duration"]))
    for i, r in enumerate(rallies):
        r["id"] = f"r{i}"
    return rallies


def _make_rally(video_id: str, hits: list[dict], duration: float) -> dict:
    point_end = min(duration - 0.05, hits[-1]["t"] + POINT_END_AFTER_LAST_HIT)
    return {
        "video_id": video_id,
        "hits": [{"t": h["t"], "player": h["player"], "shot_id": h.get("shot_id"),
                  "inferred": bool(h.get("inferred"))} for h in hits],
        "start": hits[0]["t"],
        "point_end": point_end,
    }


def length_value(n: int) -> float:
    """Shot count matters, but past ~5 shots back and forth the audience doesn't care."""
    return min(n, 5) / 5.0


def window_score(rally: dict, k: int, quality: dict[str, float], pref_hits: float | None = None) -> float:
    hits = rally["hits"][k:]
    n = len(hits)
    mine = [quality.get(h["shot_id"], 0.4) for h in hits if h["player"] == "me" and h.get("shot_id")]
    q_mean = float(np.mean(mine)) if mine else 0.3
    q_max = float(np.max(mine)) if mine else 0.3
    dur = rally["point_end"] - hits[0]["t"]
    s = 0.5 * length_value(n) + 0.35 * q_mean + 0.15 * q_max
    if dur > 9.0:
        s -= 0.04 * (dur - 9.0)
    if pref_hits:
        s -= 0.03 * abs(n - pref_hits)
    return s


def best_window(rally: dict, quality: dict[str, float], pref_hits: float | None = None) -> tuple[int, float]:
    """Pick the hit to start from (may begin mid-rally). Returns (start index, score)."""
    n = len(rally["hits"])
    best_k, best = 0, -1e9
    for k in range(0, max(1, n - 1)):
        if rally["hits"][k]["player"] != "me":
            continue  # the drop lands on MY strike (the opponent is a speck in the distance)
        s = window_score(rally, k, quality, pref_hits)
        if s > best + 1e-6:
            best, best_k = s, k
    return best_k, best


def score_rallies(rallies: list[dict], quality: dict[str, float], pref_hits: float | None = None) -> None:
    for r in rallies:
        k, s = best_window(r, quality, pref_hits)
        r["best_start"] = k
        r["score"] = round(float(s), 4)
        r["n_hits"] = len(r["hits"])
        r["duration"] = round(r["point_end"] - r["start"], 2)
