import { MutableRefObject, ReactNode, useEffect, useRef, useState } from "react";
import { proxyEnd, ServeMarksPatch, Shot, typeGroup } from "./api";
import { FRAME } from "./ClipTrim";

const SPANS = [2, 5, 10]; // seconds shown after the contact

const W = 300; // px of the strip
const sec = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}s`;

/**
 * The controls under the preview for one shot, the same whether it's a clip in the reel or a library shot
 * on its own. The strip is the shot's footage (preview clip) left to right:
 *   dashed line = contact the app detected · red line = ball contact (lands on the beat) · white = playhead
 *   green box (reel clips) = the part that plays in the clip.
 * Drag the strip to scrub; Ctrl+drag (strip or picture) to move the ball contact; [ ] step a frame;
 * M marks the frame on screen as the contact.
 */
export default function ClipBar({ shot, nowAbs, box, playing, onTogglePlay, onStep, onScrub, onContact, onWindow, onServeMarks,
  extra, dragRef }: {
  shot: Shot;
  /** Footage time on screen (seconds in the source video), or null when the playhead isn't on this shot. */
  nowAbs: number | null;
  /** Reel clips: the stretch of footage the clip plays [from, to]. */
  box?: [number, number];
  playing: boolean; onTogglePlay: () => void; onStep: (frames: number) => void;
  /** Show this footage time (clamped by the caller to what can be shown). */
  onScrub: (abs: number) => void;
  /** Set the ball contact (seconds relative to the detected hit). `live` = mid-drag. */
  onContact: (nudge: number, live: boolean) => void;
  /** Make the shot's footage run at least `after` seconds past the contact (cuts a longer preview if needed). */
  onWindow: (after: number) => Promise<void>;
  /** Serves: detect or set the toss / ball-apex moments. */
  onServeMarks: (b: ServeMarksPatch) => Promise<void>;
  extra?: ReactNode;
  /** Lets the picture start the same Ctrl+drag. */
  dragRef?: MutableRefObject<((e: React.PointerEvent) => void) | null>;
}) {
  const [after, setAfter] = useState(2);
  const [loading, setLoading] = useState(false);
  const pickSpan = async (a: number) => {
    setAfter(a);
    setLoading(true);
    try { await onWindow(a); } finally { setLoading(false); }
  };
  const [drag, setDrag] = useState<number | null>(null);
  const n = drag ?? shot.nudge ?? 0;
  // The strip shows from 1 s before the contact to `after` seconds past it (as far as the footage goes).
  // The view holds still while you drag (so the red line visibly moves); it re-centres only for a new shot
  // or when the contact ends up out of view.
  const [anchor, setAnchor] = useState(shot.t + (shot.nudge ?? 0));
  useEffect(() => { setAnchor(shot.t + (shot.nudge ?? 0)); }, [shot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const isServe = typeGroup(shot.type) === "serve";
  const marks = shot.serve_marks;
  const [detecting, setDetecting] = useState(false);
  useEffect(() => { // first look at a serve: find the toss and the top of the ball's arc
    if (!isServe || marks) return;
    setDetecting(true);
    onServeMarks({ detect: true }).finally(() => setDetecting(false));
  }, [shot.id, isServe]); // eslint-disable-line react-hooks/exhaustive-deps
  const w0 = Math.max(shot.proxy.start, Math.min(anchor - 1, isServe && marks?.toss != null ? marks.toss - 0.3 : Infinity));
  const w1 = Math.max(w0 + 0.5, Math.min(proxyEnd(shot), anchor + after));
  const min = shot.proxy.start - shot.t;
  const max = proxyEnd(shot) - shot.t;
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)) / FRAME) * FRAME;
  const px = (abs: number) => ((abs - w0) / (w1 - w0)) * W;
  const contactAbs = shot.t + n;
  useEffect(() => {
    if (drag === null && (contactAbs < w0 || contactAbs > w1)) setAnchor(contactAbs);
  }, [drag, contactAbs, w0, w1]);
  const strip = useRef<HTMLDivElement>(null);

  /** Ctrl+drag: move the ball contact; the picture follows the contact frame. Shift = 1/4 speed. */
  const startContactDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const base = shot.nudge ?? 0;
    let v = base, last = 0, moved = false;
    onScrub(shot.t + base);
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      moved = true;
      v = clamp(base + ((ev.clientX - x0) / W) * (w1 - w0) * (ev.shiftKey ? 0.25 : 1));
      setDrag(v);
      const now = performance.now();
      if (now - last > 120) { last = now; onContact(v, true); }
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (moved) onContact(v, false);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  if (dragRef) dragRef.current = startContactDrag;

  /** Plain drag on the strip scrubs through the footage. */
  const startScrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const r = strip.current!.getBoundingClientRect();
    const at = (x: number) => onScrub(w0 + (Math.max(0, Math.min(W, x - r.left)) / W) * (w1 - w0));
    at(e.clientX);
    const mv = (ev: PointerEvent) => at(ev.clientX);
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const onContactFrame = nowAbs !== null && Math.abs(nowAbs - contactAbs) < FRAME / 2;
  return (
    <div className="transport clip-bar">
      <button className="primary" onClick={onTogglePlay} style={{ minWidth: 80 }} title="Space">
        {playing ? "⏸ Pause" : "▶ Play"}
      </button>
      <span className="seg">
        <button title="Previous frame ([)" onClick={() => onStep(-1)}>◂</button>
        <button title="Next frame (])" onClick={() => onStep(1)}>▸</button>
      </span>
      <div ref={strip} className="trim-strip" style={{ width: W, cursor: "pointer" }}
        title="Drag to scrub · Ctrl+drag to move the ball contact"
        onPointerDown={(e) => (e.ctrlKey || e.metaKey ? startContactDrag(e) : startScrub(e))}>
        {box && <div className="trim-win static" style={{ left: px(box[0]), width: Math.max(4, px(box[1]) - px(box[0])) }} />}
        <div className="trim-hit" style={{ left: px(shot.t) }} title="Contact the app detected (from the sound)" />
        <div className="trim-beat" style={{ left: px(contactAbs) }} title="Ball contact: this frame lands on the beat" />
        {isServe && marks?.toss != null && <div className="trim-mark toss" style={{ left: px(marks.toss) }} title="Ball tossed" />}
        {isServe && marks?.apex != null && <div className="trim-mark apex" style={{ left: px(marks.apex) }} title="Ball at the top of its arc" />}
        {nowAbs !== null && <div className="trim-head" style={{ left: px(nowAbs) }} />}
      </div>
      <button className="contact-btn" disabled={nowAbs === null || onContactFrame}
        onClick={() => nowAbs !== null && onContact(clamp(nowAbs - shot.t), false)}
        title="Make the frame on screen the ball contact; it lands on the beat (M)">Contact here</button>
      {isServe && (
        <span className="seg">
          <button className="toss-btn" disabled={nowAbs === null} onClick={() => nowAbs !== null && onServeMarks({ toss: nowAbs })}
            title="Mark the frame on screen as the moment the ball is tossed">Toss here</button>
          <button className="apex-btn" disabled={nowAbs === null} onClick={() => nowAbs !== null && onServeMarks({ apex: nowAbs })}
            title="Mark the frame on screen as the ball at the top of its arc">Apex here</button>
        </span>
      )}
      {isServe && (detecting ? <span className="muted">Finding toss…</span>
        : nowAbs !== null && marks?.toss != null && Math.abs(nowAbs - marks.toss) < FRAME * 1.5 ? <span className="mark-flag toss">● toss</span>
        : nowAbs !== null && marks?.apex != null && Math.abs(nowAbs - marks.apex) < FRAME * 1.5 ? <span className="mark-flag apex">● apex</span>
        : null)}
      <span className="muted" style={{ minWidth: 70 }}>{Math.abs(n) < 1e-3 ? "" : `moved ${sec(n)}`}</span>
      {Math.abs(shot.nudge ?? 0) > 1e-3 && (
        <button onClick={() => { onContact(0, false); onScrub(shot.t); }} title="Back to the contact the app detected">Reset</button>
      )}
      <select value={after} disabled={loading} onChange={(e) => pickSpan(+e.target.value)}
        title="How much footage after the contact to show">
        {SPANS.map((s) => <option key={s} value={s}>{loading && s === after ? "Loading…" : `${s}s after`}</option>)}
      </select>
      {extra}
    </div>
  );
}
