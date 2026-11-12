import { useEffect, useRef, useState } from "react";

type Sample = { t: number; p: number };

const WINDOW_MS = 45_000; // estimate speed from the last ~45 s so the ETA adapts to slow/fast stages
const MIN_ELAPSED_MS = 4_000;

function fmtEta(sec: number): string {
  if (sec < 10) return "a few seconds left";
  if (sec < 60) return `~${Math.round(sec / 5) * 5}s left`;
  const m = Math.floor(sec / 60);
  if (m < 60) {
    const s = Math.round((sec - m * 60) / 10) * 10;
    return s ? `~${m}m ${s}s left` : `~${m}m left`;
  }
  const h = Math.floor(m / 60);
  return `~${h}h ${m - h * 60}m left`;
}

/** Estimates time remaining from how fast `progress` (0–1) has been moving recently. */
function useEta(progress: number): string | null {
  const samples = useRef<Sample[]>([]);
  const smoothed = useRef<number | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const s = samples.current;
    if (s.length && progress < s[s.length - 1].p) { s.length = 0; smoothed.current = null; } // job restarted
    s.push({ t: now, p: progress });
    while (s.length > 2 && now - s[1].t > WINDOW_MS) s.shift();
  }, [progress]);

  // Re-render every second so the countdown keeps moving between progress updates.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const s = samples.current;
  if (s.length < 2 || progress >= 1) return null;
  const first = s[0], last = s[s.length - 1];
  const dp = last.p - first.p, dt = last.t - first.t;
  if (dt < MIN_ELAPSED_MS || dp <= 0.002) return "estimating time…";
  const raw = ((1 - last.p) / (dp / dt) - (Date.now() - last.t)) / 1000;
  // Smooth so the number doesn't jump around on every poll.
  smoothed.current = smoothed.current == null ? raw : smoothed.current * 0.8 + raw * 0.2;
  return fmtEta(Math.max(0, smoothed.current));
}

export default function ProgressBar({ progress, wide }: { progress: number; wide?: boolean }) {
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  const eta = useEta(progress);
  return (
    <div className={`progress-wrap ${wide ? "wide" : ""}`}>
      <div className="progress rainbow" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%` }}><span className="pulse" /></div>
      </div>
      <span className="progress-pct">{Math.floor(pct)}%</span>
      {eta && <span className="muted progress-eta">{eta}</span>}
    </div>
  );
}
