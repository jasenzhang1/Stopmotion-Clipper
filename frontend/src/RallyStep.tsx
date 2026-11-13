import { useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, matchFilter, Project, Shot, StrandHit, TYPE_LABEL } from "./api";
import { FILTERS, Stars } from "./ShotsStep";
import { FRAME } from "./ClipTrim";
import { useHotkeys } from "./hotkeys";
import Speed from "./Speed";

/** Exchange tempo: 60 / average time between consecutive contacts. */
function bpm(hits: StrandHit[]): number | null {
  if (hits.length < 2) return null;
  const gaps = hits.slice(1).map((h, i) => h.t - hits[i].t);
  return 60 / (gaps.reduce((a, b) => a + b, 0) / gaps.length);
}

/** Split a run of contacts into points wherever nobody hits for `gap` seconds. */
function points(hits: StrandHit[], gap: number): StrandHit[][] {
  const out: StrandHit[][] = [];
  for (const h of hits) {
    const cur = out[out.length - 1];
    if (cur && h.t - cur[cur.length - 1].t <= gap) cur.push(h);
    else out.push([h]);
  }
  return out;
}

/**
 * Curate the drop rally. Pick a shot you like; the strand around it shows every contact in order — yours
 * (named and graded) and your partner's — like a DNA sequence. Zoom out a contact at a time, fix contacts
 * the app missed or got wrong, check the exchange tempo, and use it as the reel's rally.
 */
