import { useEffect, useMemo, useRef, useState } from "react";
import { api, EditorState, fileUrl, matchFilter, Meta, Project, ServeMarksPatch, Shot, Slot, TYPE_CODE, TYPE_LABEL } from "./api";
import Preview from "./Preview";
import { isTyping, useHotkeys } from "./hotkeys";
import { FRAME, nudgeBounds } from "./ClipTrim";
import Timeline, { contactPct, groupSlideRange } from "./Timeline";
import { ExportDialog } from "./Dialogs";
import { SkeletonDialog } from "./Skeleton";
import { FILTERS, Stars, useShotUpdater } from "./ShotsStep";

function Library({ project, used, selectedSlot, onPlace, inspecting, onInspect, update }: {
  project: Project; used: Set<string>; selectedSlot: string | null;
  onPlace: (shot: Shot) => void; inspecting: string | null; onInspect: (shot: Shot) => void;
  update: ReturnType<typeof useShotUpdater>;
}) {
  const [filter, setFilter] = useState("all");
  const shots = project.shots
    .filter((s) => !s.hidden && matchFilter(s, filter))
    .sort((a, b) => b.quality - a.quality);
  return (
    <div className="panel">
      <div className="panel-head">Shot library <span className="spacer" />{shots.length}</div>
      <div style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
        <div className="chips">
          {FILTERS.filter((f) => f.key !== "unknown" || project.shots.some((s) => s.type === "unknown")).map((f) => (
            <span key={f.key} className={`chip ${filter === f.key ? "on" : ""}`} style={{ fontSize: 12, padding: "2px 8px" }}
              onClick={() => setFilter(f.key)}>{f.label}</span>
          ))}
        </div>
      </div>
      <div className="panel-body">
        {shots.map((s) => (
          <div key={s.id} className={`lib-item ${used.has(s.id) ? "used" : ""} ${inspecting === s.id ? "inspecting" : ""}`} draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", `shot:${s.id}`)}
            onClick={() => (selectedSlot ? onPlace(s) : onInspect(s))}
            title={selectedSlot ? "Put in selected clip" : "Click (or drag onto the preview) to watch it. Drag onto a clip in the timeline to use it"}>
            <img src={fileUrl(project.id, s.thumb)} loading="lazy" alt="" />
            <div style={{ display: "grid", gap: 2 }}>
              <span><span className={`badge t-${s.type}`} title={TYPE_LABEL[s.type]}>{s.name ?? TYPE_CODE[s.type]}</span></span>
              <Stars value={s.stars} onChange={(n) => update(s, { stars: n })} />
              {used.has(s.id) && <span className="muted" style={{ fontSize: 11 }}>in reel</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Chat({ project, onResult, available }: {
  project: Project; onResult: (r: Awaited<ReturnType<typeof api.chat>>) => void; available: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [project.chat.length, pending]);

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setText("");
    setPending(msg);
    setBusy(true);
    try {
      onResult(await api.chat(project.id, msg));
    } catch (e: any) {
      onResult({ reply: e.message, timeline: project.timeline!, chat: [...project.chat, { role: "user", text: msg }, { role: "assistant", text: `Error: ${e.message}` }], shots: project.shots });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">Feedback chat</div>
      <div className="chat-msgs">
        {!project.chat.length && !pending && (
          <div className="msg assistant">
            Here's your first draft. Tell me what to change, e.g. "more backhands in the build-up",
            "make bar -3 eighth notes", or "more backhands near the drop".
            {!available && <div className="error" style={{ marginTop: 6 }}>No Anthropic API key found. Set ANTHROPIC_API_KEY and restart to use chat.</div>}
          </div>
        )}
        {project.chat.map((m, i) => <div key={i} className={`msg ${m.role}`}>{m.text}</div>)}
        {pending && <><div className="msg user">{pending}</div><div className="msg assistant muted">Working on it…</div></>}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <textarea value={text} placeholder="Describe a change…" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="primary" disabled={busy || !text.trim()} onClick={send}>Send</button>
      </div>
    </div>
  );
}

/** The project after an edit: the new timeline, plus any longer preview clips cut for long clips. */
const withEdit = (p: Project, r: { timeline: Project["timeline"]; proxies?: Record<string, Shot["proxy"]> }): Project => ({
  ...p, timeline: r.timeline,
  shots: r.proxies ? p.shots.map((s) => (r.proxies![s.id] ? { ...s, proxy: r.proxies![s.id] } : s)) : p.shots,
});

export default function Editor({ project, setProject, meta, exportReq }: {
  project: Project; setProject: (p: Project) => void; meta: Meta;
  /** Bumped when Export is pressed in the top bar: open the export dialog. */
  exportReq?: number;
}) {
  const [time, setTime] = useState(project.timeline?.reel_start ?? 0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const selected = sel.length ? sel[sel.length - 1] : null; // the clip the trim bar and library act on
  const setSelected = (id: string | null) => setSel(id ? [id] : []);
  // A library shot shown on its own in the preview. Playing the reel or selecting a clip goes back to the reel.
  const [inspectId, setInspectId] = useState<string | null>(null);
  const inspect = (inspectId && project.shots.find((s) => s.id === inspectId)) || null;
  const inspectShot = (id: string | null) => {
    if (id) { setPlaying(false); setSel([]); }
    setInspectId(id);
  };
  useEffect(() => { if (playing || selected) setInspectId(null); }, [playing, selected]);
  /** Copied clips as they play on screen, in seconds: start relative to the first, length, contact after start. */
  const clipboard = useRef<{ shot_id: string; off: number; dur: number; lead: number }[]>([]);
  // Undo / redo / saved versions
  const [hist, setHist] = useState({ undo: !!project.can_undo, redo: !!project.can_redo });
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [savedFlash, setSavedFlash] = useState(0);
  const fromHistory = useRef(false);
  const lastTl = useRef(project.timeline);
  useEffect(() => { // any other change to the reel can be undone, and clears redo
    if (project.timeline !== lastTl.current) {
      if (!fromHistory.current && lastTl.current) setHist({ undo: true, redo: false });
      fromHistory.current = false;
      lastTl.current = project.timeline;
    }
  }, [project.timeline]);
  const applyState = (r: EditorState) => {
    fromHistory.current = r.timeline !== project.timeline;
    setProject({
      ...project, timeline: r.timeline, mood: r.mood, versions: r.versions, can_undo: r.can_undo, can_redo: r.can_redo,
      shots: project.shots.map((s) => ({ ...s, nudge: r.nudges[s.id] ?? null })),
    });
    setHist({ undo: r.can_undo, redo: r.can_redo });
    setSel([]);
  };
  const historyCall = async (fn: () => Promise<EditorState>) => {
    setErr(null);
    try { applyState(await fn()); } catch (e: any) { setErr(e.message); }
  };
  const undo = () => hist.undo && historyCall(() => api.undo(project.id));
  const redo = () => hist.redo && historyCall(() => api.redo(project.id));
  /** Saving or deleting a version leaves the reel (and selection) as it is. */
  const versionCall = async (fn: () => Promise<EditorState>) => {
    setErr(null);
    try { const r = await fn(); setProject({ ...project, versions: r.versions }); return true; }
    catch (e: any) { setErr(e.message); return false; }
  };
  const saveVersion = async () => {
    if (await versionCall(() => api.saveVersion(project.id))) setSavedFlash(Date.now());
  };
  useEffect(() => {
    if (!savedFlash) return;
    const t = setTimeout(() => setSavedFlash(0), 1500);
    return () => clearTimeout(t);
  }, [savedFlash]);
  const saveRef = useRef(saveVersion);
  saveRef.current = saveVersion;
  useEffect(() => { // Ctrl+S
    const on = () => saveRef.current();
    window.addEventListener("app-save", on);
    return () => window.removeEventListener("app-save", on);
  }, []);

  const [copied, setCopied] = useState<{ n: number; label: string | null; at: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const seenExport = useRef(0);
  useEffect(() => {
    if (exportReq && exportReq !== seenExport.current && project.timeline) {
      seenExport.current = exportReq;
      setPlaying(false);
      setExportOpen(true);
    }
  }, [exportReq, project.timeline]);
  const [skeletonOpen, setSkeletonOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const update = useShotUpdater(project, setProject);
  const tl = project.timeline;

  const used = useMemo(() => new Set(tl ? tl.bars.flatMap((b) => b.slots.map((s) => s.shot_id)) : []), [tl]);

  const newDraft = async (fresh: boolean, mood?: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      const p = await api.draft(project.id, { fresh, mood: mood === undefined ? project.mood : mood });
      setProject(p);
      if (p.timeline) setTime(p.timeline.reel_start);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!tl) newDraft(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const edit = async (op: string, args: Record<string, unknown>) => {
    setErr(null);
    try {
      const r = await api.edit(project.id, op, args);
      setProject(withEdit(project, r));
      if (op === "paste_slots" && r.slot_ids?.length) { // playhead onto the pasted clip, so Ctrl+V again chains on
        const last = r.timeline.bars.flatMap((b) => b.slots).find((s) => s.id === r.slot_ids![r.slot_ids!.length - 1]);
        if (last) { setPlaying(false); setTime(last.contact); }
      }
      // moved/resized/new clips get new ids
      if (r.slot_ids) setSel(r.slot_ids);
      else if (r.slot_id) setSelected(r.slot_id);
      else if (op === "delete_slot" || op === "delete_slots") setSel([]);
      else {
        const ids = new Set(r.timeline.bars.flatMap((b) => b.slots.map((s) => s.id)));
        setSel((cur) => cur.filter((id) => ids.has(id)));
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  /** Returns an error message, or null on success (the dialog shows errors itself). */
  const applySkeleton = async (text: string): Promise<string | null> => {
    try {
      const r = await api.edit(project.id, "apply_skeleton", { text });
      setProject(withEdit(project, r));
      return null;
    } catch (e: any) {
      return e.message;
    }
  };

  // Latest requested nudge per shot, so quick repeated clicks/keys build on each other.
  const nudges = useRef<Record<string, number>>({});
  const nudge = async (shotId: string, value: number) => {
    nudges.current[shotId] = value;
    setErr(null);
    try {
      const { timeline, names: _names, all: _all, ...upd } = await api.patchShot(project.id, shotId, { nudge: value });
      if (nudges.current[shotId] !== value) return; // a newer nudge is on its way
      delete nudges.current[shotId];
      setProject({
        ...project,
        shots: project.shots.map((x) => (x.id === shotId ? { ...x, ...upd } as Shot : x)),
        timeline: timeline ?? project.timeline,
      });
      const s = timeline?.bars.flatMap((b) => b.slots).find((x) => x.id === selected);
      // show the frame that now lands on the beat, unless the playhead is already inside the clip
      if (s) { setPlaying(false); setTime((t) => (t >= s.start && t < s.end ? t : s.contact)); }
    } catch (e: any) {
      delete nudges.current[shotId];
      setErr(e.message);
    }
  };
  /** Make a shot's footage run `after` seconds past its contact (the server cuts a longer preview if needed). */
  const shotWindow = async (shotId: string, after: number) => {
    setErr(null);
    try {
      const r = await api.shotWindow(project.id, shotId, after);
      setProject({
        ...project,
        shots: project.shots.map((x) => (x.id === shotId ? { ...x, proxy: r.proxy } : x)),
        timeline: r.timeline ?? project.timeline,
      });
    } catch (e: any) {
      setErr(e.message);
    }
  };

  /** Serves: detect or set when the ball is tossed and when it tops out. */
  const serveMarks = async (shotId: string, b: ServeMarksPatch) => {
    setErr(null);
    try {
      const r = await api.serveMarks(project.id, shotId, b);
      setProject({
        ...project,
        shots: project.shots.map((x) => (x.id === shotId ? { ...x, serve_marks: r.serve_marks, proxy: r.proxy } : x)),
        timeline: r.timeline ?? project.timeline,
      });
    } catch (e: any) {
      setErr(e.message);
    }
  };

  /** Step the playhead one video frame (to find the exact moment of contact). */
  const stepFrame = (d: number) => {
    if (!tl) return false;
    setPlaying(false);
    setTime((t) => Math.max(tl.reel_start, Math.min(tl.reel_end, t + d * FRAME)));
    return true;
  };
  /** Make the frame under the playhead the selected clip's ball contact; it then lands on the beat. */
  const markContact = () => {
    const s = tl?.bars.flatMap((b) => b.slots).find((x) => x.id === selected);
    const sh = s && project.shots.find((x) => x.id === s.shot_id);
    if (!s || !sh || time < s.start || time >= s.end) return false;
    const frame = s.src_start + (time - s.start);
    const { min, max } = nudgeBounds(sh, s, project.videos.find((v) => v.id === sh.video_id)?.duration);
    const v = Math.round(Math.max(min, Math.min(max, frame - sh.t)) / FRAME) * FRAME;
    nudge(sh.id, v).then(() => { setPlaying(false); setTime(s.contact); });
    return true;
  };

  /** Slide several shots' footage at once (Ctrl+drag on a multi-selection). */
  const nudgeMany = async (values: Record<string, number>) => {
    setErr(null);
    try {
      const r = await api.nudges(project.id, values);
      const by = Object.fromEntries(r.shots.map((s) => [s.id, s]));
      setProject({
        ...project,
        shots: project.shots.map((x) => (x.id in by ? { ...x, nudge: by[x.id].nudge, proxy: by[x.id].proxy ?? x.proxy } : x)),
        timeline: r.timeline ?? project.timeline,
      });
    } catch (e: any) {
      setErr(e.message);
    }
  };

  // Ctrl+C / Ctrl+V: copy the selected clips, paste them right after the selection (overwriting).
  const absOf = (id: string) => {
    const bi = tl?.bars.findIndex((b) => b.slots.some((s) => s.id === id)) ?? -1;
    const s = bi >= 0 ? tl!.bars[bi].slots.find((x) => x.id === id)! : null;
    return s ? { a: bi * 16 + s.pos, s } : null;
  };
  const copyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const sliding = useRef(false); // a Ctrl+arrow slide is waiting on the server
  copyRef.current = (e: KeyboardEvent) => {
    if (!tl || !(e.ctrlKey || e.metaKey) || e.altKey || isTyping(e.target as HTMLElement, e.key)) return;
    const k = e.key.toLowerCase();
    if (k === "enter") { if (!inspectId && markContact()) e.preventDefault(); return; } // the shot inspector has its own
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); return; }
    if ((k === "arrowleft" || k === "arrowright") && selected) {
      // Ctrl+←/→: slide the selected clip(s) by exactly 1% (Shift: 5%) of the main clip, like a Ctrl+drag.
      e.preventDefault();
      if (sliding.current) return; // wait for the last step to land (clip ids can change)
      const all = tl.bars.flatMap((b) => b.slots);
      const main = all.find((s) => s.id === selected);
      if (!main) return;
      const step = (e.shiftKey ? 5 : 1) * (k === "arrowleft" ? 1 : -1); // left = frame earlier = contact further in
      const from = main.pos + (main.off ?? 0);
      const pct = Math.max(0, Math.min(100, contactPct(main, from) + step));
      const group = sel.length > 1 ? all.filter((s) => sel.includes(s.id)) : [main];
      const [lo, hi] = groupSlideRange(group);
      const delta = Math.max(lo, Math.min(hi, main.pos + (main.hit ?? 0) - (pct / 100) * main.len - from));
      if (Math.abs(delta) < 1e-4) return;
      sliding.current = true;
      (group.length > 1 ? edit("slide_spans", { ids: sel, delta }) : edit("slide_span", { slot_id: main.id, start: from + delta }))
        .finally(() => { sliding.current = false; });
      return;
    }
    if (k === "c" && sel.length) {
      const items = (sel.map(absOf).filter(Boolean) as { a: number; s: Slot }[]).sort((x, y) => x.s.start - y.s.start);
      clipboard.current = items.map(({ s }) => ({
        shot_id: s.shot_id, off: s.start - items[0].s.start, dur: s.end - s.start, lead: s.contact - s.start,
      }));
      setCopied({ n: items.length, label: items.length === 1 ? items[0].s.label ?? "clip" : null, at: Date.now() });
      e.preventDefault();
    } else if (k === "v" && clipboard.current.length) {
      // Selected clips: paste stitched right after them. Otherwise the clip under the playhead, else the
      // nearest note before the playhead.
      let at = 0;
      const ends = sel.map(absOf).filter(Boolean).map((x) => x!.s.end);
      const bi = tl.bars.findIndex((b) => b.slots.some((s) => time >= s.start && time < s.end));
      if (ends.length) {
        at = Math.max(...ends); // exactly where the selection ends on screen
      } else if (bi >= 0) {
        const s = tl.bars[bi].slots.find((s) => time >= s.start && time < s.end)!;
        at = s.end;
      } else {
        const b = tl.bars.find((b) => time >= b.t0 && time < b.t1);
        at = b ? b.t0 + Math.floor(((time - b.t0) / (b.t1 - b.t0)) * 8) * ((b.t1 - b.t0) / 8) : tl.bars[0].t0;
      }
      edit("paste_slots", { items: clipboard.current, at });
      e.preventDefault();
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => copyRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const nudgeSelected = (d: number) => {
    const s = tl?.bars.flatMap((b) => b.slots).find((x) => x.id === selected);
    const sh = s && project.shots.find((x) => x.id === s.shot_id);
    if (!s || !sh) return false;
    const { min, max } = nudgeBounds(sh, s, project.videos.find((v) => v.id === sh.video_id)?.duration);
    const base = nudges.current[sh.id] ?? sh.nudge ?? 0;
    nudge(sh.id, Math.max(min, Math.min(max, base + d)));
    return true;
  };

  const dialogOpen = exportOpen || skeletonOpen;
  useHotkeys((e) => {
    if (!tl || inspectId) return; // a library shot on its own: ShotInspector handles the keys
    if (e.key === "," || e.key === "<") return nudgeSelected(e.shiftKey ? -0.1 : -FRAME);
    if (e.key === "." || e.key === ">") return nudgeSelected(e.shiftKey ? 0.1 : FRAME);
    if (e.key === "[") return stepFrame(-1);
    if (e.key === "]") return stepFrame(1);
    if (e.key === "m" || e.key === "M") return markContact();
    const per = project.music!.period * (e.shiftKey ? 4 : 1);
    const seek = (t: number) => { setPlaying(false); setTime(Math.max(tl.reel_start, Math.min(tl.reel_end, t))); };
    switch (e.key) {
      case " ": setPlaying(!playing); return true;
      case "ArrowLeft": seek(time - per); return true;
      case "ArrowRight": seek(time + per); return true;
      case "Home": seek(tl.reel_start); return true;
      case "End": seek(tl.drop); return true;
      case "Escape": if (inspectId) { setInspectId(null); return true; } if (sel.length) { setSel([]); return true; } return;
      case "Delete": case "Backspace":
        if (sel.length > 1) { edit("delete_slots", { ids: sel }); return true; }
        if (selected) { edit("delete_slot", { slot_id: selected }); return true; } return;
    }
  }, !dialogOpen);

  if (!tl) {
    return <div className="home"><div className="card">{err ? <span className="error">{err}</span> : "Building your first draft…"}</div></div>;
  }

  return (
    <div className="editor">
      <div className="editor-top">
        <Library project={project} used={used} selectedSlot={selected} update={update}
          onPlace={(s) => selected && edit("set_slot_shot", { slot_id: selected, shot_id: s.id })}
          inspecting={inspectId} onInspect={(s) => inspectShot(inspectId === s.id ? null : s.id)} />
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div className="tl-toolbar" style={{ background: "var(--panel)" }}>
            <span className="muted">Mood</span>
            <select value={project.mood ?? ""} onChange={(e) => newDraft(true, e.target.value || null)} disabled={busy}>
              <option value="">Any</option>
              {meta.moods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button disabled={busy} onClick={() => newDraft(false)} title="New variation, keeping the clips you changed by hand">
              ↻ Reshuffle
            </button>
            <button disabled={busy} onClick={() => newDraft(true)} title="Start over from a fresh draft">New draft</button>
            <button onClick={() => { setPlaying(false); setSkeletonOpen(true); }}
              title="View and edit the build-up as text: F1 F1 F2 B1 …">Skeleton ✎</button>
            <span className="seg">
              <button disabled={!hist.undo} onClick={undo} title="Undo (Ctrl+Z)">↶</button>
              <button disabled={!hist.redo} onClick={redo} title="Redo (Ctrl+Shift+Z)">↷</button>
            </span>
            <span className="versions-wrap">
              <span className="seg">
                <button onClick={saveVersion} title="Save this version so you can come back to it (Ctrl+S)">
                  {savedFlash ? "Saved ✓" : "Save"}
                </button>
                <button className={versionsOpen ? "on" : ""} onClick={() => setVersionsOpen(!versionsOpen)}
                  title="Go back to a saved version">▾{project.versions?.length ? ` ${project.versions.length}` : ""}</button>
              </span>
              {versionsOpen && (
                <div className="versions-menu" onMouseLeave={() => setVersionsOpen(false)}>
                  {!project.versions?.length && <div className="muted">No saved versions</div>}
                  {[...(project.versions ?? [])].reverse().map((v) => (
                    <div key={v.id} className="version-row"
                      onClick={() => { setVersionsOpen(false); historyCall(() => api.restoreVersion(project.id, v.id)); }}>
                      <span>{v.name}</span>
                      <span className="muted">{new Date(v.time * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                      <button className="small ghost" title="Delete"
                        onClick={(e) => { e.stopPropagation(); versionCall(() => api.deleteVersion(project.id, v.id)); }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </span>
            {copied && (
              <span key={copied.at} className="chip copied" title="Ctrl+V pastes right after the selected clip">
                📋 {copied.label ? `${copied.label} copied` : `${copied.n} clips copied`} · Ctrl+V
                <button className="small ghost" title="Clear" onClick={() => { clipboard.current = []; setCopied(null); }}>✕</button>
              </span>
            )}
            {err && <span className="error">{err}</span>}
            <span className="spacer" />
            <span className="muted">{tl.bars.length} bars · {tl.bars.reduce((n, b) => n + b.slots.length, 0)} clips · {tl.duration.toFixed(1)}s</span>
            <button className="primary" onClick={() => { setPlaying(false); setExportOpen(true); }}>Export ▸</button>
          </div>
          <Preview project={project} timeline={tl} time={time} setTime={setTime} playing={playing} setPlaying={setPlaying}
            inspect={inspect} onInspect={inspectShot} onNudge={nudge} keys={!dialogOpen}
            clip={tl.bars.flatMap((b) => b.slots).find((s) => s.id === selected) ?? null} onStepFrame={stepFrame} onWindow={shotWindow} onServeMarks={serveMarks} />
        </div>
        <Chat project={project} available={meta.chat_available}
          onResult={(r) => setProject({ ...project, timeline: r.timeline, chat: r.chat, shots: r.shots })} />
      </div>
      <Timeline project={project} timeline={tl} time={time}
        onSeek={(t) => { setPlaying(false); setTime(t); setInspectId(null); }}
        selected={selected} selection={sel}
        onSelect={(id, add) => setSel((cur) => !id ? [] : !add ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])}
        onSelectMany={setSel}
        onEdit={edit}
        onNudge={nudge} onNudgeMany={nudgeMany} onStepFrame={stepFrame} onMarkContact={markContact} />
      {skeletonOpen && (
        <SkeletonDialog timeline={tl} onClose={() => setSkeletonOpen(false)} onApply={applySkeleton} />
      )}
      {exportOpen && (
        <ExportDialog project={project} meta={meta} onClose={() => setExportOpen(false)}
          onDone={() => api.project(project.id).then(setProject)} />
      )}
    </div>
  );
}
