import { useCallback, useEffect, useState } from "react";
import { api, Job, Meta, pollJob, Project } from "./api";
import Home from "./Home";
import SongStep from "./SongStep";
import ShotsStep from "./ShotsStep";
import Editor from "./Editor";
import ProgressBar from "./Progress";
import RallyStep from "./RallyStep";
import ErrorBoundary from "./ErrorBoundary";

type Step = "song" | "shots" | "editor" | "rally";

function readHash(): { pid: string | null; step: Step } {
  const m = location.hash.match(/^#\/p\/([^/]+)(?:\/(song|shots|editor|rally))?/);
  return m ? { pid: m[1], step: (m[2] as Step) || "song" } : { pid: null, step: "song" };
}

/** The project's name in the top bar; click it to rename. */
function ProjectName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return <strong className="project-name" title="Click to rename" onClick={() => setDraft(name)}>{name}</strong>;
  }
  const done = (save: boolean) => {
    const v = draft.trim();
    setDraft(null);
    if (save && v && v !== name) onRename(v);
  };
  return (
    <input type="text" className="project-name-input" value={draft} autoFocus maxLength={80}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); }} />
  );
}

export default function App() {
  const [route, setRoute] = useState(readHash);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [runs, setRuns] = useState(0); // bumped to follow a newly started analysis job
  const [savedAt, setSavedAt] = useState(0);
  const [exportReq, setExportReq] = useState(0); // bumped by the top bar's Export button
  // The backend changed since the server started: tell the user to restart run.bat (checked every 20 s).
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const check = () => api.status().then((r) => setStale(r.stale)).catch(() => {});
    check();
    const id = setInterval(check, 20000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    api.meta().then(setMeta).catch((e) => setErr(String(e)));
    const on = () => setRoute(readHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const go = (pid: string | null, step: Step = "song") => {
    location.hash = pid ? `#/p/${pid}/${step}` : "#/";
  };

  const reload = useCallback(async (pid: string) => {
    const p = await api.project(pid);
    setProject(p);
    return p;
  }, []);

  // Load project and follow its analysis job.
  useEffect(() => {
    if (!route.pid) { setProject(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const p = await reload(route.pid!);
        if (p.status !== "ready" && p.job) {
          const j = await pollJob(p.job, (j) => !cancelled && setJob(j));
          if (cancelled) return;
          if (j.status === "error") setErr(`Analysis failed: ${j.error}`);
          setJob(null);
          setStopping(false);
          await reload(route.pid!);
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [route.pid, reload, runs]);

  const p = project && project.id === route.pid ? project : null;
  const ready = p?.status === "ready";

  // Remember the step so reopening the project resumes here.
  useEffect(() => {
    if (p) api.setStep(p.id, route.step).catch(() => {});
  }, [p?.id, route.step]);

  // Ctrl+S: edits autosave; this flushes pending song markers and confirms.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        window.dispatchEvent(new Event("app-save"));
        setSavedAt(Date.now());
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(0), 1500);
    return () => clearTimeout(t);
  }, [savedAt]);
  const notStarted = p && p.status === "new" && !job;

  const stopAnalysis = async () => {
    if (!p || !confirm("Stop analyzing footage? Everything analyzed so far will be erased.")) return;
    setStopping(true);
    try {
      const r = await api.stop(p.id);
      if (!r.job) { setStopping(false); setJob(null); await reload(p.id); }
      // otherwise the job poller sees it end as "cancelled" and reloads the project
    } catch (e) {
      setStopping(false);
      setErr(String(e));
    }
  };

  const startAnalysis = async () => {
    if (!p) return;
    try {
      await api.reanalyze(p.id);
      setRuns((n) => n + 1);
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="logo" onClick={() => go(null)}><span className="ball" /> Stopmotion Clipper</div>
        {p && (
          <>
            <span className="muted">/</span>
            <ProjectName name={p.name} onRename={async (name) => {
              try { const r = await api.rename(p.id, name); setProject({ ...p, name: r.name }); }
              catch (e) { setErr(String(e)); }
            }} />
            <div className="steps">
              <button className={route.step === "song" ? "active" : ""} onClick={() => go(p.id, "song")}>1 · Song</button>
              <button className={route.step === "shots" ? "active" : ""} disabled={!ready} onClick={() => go(p.id, "shots")}>2 · Shots</button>
              <button className={route.step === "editor" ? "active" : ""} disabled={!ready} onClick={() => go(p.id, "editor")}>3 · Editor</button>
              <button className={route.step === "rally" ? "active" : ""} disabled={!ready} onClick={() => go(p.id, "rally")}>4 · Rally</button>
            </div>
          </>
        )}
        <div className="spacer" />
        {p && ready && p.timeline && (
          <button className="primary small" onClick={() => { setExportReq((n) => n + 1); go(p.id, "editor"); }}
            title="Render the reel as a video: your footage with the song as its only sound">Export ▸</button>
        )}
        {p && savedAt > 0 && <span className="muted">Saved</span>}
        {stale && <span className="error" title="The app was updated. Close the run.bat window and double-click run.bat again.">⚠ Restart run.bat to load the latest changes</span>}
        {err && <span className="error" onClick={() => setErr(null)} title="Dismiss">{err}</span>}
      </div>
      {job && job.status === "running" && (
        <div className="banner">
          <strong>Analyzing footage</strong>
          <ProgressBar progress={job.progress} />
          <span className="muted">{job.message}</span>
          <span className="spacer" />
          <button className="small" onClick={stopAnalysis} disabled={stopping}
                  title="Stop analyzing and erase all progress so far">
            {stopping ? "Stopping…" : "Stop analysis"}
          </button>
        </div>
      )}
      {notStarted && (
        <div className="banner">
          <strong>Footage not analyzed</strong>
          <span className="spacer" />
          <button className="small primary" onClick={startAnalysis}>Start analysis</button>
        </div>
      )}
      <div className="main">
        <ErrorBoundary resetKey={`${route.pid}/${route.step}`}>
        {!route.pid && meta && <Home meta={meta} onOpen={(id, step) => go(id, step ?? "song")} />}
        {p && route.step === "song" && (
          <SongStep project={p} onSaved={setProject} onNext={() => go(p.id, "shots")} ready={ready} />
        )}
        {p && ready && route.step === "shots" && (
          <ShotsStep project={p} setProject={setProject} onNext={() => go(p.id, "editor")} />
        )}
        {p && ready && route.step === "rally" && (
          <RallyStep project={p} setProject={setProject} onDone={() => go(p.id, "editor")} />
        )}
        {p && ready && route.step === "editor" && meta && (
          <Editor project={p} setProject={setProject} meta={meta} exportReq={exportReq} />
        )}
        {p && !ready && route.step !== "song" && (
          <div className="home"><div className="card">{notStarted ? "Footage hasn't been analyzed yet." : "Still analyzing footage…"}</div></div>
        )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
