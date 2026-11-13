import { useEffect, useMemo, useRef, useState } from "react";
import { fileUrl, fmtTime, Project, ServeMarksPatch, Shot, Slot, songUrl, Timeline, TYPE_CODE } from "./api";
import ClipBar from "./ClipBar";
import ShotInspector from "./ShotInspector";
import Speed from "./Speed";

interface Item { key: string; url: string; offset: number; start: number; end: number; label: string; poster?: string }

export function buildItems(p: Project, tl: Timeline): Item[] {
  const shots = Object.fromEntries(p.shots.map((s) => [s.id, s]));
  const items: Item[] = [];
  for (const b of tl.bars) {
    for (const s of b.slots) {
      const sh = shots[s.shot_id];
      if (!sh) continue;
      items.push({
        key: s.id, url: fileUrl(p.id, sh.proxy.file), offset: Math.max(0, s.src_start - sh.proxy.start),
        start: s.start, end: s.end, label: `${sh.name ?? TYPE_CODE[sh.type]} ${"★".repeat(sh.stars)}`, poster: fileUrl(p.id, sh.thumb),
      });
    }
  }
  if (tl.rally?.shot_id && tl.rally.proxy && tl.rally.end > tl.rally.start) {
    const sh = shots[tl.rally.shot_id];
    items.push({
      key: `rally-${tl.rally.shot_id}`, url: fileUrl(p.id, tl.rally.proxy.file), offset: Math.max(0, tl.rally.src_start - tl.rally.proxy.start),
      start: tl.rally.start, end: tl.rally.end, label: `DROP · ${sh ? sh.name ?? TYPE_CODE[sh.type] : "footage"}`,
      poster: sh ? fileUrl(p.id, sh.thumb) : undefined,
    });
  } else if (tl.rally) {
    const r = p.rallies.find((x) => x.id === tl.rally!.rally_id);
    if (r) {
      items.push({
        key: `rally-${r.id}`, url: fileUrl(p.id, r.proxy.file), offset: Math.max(0, tl.rally.src_start - r.proxy.start),
        start: tl.rally.start, end: tl.rally.end, label: `RALLY · ${tl.rally.n_hits} shots`,
      });
    }
  }
  return items;
}

const findItem = (items: Item[], t: number) => items.findIndex((it) => t >= it.start && t < it.end);

