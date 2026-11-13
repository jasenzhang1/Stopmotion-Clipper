"""Natural-language feedback: Claude edits the timeline through tools."""
from __future__ import annotations

import json

import anthropic

from . import config, draft, learning

SYSTEM = """You are the editing assistant inside Stopmotion Clipper, an app that turns a tennis player's \
hitting-session footage into a beat-synced "stop motion" reel for TikTok / Reels / Shorts.

How a reel is built:
- Build-up: bars of 4 beats before the drop. Each bar holds 1, 2, 4 or 8 clips ("clips" = density; 8 means \
eighth notes). Every clip is a split-second of one of the player's shots, cut so racket contact lands exactly \
on its beat. Slot ids look like "b-3s2" = bar k=-3 (3 bars before the drop), slot index 2.
- Bars are identified by k: -1 is the last bar before the drop, -2 the one before it, and so on.
- Drop: a real rally plays at normal speed starting on the drop, and the reel ends a split second after the \
point ends. A rally can start mid-way (start_hit) if the latter part is more exciting.
- Shot types: forehand, backhand, fh_slice, bh_slice (slices count as forehands/backhands, letters F/B), fh_volley, bh_volley, approach, serve, overhead. Stars (1-5) rate how good \
the shot looks (racket speed, swing size, clean contact, visibility).
- Every clip has a label like F3 (F forehand, B backhand, V volley, A approach, S serve/overhead, U unlabeled). A label names one specific clip across the whole reel: the same label twice means the exact same clip is repeated. Repeat a clip only to make a point (e.g. the music repeats the same note); otherwise keep clips unique.
- The timeline JSON includes "skeleton": the build-up as text, one line per bar, 4 beat tokens per line. "-" holds the previous clip for that beat, [a b] splits a beat into eighth notes ([a b c d] = sixteenths, only when grid is 16), an unnumbered letter (F) means "any unused forehand", * means any shot, # starts a comment. "." is black (no clip), and "-" after it keeps it black. Clips can start and end on any eighth (any sixteenth on the 16 grid), so dotted lengths are fine. Example bar: "F1 F1 F2 B1", "F3 - [F4 F5] B2" or "F1 . [- B2] B3".
- "locked" slots were set by hand; regenerate keeps them.

You get the current timeline, shot library and rallies as JSON with each message. Use the tools to make the \
change the user asks for, then reply in one to three short sentences saying what you changed. Prefer precise \
edits (set_slot_shot, swap_slots, set_bar_clips) for specific requests and regenerate for broad ones \
("busier", "more backhands overall", "try something different"). If a request can't be done with the tools, \
say so plainly. For changes to rhythm or clip identity (holding a clip longer, repeating a clip, a specific pattern like F1 F1 F2 B1), rewrite the skeleton with set_skeleton: keep every line you aren't changing as is."""

TYPES = [t for t in config.SHOT_TYPES if t != "unknown"]

TOOLS = [
    {"name": "set_slot_shot", "description": "Put a specific shot into a timeline slot (locks the slot).",
     "input_schema": {"type": "object", "properties": {
         "slot_id": {"type": "string"}, "shot_id": {"type": "string"}},
         "required": ["slot_id", "shot_id"], "additionalProperties": False}},
    {"name": "swap_slots", "description": "Swap the shots in two slots.",
     "input_schema": {"type": "object", "properties": {
         "slot_a": {"type": "string"}, "slot_b": {"type": "string"}},
         "required": ["slot_a", "slot_b"], "additionalProperties": False}},
    {"name": "set_bar_clips", "description": "Set how many clips a bar is cut into: 1 (one clip spans the bar), "
                                             "2, 4 (one per beat) or 8 (eighth notes).",
     "input_schema": {"type": "object", "properties": {
         "bar_k": {"type": "integer"}, "clips": {"type": "integer", "enum": [1, 2, 4, 8]}},
         "required": ["bar_k", "clips"], "additionalProperties": False}},
    {"name": "set_skeleton", "description": "Replace the build-up with skeleton text (same format as the "
                                             "timeline's skeleton field). Must have one line per bar.",
     "input_schema": {"type": "object", "properties": {"text": {"type": "string"}},
                      "required": ["text"], "additionalProperties": False}},
    {"name": "set_rally", "description": "Choose the rally that plays on the drop, and optionally which hit "
                                         "(0-based index into its hits) it starts from. Omit start_hit to auto-pick.",
     "input_schema": {"type": "object", "properties": {
         "rally_id": {"type": "string"}, "start_hit": {"type": "integer"}},
         "required": ["rally_id"], "additionalProperties": False}},
    {"name": "regenerate", "description": "Regenerate the build-up with adjusted settings. Locked slots and "
                                          "hand-set bar densities are kept unless keep_manual_edits is false.",
     "input_schema": {"type": "object", "properties": {
         "density_bias": {"type": "number", "description": "-0.6 (calmer, fewer clips) .. +0.6 (busier)"},
         "type_mix": {"type": "object", "description": "Relative weights per group: forehand, backhand, volley, "
                                                       "approach, serve. E.g. {\"backhand\": 0.6}",
                      "additionalProperties": {"type": "number"}},
         "reuse_per_phrase": {"type": "number", "description": "Repeated-note shot reuses per 8 bars (0-4)"},
         "showcase_rate": {"type": "number", "description": "0..1 chance calm bars hold one long clip"},
         "keep_manual_edits": {"type": "boolean"},
         "new_variation": {"type": "boolean", "description": "Use a new random seed"}},
         "additionalProperties": False}},
    {"name": "set_shot_label", "description": "Correct a shot's type label.",
     "input_schema": {"type": "object", "properties": {
         "shot_id": {"type": "string"}, "type": {"type": "string", "enum": TYPES}},
         "required": ["shot_id", "type"], "additionalProperties": False}},
    {"name": "set_shot_stars", "description": "Rate a shot 1-5 stars.",
     "input_schema": {"type": "object", "properties": {
         "shot_id": {"type": "string"}, "stars": {"type": "integer", "minimum": 1, "maximum": 5}},
         "required": ["shot_id", "stars"], "additionalProperties": False}},
    {"name": "hide_shot", "description": "Exclude (or re-include) a shot from future drafts.",
     "input_schema": {"type": "object", "properties": {
         "shot_id": {"type": "string"}, "hidden": {"type": "boolean"}},
         "required": ["shot_id", "hidden"], "additionalProperties": False}},
]


