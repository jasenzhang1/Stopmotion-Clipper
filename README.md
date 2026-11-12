# Stopmotion Clipper

Turns your tennis hitting footage + an EDM song into a beat-synced stop-motion reel: split-second shots
cut on the beat through the build-up, then a real rally on the drop. See [App Description.md](App%20Description.md)
for the product spec and [ARCHITECTURE.md](ARCHITECTURE.md) for how it works.

## Run it

Double-click **`run.bat`** (or run it from a terminal). The first run sets up Python packages and builds
the interface; afterwards it starts in seconds and opens <http://localhost:8765>.

Requirements: Python 3.13 (`py` launcher), Node.js, FFmpeg (`winget install Gyan.FFmpeg`).

**Feedback chat** uses Claude. Set your key before launching:

```powershell
setx ANTHROPIC_API_KEY "sk-ant-..."   # then open a new terminal
```

## Workflow

1. **New reel**: pick your session folder (e.g. `G:\My Drive\Tennis\2026-11-09` from Google Drive for
   Desktop) and a song file. Footage analysis starts in the background.
2. **Song**: drag START (build-up begins) and DROP onto the waveform. A section is pre-selected for you.
3. **Shots**: check labels/stars, hide shots you never want. Corrections teach the app.
4. **Editor**: preview the draft, drag shots onto clips, change each bar's cutting (1/2/4/8 clips),
   pick the drop rally, or ask the chat for changes. **Reshuffle** keeps your manual edits.
5. **Export**: original quality at 60 fps. Tag the mood and rate it; the app learns from how your final
   cut differs from its first draft.

## Notes

- Analysis is cached per video, so re-importing the same footage is instant.
- Pose detection runs on CPU by default (expect a few minutes per 10-minute video). Your NVIDIA GPU
  would make it several times faster: install the CUDA build of PyTorch into `.venv` using the command
  from pytorch.org ("Get Started", pip, CUDA); the app uses the GPU automatically when it's available.
- All data lives in `data/` (projects, previews, exports, learned preferences in `data/prefs.json`).
