import { useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, fmtTime, matchFilter, Project, RallyGroup, RankedRally, Shot, Strand, StrandHit, TYPE_LABEL } from "./api";
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

const bkey = (t: number) => t.toFixed(3);

/** Is there a rally break just before `h` (after `prev`)? Your correction wins; otherwise a long gap is a break. */
function isBreak(prev: StrandHit, h: StrandHit, gap: number, breaks?: Record<string, boolean>): boolean {
  const b = breaks?.[bkey(h.t)];
  return b ?? h.t - prev.t > gap;
}

/** Split a run of contacts into rallies (points). */
function points(hits: StrandHit[], gap: number, breaks: Record<string, boolean> = {}): StrandHit[][] {
  const out: StrandHit[][] = [];
  for (const h of hits) {
    const cur = out[out.length - 1];
    if (cur && !isBreak(cur[cur.length - 1], h, gap, breaks)) cur.push(h);
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
  const [strand, setStrand] = useState<Strand | null>(null);
  // Extra footage (seconds) shown before the first / after the last contact on screen, to look for missed ones.
  const [padBefore, setPadBefore] = useState(0);
  const [padAfter, setPadAfter] = useState(0);
  const [before, setBefore] = useState(2);
  const [after, setAfter] = useState(2);
  const [clip, setClip] = useState<{ file: string; start: number; end: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [vt, setVt] = useState<number | null>(null); // source time on screen
  const vid = useRef<HTMLVideoElement>(null);
  const [speed, setSpeed] = useState(1);
  useEffect(() => { if (vid.current) vid.current.playbackRate = speed; }, [speed, clip]);

  // The rallies (points) the shots belong to: the list bundles each rally's shots together.
  const [groups, setGroups] = useState<RallyGroup[]>([]);
  const loadSizes = () => api.rallyGroups(project.id).then(setGroups).catch(() => {});
  useEffect(() => { loadSizes(); }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Rallies ranked by their best clean stretch (cut at vibe-killers: out of the air, double bounce…).
  const [tab, setTab] = useState<"shots" | "ranked">("shots");
  const [ranked, setRanked] = useState<RankedRally[]>([]);
  const loadRanked = () => api.rallyRank(project.id).then(setRanked).catch(() => {});
  useEffect(() => { loadRanked(); }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search a shot by name (e.g. "F12") to pull up the rally it's in. While searching, the type filter is set aside.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (s: Shot) => !!q && (s.name ?? "").toLowerCase().includes(q);
  const library = useMemo(() => project.shots.filter((s) => !s.hidden && (q ? true : matchFilter(s, filter)))
    .sort((a, b) => b.stars - a.stars || b.quality - a.quality), [project.shots, filter, q]);
  /** The library bundled by rally: each rally's matching shots in play order; rallies with the best shot first
   * (then longer rallies). A shot that isn't in any rally gets a bundle of its own. */
  const bundles = useMemo(() => {
    const inLib = new Map(library.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const out: { g: RallyGroup | null; shots: Shot[] }[] = [];
    for (const g of groups) {
      const shots = g.shots.map((id) => inLib.get(id)).filter((s): s is Shot => !!s);
      shots.forEach((s) => seen.add(s.id));
      if (shots.length) out.push({ g, shots });
    }
    for (const s of library) if (!seen.has(s.id)) out.push({ g: null, shots: [s] });
    const best = (b: { shots: Shot[] }) => b.shots.reduce((m, s) => (s.stars > m.stars || (s.stars === m.stars && s.quality > m.quality) ? s : m));
    if (q) { // only the rallies with a matching shot; exact name matches first
      const exact = (b: { shots: Shot[] }) => b.shots.some((s) => (s.name ?? "").toLowerCase() === q);
      return out.filter((b) => b.shots.some(matches)).sort((a, b) => Number(exact(b)) - Number(exact(a)));
    }
    return out.sort((a, b) => {
      const x = best(a), y = best(b);
      return y.stars - x.stars || (b.g?.n ?? 1) - (a.g?.n ?? 1) || y.quality - x.quality;
    });
  }, [groups, library, q]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Open the rally of the best search match (Enter in the search box). */
  const openMatch = () => {
    const b = bundles[0];
    const s = b?.shots.find(matches);
    if (s) b.g ? pick(s, { t0: b.g.t0, t1: b.g.t1 }) : pick(s);
  };

  /** Open the strand around a shot: the whole rally it was part of, or just `range` (first/last contact time). */
  const pick = async (s: Shot, range?: { t0: number; t1: number }) => {
    setAnchorShot(s); setClip(null); setMsg(null); setVt(null);
    try {
      const st = await api.strand(project.id, s.id);
      setStrand(st);
      const i = st.hits.findIndex((h) => h.shot_id === s.id);
      let a = i, b = i;
      if (range) {
        a = st.hits.findIndex((h) => h.t >= range.t0 - 0.01);
        b = st.hits.findIndex((h) => h.t > range.t1 + 0.01) - 1;
        if (b < 0) b = st.hits.length - 1;
      } else {
        while (a > 0 && !isBreak(st.hits[a - 1], st.hits[a], st.point_gap, st.breaks)) a--;
        while (b >= 0 && b < st.hits.length - 1 && !isBreak(st.hits[b], st.hits[b + 1], st.point_gap, st.breaks)) b++;
      }
      setPadBefore(0); setPadAfter(0);
      setBefore(Math.max(0, i - a)); setAfter(Math.max(0, b - i));
    } catch (e: any) { setMsg(e.message); }
  };
  const openRanked = (r: RankedRally, whole = false) => {
    const s = project.shots.find((x) => x.id === r.shot_id);
    if (s) pick(s, whole ? { t0: r.t0, t1: r.t1 } : r.best);
  };

  const hits = strand?.hits ?? [];
  const ai = anchorShot ? hits.findIndex((h) => h.shot_id === anchorShot.id) : -1;
  const lo = Math.max(0, ai - before);
  const hi = Math.min(hits.length - 1, ai + after);
  const shown = ai >= 0 ? hits.slice(lo, hi + 1) : [];
  const pts = points(shown, strand?.point_gap ?? 5.5, strand?.breaks);
  /** The rally (point) the selected shot was part of, from the full strand. */
  const rally = useMemo(() => {
    if (ai < 0 || !strand) return null;
    const pt = points(hits, strand.point_gap, strand.breaks).find((p) => p.some((h) => h.shot_id === anchorShot!.id))!;
    return { n: pt.length, mine: pt.filter((h) => h.player === "me").length, k: pt.findIndex((h) => h.shot_id === anchorShot!.id) + 1 };
  }, [hits, ai, strand, anchorShot]);
  /** This rally's entry in the ranking (its best clean stretch), if it has one. */
  const rank = useMemo(() => {
    if (ai < 0 || !strand) return null;
    const t = hits[ai].t;
    const i = ranked.findIndex((r) => r.video_id === strand.video_id && r.t0 - 0.01 <= t && t <= r.t1 + 0.01);
    return i < 0 ? null : { ...ranked[i], place: i + 1 };
  }, [ranked, hits, ai, strand]);
  const showingBest = !!rank && shown.length > 0 && Math.abs(shown[0].t - rank.best.t0) < 0.01
    && Math.abs(shown[shown.length - 1].t - rank.best.t1) < 0.01;
  const song = project.music?.bpm;

  // The footage follows what's shown: it loads (or re-cuts) on its own when you look further back or forward.
  const want = strand && shown.length ? `${strand.video_id}:${shown[0].t - padBefore}:${shown[shown.length - 1].t + padAfter}` : null;
  const loading = useRef<string | null>(null);
  useEffect(() => {
    if (!want || !strand) return;
    const t0 = Math.max(0, shown[0].t - padBefore), t1 = shown[shown.length - 1].t + padAfter;
    if (clip && t0 >= clip.start + 0.5 && t1 <= clip.end - 1) return; // already covered
    const id = setTimeout(async () => {
      loading.current = want;
      setBusy("Loading footage…");
      try {
        const c = await api.strandPreview(project.id, strand.video_id, t0, t1);
        if (loading.current === want) setClip(c);
      } catch (e: any) { setMsg(e.message); } finally { if (loading.current === want) setBusy(null); }
    }, 350);
    return () => clearTimeout(id);
  }, [want]); // eslint-disable-line react-hooks/exhaustive-deps
  const [playing, setPlaying] = useState(false);
  const toggle = () => { const v = vid.current; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); };
  useEffect(() => { // smooth playhead while playing
    if (!playing || !clip) return;
    let raf = 0;
    const tick = () => { if (vid.current) setVt(clip.start + vid.current.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clip]);
  const strip = useRef<HTMLDivElement>(null);
  const STRIP_W = 460;
  const scrub = (e: React.PointerEvent) => {
    if (!clip) return;
    e.preventDefault();
    const r = strip.current!.getBoundingClientRect();
    const at = (x: number) => seek(clip.start + (Math.max(0, Math.min(STRIP_W, x - r.left)) / STRIP_W) * (clip.end - clip.start));
    at(e.clientX);
    const mv = (ev: PointerEvent) => at(ev.clientX);
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const seek = (t: number) => {
    const v = vid.current;
    if (!v || !clip) return;
    v.pause();
    v.currentTime = Math.max(0, t - clip.start);
    setVt(t);
  };
  /** "The rally is over": the first contact after the paused frame starts a new rally. */
  const endRallyHere = () => {
    if (vt === null) return;
    const next = hits.find((h) => h.t > vt + 0.02);
    if (!next) { setMsg("No contacts after this point: the rally already ends here."); return; }
    editHits({ break: { t: next.t, value: true } });
    setMsg(`Rally ended at ${vt.toFixed(1)}s. The next contact starts a new rally, and I'll remember pauses like this one.`);
  };
  const editHits = async (b: { add?: { t: number; player: "me" | "opp" }; remove?: number; break?: { t: number; value: boolean | null };
    flow?: { t: number; value: boolean | null } }) => {
    if (!strand) return;
    try {
      const r = await api.strandEdit(project.id, { video_id: strand.video_id, ...b });
      setStrand({ ...strand, hits: r.hits, breaks: r.breaks, point_gap: r.point_gap ?? strand.point_gap });
      if (b.break?.value === true && anchorShot) { // the rally was cut: show the selected shot's rally as it is now
        const i = r.hits.findIndex((h) => h.shot_id === anchorShot.id);
        const brk = (j: number) => isBreak(r.hits[j - 1], r.hits[j], r.point_gap ?? strand.point_gap, r.breaks);
        if (i >= 0) {
          let a = i, z = i;
          while (a > 0 && !brk(a)) a--;
          while (z < r.hits.length - 1 && !brk(z + 1)) z++;
          setBefore(i - a); setAfter(z - i); setPadBefore(0); setPadAfter(0);
        }
      }
      if (b.add && shown.length && b.add.t < shown[0].t) setBefore((n) => n + 1);
      if (b.add && shown.length && b.add.t > shown[shown.length - 1].t) setAfter((n) => n + 1);
      loadSizes(); loadRanked();
    }
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
    if (e.key === " ") { toggle(); return true; }
    if (e.key === "[") { seek((vt ?? clip.start) - FRAME); return true; }
    if (e.key === "]") { seek((vt ?? clip.start) + FRAME); return true; }
  });

  const near = vt === null ? null : shown.reduce<StrandHit | null>((b, h) => (!b || Math.abs(h.t - vt) < Math.abs(b.t - vt) ? h : b), null);
  const onHit = (h: StrandHit) => vt !== null && Math.abs(h.t - vt) < 0.12;
  // The contact the "Delete" button would remove: the nearest one, if the playhead is close to it.
  const delTarget = near && vt !== null && Math.abs(near.t - vt) <= 0.25 ? near : null;

  return (
    <div className="rally-step">
      <div className="panel">
        <div className="panel-head">
          <span className="seg rally-tabs">
            <button className={tab === "shots" ? "on" : ""} onClick={() => setTab("shots")}>Start from a shot</button>
            <button className={tab === "ranked" ? "on" : ""} onClick={() => setTab("ranked")}
              title="Rallies ranked by their best clean stretch: long, steady, no balls volleyed from the baseline or left to bounce twice">Best rallies</button>
          </span>
          <span className="spacer" />{tab === "shots" ? `${bundles.length} rallies · ${library.length} shots` : ranked.length}
        </div>
        {tab === "ranked" && (
          <div className="panel-body">
            <div className="muted rank-help">
              Ranked by the best <b>clean stretch</b>: each rally is cut where the rhythm broke (a ball taken out of the air,
              left to bounce twice, a scramble). Long and steady scores highest, then how good your shots were.
            </div>
            {ranked.map((r, i) => {
              const open = !!rank && rank.video_id === r.video_id && rank.t0 === r.t0;
              return (
                <div key={`${r.video_id}:${r.t0}`} className={`lib-item rank-item ${open ? "inspecting" : ""}`} onClick={() => openRanked(r)}>
                  {r.thumb ? <img src={fileUrl(project.id, r.thumb)} loading="lazy" alt="" /> : <span />}
                  <div style={{ display: "grid", gap: 2 }}>
                    <span><span className="rank-place">#{i + 1}</span> <span className="rank-score" title="Clean-stretch score (0–100)">{r.best.score.toFixed(0)}</span></span>
                    <span className="rally-size long">{r.best.n === r.n ? `${r.n} contacts, all clean` : `${r.best.n} clean of ${r.n} contacts`}</span>
                    <span className="muted rank-meta">
                      {r.flags.length ? `${r.flags.length} vibe-killer${r.flags.length > 1 ? "s" : ""}` : "no vibe-killers"}
                      {r.best.tempo ? ` · ${r.best.tempo.toFixed(0)} BPM` : ""} · {r.video}
                    </span>
                  </div>
                </div>
              );
            })}
            {!ranked.length && <div className="muted rank-help">No rallies with at least 3 clean contacts yet.</div>}
          </div>
        )}
        {tab === "shots" && <>
        <div style={{ padding: 8, borderBottom: "1px solid var(--line)", display: "grid", gap: 6 }}>
          <input type="search" className="rally-search" placeholder="Find a shot (e.g. F12) to pull its rally" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") openMatch(); if (e.key === "Escape") setQuery(""); }} />
          {q && !bundles.length && <span className="muted" style={{ fontSize: 12 }}>No shot named “{query.trim()}”.</span>}
          <div className="chips" style={q ? { opacity: 0.4, pointerEvents: "none" } : undefined}>
            {FILTERS.filter((f) => f.key !== "unknown" || project.shots.some((s) => s.type === "unknown")).map((f) => (
              <span key={f.key} className={`chip ${filter === f.key ? "on" : ""}`} style={{ fontSize: 12, padding: "2px 8px" }}
                onClick={() => setFilter(f.key)}>{f.label}</span>
            ))}
          </div>
        </div>
        <div className="panel-body">
          {bundles.map(({ g, shots }) => {
            const open = !!anchorShot && shots.some((s) => s.id === anchorShot.id);
            const hidden = g ? g.shots.length - shots.length : 0; // shots of this rally the filter hides
            return (
              <div key={g?.key ?? shots[0].id} className={`rally-bundle ${open ? "open" : ""}`}>
                <div className="rally-bundle-head" onClick={() => g ? pick(shots[0], { t0: g.t0, t1: g.t1 }) : pick(shots[0])}
                  title={g ? "Open the whole rally" : undefined}>
                  <span className={`rally-size ${(g?.n ?? 1) >= 6 ? "long" : ""}`}>
                    {!g || g.n === 1 ? "single shot" : `${g.n}-contact rally`}
                  </span>
                  <span className="muted">
                    {g ? `${g.shots.length} of yours${hidden ? ` (${hidden} hidden by the filter)` : ""} · ${g.video} ${fmtTime(g.t0)}` : ""}
                  </span>
                </div>
                {shots.map((s) => (
                  <div key={s.id} className={`lib-item ${anchorShot?.id === s.id ? "inspecting" : ""} ${matches(s) ? "search-hit" : ""}`} onClick={() => pick(s)}>
                    <img src={fileUrl(project.id, s.thumb)} loading="lazy" alt="" />
                    <div style={{ display: "grid", gap: 2 }}>
                      <span className={`badge t-${s.type}`} title={TYPE_LABEL[s.type]}>{s.name}</span>
                      <Stars value={s.stars} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        </>}
      </div>

      <div className="rally-main">
        {!anchorShot && <div className="muted rally-empty">Pick a shot you like.</div>}
        {anchorShot && ai < 0 && strand && <div className="muted rally-empty">That shot's contact was removed from the strand.</div>}
        {anchorShot && ai >= 0 && (
          <>
            {rally && (
              <div className="rally-fact">
                <b>{rally.n}</b> contacts in this rally · {anchorShot.name} was #{rally.k}
                <span className="muted"> · you {rally.mine}, partner {rally.n - rally.mine}</span>
              </div>
            )}
            {rank && (
              <div className="row rank-fact" style={{ flexWrap: "wrap" }}>
                <span className="rank-score" title="Clean-stretch score (0–100)">{rank.best.score.toFixed(0)}</span>
                <span>
                  #{rank.place} of {ranked.length} · best clean stretch <b>{rank.best.n}</b> of {rank.n} contacts
                  <span className="muted"> · rhythm {Math.round(rank.best.steady * 100)}% steady · your shots {Math.round(rank.best.quality * 100)}%</span>
                </span>
                {rank.flags.length > 0 && <span className="muted">· {rank.flags.length} vibe-killer{rank.flags.length > 1 ? "s" : ""} (⚠ below)</span>}
                <span className="spacer" />
                {showingBest
                  ? (rank.best.n < rank.n && <button className="small" onClick={() => openRanked(rank, true)}>Show whole rally</button>)
                  : <button className="small" onClick={() => openRanked(rank)} title="Show only the best stretch without vibe-killers">Show clean stretch</button>}
              </div>
            )}
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span className="seg">
                <button disabled={before === 0} onClick={() => setBefore(before - 1)} title="One contact fewer before">−</button>
                <button disabled={lo === 0} onClick={() => setBefore(before + 1)} title="One more contact before (even from an earlier rally)">◀ +1</button>
                <button onClick={() => setPadBefore(padBefore + 5)} title="5 more seconds of footage before, to look for contacts the app missed">◀ 5s</button>
              </span>
              <span className="muted">{shown.length} contacts</span>
              <span className="seg">
                <button onClick={() => setPadAfter(padAfter + 5)} title="5 more seconds of footage after, to look for contacts the app missed">5s ▶</button>
                <button disabled={hi === hits.length - 1} onClick={() => setAfter(after + 1)} title="One more contact after (even from the next rally)">+1 ▶</button>
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
                const brk = !!prev && isBreak(prev, h, strand?.point_gap ?? 5.5, strand?.breaks ?? {});
                const userSet = strand?.breaks?.[bkey(h.t)] !== undefined;
                return (
                  <div key={`${h.t}`} className="strand-cell">
                    {gap !== null && (
                      <div className={`strand-gap clickable ${brk ? "break" : ""} ${userSet ? "user" : ""}`}
                        onClick={() => editHits({ break: { t: h.t, value: !brk } })}
                        onContextMenu={(e) => { if (userSet) { e.preventDefault(); editHits({ break: { t: h.t, value: null } }); } }}
                        title={brk ? "A new rally starts here. Click if it's really the same rally." : "Same rally. Click if a new rally starts here."
                          + (userSet ? " (set by you; right-click to go back to automatic)" : "")}>
                        {brk ? "‖ new rally " : ""}{gap.toFixed(1)}s
                      </div>
                    )}
                    <div className={`hit ${h.player} ${h.shot_id === anchorShot.id ? "anchor" : ""} ${h.inferred ? "inferred" : ""} ${onHit(h) ? "now" : ""} ${near === h ? "near" : ""}`}
                      onClick={() => seek(h.t)}
                      title={h.player === "me" ? (h.type ? `${h.name} · ${TYPE_LABEL[h.type]} · ${h.stars}★` : "My contact (marked by you)") : h.inferred ? "Partner (guessed: no sound found)" : "Partner"}>
                      <span className={`who-dot ${h.player}`} />
                      {h.player === "me" ? <span className={`badge t-${h.type ?? "unknown"}`}>{h.name ?? "Me"}</span> : <span className="opp-tag">Partner</span>}
                      {h.player === "me" && <span className="hit-stars">{"★".repeat(h.stars ?? 0)}</span>}
                      <button className="small ghost hit-x" title="Mislabeled or not a contact: delete"
                        onClick={(e) => { e.stopPropagation(); editHits({ remove: h.t }); }}>✕</button>
                      {h.flag ? (
                        <span className={`vibe ${h.flag.off ? "off" : ""}`}
                          title={`${h.flag.why}. ${h.flag.off ? "You said it was fine: click to flag it again." : h.flag.auto ? "Click if it was fine." : "Click to unmark."}`}
                          onClick={(e) => { e.stopPropagation(); editHits({ flow: { t: h.t, value: h.flag!.off ? null : h.flag!.auto ? false : null } }); }}>
                          ⚠ {h.flag.label}
                        </span>
                      ) : (
                        <button className="small ghost hit-vibe" title="This contact killed the rally's vibe (out of the air, double bounce, shank…): cut the rally here"
                          onClick={(e) => { e.stopPropagation(); editHits({ flow: { t: h.t, value: true } }); }}>⚠</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="rally-video">
              {clip ? (
                <video ref={vid} key={clip.file} src={fileUrl(project.id, clip.file)} muted playsInline
                  onClick={toggle} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                  onLoadedMetadata={(e) => {
                    const anchorT = hits[ai]?.t ?? shown[0].t;
                    e.currentTarget.currentTime = Math.max(0, (vt ?? anchorT - 1) - clip.start);
                    e.currentTarget.playbackRate = speed;
                  }}
                  onSeeked={(e) => setVt(clip.start + e.currentTarget.currentTime)} />
              ) : (
                <span className="muted">{busy ?? "Loading footage…"}</span>
              )}
            </div>
            {clip && (
              <div className="transport clip-bar">
                <button className="primary" onClick={toggle} style={{ minWidth: 80 }} title="Space">{playing ? "⏸ Pause" : "▶ Play"}</button>
                <span className="seg">
                  <button title="Previous frame ([)" onClick={() => seek((vt ?? clip.start) - FRAME)}>◂</button>
                  <button title="Next frame (])" onClick={() => seek((vt ?? clip.start) + FRAME)}>▸</button>
                </span>
                <div ref={strip} className="trim-strip" style={{ width: STRIP_W, cursor: "pointer" }} onPointerDown={scrub}
                  title="Drag to scrub through the rally">
                  {shown.map((h) => (
                    <div key={h.t} className={`rally-tick ${h.player} ${h.shot_id === anchorShot.id ? "anchor" : ""}`}
                      style={{ left: ((h.t - clip.start) / (clip.end - clip.start)) * STRIP_W }}
                      title={h.player === "me" ? h.name ?? "Me" : "Partner"} />
                  ))}
                  {vt !== null && <div className="trim-head" style={{ left: ((vt - clip.start) / (clip.end - clip.start)) * STRIP_W }} />}
                </div>
                <Speed value={speed} onChange={setSpeed} />
                {vt !== null && hits[ai] && <span className="time">{vt - hits[ai].t >= 0 ? "+" : "−"}{Math.abs(vt - hits[ai].t).toFixed(2)}s</span>}
                {busy && <span className="muted">{busy}</span>}
              </div>
            )}
            {clip && (
              <div className="row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
                <button disabled={vt === null} onClick={() => vt !== null && editHits({ add: { t: vt, player: "me" } })}
                  title="The frame on screen is where I hit the ball (red marks)"><span className="who-dot me" />My contact here</button>
                <button disabled={vt === null} onClick={() => vt !== null && editHits({ add: { t: vt, player: "opp" } })}
                  title="The frame on screen is where my partner hit the ball (white marks)"><span className="who-dot opp" />Partner contact here</button>
                <button disabled={vt === null || !hits.some((h) => h.t > vt + 0.02)} onClick={endRallyHere}
                  title="Pause where the point is over and press this: the next contact starts a new rally. The app learns from it where rallies end.">
                  ⏹ Rally ended here</button>
                <button className="danger-btn" disabled={!delTarget} onClick={() => delTarget && editHits({ remove: delTarget.t })}
                  title={delTarget ? "Remove the contact under the playhead: it was mislabeled or isn't a real contact" : "Move the playhead onto a contact (click one in the strand) to delete it"}>
                  ✕ Delete {delTarget ? <><span className={`who-dot ${delTarget.player}`} />{delTarget.player === "me" ? delTarget.name ?? "my contact" : "partner contact"}</> : "contact here"}
                </button>
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