def _state(p: dict) -> str:
    tl = p["timeline"]
    used = {s["shot_id"] for b in tl["bars"] for s in b["slots"]}
    shots = [{"id": s["id"], "type": s["type"], "stars": s["stars"], "q": round(s["quality"], 2),
              **({"used": True} if s["id"] in used else {}), **({"hidden": True} if s.get("hidden") else {})}
             for s in p["shots"] if not s.get("parked")]
    rallies = [{"id": r["id"], "hits": r["n_hits"], "seconds": r["duration"], "score": r["score"],
                "best_start_hit": r["best_start"],
                "hit_players": "".join("M" if h["player"] == "me" else "o" for h in r["hits"])}
               for r in sorted((r for r in p["rallies"] if not r.get("parked")), key=lambda r: -r["score"])[:25]]
    return json.dumps({"timeline": draft.summarize(tl, p), "shots": shots, "rallies": rallies})


def _execute(p: dict, name: str, args: dict, regen) -> str:
    tl = p["timeline"]
    if name == "set_slot_shot":
        p["timeline"] = draft.set_slot_shot(tl, p, args["slot_id"], args["shot_id"])
    elif name == "swap_slots":
        p["timeline"] = draft.swap_slots(tl, p, args["slot_a"], args["slot_b"])
    elif name == "set_bar_clips":
        p["timeline"] = draft.set_bar_density(tl, p, int(args["bar_k"]), int(args["clips"]))
    elif name == "set_skeleton":
        p["timeline"] = draft.apply_skeleton(tl, p, args["text"])
    elif name == "set_rally":
        p["timeline"] = draft.set_rally(tl, p, args["rally_id"], args.get("start_hit"))
    elif name == "regenerate":
        overrides = {k: args[k] for k in ("density_bias", "type_mix", "reuse_per_phrase", "showcase_rate") if k in args}
        regen(overrides, args.get("keep_manual_edits", True), args.get("new_variation", True))
    elif name == "set_shot_label":
        s = next(s for s in p["shots"] if s["id"] == args["shot_id"])
        s["type"], s["label_source"] = args["type"], "user"
        learning.add_label_example(s["features"], args["type"])
    elif name == "set_shot_stars":
        s = next(s for s in p["shots"] if s["id"] == args["shot_id"])
        s["user_stars"] = s["stars"] = int(args["stars"])
        s["quality"] = 0.3 * s.get("auto_quality", s["quality"]) + 0.7 * (s["stars"] - 1) / 4
        learning.add_star_example(s["components"], s["stars"])
    elif name == "hide_shot":
        s = next(s for s in p["shots"] if s["id"] == args["shot_id"])
        s["hidden"] = bool(args["hidden"])
    else:
        raise ValueError(f"Unknown tool {name}")
    return "ok. Updated timeline: " + json.dumps(draft.summarize(p["timeline"], p))


def chat(p: dict, message: str, regen) -> str:
    """Run one user turn. Mutates p (timeline etc.). Returns the assistant's reply text."""
    try:
        client = anthropic.Anthropic()
    except Exception as e:
        return f"Chat is unavailable: {e}. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart."

    history = []
    for m in p["chat"][-20:]:
        history.append({"role": m["role"], "content": m["text"]})
    messages = history + [{"role": "user", "content": f"<state>{_state(p)}</state>\n\n{message}"}]
    reply = ""
    try:
        for _ in range(10):
            resp = client.beta.messages.create(
                model=config.CLAUDE_MODEL,
                max_tokens=16000,
                system=SYSTEM,
                tools=TOOLS,
                messages=messages,
                output_config={"effort": "medium"},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
            if resp.stop_reason == "refusal":
                reply = "Sorry, I couldn't process that request."
                break
            messages.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason == "pause_turn":
                continue
            tool_uses = [b for b in resp.content if b.type == "tool_use"]
            text = "".join(b.text for b in resp.content if b.type == "text").strip()
            if not tool_uses:
                reply = text or "Done."
                break
            results = []
            for tu in tool_uses:
                try:
                    out = _execute(p, tu.name, dict(tu.input), regen)
                    results.append({"type": "tool_result", "tool_use_id": tu.id, "content": out})
                except Exception as e:
                    results.append({"type": "tool_result", "tool_use_id": tu.id, "content": f"Error: {e}",
                                    "is_error": True})
            messages.append({"role": "user", "content": results})
        else:
            reply = "I made several changes; take a look."
    except anthropic.AuthenticationError:
        return "Chat is unavailable: the Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY and restart."
    except anthropic.RateLimitError:
        return "Claude is rate-limited right now; try again in a minute."
    except anthropic.APIStatusError as e:
        return f"Claude API error ({e.status_code}): {e.message}"
    except anthropic.APIConnectionError:
        return "Couldn't reach the Claude API. Check your internet connection."
    except TypeError as e:  # raised by the SDK when no credentials can be resolved
        return f"Chat is unavailable: {e}. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart."
    p["chat"].append({"role": "user", "text": message})
    p["chat"].append({"role": "assistant", "text": reply})
    return reply
