import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  DEFAULT_AVATAR_SHAPES,
  defaultAvatar,
  isAvatarShape,
  isSelectableAvatarShape,
  LEGACY_AVATAR_COLORS,
  newAgentAvatar,
  SELECTABLE_AVATAR_SHAPES,
} from "../server/avatars";
import { ProfileSchema } from "../server/profile";
import type { Agent } from "../server/store";
import { MIGRATIONS, Store } from "../server/store";
import { nextPickerIndex } from "../web/src/AvatarPicker";
import { notificationAvatarCss } from "../web/src/notifications";
import { agentInput } from "./helpers";

const retiredShapes = ["panda", "cow", "goat", "tile", "spark", "bean", "drop", "pill", "wedge", "gem", "hex"] as const;

describe("avatar catalog", () => {
  test("offers eleven selectable shapes including bear, fox, elephant while keeping all 22 saved shapes", () => {
    expect(SELECTABLE_AVATAR_SHAPES).toEqual([
      "orb",
      "cloud",
      "clover",
      "flower",
      "burst",
      "cat",
      "dog",
      "rabbit",
      "bear",
      "fox",
      "elephant",
    ]);
    expect(AVATAR_SHAPES).toHaveLength(22);
    for (const shape of SELECTABLE_AVATAR_SHAPES) expect(isSelectableAvatarShape(shape)).toBe(true);
    for (const shape of AVATAR_SHAPES) {
      expect(isAvatarShape(shape)).toBe(true);
      expect(ProfileSchema.safeParse({ avatar: { kind: "shape", shape, color: "#3d7bfa" } }).success).toBe(true);
    }
    for (const shape of retiredShapes) {
      expect(SELECTABLE_AVATAR_SHAPES as readonly string[]).not.toContain(shape);
      expect(isSelectableAvatarShape(shape)).toBe(false);
    }
    for (const shape of ["hedgehog", "unknown", "", null, 1]) {
      expect(isAvatarShape(shape)).toBe(false);
      expect(isSelectableAvatarShape(shape)).toBe(false);
    }
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

  test("API accepts the new selectable animals and saves edits to retired avatars", async () => {
    const { app, server } = serve({ dbPath: ":memory:" }, 0);
    const base = `http://127.0.0.1:${server.port}/api/agents`;
    try {
      for (const avatarShape of ["bear", "fox", "elephant", ...retiredShapes] as const) {
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
      for (const badShape of ["unknown", "hedgehog"]) {
        const rejected = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...agentInput("invalid"), avatarShape: badShape }),
        });
        expect(rejected.status).toBe(400);
      }
    } finally {
      app.host.shutdown();
      server.stop(true);
      app.store.db.close();
    }
  });
});

