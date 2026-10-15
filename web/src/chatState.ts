import { applyUpdate, emptyTimeline, timelineText } from "../../shared/timeline";
import type { Message, PermissionAsk, RoomEvent, RoomState, SessionView, TerminalSnapshot } from "./api";
import { mergeMessages, upsertMessage } from "./messageMerge";

export interface ChatSnapshot {
  messages: Message[];
  state: RoomState;
  sessions: Record<string, SessionView>;
  asks: PermissionAsk[];
}

export interface ChatState extends ChatSnapshot {
  roomId: string;
  terminals: Record<string, TerminalSnapshot>;
  loading: { id: number; events: RoomEvent[] } | null;
}

export function emptyChat(roomId: string): ChatState {
  return {
    roomId,
    messages: [],
    state: { activeRunId: null, queued: 0, tasks: [] },
    sessions: {},
    asks: [],
    terminals: {},
    loading: null,
  };
}

type Action =
  | { type: "load"; roomId: string; id: number }
  | { type: "snapshot"; roomId: string; id: number; data: ChatSnapshot }
  | { type: "load.failed"; roomId: string; id: number }
  | { type: "event"; event: RoomEvent };

function applyEvent(current: ChatState, e: RoomEvent): ChatState {
  switch (e.type) {
    case "message":
      return { ...current, messages: upsertMessage(current.messages, e.message) };
    case "update":
      return {
        ...current,
        messages: current.messages.map((m) => {
          if (m.id !== e.messageId) return m;
          const timeline = applyUpdate(m.timeline ?? emptyTimeline(), e.update);
          return { ...m, timeline, content: timelineText(timeline) };
        }),
      };
    case "room.state":
      return { ...current, state: e.state };
    case "session":
      return { ...current, sessions: { ...current.sessions, [e.agentId]: e.view } };
    case "permission":
      return {
        ...current,
        asks: e.ask
          ? [...current.asks.filter((a) => a.id !== e.ask?.id), e.ask]
          : current.asks.filter((a) => a.id !== e.resolvedId),
      };
    case "terminal":
      return { ...current, terminals: { ...current.terminals, [e.terminal.terminalId]: e.terminal } };
  }
}

/** A snapshot is a baseline; events received during its request always take precedence. */
export function chatReducer(current: ChatState, action: Action): ChatState {
  const roomId =
    action.type === "event"
      ? action.event.type === "message"
        ? action.event.message.roomId
        : action.event.roomId
      : action.roomId;
  if (roomId !== current.roomId) return current;
  if (action.type === "load") return { ...current, loading: { id: action.id, events: [] } };
  if (action.type === "event") {
    const next = applyEvent(current, action.event);
    return current.loading && action.event.type !== "message" && action.event.type !== "update"
      ? { ...next, loading: { ...current.loading, events: [...current.loading.events, action.event] } }
      : next;
  }
  if (action.id !== current.loading?.id) return current;
  if (action.type === "load.failed") return { ...current, loading: null };
  // Replaying only stateful events avoids applying streamed text deltas twice. Messages use their existing merge rule.
  let next: ChatState = {
    ...current,
    ...action.data,
    messages: mergeMessages(action.data.messages, current.messages, roomId),
    loading: null,
  };
  for (const event of current.loading.events) {
    if (event.type !== "message" && event.type !== "update") next = applyEvent(next, event);
  }
  return next;
}
