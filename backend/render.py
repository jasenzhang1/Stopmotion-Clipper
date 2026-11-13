"""Frame-accurate final export from the original footage."""
from __future__ import annotations

import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import media



def _out_dims(meta: dict, resolution: str) -> tuple[int, int]:
    if resolution == "1080":
        return 1080, 1920
    h = min(3840, meta["height"])
    h = media.even(h)
    return media.even(h * 9 / 16), h


def _video_filter(meta: dict, W: int, H: int, hdr_out: bool, fps: int) -> str:
    # Scale to cover 9:16 then center-crop (a no-op for normal iPhone portrait footage).
    cover = (f"scale='if(gt(a,{W}/{H}),-2,{W})':'if(gt(a,{W}/{H}),{H},-2)':flags=lanczos,"
             f"crop={W}:{H}")
    if hdr_out:
        chain = f"{cover},format=yuv420p10le"
    elif meta.get("hdr"):
        chain = f"{cover},{media.tonemap_chain(meta)}"
    else:
        chain = f"{cover},format=yuv420p"
    return f"fps={fps},{chain},tpad=stop_mode=clone:stop_duration=3,setsar=1"


def _encode_args(hdr_out: bool, trc: str) -> list[str]:
    if hdr_out:
        return ["-c:v", "libx265", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
                "-x265-params", f"colorprim=bt2020:transfer={trc}:colormatrix=bt2020nc:log-level=error",
                "-color_primaries", "bt2020", "-color_trc", trc, "-colorspace", "bt2020nc"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-profile:v", "high", "-pix_fmt", "yuv420p",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]


def export(project: dict, tl: dict, out_path: Path, resolution: str = "source", hdr: bool = False,
           progress=None) -> dict:
    videos = {v["id"]: v for v in project["videos"]}
    reel_start = tl["reel_start"]
    # Match the footage: 60 fps if it was shot at 50/60, otherwise 30 (60 would only duplicate frames).
    fps = 60 if max((v["meta"].get("fps", 30) for v in videos.values() if v.get("meta")), default=60) >= 49 else 30

    def frame(t: float) -> int:
        return int(round((t - reel_start) * fps))

    # (video_id | None for black, source start, frames), back to back in reel order.
    items = [(s["start"], s["end"], s["video_id"], s["src_start"])
             for b in tl["bars"] for s in b["slots"] if s.get("video_id")]
    r = tl.get("rally")
    if r and "src_start" in r:
        items.append((r["start"], r["end"], r["video_id"], r["src_start"]))
    items.sort(key=lambda x: x[0])
    segs = []
    cur = 0
    for start, end, vid, src in items:
        f0, f1 = max(cur, frame(start)), frame(end)
        if f0 > cur:  # time no clip covers is black
            segs.append((None, 0.0, f0 - cur))
        if f1 > f0:
            segs.append((vid, src + (f0 - frame(start)) / fps, f1 - f0))
            cur = f1
        cur = max(cur, f0)
    if tl.get("reel_end") and frame(tl["reel_end"]) > cur:  # black up to the song step's END marker
        segs.append((None, 0.0, frame(tl["reel_end"]) - cur))
    if not any(v for v, _, _ in segs):
        raise RuntimeError("Timeline is empty.")

    first_meta = videos[next(v for v, _, _ in segs if v)]["meta"]
    W, H = _out_dims(first_meta, resolution)
    hdr_out = bool(hdr and first_meta.get("hdr"))
    trc = first_meta.get("color_transfer") or "arib-std-b67"
    enc = _encode_args(hdr_out, trc)

    tmp = Path(tempfile.mkdtemp(prefix="clipper_render_"))
    try:
        done = [0]

        def encode(i: int, seg) -> Path:
            vid, src, n = seg
            out = tmp / f"seg{i:04d}.mp4"
            if vid is None:
                pix = "yuv420p10le" if hdr_out else "yuv420p"
                media.run([
                    media.ffmpeg_bin(), "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={fps}",
                    "-vf", f"format={pix},setsar=1", "-frames:v", str(n),
                    *enc, "-r", str(fps), "-video_track_timescale", "60000", str(out),
                ], capture=False)
                done[0] += 1
                return out
            v = videos[vid]
            media.run([
                media.ffmpeg_bin(), "-y", "-v", "error", "-ss", f"{src:.4f}", "-i", v["path"],
                "-an", "-vf", _video_filter(v["meta"], W, H, hdr_out, fps), "-frames:v", str(n),
                *enc, "-r", str(fps), "-video_track_timescale", "60000", str(out),
            ], capture=False)
            done[0] += 1
            if progress:
                progress(0.9 * done[0] / len(segs), f"Rendering clip {done[0]}/{len(segs)}")
            return out

        with ThreadPoolExecutor(max_workers=3) as ex:
            files = list(ex.map(lambda a: encode(*a), enumerate(segs)))

        lst = tmp / "list.txt"
        lst.write_text("".join(f"file '{f.as_posix()}'\n" for f in files))
        video_only = tmp / "video.mp4"
        media.run([media.ffmpeg_bin(), "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                   "-c", "copy", str(video_only)], capture=False)
        total_frames = sum(n for _, _, n in segs)
        dur = total_frames / fps
        if progress:
            progress(0.95, "Adding music")
        fade = min(0.08, dur / 4)
        media.run([
            media.ffmpeg_bin(), "-y", "-v", "error", "-i", str(video_only),
            "-ss", f"{reel_start:.4f}", "-t", f"{dur:.4f}", "-i", project["song"]["path"],
            "-map", "0:v", "-map", "1:a",
            "-af", f"afade=t=in:d=0.015,afade=t=out:st={dur - fade:.4f}:d={fade:.4f}",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
            "-t", f"{dur:.4f}", "-movflags", "+faststart", str(out_path),
        ], capture=False)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"width": W, "height": H, "fps": fps, "duration": dur, "hdr": hdr_out,
            "clips": sum(1 for v, _, _ in segs if v)}
