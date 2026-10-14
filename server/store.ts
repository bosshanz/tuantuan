import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { emptyTimeline, type Timeline } from "../shared/timeline";
import { type AvatarShape, defaultAvatar, isAvatarShape } from "./avatars";

/** SQLite is the source of truth for agents, rooms, messages and ACP session bindings. */

export const MIGRATIONS: string[] = [
  `CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     color TEXT NOT NULL,
     avatar TEXT NOT NULL,
     system_prompt TEXT NOT NULL,
     tools TEXT NOT NULL,         -- JSON string[] of tool ids
     skills TEXT NOT NULL,        -- JSON string[] of skill names
     model_mode TEXT NOT NULL CHECK (model_mode IN ('auto','pinned')),
     pinned_model TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     CHECK ((model_mode = 'pinned') = (pinned_model IS NOT NULL))
   );
   CREATE TABLE mcp_servers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     url TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE rooms (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('group','dm')),
     created_at INTEGER NOT NULL
   );
   CREATE TABLE room_agents (
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     PRIMARY KEY (room_id, agent_id)
   );
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     run_id TEXT NOT NULL,          -- id of the human message that started this chain
     hop INTEGER NOT NULL,          -- 0 = human, 1 = agent triggered by human, 2+ = agent-to-agent
     sender_kind TEXT NOT NULL CHECK (sender_kind IN ('human','agent','system')),
     sender_id TEXT,
     sender_name TEXT NOT NULL,
     content TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('streaming','done','error','cancelled','interrupted')),
     error TEXT,
     tool_calls TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL,
     UNIQUE (room_id, seq)
   );
   CREATE TABLE routing_decisions (
     message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
     plan TEXT NOT NULL,            -- JSON RoutingPlan
     attempts TEXT NOT NULL,        -- JSON Attempt[]
     chosen_model TEXT,             -- NULL when every candidate failed
     created_at INTEGER NOT NULL
   );`,
  // Historical (removed in migration 7): a desktop robot's conversation per agent binding.
  `CREATE TABLE device_sessions (
     device_id TEXT NOT NULL,
     agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (device_id, agent_id)
   );`,
  // Historical (removed in migration 7): collapsed duplicate browser-robot rooms.
  `DELETE FROM rooms WHERE id IN (
     SELECT room_id FROM device_sessions
     WHERE device_id LIKE 'web-robot-%' AND room_id NOT IN (SELECT DISTINCT room_id FROM messages));
   DELETE FROM device_sessions WHERE room_id NOT IN (SELECT id FROM rooms);
   UPDATE device_sessions SET device_id = 'web-robot'
   WHERE device_id LIKE 'web-robot-%'
     AND NOT EXISTS (SELECT 1 FROM device_sessions d0 WHERE d0.device_id = 'web-robot' AND d0.agent_id = device_sessions.agent_id)
     AND created_at = (SELECT MAX(d2.created_at) FROM device_sessions d2
                       WHERE d2.agent_id = device_sessions.agent_id AND d2.device_id LIKE 'web-robot-%');`,
  // SVG bot avatars; '' is backfilled with a per-id default right after migrating.
  `ALTER TABLE agents ADD COLUMN avatar_shape TEXT NOT NULL DEFAULT '';`,
  // Visual refresh: move the muted paper & ink avatar colours to the vivid palette (see LEGACY_AVATAR_COLORS).
  `UPDATE agents SET color = CASE lower(color) WHEN '#2f4a6d' THEN '#3d7bfa' WHEN '#2f6b6b' THEN '#13a594' WHEN '#3d6b4f' THEN '#2bb06a' WHEN '#6f7a3a' THEN '#86b51c' WHEN '#b0812a' THEN '#f5a30f' WHEN '#b0432a' THEN '#f2553c' WHEN '#a8476b' THEN '#ee4f97' WHEN '#6d3f5b' THEN '#9a5bea' WHEN '#7a5a3c' THEN '#ff7a1f' WHEN '#4f5d63' THEN '#22a6dc' WHEN '#2a2722' THEN '#3a3a3c' WHEN '#2f7de1' THEN '#3d7bfa' WHEN '#e0662e' THEN '#ff7a1f' ELSE color END;`,
  // Harness era (docs/plan-harness-acp.md): agents are driven by ACP harnesses. The old system prompt
  // becomes the Tuantuan identity doc; tools/skills/model_mode/pinned_model stay as unused legacy
  // columns (a CHECK constraint references them, so they cannot be dropped without a table rebuild).
  // Existing MCP bindings ("mcp:<server>:<tool>" tool ids) become per-agent MCP server ids.
  `ALTER TABLE agents RENAME COLUMN system_prompt TO identity;
   ALTER TABLE agents ADD COLUMN harness TEXT NOT NULL DEFAULT '';
   ALTER TABLE agents ADD COLUMN cwd TEXT NOT NULL DEFAULT '';
   ALTER TABLE agents ADD COLUMN env TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE agents ADD COLUMN permission_policy TEXT NOT NULL DEFAULT 'ask';
   ALTER TABLE agents ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT '[]';
   UPDATE agents SET mcp_server_ids = COALESCE((
     SELECT json_group_array(DISTINCT substr(j.value, 5, instr(substr(j.value, 5), ':') - 1))
     FROM json_each(agents.tools) j WHERE j.value LIKE 'mcp:%:%'), '[]');
   ALTER TABLE rooms ADD COLUMN main_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
   ALTER TABLE rooms ADD COLUMN cwd TEXT NOT NULL DEFAULT '';
   UPDATE rooms SET main_agent_id = (SELECT agent_id FROM room_agents WHERE room_id = rooms.id ORDER BY rowid LIMIT 1)
     WHERE kind = 'group';
   ALTER TABLE messages ADD COLUMN timeline TEXT;
   DROP TABLE routing_decisions;
   CREATE TABLE acp_sessions (
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     harness TEXT NOT NULL,
     session_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (room_id, agent_id)
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // The desktop robot feature was removed: drop its conversations and the device binding table.
  // (Migrations 2–3 above still create/clean that table so old databases upgrade step by step.)
  `DELETE FROM messages WHERE room_id IN (SELECT room_id FROM device_sessions);
   DELETE FROM acp_sessions WHERE room_id IN (SELECT room_id FROM device_sessions);
   DELETE FROM room_agents WHERE room_id IN (SELECT room_id FROM device_sessions);
   DELETE FROM rooms WHERE id IN (SELECT room_id FROM device_sessions);
   DROP TABLE device_sessions;`,
];

export const PERMISSION_POLICIES = ["ask", "allow"] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];

export interface Agent {
  id: string;
  name: string;
  color: string;
  avatar: string;
  avatarShape: AvatarShape;
  /** Tuantuan-owned identity doc (AGENTS.md-style), delivered to the harness per §3.4 of the plan. */
  identity: string;
  /** Harness id from server/harness.ts; "" = not bound yet (onboarding). */
  harness: string;
  /** Working directory for private chats; "" = the user's home directory. Groups use the room's cwd. */
  cwd: string;
  /** Extra env vars for the harness process (e.g. API keys). Never sent to the browser in full. */
  env: Record<string, string>;
  mcpServerIds: string[];
  /** "ask" shows the permission dialog; "allow" picks the agent's first allow option automatically. */
  permissionPolicy: PermissionPolicy;
  createdAt: number;
  updatedAt: number;
}

export type AgentInput = Omit<Agent, "id" | "createdAt" | "updatedAt" | "avatarShape" | "color"> & {
  /** Omitted or "" => deterministic default from the agent id. */
  color?: string;
  avatarShape?: AvatarShape;
};

export interface Room {
  id: string;
  name: string;
  kind: "group" | "dm";
  agentIds: string[];
  /** Group only: who answers when nobody is @-mentioned. */
  mainAgentId: string | null;
  /** Group only: shared working directory of all members; "" = home directory. */
  cwd: string;
  createdAt: number;
}

export type MessageStatus = "streaming" | "done" | "error" | "cancelled" | "interrupted";

export interface Message {
  id: string;
  roomId: string;
  seq: number;
  runId: string;
  hop: number;
  senderKind: "human" | "agent" | "system";
  senderId: string | null;
  senderName: string;
  content: string;
  status: MessageStatus;
  error: string | null;
  /** Agent replies: everything the harness streamed (text, thoughts, tool calls, plan). Null for others. */
  timeline: Timeline | null;
  createdAt: number;
}

export interface AcpSessionRow {
  roomId: string;
  agentId: string;
  harness: string;
  sessionId: string;
  createdAt: number;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
    for (const { id } of this.db.query("SELECT id FROM agents WHERE avatar_shape = ''").all() as { id: string }[])
      this.db.query("UPDATE agents SET avatar_shape = ? WHERE id = ?").run(defaultAvatar(id).shape, id);
    // Streams cannot survive a restart: mark them so the UI does not show a forever-typing message.
    this.db
      .query("UPDATE messages SET status = 'interrupted', error = '服务重启，回复中断' WHERE status = 'streaming'")
      .run();
  }

  private migrate() {
    const { user_version } = this.db.query("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  // ---- agents ----
  listAgents(): Agent[] {
    return (this.db.query("SELECT * FROM agents ORDER BY created_at, name").all() as Row[]).map(toAgent);
  }

  getAgent(id: string): Agent | null {
    const row = this.db.query("SELECT * FROM agents WHERE id = ?").get(id) as Row | null;
    return row ? toAgent(row) : null;
  }

  createAgent(input: AgentInput): Agent {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.writeAgent(id, input, now, now, "insert");
    return this.getAgent(id) as Agent;
  }

  updateAgent(id: string, input: AgentInput): Agent {
    const existing = this.getAgent(id);
    if (!existing) throw new ValidationError("Agent 不存在", 404);
    this.writeAgent(id, input, existing.createdAt, Date.now(), "update");
    return this.getAgent(id) as Agent;
  }

  private writeAgent(id: string, a: AgentInput, createdAt: number, updatedAt: number, op: "insert" | "update") {
    const params = {
      id,
      name: a.name,
      color: a.color || defaultAvatar(id).color,
      avatar: a.avatar,
      avatar_shape: isAvatarShape(a.avatarShape) ? a.avatarShape : defaultAvatar(id).shape,
      identity: a.identity,
      harness: a.harness,
      cwd: a.cwd,
      env: JSON.stringify(a.env),
      permission_policy: a.permissionPolicy,
      mcp_server_ids: JSON.stringify(a.mcpServerIds),
      tools: "[]",
      skills: "[]",
      model_mode: "auto",
      created_at: createdAt,
      updated_at: updatedAt,
    };
    const sql =
      op === "insert"
        ? `INSERT INTO agents (id,name,color,avatar,avatar_shape,identity,harness,cwd,env,permission_policy,mcp_server_ids,tools,skills,model_mode,created_at,updated_at)
             VALUES ($id,$name,$color,$avatar,$avatar_shape,$identity,$harness,$cwd,$env,$permission_policy,$mcp_server_ids,$tools,$skills,$model_mode,$created_at,$updated_at)`
        : `UPDATE agents SET name=$name,color=$color,avatar=$avatar,avatar_shape=$avatar_shape,identity=$identity,harness=$harness,cwd=$cwd,env=$env,
             permission_policy=$permission_policy,mcp_server_ids=$mcp_server_ids,updated_at=$updated_at WHERE id=$id AND created_at=$created_at`;
    try {
      this.db.query(sql).run(params);
    } catch (e) {
      if (String(e).includes("UNIQUE"))
        throw new ValidationError(`已存在名为「${a.name}」的 Agent（名称用于 @，不能重复）`, 409);
      throw e;
    }
  }

  deleteAgent(id: string): boolean {
    return this.db.query("DELETE FROM agents WHERE id = ?").run(id).changes > 0;
  }

  // ---- mcp servers ----
  listMcpServers(): McpServer[] {
    return (this.db.query("SELECT * FROM mcp_servers ORDER BY created_at").all() as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      url: r.url as string,
      createdAt: r.created_at as number,
    }));
  }

  createMcpServer(name: string, url: string): McpServer {
    const s = { id: crypto.randomUUID(), name, url, createdAt: Date.now() };
    try {
      this.db.query("INSERT INTO mcp_servers VALUES (?,?,?,?)").run(s.id, s.name, s.url, s.createdAt);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new ValidationError("该 MCP URL 已添加", 409);
      throw e;
    }
    return s;
  }

  deleteMcpServer(id: string): boolean {
    return this.db.query("DELETE FROM mcp_servers WHERE id = ?").run(id).changes > 0;
  }

  // ---- rooms ----
  listRooms(): Room[] {
    const rooms = this.db.query("SELECT * FROM rooms ORDER BY created_at").all() as Row[];
    return rooms.map((r) => this.toRoom(r));
  }

  getRoom(id: string): Room | null {
    const row = this.db.query("SELECT * FROM rooms WHERE id = ?").get(id) as Row | null;
    return row ? this.toRoom(row) : null;
  }

  createRoom(
    name: string,
    kind: "group" | "dm",
    agentIds: string[],
    opts: { mainAgentId?: string | null; cwd?: string } = {},
  ): Room {
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO rooms (id, name, kind, created_at, cwd) VALUES (?,?,?,?,?)")
        .run(id, name, kind, Date.now(), opts.cwd ?? "");
      this.setRoomAgentsTx(id, agentIds);
      if (kind === "group") this.setMainTx(id, opts.mainAgentId ?? null);
    })();
    return this.getRoom(id) as Room;
  }

  setRoomAgents(roomId: string, agentIds: string[]): Room {
    this.db.transaction(() => {
      this.setRoomAgentsTx(roomId, agentIds);
      const room = this.getRoom(roomId);
      if (room?.kind === "group") this.setMainTx(roomId, room.mainAgentId);
    })();
    return this.getRoom(roomId) as Room;
  }

  /** Group settings. The main agent must be a member; it falls back to the first member. */
  updateGroup(roomId: string, patch: { mainAgentId?: string | null; cwd?: string }): Room {
    this.db.transaction(() => {
      if (patch.cwd !== undefined) this.db.query("UPDATE rooms SET cwd = ? WHERE id = ?").run(patch.cwd, roomId);
      if (patch.mainAgentId !== undefined) this.setMainTx(roomId, patch.mainAgentId);
    })();
    return this.getRoom(roomId) as Room;
  }

  private setMainTx(roomId: string, wanted: string | null) {
    const members = (
      this.db.query("SELECT agent_id FROM room_agents WHERE room_id = ? ORDER BY rowid").all(roomId) as Row[]
    ).map((x) => x.agent_id as string);
    const main = wanted && members.includes(wanted) ? wanted : (members[0] ?? null);
    this.db.query("UPDATE rooms SET main_agent_id = ? WHERE id = ?").run(main, roomId);
  }

  private setRoomAgentsTx(roomId: string, agentIds: string[]) {
    this.db.query("DELETE FROM room_agents WHERE room_id = ?").run(roomId);
    for (const a of new Set(agentIds)) {
      if (!this.getAgent(a)) throw new ValidationError(`Agent ${a} 不存在`);
      this.db.query("INSERT INTO room_agents VALUES (?,?)").run(roomId, a);
    }
  }

  deleteRoom(id: string): boolean {
    return this.db.query("DELETE FROM rooms WHERE id = ?").run(id).changes > 0;
  }

  private toRoom(r: Row): Room {
    const agentIds = (
      this.db.query("SELECT agent_id FROM room_agents WHERE room_id = ? ORDER BY rowid").all(r.id as string) as Row[]
    ).map((x) => x.agent_id as string);
    return {
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as Room["kind"],
      agentIds,
      mainAgentId: (r.main_agent_id as string | null) ?? null,
      cwd: (r.cwd as string) ?? "",
      createdAt: r.created_at as number,
    };
  }

  // ---- messages ----
  insertMessage(m: Omit<Message, "id" | "seq" | "createdAt" | "timeline" | "error"> & { id?: string }): Message {
    const id = m.id ?? crypto.randomUUID();
    this.db.transaction(() => {
      const { next } = this.db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?")
        .get(m.roomId) as { next: number };
      this.db
        .query(
          `INSERT INTO messages (id, room_id, seq, run_id, hop, sender_kind, sender_id, sender_name, content, status, created_at, timeline)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          m.roomId,
          next,
          m.runId,
          m.hop,
          m.senderKind,
          m.senderId,
          m.senderName,
          m.content,
          m.status,
          Date.now(),
          m.senderKind === "agent" ? JSON.stringify(emptyTimeline()) : null,
        );
    })();
    return this.getMessage(id) as Message;
  }

  /** Saves reply progress; also used for the final state (status other than "streaming"). */
  updateReply(
    id: string,
    patch: { content: string; status: MessageStatus; error?: string | null; timeline: Timeline },
  ): Message {
    this.db
      .query("UPDATE messages SET content = ?, status = ?, error = ?, timeline = ? WHERE id = ?")
      .run(patch.content, patch.status, patch.error ?? null, JSON.stringify(patch.timeline), id);
    return this.getMessage(id) as Message;
  }

  getMessage(id: string): Message | null {
    const row = this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as Row | null;
    return row ? toMessage(row) : null;
  }

  /** Most recent `limit` messages in chronological order. */
  recentMessages(roomId: string, limit: number, beforeSeq?: number): Message[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(roomId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit) as Row[];
    return rows.reverse().map(toMessage);
  }

  // ---- ACP sessions: one per (room, agent) ----
  getAcpSession(roomId: string, agentId: string): AcpSessionRow | null {
    const r = this.db
      .query("SELECT * FROM acp_sessions WHERE room_id = ? AND agent_id = ?")
      .get(roomId, agentId) as Row | null;
    return r
      ? {
          roomId: r.room_id as string,
          agentId: r.agent_id as string,
          harness: r.harness as string,
          sessionId: r.session_id as string,
          createdAt: r.created_at as number,
        }
      : null;
  }

  setAcpSession(roomId: string, agentId: string, harness: string, sessionId: string) {
    this.db
      .query("INSERT OR REPLACE INTO acp_sessions VALUES (?,?,?,?,?)")
      .run(roomId, agentId, harness, sessionId, Date.now());
  }

  clearAcpSession(roomId: string, agentId: string) {
    this.db.query("DELETE FROM acp_sessions WHERE room_id = ? AND agent_id = ?").run(roomId, agentId);
  }

  // ---- settings ----
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as Row | null;
    return r ? (JSON.parse(r.value as string) as T) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.db.query("INSERT OR REPLACE INTO settings VALUES (?, ?)").run(key, JSON.stringify(value));
  }
}

function toAgent(r: Row): Agent {
  return {
    id: r.id as string,
    name: r.name as string,
    color: r.color as string,
    avatar: r.avatar as string,
    avatarShape: r.avatar_shape as AvatarShape,
    identity: r.identity as string,
    harness: r.harness as string,
    cwd: r.cwd as string,
    env: JSON.parse(r.env as string),
    mcpServerIds: JSON.parse(r.mcp_server_ids as string),
    permissionPolicy: r.permission_policy as PermissionPolicy,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toMessage(r: Row): Message {
  return {
    id: r.id as string,
    roomId: r.room_id as string,
    seq: r.seq as number,
    runId: r.run_id as string,
    hop: r.hop as number,
    senderKind: r.sender_kind as Message["senderKind"],
    senderId: (r.sender_id as string | null) ?? null,
    senderName: r.sender_name as string,
    content: r.content as string,
    status: r.status as MessageStatus,
    error: (r.error as string | null) ?? null,
    timeline: r.timeline ? (JSON.parse(r.timeline as string) as Timeline) : null,
    createdAt: r.created_at as number,
  };
}
