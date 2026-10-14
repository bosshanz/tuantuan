import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AVATAR_COLORS, AVATAR_SHAPES, defaultAvatar, LEGACY_AVATAR_COLORS } from "../server/avatars";
import { MIGRATIONS, Store } from "../server/store";

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

describe("palette migration", () => {
  test("legacy colours all map into the vivid palette", () => {
    for (const c of Object.values(LEGACY_AVATAR_COLORS)) expect(AVATAR_COLORS).toContain(c as never);
  });
  test("migration 5 recolours paper & ink defaults and leaves custom colours alone", () => {
    const path = `/tmp/tt-palette-${Date.now()}.db`;
    const s1 = new Database(path);
    for (const m of MIGRATIONS.slice(0, 4)) s1.exec(m);
    s1.exec(
      "INSERT INTO agents (id,name,color,avatar,system_prompt,tools,skills,model_mode,pinned_model,created_at,updated_at,avatar_shape) VALUES ('a','A','#2F4A6D','A','','[]','[]','auto',NULL,0,0,'orb'),('b','B','#123456','B','','[]','[]','auto',NULL,0,0,'orb'); PRAGMA user_version = 4",
    );
    s1.close();
    const s2 = new Store(path);
    const rows = s2.db.query("SELECT id, color FROM agents ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a", color: "#3d7bfa" },
      { id: "b", color: "#123456" },
    ]);
    s2.db.close();
  });
});
