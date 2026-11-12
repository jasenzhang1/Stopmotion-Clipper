import { RefObject, useEffect, useLayoutEffect, useRef } from "react";

/** True when the key press belongs to a text field (so global hotkeys should stay out of the way). */
function isTyping(el: HTMLElement | null, key: string): boolean {
  if (!el) return false;
  const erase = key === "Backspace" || key === "Delete"; // means nothing to sliders and dropdowns
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  if (el.tagName === "SELECT") return !erase;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    // Sliders keep their own arrow / Home / End behaviour; Space is free.
    if (type === "range") return key !== " " && !erase;
    return !["checkbox", "radio", "button", "submit"].includes(type);
  }
  return false;
}

/**
 * Window-level keyboard shortcuts. The handler returns true when it handled the key,
 * which stops the browser default (e.g. Space scrolling the page or clicking a focused button).
 */
export function useHotkeys(handler: (e: KeyboardEvent) => boolean | void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (isTyping(el, e.key)) return;
      if (ref.current(e)) {
        e.preventDefault();
        // A focused button would otherwise "click" on Space/Enter keyup and undo the hotkey.
        if (el && el !== document.body) el.blur();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [enabled]);
}

/**
 * Mouse-wheel zoom on a horizontally scrolling strip, anchored under the cursor.
 * `content` is the element whose x pixels map linearly to time at `pps` pixels per second.
 * Shift+wheel and sideways trackpad swipes still scroll horizontally.
 * Returns `zoomBy(factor)` for keyboard zoom (anchored at the strip's centre).
 */
export function useWheelZoom(
  scroll: RefObject<HTMLElement>, content: RefObject<HTMLElement>,
  pps: number, setPps: (n: number) => void, min: number, max: number,
) {
  const rendered = useRef(pps);
  const pending = useRef<{ pps: number; scroll: number } | null>(null);
  const limits = useRef({ min, max });
  limits.current = { min, max };

  const zoomAt = (factor: number, clientX: number) => {
    const el = scroll.current, c = content.current;
    if (!el || !c) return;
    const base = pending.current?.pps ?? rendered.current;
    const next = Math.max(limits.current.min, Math.min(limits.current.max, base * factor));
    if (next === base) return;
    // Pixel under the cursor at the *rendered* zoom, converted to a time offset, then re-placed.
    const px = clientX - c.getBoundingClientRect().left;
    const u = px / rendered.current;
    pending.current = { pps: next, scroll: el.scrollLeft + u * next - px };
    setPps(next);
  };
  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;

  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal scroll
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lines → pixels
      zoomRef.current(Math.exp(-dy * 0.0015), e.clientX);
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [scroll]);

  useLayoutEffect(() => {
    rendered.current = pps;
    const p = pending.current;
    if (p && p.pps === pps && scroll.current) scroll.current.scrollLeft = Math.max(0, p.scroll);
    pending.current = null;
  }, [pps, scroll]);

  return (factor: number) => {
    const el = scroll.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    zoomRef.current(factor, r.left + r.width / 2);
  };
}
