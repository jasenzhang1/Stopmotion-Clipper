export type ShotType =
  | "forehand" | "backhand" | "fh_slice" | "bh_slice" | "fh_volley" | "bh_volley" | "approach" | "serve" | "overhead" | "unknown";

export interface Shot {
  id: string;
  video_id: string;
  t: number;
  type: ShotType;
  auto_type: ShotType;
  quality: number;
  stars: number;
  user_stars: number | null;
  hidden: boolean;
  proxy: { file: string; start: number; end?: number };
  thumb: string;
  rally_id?: string;
  components: Record<string, number>;
  label_source: "auto" | "user";
  /** Serves only: did it go in (started a rally)? Missed serves only fit quarter-note clips or shorter. */
  serve?: { in: boolean; first: boolean; source: "auto" | "user" } | null;
  /** Seconds the user slid the footage (+ = later) so the right frame lands on the beat. */
  nudge?: number | null;
  /** Permanent name, e.g. F3: letter = kind (F, B, V, A, S), number = this shot's own. */
  name?: string | null;
  /** Serves: when the ball is tossed and when it tops out (source seconds). */
  serve_marks?: ServeMarks | null;
  /** Looks like shots you said weren't real; ranked near the bottom. */
  suspect?: boolean;
  rejected?: string | null;
}

export type ShotPatch = Partial<{
  type: ShotType; stars: number; hidden: boolean; serve_in: boolean | null; nudge: number;
  complaint: { reason: string; note?: string };
}>;

export interface Slot {
  id: string;
  /** Position and length inside the bar, in sixteenths (16 per bar). */
  pos: number;
  len: number;
  /** Clip identity: F3 is always the same forehand clip, everywhere in the reel. */
  label: string | null;
  contact: number;
  lead: number;
  /** Contact position inside the clip, in sixteenths from its start (on the grid). */
  hit?: number;
  /** Free shift of the clip's frame from the grid, in sixteenths (Ctrl+drag). */
  off?: number;
  start: number;
  end: number;
  shot_id: string;
  src_start: number;
  video_id: string;
  repeat: boolean;
  locked: boolean;
}

export interface Bar {
  k: number;
  beat: number;
  t0: number;
  t1: number;
  energy: number;
  density: number;
  user_density: boolean;
  /** True when the bar is cut into equal clips (so a 1/2/4/8 button applies). */
  uniform: boolean;
  slots: Slot[];
}

export interface RallyRef {
  rally_id: string;
  start_hit: number;
  n_hits: number;
  video_id: string;
  start: number;
  end: number;
  src_start: number;
  src_end: number;
  point_end: number;
  locked?: boolean;
}

export interface Timeline {
  seed: number;
  drop: number;
  bars: Bar[];
  rally: RallyRef | null;
  reel_start: number;
  reel_end: number;
  duration: number;
  mood: string | null;
  /** Finest note value: 8 = eighth notes, 16 = sixteenth notes. */
  grid: 8 | 16;
  labels: Record<string, string>;
  skeleton: string;
}

export interface Rally {
  id: string;
  video_id: string;
  hits: { t: number; player: "me" | "opp"; shot_id?: string; inferred: boolean }[];
  start: number;
  point_end: number;
  score: number;
  n_hits: number;
  duration: number;
  best_start: number;
  proxy: { file: string; start: number; end?: number };
}

export interface Music {
  duration: number;
  bpm: number;
  period: number;
  beats: number[];
  energy: number[];
  peaks: number[];
  peaks_dt: number;
}

export interface ChatMsg { role: "user" | "assistant"; text: string }

export interface ExportRec {
  id: string;
  file: string;
  time: number;
  info: { width: number; height: number; fps: number; duration: number; hdr: boolean };
  moods: string[];
  rating: string | null;
  learned: boolean;
}

export interface Project {
  id: string;
  name: string;
  status: "new" | "analyzing" | "ready";
  job?: string;
  handed: string;
  videos: { id: string; name: string; duration: number | null; hdr: boolean | null }[];
  song: { path: string; duration: number; name: string } | null;
  music: Music | null;
  section: { start: number; end: number; drop: number; suggested: boolean } | null;
  shots: Shot[];
  rallies: Rally[];
  /** Per kind (forehand, backhand, serve, volley, approach, unknown, rally): shown now / more waiting. */
  pool?: Record<string, { shown: number; more: number }>;
  timeline: Timeline | null;
  chat: ChatMsg[];
  exports: ExportRec[];
  versions?: Version[];
  can_undo?: boolean;
  can_redo?: boolean;
  mood: string | null;
  stats?: { videos: number; shots: number; opponent_hits: number; rallies: number; pose_used: boolean };
}

