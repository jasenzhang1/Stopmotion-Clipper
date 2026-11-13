"""HTTP API + static frontend. Run: python -m backend.app"""
from __future__ import annotations

import os
import string
import time
import uuid
from copy import deepcopy
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import chat as chat_mod, config, draft, learning, music as music_mod, project as proj, render
from . import media, shots as shots_mod

app = FastAPI(title="Stopmotion Clipper")


def _get(pid: str) -> dict:
    try:
        return proj.load(pid)
    except KeyError:
        raise HTTPException(404, "Project not found")


# ---------------------------------------------------------------- undo / saved versions
# Undo covers the editor: the timeline, each shot's footage slide (nudge) and the mood. History lives in
# memory per project (it resets when the app restarts); saved versions are stored in the project file.

_HIST: dict[str, dict] = {}
UNDO_LIMIT = 100


def _snap(p: dict) -> dict:
    return {"timeline": deepcopy(p.get("timeline")), "mood": p.get("mood"),
            "nudges": {s["id"]: s["nudge"] for s in p["shots"] if s.get("nudge")}}


def _hist(pid: str) -> dict:
    return _HIST.setdefault(pid, {"undo": [], "redo": [], "kind": None, "t": 0.0})


def _record(p: dict, before: dict, kind: str | None = None) -> None:
    """Remember the state before a change. Quick repeats of the same `kind` (e.g. one slip drag that sends
    many updates) count as one step."""
    if before.get("timeline") is None:
        return
    h, now = _hist(p["id"]), time.time()
    if not (kind and h["kind"] == kind and now - h["t"] < 1.5):
        h["undo"] = (h["undo"] + [before])[-UNDO_LIMIT:]
    h["redo"], h["kind"], h["t"] = [], kind, now


def _restore(p: dict, snap: dict) -> None:
    p["timeline"], p["mood"] = deepcopy(snap["timeline"]), snap.get("mood")
    for s in p["shots"]:
        if snap["nudges"].get(s["id"]):
            s["nudge"] = snap["nudges"][s["id"]]
        else:
            s.pop("nudge", None)
    if p["timeline"]:
        p["timeline"] = draft.recompute(p["timeline"], p)


def _state(p: dict) -> dict:
    h = _hist(p["id"])
    return {"timeline": p.get("timeline"), "mood": p.get("mood"),
            "nudges": {s["id"]: s.get("nudge") for s in p["shots"]},
            "can_undo": bool(h["undo"]), "can_redo": bool(h["redo"]), "versions": _versions(p)}


def _versions(p: dict) -> list[dict]:
    return [{"id": v["id"], "name": v["name"], "time": v["time"]} for v in p.get("versions", [])]


def _public(p: dict) -> dict:
    """Project without bulky internals the UI doesn't need."""
    out = {k: v for k, v in p.items() if k not in ("first_draft", "versions")}
    out["versions"] = _versions(p)
    h = _hist(p["id"])
    out["can_undo"], out["can_redo"] = bool(h["undo"]), bool(h["redo"])
    out["videos"] = [{"id": v["id"], "name": v["name"], "duration": v.get("duration"),
                      "hdr": (v.get("meta") or {}).get("hdr")} for v in p["videos"]]
    out["shots"] = [{k: s.get(k) for k in ("id", "video_id", "t", "type", "auto_type", "quality", "stars",
                                           "user_stars", "hidden", "proxy", "thumb", "rally_id", "components",
                                           "label_source", "nudge", "suspect", "rejected", "serve_marks")} for s in p["shots"] if not s.get("parked")]
    names = draft.ensure_names(p, p.get("timeline"))
    for s in out["shots"]:
        s["name"] = names.get(s["id"])
    out["rallies"] = [r for r in p.get("rallies", []) if not r.get("parked")]
    out["pool"] = proj.pool_counts(p)
    flags = draft.serve_flags(p) if p.get("shots") else {}
    for s in out["shots"]:
        s["serve"] = flags.get(s["id"])
    return out


# ---------------------------------------------------------------- filesystem browsing

