import { useEffect, useState } from "react";
import { api, Meta, ProjectSummary } from "./api";

function Browser({ mode, value, onPick }: { mode: "folder" | "audio"; value: string; onPick: (p: string) => void }) {
  const [roots, setRoots] = useState<{ name: string; path: string }[]>([]);
  const [listing, setListing] = useState<Awaited<ReturnType<typeof api.list>> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const open = (path: string) => api.list(path).then((l) => { setListing(l); setErr(null); }).catch((e) => setErr(String(e.message ?? e)));

  useEffect(() => {
    api.roots().then((r) => {
      setRoots(r);
      const gd = r.find((x) => x.name === "Google Drive");
      open(gd?.path ?? r[0]?.path);
    });
  }, []);

  return (
    <div className="browser">
      <div className="crumbs">
        {roots.map((r) => (
          <button key={r.path} className="small" onClick={() => open(r.path)}>{r.name}</button>
        ))}
      </div>
      <div className="crumbs" style={{ background: "transparent" }}>
        {listing?.parent && <button className="small" onClick={() => open(listing.parent!)}>↑ Up</button>}
        <span className="muted" style={{ wordBreak: "break-all" }}>{listing?.path}</span>
        <span className="spacer" />
        {mode === "folder" && listing && (
          <button className="small primary" disabled={!listing.n_videos} onClick={() => onPick(listing.path)}>
            Use this folder ({listing.n_videos} videos)
          </button>
        )}
      </div>
      {roots.length > 0 && !roots.some((r) => r.name === "Google Drive") && (
        <div className="muted" style={{ padding: "6px 8px", fontSize: 12 }}>
          <a href="https://www.google.com/drive/download/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>Get Google Drive for Desktop</a>
        </div>
      )}
      {err && <div className="error" style={{ padding: 8 }}>{err}</div>}
      <div className="entries">
        {listing?.entries
          .filter((e) => e.kind === "dir" || (mode === "audio" ? e.kind === "audio" : e.kind === "video"))
          .map((e) => (
            <div
              key={e.path}
              className={`entry ${value === e.path ? "sel" : ""}`}
              onClick={() => (e.kind === "dir" ? open(e.path) : mode === "audio" && onPick(e.path))}
            >
              <span>{e.kind === "dir" ? "📁" : e.kind === "audio" ? "🎵" : "🎬"}</span>
              <span>{e.name}</span>
            </div>
          ))}
        {listing && !listing.entries.length && <div className="entry muted">Empty folder</div>}
      </div>
    </div>
  );
}

const COUNT_FIELDS: { key: string; label: string }[] = [
  { key: "forehand", label: "Forehands" }, { key: "backhand", label: "Backhands" }, { key: "serve", label: "Serves / overheads" },
  { key: "volley", label: "Volleys" }, { key: "approach", label: "Approach shots" }, { key: "unknown", label: "Unlabeled" },
  { key: "rally", label: "Rallies (for the drop)" },
];
const COUNTS_KEY = "clipper.previewCounts";

function savedCounts(defaults: Record<string, number>): Record<string, number> {
  try {
    const s = JSON.parse(localStorage.getItem(COUNTS_KEY) || "null");
    if (s && typeof s === "object") return { ...defaults, ...s };
  } catch { /* storage unavailable: use defaults */ }
  return { ...defaults };
}

/** How many of the best shots of each kind get previews during analysis (the rest can be loaded later). */
function CountsField({ counts, defaults, setCounts }: {
  counts: Record<string, number>; defaults: Record<string, number>; setCounts: (c: Record<string, number>) => void;
}) {
  const changed = COUNT_FIELDS.some((f) => counts[f.key] !== defaults[f.key]);
  return (
    <div className="field">
      <label>Best shots to load</label>
      <div className="count-grid">
        {COUNT_FIELDS.map((f) => (
          <label key={f.key} className="count-input">
            <span>{f.label}</span>
            <input type="number" min={0} max={1000} step={1} value={counts[f.key] ?? 0}
              onChange={(e) => setCounts({ ...counts, [f.key]: Math.max(0, Math.min(1000, Math.round(+e.target.value || 0))) })} />
          </label>
        ))}
      </div>
      {changed && (
        <div><button className="small ghost" onClick={() => setCounts({ ...defaults })}>Reset to defaults</button></div>
      )}
    </div>
  );
}

export default function Home({ meta, onOpen }: { meta: Meta; onOpen: (id: string, step?: ProjectSummary["last_step"]) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState("");
  const [footage, setFootage] = useState("");
  const [song, setSong] = useState("");
  const [handed, setHanded] = useState(meta.handed);
  const defaults = meta.preview_defaults ?? {};
  const [counts, setCountsState] = useState(() => savedCounts(defaults));
  const setCounts = (c: Record<string, number>) => {
    setCountsState(c);
    try { localStorage.setItem(COUNTS_KEY, JSON.stringify(c)); } catch { /* not critical */ }
  };
  const [pick, setPick] = useState<"folder" | "audio" | null>("folder");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.projects().then(setProjects); }, []);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const p = await api.create({ name, footage_dir: footage, song_path: song, handed, counts });
      onOpen(p.id);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <div className="card">
        <h2>New reel</h2>
        <div className="field">
          <label>Name</label>
          <input type="text" value={name} placeholder="e.g. Saturday hitting" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Footage folder (Google Drive for Desktop works)</label>
          <div className="row">
            <input type="text" style={{ flex: 1 }} value={footage} placeholder="Pick a folder of session videos"
              onChange={(e) => setFootage(e.target.value)} onFocus={() => setPick("folder")} />
            <button onClick={() => setPick(pick === "folder" ? null : "folder")}>Browse</button>
          </div>
          {pick === "folder" && <Browser mode="folder" value={footage} onPick={(p) => { setFootage(p); setPick("audio"); }} />}
        </div>
        <div className="field">
          <label>Song (.mp3, .flac, .wav, .m4a)</label>
          <div className="row">
            <input type="text" style={{ flex: 1 }} value={song} placeholder="Pick a song file"
              onChange={(e) => setSong(e.target.value)} onFocus={() => setPick("audio")} />
            <button onClick={() => setPick(pick === "audio" ? null : "audio")}>Browse</button>
          </div>
          {pick === "audio" && <Browser mode="audio" value={song} onPick={(p) => { setSong(p); setPick(null); }} />}
        </div>
        <div className="field">
          <label>I play</label>
          <div className="chips">
            {["right", "left"].map((h) => (
              <span key={h} className={`chip ${handed === h ? "on" : ""}`} onClick={() => setHanded(h)}>
                {h === "right" ? "Right-handed" : "Left-handed"}
              </span>
            ))}
          </div>
        </div>
        <CountsField counts={counts} defaults={defaults} setCounts={setCounts} />
        <div className="row">
          <button className="primary" disabled={!footage || !song || busy} onClick={create}>
            {busy ? "Analyzing song…" : "Create & analyze"}
          </button>
          {err && <span className="error">{err}</span>}
        </div>
      </div>

      {projects.length > 0 && (
        <div className="card">
          <h2>Your reels</h2>
          <div className="project-list">
            {projects.map((p) => (
              <div key={p.id} className="project-item" onClick={() => onOpen(p.id, p.last_step)}>
                <strong>{p.name}</strong>
                <span className="muted">{new Date((p.modified ?? p.created) * 1000).toLocaleString()}</span>
                <span className="spacer" />
                <span className="muted">{p.status === "ready" ? `${p.n_shots} shots · ${p.n_exports} exports` : p.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