export interface ServeMarks { toss?: number; apex?: number; source?: "auto" | "user" }
export type ServeMarksPatch = { detect?: boolean; toss?: number; apex?: number };

/** One contact in a strand: mine (a named, graded shot) or my partner's. */
export interface StrandHit {
  t: number; player: "me" | "opp"; shot_id?: string; name?: string | null; type?: ShotType; stars?: number;
  hidden?: boolean; inferred?: boolean; user?: boolean;
}

export interface Version { id: string; name: string; time: number }

/** What undo / redo / restoring a version hands back. */
export interface EditorState {
  timeline: Timeline | null; mood: string | null; nudges: Record<string, number | null>;
  can_undo: boolean; can_redo: boolean; versions: Version[];
}

export interface ProjectSummary {
  id: string; name: string; created: number; modified: number; last_step: "song" | "shots" | "editor" | "rally";
  status: string; n_shots: number; n_exports: number;
}

export interface Job {
  id: string; kind: string; status: "running" | "done" | "error" | "cancelled"; progress: number; message: string;
  result: any; error: string | null;
}

export interface Meta {
  moods: string[];
  shot_types: Record<ShotType, string>;
  handed: string;
  chat_available: boolean;
  /** Default number of each kind (forehand, backhand, serve, volley, approach, unknown, rally) to load at analysis. */
  preview_defaults: Record<string, number>;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.detail ?? msg;
    } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  meta: () => req<Meta>("GET", "/api/meta"),
  roots: () => req<{ name: string; path: string }[]>("GET", "/api/fs/roots"),
  list: (path: string) =>
    req<{ path: string; parent: string | null; n_videos: number; entries: { name: string; path: string; kind: "dir" | "video" | "audio" }[] }>(
      "GET", `/api/fs/list?path=${encodeURIComponent(path)}`),
  status: () => req<{ stale: boolean }>("GET", "/api/status"),
  projects: () => req<ProjectSummary[]>("GET", "/api/projects"),
  create: (b: { name: string; footage_dir: string; song_path: string; handed: string; counts?: Record<string, number> }) =>
    req<Project>("POST", "/api/projects", b),
  project: (id: string) => req<Project>("GET", `/api/projects/${id}`),
  rename: (id: string, name: string) => req<{ name: string }>("PATCH", `/api/projects/${id}`, { name }),
  job: (id: string) => req<Job>("GET", `/api/jobs/${id}`),
  setStep: (id: string, step: string) => req<{ ok: boolean }>("POST", `/api/projects/${id}/step`, { step }),
  stop: (id: string) => req<{ job: string | null }>("POST", `/api/projects/${id}/stop`),
  reanalyze: (id: string) => req<{ job: string }>("POST", `/api/projects/${id}/reanalyze`),
  more: (id: string, group: string, n?: number) => req<{ job: string }>("POST", `/api/projects/${id}/more`, { group, n }),
  section: (id: string, b: { start: number; end: number; drop?: number | null }) =>
    req<Project>("POST", `/api/projects/${id}/section`, b),
  draft: (id: string, b: { mood?: string | null; fresh?: boolean }) => req<Project>("POST", `/api/projects/${id}/draft`, b),
  edit: (id: string, op: string, args: Record<string, unknown>) =>
    req<{ timeline: Timeline; slot_id?: string; slot_ids?: string[] }>("POST", `/api/projects/${id}/edit`, { op, args }),
  undo: (id: string) => req<EditorState>("POST", `/api/projects/${id}/undo`),
  redo: (id: string) => req<EditorState>("POST", `/api/projects/${id}/redo`),
  saveVersion: (id: string, name?: string) => req<EditorState>("POST", `/api/projects/${id}/versions`, { name }),
  restoreVersion: (id: string, vid: string) => req<EditorState>("POST", `/api/projects/${id}/versions/${vid}/restore`),
  deleteVersion: (id: string, vid: string) => req<EditorState>("DELETE", `/api/projects/${id}/versions/${vid}`),
  serveMarks: (id: string, sid: string, b: ServeMarksPatch) =>
    req<{ serve_marks: ServeMarks | null; proxy: Shot["proxy"]; timeline: Timeline | null }>("POST", `/api/projects/${id}/shots/${sid}/serve_marks`, b),
  strand: (id: string, sid: string) =>
    req<{ video_id: string; video: string; hits: StrandHit[]; point_gap: number }>("GET", `/api/projects/${id}/strand?shot=${encodeURIComponent(sid)}`),
  strandEdit: (id: string, b: { video_id: string; add?: { t: number; player: "me" | "opp" }; remove?: number }) =>
    req<{ hits: StrandHit[] }>("POST", `/api/projects/${id}/strand/edit`, b),
  strandPreview: (id: string, video_id: string, t0: number, t1: number) =>
    req<{ file: string; start: number; end: number }>("POST", `/api/projects/${id}/strand/preview`, { video_id, t0, t1 }),
  rallyClip: (id: string, video_id: string, t0: number, t1: number) =>
    req<Project>("POST", `/api/projects/${id}/rally_clip`, { video_id, t0, t1 }),
  shotWindow: (id: string, sid: string, after: number) =>
    req<{ proxy: Shot["proxy"]; timeline: Timeline | null }>("POST", `/api/projects/${id}/shots/${sid}/window`, { after }),
  nudges: (id: string, nudges: Record<string, number>) =>
    req<{ shots: { id: string; nudge: number }[]; timeline: Timeline | null }>("POST", `/api/projects/${id}/nudges`, { nudges }),
  patchShot: (id: string, sid: string, b: ShotPatch) =>
    req<Partial<Shot> & { timeline?: Timeline; all?: Pick<Shot, "id" | "stars" | "quality" | "suspect">[]; names?: Record<string, string> }>("PATCH", `/api/projects/${id}/shots/${sid}`, b),
  chat: (id: string, message: string) =>
    req<{ reply: string; timeline: Timeline; chat: ChatMsg[]; shots: Shot[] }>("POST", `/api/projects/${id}/chat`, { message }),
  export: (id: string, b: { resolution: string; hdr: boolean }) => req<{ job: string }>("POST", `/api/projects/${id}/export`, b),
  feedback: (id: string, eid: string, b: { rating: string | null; moods: string[] }) =>
    req<{ ok: boolean }>("POST", `/api/projects/${id}/exports/${eid}/feedback`, b),
};

