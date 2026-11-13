import { useEffect, useState } from "react";
import { api, Project, VideoRecord } from "./api";

function fmtDuration(s: number | null): string {
  if (!s) return "";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

function fmtSize(b: number | null): string {
  if (b == null) return "";
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
}

/** The footage files this reel read (Google Drive for Desktop downloads a file when it's read), grouped by
 * folder, with any other reels that use the same file. */
export default function VideosPanel({ project }: { project: Project }) {
  const [videos, setVideos] = useState<VideoRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.videos(project.id).then(setVideos).catch((e) => setErr(String(e.message ?? e)));
  }, [project.id]);

  const folders = new Map<string, VideoRecord[]>();
  for (const v of videos ?? []) folders.set(v.folder, [...(folders.get(v.folder) ?? []), v]);
  const total = (videos ?? []).reduce((n, v) => n + (v.size ?? 0), 0);

  return (
    <div className="video-list">
      {err && <div className="error">{err}</div>}
      {!videos && !err && <div className="muted">Loading…</div>}
      {videos && videos.length > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          {videos.length} videos · {videos.filter((v) => v.analyzed).length} analyzed
          {total > 0 && ` · ${fmtSize(total)} on disk`}
        </div>
      )}
      {[...folders].map(([folder, vs]) => (
        <div key={folder} className="video-folder">
          <div className="muted video-folder-path">📁 {folder}</div>
          {vs.map((v) => {
            const others = v.reels.filter((r) => r.id !== project.id);
            const mine = v.reels.find((r) => r.id === project.id);
            return (
              <div key={v.path} className="video-item" title={v.path}>
                <span>🎬</span>
                <strong className="video-name">{v.name}</strong>
                <span className="muted">{[fmtDuration(v.duration), fmtSize(v.size)].filter(Boolean).join(" · ")}</span>
                <span className="spacer" />
                <span className="muted">{mine?.shots ?? 0} shots</span>
                {others.length > 0 && <span className="muted">also in</span>}
                {others.map((r) => (
                  <a key={r.id} className="small ghost" href={`#/p/${r.id}/shots`} title="Open this reel">{r.name}</a>
                ))}
                <span className={`video-status ${v.analyzed ? "" : "muted"}`}
                  title={v.cached ? "Analysis saved: a new reel won't need to read this file again" : undefined}>
                  {v.analyzed ? "✓ Analyzed" : "Not analyzed"}
                </span>
                {!v.exists && (
                  <span className="video-status error" title="This file has been moved, renamed or deleted">File missing</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
