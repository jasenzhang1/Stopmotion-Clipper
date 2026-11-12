import { useState } from "react";
import { api, Job, pollJob, Project } from "./api";
import ProgressBar from "./Progress";

const NAMES: Record<string, [string, string]> = {
  forehand: ["forehand", "forehands"], backhand: ["backhand", "backhands"], serve: ["serve/overhead", "serves/overheads"],
  volley: ["volley", "volleys"], approach: ["approach shot", "approach shots"], unknown: ["unlabeled shot", "unlabeled shots"],
  rally: ["rally", "rallies"],
};
const STEP: Record<string, number> = { forehand: 10, backhand: 10, serve: 5, volley: 5, approach: 5, unknown: 10, rally: 6 };

/** "+ 10 more forehands" button: makes previews for the next-best parked shots of a kind, then reloads. */
export default function LoadMore({ project, group, setProject }: {
  project: Project; group: string; setProject: (p: Project) => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const left = project.pool?.[group]?.more ?? 0;
  if (!left && !job) return null;
  const n = Math.min(left, STEP[group] ?? 10);
  const [one, many] = NAMES[group] ?? [group, group];

  const go = async () => {
    setErr(null);
    try {
      const { job: id } = await api.more(project.id, group, n);
      const j = await pollJob(id, setJob);
      if (j.status === "error") setErr(j.error || "Failed");
      setProject(await api.project(project.id));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setJob(null);
    }
  };

  if (job) {
    return (
      <div className="load-more busy">
        <span className="muted">Loading {n} more {n === 1 ? one : many}…</span>
        <ProgressBar progress={job.progress} />
      </div>
    );
  }
  return (
    <div className="load-more">
      <button onClick={go} title={`Make previews for the next ${n} best ${many} from your footage`}>
        + {n} more {n === 1 ? one : many}
      </button>
      <span className="muted">{left} more in your footage</span>
      {err && <span className="error">{err}</span>}
    </div>
  );
}
