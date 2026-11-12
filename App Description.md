# Stopmotion Clipper — App Description

## Concept

A desktop app that turns raw tennis hitting-session footage into a beat-synced "stop motion" reel (TikTok / Instagram Reels / YouTube Shorts, 9:16).

- **Build-up:** rapid-fire split-second clips of my shots (forehand, backhand, volley, serve, approach…), each cut landing on the beat of an EDM song.
- **Drop:** after the viewer has only seen fragments, the drop finally shows a **real rally** at normal speed. The reel ends a split second after the point ends.

The app produces a first draft automatically. I refine it in an editor (by hand and through chat with an LLM), export it, and the app learns my taste from the differences between its draft and my final cut.

## Inputs

| Input | Details |
|---|---|
| Footage | Folder of 3–10 min videos, synced from **Google Drive via Google Drive for Desktop** (the app reads a local folder). |
| Song | Audio file: `.mp3`, `.flac`, `.wav`, `.m4a`. |
| Song section | The part of the song to work around, chosen in the app on the waveform. |
| Mood tags (optional) | Tags describing the reel's vibe, used for learning (see "Learning"). |

### Footage assumptions

- The tripod is always **portrait**, and the camera never moves within a session. All videos in a session share the same exact angle.
- **I'm always on the near side** of the court (closer to the camera), and my opponent is on the far side.
- So no cropping or reframing is needed. Shots can be split into mine and my opponent's by court position.

## Workflow

1. **Import:** pick a session folder and a song file.
2. **Mark the song:** select the section on the waveform. The app auto-detects beats, the build-up and the drop, and I can adjust them.
3. **Shot analysis:** the app detects every shot, labels it, and scores it.
4. **First draft:** the app arranges clips on the beat timeline and picks the drop rally.
5. **Edit:** I rearrange by hand and/or give feedback in chat, and the draft regenerates.
6. **Export:** a 9:16 video. The export is also saved for learning.

## Shot detection & labeling

Each detected shot of mine gets:

- **Type:** forehand, backhand, volley (forward / backing up), serve, approach shot, etc.
- **Clip:** a split-second window around ball contact (roughly 0.3–0.5 s). It stays in motion, not a freeze frame.
- **Quality score** (shown as stars), based on:
  - Racket speed
  - Swing size
  - Clean contact
  - Ball clearly visible
  - **Bonus:** I'm closer to the camera (backed up), so I'm more visible
  - **Not considered:** the shot's outcome (winner, error). A split-second clip never shows the result.

## Build-up: beat-synced clips

- The AI chooses cut density from the song's **energy**, and it should vary: one clip spanning a whole measure, one per beat, eighth-note bursts as energy rises, and so on.
- The AI chooses shot-type patterns that fit the music (e.g. FH FH FH BH | FH FH FH BH).
- **Contact on the beat:** every cut is timed so the moment of racket–ball contact lands exactly on the beat.
- **Shot reuse for repeated notes:** when a phrase repeats the exact same note or motif (e.g. Martin Garrix-style repeated hooks), the same shot can be reused to echo it. Use this sparingly and only within a phrase. Otherwise prefer unique clips.
- I can override any of this per measure: for example, "these 4 beats are a single clip" or "this measure is 8 eighth-note clips."
- **Skeleton:** the app writes the build-up as an editable skeleton, e.g. `F1 F1 F2 B1` (forehand 1 twice, forehand 2, backhand 1). Each label is one specific clip for the whole reel, so clips repeat only when I reuse a label on purpose. Clip lengths follow standard note values (whole, half, quarter, eighth). Sixteenths are an opt-in toggle. In the timeline I can also drag a clip's edge to make it twice as long.
- **Ticks:** the timeline ruler shows phrase (8 bars), bar, beat and eighth-note ticks, like Rekordbox.

## Drop: the rally

- **Rally selection** uses a holistic score:
  - Number of shots counts, but with diminishing returns: past about 5 shots back and forth, extra length adds nothing.
  - How good *I* look in it (shot strength, quality scores of my shots).
- **Playback:** normal speed, continuous, includes both players.
- **The drop hit matters most, not the full phrase.** The rally starts on the drop. It doesn't need to fill the whole drop phrase, and a shorter rally is often better because a long one bores the audience. Just pick the best rally.
- **Start point:** it doesn't need to start from the rally's first shot. It can begin mid-rally if the latter half is more exciting.
- **Ending:** the reel ends a split second after the point ends, ideally on a strong beat, so the cut feels musical and not robotic.

## Editor layout

