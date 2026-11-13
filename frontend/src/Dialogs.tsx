import { useState } from "react";
import { api, fileUrl, Job, Meta, pollJob, Project, Rally } from "./api";
import ProgressBar from "./Progress";
import LoadMore from "./LoadMore";

function RallyRow({ project, r, current, startHit, onUse }: {
  project: Project; r: Rally; current: boolean; startHit: number | null; onUse: (start: number | null) => void;
}) {
  const [start, setStart] = useState<number | null>(startHit);
  const [hover, setHover] = useState(false);
  const from = r.hits[start ?? r.best_start].t - r.proxy.start - 0.3;
  return (
    <div className={`rally-row ${current ? "cur" : ""}`}>
      <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {hover ? (
          <video src={fileUrl(project.id, r.proxy.file)} muted autoPlay playsInline
            onLoadedMetadata={(e) => { e.currentTarget.currentTime = Math.max(0, from); }} />
        ) : (
          <video src={fileUrl(project.id, r.proxy.file) + "#t=" + Math.max(0, from).toFixed(2)} muted preload="metadata" />
        )}
      </div>
      <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
        <div className="row">
          <strong>{r.n_hits} shots</strong>
          <span className="muted">{r.duration.toFixed(1)}s · score {(r.score * 100).toFixed(0)}</span>
          {current && <span className="badge" style={{ background: "var(--accent)" }}>IN REEL</span>}
          <span className="spacer" />
          <button className="small primary" onClick={() => onUse(start)}>Use{start === null ? " (auto start)" : ` from shot ${start + 1}`}</button>
        </div>
        <div className="hits">
          {r.hits.map((h, i) => (
            <span key={i}
              className={`hit ${h.player === "me" ? "me" : ""} ${(start ?? r.best_start) === i ? "start" : ""} ${i < (start ?? r.best_start) ? "dim" : ""}`}
              title={h.inferred ? "Opponent hit (inferred)" : h.player === "me" ? "You" : "Opponent"}
              onClick={() => !h.inferred && i < r.hits.length - 1 && setStart(i)}>
              {i + 1}·{h.player === "me" ? "You" : "Opp"}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RallyPicker({ project, setProject, onClose, onPick }: {
  project: Project; setProject: (p: Project) => void; onClose: () => void;
  onPick: (rallyId: string, start: number | null) => void;
}) {
  const cur = project.timeline?.rally;
  const rallies = [...project.rallies].sort((a, b) => b.score - a.score);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3>Choose the drop rally</h3><span className="spacer" /><button onClick={onClose}>Close</button></div>
        {rallies.map((r) => (
          <RallyRow key={r.id} project={project} r={r} current={cur?.rally_id === r.id}
            startHit={cur?.rally_id === r.id ? cur.start_hit ?? null : null}
            onUse={(s) => onPick(r.id, s)} />
        ))}
        {!rallies.length && <p>No rallies were found in this footage.</p>}
        <LoadMore project={project} group="rally" setProject={setProject} />
      </div>
    </div>
  );
}

export function ExportDialog({ project, meta, onClose, onDone }: {
  project: Project; meta: Meta; onClose: () => void; onDone: () => void;
}) {
  const anyHdr = project.videos.some((v) => v.hdr);
  const [resolution, setResolution] = useState("source");
  const [hdr, setHdr] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<{ id: string; file: string; width: number; height: number; duration: number } | null>(null);
  const [moods, setMoods] = useState<string[]>(project.mood ? [project.mood] : []);
  const [rating, setRating] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setErr(null);
    try {
      const { job: jid } = await api.export(project.id, { resolution, hdr });
      const j = await pollJob(jid, setJob);
      if (j.status === "error") setErr(j.error);
      else setResult(j.result);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const sendFeedback = async () => {
    if (!result) return;
    await api.feedback(project.id, result.id, { rating, moods });
    setSaved(true);
    onDone();
  };

  return (
    <div className="modal-bg" onClick={() => !job || job.status !== "running" ? onClose() : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Export reel</h3>
        {!job && (
          <>
            <div className="field">
              <label>Resolution</label>
              <div className="chips">
                <span className={`chip ${resolution === "source" ? "on" : ""}`} onClick={() => setResolution("source")}>Original quality (up to 4K)</span>
                <span className={`chip ${resolution === "1080" ? "on" : ""}`} onClick={() => setResolution("1080")}>1080×1920 (faster)</span>
              </div>
            </div>
            {anyHdr && (
              <div className="field">
                <label>Color</label>
                <div className="chips">
                  <span className={`chip ${!hdr ? "on" : ""}`} onClick={() => setHdr(false)}>SDR (looks consistent everywhere)</span>
                  <span className={`chip ${hdr ? "on" : ""}`} onClick={() => setHdr(true)}>Keep iPhone HDR</span>
                </div>
              </div>
            )}
            <div className="row"><button className="primary" onClick={start}>Render</button><button onClick={onClose}>Cancel</button></div>
          </>
        )}
        {job && !result && !err && (
          <div style={{ display: "grid", gap: 8 }}>
            <ProgressBar progress={job.progress} wide />
            <span className="muted">{job.message}</span>
          </div>
        )}
        {err && <p className="error">{err}</p>}
        {result && (
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16 }}>
            <video src={fileUrl(project.id, result.file)} controls style={{ width: 220, aspectRatio: "9/16", background: "#000", borderRadius: 8 }} />
            <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
              <div><strong>Done!</strong> <span className="muted">{result.width}×{result.height} · {result.duration.toFixed(1)}s</span></div>
              <a href={fileUrl(project.id, result.file)} download={`${project.name}.mp4`}><button className="primary">Download MP4</button></a>
              <div className="field" style={{ margin: 0 }}>
                <label>What mood is this reel?</label>
                <div className="chips">
                  {meta.moods.map((m) => (
                    <span key={m} className={`chip ${moods.includes(m) ? "on" : ""}`}
                      onClick={() => setMoods(moods.includes(m) ? moods.filter((x) => x !== m) : [...moods, m])}>{m}</span>
                  ))}
                </div>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>How did it turn out?</label>
                <div className="chips">
                  <span className={`chip ${rating === "up" ? "on" : ""}`} onClick={() => setRating("up")}>👍 Love it</span>
                  <span className={`chip ${rating === "down" ? "on" : ""}`} onClick={() => setRating("down")}>👎 Not quite</span>
                </div>
              </div>
              <div className="row">
                <button className="primary" disabled={saved} onClick={sendFeedback}>{saved ? "Learned ✓" : "Save & learn from this reel"}</button>
                <button onClick={onClose}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
