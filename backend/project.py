"""Project storage, background jobs and the analysis pipeline."""
from __future__ import annotations

import hashlib
import json
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from . import config, learning, media, music as music_mod, rallies as rallies_mod, shots as shots_mod

# ---------------------------------------------------------------- jobs

JOBS: dict[str, dict] = {}
_CANCEL: set[str] = set()


class Cancelled(Exception):
    """Raised inside a job (from its progress callback) once the user asks to stop it."""


def cancel_job(jid: str) -> bool:
    j = JOBS.get(jid)
    if not j or j["status"] != "running":
        return False
    _CANCEL.add(jid)
    j["message"] = "Stopping and erasing progress"
    return True


def start_job(kind: str, fn, *args) -> str:
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "kind": kind, "status": "running", "progress": 0.0, "message": "Starting", "result": None,
           "error": None}
    JOBS[jid] = job

    def progress(p: float | None = None, msg: str | None = None):
        """Report progress. Also the job's stop point: raises Cancelled once stopped (call with no args to check)."""
        if jid in _CANCEL:
            raise Cancelled()
        if p is not None:
            job["progress"] = float(max(0.0, min(1.0, p)))
        if msg:
            job["message"] = msg

    def runner():
        try:
            job["result"] = fn(*args, progress)
            job["status"], job["progress"], job["message"] = "done", 1.0, "Done"
        except Cancelled:
            job["status"], job["message"] = "cancelled", "Stopped"
        except Exception as e:  # surfaced to the UI
            traceback.print_exc()
            job["status"], job["error"] = "error", str(e)

    threading.Thread(target=runner, daemon=True).start()
    return jid


# ---------------------------------------------------------------- storage

_locks: dict[str, threading.RLock] = {}
_cache: dict[str, dict] = {}


def lock(pid: str) -> threading.RLock:
    return _locks.setdefault(pid, threading.RLock())


def pdir(pid: str) -> Path:
    return config.PROJECTS / pid


def load(pid: str) -> dict:
    with lock(pid):
        if pid not in _cache:
            f = pdir(pid) / "project.json"
            if not f.exists():
                raise KeyError(pid)
            _cache[pid] = json.loads(f.read_text())
        return _cache[pid]


def save(p: dict) -> None:
    with lock(p["id"]):
        _cache[p["id"]] = p
        f = pdir(p["id"]) / "project.json"
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(p))
        tmp.replace(f)


def list_projects() -> list[dict]:
    out = []
    for d in sorted(config.PROJECTS.iterdir(), key=lambda d: -(d / "project.json").stat().st_mtime if (d / "project.json").exists() else 0):
        f = d / "project.json"
        if f.exists():
            try:
                p = load(d.name)
                out.append({"id": p["id"], "name": p["name"], "created": p["created"], "status": p["status"],
                            "modified": f.stat().st_mtime, "last_step": p.get("last_step", "song"),
                            "n_shots": len(p.get("shots", [])), "n_exports": len(p.get("exports", []))})
            except Exception:
                pass
    return out


def create(name: str, footage_dir: str, song_path: str, handed: str) -> dict:
    fd = Path(footage_dir)
    if not fd.is_dir():
        raise ValueError(f"Footage folder not found: {footage_dir}")
    vids = sorted(p for p in fd.iterdir() if p.suffix.lower() in config.VIDEO_EXTS)
    if not vids:
        raise ValueError("No videos (.mov/.mp4) in that folder.")
    sp = Path(song_path)
    if not sp.is_file() or sp.suffix.lower() not in config.AUDIO_EXTS:
        raise ValueError(f"Song file not found or unsupported: {song_path}")
    pid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    d = pdir(pid)
    for sub in ("proxies", "thumbs", "exports"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    p = {
        "id": pid, "name": name or fd.name, "created": time.time(), "handed": handed,
        "footage_dir": str(fd), "song_src": str(sp),
        "videos": [{"id": f"v{i}", "path": str(v), "name": v.name} for i, v in enumerate(vids)],
        "status": "new", "song": None, "music": None, "section": None,
        "shots": [], "rallies": [], "timeline": None, "first_draft": None, "chat": [], "exports": [],
        "mood": None,
    }
    save(p)
    learning.update(lambda prefs: prefs.__setitem__("handed", handed))
    return p


# ---------------------------------------------------------------- pipeline

def _file_key(path: str) -> str:
    st = Path(path).stat()
    return hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}|v2".encode()).hexdigest()[:16]


