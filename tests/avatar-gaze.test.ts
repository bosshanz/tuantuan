import { describe, expect, test } from "bun:test";
import {
  BODY_SPRING,
  canGaze,
  clampDt,
  EYE_LIMIT,
  EYE_SPRING,
  formatGazeTransform,
  GAZE_MIN_SIZE,
  IDLE_MS,
  isGazeTimedOut,
  isSettled,
  LEAN_LIMIT,
  pointerNear,
  pointerToGaze,
  REST_GAZE,
  type Spring,
  stepSpring,
} from "../web/src/avatarGaze";
import { EXPRESSIONS } from "../web/src/avatarState";

const box = { x: 100, y: 100, width: 80, height: 80 };

function run(from: Spring, target: number, params = EYE_SPRING, steps = 240, dt = 1 / 60): Spring {
  let s = from;
  for (let i = 0; i < steps; i++) s = stepSpring(s, target, dt, params);
  return s;
}

describe("stepSpring", () => {
  test("converges to the target and reports settled", () => {
    const s = run({ pos: 0, vel: 0 }, 5);
    expect(s.pos).toBeCloseTo(5, 5);
    expect(s.vel).toBe(0);
    expect(isSettled(s, 5)).toBe(true);
  });

  test("returns to rest from a displaced position", () => {
    const s = run({ pos: 4, vel: -2 }, 0, BODY_SPRING);
    expect(s.pos).toBeCloseTo(0, 5);
    expect(isSettled(s, 0)).toBe(true);
  });

  test("a clamped long dt does not explode", () => {
    const s = stepSpring({ pos: 0, vel: 0 }, 10, 2, EYE_SPRING);
    expect(Number.isFinite(s.pos)).toBe(true);
    expect(Number.isFinite(s.vel)).toBe(true);
    expect(Math.abs(s.pos)).toBeLessThan(20);
    expect(clampDt(2)).toBe(1 / 30);
    expect(clampDt(0)).toBe(1 / 60);
    expect(clampDt(Number.NaN)).toBe(1 / 60);
  });

  test("an underdamped spring overshoots then settles", () => {
    const soft = { omega: 12, zeta: 0.4 };
    let s: Spring = { pos: 0, vel: 0 };
    let max = 0;
    for (let i = 0; i < 240; i++) {
      s = stepSpring(s, 10, 1 / 60, soft);
      if (s.pos > max) max = s.pos;
    }
    expect(max).toBeGreaterThan(10.2);
    expect(s.pos).toBeCloseTo(10, 2);
    expect(isSettled(s, 10)).toBe(true);
  });
});

describe("pointerToGaze", () => {
  test("a pointer on the avatar centre maps to zero", () => {
    expect(pointerToGaze({ x: 140, y: 140 }, box)).toEqual(REST_GAZE);
  });

  test("a pointer to the right produces a positive eye offset and a smaller lean", () => {
    const g = pointerToGaze({ x: 220, y: 140 }, box);
    expect(g.eyeX).toBeGreaterThan(0);
    expect(g.eyeY).toBeCloseTo(0, 10);
    expect(g.leanX).toBeGreaterThan(0);
    expect(g.leanX).toBeLessThan(g.eyeX);
    expect(g.rotate).toBeGreaterThan(0);
  });

  test("a pointer above the avatar produces a negative eye Y and stays inside the limits", () => {
    const g = pointerToGaze({ x: 140, y: 20 }, box);
    expect(g.eyeY).toBeLessThan(0);
    expect(Math.abs(g.eyeX)).toBeLessThanOrEqual(EYE_LIMIT.x);
    expect(Math.abs(g.eyeY)).toBeLessThanOrEqual(EYE_LIMIT.y);
    expect(Math.abs(g.leanX)).toBeLessThanOrEqual(LEAN_LIMIT.x);
    expect(Math.abs(g.leanY)).toBeLessThanOrEqual(LEAN_LIMIT.y);
    expect(Math.abs(g.rotate)).toBeLessThanOrEqual(LEAN_LIMIT.rotate);
  });

  test("a far pointer approaches the limit without crossing it", () => {
    const mid = pointerToGaze({ x: 300, y: -20 }, box);
    expect(mid.eyeX).toBeGreaterThan(0);
    expect(mid.eyeX).toBeLessThan(EYE_LIMIT.x);
    const g = pointerToGaze({ x: 10_000, y: -10_000 }, box);
    expect(g.eyeX).toBeGreaterThan(EYE_LIMIT.x * 0.99);
    expect(g.eyeX).toBeLessThanOrEqual(EYE_LIMIT.x);
    expect(g.eyeY).toBeLessThan(-EYE_LIMIT.y * 0.99);
    expect(g.eyeY).toBeGreaterThanOrEqual(-EYE_LIMIT.y);
  });

  test("a missing pointer or reduced motion maps to rest", () => {
    expect(pointerToGaze(null, box)).toEqual(REST_GAZE);
    expect(pointerToGaze({ x: 220, y: 80 }, box, { reducedMotion: true })).toEqual(REST_GAZE);
    expect(pointerToGaze({ x: 220, y: 80 }, { ...box, width: 0 })).toEqual(REST_GAZE);
  });
});

describe("formatGazeTransform and timeout bounds", () => {
  test("writes SVG user units directly without double-scaling by viewBox ratio", () => {
    expect(formatGazeTransform(0, 0, 0)).toBeNull();
    expect(formatGazeTransform(0.02, -0.01, 0.02)).toBeNull();
    expect(formatGazeTransform(5.5, -4, 0)).toBe("translate(5.5px, -4px)");
    expect(formatGazeTransform(2.2, 1.4, 5)).toBe("translate(2.2px, 1.4px) rotate(5deg)");
  });

  test("idle timeout triggers cleanly on the exact IDLE_MS boundary or when pointer leaves", () => {
    expect(isGazeTimedOut(false, 1000, 1010)).toBe(true);
    expect(isGazeTimedOut(true, 1000, 1000 + IDLE_MS - 1)).toBe(false);
    expect(isGazeTimedOut(true, 1000, 1000 + IDLE_MS)).toBe(true);
  });
});

describe("canGaze and pointerNear", () => {
  test("only idle, speaking and awaiting can look around, and only at full size", () => {
    const looking = ["idle", "speaking", "awaiting"];
    for (const e of EXPRESSIONS) {
      expect(canGaze(e, "full")).toBe(looking.includes(e));
      expect(canGaze(e, GAZE_MIN_SIZE)).toBe(looking.includes(e));
      expect(canGaze(e, "subtle")).toBe(false);
      expect(canGaze(e, 24)).toBe(false);
      expect(canGaze(e, "full", true)).toBe(false);
    }
  });

  test("hover mode only activates near the avatar", () => {
    expect(pointerNear(box, { x: 140, y: 140 }, 40)).toBe(true);
    expect(pointerNear(box, { x: 100 - 28, y: 140 }, 40)).toBe(true);
    expect(pointerNear(box, { x: 400, y: 400 }, 40)).toBe(false);
    expect(pointerNear(box, null, 40)).toBe(false);
  });
});
