import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  defaultAvatar,
  isAvatarShape,
  LEGACY_AVATAR_COLORS,
  SELECTABLE_AVATAR_SHAPES,
} from "../server/avatars";
import { ProfileSchema } from "../server/profile";
import type { Agent } from "../server/store";
import { MIGRATIONS, Store } from "../server/store";
import { agentInput } from "./helpers";

const retiredShapes = ["tile", "spark", "bean", "drop", "pill", "wedge", "gem", "hex"] as const;

describe("avatar catalog", () => {
  test("offers eleven shapes including the three new animals, while accepting saved shapes", () => {
    expect(SELECTABLE_AVATAR_SHAPES).toEqual([
      "orb",
      "cloud",
      "clover",
      "flower",
      "burst",
      "cat",
      "dog",
      "rabbit",
      "panda",
      "goat",
      "cow",
    ]);
    for (const shape of AVATAR_SHAPES) {
      expect(isAvatarShape(shape)).toBe(true);
      expect(ProfileSchema.safeParse({ avatar: { kind: "shape", shape, color: "#3d7bfa" } }).success).toBe(true);
    }
    for (const shape of retiredShapes) expect(SELECTABLE_AVATAR_SHAPES as readonly string[]).not.toContain(shape);
    for (const shape of ["unknown", "", null, 1]) expect(isAvatarShape(shape)).toBe(false);
  });

  test("keeps saved retired avatars through restart and editing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-avatar-"));
    const path = join(dir, "store.db");
    let store = new Store(path);
    try {
      const agents = retiredShapes.map((avatarShape) => store.createAgent(agentInput(avatarShape, { avatarShape })));
      store.db.close();
      store = new Store(path);
      for (const a of agents) {
        const loaded = store.getAgent(a.id) as Agent;
        expect(loaded.avatarShape).toBe(a.avatarShape);
        store.updateAgent(a.id, { ...loaded, color: "#f2553c" });
      }
      store.db.close();
      store = new Store(path);
      for (const a of agents)
        expect(store.getAgent(a.id)).toMatchObject({ avatarShape: a.avatarShape, color: "#f2553c" });
    } finally {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("API accepts the new animals and saves edits to retired avatars", async () => {
    const { app, server } = serve({ dbPath: ":memory:" }, 0);
    const base = `http://127.0.0.1:${server.port}/api/agents`;
    try {
      for (const avatarShape of ["panda", "goat", "cow", ...retiredShapes] as const) {
        const created = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(agentInput(avatarShape, { avatarShape })),
        });
        expect(created.status).toBe(201);
        const agent = (await created.json()) as Agent;
        expect(agent.avatarShape).toBe(avatarShape);
        const saved = await fetch(`${base}/${agent.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...agent, color: "#13a594" }),
        });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toMatchObject({ avatarShape, color: "#13a594" });
      }
      const rejected = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...agentInput("invalid"), avatarShape: "unknown" }),
      });
      expect(rejected.status).toBe(400);
    } finally {
      app.host.shutdown();
      server.stop(true);
      app.store.db.close();
    }
  });
});

describe("default agent avatars", () => {
  test("are deterministic per id and always valid", () => {
    for (let i = 0; i < 200; i++) {
      const id = `agent-${i}`;
      const a = defaultAvatar(id);
      expect(defaultAvatar(id)).toEqual(a);
      expect(SELECTABLE_AVATAR_SHAPES as readonly string[]).toContain(a.shape);
      expect(AVATAR_COLORS).toContain(a.color as (typeof AVATAR_COLORS)[number]);
    }
    expect(defaultAvatar("fixed-id")).toEqual(defaultAvatar("fixed-id"));
  });
  test("spread over all selectable shapes and the default colours", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `agent-${i}`);
    expect(new Set(ids.map((id) => defaultAvatar(id).shape)).size).toBe(SELECTABLE_AVATAR_SHAPES.length);
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
