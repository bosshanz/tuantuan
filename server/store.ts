import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type AvatarShape, defaultAvatar, isAvatarShape } from "./avatars";
import type { Attempt, RoutingPlan } from "./router";
import type { ToolCallRecord } from "./tool-loop";

/** SQLite is the source of truth for agents, rooms, messages and routing decisions. */

const MIGRATIONS: string[] = [
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
  // A device (e.g. desktop robot) talking to an agent gets its own DM-like room per agent binding.
  `CREATE TABLE device_sessions (
     device_id TEXT NOT NULL,
     agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (device_id, agent_id)
   );`,
  // The browser robot used to mint a random device id per browser profile, flooding the list with
  // "桌面机器人" rooms. It now uses one shared id: drop the empty ones and adopt the newest per agent.
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
];

export interface Agent {
  id: string;
  name: string;
  color: string;
  avatar: string;
  avatarShape: AvatarShape;
  systemPrompt: string;
  tools: string[];
  skills: string[];
  modelMode: "auto" | "pinned";
  pinnedModel: string | null;
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
  /** Set when this DM is the conversation of a device (robot) bound to the agent. */
  deviceId: string | null;
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
  toolCalls: ToolCallRecord[];
  createdAt: number;
}

export interface RoutingDecision {
  messageId: string;
  plan: RoutingPlan;
  attempts: Attempt[];
  chosenModel: string | null;
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
      system_prompt: a.systemPrompt,
      tools: JSON.stringify(a.tools),
      skills: JSON.stringify(a.skills),
      model_mode: a.modelMode,
      pinned_model: a.modelMode === "pinned" ? a.pinnedModel : null,
      created_at: createdAt,
      updated_at: updatedAt,
    };
    const sql =
      op === "insert"
        ? `INSERT INTO agents (id,name,color,avatar,avatar_shape,system_prompt,tools,skills,model_mode,pinned_model,created_at,updated_at)
             VALUES ($id,$name,$color,$avatar,$avatar_shape,$system_prompt,$tools,$skills,$model_mode,$pinned_model,$created_at,$updated_at)`
        : `UPDATE agents SET name=$name,color=$color,avatar=$avatar,avatar_shape=$avatar_shape,system_prompt=$system_prompt,tools=$tools,skills=$skills,
             model_mode=$model_mode,pinned_model=$pinned_model,updated_at=$updated_at WHERE id=$id AND created_at=$created_at`;
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

  createRoom(name: string, kind: "group" | "dm", agentIds: string[]): Room {
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db.query("INSERT INTO rooms VALUES (?,?,?,?)").run(id, name, kind, Date.now());
      this.setRoomAgentsTx(id, agentIds);
    })();
    return this.getRoom(id) as Room;
  }

  setRoomAgents(roomId: string, agentIds: string[]): Room {
    this.db.transaction(() => this.setRoomAgentsTx(roomId, agentIds))();
    return this.getRoom(roomId) as Room;
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
    const device = this.db
      .query("SELECT device_id FROM device_sessions WHERE room_id = ?")
      .get(r.id as string) as Row | null;
    return {
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as Room["kind"],
      agentIds,
      deviceId: (device?.device_id as string | undefined) ?? null,
      createdAt: r.created_at as number,
    };
  }

  /** Returns the device's conversation with this agent, creating it on first bind. */
  deviceRoom(deviceId: string, agent: Agent): Room {
    const existing = this.db
      .query("SELECT room_id FROM device_sessions WHERE device_id = ? AND agent_id = ?")
      .get(deviceId, agent.id) as Row | null;
    if (existing) return this.getRoom(existing.room_id as string) as Room;
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db.query("INSERT INTO rooms VALUES (?,?,?,?)").run(id, `桌面机器人 · ${agent.name}`, "dm", Date.now());
      this.db.query("INSERT INTO room_agents VALUES (?,?)").run(id, agent.id);
      this.db.query("INSERT INTO device_sessions VALUES (?,?,?,?)").run(deviceId, agent.id, id, Date.now());
    })();
    return this.getRoom(id) as Room;
  }

  // ---- messages ----
  insertMessage(m: Omit<Message, "id" | "seq" | "createdAt" | "toolCalls" | "error"> & { id?: string }): Message {
    const id = m.id ?? crypto.randomUUID();
    this.db.transaction(() => {
      const { next } = this.db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?")
        .get(m.roomId) as { next: number };
      this.db
        .query(
          `INSERT INTO messages (id, room_id, seq, run_id, hop, sender_kind, sender_id, sender_name, content, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
        );
    })();
    return this.getMessage(id) as Message;
  }

  finishMessage(
    id: string,
    patch: { content: string; status: MessageStatus; error?: string | null; toolCalls: ToolCallRecord[] },
  ): Message {
    this.db
      .query("UPDATE messages SET content = ?, status = ?, error = ?, tool_calls = ? WHERE id = ?")
      .run(patch.content, patch.status, patch.error ?? null, JSON.stringify(patch.toolCalls), id);
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

  // ---- routing ----
  saveRouting(d: Omit<RoutingDecision, "createdAt">) {
    this.db
      .query("INSERT OR REPLACE INTO routing_decisions VALUES (?,?,?,?,?)")
      .run(d.messageId, JSON.stringify(d.plan), JSON.stringify(d.attempts), d.chosenModel, Date.now());
  }

  routingFor(messageIds: string[]): RoutingDecision[] {
    if (messageIds.length === 0) return [];
    const rows = this.db
      .query(`SELECT * FROM routing_decisions WHERE message_id IN (${messageIds.map(() => "?").join(",")})`)
      .all(...messageIds) as Row[];
    return rows.map((r) => ({
      messageId: r.message_id as string,
      plan: JSON.parse(r.plan as string),
      attempts: JSON.parse(r.attempts as string),
      chosenModel: (r.chosen_model as string | null) ?? null,
      createdAt: r.created_at as number,
    }));
  }
}

function toAgent(r: Row): Agent {
  return {
    id: r.id as string,
    name: r.name as string,
    color: r.color as string,
    avatar: r.avatar as string,
    avatarShape: r.avatar_shape as AvatarShape,
    systemPrompt: r.system_prompt as string,
    tools: JSON.parse(r.tools as string),
    skills: JSON.parse(r.skills as string),
    modelMode: r.model_mode as Agent["modelMode"],
    pinnedModel: (r.pinned_model as string | null) ?? null,
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
    toolCalls: JSON.parse(r.tool_calls as string),
    createdAt: r.created_at as number,
  };
}
