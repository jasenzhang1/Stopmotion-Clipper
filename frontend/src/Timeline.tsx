import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, fileUrl, NOTE_NAME, Project, Slot, Timeline as TL } from "./api";
import { useHotkeys, useWheelZoom } from "./hotkeys";

const RULER = 16; // px of tick ruler above the waveform
const WAVE = 44;

/** Song time of a grid position (sixteenths) inside a bar. */
const posTime = (b: Bar, pos: number) => b.t0 + (pos * (b.t1 - b.t0)) / 16;

/** How far into the clip its contact is, as a whole percent, if the frame starts at `start` (sixteenths). */
export const contactPct = (s: Slot, start: number) => Math.round(((s.pos + (s.hit ?? 0) - start) / s.len) * 100);
/** The frame start (sixteenths) nearest `start` that puts the contact a whole percent into the clip. */
export const wholePct = (s: Slot, start: number) => s.pos + (s.hit ?? 0) - (contactPct(s, start) / 100) * s.len;
/** How far (sixteenths) a group of clips can slide together: each one's contact must stay inside its frame. */
export const groupSlideRange = (group: Slot[]): [number, number] => {
  let lo = -Infinity, hi = Infinity;
  for (const x of group) {
    const c = x.pos + (x.hit ?? 0), st = x.pos + (x.off ?? 0);
    lo = Math.max(lo, c - x.len - st);
    hi = Math.min(hi, c - st);
  }
  return [lo, hi];
};

