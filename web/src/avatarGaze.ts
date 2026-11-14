import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import type { Expression } from "./avatarState";
import { reducedMotion } from "./motion";

/** Full-tier floor; keep in sync with `avatarTier` in BotAvatar. */
export const GAZE_MIN_SIZE = 28;

/** Expressions whose eyes can look around. Closed, downcast, or already-scripted looks stay put. */
const GAZE_EXPRESSIONS = new Set<Expression>(["idle", "speaking", "awaiting"]);

export interface Spring {
  pos: number;
  vel: number;
}

export interface SpringParams {
  /** Natural frequency, rad/s. */
  omega: number;
  /** Damping ratio: 1 is critical, below 1 is underdamped. */
  zeta: number;
}

/** Snappy enough to lead the body, slight overshoot, settles in ~0.35s. */
export const EYE_SPRING: SpringParams = { omega: 18, zeta: 0.82 };
/** Softer and slower so the body trails the eyes. */
export const BODY_SPRING: SpringParams = { omega: 11, zeta: 0.9 };

/** Max eye travel in SVG user units (viewBox 100). Conservative so bars stay inside every silhouette. */
export const EYE_LIMIT = { x: 5.5, y: 4 };
/** Body lean in SVG units / degrees; smaller than the eye travel. */
export const LEAN_LIMIT = { x: 2.2, y: 1.4, rotate: 5 };

export type GazeTarget = {
  eyeX: number;
  eyeY: number;
  leanX: number;
  leanY: number;
  rotate: number;
};

export const REST_GAZE: GazeTarget = { eyeX: 0, eyeY: 0, leanX: 0, leanY: 0, rotate: 0 };

const REST_POS = 0.04;
const REST_VEL = 0.08;
const REST_ROT = 0.05;
export const IDLE_MS = 2400;
const MAX_DT = 1 / 30;

export function clampDt(dt: number, max = MAX_DT): number {
  if (!(dt > 0) || !Number.isFinite(dt)) return 1 / 60;
  return dt > max ? max : dt;
}

export function isSettled(s: Spring, target: number, posEps = REST_POS, velEps = REST_VEL): boolean {
  return Math.abs(s.pos - target) < posEps && Math.abs(s.vel) < velEps;
}

/** Semi-implicit Euler; dt is clamped so a long pause cannot explode the state. */
export function stepSpring(s: Spring, target: number, dt: number, p: SpringParams): Spring {
  const h = clampDt(dt);
  const vel = s.vel + (-p.omega * p.omega * (s.pos - target) - 2 * p.zeta * p.omega * s.vel) * h;
  const pos = s.pos + vel * h;
  if (isSettled({ pos, vel }, target)) return { pos: target, vel: 0 };
  return { pos, vel };
}

export function canGaze(
  expression: Expression,
  sizeOrTier: number | "full" | "subtle" | "static",
  reduced = false,
): boolean {
  if (reduced) return false;
  const full = typeof sizeOrTier === "number" ? sizeOrTier >= GAZE_MIN_SIZE : sizeOrTier === "full";
  return full && GAZE_EXPRESSIONS.has(expression);
}

/**
 * Map a pointer in CSS pixels to a clamped gaze in SVG units.
 * `tanh` approaches the limit asymptotically, so far-away pointers do not jump to a hard stop.
 */
export function pointerToGaze(
  pointer: { x: number; y: number } | null,
  origin: { x: number; y: number; width: number; height: number },
  opts: { reducedMotion?: boolean } = {},
): GazeTarget {
  if (!pointer || opts.reducedMotion || origin.width <= 0 || origin.height <= 0) return REST_GAZE;
  const nx = (pointer.x - (origin.x + origin.width / 2)) / (origin.width / 2);
  const ny = (pointer.y - (origin.y + origin.height / 2)) / (origin.height / 2);
  return {
    eyeX: EYE_LIMIT.x * Math.tanh(nx / 2),
    eyeY: EYE_LIMIT.y * Math.tanh(ny / 2),
    leanX: LEAN_LIMIT.x * Math.tanh(nx / 2.6),
    leanY: LEAN_LIMIT.y * Math.tanh(ny / 2.6),
    rotate: LEAN_LIMIT.rotate * Math.tanh(nx / 2.6),
  };
}