@app.get("/api/fs/roots")
def fs_roots():
    home = Path.home()
    letters = [L for L in string.ascii_uppercase if os.path.exists(f"{L}:\\")]
    # Google Drive for Desktop mounts a virtual drive (G: by default, but any letter) containing "My Drive".
    gdrive = [Path(f"{L}:/My Drive") for L in letters] + [home / "Google Drive", home / "My Drive"]
    cands = [("Google Drive", p) for p in gdrive]
    cands += [("iCloud Drive", home / "iCloudDrive"), ("iCloud Photos", home / "Pictures" / "iCloud Photos"),
              ("OneDrive", home / "OneDrive"), ("Videos", home / "Videos"), ("Music", home / "Music"),
              ("Downloads", home / "Downloads"), ("Desktop", home / "Desktop"), ("Home", home)]
    roots = [{"name": n, "path": str(p)} for n, p in cands if p.exists()]
    roots += [{"name": f"{L}:", "path": f"{L}:\\"} for L in letters]
    return roots


@app.get("/api/fs/list")
def fs_list(path: str):
    p = Path(path)
    if not p.is_dir():
        raise HTTPException(400, "Not a folder")
    entries = []
    try:
        for c in sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
            if c.name.startswith(".") or c.name.startswith("$"):
                continue
            try:
                is_dir = c.is_dir()
            except OSError:
                continue
            ext = c.suffix.lower()
            kind = "dir" if is_dir else "video" if ext in config.VIDEO_EXTS else "audio" if ext in config.AUDIO_EXTS else None
            if kind:
                entries.append({"name": c.name, "path": str(c), "kind": kind})
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    n_videos = sum(1 for e in entries if e["kind"] == "video")
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else None, "entries": entries,
            "n_videos": n_videos}


# ---------------------------------------------------------------- meta

_STARTED = time.time()


def _stale() -> bool:
    """True when the backend's code changed after this server started (run.bat needs to be restarted)."""
    try:
        return max(f.stat().st_mtime for f in Path(__file__).parent.glob("*.py")) > _STARTED + 1
    except Exception:
        return False


@app.get("/api/status")
def status():
    return {"stale": _stale()}


@app.get("/api/meta")
def meta():
    prefs = learning.load()
    return {"moods": config.MOODS, "shot_types": config.SHOT_TYPES, "handed": prefs.get("handed", "right"),
            "preview_defaults": proj.default_counts(),
            "chat_available": bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                                   or (Path.home() / ".config" / "anthropic").exists())}


@app.get("/api/prefs")
def prefs_summary():
    prefs = learning.load()
    return {"profiles": {k: learning.profile(None if k == "_global" else k) for k in prefs["profiles"]},
            "exports_learned": len(prefs["history"]), "label_examples": len(prefs["label_examples"]),
            "star_examples": len(prefs["star_examples"])}


@app.get("/api/jobs/{jid}")
def job(jid: str):
    j = proj.JOBS.get(jid)
    if not j:
        raise HTTPException(404, "No such job")
    return j


# ---------------------------------------------------------------- projects

@app.get("/api/projects")
def projects():
    return proj.list_projects()


@app.post("/api/projects")
def create_project(body: dict = Body(...)):
    try:
        p = proj.create(body.get("name", ""), body["footage_dir"], body["song_path"], body.get("handed", "right"))
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    p["preview_counts"] = proj.clean_counts(body.get("counts"))
    try:
        proj.analyze_song(p)
    except Exception as e:
        raise HTTPException(400, f"Couldn't analyze the song: {e}")
    proj.save(p)
    p["job"] = proj.start_job("analyze", proj.analyze_footage, p["id"])
    proj.save(p)
    return _public(p)


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    p = _get(pid)
    tl = p.get("timeline")
    if tl and any("hit" not in s for b in tl["bars"] for s in b["slots"]):  # saved before clips sat on the grid
        with proj.lock(pid):
            p["timeline"] = draft.recompute(tl, p)
            proj.save(p)
    return _public(p)


@app.patch("/api/projects/{pid}")
def rename_project(pid: str, body: dict = Body(...)):
    p = _get(pid)
    name = str(body.get("name") or "").strip()[:80]
    if not name:
        raise HTTPException(400, "The name can't be empty.")
    with proj.lock(pid):
        p["name"] = name
        proj.save(p)
    return {"name": name}


@app.post("/api/projects/{pid}/step")
def set_step(pid: str, body: dict = Body(...)):
    p = _get(pid)
    if body.get("step") in ("song", "shots", "editor", "rally") and p.get("last_step") != body["step"]:
        with proj.lock(pid):
            p["last_step"] = body["step"]
            proj.save(p)
    return {"ok": True}


