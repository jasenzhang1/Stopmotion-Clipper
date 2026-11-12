import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, fileUrl, NOTE_NAME, Project, Slot, Timeline as TL } from "./api";
import { useHotkeys, useWheelZoom } from "./hotkeys";
import ClipTrim, { nudgeBounds } from "./ClipTrim";

const RULER = 16; // px of tick ruler above the waveform
const WAVE = 44;

/** Song time of a grid position (sixteenths) inside a bar. */
const posTime = (b: Bar, pos: number) => b.t0 + (pos * (b.t1 - b.t0)) / 16;

export default function Timeline({ project, timeline, time, onSeek, selected, onSelect, onEdit, onOpenRally, onNudge }: {
  project: Project; timeline: TL; time: number; onSeek: (t: number) => void;
  selected: string | null; onSelect: (id: string | null) => void;
  onEdit: (op: string, args: Record<string, unknown>) => void; onOpenRally: () => void;
  onNudge: (shotId: string, nudge: number) => void;
}) {
  const m = project.music!;
  const shots = useMemo(() => Object.fromEntries(project.shots.map((s) => [s.id, s])), [project.shots]);
  const scroll = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const wave = useRef<HTMLCanvasElement>(null);
  const [pps, setPps] = useState(60);
  const [over, setOver] = useState<string | null>(null);
  const [resize, setResize] = useState<{ id: string; len: number } | null>(null);
  const grid = timeline.grid ?? 8;
  const t0 = timeline.reel_start - 0.3;
  const t1 = timeline.reel_end + 0.5;
  const W = Math.ceil((t1 - t0) * pps);
  const x = (t: number) => (t - t0) * pps;
  const dropIdx = Math.round((timeline.drop - m.beats[0]) / m.period);
  const densities = grid >= 16 ? [1, 2, 4, 8, 16] : [1, 2, 4, 8];
  const unit = grid >= 16 ? 1 : 2; // smallest step clips move and resize by, in sixteenths

  // Fit to width on first render
  useEffect(() => {
    if (scroll.current) setPps(Math.max(20, Math.min(200, (scroll.current.clientWidth - 20) / (t1 - t0))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Ruler (Rekordbox-style tick hierarchy: phrase > bar > beat > eighth > sixteenth) + waveform.
  useEffect(() => {
    const c = wave.current;
    if (!c) return;
    const H = RULER + WAVE;
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, W, H);
    const i0 = Math.max(0, Math.floor(t0 / m.peaks_dt));
    const i1 = Math.min(m.peaks.length, Math.ceil(t1 / m.peaks_dt));
    const step = m.peaks_dt * pps;
    const mid = RULER + WAVE / 2;
    for (let i = i0; i < i1; i++) {
      const h = m.peaks[i] * (WAVE / 2 - 2);
      const t = i * m.peaks_dt;
      g.fillStyle = t >= timeline.drop ? "#b9cf55" : "#5d6371";
      g.fillRect(x(t), mid - h, Math.max(1, step), h * 2);
    }
    const sub = grid >= 16 ? 4 : 2;
    const subPx = (m.period / sub) * pps;
    m.beats.forEach((b, i) => {
      if (b < t0 - m.period || b > t1) return;
      const rel = i - dropIdx;
      const bar = ((rel % 4) + 4) % 4 === 0;
      const phrase = ((rel % 32) + 32) % 32 === 0;
      const X = Math.round(x(b));
      // ruler tick
      const th = phrase ? RULER : bar ? 11 : 7;
      g.fillStyle = phrase ? "#d4f542" : bar ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.45)";
      g.fillRect(X, RULER - th, phrase ? 2 : 1, th);
      // subdivisions, only when there's room to see them
      if (subPx >= 5) {
        for (let k = 1; k < sub; k++) {
          const sx = Math.round(x(b + (k * m.period) / sub));
          const eighth = sub === 4 ? k === 2 : true;
          g.fillStyle = "rgba(255,255,255,0.3)";
          g.fillRect(sx, RULER - (eighth ? 4 : 2), 1, eighth ? 4 : 2);
        }
      }
      // grid line through the waveform
      g.fillStyle = phrase ? "rgba(212,245,66,0.55)" : bar ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.12)";
      g.fillRect(X, RULER, 1, WAVE);
    });
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.fillRect(0, RULER - 1, W, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W, pps, t0, t1, m, timeline.drop, grid]);

  const zoomBy = useWheelZoom(scroll, inner, pps, setPps, 20, 400);
  useHotkeys((e) => {
    if (e.key === "=" || e.key === "+") { zoomBy(1.25); return true; }
    if (e.key === "-" || e.key === "_") { zoomBy(0.8); return true; }
  });

  const seekFromEvent = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onSeek(t0 + (e.clientX - r.left) / pps);
  };

  // ---- free placement: positions are absolute sixteenths from the first bar (bars are all the same length)
  const bars = timeline.bars;
  const barDur = bars.length ? bars[0].t1 - bars[0].t0 : 4 * m.period;
  const px16 = (barDur / 16) * pps;
  const nAbs = bars.length * 16;
  const timeAt = (clientX: number) => t0 + (clientX - inner.current!.getBoundingClientRect().left) / pps;
  /** Clips this span would wipe out (fully covered), so they can be shown before you let go. */
  const covered = (bi: number, pos: number, len: number, except: string) =>
    new Set((bars[bi]?.slots ?? []).filter((o) => o.id !== except && o.pos >= pos && o.pos + o.len <= pos + len).map((o) => o.id));

  const [move, setMove] = useState<{ id: string; bi: number; pos: number; swap: string | null } | null>(null);
  const dragged = useRef(false);
  const [slip, setSlip] = useState<{ id: string; v: number; d: number } | null>(null);

  /** Ctrl+drag: slide which footage plays inside the clip (start and end move together), 1:1 with the
   * timeline; Shift for 1/4 speed. Dragging right shows later footage. */
  const startSlip = (e: React.PointerEvent, s: Slot) => {
    const sh = shots[s.shot_id];
    if (!sh) return;
    e.preventDefault();
    const x0 = e.clientX;
    const base = sh.nudge ?? 0;
    const { min, max } = nudgeBounds(sh, s);
    let v = base, sent = base, last = 0;
    dragged.current = false;
    const mv = (ev: PointerEvent) => {
      if (!dragged.current && Math.abs(ev.clientX - x0) < 2) return;
      dragged.current = true;
      v = Math.max(min, Math.min(max, base + ((ev.clientX - x0) / pps) * (ev.shiftKey ? 0.25 : 1)));
      setSlip({ id: s.id, v, d: v - base });
      const now = performance.now();
      if (now - last > 120) { last = now; sent = v; onNudge(sh.id, v); } // live preview while dragging
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setSlip(null);
      if (dragged.current && Math.abs(v - sent) > 1e-4) onNudge(sh.id, v);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  /** Drag a clip anywhere (it overwrites what it lands on). Hold Alt when letting go to swap instead. */
  const startMove = (e: React.PointerEvent, bi: number, s: Slot) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey) { startSlip(e, s); return; }
    const x0 = e.clientX;
    const a0 = bi * 16 + s.pos;
    let target: { bi: number; pos: number } | null = null;
    let swap: string | null = null;
    dragged.current = false;
    const mv = (ev: PointerEvent) => {
      if (!dragged.current && Math.abs(ev.clientX - x0) < 4) return;
      dragged.current = true;
      const raw = a0 + (ev.clientX - x0) / px16;
      let a = Math.round(raw / unit) * unit;
      a = Math.max(0, Math.min(nAbs - s.len, a));
      let tb = Math.floor(a / 16), tp = a % 16;
      if (tp + s.len > 16) { // would cross a bar line: snap to whichever side is closer
        const left = tb * 16 + 16 - s.len, right = (tb + 1) * 16;
        if (right + s.len <= nAbs && Math.abs(raw - right) < Math.abs(raw - left)) { tb += 1; tp = 0; }
        else tp = 16 - s.len;
      }
      target = { bi: tb, pos: tp };
      const el = ev.altKey ? (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest("[data-slot]") : null;
      swap = el && el.getAttribute("data-slot") !== s.id ? el.getAttribute("data-slot") : null;
      setMove({ id: s.id, bi: tb, pos: tp, swap });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setMove(null);
      if (!dragged.current || !target) return;
      if (swap) onEdit("swap_slots", { a: s.id, b: swap });
      else if (target.bi !== bi || target.pos !== s.pos) onEdit("move_slot", { slot_id: s.id, k: bars[target.bi].k, pos: target.pos });
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  /** Drag a clip's right edge: any whole number of grid steps; growing overwrites, shrinking leaves black. */
  const startResize = (e: React.PointerEvent, b: Bar, s: Slot) => {
    e.preventDefault();
    e.stopPropagation();
    let len = s.len;
    const move = (ev: PointerEvent) => {
      const raw = ((timeAt(ev.clientX) + s.lead - b.t0) / barDur) * 16 - s.pos;
      len = Math.max(unit, Math.min(16 - s.pos, Math.round(raw / unit) * unit));
      setResize({ id: s.id, len });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResize(null);
      if (len !== s.len) onEdit("resize_slot", { slot_id: s.id, len });
    };
    setResize({ id: s.id, len });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Library shot dropped onto a clip replaces it; dropped onto black, it fills the black from there. */
  const onDropShot = (e: React.DragEvent, slotId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const d = e.dataTransfer.getData("text/plain");
    if (!d.startsWith("shot:")) return;
    if (slotId) { onEdit("set_slot_shot", { slot_id: slotId, shot_id: d.slice(5) }); return; }
    const a = Math.floor(((timeAt(e.clientX) - bars[0].t0) / barDur) * 16 / unit) * unit;
    if (a < 0 || a >= nAbs) return;
    const bi = Math.floor(a / 16), pos = a % 16;
    const next = bars[bi].slots.map((o) => o.pos).filter((p) => p > pos);
    const len = Math.max(unit, Math.min(16, ...next) - pos);
    onEdit("insert_slot", { k: bars[bi].k, pos, len, shot_id: d.slice(5) });
  };

  const labelUses = useMemo(() => {
    const n: Record<string, number> = {};
    timeline.bars.forEach((b) => b.slots.forEach((s) => { if (s.label) n[s.label] = (n[s.label] ?? 0) + 1; }));
    return n;
  }, [timeline]);
  const selSlot = selected ? timeline.bars.flatMap((b) => b.slots).find((s) => s.id === selected) : undefined;

  // Black stretches (no clip), from the reel start to the rally.
  const gaps = useMemo(() => {
    const flat = timeline.bars.flatMap((b) => b.slots);
    const out: { a: number; b: number }[] = [];
    let cur = timeline.reel_start;
    for (const s of flat) {
      if (s.start - cur > 0.01) out.push({ a: cur, b: s.start });
      cur = Math.max(cur, s.end);
    }
    const stop = timeline.rally?.start ?? timeline.drop;
    if (stop - cur > 0.01) out.push({ a: cur, b: stop });
    return out;
  }, [timeline]);

  // What a drag in progress will do: where the ghost goes and which clips it will wipe out.
  const moving = move && timeline.bars.flatMap((b) => b.slots).find((s) => s.id === move.id);
  const doomed = move && moving && !move.swap ? covered(move.bi, move.pos, moving.len, moving.id)
    : resize ? (() => {
      const bi = bars.findIndex((b) => b.slots.some((s) => s.id === resize.id));
      const pos = bars[bi]?.slots.find((s) => s.id === resize.id)?.pos ?? 0;
      return covered(bi, pos, resize.len, resize.id);
    })() : new Set<string>();
  const rally = timeline.rally;
  const lastK = timeline.bars.length ? timeline.bars[timeline.bars.length - 1].k : 0;

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        {selSlot && shots[selSlot.shot_id] ? (
          <ClipTrim shot={shots[selSlot.shot_id]} slot={selSlot} onNudge={(v) => onNudge(selSlot.shot_id, v)} />
        ) : null}
        <span className="spacer" />
        <span className="muted">Finest note</span>
        <span className="seg">
          {([8, 16] as const).map((gv) => (
            <button key={gv} className={grid === gv ? "on" : ""} title={gv === 8 ? "Eighth notes" : "Sixteenth notes"}
              onClick={() => grid !== gv && onEdit("set_grid", { grid: gv })}>1/{gv}</button>
          ))}
        </span>
        <span className="muted">Zoom</span>
        <input type="range" min={20} max={400} value={pps} onChange={(e) => setPps(+e.target.value)} />
      </div>
      <div className="tl-scroll" ref={scroll}>
        <div className="tl-inner" style={{ width: W }} ref={inner}>
          {/* Bar headers */}
          <div className="lane" style={{ height: 28 }}>
            {timeline.bars.map((b) => (
              <div key={b.k} className={`bar-head ${b.k % 8 === 0 ? "phrase" : ""}`} style={{ left: x(b.t0), width: x(b.t1) - x(b.t0) }}>
                <span>{b.k === lastK ? "→drop" : `bar ${b.k}`}</span>
                <span className="dens">
                  {densities.map((d) => {
                    const on = b.uniform !== false && b.density === d;
                    return (
                      <button key={d} className={`${on ? "on" : ""} ${on && b.user_density ? "user" : ""}`}
                        title={`${d} equal clip${d > 1 ? "s" : ""} in this bar`}
                        onClick={() => !on && onEdit("set_bar_density", { k: b.k, density: d })}>{d}</button>
                    );
                  })}
                </span>
              </div>
            ))}
            {rally && (
              <div className="bar-head" style={{ left: x(timeline.drop), color: "var(--accent)", fontWeight: 700 }}>DROP · rally</div>
            )}
          </div>
          {/* Tick ruler + waveform */}
          <div className="lane" style={{ height: RULER + WAVE }} onClick={seekFromEvent}>
            <canvas ref={wave} style={{ position: "absolute", left: 0, top: 0, height: RULER + WAVE }} />
          </div>
          {/* Clips */}
          <div className="lane" style={{ height: 76 }}
            onClick={(e) => { if (e.target === e.currentTarget) { onSelect(null); seekFromEvent(e); } }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropShot(e, null)}>
            {gaps.map((g, i) => (
              <div key={`gap${i}`} className="gap" style={{ left: x(g.a), width: Math.max(1, x(g.b) - x(g.a)) }}
                onClick={(e) => { e.stopPropagation(); onSelect(null); seekFromEvent(e as unknown as React.MouseEvent); }}
                title="Black: no clip here. Drop a shot from the library to fill it.">
                {x(g.b) - x(g.a) > 40 && "black"}
              </div>
            ))}
            {timeline.bars.flatMap((b, bi) => b.slots.map((s) => {
              const sh = shots[s.shot_id];
              const len = resize?.id === s.id ? resize.len : s.len;
              const right = resize?.id === s.id ? posTime(b, s.pos + len) - s.lead : s.end;
              const isRepeat = !!s.label && (labelUses[s.label] ?? 0) > 1;
              const isMoving = move?.id === s.id;
              return (
                <div key={s.id} data-slot={s.id}
                  className={`slot ${selected === s.id ? "sel" : ""} ${over === s.id || move?.swap === s.id ? "dragover" : ""}`
                    + ` ${resize?.id === s.id || slip?.id === s.id ? "resizing" : ""} ${isMoving ? "lifted" : ""} ${doomed.has(s.id) ? "doomed" : ""}`}
                  style={{ left: x(s.start), width: Math.max(2, x(right) - x(s.start)),
                    backgroundImage: sh ? `url(${fileUrl(project.id, sh.thumb)})` : undefined }}
                  onPointerDown={(e) => startMove(e, bi, s)}
                  onDragOver={(e) => { e.preventDefault(); setOver(s.id); }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => onDropShot(e, s.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (dragged.current) { dragged.current = false; return; }
                    onSelect(s.id); onSeek(s.contact);
                  }}
                  title={sh ? `${s.label ?? ""} · ${sh.type} · ${sh.stars}★ · ${NOTE_NAME[s.len] ?? `${s.len / 4} beats`}`
                    + `${isRepeat ? " · this exact clip is used more than once" : ""}${s.locked ? " · set by you" : ""}`
                    + " · drag to move (Alt to swap) · Ctrl+drag to slip footage · Delete removes it" : s.id}
                >
                  {slip?.id === s.id && (
                    <div className="note-tag">{slip.d >= 0 ? "+" : "−"}{Math.abs(slip.d).toFixed(3)}s · {Math.round(slip.d * 30)}f</div>
                  )}
                  <div className="icons">{isRepeat ? "↻" : ""}{s.locked ? "🔒" : ""}</div>
                  {sh && <div className={`lbl t-${sh.type}`}>{s.label ?? "?"}</div>}
                  {resize?.id === s.id && <div className="note-tag">{NOTE_NAME[len] ?? `${len / 4} beats`}</div>}
                  <div className="handle" onPointerDown={(e) => startResize(e, b, s)} title="Drag to change the clip's length" />
                </div>
              );
            }))}
            {move && moving && !move.swap && (() => {
              const b = bars[move.bi];
              const st = posTime(b, move.pos) - moving.lead;
              const sh = shots[moving.shot_id];
              return (
                <div className="slot ghost" style={{ left: x(st), width: Math.max(2, (moving.len / 16) * barDur * pps),
                  backgroundImage: sh ? `url(${fileUrl(project.id, sh.thumb)})` : undefined }}>
                  <div className="note-tag">bar {b.k} · beat {move.pos / 4 + 1}{doomed.size ? ` · replaces ${doomed.size}` : ""}</div>
                </div>
              );
            })()}
            {rally && (
              <div className="rally-block" style={{ left: x(rally.start), width: x(rally.end) - x(rally.start) }}
                onClick={(e) => { e.stopPropagation(); onOpenRally(); }} title="Click to choose a different rally">
                RALLY · {rally.n_hits} shots · {(rally.end - rally.start).toFixed(1)}s ✎
              </div>
            )}
          </div>
          <div className="marker drop" style={{ left: x(timeline.drop) }} />
          <div className="marker head" style={{ left: x(time) }} />
        </div>
      </div>
    </div>
  );
}