/** Hover-mode activation: the pointer is on or near this avatar, not just anywhere on the page. */
export function pointerNear(
  origin: { x: number; y: number; width: number; height: number },
  pointer: { x: number; y: number } | null,
  size: number,
  pad = Math.max(28, size),
): boolean {
  if (!pointer) return false;
  return (
    pointer.x >= origin.x - pad &&
    pointer.x <= origin.x + origin.width + pad &&
    pointer.y >= origin.y - pad &&
    pointer.y <= origin.y + origin.height + pad
  );
}

export function isGazeTimedOut(pointerInDoc: boolean, moveAt: number, now: number, idleMs = IDLE_MS): boolean {
  return !pointerInDoc || now - moveAt >= idleMs;
}

function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

/**
 * Format SVG `<g>` transform directly in SVG user units (`viewBox="0 0 100 100"`).
 * Inside SVG, CSS `translate(Xpx, Ypx)` already maps to SVG user units and scales with the box.
 */
export function formatGazeTransform(x: number, y: number, rotate = 0): string | null {
  if (Math.abs(x) < REST_POS && Math.abs(y) < REST_POS && Math.abs(rotate) < REST_ROT) return null;
  const rot = Math.abs(rotate) < REST_ROT ? "" : ` rotate(${fmt(rotate)}deg)`;
  return `translate(${fmt(x)}px, ${fmt(y)}px)${rot}`;
}

type FollowMode = boolean | "hover";

interface GazeSource {
  svg: () => SVGSVGElement | null;
  lean: () => SVGGElement | null;
  gaze: () => SVGGElement | null;
  follow: () => FollowMode;
  expression: () => Expression;
  size: () => number;
  springs: Record<"eyeX" | "eyeY" | "leanX" | "leanY" | "rotate", Spring>;
}

const sources = new Set<GazeSource>();
let listening = false;
let raf = 0;
let lastTs = 0;
let idleTimer = 0;
let pointer: { x: number; y: number } | null = null;
let pointerInDocument = false;
let lastMoveAt = 0;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function restSpring(): Spring {
  return { pos: 0, vel: 0 };
}

function resetSprings(src: GazeSource) {
  src.springs.eyeX = restSpring();
  src.springs.eyeY = restSpring();
  src.springs.leanX = restSpring();
  src.springs.leanY = restSpring();
  src.springs.rotate = restSpring();
}

function isAtRest(s: GazeSource["springs"]): boolean {
  return (
    s.eyeX.pos === 0 &&
    s.eyeX.vel === 0 &&
    s.eyeY.pos === 0 &&
    s.eyeY.vel === 0 &&
    s.leanX.pos === 0 &&
    s.leanX.vel === 0 &&
    s.leanY.pos === 0 &&
    s.leanY.vel === 0 &&
    s.rotate.pos === 0 &&
    s.rotate.vel === 0
  );
}

function scheduleIdle(delay = IDLE_MS) {
  if (typeof window === "undefined") return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idleTimer = 0;
    kick();
  }, delay);
}

function onPointer(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
  pointerInDocument = true;
  lastMoveAt = nowMs();
  scheduleIdle();
  kick();
}

function onPointerLeft() {
  pointerInDocument = false;
  kick();
}

/** Drive the shared pointer from tests or the evidence harness (synthetic events are unreliable here). */
export function setAvatarPointer(point: { x: number; y: number } | null) {
  if (point) {
    pointer = point;
    pointerInDocument = true;
    lastMoveAt = nowMs();
    scheduleIdle();
    kick();
    return;
  }
  pointerInDocument = false;
  kick();
}

function syncDevHook() {
  if (typeof window === "undefined") return;
  // Showcase evidence harness: Playwright cannot dispatch mouse events in this environment.
  if (location.hash.includes("/dev/avatars")) {
    (window as Window & { __setAvatarPointer?: typeof setAvatarPointer }).__setAvatarPointer = setAvatarPointer;
  }
}

function onVisibility() {
  if (document.hidden) stopLoop();
  else kick();
}

function ensureListen() {
  syncDevHook();
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pointerdown", onPointer, { passive: true });
  window.addEventListener("blur", onPointerLeft);
  window.addEventListener("hashchange", syncDevHook);
  document.documentElement.addEventListener("mouseleave", onPointerLeft);
  document.addEventListener("visibilitychange", onVisibility);
}

function releaseListen() {
  if (!listening) return;
  listening = false;
  delete (window as Window & { __setAvatarPointer?: typeof setAvatarPointer }).__setAvatarPointer;
  window.removeEventListener("pointermove", onPointer);
  window.removeEventListener("pointerdown", onPointer);
  window.removeEventListener("blur", onPointerLeft);
  window.removeEventListener("hashchange", syncDevHook);
  document.documentElement.removeEventListener("mouseleave", onPointerLeft);
  document.removeEventListener("visibilitychange", onVisibility);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = 0;
}