@app.post("/api/projects/{pid}/more")
def more_shots(pid: str, body: dict = Body(...)):
    """Load the next-best parked shots of one kind (or rallies): {"group": "forehand", "n": 10}."""
    p = _get(pid)
    group = body.get("group")
    if group not in config.MORE_STEP:
        raise HTTPException(400, f"Unknown group {group!r}")
    if proj.pool_counts(p).get(group, {}).get("more", 0) == 0:
        raise HTTPException(400, "There are no more of those in your footage.")
    n = max(1, min(100, int(body.get("n") or config.MORE_STEP[group])))
    return {"job": proj.start_job("more", proj.load_more, pid, group, n)}


@app.post("/api/projects/{pid}/reanalyze")
def reanalyze(pid: str):
    p = _get(pid)
    p["job"] = proj.start_job("analyze", proj.analyze_footage, pid)
    proj.save(p)
    return {"job": p["job"]}


@app.post("/api/projects/{pid}/stop")
def stop_analysis(pid: str):
    """Stop the running footage analysis and erase everything it has produced so far."""
    p = _get(pid)
    jid = p.get("job")
    if jid and proj.cancel_job(jid):
        return {"job": jid}  # the job erases its own progress as it stops; poll it until "cancelled"
    if p["status"] == "analyzing":  # no live job (e.g. the server restarted mid-analysis): just reset
        proj.reset_analysis(pid)
    return {"job": None}


@app.get("/api/projects/{pid}/song")
def song(pid: str):
    p = _get(pid)
    return FileResponse(p["song"]["path"], media_type="audio/wav")


@app.get("/api/projects/{pid}/files/{rel:path}")
def files(pid: str, rel: str):
    base = proj.pdir(pid).resolve()
    f = (base / rel).resolve()
    if base not in f.parents or not f.is_file():
        raise HTTPException(404, "Not found")
    return FileResponse(f, headers={"Cache-Control": "max-age=3600"})


@app.post("/api/projects/{pid}/section")
def set_section(pid: str, body: dict = Body(...)):
    p = _get(pid)
    with proj.lock(pid):
        m = p["music"]
        start = float(body["start"])
        end = float(body.get("end", start + 64 * m["period"]))
        if "drop" in body and body["drop"] is not None:
            drop = m["beats"][music_mod.beat_index(m, float(body["drop"]))]
        else:
            drop = music_mod.detect_drop(m, start, end)
        if drop - start < 4 * m["period"]:
            raise HTTPException(400, "Leave at least one bar of build-up before the drop.")
        p["section"] = {"start": start, "end": end, "drop": drop, "suggested": False}
        if p.get("timeline") and p["status"] == "ready":
            _regen(p, {}, keep=True, new_seed=False)
        proj.save(p)
    return _public(p)


# ---------------------------------------------------------------- drafts & edits

def _regen(p: dict, overrides: dict, keep: bool, new_seed: bool) -> None:
    prof = learning.profile(p.get("mood"))
    proj.refresh_quality(p, prof["quality_weights"])
    old = p.get("timeline")
    seed = None if new_seed or not old else old.get("seed")
    if old:
        overrides = {"grid": old.get("grid", 8), **overrides}
    p["timeline"] = draft.generate(p, prof, seed=seed, keep=old if keep else None, overrides=overrides)


@app.post("/api/projects/{pid}/draft")
def make_draft(pid: str, body: dict = Body(default={})):
    p = _get(pid)
    if p["status"] != "ready":
        raise HTTPException(409, "Footage analysis isn't finished yet.")
    if not p["shots"]:
        raise HTTPException(409, "No shots were found in this footage.")
    with proj.lock(pid):
        before = _snap(p)
        if "mood" in body:
            p["mood"] = body["mood"]
        fresh = bool(body.get("fresh", True))
        _regen(p, body.get("overrides") or {}, keep=not fresh, new_seed=True)
        if fresh or not p.get("first_draft"):
            p["first_draft"] = deepcopy(p["timeline"])
        _record(p, before)
        proj.save(p)
    return _public(p)


