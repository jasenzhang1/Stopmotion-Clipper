import { useState } from "react";
import { proxyEnd, Shot, Slot } from "./api";

export const NUDGE_MAX = 0.75; // must match the backend's limit
export const FRAME = 1 / 30;
export const POST = 2.0; // preview clips run to 2 s after the detected hit (config.SHOT_PROXY_WINDOW)
const W = 300;

const sec = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}s`;

/** How far a clip's footage can slide while staying inside its preview clip. */
export function nudgeBounds(shot: Shot, slot: Slot) {
  const dur = slot.end - slot.start;
  return {
    min: shot.proxy.start - shot.t + slot.lead,
    max: proxyEnd(shot) - shot.t - dur + slot.lead,
  };
}

/**
 * Slip editor for the selected clip. The clip's place on the timeline is locked to the beat, so this
 * slides *which footage* plays inside it: its start and end points move together.
 */
export default function ClipTrim({ shot, slot, time, onNudge, onStepFrame, onMarkContact }: {
  shot: Shot; slot: Slot; time: number; onNudge: (nudge: number) => void;
  onStepFrame: (d: number) => void; onMarkContact: () => void;
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

  const inClip = time >= slot.start && time < slot.end;
  const onContact = Math.abs(time - slot.contact) < FRAME / 2;

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
        <div className="trim-hit" style={{ left: px(shot.t) }} title="Contact the app detected (from the sound)" />
        <div className="trim-win" style={{ left: px(src), width: Math.max(4, px(src + dur) - px(src)) }} onPointerDown={onDown}>
          <div className="trim-beat" style={{ left: px(src + slot.lead) - px(src) }} title="Ball contact: lands on the beat" />
        </div>
        {time >= slot.start && time < slot.end && (
          <div className="trim-head" style={{ left: px(src + (time - slot.start)) }} title="Playhead" />
        )}
      </div>
      <span className="seg">
        <button title="Earlier footage by 0.1s (Shift+,)" disabled={n <= min + 1e-4} onClick={() => step(-0.1)}>«</button>
        <button title="Earlier footage by one frame (,)" disabled={n <= min + 1e-4} onClick={() => step(-FRAME)}>‹</button>
        <button title="Later footage by one frame (.)" disabled={n >= max - 1e-4} onClick={() => step(FRAME)}>›</button>
        <button title="Later footage by 0.1s (Shift+.)" disabled={n >= max - 1e-4} onClick={() => step(0.1)}>»</button>
      </span>
      <span className="muted" style={{ minWidth: 64 }}>{Math.abs(n) < 1e-3 ? "" : `nudged ${sec(n)}`}</span>
      <span className="seg">
        <button title="Previous frame ([)" onClick={() => onStepFrame(-1)}>◂</button>
        <button title="Next frame (])" onClick={() => onStepFrame(1)}>▸</button>
      </span>
      <button className="contact-btn" disabled={!inClip || onContact} onClick={onMarkContact}
        title={inClip ? "Make the frame in the preview the ball contact; it moves onto the beat (M or Ctrl+Enter)" : "Move the playhead into this clip first"}>
        Contact here
      </button>
      {Math.abs(saved) > 1e-3 && <button onClick={() => onNudge(0)} title="Back to the detected hit">Reset</button>}
    </div>
  );
}