```
┌───────────────────────────────────────────────────────────────────┐
│ Stopmotion Clipper     [Session: Nov 9 hitting]       [Export ▸]  │
├──────────────┬───────────────────────────────┬────────────────────┤
│ SHOT LIBRARY │                               │ FEEDBACK CHAT      │
│ [All][FH][BH]│        ┌───────────┐          │                    │
│ [Volley][Srv]│        │           │          │ AI: Here's draft 1.│
│ [Approach]   │        │   9:16    │          │ I put backhands on │
│              │        │  PREVIEW  │          │ every 4th beat...  │
│ ▣ FH ★★★★☆  │        │           │          │                    │
│ ▣ BH ★★★☆☆  │        │           │          │ You: more volleys  │
│ ▣ FH ★★★★★  │        └───────────┘          │ near the drop      │
│ ▣ VOL ★★★★☆ │       ◂◂   ▶   ▸▸   0:07/0:22 │                    │
│  ...         │                               │ [type here...]     │
├──────────────┴───────────────────────────────┴────────────────────┤
│ SONG  ▁▂▃▅▃▂▁▂▃▅▆▇▆▅▃▂▃▅▆▇██████▇▆▅▃▂▁                            │
│ BEATS |  |  |  |  |  |  |  |  |  |  |  |  [DROP]                  │
│ CLIPS [FH][FH][FH][BH][FH][FH][FH][BH][VOL]...[=== RALLY ======]  │
│       └─ build-up ──────────────────────────┘└── drop ───────┘    │
└───────────────────────────────────────────────────────────────────┘
```

- **Shot library (left):** every detected shot, filterable by type and sortable by score. I can fix wrong labels or ratings here.
- **Preview (center):** 9:16 playback of the current draft.
- **Feedback chat (right):** natural-language changes ("more backhands in the build-up", "pick a different rally").
- **Timeline (bottom):** song waveform, beat grid, build-up/drop markers, and clip track. I can drag clips from the library onto beats, rearrange or remove clips, change per-measure density, and swap the rally.

## Learning my style

- Every exported reel is saved alongside the app's original first draft. The app learns from the **differences** (what I swapped, removed, reordered, re-rated, and what density and patterns I chose).
- I can tag each reel with **moods** from a **preset list** (starting set: Hype, Chill, Aggressive, Playful, Cinematic). I have distinct moods I go for, so preferences are learned per mood, and I can pick a mood when generating a new draft.

## Output

- Vertical 9:16 video, ready for TikTok / Reels / Shorts.
- **Audio:** the song only. Tennis audio is never included.
- **Quality:** match the source as closely as possible. Footage is from an iPhone 17 at 60 fps, so export at the source resolution and 60 fps with high bitrate.

## Open questions

- iPhone footage is often HDR (Dolby Vision) by default, and social platforms handle HDR inconsistently. Export in HDR, or convert to SDR?

---

## Original notes (verbatim)

I have a clipping procedure and algorithm that I want to develop. I'm a tennis player, and I love EDM. I usually post stories of me playing tennis, just rallying back and forth.
An idea I had is to incorporate stop motion with every time I hit the ball, with the beat of an EDM song. This app would take in footage from my tennis play and find and label certain shots that I made, such as forehand, backhand, volley, and serve. It would also presumably rank them. Some of them look better than others. Some of them, I went forward to volley. Some of them, I volleyed towards the back. Some of them were approach shots. These tennis shots will be properly labeled.
Depending on the energy of the song that I want to use in this tennis stop motion video, certain clips would be played at certain beats of the song. The pre-chorus, as it builds up, you would probably get forehand, forehand, forehand, backhand, forehand, forehand, forehand, backhand, or some sort of pattern that corresponds well with a song. The song could be 1, 2, and 3, and there would be an element of mixing here: what shots mix well with the energy of the song. When the drop of the song happens, that would presumably be matched with my most energetic shot. You can marinate on that clip for a while because the user has watched so many small clips of shots that they haven't seen a proper rally.
For now, have the drop contain a proper rally, and then after a few shots, the point ends, and that's when the reel ends.
I want you to stitch a fun stop-motion TikTok video/Instagram reel/YouTube short, and all I need to supply is:
- all of my footage
- a part of the song that I want you to work around
- maybe some other parameters that you find relevant for me to specify
The user should be able to see a first draft of this reel and be able to give feedback, in which the LLM will be able to make changes. My videos will be on iCloud at first, but I can definitely migrate them to Google Drive if needed. Ideally, on iCloud, if you can find an MCP or be able to view my videos.
That's it. If you have any questions about what I mean or have any clarifying questions about what I want from this, then please let me know. Thank you.