def analyze_song(p: dict) -> None:
    out = pdir(p["id"]) / "song.wav"
    media.extract_audio(p["song_src"], out, 44100, mono=False)
    ana_wav = pdir(p["id"]) / "song_mono.wav"
    media.extract_audio(p["song_src"], ana_wav, music_mod.SR, mono=True)
    m = music_mod.analyze_song(str(ana_wav))
    ana_wav.unlink(missing_ok=True)
    p["song"] = {"path": str(out), "duration": m["duration"], "name": Path(p["song_src"]).name}
    p["music"] = m
    # Suggest a section: the strongest drop in the song, with 8 bars of build-up.
    drop = music_mod.detect_drop(m, 0, m["duration"])
    start = max(0.0, drop - 32 * m["period"])
    p["section"] = {"start": start, "end": min(m["duration"], drop + 32 * m["period"]), "drop": drop,
                    "suggested": True}


def default_counts() -> dict[str, int]:
    """How many of each kind get previews when analysis runs, unless the user picks other numbers."""
    return {**config.INITIAL_SHOTS, "rally": config.INITIAL_RALLIES}


def clean_counts(counts: dict | None) -> dict[str, int]:
    """User-chosen counts per kind, clamped to 0..1000; missing or invalid kinds use the defaults."""
    out = default_counts()
    for k, v in (counts or {}).items():
        if k in out:
            try:
                out[k] = max(0, min(1000, int(v)))
            except (TypeError, ValueError):
                pass
    return out


def pool_group(s: dict) -> str:
    """Which preview budget a shot counts against (config.INITIAL_SHOTS keys)."""
    return "unknown" if s["type"] == "unknown" else learning.type_group(s["type"])


def next_best(shots: list[dict], group: str, n: int) -> list[dict]:
    """The `n` best parked shots of `group`."""
    cands = [s for s in shots if s.get("parked") and pool_group(s) == group]
    return sorted(cands, key=lambda s: -s["quality"])[:n]


def pool_counts(p: dict) -> dict[str, dict]:
    """Per kind: how many shots are shown and how many more are waiting (parked)."""
    out = {g: {"shown": 0, "more": 0} for g in [*config.INITIAL_SHOTS, "rally"]}
    for s in p.get("shots", []):
        out.setdefault(pool_group(s), {"shown": 0, "more": 0})["more" if s.get("parked") else "shown"] += 1
    for r in p.get("rallies", []):
        out["rally"]["more" if r.get("parked") else "shown"] += 1
    return out


def make_previews(pid: str, videos: dict[str, dict], shots: list[dict], rallies: list[dict],
                  progress, lo: float, hi: float) -> None:
    """Cut the browser preview clips (and shot thumbnails), setting the proxy/thumb fields on each item."""
    d = pdir(pid)
    tasks = []
    pre, post = config.SHOT_PROXY_WINDOW
    for s in shots:
        v = videos[s["video_id"]]
        start = max(0.0, s["t"] + pre)
        s["proxy"] = {"file": f"proxies/{s['id']}.mp4", "start": start}
        s["thumb"] = f"thumbs/{s['id']}.jpg"
        tasks.append(("proxy", v, start, s["t"] + post - start, d / s["proxy"]["file"]))
        tasks.append(("thumb", v, s["t"], 0, d / s["thumb"]))
    for r in rallies:
        v = videos[r["video_id"]]
        start = max(0.0, r["start"] - 0.6)
        end = min(v["duration"], r["point_end"] + 1.5)
        r["proxy"] = {"file": f"proxies/{r['id']}.mp4", "start": start}
        tasks.append(("proxy", v, start, end - start, d / r["proxy"]["file"]))
    done = [0]

    def work(t):
        progress()  # once stopped, skip the remaining previews
        kind, v, start, dur, out = t
        if not out.exists():
            if kind == "proxy":
                media.make_proxy(v["path"], start, dur, out, v["meta"], config.PROXY_HEIGHT, config.PROXY_FPS)
            else:
                media.make_thumb(v["path"], start, out, v["meta"])
        done[0] += 1
        progress(lo + (hi - lo) * done[0] / max(1, len(tasks)), f"Preparing previews ({done[0]}/{len(tasks)})")

    with ThreadPoolExecutor(max_workers=3) as ex:
        list(ex.map(work, tasks))