@app.post("/api/projects/{pid}/edit")
def edit(pid: str, body: dict = Body(...)):
    p = _get(pid)
    op, a = body.get("op"), body.get("args", {})
    new_id, new_ids = None, None
    with proj.lock(pid):
        before = _snap(p)
        tl = p.get("timeline")
        if not tl:
            raise HTTPException(409, "Generate a draft first.")
        try:
            if op == "set_slot_shot":
                p["timeline"] = draft.set_slot_shot(tl, p, a["slot_id"], a["shot_id"])
            elif op == "swap_slots":
                p["timeline"] = draft.swap_slots(tl, p, a["a"], a["b"])
            elif op == "set_bar_density":
                p["timeline"] = draft.set_bar_density(tl, p, int(a["k"]), int(a["density"]))
            elif op == "set_hit":
                p["timeline"] = draft.set_hit(tl, p, a["slot_id"], int(a["hit"]))
            elif op == "slide_span":
                p["timeline"], new_id = draft.slide_span(tl, p, a["slot_id"], float(a["start"]))
            elif op == "resize_left":
                p["timeline"], new_id = draft.resize_left(tl, p, a["slot_id"], int(a["pos"]))
            elif op == "resize_slot":
                p["timeline"], new_id = draft.resize_slot(tl, p, a["slot_id"], int(a["len"]))
            elif op == "move_slot":
                p["timeline"], new_id = draft.move_slot(tl, p, a["slot_id"], int(a["k"]), int(a["pos"]))
            elif op == "insert_slot":
                p["timeline"], new_id = draft.insert_slot(tl, p, int(a["k"]), int(a["pos"]), int(a["len"]), a["shot_id"])
            elif op == "delete_slot":
                p["timeline"] = draft.delete_slot(tl, p, a["slot_id"])
            elif op == "set_grid":
                p["timeline"] = draft.set_grid(tl, p, int(a["grid"]))
            elif op == "apply_skeleton":
                p["timeline"] = draft.apply_skeleton(tl, p, str(a["text"]))
            elif op == "set_rally":
                p["timeline"] = draft.set_rally(tl, p, a["rally_id"], a.get("start_hit"))
            elif op in ("unlock_slot", "lock_slot"):
                draft._find_slot(tl, a["slot_id"])["locked"] = op == "lock_slot"
            elif op == "move_slots":
                p["timeline"], new_ids = draft.move_slots(tl, p, list(a["ids"]), int(a["delta"]))
            elif op == "paste_slots":
                p["timeline"], new_ids = draft.paste_slots(tl, p, list(a["items"]), int(a["at"]))
            elif op == "delete_slots":
                p["timeline"] = draft.delete_slots(tl, p, list(a["ids"]))
            elif op == "regenerate":
                _regen(p, a.get("overrides") or {}, keep=a.get("keep", True), new_seed=True)
            else:
                raise HTTPException(400, f"Unknown op {op}")
        except (KeyError, ValueError) as e:
            raise HTTPException(400, str(e))
        _record(p, before)
        proj.save(p)
    return {"timeline": p["timeline"], **({"slot_id": new_id} if new_id else {}),
            **({"slot_ids": new_ids} if new_ids else {})}


@app.post("/api/projects/{pid}/undo")
def undo(pid: str):
    p = _get(pid)
    with proj.lock(pid):
        h = _hist(pid)
        if not h["undo"]:
            raise HTTPException(409, "Nothing to undo.")
        h["redo"].append(_snap(p))
        _restore(p, h["undo"].pop())
        h["kind"] = None
        proj.save(p)
        return _state(p)


@app.post("/api/projects/{pid}/redo")
def redo(pid: str):
    p = _get(pid)
    with proj.lock(pid):
        h = _hist(pid)
        if not h["redo"]:
            raise HTTPException(409, "Nothing to redo.")
        h["undo"].append(_snap(p))
        _restore(p, h["redo"].pop())
        h["kind"] = None
        proj.save(p)
        return _state(p)


@app.post("/api/projects/{pid}/versions")
def save_version(pid: str, body: dict = Body(default={})):
    p = _get(pid)
    if not p.get("timeline"):
        raise HTTPException(409, "Nothing to save yet.")
    with proj.lock(pid):
        vs = p.setdefault("versions", [])
        name = str(body.get("name") or "").strip()[:60] or f"Version {len(vs) + 1}"
        vs.append({"id": uuid.uuid4().hex[:8], "name": name, "time": time.time(), **_snap(p)})
        proj.save(p)
        return _state(p)


