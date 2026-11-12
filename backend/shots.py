"""Shot detection.

1. Audio: ball strikes are sharp, high-frequency transients -> candidate hit times (exact contact).
2. Pose: YOLO pose on short frame windows around each candidate. The near player (me) is the
   biggest person in the lower part of the frame; the opponent is on the far side.
3. A candidate is *my* shot when my wrist speed peaks at the sound; the opponent's when theirs does.
4. Per-shot features drive the type classification and quality score.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt

from . import config, media

HOP = 128

# COCO keypoint indices
NOSE, L_SH, R_SH, L_WR, R_WR, L_HIP, R_HIP, L_ANK, R_ANK = 0, 5, 6, 9, 10, 11, 12, 15, 16


# ---------------------------------------------------------------- audio onsets

def detect_onsets(wav_path: str) -> list[dict]:
    y, sr = sf.read(wav_path, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    sos = butter(4, [1500, min(9000, sr / 2 - 100)], btype="band", fs=sr, output="sos")
    yf = sosfiltfilt(sos, y)
    # High-band energy envelope and its positive derivative (spectral-flux-like)
    n = len(yf) // HOP
    frames = yf[: n * HOP].reshape(n, HOP)
    env = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
    log_env = 20 * np.log10(env + 1e-6)
    flux = np.maximum(0.0, np.diff(log_env, prepend=log_env[0]))
    # Smooth slightly
    k = np.array([0.25, 0.5, 0.25])
    flux = np.convolve(flux, k, mode="same")
    med = np.median(flux)
    mad = np.median(np.abs(flux - med)) + 1e-6
    thr = med + 6 * mad
    fps = sr / HOP
    wait = int(0.18 * fps)
    onsets: list[dict] = []
    last = -wait
    win = int(0.04 * fps)
    for i in range(1, n - 1):
        if flux[i] < thr or flux[i] < flux[i - 1] or flux[i] < flux[i + 1]:
            continue
        lo, hi = max(0, i - win), min(n, i + win)
        if flux[i] < flux[lo:hi].max():
            continue
        if i - last < wait:
            if onsets and flux[i] > onsets[-1]["flux"]:
                onsets.pop()
            else:
                continue
        last = i
        # Refine to the sample of max amplitude near the onset
        a, b = max(0, (i - 2) * HOP), min(len(yf), (i + 3) * HOP)
        peak_sample = a + int(np.argmax(np.abs(yf[a:b])))
        peak_db = float(log_env[min(n - 1, i + 1)])
        before = float(np.median(log_env[max(0, i - int(0.15 * fps)): max(1, i - 2)]))
        decay = float(log_env[min(n - 1, i + int(0.06 * fps))])
        onsets.append({
            "t": peak_sample / sr,
            "flux": float(flux[i]),
            "loud": peak_db,
            "rise": peak_db - before,  # how far above the background it pops
            "sharp": peak_db - decay,  # fast decay = crisp contact
        })
    return onsets


# ---------------------------------------------------------------- pose model

_model = None
_model_lock = threading.Lock()


def pose_model():
    global _model
    with _model_lock:
        if _model is None:
            from ultralytics import YOLO
            import torch
            weights = config.MODELS / "yolo11n-pose.pt"
            _model = YOLO(str(weights) if weights.exists() else "yolo11n-pose.pt")
            if not weights.exists():
                try:
                    src = getattr(_model, "ckpt_path", None)
                    if src:
                        import shutil
                        shutil.copy(src, weights)
                except Exception:
                    pass
            _model.to("cuda" if torch.cuda.is_available() else "cpu")
        return _model


@dataclass
class Person:
    box: np.ndarray   # x1 y1 x2 y2 (px)
    kp: np.ndarray    # (17, 3) x, y, conf

    @property
    def height(self) -> float:
        return float(self.box[3] - self.box[1])

    @property
    def bottom(self) -> float:
        return float(self.box[3])

    @property
    def cx(self) -> float:
        return float((self.box[0] + self.box[2]) / 2)


def run_pose(frames: np.ndarray) -> list[list[Person]]:
    model = pose_model()
    out: list[list[Person]] = []
    for i in range(0, len(frames), 16):
        batch = [f for f in frames[i:i + 16]]
        results = model(batch, imgsz=config.POSE_IMGSZ, verbose=False, conf=0.25)
        for r in results:
            people = []
            if r.boxes is not None and len(r.boxes):
                boxes = r.boxes.xyxy.cpu().numpy()
                kps = r.keypoints.data.cpu().numpy() if r.keypoints is not None else np.zeros((len(boxes), 17, 3))
                for b, k in zip(boxes, kps):
                    people.append(Person(b, k))
            out.append(people)
    return out


def pick_players(people: list[Person], frame_h: int, prev_near: Person | None) -> tuple[Person | None, Person | None]:
    near_cands = [p for p in people if p.bottom > 0.45 * frame_h and p.height > 0.08 * frame_h]
    near = None
    if near_cands:
        if prev_near is not None:
            near = min(near_cands, key=lambda p: abs(p.cx - prev_near.cx) / frame_h - 0.5 * p.height / frame_h)
        else:
            near = max(near_cands, key=lambda p: p.height)
    far_cands = [p for p in people if p is not near and p.bottom < 0.7 * frame_h]
    far = max(far_cands, key=lambda p: p.height) if far_cands else None
    return near, far


# ---------------------------------------------------------------- per-window features

def _wrists(p: Person) -> np.ndarray:
    return p.kp[[L_WR, R_WR], :]


def _hip_center(p: Person) -> tuple[float, float]:
    hips = p.kp[[L_HIP, R_HIP]]
    ok = hips[:, 2] > 0.3
    if ok.any():
        return float(hips[ok, 0].mean()), float(hips[ok, 1].mean())
    return p.cx, float((p.box[1] + p.box[3]) / 2)


def _wrist_speeds(track: list[Person | None], dt: float) -> tuple[np.ndarray, np.ndarray]:
    """Per-frame max wrist speed (body heights / s) and which wrist (0=L,1=R)."""
    n = len(track)
    speed = np.zeros(n)
    which = np.zeros(n, dtype=int)
    for i in range(1, n):
        a, b = track[i - 1], track[i]
        if a is None or b is None:
            continue
        wa, wb = _wrists(a), _wrists(b)
        h = max(1.0, (a.height + b.height) / 2)
        best = 0.0
        for j in range(2):
            if wa[j, 2] > 0.3 and wb[j, 2] > 0.3:
                s = float(np.hypot(*(wb[j, :2] - wa[j, :2]))) / h / dt
                if s > best:
                    best, which[i] = s, j
        speed[i] = best
    return speed, which


def window_features(onset_t: float, w_start: float, frames_people: list[list[Person]], frame_h: int,
                    fps: int) -> dict:
    """Features for one onset, given pose results for a window starting at w_start."""
    dt = 1.0 / fps
    near_track: list[Person | None] = []
    far_track: list[Person | None] = []
    prev = None
    for people in frames_people:
        near, far = pick_players(people, frame_h, prev)
        near_track.append(near)
        far_track.append(far)
        if near is not None:
            prev = near
    n = len(near_track)
    times = w_start + np.arange(n) * dt
    ci = int(np.clip(round((onset_t - w_start) / dt), 0, max(0, n - 1)))
    contact_mask = (times >= onset_t - 0.2) & (times <= onset_t + 0.12)

    near_speed, near_which = _wrist_speeds(near_track, dt)
    far_speed, _ = _wrist_speeds(far_track, dt)
    feats: dict = {
        "near_present": float(np.mean([p is not None for p in near_track])) if n else 0.0,
        "near_speed": float(near_speed[contact_mask].max()) if contact_mask.any() else 0.0,
        "far_speed": float(far_speed[contact_mask].max()) if contact_mask.any() else 0.0,
        "far_present": float(np.mean([p is not None for p in far_track])) if n else 0.0,
    }
    # Nearest valid near-player frame to contact
    idxs = [i for i in range(n) if near_track[i] is not None]
    if not idxs:
        return feats
    ci_near = min(idxs, key=lambda i: abs(i - ci))
    p = near_track[ci_near]
    h = max(1.0, p.height)
    # Hitting wrist: the faster one around contact
    if contact_mask.any():
        peak_i = int(np.argmax(np.where(contact_mask, near_speed, -1)))
        hit_w = int(near_which[peak_i])
    else:
        hit_w = 1
    # Side: seen from behind, a (right-handed) forehand takes the hitting wrist back on the right and
    # finishes on the left; a backhand is the mirror image. Compare backswing vs follow-through position
    # of (a) the faster "hitting" wrist and (b) whichever wrist is farthest from the hip line.
    # (The pose model often swaps left/right wrists from behind, so we never trust its L/R labels.)
    def side_in(a: float, b: float) -> tuple[float, float]:
        hit_v, far_v = [], []
        for i in range(n):
            q = near_track[i]
            if q is None or not (onset_t + a <= times[i] <= onset_t + b):
                continue
            hx, _ = _hip_center(q)
            w = _wrists(q)
            hq = max(1.0, q.height)
            if w[hit_w, 2] > 0.3:
                hit_v.append((w[hit_w, 0] - hx) / hq)
            ok = w[:, 2] > 0.3
            if ok.any():
                d = w[ok, 0] - hx
                far_v.append(d[np.argmax(np.abs(d))] / hq)
        return (float(np.median(hit_v)) if hit_v else 0.0, float(np.median(far_v)) if far_v else 0.0)

    def wrist_y(a: float, b: float) -> float | None:
        ys = [(_wrists(near_track[i])[hit_w, 1]) / max(1.0, near_track[i].height) for i in range(n)
              if near_track[i] is not None and onset_t + a <= times[i] <= onset_t + b
              and _wrists(near_track[i])[hit_w, 2] > 0.3]
        return float(np.median(ys)) if ys else None

    back_y, follow_y = wrist_y(-0.6, -0.15), wrist_y(0.05, 0.35)
    # Lift: > 0 the racket hand finishes higher than the backswing (topspin), <= 0 high-to-low (slice).
    lift = (back_y - follow_y) if back_y is not None and follow_y is not None else None
    back_hit, back_far = side_in(-0.6, -0.15)
    follow_hit, follow_far = side_in(0.05, 0.35)
    side_score = (back_hit - follow_hit) + 0.5 * (back_far - follow_far)
    # Height of the hitting wrist vs nose at contact
    w = _wrists(p)
    nose = p.kp[NOSE]
    overhead = 0.0
    if w[hit_w, 2] > 0.3 and nose[2] > 0.3:
        overhead = float((nose[1] - w[hit_w, 1]) / h)
    # Wrist path length (swing size) over the window, body heights
    path = 0.0
    for i in range(1, n):
        a, b = near_track[i - 1], near_track[i]
        if a is None or b is None:
            continue
        wa, wb = _wrists(a)[hit_w], _wrists(b)[hit_w]
        if wa[2] > 0.3 and wb[2] > 0.3:
            path += float(np.hypot(*(wb[:2] - wa[:2]))) / max(1.0, (a.height + b.height) / 2)
    # Forward movement: feet moving up the frame (toward the net) over the window
    bottoms = [(times[i], near_track[i].bottom) for i in idxs]
    forward = 0.0
    if len(bottoms) >= 3:
        forward = float((bottoms[0][1] - bottoms[-1][1]) / frame_h)
    feats.update({
        "side": side_score,  # > 0: forehand side for a right-hander
        "side_both": back_hit,
        "follow": follow_hit,
        "overhead": overhead,
        "swing": path,
        "forward": forward,
        "body_h": float(h / frame_h),
        "bottom": float(p.bottom / frame_h),
        "kp_conf": float(p.kp[:, 2].mean()),
        "hit_wrist": hit_w,
        **({"lift": lift} if lift is not None else {}),
    })
    return feats


def analyze_video(video_path: str, wav_path: str, meta: dict, progress=None) -> dict:
    """Return onsets with per-onset pose features for one video."""
    onsets = detect_onsets(wav_path)
    # Keep the strongest candidates only (ball strikes are among the loudest transients)
    if onsets:
        rise = np.array([o["rise"] for o in onsets])
        cut = max(6.0, float(np.percentile(rise, 25)))
        onsets = [o for o in onsets if o["rise"] >= cut]
    pre, post = config.POSE_WINDOW
    fps = config.POSE_FPS
    # Frames needed: a window around every candidate onset.
    spans = []
    needed: set[int] = set()
    for o in onsets:
        i0 = max(0, int(np.ceil((o["t"] + pre) * fps)))
        i1 = int(np.floor((o["t"] + post) * fps))
        spans.append((i0, i1))
        needed.update(range(i0, i1 + 1))
    last_needed = max(needed) if needed else -1
    total = max(1, int(meta.get("duration", 1) * fps))
    # One sequential decode pass; pose only on needed frames, in batches.
    people: dict[int, list[Person]] = {}
    batch_i: list[int] = []
    batch_f: list[np.ndarray] = []

    def flush():
        if batch_f:
            for i, ppl in zip(batch_i, run_pose(np.stack(batch_f))):
                people[i] = ppl
            batch_i.clear()
            batch_f.clear()

    if needed:
        for idx, frame in media.iter_frames(video_path, fps, config.POSE_HEIGHT, meta):
            if idx in needed:
                batch_i.append(idx)
                batch_f.append(frame)
                if len(batch_f) >= 16:
                    flush()
            if progress and idx % 100 == 0:
                progress(min(1.0, idx / min(total, last_needed + 1)))
            if idx >= last_needed:
                break
        flush()
    for o, (i0, i1) in zip(onsets, spans):
        seq = [people.get(i, []) for i in range(i0, i1 + 1)]
        o.update(window_features(o["t"], i0 / fps, seq, config.POSE_HEIGHT, fps))
    return {"onsets": onsets}


# ---------------------------------------------------------------- session-level classification

def _pct(values: np.ndarray) -> np.ndarray:
    if len(values) == 0:
        return values
    order = values.argsort().argsort()
    return order / max(1, len(values) - 1)


def classify_session(videos: list[dict], analyses: dict[str, dict], handed: str, label_examples: list[dict]) -> list[dict]:
    """Turn raw onsets from every video into hit events (mine + opponent's)."""
    any_pose = any(o.get("near_present", 0) > 0 for a in analyses.values() for o in a["onsets"])
    events: list[dict] = []
    for v in videos:
        onsets = analyses[v["id"]]["onsets"]
        if not onsets:
            continue
        loud = np.array([o["loud"] for o in onsets])
        loud_pct = _pct(loud)
        vid_events = []
        for o, lp in zip(onsets, loud_pct):
            ns = o.get("near_speed", 0.0)
            if any_pose:
                # Calibrated on real footage: my strikes peak at >= ~2.4 body-heights/s at the sound;
                # the opponent's (equally loud) strikes happen while I'm in ready position (<= ~1.4).
                # (A looser rule let in the opponent's strikes whenever I happened to be moving.)
                mine = ns >= 2.2
                # The opponent is usually too small for the pose model, so their strikes are recognized by
                # sound: loud and crisp while I'm not swinging. Rally logic later keeps only plausible ones.
                opp = (not mine) and ns < 1.6 and o.get("rise", 0) >= 12 and o.get("sharp", 0) >= 7
            else:
                # Audio-only fallback (no people detected at all): the louder hits are mine.
                mine, opp = lp >= 0.5, lp < 0.5
            if not (mine or opp):
                continue
            vid_events.append({**o, "video_id": v["id"], "player": "me" if mine else "opp", "loud_pct": float(lp)})
        events.extend(_dedupe(vid_events))
    # Depth reference: median body height of my shots
    mine = [e for e in events if e["player"] == "me"]
    body = np.array([e.get("body_h", 0) for e in mine if e.get("body_h")])
    med_h = float(np.median(body)) if len(body) else 0.3
    sign = 1.0 if handed == "right" else -1.0
    for e in mine:
        e["depth_ratio"] = e.get("body_h", med_h) / med_h if med_h else 1.0
        e["type"] = heuristic_type(e, sign)
        e["auto_type"] = e["type"]
    # Learned corrections (k-NN on user-labelled examples)
    if len(label_examples) >= 10:
        X = np.array([feature_vector(x["features"]) for x in label_examples])
        y = [x["label"] for x in label_examples]
        for e in mine:
            fv = feature_vector(e)
            d = np.linalg.norm(X - fv, axis=1)
            nn = d.argsort()[:5]
            votes: dict[str, int] = {}
            for j in nn:
                votes[y[j]] = votes.get(y[j], 0) + 1
            lab, cnt = max(votes.items(), key=lambda kv: kv[1])
            if cnt >= 3:
                e["type"] = lab
    return events


def _dedupe(events: list[dict]) -> list[dict]:
    """One swing can produce several sounds (strike, frame rattle, bounce right before). Keep one 'me'
    event per 1 s (a ball can't come back faster; keep the loudest, crispest), and drop 'opp' sounds right around my own strikes."""
    events = sorted(events, key=lambda e: e["t"])
    mine = [e for e in events if e["player"] == "me"]
    kept: list[dict] = []
    for e in mine:
        if kept and e["t"] - kept[-1]["t"] < 1.0:
            if e["loud"] + 0.5 * e.get("sharp", 0) > kept[-1]["loud"] + 0.5 * kept[-1].get("sharp", 0):
                kept[-1] = e
            continue
        kept.append(e)
    my_t = np.array([e["t"] for e in kept])
    opp = [e for e in events if e["player"] == "opp"
           and not (len(my_t) and np.any((my_t - e["t"] > -0.4) & (my_t - e["t"] < 0.7)))]
    return sorted(kept + opp, key=lambda e: e["t"])


def feature_vector(e: dict) -> np.ndarray:
    return np.array([
        e.get("side", 0) * 2, e.get("side_both", 0), e.get("overhead", 0) * 2,
        e.get("depth_ratio", 1), e.get("forward", 0) * 5, e.get("swing", 0) * 0.3,
        (e.get("lift") if e.get("lift") is not None else 0.3) * 3,  # missing (older analyses) reads as topspin
    ])


def heuristic_type(e: dict, sign: float) -> str:
    if "side" not in e:
        return "unknown"
    side = sign * e["side"]
    fh = side >= 0
    if e.get("overhead", 0) > 0.12:
        return "overhead"  # promoted to "serve" when it starts a rally (see rallies.py)
    ratio = e.get("depth_ratio", 1.0)
    if ratio < 0.72:
        return "fh_volley" if fh else "bh_volley"
    if ratio < 0.9 and e.get("forward", 0) > 0.04:
        return "approach"
    if e.get("lift") is not None and e["lift"] < -0.02:
        return "fh_slice" if fh else "bh_slice"
    return "forehand" if fh else "backhand"


QUALITY_FEATURES = ["speed", "swing", "contact", "clarity", "proximity"]
DEFAULT_WEIGHTS = {"speed": 0.3, "swing": 0.25, "contact": 0.2, "clarity": 0.1, "proximity": 0.15}


def quality_components(mine: list[dict]) -> None:
    """Attach percentile-normalized quality components (0..1) to each of my shots."""
    if not mine:
        return
    speed = np.array([e.get("near_speed", 0) for e in mine])
    swing = np.array([e.get("swing", 0) for e in mine])
    contact = np.array([0.6 * e.get("sharp", 0) + 0.4 * e.get("rise", 0) for e in mine])
    clarity = np.array([e.get("kp_conf", 0) * e.get("near_present", 0) for e in mine])
    prox = np.array([e.get("depth_ratio", 1) for e in mine])
    comps = {
        "speed": _pct(speed), "swing": _pct(swing), "contact": _pct(contact),
        "clarity": _pct(clarity), "proximity": _pct(prox),
    }
    for i, e in enumerate(mine):
        e["components"] = {k: float(v[i]) for k, v in comps.items()}
        # Backing up (bigger than usual in frame) gets extra credit.
        if e.get("depth_ratio", 1) > 1.1:
            e["components"]["proximity"] = min(1.0, e["components"]["proximity"] + 0.15)


def score(components: dict, weights: dict) -> float:
    tot = sum(weights.values()) or 1.0
    return float(sum(components.get(k, 0) * w for k, w in weights.items()) / tot)


def stars_from_quality(q: list[float]) -> list[int]:
    if not q:
        return []
    p = _pct(np.array(q))
    return [int(np.clip(1 + np.floor(x * 5), 1, 5)) for x in p]
