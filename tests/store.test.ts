import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";

describe("Store", () => {
  test("migrations are idempotent and a restart marks in-flight replies as interrupted", () => {
    const path = join(tmpdir(), `agent-hub-store-${Date.now()}.db`);
    try {
      const s1 = new Store(path);
      const room = s1.createRoom("r", "group", []);
      const m = s1.insertMessage({
        roomId: room.id,
        runId: "x",
        hop: 1,
        senderKind: "agent",
        senderId: null,
        senderName: "A",
        content: "",
        status: "streaming",
      });
      s1.db.close();
      const s2 = new Store(path);
      expect(s2.getMessage(m.id)).toMatchObject({ status: "interrupted", error: "服务重启，回复中断" });
      expect(s2.db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      s2.db.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    }
  });

  test("pinned_model must be set exactly when mode is pinned (DB CHECK)", () => {
    const s = new Store(":memory:");
    expect(() =>
      s.db.query("INSERT INTO agents VALUES ('a','n','#000000','x','', '[]','[]','pinned',NULL,0,0)").run(),
    ).toThrow("CHECK");
  });

  test("message seq is per room and monotonic", () => {
    const s = new Store(":memory:");
    const r1 = s.createRoom("a", "group", []);
    const r2 = s.createRoom("b", "group", []);
    const base = {
      runId: "x",
      hop: 0,
      senderKind: "human" as const,
      senderId: null,
      senderName: "u",
      content: "c",
      status: "done" as const,
    };
    const seqs = [r1, r1, r2, r1].map((r) => s.insertMessage({ ...base, roomId: r.id }).seq);
    expect(seqs).toEqual([1, 2, 1, 3]);
    expect(s.recentMessages(r1.id, 2).map((m) => m.seq)).toEqual([2, 3]);
  });

  test("browser robot sessions collapse to one shared device: empty ones dropped, newest kept per agent", () => {
    const path = join(tmpdir(), `agent-hub-robot-${Date.now()}.db`);
    try {
      const s1 = new Store(path);
      const agent = s1.createAgent({
        name: "R",
        color: "#000000",
        avatar: "R",
        systemPrompt: "",
        tools: [],
        skills: [],
        modelMode: "auto",
        pinnedModel: null,
      });
      const old = s1.deviceRoom("web-robot-aaaa1111", agent);
      s1.insertMessage({
        roomId: old.id,
        runId: "x",
        hop: 0,
        senderKind: "human",
        senderId: null,
        senderName: "me",
        content: "hi",
        status: "done",
      });
      const empty = s1.deviceRoom("web-robot-bbbb2222", agent);
      s1.db.exec("UPDATE device_sessions SET created_at = 1 WHERE room_id = '" + old.id + "'");
      s1.db.exec("PRAGMA user_version = 2");
      s1.db.close();
      const s2 = new Store(path);
      expect(s2.getRoom(empty.id)).toBeFalsy();
      expect(s2.deviceRoom("web-robot", agent).id).toBe(old.id);
      s2.db.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    }
  });
});
