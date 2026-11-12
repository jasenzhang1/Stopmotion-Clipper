"""Paths and global settings."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("CLIPPER_DATA", ROOT / "data"))
PROJECTS = DATA / "projects"
CACHE = DATA / "cache"
MODELS = DATA / "models"
PREFS_FILE = DATA / "prefs.json"
FRONTEND_DIST = ROOT / "frontend" / "dist"

for _d in (DATA, PROJECTS, CACHE, MODELS):
    _d.mkdir(parents=True, exist_ok=True)

VIDEO_EXTS = {".mov", ".mp4", ".m4v", ".mkv", ".avi"}
AUDIO_EXTS = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".aiff", ".aif"}

MOODS = ["Hype", "Chill", "Aggressive", "Playful", "Cinematic"]

# Shot types (display codes in the UI).
SHOT_TYPES = {
    "forehand": "FH",
    "backhand": "BH",
    "fh_slice": "FHS",
    "bh_slice": "BHS",
    "fh_volley": "FHV",
    "bh_volley": "BHV",
    "approach": "APP",
    "serve": "SRV",
    "overhead": "OH",
    "unknown": "?",
}

# Why a shot is wrong, as reported by the user.
REJECT_REASONS = {"no_contact", "not_me"}            # not a real shot of mine
RANK_REASONS = {                                     # real shot, rated too high; quality parts it should weigh more
    "out_of_frame": ["clarity"], "blurry": ["clarity"], "too_far": ["proximity"],
    "weak_swing": ["swing", "speed"], "mishit": ["contact"], "overrated": [],
}
COMPLAINT_REASONS = REJECT_REASONS | set(RANK_REASONS) | {"wrong_stroke", "underrated", "other"}

CLAUDE_MODEL = "claude-opus-5-5"

# Analysis parameters
ANALYSIS_SR = 22050
POSE_FPS = 20
POSE_HEIGHT = 640
POSE_IMGSZ = 384  # model input size; as accurate as 640 here, ~3x faster
POSE_WINDOW = (-0.6, 0.4)  # seconds around each audio onset (backswing .. follow-through)
PROXY_HEIGHT = 960
PROXY_FPS = 30
SHOT_PROXY_WINDOW = (-1.0, 2.0)  # long enough for a whole-bar clip

# Previews are the slow part of analysis, so only the best shots of each kind get one at first; the rest are
# "parked" (known, ranked, but not shown or used) until the user asks for more.
INITIAL_SHOTS = {"forehand": 30, "backhand": 30, "serve": 10, "volley": 6, "approach": 4, "unknown": 0}
INITIAL_RALLIES = 12
MORE_STEP = {"forehand": 10, "backhand": 10, "serve": 5, "volley": 5, "approach": 5, "unknown": 10, "rally": 6}