@app.post("/api/projects/{pid}/versions/{vid}/restore")
def restore_version(pid: str, vid: str):
    p = _get(pid)
    with proj.lock(pid):
        v = next((v for v in p.get("versions", []) if v["id"] == vid), None)
        if not v:
            raise HTTPException(404, "No such version")
        _record(p, _snap(p))  # restoring can itself be undone
        _restore(p, v)
        proj.save(p)
        return _state(p)


@app.delete("/api/projects/{pid}/versions/{vid}")
def delete_version(pid: str, vid: str):
    p = _get(pid)
    with proj.lock(pid):
        p["versions"] = [v for v in p.get("versions", []) if v["id"] != vid]
        proj.save(p)
        return _state(p)


# ---------------------------------------------------------------- rally curation ("strands")
# A strand is every contact in one video, in order: my shots (named, graded) and my partner's hits.
# You can add contacts the app missed or remove wrong ones; a stretch of it becomes the drop rally.

POINT_GAP = 5.5  # seconds without a hit = the point is over


def _strand(p: dict, video_id: str) -> list[dict]:
    names = draft.ensure_names(p, p.get("timeline"))
    edits = (p.get("strand_edits") or {}).get(video_id) or {}
    removed = edits.get("remove") or []
    gone = lambda t: any(abs(t - r) < 0.05 for r in removed)
    hits = []
    for s in p["shots"]:
        if s["video_id"] != video_id:
            continue
        t = s["t"] + (s.get("nudge") or 0)
        if not gone(t):
            hits.append({"t": round(t, 4), "player": "me", "shot_id": s["id"], "name": names.get(s["id"]),
                         "type": s["type"], "stars": s.get("stars"), "hidden": bool(s.get("hidden"))})
    for r in p.get("rallies", []):
        if r["video_id"] != video_id or r.get("custom"):
            continue
        for h in r["hits"]:
            if h["player"] == "opp" and not gone(h["t"]) and not any(abs(h["t"] - x["t"]) < 0.3 for x in hits):
                hits.append({"t": round(h["t"], 4), "player": "opp", "inferred": bool(h.get("inferred"))})
    for a in edits.get("add") or []:
        if not gone(a["t"]):
            hits.append({"t": round(a["t"], 4), "player": a["player"], "user": True})
    return sorted(hits, key=lambda h: h["t"])


@app.get("/api/projects/{pid}/strand")
def strand(pid: str, shot: str):
    p = _get(pid)
    s = next((s for s in p["shots"] if s["id"] == shot), None)
    if not s:
        raise HTTPException(404, "No such shot")
    v = next(v for v in p["videos"] if v["id"] == s["video_id"])
    return {"video_id": v["id"], "video": v["name"], "hits": _strand(p, v["id"]), "point_gap": POINT_GAP}


@app.post("/api/projects/{pid}/strand/edit")
def strand_edit(pid: str, body: dict = Body(...)):
    """{"video_id", "add": {"t", "player": "me"|"opp"}} or {"video_id", "remove": t}."""
    p = _get(pid)
    vid = body["video_id"]
    with proj.lock(pid):
        e = p.setdefault("strand_edits", {}).setdefault(vid, {"add": [], "remove": []})
        if body.get("add"):
            a = body["add"]
            t = float(a["t"])
            e["remove"] = [r for r in e["remove"] if abs(r - t) >= 0.05]
            e["add"].append({"t": round(t, 4), "player": "opp" if a.get("player") == "opp" else "me"})
        if body.get("remove") is not None:
            t = float(body["remove"])
            before = len(e["add"])
            e["add"] = [a for a in e["add"] if abs(a["t"] - t) >= 0.05]
            if len(e["add"]) == before:  # a detected hit: remember to leave it out
                e["remove"].append(round(t, 4))
        proj.save(p)
    return {"hits": _strand(p, vid)}


@app.post("/api/projects/{pid}/strand/preview")
def strand_preview(pid: str, body: dict = Body(...)):
    """A playable clip of the strand from t0 to t1 (with a little before and after)."""
    p = _get(pid)
    v = next((v for v in p["videos"] if v["id"] == body["video_id"]), None)
    if not v:
        raise HTTPException(404, "No such video")
    a = max(0.0, float(body["t0"]) - 1.0)
    b = min(v["duration"], float(body["t1"]) + 1.5)
    rel = f"proxies/strand_{v['id']}_{int(a * 1000)}_{int(b * 1000)}.mp4"
    out = proj.pdir(pid) / rel
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        media.make_proxy(v["path"], a, b - a, out, v["meta"], config.PROXY_HEIGHT, config.PROXY_FPS)
    return {"file": rel, "start": a, "end": b}


