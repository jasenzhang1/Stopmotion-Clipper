/** Playback speed, in steps of 0.05× (0.05× to 3×). */
export const clampSpeed = (v: number) => Math.round(Math.max(0.05, Math.min(3, v)) * 20) / 20;

export default function Speed({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="seg speed" title="Playback speed (0.05× steps). Double-click the number for 1×.">
      <button onClick={() => onChange(clampSpeed(value - 0.05))} disabled={value <= 0.05}>−</button>
      <span className="speed-val" onDoubleClick={() => onChange(1)}>{value.toFixed(2)}×</span>
      <button onClick={() => onChange(clampSpeed(value + 0.05))} disabled={value >= 3}>+</button>
    </span>
  );
}