def load_more(pid: str, group: str, n: int, progress) -> dict:
    """Un-park the next `n` best shots of `group` (or rallies, group="rally") and make their previews."""
    p = load(pid)
    videos = {v["id"]: v for v in p["videos"]}
    if group == "rally":
        picks_s, picks_r = [], sorted((r for r in p["rallies"] if r.get("parked")), key=lambda r: -r["score"])[:n]
    else:
        picks_s, picks_r = next_best(p["shots"], group, n), []
    progress(0.02, f"Preparing {len(picks_s) + len(picks_r)} more previews")
    make_previews(pid, videos, picks_s, picks_r, progress, 0.02, 0.98)
    with lock(pid):  # reload: the user may have edited the project meanwhile
        p = load(pid)
        new_s = {s["id"]: s for s in picks_s}
        new_r = {r["id"]: r for r in picks_r}
        for s in p["shots"]:
            if s["id"] in new_s:
                s.update(proxy=new_s[s["id"]]["proxy"], thumb=new_s[s["id"]]["thumb"], parked=False)
        for r in p["rallies"]:
            if r["id"] in new_r:
                r.update(proxy=new_r[r["id"]]["proxy"], parked=False)
        save(p)
    return {"added": len(picks_s) + len(picks_r), "pool": pool_counts(p)}


def reset_analysis(pid: str) -> None:
    """Erase all footage-analysis results for a project, back to how it was right after creation."""
    d = pdir(pid)
    for sub in ("proxies", "thumbs"):
        for f in (d / sub).glob("*"):
            f.unlink(missing_ok=True)
    with lock(pid):
        p = load(pid)
        p.update(status="new", shots=[], rallies=[], timeline=None, first_draft=None, chat=[], job=None)
        p.pop("stats", None)
        save(p)


def analyze_footage(pid: str, progress) -> dict:
    written: list[Path] = []  # cache files this run creates; removed again if the run is stopped
    try:
        return _analyze_footage(pid, progress, written)
    except Cancelled:
        for f in written:
            f.unlink(missing_ok=True)
        reset_analysis(pid)
        raise