export function gazeLoopRunning(): boolean {
  return raf !== 0;
}

function writeTransform(el: SVGGElement | null, x: number, y: number, rotate = 0): boolean {
  if (!el) return true;
  const tf = formatGazeTransform(x, y, rotate);
  if (!tf) {
    if (el.style.transform) el.style.removeProperty("transform");
    return true;
  }
  if (el.style.transform !== tf) el.style.transform = tf;
  return false;
}

function setGazeAttr(svg: SVGSVGElement | null, active: boolean) {
  if (!svg) return;
  if (active) {
    if (!svg.hasAttribute("data-gaze")) svg.dataset.gaze = "";
  } else if (svg.hasAttribute("data-gaze")) {
    delete svg.dataset.gaze;
  }
}

function resetAllGaze() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = 0;
  for (const src of sources) {
    resetSprings(src);
    writeTransform(src.gaze(), 0, 0);
    writeTransform(src.lean(), 0, 0, 0);
    setGazeAttr(src.svg(), false);
  }
  stopLoop();
}

function syncSourceDom(
  src: GazeSource,
  follow: FollowMode = src.follow(),
  expression: Expression = src.expression(),
  size: number = src.size(),
) {
  const svg = src.svg();
  const lean = src.lean();
  const gaze = src.gaze();
  if (!svg || !lean || !gaze) return;
  if (reducedMotion() || follow === false) {
    resetSprings(src);
    writeTransform(gaze, 0, 0);
    writeTransform(lean, 0, 0, 0);
    setGazeAttr(svg, false);
    return;
  }
  const gazing = canGaze(expression, size, false);
  if (!gazing) {
    // Drop eye offset immediately so non-gazing looks (.ba-look-up / happy) do not fight stale transforms.
    src.springs.eyeX = restSpring();
    src.springs.eyeY = restSpring();
  }
  const eyesRest = writeTransform(gaze, src.springs.eyeX.pos, src.springs.eyeY.pos);
  writeTransform(lean, src.springs.leanX.pos, src.springs.leanY.pos, src.springs.rotate.pos);
  setGazeAttr(svg, !eyesRest);
}

function kick() {
  if (typeof window === "undefined") return;
  if (reducedMotion()) {
    resetAllGaze();
    return;
  }
  if (raf || document.hidden) return;
  lastTs = 0;
  raf = requestAnimationFrame(tick);
  document.documentElement.dataset.avatarGaze = "";
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  lastTs = 0;
  delete document.documentElement.dataset.avatarGaze;
}

