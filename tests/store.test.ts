import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, Store } from "../server/store";
import { agentInput } from "./helpers";

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
      expect(s2.db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
      s2.db.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    }
  });

  test("migration 6: system prompt becomes the identity doc, MCP tool ids become servers, groups get a main agent", () => {
    const path = join(tmpdir(), `agent-hub-m6-${Date.now()}.db`);
    try {
      const db = new Database(path);
      for (const m of MIGRATIONS.slice(0, 5)) db.exec(m);
      db.exec("PRAGMA user_version = 5");
      db.exec(`INSERT INTO mcp_servers VALUES ('srv1','s','http://x',0);
        INSERT INTO agents (id,name,color,avatar,system_prompt,tools,skills,model_mode,pinned_model,created_at,updated_at,avatar_shape)
        VALUES ('a1','A','#000000','A','你是测试员','["builtin:calculator","mcp:srv1:search","mcp:srv1:fetch"]','[]','auto',NULL,0,0,'orb'),
               ('a2','B','#000000','B','','[]','[]','auto',NULL,1,1,'orb');
        INSERT INTO rooms VALUES ('g','群','group',0); INSERT INTO room_agents VALUES ('g','a2'),('g','a1');`);
      db.close();
      const s = new Store(path);
      expect(s.getAgent("a1")).toMatchObject({ identity: "你是测试员", harness: "", mcpServerIds: ["srv1"] });
      expect(s.getAgent("a2")?.mcpServerIds).toEqual([]);
      expect(s.getRoom("g")).toMatchObject({ mainAgentId: "a2", cwd: "" });
      s.db.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    }
  });

  test("migration 8: an agent's old cwd moves onto its DMs that have none, then the column is dropped", () => {
    const path = join(tmpdir(), `agent-hub-m8-${Date.now()}.db`);
    try {
      const db = new Database(path);
      for (const m of MIGRATIONS.slice(0, 7)) db.exec(m);
      db.exec("PRAGMA user_version = 7");
      db.exec(`INSERT INTO agents (id,name,color,avatar,identity,tools,skills,model_mode,created_at,updated_at,cwd) VALUES ('a1','A','#000000','A','','[]','[]','auto',0,0,'/srv/a');
        INSERT INTO rooms (id,name,kind,created_at,cwd) VALUES ('d1','dm','dm',0,''),('d2','dm2','dm',0,'/keep'),('g','g','group',0,'');
        INSERT INTO room_agents VALUES ('d1','a1'),('d2','a1'),('g','a1');`);
      db.close();
      const s = new Store(path);
      expect([s.getRoom("d1")?.cwd, s.getRoom("d2")?.cwd, s.getRoom("g")?.cwd]).toEqual(["/srv/a", "/keep", ""]);
      expect(s.getAgent("a1")).not.toHaveProperty("cwd");
      s.db.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    }
  });

  test("group main agent must be a member and follows membership changes", () => {
    const s = new Store(":memory:");
    const a = s.createAgent(agentInput("A"));
    const b = s.createAgent(agentInput("B"));
    const g = s.createRoom("g", "group", [a.id, b.id], { mainAgentId: b.id });
    expect(g.mainAgentId).toBe(b.id);
    expect(s.updateRoom(g.id, { mainAgentId: "nope" }).mainAgentId).toBe(a.id);
    expect(s.setRoomAgents(g.id, [b.id]).mainAgentId).toBe(b.id);
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

  test("migration 7: databases from the robot era start and lose only the robot conversations", () => {
    const path = join(tmpdir(), `agent-hub-robot-${Date.now()}.db`);
    try {
      // Build a version-2 database (before avatar shapes) holding two browser-robot rooms.
      const db = new Database(path);
      for (const m of MIGRATIONS.slice(0, 2)) db.exec(m);
      db.exec(`PRAGMA user_version = 2;
        INSERT INTO agents (id,name,color,avatar,system_prompt,tools,skills,model_mode,pinned_model,created_at,updated_at)
          VALUES ('r','R','#000000','R','','[]','[]','auto',NULL,0,0);
        INSERT INTO rooms VALUES ('old','桌面机器人 · R','dm',0), ('empty','桌面机器人 · R','dm',2), ('keep','私聊','dm',3);
        INSERT INTO room_agents VALUES ('old','r'), ('empty','r'), ('keep','r');
        INSERT INTO device_sessions VALUES ('web-robot-aaaa1111','r','old',1), ('web-robot-bbbb2222','r','empty',2);
        INSERT INTO messages (id,room_id,seq,run_id,hop,sender_kind,sender_id,sender_name,content,status,created_at)
          VALUES ('m','old',1,'m',0,'human',NULL,'me','hi','done',0), ('k','keep',1,'k',0,'human',NULL,'me','yo','done',0);`);
      db.close();
      const s2 = new Store(path);
      expect(s2.listRooms().map((r) => r.id)).toEqual(["keep"]);
      expect(s2.recentMessages("keep", 10).map((m) => m.content)).toEqual(["yo"]);
      expect(s2.db.query("SELECT name FROM sqlite_master WHERE name = 'device_sessions'").get()).toBeNull();
      s2.db.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    }
  });
});
