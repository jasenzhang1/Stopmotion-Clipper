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

app = FastAPI(title="Stopmotion Clipper")


def _get(pid: str) -> dict:
    try:
        return proj.load(pid)
    except KeyError:
        raise HTTPException(404, "Project not found")


def _public(p: dict) -> dict:
    """Project without bulky internals the UI doesn't need."""
    out = {k: v for k, v in p.items() if k not in ("first_draft",)}
    out["videos"] = [{"id": v["id"], "name": v["name"], "duration": v.get("duration"),
                      "hdr": (v.get("meta") or {}).get("hdr")} for v in p["videos"]]
    out["shots"] = [{k: s.get(k) for k in ("id", "video_id", "t", "type", "auto_type", "quality", "stars",
                                           "user_stars", "hidden", "proxy", "thumb", "rally_id", "components",
                                           "label_source", "nudge", "suspect", "rejected")} for s in p["shots"] if not s.get("parked")]
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
    return _public(_get(pid))


@app.post("/api/projects/{pid}/step")
def set_step(pid: str, body: dict = Body(...)):
    p = _get(pid)
    if body.get("step") in ("song", "shots", "editor") and p.get("last_step") != body["step"]:
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
        if "mood" in body:
            p["mood"] = body["mood"]
        fresh = bool(body.get("fresh", True))
        _regen(p, body.get("overrides") or {}, keep=not fresh, new_seed=True)
        if fresh or not p.get("first_draft"):
            p["first_draft"] = deepcopy(p["timeline"])
        proj.save(p)
    return _public(p)


@app.post("/api/projects/{pid}/edit")
def edit(pid: str, body: dict = Body(...)):
    p = _get(pid)
    op, a = body.get("op"), body.get("args", {})
    new_id = None
    with proj.lock(pid):
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
            elif op == "unlock_slot":
                draft._find_slot(tl, a["slot_id"])["locked"] = False
            elif op == "regenerate":
                _regen(p, a.get("overrides") or {}, keep=a.get("keep", True), new_seed=True)
            else:
                raise HTTPException(400, f"Unknown op {op}")
        except (KeyError, ValueError) as e:
            raise HTTPException(400, str(e))
        proj.save(p)
    return {"timeline": p["timeline"], **({"slot_id": new_id} if new_id else {})}


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
        if "nudge" in body:  # seconds; slides the footage shown around the detected contact
            s["nudge"] = round(max(-NUDGE_MAX, min(NUDGE_MAX, float(body["nudge"] or 0))), 4)
        if p.get("timeline"):
            p["timeline"] = draft.recompute(p["timeline"], p)
        proj.save(p)
        out = {k: s.get(k) for k in ("id", "type", "stars", "user_stars", "hidden", "quality", "label_source", "nudge",
                                     "suspect", "rejected")}
        if relearn:
            out["all"] = [{k: x.get(k) for k in ("id", "stars", "quality", "suspect")} for x in p["shots"]]
        out["serve"] = draft.serve_flags(p).get(sid)
        if p.get("timeline"):
            out["timeline"] = p["timeline"]
        return out


NUDGE_MAX = 0.75


@app.post("/api/projects/{pid}/chat")
def chat(pid: str, body: dict = Body(...)):
    p = _get(pid)
    if not p.get("timeline"):
        raise HTTPException(409, "Generate a draft first.")
    with proj.lock(pid):
        reply = chat_mod.chat(p, body["message"], lambda ov, keep, new: _regen(p, ov, keep, new))
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
