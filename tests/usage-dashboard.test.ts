import { expect, test } from "bun:test";
import { cacheHitRate, formatCacheHitRate } from "../web/src/usage";

test("cache hit rate uses input + cache read + cache write as its denominator", () => {
  expect(cacheHitRate(800, 400, 100)).toBeCloseTo(400 / 1300, 12);
  expect(formatCacheHitRate(cacheHitRate(800, 400, 100))).toBe("30.8%");
  // No recorded token volume is no data, not 0%.
  expect(cacheHitRate(0, 0, 0)).toBeNull();
  expect(formatCacheHitRate(null)).toBeNull();
  // Input without any cache read is a real 0%, and cache-only traffic can reach or exceed 100%.
  expect(cacheHitRate(500, 0, 0)).toBe(0);
  expect(formatCacheHitRate(0)).toBe("0.0%");
  expect(cacheHitRate(0, 250, 0)).toBe(1);
  expect(formatCacheHitRate(1)).toBe("100.0%");
  expect(formatCacheHitRate(1.3)).toBe("130.0%");
});
