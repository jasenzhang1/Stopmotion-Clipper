import { useState } from "react";
import { Shot, Slot } from "./api";

export const NUDGE_MAX = 0.75; // must match the backend's limit
export const FRAME = 1 / 30;
const POST = 2.0; // preview clips run to 2 s after the detected hit (config.SHOT_PROXY_WINDOW)
const W = 300;

const sec = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}s`;

/** How far a clip's footage can slide while staying inside its preview clip. */
export function nudgeBounds(shot: Shot, slot: Slot) {
  const dur = slot.end - slot.start;
  return {
    min: Math.max(-NUDGE_MAX, shot.proxy.start - shot.t + slot.lead),
    max: Math.min(NUDGE_MAX, POST - dur + slot.lead),
  };
}

/**
 * Slip editor for the selected clip. The clip's place on the timeline is locked to the beat, so this
 * slides *which footage* plays inside it: its start and end points move together.
 */
export default function ClipTrim({ shot, slot, onNudge }: {
  shot: Shot; slot: Slot; onNudge: (nudge: number) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const saved = shot.nudge ?? 0;
  const n = drag ?? saved;
  const { min, max } = nudgeBounds(shot, slot);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const dur = slot.end - slot.start;

  const w0 = shot.proxy.start;
  const w1 = shot.t + POST;
  const px = (t: number) => ((t - w0) / (w1 - w0)) * W;
  const src = shot.t + n - slot.lead; // what the backend computes (it clamps the same way)
  const startRel = src - shot.t;
  const endRel = src + dur - shot.t;

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    let v = saved;
    const move = (ev: PointerEvent) => {
      v = clamp(saved + ((ev.clientX - x0) / W) * (w1 - w0));
      setDrag(v);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (Math.abs(v - saved) > 1e-3) onNudge(v);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const step = (d: number) => onNudge(clamp(saved + d));

  return (
    <div className="clip-trim">
      <b>{slot.label ?? "Clip"}</b>
      <span className="muted" title="Relative to the detected hit">
        shows {sec(startRel)} → {sec(endRel)}
      </span>
      <div className="trim-strip" style={{ width: W }}
        title="Drag the window to choose which moment of the footage plays. The bright line lands on the beat.">
        <div className="trim-hit" style={{ left: px(shot.t) }} title="Detected hit" />
        <div className="trim-win" style={{ left: px(src), width: Math.max(4, px(src + dur) - px(src)) }} onPointerDown={onDown}>
          <div className="trim-beat" style={{ left: px(src + slot.lead) - px(src) }} />
        </div>
      </div>
      <span className="seg">
        <button title="Earlier footage by 0.1s (Shift+,)" disabled={n <= min + 1e-4} onClick={() => step(-0.1)}>«</button>
        <button title="Earlier footage by one frame (,)" disabled={n <= min + 1e-4} onClick={() => step(-FRAME)}>‹</button>
        <button title="Later footage by one frame (.)" disabled={n >= max - 1e-4} onClick={() => step(FRAME)}>›</button>
        <button title="Later footage by 0.1s (Shift+.)" disabled={n >= max - 1e-4} onClick={() => step(0.1)}>»</button>
      </span>
      <span className="muted" style={{ minWidth: 64 }}>{Math.abs(n) < 1e-3 ? "" : `nudged ${sec(n)}`}</span>
      {Math.abs(saved) > 1e-3 && <button onClick={() => onNudge(0)} title="Back to the detected hit">Reset</button>}
    </div>
  );
}