function tick(ts: number) {
  const dt = lastTs ? (ts - lastTs) / 1000 : 1 / 60;
  lastTs = ts;
  if (document.hidden) {
    stopLoop();
    return;
  }
  if (reducedMotion()) {
    resetAllGaze();
    return;
  }
  // Idle: pointer left the document, or no movement for IDLE_MS (timer also kicks a return-to-center).
  const now = nowMs();
  const elapsed = now - lastMoveAt;
  const timedOut = isGazeTimedOut(pointerInDocument, lastMoveAt, now);
  let busy = false;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const reads: {
    src: GazeSource;
    svg: SVGSVGElement;
    lean: SVGGElement;
    gaze: SVGGElement;
    mode: FollowMode;
    size: number;
    gazing: boolean;
    rect: DOMRect | null;
  }[] = [];

  for (const src of sources) {
    const svg = src.svg();
    const lean = src.lean();
    const gaze = src.gaze();
    if (!svg?.isConnected || !lean || !gaze) continue;
    const mode = src.follow();
    const size = src.size();
    const gazing = mode !== false && canGaze(src.expression(), size, false);
    const clean =
      isAtRest(src.springs) && !gaze.style.transform && !lean.style.transform && !svg.hasAttribute("data-gaze");
    if (clean && (!gazing || !pointer || timedOut)) continue;
    reads.push({
      src,
      svg,
      lean,
      gaze,
      mode,
      size,
      gazing,
      rect: gazing && !timedOut && pointer ? svg.getBoundingClientRect() : null,
    });
  }

  for (const { src, svg, lean, gaze, mode, size, gazing, rect } of reads) {
    const visible =
      rect !== null && rect.bottom > -40 && rect.top < viewportH + 40 && rect.right > 0 && rect.left < viewportW;
    const nearby = rect !== null && (mode === true || (mode === "hover" && pointerNear(rect, pointer, size)));
    const target =
      gazing && nearby && visible && !timedOut && pointer && rect ? pointerToGaze(pointer, rect) : REST_GAZE;

    if (!gazing) {
      // Immediately clear eye displacement when switching to a scripted expression (thinking/happy/sad).
      src.springs.eyeX = restSpring();
      src.springs.eyeY = restSpring();
    } else {
      src.springs.eyeX = stepSpring(src.springs.eyeX, target.eyeX, dt, EYE_SPRING);
      src.springs.eyeY = stepSpring(src.springs.eyeY, target.eyeY, dt, EYE_SPRING);
    }
    src.springs.leanX = stepSpring(src.springs.leanX, target.leanX, dt, BODY_SPRING);
    src.springs.leanY = stepSpring(src.springs.leanY, target.leanY, dt, BODY_SPRING);
    src.springs.rotate = stepSpring(src.springs.rotate, target.rotate, dt, BODY_SPRING);

    const eyesRest = writeTransform(gaze, src.springs.eyeX.pos, src.springs.eyeY.pos);
    writeTransform(lean, src.springs.leanX.pos, src.springs.leanY.pos, src.springs.rotate.pos);
    setGazeAttr(svg, !eyesRest);

    if (
      (gazing && (!isSettled(src.springs.eyeX, target.eyeX) || !isSettled(src.springs.eyeY, target.eyeY))) ||
      !isSettled(src.springs.leanX, target.leanX) ||
      !isSettled(src.springs.leanY, target.leanY) ||
      !isSettled(src.springs.rotate, target.rotate)
    ) {
      busy = true;
    }
  }

  if (busy) {
    raf = requestAnimationFrame(tick);
  } else {
    stopLoop();
    if (pointerInDocument && !timedOut) scheduleIdle(Math.max(16, IDLE_MS - elapsed));
  }
}

function subscribeGaze(el: Omit<GazeSource, "springs">): { src: GazeSource; unsubscribe: () => void } {
  const src: GazeSource = {
    ...el,
    springs: {
      eyeX: restSpring(),
      eyeY: restSpring(),
      leanX: restSpring(),
      leanY: restSpring(),
      rotate: restSpring(),
    },
  };
  sources.add(src);
  ensureListen();
  kick();
  return {
    src,
    unsubscribe: () => {
      sources.delete(src);
      writeTransform(el.gaze(), 0, 0);
      writeTransform(el.lean(), 0, 0, 0);
      setGazeAttr(el.svg(), false);
      if (sources.size === 0) {
        stopLoop();
        releaseListen();
        pointer = null;
        pointerInDocument = false;
      }
    },
  };
}

export function useAvatarGaze(
  svgRef: RefObject<SVGSVGElement | null>,
  leanRef: RefObject<SVGGElement | null>,
  gazeRef: RefObject<SVGGElement | null>,
  opts: { follow: FollowMode; expression: Expression; size: number; hop?: unknown },
) {
  const { follow, expression, size, hop } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const active = follow !== false && size >= GAZE_MIN_SIZE;
  const srcRef = useRef<GazeSource | null>(null);
  const lastTokenRef = useRef<unknown>(hop);

  useEffect(() => {
    if (!active) return;
    const svg = svgRef.current;
    const lean = leanRef.current;
    const gaze = gazeRef.current;
    if (!svg || !lean || !gaze || typeof window === "undefined") return;
    const sub = subscribeGaze({
      svg: () => svgRef.current,
      lean: () => leanRef.current,
      gaze: () => gazeRef.current,
      follow: () => optsRef.current.follow,
      expression: () => optsRef.current.expression,
      size: () => optsRef.current.size,
    });
    srcRef.current = sub.src;
    return () => {
      srcRef.current = null;
      sub.unsubscribe();
    };
  }, [active, svgRef, leanRef, gazeRef]);

  // Re-sync after expression / hop / follow / size commits so remounted .ba-gaze keeps continuity
  // and transitions into non-gazing expressions wake the loop to clear lean and release data-gaze.
  useLayoutEffect(() => {
    lastTokenRef.current = hop;
    const src = srcRef.current;
    if (!active || !src) return;
    syncSourceDom(src, follow, expression, size);
    kick();
  }, [active, follow, expression, size, hop]);
}
