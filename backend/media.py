"""FFmpeg helpers: probing, audio extraction, frame windows, proxies."""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import numpy as np

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _find_tool(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        os.path.join(local, "Microsoft", "WinGet", "Links", f"{name}.exe"),
        *glob.glob(os.path.join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "*", "bin", f"{name}.exe")),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    raise RuntimeError(f"{name} not found. Install FFmpeg (e.g. `winget install Gyan.FFmpeg`).")


@lru_cache(maxsize=None)
def ffmpeg_bin() -> str:
    return _find_tool("ffmpeg")


@lru_cache(maxsize=None)
def ffprobe_bin() -> str:
    return _find_tool("ffprobe")


def run(args: list[str], *, input: bytes | None = None, capture: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        args,
        input=input,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=_NO_WINDOW,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode(errors="replace")[-2000:]
        raise RuntimeError(f"Command failed ({Path(args[0]).name}): {err}")
    return proc


def _rate(s: str | None) -> float:
    if not s or s in ("0/0", "N/A"):
        return 0.0
    if "/" in s:
        a, b = s.split("/")
        return float(a) / float(b) if float(b) else 0.0
    return float(s)


def probe(path: str | Path) -> dict:
    out = run([
        ffprobe_bin(), "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(path),
    ]).stdout
    info = json.loads(out)
    v = next((s for s in info["streams"] if s.get("codec_type") == "video"), None)
    a = next((s for s in info["streams"] if s.get("codec_type") == "audio"), None)
    duration = float(info.get("format", {}).get("duration") or 0)
    result = {"duration": duration, "has_audio": a is not None, "has_video": v is not None}
    if v:
        rotation = 0
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rotation = int(sd["rotation"])
        if not rotation and "rotate" in (v.get("tags") or {}):
            rotation = int(v["tags"]["rotate"])
        w, h = int(v["width"]), int(v["height"])
        if abs(rotation) % 180 == 90:
            w, h = h, w
        trc = v.get("color_transfer") or ""
        result.update({
            "width": w,
            "height": h,
            "fps": _rate(v.get("avg_frame_rate")) or _rate(v.get("r_frame_rate")) or 30.0,
            "codec": v.get("codec_name"),
            "pix_fmt": v.get("pix_fmt"),
            "color_transfer": trc,
            "color_primaries": v.get("color_primaries") or "",
            "color_space": v.get("color_space") or "",
            "hdr": trc in ("arib-std-b67", "smpte2084"),
        })
    return result


def extract_audio(src: str | Path, out_wav: str | Path, sr: int, mono: bool = True) -> None:
    args = [ffmpeg_bin(), "-y", "-v", "error", "-i", str(src), "-vn"]
    if mono:
        args += ["-ac", "1"]
    args += ["-ar", str(sr), "-c:a", "pcm_s16le", str(out_wav)]
    run(args, capture=False)


def even(x: float) -> int:
    return max(2, int(round(x / 2)) * 2)


def tonemap_chain(meta: dict) -> str:
    """Filter that converts HDR (HLG/PQ, BT.2020) to SDR BT.709 8-bit."""
    tin = meta.get("color_transfer") or "arib-std-b67"
    return (
        f"zscale=tin={tin}:pin=bt2020:min=bt2020nc:t=linear:npl=100,format=gbrpf32le,"
        "zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
        "zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
    )


def sdr_chain(meta: dict, width: int, height: int) -> str:
    """Scale (cheaply, before tone-mapping) and convert to SDR yuv420p."""
    scale = f"scale={width}:{height}:flags=lanczos"
    if meta.get("hdr"):
        return f"{scale},{tonemap_chain(meta)}"
    return f"{scale},format=yuv420p"


def read_frames(src: str | Path, start: float, duration: float, fps: int, height: int, meta: dict) -> np.ndarray:
    """Decode a window of frames as BGR uint8 array (N, H, W, 3)."""
    width = even(meta["width"] * height / meta["height"])
    vf = f"fps={fps},scale={width}:{height}:flags=bilinear,format=bgr24"
    args = [
        ffmpeg_bin(), "-v", "error", "-ss", f"{max(0.0, start):.3f}", "-t", f"{duration:.3f}",
        "-i", str(src), "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
    ]
    raw = run(args).stdout
    frame_size = width * height * 3
    n = len(raw) // frame_size
    if n == 0:
        return np.zeros((0, height, width, 3), dtype=np.uint8)
    return np.frombuffer(raw[: n * frame_size], dtype=np.uint8).reshape(n, height, width, 3)


def iter_frames(src: str | Path, fps: int, height: int, meta: dict):
    """Decode the whole video once, sequentially (far faster than many seeks). Yields (index, BGR frame);
    frame i is at time i / fps. Close the generator early to stop decoding."""
    width = even(meta["width"] * height / meta["height"])
    vf = f"fps={fps},scale={width}:{height}:flags=bilinear,format=bgr24"
    proc = subprocess.Popen(
        [ffmpeg_bin(), "-v", "error", "-i", str(src), "-an", "-vf", vf, "-f", "rawvideo", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=_NO_WINDOW, bufsize=10 ** 7,
    )
    size = width * height * 3
    i = 0
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield i, np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
            i += 1
    finally:
        proc.kill()
        proc.wait()


def make_proxy(src: str | Path, start: float, duration: float, out: str | Path, meta: dict,
               height: int, fps: int) -> None:
    width = even(meta["width"] * height / meta["height"])
    vf = f"fps={fps},{sdr_chain(meta, width, height)}"
    run([
        ffmpeg_bin(), "-y", "-v", "error", "-ss", f"{max(0.0, start):.3f}", "-t", f"{duration:.3f}",
        "-i", str(src), "-an", "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-g", "6",
        "-movflags", "+faststart", str(out),
    ], capture=False)


def make_thumb(src: str | Path, t: float, out: str | Path, meta: dict, height: int = 400) -> None:
    width = even(meta["width"] * height / meta["height"])
    vf = sdr_chain(meta, width, height)
    run([
        ffmpeg_bin(), "-y", "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", str(src),
        "-frames:v", "1", "-vf", vf, "-q:v", "4", str(out),
    ], capture=False)
