import type * as acp from "@agentclientprotocol/sdk";

/**
 * What one agent reply looks like, folded from ACP session/update notifications. The server
 * persists it with the message; the browser applies the same updates live, so both sides use this
 * one reducer and never disagree about ordering.
 */
export type TimelinePart =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; toolCallId: string }
  | { kind: "image"; mimeType: string; data: string };

export interface ToolState {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  content: acp.ToolCallContent[];
  locations: { path: string; line?: number | null }[];
  rawInput?: unknown;
}

export interface Timeline {
  parts: TimelinePart[];
  tools: Record<string, ToolState>;
  plan: acp.PlanEntry[] | null;
  stopReason?: string | null;
  /** Hand-offs this reply made through Tuantuan's `handoff` MCP tool (group chats). */
  handoffs?: Handoff[];
  /** Set on a reply that was triggered by another agent's hand-off. */
  handoffFrom?: Handoff;
  /** What the robot said aloud for this reply (`speak` tool), when it differs from the text. */
  spoken?: string;
}

export interface Handoff {
  /** The other agent: the target on `handoffs`, the sender on `handoffFrom`. */
  agentId: string;
  agentName: string;
  task: string;
}

export const emptyTimeline = (): Timeline => ({ parts: [], tools: {}, plan: null });

/** Plain text of the reply, used for search, previews and group-chat context. */
export function timelineText(t: Timeline): string {
  return t.parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

/** Returns a new timeline (never mutates), or the same object when the update is not reply content. */
export function applyUpdate(t: Timeline, u: acp.SessionUpdate): Timeline {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const kind = u.sessionUpdate === "agent_message_chunk" ? "text" : "thought";
      if (u.content.type === "image" && kind === "text")
        return { ...t, parts: [...t.parts, { kind: "image", mimeType: u.content.mimeType, data: u.content.data }] };
      if (u.content.type !== "text") return t;
      const last = t.parts.at(-1);
      if (last && last.kind === kind)
        return { ...t, parts: [...t.parts.slice(0, -1), { kind, text: last.text + u.content.text }] };
      return { ...t, parts: [...t.parts, { kind, text: u.content.text }] };
    }
    case "tool_call": {
      const prev = t.tools[u.toolCallId];
      const tool: ToolState = {
        toolCallId: u.toolCallId,
        title: u.title,
        kind: u.kind ?? "other",
        status: u.status ?? "pending",
        content: u.content ?? [],
        locations: u.locations ?? [],
        rawInput: u.rawInput,
      };
      return {
        ...t,
        tools: { ...t.tools, [u.toolCallId]: tool },
        parts: prev ? t.parts : [...t.parts, { kind: "tool", toolCallId: u.toolCallId }],
      };
    }
    case "tool_call_update": {
      const prev = t.tools[u.toolCallId];
      const tool: ToolState = {
        toolCallId: u.toolCallId,
        title: u.title ?? prev?.title ?? "工具调用",
        kind: u.kind ?? prev?.kind ?? "other",
        status: u.status ?? prev?.status ?? "pending",
        content: u.content ?? prev?.content ?? [],
        locations: u.locations ?? prev?.locations ?? [],
        rawInput: u.rawInput ?? prev?.rawInput,
      };
      return {
        ...t,
        tools: { ...t.tools, [u.toolCallId]: tool },
        parts: prev ? t.parts : [...t.parts, { kind: "tool", toolCallId: u.toolCallId }],
      };
    }
    case "plan":
      return { ...t, plan: u.entries };
    default:
      return t;
  }
}

/** One turn of harness-side history replayed by session/load: what the user sent and how the agent replied. */
export interface ReplayTurn {
  user: string;
  reply: Timeline;
}

/** Groups replayed session/update notifications into turns; Tuantuan's own wrappers are stripped from user text. */
export function replayTurns(updates: acp.SessionUpdate[]): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  let cur: ReplayTurn | null = null;
  for (const u of updates) {
    if (u.sessionUpdate === "user_message_chunk") {
      if (!cur || cur.reply.parts.length > 0) {
        cur = { user: "", reply: emptyTimeline() };
        turns.push(cur);
      }
      if (u.content.type === "text") cur.user += (cur.user ? "\n" : "") + u.content.text;
      continue;
    }
    if (!cur) {
      cur = { user: "", reply: emptyTimeline() };
      turns.push(cur);
    }
    cur.reply = applyUpdate(cur.reply, u);
  }
  for (const t of turns) t.user = t.user.replace(/<tuantuan-identity>[\s\S]*?<\/tuantuan-identity>\s*/g, "").trim();
  return turns;
}
