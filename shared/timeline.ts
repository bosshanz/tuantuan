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
  /** Member names whose results prompted a group leader's follow-up reply. */
  reviewOf?: string[];
  /** Explicit task checkpoint, committed only when this reply completes successfully. */
  taskContext?: TaskContext;
}

export interface TaskContext {
  goal: string;
  decisions: string[];
  pending: string[];
}

/** Latest accepted task note shown as the room's read-only conclusion card. Derived, not stored. */
export interface RoomConclusion {
  messageId: string;
  seq: number;
  context: TaskContext;
}

/** Timeline JSON is not revalidated on read, so a malformed legacy note must not reach the card. */
function validTaskContext(timeline: Timeline | null): TaskContext | null {
  const context = timeline?.taskContext as unknown;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const record = context as Record<string, unknown>;
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
  if (typeof record.goal !== "string" || !strings(record.decisions) || !strings(record.pending)) return null;
  return context as TaskContext;
}

/** Root-task or coordinator-follow-up replies carry the room's conclusion; hand-off replies do not. */
export function conclusionFromMessage(message: {
  id: string;
  seq: number;
  hop: number;
  senderKind: string;
  status: string;
  timeline: Timeline | null;
}): RoomConclusion | null {
  if (message.senderKind !== "agent" || message.status !== "done") return null;
  const context = validTaskContext(message.timeline);
  if (!context) return null;
  if (message.hop !== 1 && !message.timeline?.reviewOf?.length) return null;
  return { messageId: message.id, seq: message.seq, context };
}

export function latestConclusionOf(
  messages: {
    id: string;
    seq: number;
    hop: number;
    senderKind: string;
    status: string;
    timeline: Timeline | null;
  }[],
): RoomConclusion | null {
  let latest: RoomConclusion | null = null;
  for (const message of messages) {
    const conclusion = conclusionFromMessage(message);
    if (conclusion && (!latest || conclusion.seq > latest.seq)) latest = conclusion;
  }
  return latest;
}

export interface Handoff {
  /** The other agent: the target on `handoffs`, the sender on `handoffFrom`. */
  agentId: string;
  agentName: string;
  task: string;
  context?: TaskContext;
}

export const emptyTimeline = (): Timeline => ({ parts: [], tools: {}, plan: null });

/** Plain text of the reply, used for search, previews and group-chat context. */
export function timelineText(t: Timeline): string {
  return t.parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

export interface TimelineProcess {
  tools: number;
  thoughts: number;
  planDone: number;
  planTotal: number;
  failed: number;
}

/** What the compact view folds into one summary line: every tool, thought and plan step. */
export function timelineProcess(t: Timeline | null | undefined): TimelineProcess {
  const ids = new Set(
    (t?.parts ?? [])
      .filter((p): p is { kind: "tool"; toolCallId: string } => p.kind === "tool")
      .map((p) => p.toolCallId),
  );
  let failed = 0;
  for (const id of ids) if (t?.tools[id]?.status === "failed") failed++;
  const plan = t?.plan ?? [];
  return {
    tools: ids.size,
    thoughts: (t?.parts ?? []).filter((p) => p.kind === "thought").length,
    planDone: plan.filter((entry) => entry.status === "completed").length,
    planTotal: plan.length,
    failed,
  };
}

/** The tool the compact view names while the reply is still running, if any. */
export function currentToolOf(t: Timeline | null | undefined): string | null {
  const parts = t?.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part) continue;
    if (part.kind !== "tool") continue;
    const tool = t?.tools[part.toolCallId];
    if (tool && (tool.status === "pending" || tool.status === "in_progress")) return tool.title;
    return null;
  }
  return null;
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
  for (const t of turns)
    t.user = t.user
      .replace(/<tuantuan-identity>[\s\S]*?<\/tuantuan-identity>\s*/g, "")
      .replace(/<tuantuan-skills>[\s\S]*?<\/tuantuan-skills>\s*/g, "")
      .replace(/<tuantuan-coordination\b[^>]*>[\s\S]*?<\/tuantuan-coordination>\s*/g, "")
      .replace(/<tuantuan-context>[\s\S]*?<\/tuantuan-context>\s*/g, "")
      .trim();
  return turns;
}