def _analyze_footage(pid: str, progress, written: list[Path]) -> dict:
    p = load(pid)
    with lock(pid):
        p["status"] = "analyzing"
        save(p)
    if not p.get("music"):
        progress(0.01, "Analyzing song")
        analyze_song(p)
        save(p)
    n = len(p["videos"])
    analyses: dict[str, dict] = {}
    for i, v in enumerate(p["videos"]):
        base = 0.03 + 0.67 * i / n
        span = 0.67 / n
        progress(base, f"Reading {v['name']} ({i + 1}/{n})")
        v["meta"] = media.probe(v["path"])
        v["duration"] = v["meta"]["duration"]
        key = _file_key(v["path"])
        cache_f = config.CACHE / f"{key}-v2.json"  # v2: adds swing lift (slice detection)
        if cache_f.exists():
            analyses[v["id"]] = json.loads(cache_f.read_text())
            continue
        if not v["meta"].get("has_audio"):
            analyses[v["id"]] = {"onsets": []}
            continue
        wav = config.CACHE / f"{key}.wav"
        written += [wav, cache_f]
        media.extract_audio(v["path"], wav, config.ANALYSIS_SR)
        progress(base + 0.05 * span, f"Finding shots in {v['name']} ({i + 1}/{n})")
        res = shots_mod.analyze_video(
            v["path"], str(wav), v["meta"],
            progress=lambda f, b=base: progress(b + span * (0.05 + 0.95 * f), f"Finding shots in {v['name']} ({i + 1}/{n})"))
        wav.unlink(missing_ok=True)
        progress()
        cache_f.write_text(json.dumps(res))
        analyses[v["id"]] = res

    progress(0.71, "Labeling shots")
    prefs = learning.load()
    events = shots_mod.classify_session(p["videos"], analyses, p["handed"], prefs.get("label_examples", []))
    mine = [e for e in events if e["player"] == "me"]
    shots_mod.quality_components(mine)
    weights = learning.profile(None)["quality_weights"]
    shots = []
    for i, e in enumerate(mine):
        sid = f"s{i}"
        e["shot_id"] = sid
        feats = {k: e.get(k) for k in ("side", "side_both", "overhead", "depth_ratio", "forward", "swing",
                                       "near_speed", "loud_pct", "sharp", "rise", "lift")}
        shots.append({
            "id": sid, "video_id": e["video_id"], "t": round(e["t"], 4), "type": e["type"],
            "auto_type": e["auto_type"], "components": e["components"], "features": feats,
            "quality": shots_mod.score(e["components"], weights), "stars": 3, "user_stars": None,
            "hidden": False, "label_source": "auto",
        })
    mark_suspects(shots)
    for s in shots:
        if s.get("suspect"):
            s["quality"] *= SUSPECT_PENALTY
    for s, st in zip(shots, shots_mod.stars_from_quality([s["quality"] for s in shots])):
        s["stars"] = st
    videos = {v["id"]: v for v in p["videos"]}
    rallies = rallies_mod.build_rallies(events, videos)
    by_id = {s["id"]: s for s in shots}
    # Serves: an overhead that starts a rally, or that has no hit in the 4 s before it.
    for r in rallies:
        h0 = r["hits"][0]
        if h0["player"] == "me" and h0.get("shot_id") and by_id[h0["shot_id"]]["type"] == "overhead":
            by_id[h0["shot_id"]]["type"] = "serve"
        for h in r["hits"]:
            if h.get("shot_id"):
                by_id[h["shot_id"]]["rally_id"] = r["id"]
    ev_times: dict[str, list[float]] = {}
    for e in events:
        ev_times.setdefault(e["video_id"], []).append(e["t"])
    for s in shots:
        if s["type"] == "overhead":
            prior = [t for t in ev_times.get(s["video_id"], []) if s["t"] - 4 < t < s["t"] - 0.3]
            if not prior:
                s["type"] = "serve"
    rallies_mod.score_rallies(rallies, {s["id"]: s["quality"] for s in shots})

    # Only the best shots of each kind (and the best rallies) get previews now; the rest are parked.
    for s in shots:
        s["parked"] = True
    for r in rallies:
        r["parked"] = True
    counts = clean_counts(p.get("preview_counts"))
    picked_s: list[dict] = []
    for g in config.INITIAL_SHOTS:
        picked_s += next_best(shots, g, counts[g])
    picked_r = sorted(rallies, key=lambda r: -r["score"])[:counts["rally"]]
    progress(0.72, f"Preparing previews for the best {len(picked_s)} of {len(shots)} shots")
    make_previews(pid, videos, picked_s, picked_r, progress, 0.72, 0.99)
    for x in picked_s + picked_r:
        x["parked"] = False

    with lock(pid):
        progress()  # last chance to stop before the results are saved
        p = load(pid)
        p["videos"] = [{**v, "meta": videos[v["id"]]["meta"], "duration": videos[v["id"]]["duration"]}
                       for v in p["videos"]]
        p["shots"], p["rallies"] = shots, rallies
        p["status"] = "ready"
        p["stats"] = {
            "videos": n, "shots": len(shots), "opponent_hits": len([e for e in events if e["player"] == "opp"]),
            "rallies": len(rallies), "pose_used": any(e.get("near_present", 0) > 0 for e in events),
        }
        save(p)
    return p["stats"]


SUSPECT_PENALTY = 0.2


def mark_suspects(shots: list[dict]) -> None:
    """Flag shots that look like ones the user said weren't real (no contact, not me). Shots the user
    has rated, relabelled or kept are never flagged."""
    f = learning.suspect_model()
    for s in shots:
        touched = s.get("user_stars") or s.get("label_source") == "user" or s.get("user_kept")
        s["suspect"] = bool(f and not touched and f(s.get("features") or {}))


def refresh_quality(p: dict, weights: dict) -> None:
    for s in p["shots"]:
        auto = shots_mod.score(s["components"], weights) * (SUSPECT_PENALTY if s.get("suspect") else 1)
        s["auto_quality"] = auto
        s["quality"] = 0.3 * auto + 0.7 * (s["user_stars"] - 1) / 4 if s.get("user_stars") else auto
    auto_stars = shots_mod.stars_from_quality([s["auto_quality"] for s in p["shots"]])
    for s, st in zip(p["shots"], auto_stars):
        s["stars"] = s["user_stars"] or st
    rallies_mod.score_rallies(p["rallies"], {s["id"]: s["quality"] for s in p["shots"]})