export default function Timeline({ project, timeline, time, onSeek, selected, selection, onSelect, onSelectMany, onEdit,
  onNudge, onNudgeMany, onStepFrame, onMarkContact }: {
  project: Project; timeline: TL; time: number; onSeek: (t: number) => void;
  selected: string | null; selection: string[]; onSelect: (id: string | null, add?: boolean) => void; onSelectMany: (ids: string[]) => void;
  onEdit: (op: string, args: Record<string, unknown>) => void;
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
  /** A right-edge drag in progress: the clip's visible length and where its frame ends (sixteenths into its bar). */
  const [resize, setResize] = useState<{ id: string; len: number; end: number; snapped: boolean } | null>(null);
  /** A left-edge drag in progress: where the frame would start (sixteenths into its bar; may be negative). */
  const [leftDrag, setLeftDrag] = useState<{ id: string; pos: number; snapped: boolean } | null>(null);
  /** Left edge: snaps to the grid. Earlier shows more before the contact; the contact and right edge stay put. */
  const startLeft = (e: React.PointerEvent, b: Bar, s: Slot) => {
    e.preventDefault();
    e.stopPropagation();
    // In sixteenths from this bar's start; negative = back into earlier bars. The right end and the contact
    // stay put. Snaps to the grid, or exactly onto the end of the clip before it when close (Alt: free).
    const contact = s.pos + (s.hit ?? 0);
    const end = s.pos + (s.off ?? 0) + s.len + (s.ext ?? 0);
    const from = s.pos + (s.off ?? 0);
    const bi = bars.indexOf(b);
    const lo = -bi * 16, hi = Math.min(contact, end - unit);
    const flat = timeline.bars.flatMap((bb) => bb.slots);
    const prev = flat[flat.findIndex((x) => x.id === s.id) - 1];
    const prevEnd = prev && prev.end < s.start - 1e-4 ? ((prev.end - b.t0) / barDur) * 16 : null;
    let start = from;
    const move = (ev: PointerEvent) => {
      const raw = ((timeAt(ev.clientX) - b.t0) / barDur) * 16;
      let snapped = false;
      if (ev.altKey) start = raw;
      else if (prevEnd !== null && Math.abs(raw - prevEnd) * px16 < 10) { start = prevEnd; snapped = true; }
      else start = Math.round(raw / unit) * unit;
      start = Math.max(lo, Math.min(hi, start));
      setLeftDrag({ id: s.id, pos: start, snapped });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLeftDrag(null);
      if (Math.abs(start - from) > 1e-4) onEdit("resize_start", { slot_id: s.id, start: Math.round(start * 1e4) / 1e4 });
    };
    setLeftDrag({ id: s.id, pos: start, snapped: false });
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
    // Anywhere in the visible frame, from its first moment to its last. Grid lines (and the clip's edges) pull
    // the line onto them when it's dragged close; hold Alt to place it freely.
    const off = s.off ?? 0;
    const lo = off, hi = off + s.len + (s.ext ?? 0);
    const SNAP_PX = 6;
    let hit = s.hit ?? 0;
    const mv = (ev: PointerEvent) => {
      const g = Math.max(lo, Math.min(hi, ((timeAt(ev.clientX) - b.t0) / barDur) * 16 - s.pos));
      hit = g;
      if (!ev.altKey) {
        const grid = Math.round(g / unit) * unit;
        const near = [lo, hi, ...(grid >= lo && grid <= hi ? [grid] : [])].sort((p, q) => Math.abs(p - g) - Math.abs(q - g))[0];
        if (Math.abs(near - g) * px16 < SNAP_PX) hit = near;
      }
      setHitDrag({ id: s.id, hit });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setHitDrag(null);
      if (Math.abs(hit - (s.hit ?? 0)) > 1e-4) onEdit("set_hit", { slot_id: s.id, hit: Math.round(hit * 1e4) / 1e4 });
    };
    setHitDrag({ id: s.id, hit });
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  /** A Ctrl+drag in progress: each sliding clip's frame start (sixteenths into its bar); `id` is the one dragged. */
  const [slide, setSlide] = useState<{ id: string; starts: Record<string, number>; snap: "left" | "right" | null } | null>(null);
  /** Ctrl+drag: slide the clip's frame freely (any start) while the contact stays on its beat; the contact can
   * end up anywhere from the clip's start to its end. On a multi-selection every selected clip slides by the
   * same amount, so touching clips stay touching. The dragged clip settles on whole percents (Shift = slower). */
  const startSlide = (e: React.PointerEvent, bi: number, s: Slot) => {
    e.preventDefault();
    if (selection.length > 1 && selection.includes(s.id)) { startGroupSlide(e, s); return; }
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
      start = Math.max(lo, Math.min(hi, wholePct(s, from + (ev.clientX - x0) / px16 * (ev.shiftKey ? 0.25 : 1))));
      let snap: "left" | "right" | null = null;
      if (leftEdge !== null && Math.abs(start - leftEdge) * px16 < SNAP_PX && leftEdge >= lo && leftEdge <= hi) { start = leftEdge; snap = "left"; }
      else if (rightEdge !== null && Math.abs(start - rightEdge) * px16 < SNAP_PX && rightEdge >= lo && rightEdge <= hi) { start = rightEdge; snap = "right"; }
      setSlide({ id: s.id, starts: { [s.id]: start }, snap });
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
  /** Ctrl+drag on one of several selected clips: slide them all by the same amount. */
  const startGroupSlide = (e: React.PointerEvent, s: Slot) => {
    const x0 = e.clientX;
    const group = timeline.bars.flatMap((b) => b.slots).filter((x) => selection.includes(x.id));
    const froms = Object.fromEntries(group.map((x) => [x.id, x.pos + (x.off ?? 0)]));
    const [lo, hi] = groupSlideRange(group);
    const from = froms[s.id];
    let delta = 0;
    dragged.current = false;
    onSeek(s.contact);
    const mv = (ev: PointerEvent) => {
      if (!dragged.current && Math.abs(ev.clientX - x0) < 3) return;
      dragged.current = true;
      const raw = from + (ev.clientX - x0) / px16 * (ev.shiftKey ? 0.25 : 1);
      delta = Math.max(lo, Math.min(hi, wholePct(s, raw) - from));
      setSlide({ id: s.id, starts: Object.fromEntries(group.map((x) => [x.id, froms[x.id] + delta])), snap: null });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setSlide(null);
      if (dragged.current && Math.abs(delta) > 1e-3) onEdit("slide_spans", { ids: selection, delta });
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
    // Lengths are measured from where the clip visibly starts (a Ctrl+dragged frame starts off the grid), and
    // the right edge may run past the bar line into the next bar.
    const start = s.pos + (s.off ?? 0);
    const bi = bars.indexOf(b);
    const maxLen = (bars.length - bi) * 16 - start; // not past the last bar
    const minLen = Math.max(unit, Math.ceil((s.pos + (s.hit ?? 0) - start) / unit) * unit); // the contact stays inside
    const curLen = s.len + (s.ext ?? 0);
    let len = curLen;
    let snapEnd: number | null = null;
    // Where the next clip begins (sixteenths into this bar): dragging close snaps exactly onto it.
    const flat = timeline.bars.flatMap((bb) => bb.slots);
    const nxt = flat[flat.findIndex((x) => x.id === s.id) + 1];
    const nextStart = nxt && nxt.start > s.end + 1e-4 ? ((nxt.start - b.t0) / barDur) * 16 : null;
    const move = (ev: PointerEvent) => {
      const at = ((timeAt(ev.clientX) - b.t0) / barDur) * 16;
      snapEnd = nextStart !== null && Math.abs(at - nextStart) * px16 < 10 ? nextStart : null;
      len = Math.max(minLen, Math.min(maxLen, Math.round((at - start) / unit) * unit));
      setResize({ id: s.id, len, end: snapEnd ?? start + len, snapped: snapEnd !== null });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResize(null);
      if (snapEnd !== null) onEdit("resize_end", { slot_id: s.id, end: snapEnd });
      else if (Math.abs(len - curLen) < 1e-6) return;
      // On the grid and inside the bar: an ordinary resize (it overwrites what it runs into). A slid frame or
      // one crossing the bar line ends exactly where it was dragged.
      else if ((s.off ?? 0) === 0 && Number.isInteger(len) && s.pos + len <= 16) onEdit("resize_slot", { slot_id: s.id, len });
      else onEdit("resize_end", { slot_id: s.id, end: start + len });
    };
    setResize({ id: s.id, len, end: start + len, snapped: false });
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

  // Black stretches (no clip), from the reel start to its end (the song step's END marker).
  const gaps = useMemo(() => {
    const flat = timeline.bars.flatMap((b) => b.slots);
    const out: { a: number; b: number }[] = [];
    let cur = timeline.reel_start;
    for (const s of flat) {
      if (s.start - cur > 0.01) out.push({ a: cur, b: s.start });
      cur = Math.max(cur, s.end);
    }
    if (timeline.reel_end - cur > 0.01) out.push({ a: cur, b: timeline.reel_end });
    return out;
  }, [timeline]);

  // What a drag in progress will do: where the ghost goes and which clips it will wipe out.
  const moving = move && timeline.bars.flatMap((b) => b.slots).find((s) => s.id === move.id);
  const doomed = move && moving && !move.swap ? covered(move.bi, move.pos, moving.len, moving.id)
    : resize ? (() => { // clips the stretched frame covers completely, in this bar or the next ones
      const b = bars.find((bb) => bb.slots.some((s) => s.id === resize.id));
      const r = b?.slots.find((s) => s.id === resize.id);
      if (!b || !r) return new Set<string>();
      const a = r.start, e = posTime(b, resize.end);
      return new Set(bars.flatMap((bb) => bb.slots).filter((o) => o.id !== r.id && o.start >= a - 1e-4 && o.end <= e + 1e-4).map((o) => o.id));
    })() : leftDrag ? (() => { // the same for a left edge pulled back over earlier clips
      const b = bars.find((bb) => bb.slots.some((s) => s.id === leftDrag.id));
      const r = b?.slots.find((s) => s.id === leftDrag.id);
      if (!b || !r) return new Set<string>();
      const a = posTime(b, leftDrag.pos), e = r.end;
      return new Set(bars.flatMap((bb) => bb.slots).filter((o) => o.id !== r.id && o.start >= a - 1e-4 && o.end <= e + 1e-4).map((o) => o.id));
    })() : new Set<string>();

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
              <div key={b.k} className={`bar-head ${b.k % 8 === 0 ? "phrase" : ""} ${b.k === 0 ? "drop-head" : ""}`} style={{ left: x(b.t0), width: x(b.t1) - x(b.t0) }}>
                <span>{b.k === 0 ? "DROP" : b.k === -1 ? "→drop" : b.k > 0 ? `+${b.k}` : `bar ${b.k}`}</span>
              </div>
            ))}
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
              const right = resize?.id === s.id ? posTime(b, resize.end) : s.end;
              const slideStart = slide?.starts[s.id];
              const sliding = slideStart !== undefined;
              const left = leftDrag?.id === s.id ? posTime(b, leftDrag.pos) : sliding ? posTime(b, slideStart) : s.start;
              const rightEdge = sliding ? posTime(b, slideStart + s.len) : right;
              const isRepeat = !!s.label && (labelUses[s.label] ?? 0) > 1;
              const isMoving = move?.id === s.id;
              return (
                <div key={s.id} data-slot={s.id}
                  className={`slot ${selected === s.id ? "sel" : selection.includes(s.id) ? "sel multi" : ""} ${over === s.id || move?.swap === s.id ? "dragover" : ""}`
                    + ` ${resize?.id === s.id || leftDrag?.id === s.id || sliding ? "resizing" : ""} ${sliding && slide!.snap ? `snapped-${slide!.snap}` : ""} ${resize?.id === s.id && resize.snapped ? "snapped-right" : ""} ${isMoving || (gmove !== null && selection.includes(s.id)) ? "lifted" : ""} ${doomed.has(s.id) ? "doomed" : ""}`}
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
                    + " · drag to move (Alt to swap) · Shift+click to select several · Ctrl+drag to slide the clip around its contact (all selected clips together)"
                    + " · Ctrl+←/→ to slide by 1% (Shift: 5%)" : s.id}
                >
                  <div className={`contact-line grab ${hitDrag?.id === s.id ? "dragging" : ""}`}
                    style={{ left: (hitDrag?.id === s.id ? x(posTime(b, s.pos + hitDrag.hit)) : x(s.contact)) - x(left) }}
                    onPointerDown={(e) => startHit(e, b, s)}
                    title="Drag to move the contact anywhere in the clip (it snaps to beats and the clip's edges when close; hold Alt to place it freely)">
                    <span className="knob" />
                  </div>
                  {hitDrag?.id === s.id && (
                    (() => {
                      const into = hitDrag.hit - (s.off ?? 0), span = s.len + (s.ext ?? 0);
                      const onBeat = Math.abs(hitDrag.hit - Math.round(hitDrag.hit / unit) * unit) < 1e-4;
                      return <div className="note-tag">contact {into <= 1e-4 ? "at the start" : into >= span - 1e-4 ? "at the end" : `${Math.round((into / span) * 100)}% in`}{onBeat ? " · on the beat" : ""}</div>;
                    })()
                  )}
                  <div className="icons">
                    {isRepeat && <span title="This exact clip is used more than once">↻</span>}
                  </div>
                  {sh && <div className={`lbl t-${sh.type}`}>{s.label ?? "?"}</div>}
                  {resize?.id === s.id && <div className="note-tag">{resize.snapped ? "touching the next clip ⇥" : NOTE_NAME[len] ?? `${len / 4} beats`}{!resize.snapped && resize.end > 16 + 1e-6 ? " · into the next bar" : ""}</div>}
                  <div className="handle left" onPointerDown={(e) => startLeft(e, b, s)} title="Drag to start the clip earlier or later (the contact stays put)" />
                  <div className="handle" onPointerDown={(e) => startResize(e, b, s)} title="Drag to change where the clip ends" />
                  {sliding && slide!.id === s.id && (() => {
                    const h = s.pos + (s.hit ?? 0) - slideStart;
                    const n = Object.keys(slide!.starts).length;
                    return <div className="note-tag">{n > 1 ? `${n} clips · ` : ""}{slide!.snap === "left" ? "⇤ touching the clip on the left · " : slide!.snap === "right" ? "touching the clip on the right ⇥ · " : ""}contact {h < 0.005 ? "at the start" : h > s.len - 0.005 ? "at the end" : `${Math.round((h / s.len) * 100)}% in`}</div>;
                  })()}
                  {leftDrag?.id === s.id && (() => {
                    const ln = s.pos + (s.off ?? 0) + s.len + (s.ext ?? 0) - leftDrag.pos; // visible length, sixteenths
                    const before = s.pos + (s.hit ?? 0) - leftDrag.pos;
                    const name = Math.abs(ln - Math.round(ln)) < 1e-4 ? NOTE_NAME[Math.round(ln)] : undefined;
                    return <div className="note-tag">{leftDrag.snapped ? "⇤ touching the clip on the left · " : ""}{name ?? `${(ln / 4).toFixed(2)} beats`} · contact {ln > 0 ? Math.round((before / ln) * 100) : 0}% in{leftDrag.pos < 0 ? " · into the bar before" : ""}</div>;
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
          </div>
          <div className="marker drop" style={{ left: x(timeline.drop) }} />
          <div className="marker head" style={{ left: x(time) }} />
        </div>
      </div>
    </div>
  );
}