export const fileUrl = (pid: string, rel: string) => `/api/projects/${pid}/files/${rel}`;
export const songUrl = (pid: string) => `/api/projects/${pid}/song`;

export const TYPE_CODE: Record<ShotType, string> = {
  forehand: "FH", backhand: "BH", fh_slice: "FHS", bh_slice: "BHS", fh_volley: "FHV", bh_volley: "BHV", approach: "APP",
  serve: "SRV", overhead: "OH", unknown: "?",
};

export const TYPE_LABEL: Record<ShotType, string> = {
  forehand: "Forehand", backhand: "Backhand", fh_slice: "FH slice", bh_slice: "BH slice", fh_volley: "FH volley", bh_volley: "BH volley",
  approach: "Approach", serve: "Serve", overhead: "Overhead", unknown: "Unlabeled",
};

export const typeGroup = (t: ShotType): string =>
  t === "fh_slice" ? "forehand" : t === "bh_slice" ? "backhand"
    : t === "fh_volley" || t === "bh_volley" ? "volley" : t === "overhead" ? "serve" : t;

/** Where a shot's preview clip ends, in source seconds. */
export const proxyEnd = (s: { t: number; proxy: { start: number; end?: number } }) => s.proxy.end ?? s.t + 2.0;

export const matchFilter = (s: { type: ShotType }, key: string): boolean =>
  key === "all" || (key === "unknown" ? s.type === "unknown"
    : key === "slice" ? s.type === "fh_slice" || s.type === "bh_slice" : typeGroup(s.type) === key);

/** Why a shot is wrong (keys match backend config.COMPLAINT_REASONS). */
export const COMPLAINTS: { key: string; label: string }[] = [
  { key: "no_contact", label: "No ball contact" }, { key: "not_me", label: "Not my shot" },
  { key: "wrong_stroke", label: "Wrong stroke" }, { key: "mishit", label: "Mishit" },
  { key: "weak_swing", label: "Weak swing" }, { key: "out_of_frame", label: "Out of frame" },
  { key: "blurry", label: "Blurry" }, { key: "too_far", label: "Too far" },
  { key: "overrated", label: "Rated too high" }, { key: "underrated", label: "Rated too low" },
];

export const NOTE_NAME: Record<number, string> = {
  16: "whole note", 8: "half note", 4: "quarter note", 2: "eighth note", 1: "sixteenth note",
};

export const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
};

export async function pollJob(id: string, onProgress: (j: Job) => void): Promise<Job> {
  for (;;) {
    const j = await api.job(id);
    onProgress(j);
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 800));
  }
}
