import { useEffect, useRef, useState } from "react";
import { api, fmtTime, Project, songUrl } from "./api";
import { useHotkeys, useWheelZoom } from "./hotkeys";

type Handle = "start" | "drop" | "end" | null;

export default function SongStep({ project, onSaved, onNext, ready }: {
  project: Project; onSaved: (p: Project) => void; onNext: () => void; ready: boolean;
}) {
  const m = project.music!;
  const sec = project.section!;
  const [start, setStart] = useState(sec.start);
  const [drop, setDrop] = useState(sec.drop);
  const [end, setEnd] = useState(sec.end);
  const [pps, setPps] = useState(8);
  const [head, setHead] = useState(sec.start);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Once saved, the selection is locked until the user chooses to change it (or undoes the save).
  const [locked, setLocked] = useState(!sec.suggested);
  const [justSaved, setJustSaved] = useState(false);
  const [prev, setPrev] = useState<{ start: number; drop: number; end: number } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const drag = useRef<Handle>(null);
  const H = 180;

  useEffect(() => {
    if (wrap.current) setPps(Math.max(4, (wrap.current.clientWidth - 4) / m.duration));
  }, [m.duration]);

  const snap = (t: number) => {
    const i = Math.round((t - m.beats[0]) / m.period);
    return m.beats[Math.max(0, Math.min(m.beats.length - 1, i))];
  };
  const dropIdx = Math.round((drop - m.beats[0]) / m.period);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const W = Math.ceil(m.duration * pps);
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1a1c22";
    g.fillRect(0, 0, W, H);
    // selection
    g.fillStyle = "rgba(212,245,66,0.08)";
    g.fillRect(start * pps, 0, (end - start) * pps, H);
    g.fillStyle = "rgba(212,245,66,0.14)";
    g.fillRect(start * pps, 0, (drop - start) * pps, H);
    // beats
    m.beats.forEach((b, i) => {
      const down = ((i - dropIdx) % 4 + 4) % 4 === 0;
      if (!down && pps < 20) return;
      g.fillStyle = down ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.05)";
      g.fillRect(Math.round(b * pps), 0, 1, H);
    });
    // waveform
    const mid = H / 2;
    g.fillStyle = "#6c7280";
    const step = m.peaks_dt * pps;
    for (let i = 0; i < m.peaks.length; i++) {
      const x = i * step;
      const h = m.peaks[i] * (H / 2 - 10);
      const inSel = x >= start * pps && x <= end * pps;
      g.fillStyle = inSel ? "#c9d48a" : "#4d525e";
      g.fillRect(x, mid - h, Math.max(1, step), h * 2);
    }
    // markers
    const mark = (t: number, color: string, label: string) => {
      g.fillStyle = color;
      g.fillRect(t * pps - 1, 0, 3, H);
      g.font = "bold 11px system-ui";
      g.fillText(label, t * pps + 5, 14);
    };
    mark(start, "#ffffff", "START");
    mark(drop, "#d4f542", "DROP");
    mark(end, "#8b909c", "END");
    g.fillStyle = "#ff6b6b";
    g.fillRect(head * pps, 0, 1, H);
  }, [m, pps, start, drop, end, head, dropIdx]);

  // playhead follows audio
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (audio.current) setHead(audio.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const timeAt = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return Math.max(0, Math.min(m.duration, (e.clientX - r.left) / pps));
  };

  const [cursor, setCursor] = useState("pointer");
  const markerAt = (t: number) => {
    const near = (x: number) => Math.abs(x - t) * pps < 8;
    return locked ? null : near(drop) ? "drop" : near(start) ? "start" : near(end) ? "end" : null;
  };
  const onDown = (e: React.MouseEvent) => {
    const t = timeAt(e);
    drag.current = markerAt(t);
    if (drag.current) setCursor("grabbing");
    if (!drag.current) {
      setHead(t);
      if (audio.current) audio.current.currentTime = t;
    }
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current) { setCursor(markerAt(timeAt(e)) ? "grab" : "pointer"); return; }
    const t = snap(timeAt(e));
    if (drag.current === "start") setStart(Math.min(t, drop - 4 * m.period));
    if (drag.current === "drop") setDrop(Math.max(t, start + 4 * m.period));
    if (drag.current === "end") setEnd(Math.max(t, drop + m.period));
  };

  const play = (from?: number) => {
    const a = audio.current!;
    if (playing && from === undefined) { a.pause(); setPlaying(false); return; }
    a.currentTime = from ?? head;
    a.play();
    setPlaying(true);
  };

  const save = async (autoDrop: boolean) => {
    setBusy(true);
    setMsg(null);
    const before = { start: sec.start, drop: sec.drop, end: sec.end };
    try {
      const p = await api.section(project.id, { start, end, drop: autoDrop ? null : drop });
      setDrop(p.section!.drop);
      onSaved(p);
      setPrev(before);
      setLocked(true);
      setJustSaved(true);
      setMsg(autoDrop ? "Drop detected automatically." : null);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!prev) return;
    setBusy(true);
    setMsg(null);
    try {
      const p = await api.section(project.id, prev);
      setStart(p.section!.start);
      setDrop(p.section!.drop);
      setEnd(p.section!.end);
      onSaved(p);
      setPrev(null);
      setJustSaved(false);
      setLocked(false);
      setMsg("Undone: back to your previous selection. Adjust it and save again.");
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const seek = (t: number) => {
    const c = Math.max(0, Math.min(m.duration, t));
    setHead(c);
    if (audio.current) audio.current.currentTime = c;
  };

  const zoomMax = Math.min(120, Math.floor(32000 / m.duration));
  const zoomBy = useWheelZoom(wrap, canvas, pps, setPps, 2, zoomMax);

  useHotkeys((e) => {
    const step = e.shiftKey ? 4 * m.period : m.period;
    switch (e.key) {
      case " ": play(); return true;
      case "ArrowLeft": seek(head - step); return true;
      case "ArrowRight": seek(head + step); return true;
      case "Home": seek(start); return true;
      case "End": seek(end); return true;
      case "=": case "+": zoomBy(1.25); return true;
      case "-": case "_": zoomBy(0.8); return true;
    }
  });

  const unlock = () => { setLocked(false); setJustSaved(false); setMsg(null); };

  const beats = (a: number, b: number) => Math.round((b - a) / m.period);
  const buildBeats = beats(start, drop);
  const dropBeats = beats(drop, end);
  const totalBeats = beats(start, end);
  const bars = Math.round(buildBeats / 4);
  const dirty = Math.abs(start - sec.start) > 1e-3 || Math.abs(drop - sec.drop) > 1e-3 || Math.abs(end - sec.end) > 1e-3;
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => { if (dirty && !busy && !locked) save(false); };
  useEffect(() => {
    const onSave = () => saveRef.current();
    window.addEventListener("app-save", onSave);
    return () => window.removeEventListener("app-save", onSave);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const stat = (label: string, value: string, sub?: string) => (
    <div className="stat"><span className="stat-label">{label}</span><b>{value}</b>{sub && <span className="muted">{sub}</span>}</div>
  );

  return (
    <div className="song-step">
      <div className="row">
        <h2 style={{ margin: 0 }}>{project.song?.name}</h2>
        <span className="muted">{m.bpm.toFixed(1)} BPM · {fmtTime(m.duration)}</span>
        <span className="spacer" />
        <span className="muted">Zoom</span>
        <input type="range" min={2} max={zoomMax} value={pps}
          onChange={(e) => setPps(+e.target.value)} />
      </div>
      <div className="stats-row">
        {stat("Selection", `${(end - start).toFixed(1)}s`, `${totalBeats} beats · ${fmtTime(start)}–${fmtTime(end)}`)}
        {stat("Build-up", `${(drop - start).toFixed(1)}s`, `${buildBeats} beats · ${bars} bars`)}
        {stat("Drop section", `${(end - drop).toFixed(1)}s`, `${dropBeats} beats · ${Math.round(dropBeats / 4)} bars`)}
        {stat("Tempo", `${m.bpm.toFixed(1)} BPM`, `${(m.period * 1000).toFixed(0)} ms per beat`)}
      </div>
      <div className={`wave-wrap ${locked ? "locked" : ""}`} ref={wrap}>
        <canvas ref={canvas} style={{ cursor: locked ? "default" : cursor, height: H, width: Math.ceil(m.duration * pps) }} onMouseDown={onDown} onMouseMove={onMove}
          onMouseUp={(e) => { drag.current = null; onMove(e); }} onMouseLeave={() => { drag.current = null; setCursor("pointer"); }} />
      </div>
      <div className="row">
        <button onClick={() => play()}>{playing ? "⏸ Pause" : "▶ Play from playhead"}</button>
        <button onClick={() => play(start)}>▶ Play build-up</button>
        <button onClick={() => play(Math.max(0, drop - 4 * m.period))}>▶ Hear the drop</button>
        <span className="spacer" />
        {locked ? (
          <button disabled={busy} onClick={unlock}>✎ Change selection</button>
        ) : (
          <>
            <button disabled={busy} onClick={() => save(true)} title="Find the biggest energy jump between START and END">
              Auto-detect drop
            </button>
            <button className="primary" disabled={busy || (!dirty && !sec.suggested)} onClick={() => save(false)}>
              Save section
            </button>
          </>
        )}
        <button className="primary" disabled={!ready || dirty} onClick={onNext}>
          {ready ? "Next: review shots →" : "Waiting for footage…"}
        </button>
      </div>
      {justSaved && (
        <div className="saved-note">
          <span className="check">✓</span>
          <span>
            <b>Section saved.</b> {bars} bar build-up ({(drop - start).toFixed(1)}s), drop at {fmtTime(drop)}.
            {msg && <> {msg}</>}
          </span>
          <span className="spacer" />
          {prev && <button disabled={busy} onClick={undo}>↶ Undo</button>}
          <button disabled={busy} onClick={unlock}>✎ Change selection</button>
        </div>
      )}
      {msg && !justSaved && <div className="muted">{msg}</div>}
      <audio ref={audio} src={songUrl(project.id)} preload="auto" onPause={() => setPlaying(false)} />
    </div>
  );
}
