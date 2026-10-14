import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

export const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Keep an element mounted for `ms` after `open` turns false so its exit can animate.
 * `state` drives CSS: "open" plays the enter keyframes, "closing" the exit ones.
 */
export function usePresence(open: boolean, ms = 160): { mounted: boolean; state: "open" | "closing" } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || mounted, state: open ? "open" : "closing" };
}

/** Run a DOM-changing state update as a View Transition where supported (route and conversation switches). */
export function withViewTransition(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (!doc.startViewTransition || reducedMotion() || document.hidden) {
    update();
    return;
  }
  doc.startViewTransition(() => flushSync(update));
}
