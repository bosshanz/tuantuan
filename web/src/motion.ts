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

let activeTransitions = 0;

/** Run a DOM-changing state update as a View Transition where supported (route and conversation switches). */
export function withViewTransition(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (!doc.startViewTransition || reducedMotion() || document.hidden) {
    update();
    return;
  }
  const t = doc.startViewTransition(() => flushSync(update)) as {
    ready?: Promise<void>;
    finished?: Promise<void>;
  } | null;
  // A newer navigation may skip this one (e.g. the first-launch redirect); that is not an error.
  t?.ready?.catch(() => {});
  // While a transition runs, hit-testing lands on the ::view-transition pseudo (the <html> element), so
  // expose it: tests wait for it instead of guessing a delay before probing what is clickable.
  const root = document.documentElement;
  activeTransitions++;
  root.dataset.viewTransition = "";
  const done = () => {
    if (--activeTransitions === 0) delete root.dataset.viewTransition;
  };
  if (t?.finished) t.finished.then(done, done);
  else done();
}