@app.post("/api/projects/{pid}/rally_clip")
def rally_clip(pid: str, body: dict = Body(...)):
    """Make the strand from t0 to t1 (first and last contact) the drop rally."""
    p = _get(pid)
    vid = body["video_id"]
    t0, t1 = float(body["t0"]), float(body["t1"])
    hits = [h for h in _strand(p, vid) if t0 - 0.01 <= h["t"] <= t1 + 0.01]
    if len(hits) < 2:
        raise HTTPException(400, "A rally needs at least two contacts.")
    v = next(v for v in p["videos"] if v["id"] == vid)
    with proj.lock(pid):
        r = {"id": f"c{sum(1 for x in p.get('rallies', []) if x.get('custom')) + 1}", "custom": True, "video_id": vid,
             "hits": [{"t": h["t"], "player": h["player"], "shot_id": h.get("shot_id"), "inferred": False} for h in hits],
             "start": hits[0]["t"], "point_end": min(v["duration"], hits[-1]["t"] + 0.8), "best_start": 0,
             "n_hits": len(hits), "parked": False}
        r["duration"] = round(r["point_end"] - r["start"], 2)
        q = {s["id"]: s["quality"] for s in p["shots"]}
        mine = [q[h["shot_id"]] for h in hits if h.get("shot_id") in q]
        r["score"] = round(sum(mine) / max(1, len(mine)), 4)
        a = max(0.0, r["start"] - 0.6)
        b = min(v["duration"], r["point_end"] + 1.5)
        rel = f"proxies/{r['id']}_{int(a * 1000)}_{int(b * 1000)}.mp4"
        if not (proj.pdir(pid) / rel).exists():
            media.make_proxy(v["path"], a, b - a, proj.pdir(pid) / rel, v["meta"], config.PROXY_HEIGHT, config.PROXY_FPS)
        r["proxy"] = {"file": rel, "start": a}
        p.setdefault("rallies", []).append(r)
        if p.get("timeline"):
            before = _snap(p)
            p["timeline"] = draft.set_rally(p["timeline"], p, r["id"], 0)
            _record(p, before)
        proj.save(p)
    return _public(p)


@app.post("/api/projects/{pid}/shots/{sid}/serve_marks")
def serve_marks(pid: str, sid: str, body: dict = Body(default={})):
    """Serves: when the ball is tossed and when it tops out (source seconds).
    {"detect": true} estimates them from the footage; {"toss": t} / {"apex": t} sets them by hand."""
    p = _get(pid)
    s = next((s for s in p["shots"] if s["id"] == sid), None)
    if not s:
        raise HTTPException(404, "No such shot")
    marks = None
    if body.get("detect"):
        v = next(v for v in p["videos"] if v["id"] == s["video_id"])
        try:
            marks = shots_mod.serve_marks(v["path"], v["meta"], s["t"] + (s.get("nudge") or 0))
        except Exception as e:
            raise HTTPException(500, f"Couldn't analyze the serve: {e}")
    with proj.lock(pid):
        if body.get("detect"):
            s["serve_marks"] = {**(marks or {}), "source": "auto", "for": round(s["t"] + (s.get("nudge") or 0), 3)}
        for k in ("toss", "apex"):
            if body.get(k) is not None:
                s.setdefault("serve_marks", {})[k] = round(float(body[k]), 4)
                s["serve_marks"]["source"] = "user"
        m = s.get("serve_marks") or {}
        if m.get("toss") is not None:  # the preview clip has to reach back to the toss
            proj.ensure_proxy(p, s, m["toss"] - 0.5, proj.proxy_end(s))
        proj.save(p)
        return {"serve_marks": s.get("serve_marks"), "proxy": s.get("proxy"), "timeline": p.get("timeline")}


