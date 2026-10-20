import {
  type AttentionFailure,
  type AttentionRequest,
  type AttentionSnapshot,
  attentionFailureKind,
} from "../shared/attention";
import { preview } from "../shared/notify";
import type { HarnessHost } from "./host";
import { type Store, ValidationError } from "./store";

const FAILED = "m.sender_kind = 'agent' AND m.status IN ('error','interrupted') AND d.message_id IS NULL";

interface FailureRow {
  id: string;
  room_id: string;
  room_name: string;
  project_id: string | null;
  project_name: string | null;
  sender_id: string | null;
  sender_name: string;
  status: string;
  error: string | null;
  created_at: number;
}

function readCursor(value: string | null | undefined): { at: number; id: string } | null {
  if (value == null) return null;
  try {
    if (!value || value.length > 1024) throw new Error("cursor");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Number.isSafeInteger(parsed.at) || parsed.at < 0 || typeof parsed.id !== "string" || !parsed.id)
      throw new Error("cursor");
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new ValidationError("待办分页位置无效，请刷新列表");
  }
}

/** Live requests belong to Host; only the explicit dismissal of a persisted failed message is stored here. */
export class AttentionService {
  constructor(
    private store: Store,
    private host: Pick<HarnessHost, "pendingAsks" | "pendingElicitations">,
  ) {}

  list(options: { cursor?: string | null; limit?: number } = {}): AttentionSnapshot {
    const cursor = readCursor(options.cursor);
    const limit = options.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new ValidationError("待办每页数量必须为 1 到 50");
    const active: AttentionRequest[] = [];
    const agents = new Map(
      (this.store.db.query("SELECT id, name FROM agents").all() as { id: string; name: string }[]).map((agent) => [
        agent.id,
        agent.name,
      ]),
    );
    const rooms = this.store.db
      .query(
        `SELECT r.id, r.name, r.project_id, p.name AS project_name FROM rooms r
         LEFT JOIN projects p ON p.id = r.project_id ORDER BY r.created_at, r.id`,
      )
      .all() as { id: string; name: string; project_id: string | null; project_name: string | null }[];
    for (const room of rooms) {
      const base = {
        roomId: room.id,
        roomName: room.name,
        projectId: room.project_id,
        projectName: room.project_name,
        createdAt: null,
      };
      for (const ask of this.host.pendingAsks(room.id))
        active.push({
          ...base,
          id: `permission:${ask.id}`,
          kind: "permission",
          askId: ask.id,
          agentId: ask.agentId,
          agentName: agents.get(ask.agentId) ?? "Agent 已删除",
          // Tool titles, commands and rawInput may contain secrets. Details are available only in the room.
          reason: "有工具操作等待你的批准",
        });
      for (const ask of this.host.pendingElicitations(room.id))
        active.push({
          ...base,
          id: `question:${ask.id}`,
          kind: "question",
          askId: ask.id,
          agentId: ask.agentId,
          agentName: agents.get(ask.agentId) ?? "Agent 已删除",
          reason: "Agent 有问题等待你回答",
        });
    }
    const { count } = this.store.db
      .query(
        `SELECT COUNT(*) AS count FROM messages m LEFT JOIN message_attention_dismissals d ON d.message_id = m.id WHERE ${FAILED}`,
      )
      .get() as { count: number };
    const rows = this.store.db
      .query(
        `SELECT m.id, m.room_id, r.name AS room_name, r.project_id, p.name AS project_name,
           m.sender_id, m.sender_name, m.status, m.error, m.created_at
         FROM messages m JOIN rooms r ON r.id = m.room_id LEFT JOIN projects p ON p.id = r.project_id
         LEFT JOIN message_attention_dismissals d ON d.message_id = m.id
         WHERE ${FAILED}${cursor ? " AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))" : ""}
         ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      )
      .all(...(cursor ? [cursor.at, cursor.at, cursor.id, limit + 1] : [limit + 1])) as FailureRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const failures: AttentionFailure[] = page.map((row) => ({
      id: `message:${row.id}`,
      kind: attentionFailureKind({ status: row.status, error: row.error }),
      messageId: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      roomId: row.room_id,
      roomName: row.room_name,
      agentId: row.sender_id,
      agentName: row.sender_name,
      reason: preview(row.error ?? (row.status === "interrupted" ? "回复中断" : "出错了"), 180),
      createdAt: row.created_at,
    }));
    return {
      active,
      failures,
      totalCount: active.length + count,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString("base64url")
          : null,
    };
  }

  dismiss(messageId: string): { ok: true } {
    this.store.db.transaction(() => {
      const message = this.store.db.query("SELECT sender_kind, status FROM messages WHERE id = ?").get(messageId) as {
        sender_kind: string;
        status: string;
      } | null;
      if (!message) throw new ValidationError("待办消息不存在", 404);
      if (message.sender_kind !== "agent" || !["error", "interrupted"].includes(message.status))
        throw new ValidationError("只有失败或中断的 Agent 消息可以标为已处理");
      this.store.db
        .query("INSERT OR IGNORE INTO message_attention_dismissals (message_id, dismissed_at) VALUES (?, ?)")
        .run(messageId, Date.now());
    })();
    return { ok: true };
  }
}
