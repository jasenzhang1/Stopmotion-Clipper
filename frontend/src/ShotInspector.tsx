import { useEffect, useRef, useState } from "react";
import { fileUrl, Project, proxyEnd, ServeMarksPatch, Shot, TYPE_LABEL } from "./api";
import ClipBar from "./ClipBar";
import Speed from "./Speed";
import { FRAME } from "./ClipTrim";
import { isTyping, useHotkeys } from "./hotkeys";

/**
 * A library shot on its own, outside the reel. Same controls as a reel clip (ClipBar): scrub, step frames,
 * Ctrl+drag or "Contact here" to set the ball contact (the shot's nudge).
 *
 * Keys: Space play/pause · [ ] frame · ←/→ 0.25s · M or Ctrl+Enter contact here · , . move contact a
 * frame (Shift 0.1s) · Esc back to the reel.
 */
export default function ShotInspector({ project, shot, onNudge, onWindow, onServeMarks, onClose, enabled, speed, onSpeed }: {
  project: Project; shot: Shot; onNudge: (shotId: string, value: number) => Promise<void>;
  onWindow: (shotId: string, after: number) => Promise<void>;
  onServeMarks: (shotId: string, b: ServeMarksPatch) => Promise<void>;
  onClose: () => void; enabled: boolean;
  speed: number; onSpeed: (v: number) => void;
}) {
  const vid = useRef<HTMLVideoElement>(null);
  const [vt, setVt] = useState(0); // video time (seconds into the proxy file)
  const [paused, setPaused] = useState(false);
  const [want, setWant] = useState<number | null>(null); // nudge sent but not back yet
  const n = want ?? shot.nudge ?? 0;

  const w0 = shot.proxy.start;
  const w1 = proxyEnd(shot);
  const min = w0 - shot.t;
  const max = w1 - shot.t;
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const contactAbs = shot.t + n;
  const nowAbs = w0 + vt;

  useEffect(() => { setWant(null); setPaused(false); }, [shot.id]);

  // Keep the playhead readout smooth while playing.
  useEffect(() => {
    if (paused) return;
    let raf = 0;
    const tick = () => { if (vid.current) setVt(vid.current.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paused]);

  const seekAbs = (abs: number) => {
    const v = vid.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min((v.duration || w1 - w0) - 0.001, abs - w0));
    setVt(v.currentTime);
  };
  const pause = () => { vid.current?.pause(); setPaused(true); };
  const toggle = () => {
    const v = vid.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); setPaused(false); } else pause();
  };
  const step = (d: number) => { pause(); seekAbs(nowAbs + d); };

  const send = (value: number) => {
    const v = Math.round(clamp(value) / FRAME) * FRAME;
    setWant(v);
    onNudge(shot.id, v).finally(() => setWant((cur) => (cur === v ? null : cur)));
  };
  const setContact = (v: number, live: boolean) => {
    pause();
    if (live) setWant(v); else send(v);
    seekAbs(shot.t + v); // show the contact frame
  };
  const markContact = () => setContact(nowAbs - shot.t, false);
  const moveContact = (d: number) => setContact(clamp(n + d), false);

  useHotkeys((e) => {
    switch (e.key) {
      case " ": toggle(); return true;
      case "[": step(-FRAME); return true;
      case "]": step(FRAME); return true;
      case "ArrowLeft": step(-0.25); return true;
      case "ArrowRight": step(0.25); return true;
      case "m": case "M": markContact(); return true;
      case ",": case "<": moveContact(e.shiftKey ? -0.1 : -FRAME); return true;
      case ".": case ">": moveContact(e.shiftKey ? 0.1 : FRAME); return true;
      case "Escape": onClose(); return true;
    }
  }, enabled);

  // Ctrl+Enter (useHotkeys leaves Ctrl combos alone).
  const ctrlEnter = useRef(markContact);
  ctrlEnter.current = markContact;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || isTyping(e.target as HTMLElement, e.key)) return;
      e.preventDefault();
      ctrlEnter.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [enabled]);

  const onContact = Math.abs(nowAbs - contactAbs) < FRAME / 2;
  useEffect(() => { if (vid.current) vid.current.playbackRate = speed; }, [speed]);
  const pictureDrag = useRef<((e: React.PointerEvent) => void) | null>(null);
  return (
    <>
      <div className="screen">
        <video ref={vid} key={shot.proxy.file} className="on inspect" src={fileUrl(project.id, shot.proxy.file)}
          poster={fileUrl(project.id, shot.thumb)} muted playsInline autoPlay loop
          onLoadedMetadata={(e) => { e.currentTarget.currentTime = Math.max(0, contactAbs - w0 - 1); e.currentTarget.playbackRate = speed; }}
          onSeeked={(e) => setVt(e.currentTarget.currentTime)}
          title="Click to pause/play · Ctrl+drag to move the ball contact"
          onPointerDown={(e) => { if ((e.ctrlKey || e.metaKey) && pictureDrag.current) { pause(); pictureDrag.current(e); } }}
          onClick={(e) => { if (!e.ctrlKey && !e.metaKey) toggle(); }} />
        <div className="overlay">{shot.name ?? TYPE_LABEL[shot.type]} {"★".repeat(shot.stars)}</div>
        {onContact && <div className="overlay contact-flag">● contact</div>}
      </div>
      <ClipBar extra={<Speed value={speed} onChange={onSpeed} />} shot={{ ...shot, nudge: n }} dragRef={pictureDrag} nowAbs={nowAbs} playing={!paused} onTogglePlay={toggle}
        onStep={(d) => step(d * FRAME)} onScrub={(abs) => { pause(); seekAbs(abs); }} onContact={setContact}
        onServeMarks={(b) => onServeMarks(shot.id, b)}
        onWindow={(after) => { const at = nowAbs; return onWindow(shot.id, after).then(() => { pause(); requestAnimationFrame(() => seekAbs(at)); }); }} />
    </>
  );
}