@app.post("/api/projects/{pid}/shots/{sid}/window")
def shot_window(pid: str, sid: str, body: dict = Body(...)):
    """See more of a shot: make its preview clip run `after` seconds past the contact (max 12)."""
    p = _get(pid)
    with proj.lock(pid):
        s = next((s for s in p["shots"] if s["id"] == sid), None)
        if not s:
            raise HTTPException(404, "No such shot")
        c = s["t"] + (s.get("nudge") or 0)
        after = max(1.0, min(12.0, float(body.get("after") or 2)))
        before = max(0.5, min(5.0, float(body.get("before") or 1)))
        if proj.ensure_proxy(p, s, c - before, c + after):
            if p.get("timeline"):
                p["timeline"] = draft.recompute(p["timeline"], p)
            proj.save(p)
        return {"proxy": s["proxy"], "timeline": p.get("timeline")}


@app.post("/api/projects/{pid}/nudges")
def nudges(pid: str, body: dict = Body(...)):
    """Slide several shots' footage at once: {"nudges": {shot_id: seconds}}."""
    p = _get(pid)
    with proj.lock(pid):
        _record(p, _snap(p), "nudge:" + ",".join(sorted(body.get("nudges") or {})))
        by_id = {s["id"]: s for s in p["shots"]}
        for sid, v in (body.get("nudges") or {}).items():
            if sid in by_id:
                by_id[sid]["nudge"] = _clamp_nudge(p, by_id[sid], float(v or 0))
        if p.get("timeline"):
            p["timeline"] = draft.recompute(p["timeline"], p)
        proj.save(p)
        return {"shots": [{"id": sid, "nudge": by_id[sid].get("nudge")} for sid in body.get("nudges") or {} if sid in by_id],
                "timeline": p.get("timeline")}


@app.patch("/api/projects/{pid}/shots/{sid}")
def patch_shot(pid: str, sid: str, body: dict = Body(...)):
    p = _get(pid)
    with proj.lock(pid):
        s = next((s for s in p["shots"] if s["id"] == sid), None)
        if not s:
            raise HTTPException(404, "No such shot")
        if "type" in body and body["type"] in config.SHOT_TYPES:
            s["type"], s["label_source"] = body["type"], "user"
            learning.add_label_example(s["features"], body["type"])
            if body["type"] != "unknown":
                learning.add_accept_example(s["features"])
        if "stars" in body:
            st = int(body["stars"])
            s["user_stars"] = s["stars"] = st
            s["quality"] = 0.3 * s.get("auto_quality", s["quality"]) + 0.7 * (st - 1) / 4
            learning.add_star_example(s["components"], st)
            if st >= 3:
                learning.add_accept_example(s["features"])
        if "hidden" in body:
            s["hidden"] = bool(body["hidden"])
            if not s["hidden"] and (s.get("rejected") or s.get("suspect")):
                s["rejected"], s["suspect"], s["user_kept"] = None, False, True
                learning.add_accept_example(s["features"])
        relearn = False
        c = body.get("complaint")
        if c and c.get("reason") in config.COMPLAINT_REASONS:
            reason, note = c["reason"], str(c.get("note") or "")[:500]
            learning.add_complaint(s, reason, note)
            s.setdefault("complaints", []).append(reason)
            if reason in config.REJECT_REASONS:
                s["hidden"], s["rejected"] = True, reason
                relearn = True
            elif reason in config.RANK_REASONS or reason == "underrated":
                st = max(1, min(5, s["stars"] + (1 if reason == "underrated" else -1)))
                s["user_stars"] = s["stars"] = st
                s["quality"] = 0.3 * s.get("auto_quality", s["quality"]) + 0.7 * (st - 1) / 4
                learning.add_star_example(s["components"], st)
                learning.add_accept_example(s["features"])
                relearn = reason != "underrated"
        if relearn:  # re-score the rest of this project with what was just learned
            proj.mark_suspects(p["shots"])
            proj.refresh_quality(p, learning.profile(None)["quality_weights"])
        if "serve_in" in body:  # true / false, or null to go back to auto-detection
            s["user_serve_in"] = None if body["serve_in"] is None else bool(body["serve_in"])
        if "nudge" in body:  # seconds; where the ball contact is, relative to the detected hit
            _record(p, _snap(p), f"nudge:{sid}")
            _cover_contact(p, s, float(body["nudge"] or 0))
            s["nudge"] = _clamp_nudge(p, s, float(body["nudge"] or 0))
        if p.get("timeline"):
            p["timeline"] = draft.recompute(p["timeline"], p)
        proj.save(p)
        out = {k: s.get(k) for k in ("id", "type", "stars", "user_stars", "hidden", "quality", "label_source", "nudge",
                                     "suspect", "rejected", "proxy")}
        names = draft.ensure_names(p, p.get("timeline"))
        out["name"] = names.get(sid)
        out["names"] = {x["id"]: names[x["id"]] for x in p["shots"] if not x.get("parked")}  # ranks may shift
        if relearn:
            out["all"] = [{k: x.get(k) for k in ("id", "stars", "quality", "suspect")} for x in p["shots"]]
        out["serve"] = draft.serve_flags(p).get(sid)
        if p.get("timeline"):
            out["timeline"] = p["timeline"]
        return out


