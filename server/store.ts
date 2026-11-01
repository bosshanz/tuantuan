import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type MessageQuote, messageQuote } from "../shared/messageQuote";
import {
  MESSAGE_SEARCH_SNIPPET_LENGTH,
  type MessageSearchQuery,
  type MessageSearchResult,
} from "../shared/messageSearch";
import { messagePreview, type RoomPreview } from "../shared/roomPreview";
import { emptyTimeline, type RoomConclusion, type Timeline } from "../shared/timeline";
import { type AvatarShape, defaultAvatar, isAvatarShape } from "./avatars";
import { type CustomFormat, type CustomSecret, type Item, maskKey } from "./custom";
import { ModelCatalog } from "./model-catalog";
import type { ProviderSecret } from "./providers";
import { parseTaskContext } from "./task-context";

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
  // Working directories belong to conversations, not agents: a DM without one inherits its agent's old
  // cwd; rooms still without one get an auto-created workspace at startup (server/app.ts).
  `UPDATE rooms SET cwd = COALESCE((
     SELECT a.cwd FROM agents a JOIN room_agents ra ON ra.agent_id = a.id WHERE ra.room_id = rooms.id LIMIT 1), '')
   WHERE kind = 'dm' AND cwd = '';
   ALTER TABLE agents DROP COLUMN cwd;`,
  // BYOK「自定义」harness settings (format, base URL, model, API key) as JSON; the key never leaves the server.
  `ALTER TABLE agents ADD COLUMN custom TEXT;`,
  // Projects own the working directory; conversations (rooms) live in a project. Rooms are
  // assigned to projects at startup (server/projects.ts), which needs the file system.
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     cwd TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   ALTER TABLE rooms ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;`,
  // Preferred model per conversation member (harness session/new + setConfigOption / BYOK override).
  `CREATE TABLE room_models (
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     model TEXT NOT NULL,
     PRIMARY KEY (room_id, agent_id)
   );`,
  // Agent-level default config (model / effort / mode…) + per-conversation overrides for any option;
  // legacy DM titles "与 X 私聊" become just the agent name.
  `ALTER TABLE agents ADD COLUMN config_defaults TEXT NOT NULL DEFAULT '{}';
   CREATE TABLE room_config (
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     config_id TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (room_id, agent_id, config_id)
   );
   INSERT INTO room_config (room_id, agent_id, config_id, value) SELECT room_id, agent_id, 'model', model FROM room_models;
   UPDATE rooms SET name = substr(name, 3, length(name) - 5) WHERE name LIKE '与 % 私聊' AND length(name) > 5;`,
  // 服务商 (provider profiles) + per-agent choice; per-turn token usage reported by harnesses.
  `CREATE TABLE providers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     preset TEXT NOT NULL DEFAULT 'custom',
     anthropic_base_url TEXT NOT NULL DEFAULT '',
     openai_base_url TEXT NOT NULL DEFAULT '',
     api_key TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL DEFAULT '',
     small_model TEXT NOT NULL DEFAULT '',
     wire_api TEXT NOT NULL DEFAULT 'chat',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   ALTER TABLE agents ADD COLUMN provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL;
   CREATE TABLE usage_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     room_id TEXT,
     agent_id TEXT,
     harness TEXT NOT NULL,
     provider_id TEXT,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cached_tokens INTEGER NOT NULL DEFAULT 0,
     total_tokens INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX usage_log_at ON usage_log(at);`,
  // xAI: optional Management API key for the prepaid balance (separate from the inference key).
  `ALTER TABLE providers ADD COLUMN mgmt_key TEXT NOT NULL DEFAULT '';`,
  // Usage dashboard: model, cache read/write split, reasoning tokens, cost when the harness reports it.
  `ALTER TABLE usage_log ADD COLUMN model TEXT;
   ALTER TABLE usage_log ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE usage_log ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE usage_log ADD COLUMN thought_tokens INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE usage_log ADD COLUMN cost REAL;
   ALTER TABLE usage_log ADD COLUMN cost_currency TEXT;
   UPDATE usage_log SET cache_read_tokens = cached_tokens;`,
  // 个人资料: an agent can opt out of the user's 「关于我」 text.
  `ALTER TABLE agents ADD COLUMN use_profile INTEGER NOT NULL DEFAULT 1;`,
  // Group replies keep a bounded server-generated snapshot of the referenced message.
  `ALTER TABLE messages ADD COLUMN quote TEXT;`,
  // BYOK conversations keep their bounded context (whole turns, see server/custom.ts) in SQLite so
  // restarts continue the same conversation instead of re-deriving it from the message log.
  `CREATE TABLE custom_history (
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     turns TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (room_id, agent_id)
   );`,
  // Alias capability references only; API credentials remain in the existing secret columns.
  `ALTER TABLE providers ADD COLUMN model_catalog TEXT NOT NULL DEFAULT '{}';`,
  // Actionable failures stay visible until explicitly acknowledged, across restarts.
  `CREATE TABLE message_attention_dismissals (
     message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
     dismissed_at INTEGER NOT NULL
   );
   CREATE INDEX messages_attention_failed ON messages(created_at DESC, id DESC)
     WHERE sender_kind = 'agent' AND status IN ('error','interrupted');`,
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
  /** Extra env vars for the harness process (e.g. API keys). Never sent to the browser in full. */
  env: Record<string, string>;
  mcpServerIds: string[];
  /** "ask" shows the permission dialog; "allow" picks the agent's first allow option automatically. */
  permissionPolicy: PermissionPolicy;
  /** 服务商 profile driving this agent's harness; null = the user's own local config. */
  providerId: string | null;
  /** Default session config for new conversations (configId → value, e.g. model / effort / mode). */
  configDefaults: Record<string, string>;
  /** Add the user's 「关于我」 (个人资料) to this agent's instructions. */
  useProfile: boolean;
  /** BYOK settings when harness is "custom"; the API key is only ever exposed masked. */
  custom: CustomPublic | null;
  createdAt: number;
  updatedAt: number;
}

export interface CustomPublic {
  format: CustomFormat;
  baseUrl: string;
  model: string;
  /** Masked key, e.g. "sk-••••abcd"; "" = none saved. */
  keyHint: string;
}

/** On save: apiKey "" / omitted keeps the stored key. */
export interface CustomInput {
  format: CustomFormat;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type AgentInput = Omit<
  Agent,
  "id" | "createdAt" | "updatedAt" | "avatarShape" | "color" | "custom" | "configDefaults" | "providerId" | "useProfile"
> & {
  useProfile?: boolean;
  providerId?: string | null;
  configDefaults?: Record<string, string>;
  custom?: CustomInput | null;
  /** Omitted or "" => deterministic default from the agent id. */
  color?: string;
  avatarShape?: AvatarShape;
};

export interface Project {
  id: string;
  name: string;
  /** Working directory of every conversation in the project. */
  cwd: string;
  createdAt: number;
  /** Sidebar preview: last message (list endpoint only). sender null = the user. */
  last?: { sender: string | null; text: string; at: number };
}

/** A conversation inside a project. */
export interface UsageTally {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thought: number;
  total: number;
  cost: number | null;
  currency: string | null;
}
export interface UsageStats {
  totals: UsageTally;
  byAgent: ({ key: string | null } & UsageTally)[];
  byModel: ({ key: string | null } & UsageTally)[];
  byHarness: ({ key: string | null } & UsageTally)[];
  daily: { day: string; input: number; output: number; cache: number; total: number }[];
}

export interface Room {
  id: string;
  name: string;
  /** Derived from membership: 2+ agents behave as a group (main agent, relay, handoff). */
  kind: "group" | "dm";
  agentIds: string[];
  /** 2+ agents: who answers when nobody is @-mentioned. */
  mainAgentId: string | null;
  projectId: string | null;
  /** The project's directory (read-only here). */
  cwd: string;
  createdAt: number;
  /** Sidebar preview: last message (list endpoint only). sender null = the user. */
  last?: RoomPreview;
  /** List endpoint only: an agent chain is running in this room. */
  busy?: boolean;
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
  quote: MessageQuote | null;
  createdAt: number;
}

/** Compact persisted references; binary payloads are selected only for an exact download. */
export interface ConversationFileSource {
  key: string;
  kind: "inline" | "path" | "text";
  name: string | null;
  mimeType: string | null;
  path: string | null;
  size: number | null;
  valid: number;
  text: string | null;
  data: string | null;
}

export type ConversationFileMessage = Pick<Message, "id" | "seq" | "senderKind" | "senderName" | "createdAt">;

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

/**
 * Messages the transcript, search, sidebar and agent context may treat as real history.
 * Missing or corrupt timelines are not withdrawn. json_extract must not see invalid JSON:
 * historical rows can store non-JSON timelines, and search still has to read their body.
 */
function visibleTranscriptSql(alias = ""): string {
  const timeline = alias ? `${alias}.timeline` : "timeline";
  const sender = alias ? `${alias}.sender_kind` : "sender_kind";
  return `${sender} != 'system' AND CASE WHEN json_valid(${timeline}) THEN IFNULL(json_extract(${timeline}, '$.withdrawn'), 0) ELSE 0 END != 1`;
}

export class Store {
  readonly db: Database;
  readonly modelCatalog: ModelCatalog;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
    let cachedCatalog: unknown = null;
    try {
      cachedCatalog = this.getSetting("modelCatalog", null);
    } catch {
      cachedCatalog = {};
    } // Invalid cache is reported by ModelCatalog and falls back to the bundle.
    this.modelCatalog = new ModelCatalog(cachedCatalog, (data) => this.setSetting("modelCatalog", data));
    for (const { id } of this.db.query("SELECT id FROM agents WHERE avatar_shape = ''").all() as { id: string }[])
      this.db.query("UPDATE agents SET avatar_shape = ? WHERE id = ?").run(defaultAvatar(id).shape, id);
    // Streams cannot survive a restart: mark them so the UI does not show a forever-typing message.
    this.db
      .query("UPDATE messages SET status = 'interrupted', error = '服务重启，回复中断' WHERE status = 'streaming'")
      .run();
    // The task queue is in-memory: an accepted steer that never delivered is interrupted, not replayed.
    this.db
      .query(
        "UPDATE messages SET timeline = json_set(timeline, '$.steer.stage', 'interrupted') WHERE json_extract(timeline, '$.steer.stage') = 'stopping'",
      )
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

  /** Full BYOK settings including the key — server-side use only. */
  getCustomSecret(agentId: string): CustomSecret | null {
    const r = this.db.query("SELECT custom FROM agents WHERE id = ?").get(agentId) as Row | null;
    return r?.custom ? (JSON.parse(r.custom as string) as CustomSecret) : null;
  }

  private writeAgent(id: string, a: AgentInput, createdAt: number, updatedAt: number, op: "insert" | "update") {
    const old = op === "update" ? this.getCustomSecret(id) : null;
    const custom: CustomSecret | null = a.custom
      ? {
          format: a.custom.format,
          baseUrl: a.custom.baseUrl.trim(),
          model: a.custom.model.trim(),
          apiKey: a.custom.apiKey?.trim() || old?.apiKey || "",
        }
      : null;
    const params = {
      custom: custom ? JSON.stringify(custom) : null,
      id,
      name: a.name,
      color: a.color || defaultAvatar(id).color,
      avatar: a.avatar,
      avatar_shape: isAvatarShape(a.avatarShape) ? a.avatarShape : defaultAvatar(id).shape,
      identity: a.identity,
      harness: a.harness,
      env: JSON.stringify(a.env),
      permission_policy: a.permissionPolicy,
      mcp_server_ids: JSON.stringify(a.mcpServerIds),
      config_defaults: JSON.stringify(a.configDefaults ?? {}),
      use_profile: a.useProfile === false ? 0 : 1,
      provider_id: a.providerId || null,
      tools: "[]",
      skills: "[]",
      model_mode: "auto",
      created_at: createdAt,
      updated_at: updatedAt,
    };
    const sql =
      op === "insert"
        ? `INSERT INTO agents (id,name,color,avatar,avatar_shape,identity,harness,env,permission_policy,mcp_server_ids,config_defaults,use_profile,provider_id,tools,skills,model_mode,created_at,updated_at,custom)
             VALUES ($id,$name,$color,$avatar,$avatar_shape,$identity,$harness,$env,$permission_policy,$mcp_server_ids,$config_defaults,$use_profile,$provider_id,$tools,$skills,$model_mode,$created_at,$updated_at,$custom)`
        : `UPDATE agents SET name=$name,color=$color,avatar=$avatar,avatar_shape=$avatar_shape,identity=$identity,harness=$harness,env=$env,
             permission_policy=$permission_policy,mcp_server_ids=$mcp_server_ids,config_defaults=$config_defaults,use_profile=$use_profile,provider_id=$provider_id,custom=$custom,updated_at=$updated_at WHERE id=$id AND created_at=$created_at`;
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
    const last = new Map(this.lastPreviewRows().map((row) => [row.room_id as string, row]));
    return rooms.map((r) => {
      const room = this.toRoom(r);
      const preview = last.get(room.id);
      if (preview) room.last = this.previewFromRow(preview) ?? undefined;
      return room;
    });
  }

  /** Sidebar preview for one room, skipping system notes and messages pulled back into the composer. */
  latestPreview(roomId: string): RoomPreview | null {
    const row = this.lastPreviewRows(roomId)[0];
    return row ? this.previewFromRow(row) : null;
  }

  private previewFromRow(row: Row): RoomPreview | null {
    return messagePreview({
      id: row.id as string,
      seq: row.seq as number,
      status: row.status as MessageStatus,
      senderKind: row.sender_kind as Message["senderKind"],
      senderName: row.sender_name as string,
      content: row.content as string,
      error: row.error as string | null,
      createdAt: row.created_at as number,
      timeline: row.attachment_parts
        ? { parts: JSON.parse(row.attachment_parts as string) as { kind: string; name?: string | null }[] }
        : null,
    });
  }

  /** Last visible message per room. Withdrawn rows stay in the table so sequence numbers do not gap. */
  private lastPreviewRows(roomId?: string): Row[] {
    return this.db
      .query(
        `SELECT m.room_id, m.id, m.seq, m.status, m.sender_name, m.sender_kind, m.content, m.error, m.created_at,
           CASE WHEN trim(m.content) = '' AND json_valid(m.timeline) THEN
             (SELECT json_group_array(json_object('kind', json_extract(p.value, '$.kind'), 'name', json_extract(p.value, '$.name')))
              FROM json_each(m.timeline, '$.parts') p
              WHERE json_extract(p.value, '$.kind') IN ('file', 'image'))
           END AS attachment_parts
         FROM messages m
         JOIN (
           SELECT room_id, MAX(seq) AS seq FROM messages
           WHERE ${visibleTranscriptSql()}
           GROUP BY room_id
         ) x ON x.room_id = m.room_id AND x.seq = m.seq
         ${roomId ? "WHERE m.room_id = ?" : ""}`,
      )
      .all(...(roomId ? [roomId] : [])) as Row[];
  }

  getRoom(id: string): Room | null {
    const row = this.db.query("SELECT * FROM rooms WHERE id = ?").get(id) as Row | null;
    return row ? this.toRoom(row) : null;
  }

  createRoom(
    name: string,
    agentIds: string[],
    opts: { mainAgentId?: string | null; projectId?: string | null } = {},
  ): Room {
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO rooms (id, name, kind, created_at, cwd, project_id) VALUES (?,?,?,?,?,?)")
        .run(id, name, kindFor(agentIds), Date.now(), "", opts.projectId ?? null);
      this.setRoomAgentsTx(id, agentIds);
      this.setMainTx(id, opts.mainAgentId ?? null);
    })();
    return this.getRoom(id) as Room;
  }

  setRoomAgents(roomId: string, agentIds: string[]): Room {
    this.db.transaction(() => {
      this.setRoomAgentsTx(roomId, agentIds);
      this.db.query("UPDATE rooms SET kind = ? WHERE id = ?").run(kindFor(agentIds), roomId);
      this.setMainTx(roomId, this.getRoom(roomId)?.mainAgentId ?? null);
    })();
    return this.getRoom(roomId) as Room;
  }

  /** Conversation settings. The main agent must be a member; it falls back to the first member. */
  updateRoom(roomId: string, patch: { mainAgentId?: string | null; name?: string; projectId?: string }): Room {
    this.db.transaction(() => {
      if (patch.name !== undefined) this.db.query("UPDATE rooms SET name = ? WHERE id = ?").run(patch.name, roomId);
      if (patch.projectId !== undefined && patch.projectId !== this.getRoom(roomId)?.projectId) {
        // Another project = another directory: harness sessions belong to the old one.
        this.db.query("UPDATE rooms SET project_id = ? WHERE id = ?").run(patch.projectId, roomId);
        this.db.query("DELETE FROM acp_sessions WHERE room_id = ?").run(roomId);
      }
      if (patch.mainAgentId !== undefined) this.setMainTx(roomId, patch.mainAgentId);
    })();
    return this.getRoom(roomId) as Room;
  }

  /** Migration only: attach to a project keeping harness sessions (same directory). */
  assignProject(roomId: string, projectId: string) {
    this.db.query("UPDATE rooms SET project_id = ? WHERE id = ?").run(projectId, roomId);
  }

  /** Legacy per-room directory (before projects); used once by the project migration. */
  legacyRoomCwd(roomId: string): string {
    return ((this.db.query("SELECT cwd FROM rooms WHERE id = ?").get(roomId) as Row | null)?.cwd as string) ?? "";
  }

  // ---- projects ----
  listProjects(): Project[] {
    return (this.db.query("SELECT * FROM projects ORDER BY created_at, name").all() as Row[]).map(toProject);
  }

  getProject(id: string): Project | null {
    const r = this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as Row | null;
    return r ? toProject(r) : null;
  }

  createProject(name: string, cwd: string, id: string = crypto.randomUUID()): Project {
    this.db.query("INSERT INTO projects (id, name, cwd, created_at) VALUES (?,?,?,?)").run(id, name, cwd, Date.now());
    return this.getProject(id) as Project;
  }

  /** Changing the directory forgets the harness sessions of every conversation in the project. */
  updateProject(id: string, patch: { name?: string; cwd?: string }): Project {
    const p = this.getProject(id);
    if (!p) throw new ValidationError("项目不存在", 404);
    this.db.transaction(() => {
      if (patch.name !== undefined) this.db.query("UPDATE projects SET name = ? WHERE id = ?").run(patch.name, id);
      if (patch.cwd !== undefined && patch.cwd !== p.cwd) {
        this.db.query("UPDATE projects SET cwd = ? WHERE id = ?").run(patch.cwd, id);
        this.db.query("DELETE FROM acp_sessions WHERE room_id IN (SELECT id FROM rooms WHERE project_id = ?)").run(id);
      }
    })();
    return this.getProject(id) as Project;
  }

  /** Deletes the project and its conversations (the folder on disk is left alone). */
  deleteProject(id: string): boolean {
    return this.db.transaction(() => {
      this.db.query("DELETE FROM rooms WHERE project_id = ?").run(id);
      return this.db.query("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
    })();
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
      projectId: (r.project_id as string | null) ?? null,
      cwd: r.project_id ? (this.getProject(r.project_id as string)?.cwd ?? "") : "",
      createdAt: r.created_at as number,
    };
  }

  // ---- messages ----
  insertMessage(
    m: Omit<Message, "id" | "seq" | "createdAt" | "timeline" | "error" | "quote"> & {
      id?: string;
      initialTimeline?: Timeline;
      replyToId?: string | null;
      replyToPartIndex?: number;
    },
  ): Message {
    const id = m.id ?? crypto.randomUUID();
    this.db.transaction(() => {
      let quote: MessageQuote | null = null;
      if (
        m.replyToPartIndex !== undefined &&
        (!Number.isSafeInteger(m.replyToPartIndex) || m.replyToPartIndex < 0 || !m.replyToId)
      )
        throw new ValidationError("引用阶段必须是非负安全整数，并指定引用消息");
      if (m.replyToId) {
        // Human quotes are also created by retry, which must reference the original request in a DM too.
        if (m.senderKind !== "human") throw new ValidationError("只有用户消息可以引用回复");
        const original = this.getMessage(m.replyToId);
        if (!original || original.roomId !== m.roomId) throw new ValidationError("引用消息不存在或不在当前会话");
        quote = messageQuote(original, m.replyToPartIndex);
        if (!quote)
          throw new ValidationError(
            m.replyToPartIndex === undefined
              ? "只能引用已完成的用户或 Agent 消息"
              : "只能引用已完成 Agent 消息的有效正文阶段",
          );
      }
      const { next } = this.db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?")
        .get(m.roomId) as { next: number };
      this.db
        .query(
          `INSERT INTO messages (id, room_id, seq, run_id, hop, sender_kind, sender_id, sender_name, content, status, created_at, timeline, quote)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          m.senderKind === "agent" ? JSON.stringify(m.initialTimeline ?? emptyTimeline()) : null,
          quote ? JSON.stringify(quote) : null,
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

  /**
   * Finished Agent replies that contain at least one completed edit tool,
   * including replies that failed, were cancelled, or were interrupted.
   * Timelines are loaded so callers can extract paths and diffs; listing UIs should
   * not put every diff on the wire without an explicit detail request.
   */
  agentEditMessages(roomId: string): Message[] {
    const rows = this.db
      .query(
        `SELECT * FROM messages m
         WHERE room_id = ? AND sender_kind = 'agent' AND status IN ('done','error','cancelled','interrupted') AND timeline IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM json_each(CASE WHEN json_valid(timeline) THEN timeline ELSE '{}' END, '$.tools') t
             WHERE t.type = 'object' AND json_extract(t.value, '$.status') = 'completed'
               AND json_extract(t.value, '$.kind') = 'edit'
               AND (json_array_length(t.value, '$.locations') > 0 OR EXISTS (
                 SELECT 1 FROM json_each(t.value, '$.content') c
                 WHERE c.type = 'object' AND json_extract(c.value, '$.type') = 'diff')))
         ORDER BY seq`,
      )
      .all(roomId) as Row[];
    return rows.map(toMessage);
  }

  /** One persisted message at a time keeps attachment blobs out of file-list memory. */
  conversationFileMessage(roomId: string, beforeSeq = Number.MAX_SAFE_INTEGER): ConversationFileMessage | null {
    const row = this.db
      .query(
        `SELECT id, seq, sender_kind, sender_name, created_at FROM messages m
         WHERE room_id = ? AND seq <= ? AND sender_kind IN ('human', 'agent') AND status != 'streaming'
           AND ((sender_kind = 'agent' AND instr(content, '](') > 0)
             OR EXISTS (
               SELECT 1 FROM json_each(CASE WHEN json_valid(timeline) THEN timeline ELSE '{}' END, '$.parts') p
               WHERE p.type = 'object' AND json_extract(p.value, '$.kind') IN ('file', 'image'))
             OR (sender_kind = 'agent' AND EXISTS (
               SELECT 1 FROM json_each(CASE WHEN json_valid(timeline) THEN timeline ELSE '{}' END, '$.tools') t
               WHERE t.type = 'object' AND json_extract(t.value, '$.status') = 'completed'
                 AND json_extract(t.value, '$.kind') != 'read'
                 AND ((json_extract(t.value, '$.kind') = 'edit' AND
                       (json_array_length(t.value, '$.locations') > 0 OR EXISTS (
                         SELECT 1 FROM json_each(t.value, '$.content') c WHERE c.type = 'object' AND json_extract(c.value, '$.type') = 'diff')))
                   OR EXISTS (SELECT 1 FROM json_each(t.value, '$.content') c
                     WHERE c.type = 'object' AND json_extract(c.value, '$.type') = 'content'
                       AND json_extract(c.value, '$.content.type') IN ('resource_link', 'image'))))))
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(roomId, beforeSeq) as Row | null;
    return row
      ? {
          id: row.id as string,
          seq: row.seq as number,
          senderKind: row.sender_kind as "human" | "agent",
          senderName: row.sender_name as string,
          createdAt: row.created_at as number,
        }
      : null;
  }

  /**
   * SQLite projects only file metadata and visible message bodies. JSON data, thoughts,
   * tool inputs, read results and diff bodies never leave SQLite during listing.
   * `exactKey` is a persisted reference coordinate, never a filesystem path or JSON path.
   */
  conversationFileSources(
    roomId: string,
    messageId: string,
    afterKey: string,
    limit: number,
    exactKey: string | null = null,
    includeData = false,
    dataMaxBytes = 20 * 1024 * 1024,
  ): ConversationFileSource[] {
    return this.db
      .query(
        `WITH message AS MATERIALIZED (
           SELECT content, sender_kind,
                  CASE WHEN json_valid(timeline) THEN timeline ELSE '{}' END AS timeline
           FROM messages WHERE room_id = ? AND id = ? AND sender_kind IN ('human', 'agent') AND status != 'streaming'
         ), tools AS MATERIALIZED (
           SELECT t.key, t.value FROM message, json_each(message.timeline, '$.tools') t
           WHERE t.type = 'object' AND message.sender_kind = 'agent' AND json_extract(t.value, '$.status') = 'completed'
             AND json_extract(t.value, '$.kind') != 'read'
         ), sources AS (
           SELECT 'p:' || printf('%012d', p.key) AS key, 'inline' AS kind,
                  json_extract(p.value, '$.name') AS name, json_extract(p.value, '$.mimeType') AS mimeType,
                  NULL AS path, json_extract(p.value, '$.data') AS payload, NULL AS text
           FROM message, json_each(message.timeline, '$.parts') p
           WHERE p.type = 'object' AND json_extract(p.value, '$.kind') IN ('file', 'image')
           UNION ALL
           SELECT 'b:000000000000', 'text', NULL, NULL, NULL, NULL, message.content
           FROM message WHERE sender_kind = 'agent' AND instr(content, '](') > 0
           UNION ALL
           SELECT 't:' || hex(t.key) || ':l:' || printf('%012d', l.key), 'path', NULL, NULL,
                  json_extract(l.value, '$.path'), NULL, NULL
           FROM tools t, json_each(t.value, '$.locations') l WHERE l.type = 'object' AND json_extract(t.value, '$.kind') = 'edit'
           UNION ALL
           SELECT 't:' || hex(t.key) || ':c:' || printf('%012d', c.key),
                  CASE WHEN json_extract(c.value, '$.content.type') = 'image' THEN 'inline' ELSE 'path' END,
                  json_extract(c.value, '$.content.name'), json_extract(c.value, '$.content.mimeType'),
                  CASE WHEN json_extract(c.value, '$.type') = 'diff' THEN json_extract(c.value, '$.path')
                       ELSE json_extract(c.value, '$.content.uri') END,
                  CASE WHEN json_extract(c.value, '$.content.type') = 'image' THEN json_extract(c.value, '$.content.data') END,
                  NULL
           FROM tools t, json_each(t.value, '$.content') c
           WHERE c.type = 'object' AND ((json_extract(c.value, '$.type') = 'diff' AND json_extract(t.value, '$.kind') = 'edit')
              OR (json_extract(c.value, '$.type') = 'content' AND json_extract(c.value, '$.content.type') IN ('resource_link', 'image')))
         )
         SELECT key, kind, name, mimeType, path,
                CASE WHEN typeof(payload) = 'text' THEN length(payload) / 4 * 3 -
                     CASE WHEN substr(payload, -2) = '==' THEN 2 WHEN substr(payload, -1) = '=' THEN 1 ELSE 0 END END AS size,
                CASE WHEN typeof(payload) = 'text' AND length(payload) <= 27962028
                          AND length(payload) % 4 = 0 AND payload NOT GLOB '*[^A-Za-z0-9+/=]*'
                          AND instr(rtrim(payload, '='), '=') = 0
                          AND length(payload) - length(rtrim(payload, '=')) <= 2
                          AND (substr(payload, -2) != '==' OR instr('AQgw', substr(payload, -3, 1)) > 0)
                          AND (substr(payload, -1) != '=' OR substr(payload, -2) = '=='
                               OR instr('AEIMQUYcgkosw048', substr(payload, -2, 1)) > 0)
                     THEN 1 ELSE 0 END AS valid,
                text,
                CASE WHEN ? AND length(payload) <= ? THEN payload ELSE NULL END AS data
         FROM sources s WHERE (? IS NULL AND key > ?) OR key = ? ORDER BY key LIMIT ?`,
      )
      .all(
        roomId,
        messageId,
        includeData ? 1 : 0,
        Math.ceil(dataMaxBytes / 3) * 4,
        exactKey,
        afterKey,
        exactKey,
        limit,
      ) as ConversationFileSource[];
  }

  /** Search the complete persisted body column, returning only a bounded excerpt and source metadata. */
  searchMessages({ query, roomId, limit, before }: MessageSearchQuery): MessageSearchResult[] {
    const rows = this.db
      .query(
        `WITH page AS MATERIALIZED (
           SELECT m.id FROM messages m
           WHERE ${visibleTranscriptSql("m")} AND m.status != 'streaming'
             AND instr(lower(m.content), lower(?)) > 0
             ${roomId ? "AND m.room_id = ?" : ""}
             ${before ? "AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))" : ""}
           ORDER BY m.created_at DESC, m.id DESC LIMIT ?
         ), matches AS (
           SELECT m.id, m.room_id, r.name AS room_name, p.name AS project_name,
                  m.sender_name, m.sender_kind, m.created_at, m.seq, m.content,
                  instr(lower(m.content), lower(?)) AS match_at
           FROM page JOIN messages m ON m.id = page.id
           JOIN rooms r ON r.id = m.room_id
           LEFT JOIN projects p ON p.id = r.project_id
         )
         SELECT id, room_id, room_name, project_name, sender_name, sender_kind, created_at, seq,
                CASE WHEN match_at > 71 THEN '…' ELSE '' END ||
                substr(content, max(1, match_at - 70), ?) ||
                CASE WHEN length(content) >= max(1, match_at - 70) + ? THEN '…' ELSE '' END AS snippet
         FROM matches ORDER BY created_at DESC, id DESC`,
      )
      .all(
        query,
        ...(roomId ? [roomId] : []),
        ...(before ? [before.createdAt, before.createdAt, before.messageId] : []),
        limit,
        query,
        MESSAGE_SEARCH_SNIPPET_LENGTH,
        MESSAGE_SEARCH_SNIPPET_LENGTH,
      ) as Row[];
    return rows.map((row) => ({
      messageId: row.id as string,
      roomId: row.room_id as string,
      roomName: row.room_name as string,
      projectName: row.project_name as string | null,
      senderName: row.sender_name as string,
      senderKind: row.sender_kind as MessageSearchResult["senderKind"],
      createdAt: row.created_at as number,
      seq: row.seq as number,
      snippet: row.snippet as string,
    }));
  }

  /** Stream persisted user attachments for exact-file read grants when a Harness process is rebuilt. */
  *humanAttachmentMessages(roomId: string): Generator<Message> {
    const statement = this.db.prepare(
      "SELECT * FROM messages WHERE room_id = ? AND sender_kind = 'human' AND status = 'done' AND timeline IS NOT NULL ORDER BY seq",
    );
    // A failed attachment check can close this generator early. Never leave a partially consumed
    // bound iterator in Database.query's statement cache, or the next recovery may resume it.
    try {
      for (const row of statement.iterate(roomId)) yield toMessage(row as Row);
    } finally {
      statement.finalize();
    }
  }

  /**
   * The newest accepted task note from a root task or a coordinator follow-up. Member hand-off
   * replies are deliberately skipped: their notes stay on their own messages.
   */
  latestConclusion(roomId: string): RoomConclusion | null {
    const rows = this.db
      .query(
        `SELECT * FROM messages
         WHERE room_id = ? AND sender_kind = 'agent' AND status = 'done'
           AND timeline LIKE '%"taskContext"%'
           AND (hop = 1 OR timeline LIKE '%"reviewOf"%')
         ORDER BY seq DESC`,
      )
      .all(roomId) as Row[];
    for (const row of rows) {
      const message = toMessage(row);
      if (message.hop !== 1 && !message.timeline?.reviewOf?.length) continue;
      try {
        const context = parseTaskContext(message.timeline?.taskContext);
        return { messageId: message.id, seq: message.seq, context };
      } catch {
        // A malformed legacy note must not hide an older valid conclusion.
      }
    }
    return null;
  }

  /** Query this request before applying any relay budget, so unrelated runs cannot displace it. */
  runMessages(roomId: string, runId: string): Message[] {
    return (
      this.db.query("SELECT * FROM messages WHERE room_id = ? AND run_id = ? ORDER BY seq").all(roomId, runId) as Row[]
    ).map(toMessage);
  }

  /** Historical messages visible at this request, plus settled replies from its own run. */
  contextMessages(roomId: string, runId: string, throughSeq: number, limit: number, beforeSeq?: number): Message[] {
    const rows = this.db
      .query(
        `SELECT * FROM messages WHERE room_id = ? AND seq < ? AND (seq <= ? OR run_id = ?)
         AND ${visibleTranscriptSql()} AND status != 'streaming' ORDER BY seq DESC LIMIT ?`,
      )
      .all(roomId, beforeSeq ?? Number.MAX_SAFE_INTEGER, throughSeq, runId, limit) as Row[];
    return rows.reverse().map(toMessage);
  }

  // ---- Preferred model per (room, agent) ----
  getRoomModel(roomId: string, agentId: string): string | null {
    return this.getRoomConfig(roomId, agentId).model ?? null;
  }

  setRoomModel(roomId: string, agentId: string, model: string) {
    this.setRoomConfig(roomId, agentId, "model", model);
  }

  /** Conversation-level overrides of an agent's session config (configId → value). */
  getRoomConfig(roomId: string, agentId: string): Record<string, string> {
    const rows = this.db
      .query("SELECT config_id, value FROM room_config WHERE room_id = ? AND agent_id = ?")
      .all(roomId, agentId) as Row[];
    return Object.fromEntries(rows.map((r) => [r.config_id as string, r.value as string]));
  }

  setRoomConfig(roomId: string, agentId: string, configId: string, value: string | null) {
    if (value === null)
      this.db
        .query("DELETE FROM room_config WHERE room_id = ? AND agent_id = ? AND config_id = ?")
        .run(roomId, agentId, configId);
    else
      this.db
        .query(
          `INSERT INTO room_config (room_id, agent_id, config_id, value) VALUES (?,?,?,?)
           ON CONFLICT(room_id, agent_id, config_id) DO UPDATE SET value = excluded.value`,
        )
        .run(roomId, agentId, configId, value);
  }

  // ---- 服务商 ----
  listProviders(): ProviderSecret[] {
    return (this.db.query("SELECT * FROM providers ORDER BY created_at").all() as Row[]).map((row) =>
      this.modelCatalog.capture(toProvider(row)),
    );
  }

  getProvider(id: string): ProviderSecret | null {
    const r = this.db.query("SELECT * FROM providers WHERE id = ?").get(id) as Row | null;
    return r ? this.modelCatalog.capture(toProvider(r)) : null;
  }

  saveProvider(
    input: Omit<ProviderSecret, "id" | "createdAt" | "updatedAt" | "mgmtKey"> & { id?: string; mgmtKey?: string },
  ): ProviderSecret {
    const now = Date.now();
    const old = input.id ? this.getProvider(input.id) : null;
    const id = old?.id ?? input.id ?? crypto.randomUUID();
    const row = {
      id,
      name: input.name,
      preset: input.preset,
      anthropic_base_url: input.anthropicBaseUrl,
      openai_base_url: input.openaiBaseUrl,
      // empty key on edit = keep the stored one (the browser only ever sees a mask)
      api_key: input.apiKey || old?.apiKey || "",
      mgmt_key: input.mgmtKey || old?.mgmtKey || "",
      model: input.model,
      small_model: input.smallModel,
      wire_api: input.wireApi,
      model_catalog: JSON.stringify(input.modelCatalog ?? old?.modelCatalog ?? {}),
      created_at: old?.createdAt ?? now,
      updated_at: Math.max(now, (old?.updatedAt ?? 0) + 1),
    };
    this.db
      .query(
        `INSERT INTO providers (id,name,preset,anthropic_base_url,openai_base_url,api_key,mgmt_key,model,small_model,wire_api,model_catalog,created_at,updated_at)
         VALUES ($id,$name,$preset,$anthropic_base_url,$openai_base_url,$api_key,$mgmt_key,$model,$small_model,$wire_api,$model_catalog,$created_at,$updated_at)
         ON CONFLICT(id) DO UPDATE SET name=$name,preset=$preset,anthropic_base_url=$anthropic_base_url,openai_base_url=$openai_base_url,
           api_key=$api_key,mgmt_key=$mgmt_key,model=$model,small_model=$small_model,wire_api=$wire_api,model_catalog=$model_catalog,updated_at=$updated_at`,
      )
      .run(row);
    return this.getProvider(id) as ProviderSecret;
  }

  deleteProvider(id: string) {
    this.db.query("UPDATE agents SET provider_id = NULL WHERE provider_id = ?").run(id);
    this.db.query("DELETE FROM providers WHERE id = ?").run(id);
  }

  // ---- token usage reported by harnesses (ACP PromptResponse.usage) ----
  logUsage(u: {
    roomId: string | null;
    agentId: string | null;
    harness: string;
    providerId: string | null;
    model?: string | null;
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** Old callers: cache read + write combined. */
    cached?: number;
    thought?: number;
    total: number;
    cost?: number | null;
    currency?: string | null;
    at?: number;
  }) {
    const read = u.cacheRead ?? u.cached ?? 0;
    const write = u.cacheWrite ?? 0;
    this.db
      .query(
        `INSERT INTO usage_log (at, room_id, agent_id, harness, provider_id, model, input_tokens, output_tokens,
           cached_tokens, cache_read_tokens, cache_write_tokens, thought_tokens, total_tokens, cost, cost_currency)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        u.at ?? Date.now(),
        u.roomId,
        u.agentId,
        u.harness,
        u.providerId,
        u.model ?? null,
        u.input,
        u.output,
        read + write,
        read,
        write,
        u.thought ?? 0,
        u.total,
        u.cost ?? null,
        u.currency ?? null,
      );
  }

  usageHarnesses(): string[] {
    return (this.db.query("SELECT DISTINCT harness FROM usage_log").all() as Row[]).map((r) => r.harness as string);
  }

  /** Dashboard aggregation since `since` (ms). `tzOffsetMin` buckets days in the viewer's zone. */
  usageStats(since: number, tzOffsetMin = 0): UsageStats {
    const sums = `COUNT(*) AS turns, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
      SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(thought_tokens) AS thought,
      SUM(total_tokens) AS total, SUM(cost) AS cost, MAX(cost_currency) AS currency, COUNT(cost) AS costed`;
    const tally = (r: Row): UsageTally => ({
      turns: Number(r.turns ?? 0),
      input: Number(r.input ?? 0),
      output: Number(r.output ?? 0),
      cacheRead: Number(r.cache_read ?? 0),
      cacheWrite: Number(r.cache_write ?? 0),
      thought: Number(r.thought ?? 0),
      total: Number(r.total ?? 0),
      cost: Number(r.costed ?? 0) > 0 ? Number(r.cost ?? 0) : null,
      currency: (r.currency as string | null) ?? null,
    });
    const group = (col: string) =>
      (
        this.db
          .query(`SELECT ${col} AS k, ${sums} FROM usage_log WHERE at >= ? GROUP BY ${col} ORDER BY total DESC`)
          .all(since) as Row[]
      ).map((r) => ({ key: (r.k as string | null) ?? null, ...tally(r) }));
    const shift = tzOffsetMin * 60_000;
    const daily = (
      this.db
        .query(
          `SELECT ((at + ?) / 86400000) AS d, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
             SUM(cache_read_tokens) + SUM(cache_write_tokens) AS cache, SUM(total_tokens) AS total
           FROM usage_log WHERE at >= ? GROUP BY d ORDER BY d`,
        )
        .all(shift, since) as Row[]
    ).map((r) => ({
      day: new Date(Number(r.d) * 86_400_000).toISOString().slice(0, 10),
      input: Number(r.input ?? 0),
      output: Number(r.output ?? 0),
      cache: Number(r.cache ?? 0),
      total: Number(r.total ?? 0),
    }));
    return {
      totals: tally(this.db.query(`SELECT ${sums} FROM usage_log WHERE at >= ?`).get(since) as Row),
      byAgent: group("agent_id"),
      byModel: group("model"),
      byHarness: group("harness"),
      daily,
    };
  }

  /** Room-scoped usage aggregation. Cost stays null when no turn reported a cost. */
  usageForRoom(roomId: string): UsageTally & { reporting: boolean } {
    const sums = `COUNT(*) AS turns, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
      SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(thought_tokens) AS thought,
      SUM(total_tokens) AS total, SUM(cost) AS cost, MAX(cost_currency) AS currency, COUNT(cost) AS costed`;
    const r = this.db.query(`SELECT ${sums} FROM usage_log WHERE room_id = ?`).get(roomId) as Row;
    const turns = Number(r?.turns ?? 0);
    return {
      turns,
      input: Number(r?.input ?? 0),
      output: Number(r?.output ?? 0),
      cacheRead: Number(r?.cache_read ?? 0),
      cacheWrite: Number(r?.cache_write ?? 0),
      thought: Number(r?.thought ?? 0),
      total: Number(r?.total ?? 0),
      cost: Number(r?.costed ?? 0) > 0 ? Number(r?.cost ?? 0) : null,
      currency: (r?.currency as string | null) ?? null,
      reporting: turns > 0,
    };
  }

  usageSince(
    since: number,
  ): { harness: string; providerId: string | null; turns: number; input: number; output: number; total: number }[] {
    return (
      this.db
        .query(
          `SELECT harness, provider_id, COUNT(*) AS turns, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(total_tokens) AS total
           FROM usage_log WHERE at >= ? GROUP BY harness, provider_id`,
        )
        .all(since) as Row[]
    ).map((r) => ({
      harness: r.harness as string,
      providerId: (r.provider_id as string | null) ?? null,
      turns: Number(r.turns),
      input: Number(r.input),
      output: Number(r.output),
      total: Number(r.total),
    }));
  }

  // ---- BYOK conversation context (bounded, whole turns; null = never initialized, [] = cleared) ----
  getCustomHistory(roomId: string, agentId: string): Item[][] | null {
    const r = this.db
      .query("SELECT turns FROM custom_history WHERE room_id = ? AND agent_id = ?")
      .get(roomId, agentId) as Row | null;
    return r ? (JSON.parse(r.turns as string) as Item[][]) : null;
  }

  setCustomHistory(roomId: string, agentId: string, turns: Item[][]) {
    this.db
      .query("INSERT OR REPLACE INTO custom_history VALUES (?,?,?,?)")
      .run(roomId, agentId, JSON.stringify(turns), Date.now());
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

const kindFor = (agentIds: string[]): Room["kind"] => (new Set(agentIds).size > 1 ? "group" : "dm");

function toProject(r: Row): Project {
  return { id: r.id as string, name: r.name as string, cwd: r.cwd as string, createdAt: r.created_at as number };
}

function publicCustom(c: CustomSecret): CustomPublic {
  return { format: c.format, baseUrl: c.baseUrl, model: c.model, keyHint: maskKey(c.apiKey) };
}

function toProvider(r: Row): ProviderSecret {
  return {
    id: r.id as string,
    name: r.name as string,
    preset: r.preset as string,
    anthropicBaseUrl: r.anthropic_base_url as string,
    openaiBaseUrl: r.openai_base_url as string,
    apiKey: r.api_key as string,
    mgmtKey: (r.mgmt_key as string) ?? "",
    model: r.model as string,
    smallModel: r.small_model as string,
    wireApi: (r.wire_api as string) === "responses" ? "responses" : "chat",
    modelCatalog: JSON.parse((r.model_catalog as string) || "{}"),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
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
    env: JSON.parse(r.env as string),
    mcpServerIds: JSON.parse(r.mcp_server_ids as string),
    configDefaults: JSON.parse((r.config_defaults as string) || "{}"),
    useProfile: r.use_profile !== 0,
    providerId: (r.provider_id as string | null) ?? null,
    permissionPolicy: r.permission_policy as PermissionPolicy,
    custom: r.custom ? publicCustom(JSON.parse(r.custom as string)) : null,
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
    quote: r.quote ? (JSON.parse(r.quote as string) as MessageQuote) : null,
    createdAt: r.created_at as number,
  };
}
