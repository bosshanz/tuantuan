import { describe, expect, test } from "bun:test";
import { AVATAR_COLORS, AVATAR_SHAPES, defaultAvatar } from "../server/avatars";

describe("default agent avatars", () => {
  test("are deterministic per id and always valid", () => {
    for (let i = 0; i < 200; i++) {
      const id = `agent-${i}`;
      const a = defaultAvatar(id);
      expect(defaultAvatar(id)).toEqual(a);
      expect(AVATAR_SHAPES).toContain(a.shape);
      expect(AVATAR_COLORS).toContain(a.color as (typeof AVATAR_COLORS)[number]);
    }
    expect(defaultAvatar("fixed-id")).toEqual(defaultAvatar("fixed-id"));
  });
  test("spread over most shapes and the muted colours", () => {
    const ids = Array.from({ length: 400 }, () => crypto.randomUUID());
    expect(new Set(ids.map((id) => defaultAvatar(id).shape)).size).toBe(AVATAR_SHAPES.length);
    expect(new Set(ids.map((id) => defaultAvatar(id).color)).size).toBeGreaterThanOrEqual(8);
  });
});
