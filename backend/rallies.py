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


# ---------------------------------------------------------------- flow: what makes a practice rally good to watch
# A good rally has a steady back-and-forth rhythm. The things that kill it (volleying a ball that's flying
# out from the baseline, letting a short ball bounce twice, a scramble) show up as a break in that rhythm:
# the ball comes back much sooner or much later than the exchange around it. The rhythm is measured as my
# cycle time (one of my contacts to the next), which survives partner hits the microphone missed; when the
# partner's contact was heard, the half of the cycle that's off tells whose ball it was.

FLOW_EARLY = 0.55  # cycle this much shorter than the local rhythm: taken out of the air
FLOW_LATE = 1.9    # this much longer: short ball, double bounce, or a scramble
FLOW_DEAD = 4.2    # seconds between my contacts: the ball was dead whatever the rhythm
FLOW_MIN = 3       # contacts in a stretch worth ranking
VOLLEYS = {"fh_volley", "bh_volley"}
BASELINE_DEPTH = 0.88  # body size vs. usual: at or near the baseline

LABELS = {
    "early": ("Out of the air?", "came back {d:.1f}s sooner than this rally's rhythm: volleyed from the baseline, or the ball was flying out"),
    "late": ("Double bounce?", "came back {d:.1f}s later than this rally's rhythm: a short ball (let it bounce twice?) or a scramble"),
    "opp_early": ("Partner: out of the air?", "partner played my ball {d:.1f}s sooner than the rhythm: it was probably flying long"),
    "opp_late": ("Partner: double bounce?", "partner played my ball {d:.1f}s later than the rhythm: it was probably short"),
    "baseline_volley": ("Baseline volley", "a volley hit from baseline depth: the ball was flying out"),
    "marked": ("Vibe-killer", "marked by you"),
}


def _med(xs: list[float]) -> float | None:
    return float(np.median(xs)) if xs else None


def typical_cycle(points: list[list[dict]]) -> float:
    """A video's usual time between my contacts, for points too short to have a rhythm of their own."""
    cyc = []
    for pt in points:
        mine = [h["t"] for h in pt if h["player"] == "me"]
        cyc += [b - a for a, b in zip(mine, mine[1:]) if b - a < FLOW_DEAD]
    return _med(cyc) or 2.5


def _flag(kind: str, d: float = 0.0, auto: bool = True) -> dict:
    short, why = LABELS[kind]
    return {"kind": kind, "label": short, "why": why.format(d=abs(d)), "auto": auto}


def flow_flags(hits: list[dict], shots: dict[str, dict], overrides: dict[str, bool], fallback: float) -> dict[int, dict]:
    """Vibe-killers in one point, by contact index. Overrides (keyed by the contact's time, "%.3f"):
    True = you marked it, False = you said it was fine (the flag stays, switched off)."""
    auto: dict[int, dict] = {}
    for i, h in enumerate(hits):
        s = shots.get(h.get("shot_id") or "")
        if s and s.get("type") in VOLLEYS and ((s.get("features") or {}).get("depth_ratio") or 0) >= BASELINE_DEPTH:
            auto[i] = _flag("baseline_volley")

    mine = [i for i, h in enumerate(hits) if h["player"] == "me"]
    cycles = [hits[b]["t"] - hits[a]["t"] for a, b in zip(mine, mine[1:])]
    halves: list[tuple[int, float, float] | None] = []  # (partner index, my ball's flight, partner's ball's flight)
    for a, b in zip(mine, mine[1:]):
        heard = [k for k in range(a + 1, b) if not hits[k].get("inferred")]
        halves.append((heard[0], hits[heard[0]]["t"] - hits[a]["t"], hits[b]["t"] - hits[heard[0]]["t"])
                      if len(heard) == 1 else None)
    ref_out = _med([x[1] for x in halves if x])
    ref_back = _med([x[2] for x in halves if x])

    for j, c in enumerate(cycles):
        near = [x for x in cycles[max(0, j - 4):j] + cycles[j + 1:j + 5] if x < FLOW_DEAD]
        ref = _med(near) if len(near) >= 3 else fallback
        r = c / ref
        early, late = r < FLOW_EARLY, (r > FLOW_LATE or c > FLOW_DEAD) and j > 0  # the first cycle is the feed
        if not (early or late):
            continue
        target, kind = mine[j + 1], "early" if early else "late"
        hv = halves[j]
        if hv and ref_out and ref_back:
            r_out, r_back = hv[1] / ref_out, hv[2] / ref_back
            if (r_out < r_back) if early else (r_out > r_back):
                target, kind = hv[0], "opp_" + kind
        auto.setdefault(target, _flag(kind, c - ref))

    out: dict[int, dict] = {}
    for i, h in enumerate(hits):
        o = overrides.get(f"{h['t']:.3f}")
        if o is True:
            out[i] = auto.get(i) or _flag("marked", auto=False)
            out[i] = {**out[i], "off": False, "auto": i in auto}
        elif i in auto:
            out[i] = {**auto[i], "off": o is False}
    return out


def stretch_score(hits: list[dict], shots: dict[str, dict]) -> dict:
    """0-100. Length matters most (diminishing past ~15 contacts), then a steady rhythm, then my shots."""
    n = len(hits)
    mine_t = [h["t"] for h in hits if h["player"] == "me"]
    cyc = np.diff(mine_t) if len(mine_t) >= 2 else np.array([])
    steady = float(np.clip(1 - 2 * np.std(cyc) / np.mean(cyc), 0, 1)) if len(cyc) >= 2 else 0.5
    qs = []
    for h in hits:
        s = shots.get(h.get("shot_id") or "")
        if s:
            q = (s["user_stars"] - 1) / 4 if s.get("user_stars") else s.get("quality", 0.4)
            qs.append(0.1 if s.get("hidden") else q)
    quality = float(np.mean(qs)) if qs else 0.4
    opp = [h for h in hits if h["player"] == "opp"]
    heard = 1 - sum(1 for h in opp if h.get("inferred")) / len(opp) if opp else 0.5
    length = 1 - float(np.exp(-n / 8))
    score = 100 * (0.55 * length + 0.2 * steady + 0.2 * quality + 0.05 * heard)
    return {"score": round(score, 1), "n": n, "steady": round(steady, 2), "quality": round(quality, 2),
            "tempo": round(60 / float(np.mean(cyc)) * 2, 1) if len(cyc) else None}


def clean_stretches(hits: list[dict], flags: dict[int, dict], shots: dict[str, dict]) -> list[dict]:
    """The point cut at each vibe-killer (the bad contact is left out), each part scored, best first."""
    out, run = [], []
    for i, h in enumerate(hits):
        f = flags.get(i)
        if f and not f.get("off"):
            if run:
                out.append(run)
            run = []
        else:
            run.append(i)
    if run:
        out.append(run)
    scored = []
    for r in out:
        sub = [hits[i] for i in r]
        if len(sub) >= FLOW_MIN and any(h["player"] == "me" for h in sub):
            scored.append({"i0": r[0], "i1": r[-1], "t0": sub[0]["t"], "t1": sub[-1]["t"], **stretch_score(sub, shots)})
    return sorted(scored, key=lambda s: -s["score"])