export default function Preview({ project, timeline, time, setTime, playing, setPlaying, inspect, onInspect, onNudge, keys,
  clip, onStepFrame, onWindow, onServeMarks }: {
  project: Project; timeline: Timeline; time: number; setTime: (t: number) => void;
  playing: boolean; setPlaying: (b: boolean) => void;
  /** Library shot being looked at on its own (instead of the reel), or null. */
  inspect: Shot | null; onInspect: (shotId: string | null) => void;
  onNudge: (shotId: string, value: number) => Promise<void>;
  /** Hotkeys on (off while a dialog is open). */
  keys: boolean;
  /** The selected reel clip: gets the same controls as a library shot. */
  clip: Slot | null; onStepFrame: (frames: number) => void;
  onWindow: (shotId: string, after: number) => Promise<void>;
  onServeMarks: (shotId: string, b: ServeMarksPatch) => Promise<void>;
}) {
  const [dropping, setDropping] = useState(false);
  const items = useMemo(() => buildItems(project, timeline), [project, timeline]);
  const vids = useRef(new Map<string, HTMLVideoElement>());
  const audio = useRef<HTMLAudioElement>(null);
  const cur = useRef(-1);
  const [active, setActive] = useState(-1);

  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
    vids.current.forEach((v) => { v.playbackRate = speed; });
  }, [speed, items]);

  const show = (idx: number, t: number, play: boolean) => {
    if (idx !== cur.current) {
      const prev = items[cur.current];
      const pv = prev && vids.current.get(prev.key);
      if (pv) { pv.pause(); pv.currentTime = prev.offset; } // re-arm for the next pass
      cur.current = idx;
      setActive(idx);
    }
    const it = items[idx];
    const v = it && vids.current.get(it.key);
    if (!v) return;
    const want = it.offset + (t - it.start);
    if (Math.abs(v.currentTime - want) > (play ? 0.06 : 0.01)) v.currentTime = want;
    v.playbackRate = speed;
    if (play && v.paused) v.play().catch(() => {});
    if (!play && !v.paused) v.pause();
  };

  const blank = () => {
    if (cur.current === -1) return;
    const prev = items[cur.current];
    const pv = prev && vids.current.get(prev.key);
    if (pv) { pv.pause(); pv.currentTime = prev.offset; }
    cur.current = -1;
    setActive(-1);
  };

  // Scrubbing while paused
  useEffect(() => {
    if (playing) return;
    const idx = findItem(items, time);
    if (idx >= 0) show(idx, time, false);
    else blank();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, items, playing]);

  // Playback loop: the song is the clock.
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    if (!playing) { a.pause(); vids.current.forEach((v) => v.pause()); return; }
    const from = time >= timeline.reel_start && time < timeline.reel_end - 0.05 ? time : timeline.reel_start;
    a.currentTime = from;
    a.playbackRate = speed;
    a.play().catch(() => setPlaying(false));
    let raf = 0;
    const tick = () => {
      const t = a.currentTime;
      if (t >= timeline.reel_end) {
        a.pause();
        setPlaying(false);
        setTime(timeline.reel_start);
        return;
      }
      const idx = findItem(items, t);
      if (idx >= 0) show(idx, t, true);
      else blank(); // no clip here: the reel is black
      setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, items, timeline.reel_start, timeline.reel_end]);

  const it = items[active];
  const clipShot = clip ? project.shots.find((s) => s.id === clip.shot_id) ?? null : null;
  const rel = Math.max(0, time - timeline.reel_start);
  return (
    <div className={`preview ${dropping ? "drop-target" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("text/plain")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={(e) => {
        setDropping(false);
        const d = e.dataTransfer.getData("text/plain");
        if (!d.startsWith("shot:")) return;
        e.preventDefault();
        onInspect(d.slice(5));
      }}>
      {inspect && (
        <ShotInspector project={project} shot={inspect} onNudge={onNudge} onWindow={onWindow} onServeMarks={onServeMarks} onClose={() => onInspect(null)} enabled={keys}
          speed={speed} onSpeed={setSpeed} />
      )}
      {/* The reel stays mounted (hidden) while a shot is inspected, so its videos don't reload. */}
      <div className="screen" style={inspect ? { display: "none" } : undefined}>
        {it?.poster && <img className="poster" src={it.poster} alt="" />}
        {items.map((x, i) => (
          <video key={x.key} src={x.url} muted playsInline preload="auto" className={i === active ? "on" : ""}
            ref={(el) => { if (el) vids.current.set(x.key, el); else vids.current.delete(x.key); }}
            onLoadedMetadata={(e) => { if (i !== cur.current) e.currentTarget.currentTime = x.offset; }} />
        ))}
        {it && <div className="overlay">{it.label}</div>}
      </div>
      {!inspect && clipShot && clip ? (() => {
        const inClip = time >= clip.start && time < clip.end;
        const toTime = (abs: number) => Math.max(clip.start, Math.min(clip.end - 0.001, clip.start + abs - clip.src_start));
        return (
          <ClipBar shot={clipShot} nowAbs={inClip ? clip.src_start + (time - clip.start) : null}
            box={[clip.src_start, clip.src_start + (clip.end - clip.start)]}
            playing={playing} onTogglePlay={() => setPlaying(!playing)} onStep={onStepFrame}
            onScrub={(abs) => { setPlaying(false); setTime(toTime(abs)); }}
            onContact={(v, live) => {
              setPlaying(false);
              const done = onNudge(clipShot.id, v);
              if (!live) done.then(() => setTime(clip.contact)); // the new contact frame, on the beat
            }}
            onWindow={(after) => onWindow(clipShot.id, after)}
            onServeMarks={(b) => onServeMarks(clipShot.id, b)}
            extra={<><Speed value={speed} onChange={setSpeed} /><span className="time">{fmtTime(rel)} / {fmtTime(timeline.duration)}</span></>} />
        );
      })() : !inspect && <div className="transport">
        <button onClick={() => setTime(timeline.reel_start)} title="Back to start">⏮</button>
        <button className="primary" onClick={() => setPlaying(!playing)} style={{ minWidth: 80 }}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <Speed value={speed} onChange={setSpeed} />
        <span className="time">{fmtTime(rel)} / {fmtTime(timeline.duration)}</span>
      </div>}
      <audio ref={audio} src={songUrl(project.id)} preload="auto" />
    </div>
  );
}
