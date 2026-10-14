import type { Message } from "../../server/store";

export const EXPRESSIONS = ["idle", "happy", "thinking", "speaking", "surprised", "sad", "sleepy"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const EXPRESSION_LABEL: Record<Expression, string> = {
  idle: "平静",
  happy: "开心",
  thinking: "思考",
  speaking: "说话",
  surprised: "惊讶",
  sad: "难过",
  sleepy: "休眠",
};

type Msg = Pick<Message, "status" | "content" | "senderKind" | "senderId">;

/** Expression for the avatar next to one reply. Only a reply in flight is "live" (animated). */
export function messageExpression(m: Msg): { expression: Expression; live: boolean } {
  if (m.status === "streaming") return { expression: m.content ? "speaking" : "thinking", live: true };
  if (m.status === "error") return { expression: "sad", live: false };
  return { expression: "idle", live: false };
}

/**
 * What an agent is doing in a room right now, from its messages (oldest first):
 * replying > its last reply failed > it was cut off > unavailable (pinned to an inactive model) > idle.
 */
export function agentActivity(agentId: string, messages: Msg[], opts: { unavailable?: boolean } = {}): Expression {
  const own = messages.filter((m) => m.senderKind === "agent" && m.senderId === agentId);
  const last = own.at(-1);
  if (last?.status === "streaming") return last.content ? "speaking" : "thinking";
  if (opts.unavailable) return "sleepy";
  if (last?.status === "error") return "sad";
  if (last?.status === "cancelled" || last?.status === "interrupted") return "surprised";
  return "idle";
}
