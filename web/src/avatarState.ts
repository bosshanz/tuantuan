import type { Message } from "../../server/store";
import type { RoomPreview } from "../../shared/roomPreview";

/**
 * One avatar state per real agent situation. Each state is a coordinated pose (face + body motion);
 * see `docs/ui.md` "Bot 头像状态" for the table. `happy` is the short celebration after a reply
 * finishes — it is played by the avatar itself, never derived from stored data.
 */
export const EXPRESSIONS = ["idle", "thinking", "working", "speaking", "awaiting", "happy", "sad", "sleepy"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const EXPRESSION_LABEL: Record<Expression, string> = {
  idle: "待命",
  thinking: "思考",
  working: "执行工具",
  speaking: "输出中",
  awaiting: "等你确认",
  happy: "完成",
  sad: "出错",
  sleepy: "不可用",
};

/** `live` means the agent is in a run right now (the avatar animates and can celebrate when it ends). */
export interface AvatarState {
  expression: Expression;
  live: boolean;
}

type Msg = Pick<Message, "status" | "content" | "senderKind" | "senderId"> & { timeline?: Message["timeline"] };

export interface AvatarContext {
  /** The agent has a pending permission request or question for the user. */
  awaiting?: boolean;
  /** The agent is pinned to a model that is no longer available. */
  unavailable?: boolean;
}

/** A tool call of this reply is still running (the latest part is a tool that has not finished). */
export function toolRunning(m: Msg): boolean {
  const t = m.timeline;
  const last = t?.parts.at(-1);
  if (!t || last?.kind !== "tool") return false;
  const st = t.tools[last.toolCallId]?.status;
  return st === "pending" || st === "in_progress";
}

/**
 * The single derivation from an agent's latest reply (+ context) to its avatar state:
 * waiting for you > replying (tool / text / not yet) > unavailable > last reply failed > idle.
 * Cancelled or interrupted replies settle back to idle: stopping is the user's choice, not a surprise.
 */
export function avatarState(last: Msg | undefined, ctx: AvatarContext = {}): AvatarState {
  if (ctx.awaiting) return { expression: "awaiting", live: true };
  if (last?.status === "streaming") {
    if (toolRunning(last)) return { expression: "working", live: true };
    return { expression: last.content ? "speaking" : "thinking", live: true };
  }
  if (ctx.unavailable) return { expression: "sleepy", live: false };
  if (last?.status === "error") return { expression: "sad", live: false };
  return { expression: "idle", live: false };
}

/** What an agent is doing in a room right now, from the room's messages (oldest first). */
export function agentActivity(agentId: string, messages: Msg[], ctx: AvatarContext = {}): AvatarState {
  let last: Msg | undefined;
  for (let i = messages.length - 1; i >= 0 && !last; i--) {
    const m = messages[i];
    if (m?.senderKind === "agent" && m.senderId === agentId) last = m;
  }
  return avatarState(last, ctx);
}

/**
 * Sidebar state for a room, from the list snapshot only (busy flag, pending asks, latest preview).
 * Without the full timeline a busy room whose latest message is not a streaming reply is "working".
 */
export function roomAvatarState(room: {
  busy?: boolean;
  awaiting?: boolean;
  last?: Pick<RoomPreview, "status" | "text">;
}): AvatarState {
  if (room.awaiting) return { expression: "awaiting", live: true };
  if (room.busy) {
    if (room.last?.status === "streaming") return { expression: room.last.text ? "speaking" : "thinking", live: true };
    return { expression: "working", live: true };
  }
  if (room.last?.status === "error") return { expression: "sad", live: false };
  return { expression: "idle", live: false };
}
