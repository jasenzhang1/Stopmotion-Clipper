import { useEffect, useState } from "react";
import { Timeline } from "./api";

/** Text editor for the build-up skeleton. The app writes the first one; Apply rebuilds the clips from it. */
export function SkeletonDialog({ timeline, onClose, onApply }: {
  timeline: Timeline; onClose: () => void; onApply: (text: string) => Promise<string | null>;
}) {
  const [text, setText] = useState(timeline.skeleton);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = text !== timeline.skeleton;

  // When the timeline changes elsewhere (chat, drags) and nothing is being edited, follow it.
  useEffect(() => { if (!dirty) setText(timeline.skeleton); }, [timeline.skeleton]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    setBusy(true);
    const e = await onApply(text);
    setBusy(false);
    setErr(e);
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal skeleton-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3 style={{ margin: 0 }}>Skeleton</h3>
          <span className="muted">{timeline.bars.length} bars · finest note 1/{timeline.grid ?? 8}</span>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <div className="skeleton-body">
          <textarea className="skeleton-text" value={text} spellCheck={false}
            onChange={(e) => { setText(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); } }} />
          <div className="skeleton-help">
            <p><b>One line = one bar</b>, four beats per line.</p>
            <table>
              <tbody>
                <tr><td><code>F B V A S</code></td><td>forehand, backhand, volley, approach, serve/overhead</td></tr>
                <tr><td><code>F3</code></td><td>one specific clip. Same label = the exact same clip, anywhere in the reel</td></tr>
                <tr><td><code>F</code></td><td>any forehand not used yet</td></tr>
                <tr><td><code>*</code></td><td>any shot</td></tr>
                <tr><td><code>-</code></td><td>hold the previous clip through this beat</td></tr>
                <tr><td><code>.</code></td><td>black (no clip); a <code>-</code> after it stays black</td></tr>
                <tr><td><code>[F1 F2]</code></td><td>two eighth notes in one beat</td></tr>
                {(timeline.grid ?? 8) >= 16 && <tr><td><code>[F F F F]</code></td><td>four sixteenth notes</td></tr>}
                <tr><td><code># …</code></td><td>comment</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button disabled={!dirty || busy} onClick={() => { setText(timeline.skeleton); setErr(null); }}>Revert</button>
          <span className="spacer" />
          <button className="primary" title="Ctrl+Enter" disabled={!dirty || busy} onClick={apply}>{busy ? "Applying…" : "Apply"}</button>
        </div>
      </div>
    </div>
  );
}