describe("default & new agent avatars", () => {
  test("defaultAvatar stays deterministic over DEFAULT_AVATAR_SHAPES (legacy backfill)", () => {
    for (let i = 0; i < 200; i++) {
      const id = `agent-${i}`;
      const a = defaultAvatar(id);
      expect(defaultAvatar(id)).toEqual(a);
      expect(DEFAULT_AVATAR_SHAPES as readonly string[]).toContain(a.shape);
      expect(AVATAR_COLORS).toContain(a.color as (typeof AVATAR_COLORS)[number]);
    }
    expect(defaultAvatar("fixed-id")).toEqual(defaultAvatar("fixed-id"));
    const ids = Array.from({ length: 400 }, (_, i) => `agent-${i}`);
    expect(new Set(ids.map((id) => defaultAvatar(id).shape)).size).toBe(DEFAULT_AVATAR_SHAPES.length);
    expect(new Set(ids.map((id) => defaultAvatar(id).color)).size).toBeGreaterThanOrEqual(8);
  });

  test("newAgentAvatar assigns deterministically from SELECTABLE_AVATAR_SHAPES and never picks retired shapes", () => {
    for (let i = 0; i < 200; i++) {
      const id = `new-agent-${i}`;
      const a = newAgentAvatar(id);
      expect(newAgentAvatar(id)).toEqual(a);
      expect(isSelectableAvatarShape(a.shape)).toBe(true);
      expect(retiredShapes as readonly string[]).not.toContain(a.shape);
      expect(AVATAR_COLORS).toContain(a.color as (typeof AVATAR_COLORS)[number]);
    }
    const ids = Array.from({ length: 400 }, (_, i) => `new-agent-${i}`);
    expect(new Set(ids.map((id) => newAgentAvatar(id).shape)).size).toBe(SELECTABLE_AVATAR_SHAPES.length);
    expect(new Set(ids.map((id) => newAgentAvatar(id).color)).size).toBeGreaterThanOrEqual(8);
  });

  test("Store insert defaults to SELECTABLE_AVATAR_SHAPES while startup backfill and updates keep defaultAvatar", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-avatar-backfill-"));
    const path = join(dir, "store.db");
    let store = new Store(path);
    try {
      for (let i = 0; i < 40; i++) {
        const created = store.createAgent(agentInput(`fresh-${i}`));
        expect(isSelectableAvatarShape(created.avatarShape)).toBe(true);
      }
      const seeded = store.createAgent(agentInput("Legacy"));
      store.db.run("UPDATE agents SET id = 'agent-3', avatar_shape = '' WHERE id = ?", [seeded.id]);
      store.db.close();
      store = new Store(path);
      const backfilled = store.getAgent("agent-3") as Agent;
      expect(backfilled.avatarShape).toBe(defaultAvatar("agent-3").shape);
      expect(DEFAULT_AVATAR_SHAPES as readonly string[]).toContain(backfilled.avatarShape);
      const updated = store.updateAgent("agent-3", { ...agentInput("Legacy"), avatarShape: undefined });
      expect(updated?.avatarShape).toBe(defaultAvatar("agent-3").shape);
    } finally {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("avatar picker keyboard navigation", () => {
  test("wraps 5-column grid cleanly without a header slot", () => {
    expect(nextPickerIndex(0, "ArrowRight", 11, 5, false)).toBe(1);
    expect(nextPickerIndex(10, "ArrowRight", 11, 5, false)).toBe(0);
    expect(nextPickerIndex(0, "ArrowLeft", 11, 5, false)).toBe(10);
    expect(nextPickerIndex(1, "ArrowDown", 11, 5, false)).toBe(6);
    expect(nextPickerIndex(7, "ArrowDown", 11, 5, false)).toBe(1);
    expect(nextPickerIndex(1, "ArrowUp", 11, 5, false)).toBe(7);
    expect(nextPickerIndex(-1, "ArrowDown", 11, 5, false)).toBeNull();
    expect(nextPickerIndex(0, "Enter", 11, 5, false)).toBeNull();
  });

  test("navigates top pinned retired slot + 5-column selectable grid", () => {
    // Index 0 = pinned retired shape row; grid rows: [1..5], [6..10], [11]
    expect(nextPickerIndex(0, "ArrowDown", 12, 5, true)).toBe(1);
    expect(nextPickerIndex(1, "ArrowDown", 12, 5, true)).toBe(6);
    expect(nextPickerIndex(6, "ArrowDown", 12, 5, true)).toBe(11);
    expect(nextPickerIndex(7, "ArrowDown", 12, 5, true)).toBe(0);
    expect(nextPickerIndex(11, "ArrowDown", 12, 5, true)).toBe(0);

    expect(nextPickerIndex(0, "ArrowUp", 12, 5, true)).toBe(11);
    expect(nextPickerIndex(11, "ArrowUp", 12, 5, true)).toBe(6);
    expect(nextPickerIndex(6, "ArrowUp", 12, 5, true)).toBe(1);
    expect(nextPickerIndex(1, "ArrowUp", 12, 5, true)).toBe(0);
    expect(nextPickerIndex(5, "ArrowUp", 12, 5, true)).toBe(0);

    expect(nextPickerIndex(11, "ArrowRight", 12, 5, true)).toBe(0);
    expect(nextPickerIndex(0, "ArrowLeft", 12, 5, true)).toBe(11);
  });
});

describe("notification avatar CSS", () => {
  test("embeds solid white cutout/white layers, detail strokes, mouth width, and panda overrides", () => {
    const css = notificationAvatarCss("#3d7bfa");
    expect(css).toContain(".ba-body>*{fill:#3d7bfa;stroke:#3d7bfa}");
    expect(css).toContain(".ba-body>.ba-white,.ba-body>.ba-cutout{fill:#fff;stroke:none}");
    expect(css).toContain(".ba-body>.ba-detail{fill:none;stroke:#fff;stroke-width:4}");
    expect(css).toContain(".ba-mouth:not(.ba-dot){stroke-width:5}");
    expect(css).toContain('[data-expr="happy"] .ba-eyes path,.ba-face-curious .ba-eyes path{stroke-width:6}');
    expect(css).toContain('[data-shape="panda"] .ba-mouth{stroke:#3d7bfa}');
    expect(css).toContain('[data-shape="panda"] .ba-dot.ba-mouth{fill:#3d7bfa;stroke:none}');
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