export default function RallyStep({ project, setProject, onDone }: {
  project: Project; setProject: (p: Project) => void; onDone: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [anchorShot, setAnchorShot] = useState<Shot | null>(null);
  const [strand, setStrand] = useState<{ video_id: string; video: string; hits: StrandHit[]; point_gap: number } | null>(null);
  const [before, setBefore] = useState(2);
  const [after, setAfter] = useState(2);
  const [clip, setClip] = useState<{ file: string; start: number; end: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [vt, setVt] = useState<number | null>(null); // source time on screen
  const vid = useRef<HTMLVideoElement>(null);
  const [speed, setSpeed] = useState(1);
  useEffect(() => { if (vid.current) vid.current.playbackRate = speed; }, [speed, clip]);

  const library = useMemo(() => project.shots.filter((s) => !s.hidden && matchFilter(s, filter))
    .sort((a, b) => b.stars - a.stars || b.quality - a.quality), [project.shots, filter]);

  const pick = async (s: Shot) => {
    setAnchorShot(s); setBefore(2); setAfter(2); setClip(null); setMsg(null);
    try { setStrand(await api.strand(project.id, s.id)); } catch (e: any) { setMsg(e.message); }
  };

  const hits = strand?.hits ?? [];
  const ai = anchorShot ? hits.findIndex((h) => h.shot_id === anchorShot.id) : -1;
  const lo = Math.max(0, ai - before);
  const hi = Math.min(hits.length - 1, ai + after);
  const shown = ai >= 0 ? hits.slice(lo, hi + 1) : [];
  const pts = points(shown, strand?.point_gap ?? 5.5);
  const song = project.music?.bpm;

  // The clip on screen follows the selection; re-cut when it no longer covers it.
  useEffect(() => { if (clip && shown.length && (shown[0].t < clip.start + 0.5 || shown[shown.length - 1].t > clip.end - 1)) setClip(null); },
    [lo, hi]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadClip = async () => {
    if (!strand || !shown.length) return;
    setBusy("Preparing preview…");
    try { setClip(await api.strandPreview(project.id, strand.video_id, shown[0].t, shown[shown.length - 1].t)); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(null); }
  };
  const seek = (t: number) => {
    const v = vid.current;
    if (!v || !clip) return;
    v.pause();
    v.currentTime = Math.max(0, t - clip.start);
    setVt(t);
  };
  const editHits = async (b: { add?: { t: number; player: "me" | "opp" }; remove?: number }) => {
    if (!strand) return;
    try { const r = await api.strandEdit(project.id, { video_id: strand.video_id, ...b }); setStrand({ ...strand, hits: r.hits }); }
    catch (e: any) { setMsg(e.message); }
  };
  const use = async () => {
    if (!strand || shown.length < 2) return;
    setBusy("Making the rally…");
    try {
      setProject(await api.rallyClip(project.id, strand.video_id, shown[0].t, shown[shown.length - 1].t));
      setMsg("Set as the reel's drop rally.");
    } catch (e: any) { setMsg(e.message); } finally { setBusy(null); }
  };

  useHotkeys((e) => {
    const v = vid.current;
    if (!v || !clip) return;
    if (e.key === " ") { if (v.paused) v.play(); else v.pause(); return true; }
    if (e.key === "[") { seek((vt ?? clip.start) - FRAME); return true; }
    if (e.key === "]") { seek((vt ?? clip.start) + FRAME); return true; }
  });

  const near = vt === null ? null : shown.reduce<StrandHit | null>((b, h) => (!b || Math.abs(h.t - vt) < Math.abs(b.t - vt) ? h : b), null);
  const onHit = (h: StrandHit) => vt !== null && Math.abs(h.t - vt) < 0.12;

  return (
    <div className="rally-step">
      <div className="panel">
        <div className="panel-head">Start from a shot <span className="spacer" />{library.length}</div>
        <div style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
          <div className="chips">
            {FILTERS.filter((f) => f.key !== "unknown" || project.shots.some((s) => s.type === "unknown")).map((f) => (
              <span key={f.key} className={`chip ${filter === f.key ? "on" : ""}`} style={{ fontSize: 12, padding: "2px 8px" }}
                onClick={() => setFilter(f.key)}>{f.label}</span>
            ))}
          </div>
        </div>
        <div className="panel-body">
          {library.map((s) => (
            <div key={s.id} className={`lib-item ${anchorShot?.id === s.id ? "inspecting" : ""}`} onClick={() => pick(s)}>
              <img src={fileUrl(project.id, s.thumb)} loading="lazy" alt="" />
              <div style={{ display: "grid", gap: 2 }}>
                <span className={`badge t-${s.type}`} title={TYPE_LABEL[s.type]}>{s.name}</span>
                <Stars value={s.stars} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rally-main">
        {!anchorShot && <div className="muted rally-empty">Pick a shot you like.</div>}
        {anchorShot && ai < 0 && strand && <div className="muted rally-empty">That shot's contact was removed from the strand.</div>}
        {anchorShot && ai >= 0 && (
          <>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span className="seg">
                <button disabled={before === 0} onClick={() => setBefore(before - 1)} title="One contact fewer before">−</button>
                <button disabled={lo === 0} onClick={() => setBefore(before + 1)} title="One more contact before">◀ +1</button>
              </span>
              <span className="muted">{shown.length} contacts</span>
              <span className="seg">
                <button disabled={hi === hits.length - 1} onClick={() => setAfter(after + 1)} title="One more contact after">+1 ▶</button>
                <button disabled={after === 0} onClick={() => setAfter(after - 1)} title="One contact fewer after">−</button>
              </span>
              <span className="spacer" />
              {pts.map((pt, i) => {
                const b = bpm(pt);
                return b && (
                  <span key={i} className="tempo" title={`Average ${(60 / b).toFixed(2)}s between contacts${song ? ` · song ${song.toFixed(0)} BPM` : ""}`}>
                    {pts.length > 1 ? `Point ${i + 1}: ` : ""}<b>{b.toFixed(0)}</b> BPM
                  </span>
                );
              })}
              {song && <span className="muted">song {song.toFixed(0)}</span>}
            </div>

            <div className="strand">
              {shown.map((h, i) => {
                const prev = shown[i - 1];
                const gap = prev ? h.t - prev.t : null;
                const brk = gap !== null && gap > (strand?.point_gap ?? 5.5);
                return (
                  <div key={`${h.t}`} className="strand-cell">
                    {gap !== null && <div className={`strand-gap ${brk ? "break" : ""}`}>{brk ? "‖ " : ""}{gap.toFixed(1)}s</div>}
                    <div className={`hit ${h.player} ${h.shot_id === anchorShot.id ? "anchor" : ""} ${h.inferred ? "inferred" : ""} ${onHit(h) ? "now" : ""} ${near === h ? "near" : ""}`}
                      onClick={() => seek(h.t)}
                      title={h.player === "me" ? (h.type ? `${h.name} · ${TYPE_LABEL[h.type]} · ${h.stars}★` : "My contact (marked by you)") : h.inferred ? "Partner (guessed: no sound found)" : "Partner"}>
                      {h.player === "me" ? <span className={`badge t-${h.type ?? "unknown"}`}>{h.name ?? "Me"}</span> : <span className="opp-tag">Partner</span>}
                      {h.player === "me" && <span className="hit-stars">{"★".repeat(h.stars ?? 0)}</span>}
                      <button className="small ghost hit-x" title="Not a contact: remove"
                        onClick={(e) => { e.stopPropagation(); editHits({ remove: h.t }); }}>✕</button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="rally-video">
              {clip ? (
                <video ref={vid} key={clip.file} src={fileUrl(project.id, clip.file)} controls muted playsInline
                  onLoadedMetadata={(e) => { e.currentTarget.currentTime = Math.max(0, shown[0].t - clip.start - 0.5); e.currentTarget.playbackRate = speed; }}
                  onTimeUpdate={(e) => setVt(clip.start + e.currentTarget.currentTime)}
                  onSeeked={(e) => setVt(clip.start + e.currentTarget.currentTime)} />
              ) : (
                <button className="primary" disabled={!!busy} onClick={loadClip}>{busy ?? "▶ Watch this rally"}</button>
              )}
            </div>
            {clip && (
              <div className="row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
                <span className="seg">
                  <button title="Previous frame ([)" onClick={() => seek((vt ?? clip.start) - FRAME)}>◂</button>
                  <button title="Next frame (])" onClick={() => seek((vt ?? clip.start) + FRAME)}>▸</button>
                </span>
                <Speed value={speed} onChange={setSpeed} />
                <button disabled={vt === null} onClick={() => vt !== null && editHits({ add: { t: vt, player: "me" } })}
                  title="The frame on screen is where I hit the ball">My contact here</button>
                <button disabled={vt === null} onClick={() => vt !== null && editHits({ add: { t: vt, player: "opp" } })}
                  title="The frame on screen is where my partner hit the ball">Partner contact here</button>
              </div>
            )}
            <div className="row">
              <span className="spacer" />
              {msg && <span className="muted">{msg}</span>}
              <button className="primary" disabled={!!busy || shown.length < 2} onClick={use}>Use as drop rally</button>
              {msg === "Set as the reel's drop rally." && <button onClick={onDone}>Go to editor →</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