def _clamp_nudge(p: dict, s: dict, v: float) -> float:
    """The contact can be anywhere in the shot's preview clip."""
    lo, hi = s["proxy"]["start"] - s["t"], proj.proxy_end(s) - s["t"]
    return round(max(lo, min(hi, v)), 4)


def _cover_contact(p: dict, s: dict, nudge: float) -> None:
    """A contact near the edge of the preview clip: re-cut it so a clip around the contact still fits."""
    c = s["t"] + nudge
    proj.ensure_proxy(p, s, c - 1.0, c + config.SHOT_PROXY_WINDOW[1])


@app.post("/api/projects/{pid}/chat")
def chat(pid: str, body: dict = Body(...)):
    p = _get(pid)
    if not p.get("timeline"):
        raise HTTPException(409, "Generate a draft first.")
    with proj.lock(pid):
        before = _snap(p)
        reply = chat_mod.chat(p, body["message"], lambda ov, keep, new: _regen(p, ov, keep, new))
        if before["timeline"] != p.get("timeline"):
            _record(p, before)
        proj.save(p)
    return {"reply": reply, "timeline": p["timeline"], "chat": p["chat"],
            "shots": _public(p)["shots"]}


# ---------------------------------------------------------------- export

def _do_export(pid: str, settings: dict, progress) -> dict:
    p = proj.load(pid)
    tl = deepcopy(p["timeline"])
    eid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    rel = f"exports/{eid}.mp4"
    info = render.export(p, tl, proj.pdir(pid) / rel, settings.get("resolution", "source"),
                         bool(settings.get("hdr")), progress)
    with proj.lock(pid):
        p = proj.load(pid)
        exp = {"id": eid, "file": rel, "time": time.time(), "settings": settings, "info": info,
               "timeline": tl, "draft": p.get("first_draft"), "moods": [], "rating": None, "learned": False}
        p["exports"].append(exp)
        proj.save(p)
    return {"id": eid, "file": rel, **info}


@app.post("/api/projects/{pid}/export")
def export(pid: str, body: dict = Body(default={})):
    p = _get(pid)
    if not p.get("timeline"):
        raise HTTPException(409, "Generate a draft first.")
    return {"job": proj.start_job("export", _do_export, pid, body)}


@app.post("/api/projects/{pid}/exports/{eid}/feedback")
def export_feedback(pid: str, eid: str, body: dict = Body(...)):
    p = _get(pid)
    with proj.lock(pid):
        exp = next((e for e in p["exports"] if e["id"] == eid), None)
        if not exp:
            raise HTTPException(404, "No such export")
        exp["moods"] = [m for m in body.get("moods", []) if m in config.MOODS]
        exp["rating"] = body.get("rating")
        if not exp["learned"] and exp.get("draft"):
            shots = {s["id"]: s for s in p["shots"]}
            learning.learn_from_export(exp["draft"], exp["timeline"], shots, exp["moods"], exp["rating"], pid)
            exp["learned"] = True
        if exp["moods"]:
            p["mood"] = exp["moods"][0]
        proj.save(p)
    return {"ok": True}


# ---------------------------------------------------------------- frontend

if config.FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full:path}")
    def spa(full: str):
        f = config.FRONTEND_DIST / full
        if full and f.is_file():
            return FileResponse(f)
        return FileResponse(config.FRONTEND_DIST / "index.html")


def main():
    import uvicorn
    port = int(os.environ.get("CLIPPER_PORT", "8765"))
    url = f"http://localhost:{port}"
    print(f"Stopmotion Clipper running at {url} (keep this window open)")
    if os.environ.get("CLIPPER_OPEN_BROWSER"):
        @app.on_event("startup")
        async def _open_browser():  # open only once the server is actually listening
            import threading
            import webbrowser
            threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
