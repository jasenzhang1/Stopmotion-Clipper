import { useMemo, useRef, useState } from "react";
import LoadMore from "./LoadMore";
import { api, COMPLAINTS, fileUrl, matchFilter, Project, Shot, ShotPatch, ShotType, TYPE_CODE, TYPE_LABEL } from "./api";

export function Stars({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  return (
    <span className="stars">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? "on" : ""} onClick={(e) => { e.stopPropagation(); onChange?.(n); }}>★</span>
      ))}
    </span>
  );
}

export const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" }, { key: "forehand", label: "FH" }, { key: "backhand", label: "BH" }, { key: "slice", label: "Slice" },
  { key: "volley", label: "Volley" }, { key: "approach", label: "Approach" }, { key: "serve", label: "Serve/OH" },
  { key: "unknown", label: "Unlabeled" },
];

const TYPES: ShotType[] = ["forehand", "backhand", "fh_slice", "bh_slice", "fh_volley", "bh_volley", "approach", "serve", "overhead", "unknown"];

export function useShotUpdater(project: Project, setProject: (p: Project) => void) {
  return async (s: Shot, patch: ShotPatch) => {
    const { timeline, all, names, ...upd } = await api.patchShot(project.id, s.id, patch);
    const rescored = all && Object.fromEntries(all.map((a) => [a.id, a]));
    setProject({
      ...project,
      shots: project.shots.map((x) => {
        const y = x.id === s.id ? { ...x, ...rescored?.[x.id], ...upd } as Shot : rescored?.[x.id] ? { ...x, ...rescored[x.id] } : x;
        return names?.[x.id] ? { ...y, name: names[x.id] } : y;
      }),
      timeline: timeline ?? project.timeline,
    });
  };
}

function ShotCard({ project, shot, update }: { project: Project; shot: Shot; update: ReturnType<typeof useShotUpdater> }) {
  const [hover, setHover] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [note, setNote] = useState("");
  const vid = useRef<HTMLVideoElement>(null);
  const typeSel = useRef<HTMLSelectElement>(null);
  const complain = (reason: string) => {
    update(shot, { complaint: { reason, note: note.trim() || undefined } });
    setFlagging(false);
    setNote("");
    if (reason === "wrong_stroke") {
      typeSel.current?.focus();
      try { typeSel.current?.showPicker(); } catch { /* not supported */ }
    }
  };
  const contact = shot.t - shot.proxy.start;
  return (
    <div className={`shot-card ${shot.hidden ? "hidden-shot" : ""}`}>
      <div className="shot-media" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <img src={fileUrl(project.id, shot.thumb)} loading="lazy" alt="" />
        {hover && (
          <video ref={vid} src={fileUrl(project.id, shot.proxy.file)} muted autoPlay playsInline
            onLoadedMetadata={(e) => { e.currentTarget.currentTime = Math.max(0, contact - 0.6); }}
            onTimeUpdate={(e) => { if (e.currentTarget.currentTime > contact + 0.8) e.currentTarget.currentTime = Math.max(0, contact - 0.6); }} />
        )}
      </div>
      <div className="meta">
        <div className="row">
          <span className={`badge t-${shot.type}`} title={TYPE_LABEL[shot.type]}>{shot.name ?? TYPE_CODE[shot.type]}</span>
          <Stars value={shot.stars} onChange={(n) => update(shot, { stars: n })} />
          {shot.serve && (
            <span className={`chip serve-chip ${shot.serve.in ? "in" : "out"}`}
              title={(shot.serve.in
                ? "Went in: usable on any clip length."
                : "Didn't go in: only used on quarter notes or shorter, where nobody can tell.")
                + (shot.serve.source === "user" ? " (set by you)" : " (auto-detected)") + " Click to change."}
              onClick={() => update(shot, { serve_in: !shot.serve!.in })}>
              {shot.serve.in ? "In" : `Fault · ${shot.serve.first ? "1st" : "2nd"}`}
            </span>
          )}
          <span className="spacer" />
          <button className={`small ghost ${flagging ? "on" : ""}`} title="What's wrong?" onClick={() => setFlagging(!flagging)}>⚑</button>
          <button className="small ghost" title={shot.hidden ? "Include" : "Exclude from reels"}
            onClick={() => update(shot, { hidden: !shot.hidden })}>{shot.hidden ? "↺" : "✕"}</button>
        </div>
        {flagging && (
          <div className="flag-panel">
            {COMPLAINTS.map((c) => <span key={c.key} className="chip" onClick={() => complain(c.key)}>{c.label}</span>)}
            <input type="text" placeholder="Other…" value={note} autoFocus
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && note.trim()) complain("other"); if (e.key === "Escape") setFlagging(false); }} />
          </div>
        )}
        <select ref={typeSel} value={shot.type} onChange={(e) => update(shot, { type: e.target.value as ShotType })}>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}{t === shot.auto_type && shot.label_source === "user" ? " (auto)" : ""}</option>)}
        </select>
      </div>
    </div>
  );
}

export default function ShotsStep({ project, setProject, onNext }: {
  project: Project; setProject: (p: Project) => void; onNext: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<"stars" | "time">("stars");
  const update = useShotUpdater(project, setProject);
  const shots = useMemo(() => {
    const vids = Object.fromEntries(project.videos.map((v, i) => [v.id, i]));
    return project.shots
      .filter((s) => matchFilter(s, filter))
      .sort((a, b) => sort === "stars" ? b.quality - a.quality : vids[a.video_id] - vids[b.video_id] || a.t - b.t);
  }, [project, filter, sort]);
  const st = project.stats;

  return (
    <div className="shots-step">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Your shots</h2>
        {st && <span className="muted">Showing your best {project.shots.length} of {st.shots} shots · {st.rallies} rallies from {st.videos} videos</span>}
        <span className="spacer" />
        <button className="primary" onClick={onNext}>Next: build the reel →</button>
      </div>
      {st && !st.pose_used && (
        <p className="error">No players were detected in the video frames, so shots were found from sound only and are unlabeled.</p>
      )}
      <div className="row">
        <div className="chips">
          {FILTERS.map((f) => (
            <span key={f.key} className={`chip ${filter === f.key ? "on" : ""}`} onClick={() => setFilter(f.key)}>
              {f.label} <span className="muted">{project.shots.filter((s) => matchFilter(s, f.key)).length}</span>
            </span>
          ))}
        </div>
        <span className="spacer" />
        <select value={sort} onChange={(e) => setSort(e.target.value as "stars" | "time")}>
          <option value="stars">Best first</option>
          <option value="time">In order filmed</option>
        </select>
      </div>
      <div className="shot-grid">
        {shots.map((s) => <ShotCard key={s.id} project={project} shot={s} update={update} />)}
      </div>
      <div className="load-more-row">
        {(filter === "all" ? ["forehand", "backhand", "serve", "volley", "approach", "unknown"] : [filter]).map((g) => (
          <LoadMore key={g} project={project} group={g} setProject={setProject} />
        ))}
      </div>
    </div>
  );
}
