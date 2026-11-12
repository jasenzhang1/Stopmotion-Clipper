# Stopmotion Clipper — Architecture

A local app: a Python server does the heavy video/audio work, and a browser UI (served by that same
server at `http://localhost:8765`) is the editor.

```
 Google Drive for Desktop ──► local footage folder ─┐
 song.mp3 / .flac ─────────────────────────────────┤
                                                    ▼
┌──────────────────────── Python backend (FastAPI) ─────────────────────────┐
│ media.py    FFmpeg: probe, audio extract, frame windows, proxies, render  │
│ music.py    librosa: beat grid, bars, energy, drop detection, repeats     │
│ shots.py    hit sounds + YOLO pose → my shots, type, quality features     │
│ rallies.py  group hits into rallies, find point end, rally score          │
│ draft.py    timeline generator (density, patterns, reuse, rally window)   │
│ skeleton.py skeleton text (F1 F1 F2 B1 …) ⇄ timeline                      │
│ learning.py preferences per mood, learned from draft-vs-export diffs      │
│ chat.py     Claude (Opus 5.5) with timeline-editing tools                 │
│ render.py   frame-accurate 9:16 export (60 fps, high bitrate)             │
└───────────────────────────────────▲───────────────────────────────────────┘
                                    │ JSON API + proxy clips
┌──────────────────────── React + TypeScript UI (Vite) ─────────────────────┐
│ Import → Song (waveform, section, drop) → Shots review → Editor → Export  │
│ Editor: shot library | live 9:16 preview | feedback chat                  │
│         timeline: waveform, beat grid, bars w/ density, clips, rally      │
└───────────────────────────────────────────────────────────────────────────┘
```

## Stack

| Concern | Choice | Why |
|---|---|---|
| Server | Python 3.13, FastAPI, uvicorn | Best ecosystem for audio/video/ML |
| Video I/O | FFmpeg (subprocess) | Handles iPhone HEVC/HDR, frame-accurate cuts |
| Music analysis | librosa | Beat tracking, onset strength, chroma |
| Player pose | Ultralytics YOLO11n-pose | Multi-person, so near player vs. opponent is easy; runs on CPU or GPU |
| LLM feedback | Anthropic Python SDK, `claude-opus-5-5` | Turns plain-language feedback into edit operations via tools |
| UI | React 18 + TypeScript + Vite | Drag-and-drop timeline editor |
| Storage | JSON files under `data/` | Zero setup, easy to inspect |

## How the pieces work

**Shot detection.** Ball strikes are sharp high-frequency transients, so the app first finds candidate
hits in each video's audio (fast, and gives exact contact time). It runs the pose model only on short
windows around those moments. A hit is "mine" when the near player's wrist speed peaks at the sound.
Shot type comes from where the hitting wrist travels relative to the body (forehand/backhand side), wrist
height (serve/overhead), and court depth from body size in frame (volley/approach). Label corrections
you make are stored and used as examples for future classification.

**Quality score.** Percentile-normalized racket (wrist) speed, swing size, contact crispness (sound
sharpness/strength), body/keypoint clarity, and closeness to camera. Ball visibility is not measured yet.

**Music.** EDM tempo is constant, so beats are fitted to a regular grid. The drop is the downbeat with
the largest jump in bass/overall energy inside the chosen section; that also fixes the bar phase.

**Draft generation.** Per bar, density (1/2/4/8 clips) follows energy and progress toward the drop, with
seeded variation. Shot types follow patterns (e.g. FH FH FH BH), best shots go to the most important
slots, and repeated musical notes (similar chroma on consecutive strong onsets) can reuse the previous
shot, capped per phrase. Every cut is offset so racket contact lands exactly on its beat. The drop gets the
best rally window (shot count saturates at 5; my shot quality counts), starting on the drop and ending a
split second after the point, snapped to a beat.

**Skeleton.** The build-up can be read and edited as text, one line per bar and four beat tokens per line
(`F1 F1 F2 B1`, `F3 - - -`, `[F4 F5] B2 F6 -`). A label such as `F3` names one specific clip across the whole
reel, so writing the same label twice repeats that exact clip. An unnumbered letter means "any unused
clip of that type". Slots are stored as a position and length in sixteenths of a bar. Lengths must be
standard note values (whole, half, quarter, eighth), and sixteenths can be switched on per reel. The
generator writes the first skeleton. Bars you edit, as text or by dragging a clip's edge, are kept when
you reshuffle.

**Preview.** Low-res proxy clips are played by a browser sequencer synced to the song, so edits show
up instantly with no re-render. Export renders from the original footage.

**Export.** Source resolution (capped at 4K) at 60 fps, H.264 CRF 16, song audio only. iPhone HDR is
tone-mapped to SDR by default (most consistent across TikTok/Instagram/YouTube); an HDR (HEVC 10-bit HLG)
option exists.

**Learning.** Each export stores the app's first draft beside your final cut plus mood tags. Differences
(density changes, type mix, reuse, which shots you swapped in/out, rally length) update per-mood
preferences used for the next draft.
