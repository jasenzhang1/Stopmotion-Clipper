import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, fileUrl, NOTE_NAME, Project, Slot, Timeline as TL } from "./api";
import { useHotkeys, useWheelZoom } from "./hotkeys";

const RULER = 16; // px of tick ruler above the waveform
const WAVE = 44;

/** Song time of a grid position (sixteenths) inside a bar. */
const posTime = (b: Bar, pos: number) => b.t0 + (pos * (b.t1 - b.t0)) / 16;

export default function Timeline({ project, timeline, time, onSeek, selected, selection, onSelect, onSelectMany, onEdit, onOpenRally,
  onNudge, onNudgeMany, onStepFrame, onMarkContact }: {
  project: Project; timeline: TL; time: number; onSeek: (t: number) => void;
  selected: string | null; selection: string[]; onSelect: (id: string | null, add?: boolean) => void; onSelectMany: (ids: string[]) => void;
  onEdit: (op: string, args: Record<string, unknown>) => void; onOpenRally: () => void;
  onNudge: (shotId: string, nudge: number) => void; onNudgeMany: (values: Record<string, number>) => void;
  onStepFrame: (d: number) => void; onMarkContact: () => void;
}) {
  const m = project.music!;
  const shots = useMemo(() => Object.fromEntries(project.shots.map((s) => [s.id, s])), [project.shots]);
  const scroll = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const wave = useRef<HTMLCanvasElement>(null);
  const [pps, setPps] = useState(60);
  const [over, setOver] = useState<string | null>(null);
  const [resize, setResize] = useState<{ id: string; len: number } | null>(null);
  const [leftDrag, setLeftDrag] = useState<{ id: string; pos: number } | null>(null);
  /** Left edge: snaps to the grid. Earlier shows more before the contact; the contact and right edge stay put. */
  const startLeft = (e: React.PointerEvent, b: Bar, s: Slot) => {
    e.preventDefault();
    e.stopPropagation();
    const contact = s.pos + (s.hit ?? 0);
    let pos = s.pos;
    const move = (ev: PointerEvent) => {
      const raw = ((timeAt(ev.clientX) - b.t0) / barDur) * 16;
      pos = Math.max(0, Math.min(contact, Math.round(raw / unit) * unit));
      setLeftDrag({ id: s.id, pos });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLeftDrag(null);
      if (pos !== s.pos) onEdit("resize_left", { slot_id: s.id, pos });
    };
    setLeftDrag({ id: s.id, pos });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const grid = timeline.grid ?? 8;
  const t0 = timeline.reel_start - 0.3;
  const t1 = timeline.reel_end + 0.5;
  const W = Math.ceil((t1 - t0) * pps);
  const x = (t: number) => (t - t0) * pps;
  const dropIdx = Math.round((timeline.drop - m.beats[0]) / m.period);
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
  const anchor = useRef<string | null>(null); // where a Shift+click range starts
  useEffect(() => { // ids change after edits: follow the selection
    if (!selection.length) anchor.current = null;
    else if (!anchor.current || !selection.includes(anchor.current)) anchor.current = selection[0];
  }, [selection]);
  const [hitDrag, setHitDrag] = useState<{ id: string; hit: number } | null>(null);
  /** Drag the red line: move only the contact within the clip, snapping to grid lines inside its frame. */
  const startHit = (e: React.PointerEvent, b: Bar, s: Slot) => {
    e.preventDefault();
    e.stopPropagation();
    const off = s.off ?? 0;
    const lo = Math.ceil((off - 1e-6) / unit) * unit, hi = Math.floor((off + s.len + 1e-6) / unit) * unit;
    let hit = s.hit ?? 0;
    const mv = (ev: PointerEvent) => {
      const g = ((timeAt(ev.clientX) - b.t0) / barDur) * 16 - s.pos;
      hit = Math.max(lo, Math.min(hi, Math.round(g / unit) * unit));
      setHitDrag({ id: s.id, hit });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setHitDrag(null);
      if (hit !== (s.hit ?? 0)) onEdit("set_hit", { slot_id: s.id, hit });
    };
    setHitDrag({ id: s.id, hit });
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const [slide, setSlide] = useState<{ id: string; start: number; bi: number; snap: "left" | "right" | null } | null>(null);
  /** Ctrl+drag: slide the clip's frame freely (any start) while the contact stays on its beat; the contact can
   * end up anywhere from the clip's start to its end. */
  const startSlide = (e: React.PointerEvent, bi: number, s: Slot) => {
    e.preventDefault();
    const x0 = e.clientX;
    const contact = s.pos + (s.hit ?? 0);
    const from = s.pos + (s.off ?? 0);
    const lo = contact - s.len, hi = contact;
    // Neighbours' edges (in this bar's sixteenths) to snap to: the left clip's end, the right clip's start.
    const flat = timeline.bars.flatMap((b) => b.slots);
    const i = flat.findIndex((x) => x.id === s.id);
    const b = bars[bi];
    const toPos = (t: number) => ((t - b.t0) / barDur) * 16;
    const natEnd = (x: Slot) => {
      const xb = bars.find((bb) => bb.slots.some((y) => y.id === x.id))!;
      return posTime(xb, x.pos + (x.off ?? 0) + x.len);
    };
    const leftEdge = i > 0 ? toPos(natEnd(flat[i - 1])) : null;
    const rightEdge = i < flat.length - 1 ? toPos(flat[i + 1].start) - s.len : null;
    const SNAP_PX = 8;
    let start = from;
    dragged.current = false;
    onSeek(s.contact);
    const mv = (ev: PointerEvent) => {
      if (!dragged.current && Math.abs(ev.clientX - x0) < 3) return;
      dragged.current = true;
      start = Math.max(lo, Math.min(hi, from + (ev.clientX - x0) / px16 * (ev.shiftKey ? 0.25 : 1)));
      let snap: "left" | "right" | null = null;
      if (leftEdge !== null && Math.abs(start - leftEdge) * px16 < SNAP_PX && leftEdge >= lo && leftEdge <= hi) { start = leftEdge; snap = "left"; }
      else if (rightEdge !== null && Math.abs(start - rightEdge) * px16 < SNAP_PX && rightEdge >= lo && rightEdge <= hi) { start = rightEdge; snap = "right"; }
      setSlide({ id: s.id, start, bi, snap });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setSlide(null);
      if (dragged.current && Math.abs(start - from) > 1e-3) onEdit("slide_span", { slot_id: s.id, start });
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };


  const allSlots = useMemo(() => timeline.bars.flatMap((b, bi) => b.slots.map((s) => ({ s, bi }))), [timeline]);


  const [gmove, setGmove] = useState<number | null>(null); // group move: offset in sixteenths
  /** Drag one of several selected clips: they all move together, keeping their spacing. */
  const startGroupMove = (e: React.PointerEvent) => {
    const x0 = e.clientX;
    const group = allSlots.filter(({ s }) => selection.includes(s.id)).map(({ s, bi }) => ({ a: bi * 16 + s.pos, len: s.len }));
    const fits = (d: number) => group.every(({ a, len }) => a + d >= 0 && a + d + len <= nAbs && ((a + d) % 16) + len <= 16);
    let delta = 0;
    dragged.current = false;
    const mv = (ev: PointerEvent) => {
      if (!dragged.current && Math.abs(ev.clientX - x0) < 4) return;
      dragged.current = true;
      const raw = Math.round((ev.clientX - x0) / px16 / unit) * unit;
      // nearest offset where no clip would cross a bar line
      for (let i = 0; i <= 32; i += unit) {
        if (fits(raw - i)) { delta = raw - i; break; }
        if (fits(raw + i)) { delta = raw + i; break; }
      }
      setGmove(delta);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setGmove(null);
      if (dragged.current && delta !== 0) onEdit("move_slots", { ids: selection, delta });
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  /** Drag a clip anywhere (it overwrites what it lands on). Hold Alt when letting go to swap instead. */
  const startMove = (e: React.PointerEvent, bi: number, s: Slot) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey) { startSlide(e, bi, s); return; }
    if (selection.length > 1 && selection.includes(s.id) && !e.shiftKey) { startGroupMove(e); return; }
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
      const raw = ((timeAt(ev.clientX) - b.t0) / barDur) * 16 - s.pos;
      len = Math.max((s.hit ?? 0) + unit, Math.min(16 - s.pos, Math.round(raw / unit) * unit)); // contact stays inside
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
        <span className="spacer" />
        <span className="muted" title="Scroll the mouse wheel over the track to zoom (or press + / −)">Scroll to zoom</span>
      </div>
      <div className="tl-scroll" ref={scroll}>
        <div className="tl-inner" style={{ width: W }} ref={inner}>
          {/* Bar headers */}
          <div className="lane" style={{ height: 28 }}>
            {timeline.bars.map((b) => (
              <div key={b.k} className={`bar-head ${b.k % 8 === 0 ? "phrase" : ""}`} style={{ left: x(b.t0), width: x(b.t1) - x(b.t0) }}>
                <span>{b.k === lastK ? "→drop" : `bar ${b.k}`}</span>
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
              const right = resize?.id === s.id ? posTime(b, s.pos + len) : s.end;
              const sliding = slide?.id === s.id;
              const left = leftDrag?.id === s.id ? posTime(b, leftDrag.pos) : sliding ? posTime(b, slide!.start) : s.start;
              const rightEdge = sliding ? posTime(b, slide!.start + s.len) : right;
              const isRepeat = !!s.label && (labelUses[s.label] ?? 0) > 1;
              const isMoving = move?.id === s.id;
              return (
                <div key={s.id} data-slot={s.id}
                  className={`slot ${selected === s.id ? "sel" : selection.includes(s.id) ? "sel multi" : ""} ${over === s.id || move?.swap === s.id ? "dragover" : ""}`
                    + ` ${resize?.id === s.id || leftDrag?.id === s.id || slide?.id === s.id ? "resizing" : ""} ${sliding && slide!.snap ? `snapped-${slide!.snap}` : ""} ${isMoving || (gmove !== null && selection.includes(s.id)) ? "lifted" : ""} ${doomed.has(s.id) ? "doomed" : ""}`}
                  style={{ left: x(left), width: Math.max(2, x(rightEdge) - x(left)),
                    backgroundImage: sh ? `url(${fileUrl(project.id, sh.thumb)})` : undefined }}
                  onPointerDown={(e) => startMove(e, bi, s)}
                  onDragOver={(e) => { e.preventDefault(); setOver(s.id); }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => onDropShot(e, s.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (dragged.current) { dragged.current = false; return; }
                    const order = timeline.bars.flatMap((b) => b.slots.map((x) => x.id));
                    const from = anchor.current ? order.indexOf(anchor.current) : -1;
                    if (e.shiftKey && from >= 0) { // Shift+click: everything from the last clicked clip to this one
                      const to = order.indexOf(s.id);
                      const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
                      onSelectMany([...span.filter((id) => id !== s.id), s.id]);
                      return;
                    }
                    anchor.current = s.id;
                    const add = e.shiftKey || e.ctrlKey || e.metaKey;
                    onSelect(s.id, add);
                    if (!add) onSeek(s.contact);
                  }}
                  title={sh ? `${s.label ?? ""} · ${sh.type} · ${sh.stars}★ · ${NOTE_NAME[s.len] ?? `${s.len / 4} beats`}`
                    + `${isRepeat ? " · this exact clip is used more than once" : ""}`
                    + " · drag to move (Alt to swap) · Shift+click to select several · Ctrl+drag to slide the clip around its contact" : s.id}
                >
                  <div className={`contact-line grab ${hitDrag?.id === s.id ? "dragging" : ""}`}
                    style={{ left: (hitDrag?.id === s.id ? x(posTime(b, s.pos + hitDrag.hit)) : x(s.contact)) - x(left) }}
                    onPointerDown={(e) => startHit(e, b, s)}
                    title="Drag to move the contact within the clip (snaps to the beat grid)">
                    <span className="knob" />
                  </div>
                  {hitDrag?.id === s.id && (
                    <div className="note-tag">contact {(hitDrag.hit - (s.off ?? 0)) <= 0.05 ? "at the start" : hitDrag.hit - (s.off ?? 0) >= s.len - 0.05 ? "at the end" : `${(hitDrag.hit - (s.off ?? 0)) / 2}/8 in`}</div>
                  )}
                  <div className="icons">
                    {isRepeat && <span title="This exact clip is used more than once">↻</span>}
                  </div>
                  {sh && <div className={`lbl t-${sh.type}`}>{s.label ?? "?"}</div>}
                  {resize?.id === s.id && <div className="note-tag">{NOTE_NAME[len] ?? `${len / 4} beats`}</div>}
                  <div className="handle left" onPointerDown={(e) => startLeft(e, b, s)} title="Drag to start the clip earlier or later (the contact stays put)" />
                  <div className="handle" onPointerDown={(e) => startResize(e, b, s)} title="Drag to change where the clip ends" />
                  {sliding && (() => {
                    const h = s.pos + (s.hit ?? 0) - slide!.start;
                    return <div className="note-tag">{slide!.snap === "left" ? "⇤ touching the clip on the left · " : slide!.snap === "right" ? "touching the clip on the right ⇥ · " : ""}contact {h < 0.05 ? "at the start" : h > s.len - 0.05 ? "at the end" : `${Math.round((h / s.len) * 100)}% in`}</div>;
                  })()}
                  {leftDrag?.id === s.id && (() => {
                    const ln = s.pos + s.len - leftDrag.pos;
                    return <div className="note-tag">{NOTE_NAME[ln] ?? `${ln / 2} eighths`} · {(s.pos + (s.hit ?? 0) - leftDrag.pos) / 2}/8 before contact</div>;
                  })()}
                </div>
              );
            }))}
            {gmove !== null && allSlots.filter(({ s }) => selection.includes(s.id)).map(({ s, bi }) => {
              const a = bi * 16 + s.pos + gmove;
              const b = bars[Math.floor(a / 16)];
              if (!b) return null;
              const sh = shots[s.shot_id];
              return (
                <div key={`g${s.id}`} className="slot ghost" style={{ left: x(posTime(b, a % 16 + (s.off ?? 0))), width: Math.max(2, (s.len / 16) * barDur * pps),
                  backgroundImage: sh ? `url(${fileUrl(project.id, sh.thumb)})` : undefined }} ><div className="contact-line" style={{ left: ((s.hit ?? 0) - (s.off ?? 0)) / 16 * barDur * pps }} /></div>
              );
            })}
            {move && moving && !move.swap && (() => {
              const b = bars[move.bi];
              const st = posTime(b, move.pos + (moving.off ?? 0));
              const sh = shots[moving.shot_id];
              return (
                <div className="slot ghost" style={{ left: x(st), width: Math.max(2, (moving.len / 16) * barDur * pps),
                  backgroundImage: sh ? `url(${fileUrl(project.id, sh.thumb)})` : undefined }}>
                  <div className="contact-line" style={{ left: ((moving.hit ?? 0) - (moving.off ?? 0)) / 16 * barDur * pps }} />
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
