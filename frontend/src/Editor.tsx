import { useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, matchFilter, Meta, Project, Shot, TYPE_CODE } from "./api";
import Preview from "./Preview";
import { useHotkeys } from "./hotkeys";
import { FRAME, nudgeBounds } from "./ClipTrim";
import Timeline from "./Timeline";
import { ExportDialog, RallyPicker } from "./Dialogs";
import { SkeletonDialog } from "./Skeleton";
import { FILTERS, Stars, useShotUpdater } from "./ShotsStep";

function Library({ project, used, selectedSlot, onPlace, update }: {
  project: Project; used: Set<string>; selectedSlot: string | null;
  onPlace: (shot: Shot) => void; update: ReturnType<typeof useShotUpdater>;
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
          <div key={s.id} className={`lib-item ${used.has(s.id) ? "used" : ""}`} draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", `shot:${s.id}`)}
            onClick={() => selectedSlot && onPlace(s)}
            title={selectedSlot ? "Put in selected clip" : "Drag onto a clip in the timeline"}>
            <img src={fileUrl(project.id, s.thumb)} loading="lazy" alt="" />
            <div style={{ display: "grid", gap: 2 }}>
              <span><span className={`badge t-${s.type}`}>{TYPE_CODE[s.type]}</span> <span className="muted" style={{ fontSize: 11 }}>{s.id}</span></span>
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
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth" }), [project.chat.length, pending]);

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
            "make bar -3 eighth notes", or "pick a longer rally for the drop".
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

export default function Editor({ project, setProject, meta }: {
  project: Project; setProject: (p: Project) => void; meta: Meta;
}) {
  const [time, setTime] = useState(project.timeline?.reel_start ?? 0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [rallyOpen, setRallyOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
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
      setProject({ ...project, timeline: r.timeline });
      if (r.slot_id) setSelected(r.slot_id); // moved/resized/new clips get new ids
      else if (op === "delete_slot") setSelected(null);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  /** Returns an error message, or null on success (the dialog shows errors itself). */
  const applySkeleton = async (text: string): Promise<string | null> => {
    try {
      const r = await api.edit(project.id, "apply_skeleton", { text });
      setProject({ ...project, timeline: r.timeline });
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
      const { timeline, ...upd } = await api.patchShot(project.id, shotId, { nudge: value });
      if (nudges.current[shotId] !== value) return; // a newer nudge is on its way
      delete nudges.current[shotId];
      setProject({
        ...project,
        shots: project.shots.map((x) => (x.id === shotId ? { ...x, ...upd } as Shot : x)),
        timeline: timeline ?? project.timeline,
      });
      const s = timeline?.bars.flatMap((b) => b.slots).find((x) => x.id === selected);
      if (s) { setPlaying(false); setTime(s.contact); } // show the frame that now lands on the beat
    } catch (e: any) {
      delete nudges.current[shotId];
      setErr(e.message);
    }
  };
  const nudgeSelected = (d: number) => {
    const s = tl?.bars.flatMap((b) => b.slots).find((x) => x.id === selected);
    const sh = s && project.shots.find((x) => x.id === s.shot_id);
    if (!s || !sh) return false;
    const { min, max } = nudgeBounds(sh, s);
    const base = nudges.current[sh.id] ?? sh.nudge ?? 0;
    nudge(sh.id, Math.max(min, Math.min(max, base + d)));
    return true;
  };

  const dialogOpen = rallyOpen || exportOpen || skeletonOpen;
  useHotkeys((e) => {
    if (!tl) return;
    if (e.key === "," || e.key === "<") return nudgeSelected(e.shiftKey ? -0.1 : -FRAME);
    if (e.key === "." || e.key === ">") return nudgeSelected(e.shiftKey ? 0.1 : FRAME);
    const per = project.music!.period * (e.shiftKey ? 4 : 1);
    const seek = (t: number) => { setPlaying(false); setTime(Math.max(tl.reel_start, Math.min(tl.reel_end, t))); };
    switch (e.key) {
      case " ": setPlaying(!playing); return true;
      case "ArrowLeft": seek(time - per); return true;
      case "ArrowRight": seek(time + per); return true;
      case "Home": seek(tl.reel_start); return true;
      case "End": seek(tl.drop); return true;
      case "Escape": if (selected) { setSelected(null); return true; } return;
      case "Delete": case "Backspace":
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
          onPlace={(s) => selected && edit("set_slot_shot", { slot_id: selected, shot_id: s.id })} />
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div className="tl-toolbar" style={{ background: "var(--panel)" }}>
            <span className="muted">Mood</span>
            <select value={project.mood ?? ""} onChange={(e) => newDraft(true, e.target.value || null)} disabled={busy}>
              <option value="">Any</option>
              {meta.moods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button disabled={busy} onClick={() => newDraft(false)} title="New variation, keeping the clips and bar settings you changed by hand">
              ↻ Reshuffle
            </button>
            <button disabled={busy} onClick={() => newDraft(true)} title="Start over from a fresh draft">New draft</button>
            <button onClick={() => { setPlaying(false); setSkeletonOpen(true); }}
              title="View and edit the build-up as text: F1 F1 F2 B1 …">Skeleton ✎</button>
            {err && <span className="error">{err}</span>}
            <span className="spacer" />
            <span className="muted">{tl.bars.length} bars · {tl.bars.reduce((n, b) => n + b.slots.length, 0)} clips · {tl.duration.toFixed(1)}s</span>
            <button className="primary" onClick={() => { setPlaying(false); setExportOpen(true); }}>Export ▸</button>
          </div>
          <Preview project={project} timeline={tl} time={time} setTime={setTime} playing={playing} setPlaying={setPlaying} />
        </div>
        <Chat project={project} available={meta.chat_available}
          onResult={(r) => setProject({ ...project, timeline: r.timeline, chat: r.chat, shots: r.shots })} />
      </div>
      <Timeline project={project} timeline={tl} time={time}
        onSeek={(t) => { setPlaying(false); setTime(t); }}
        selected={selected} onSelect={setSelected} onEdit={edit} onOpenRally={() => setRallyOpen(true)}
        onNudge={nudge} />
      {rallyOpen && (
        <RallyPicker project={project} setProject={setProject} onClose={() => setRallyOpen(false)}
          onPick={(id, start) => { setRallyOpen(false); edit("set_rally", { rally_id: id, start_hit: start }); }} />
      )}
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
