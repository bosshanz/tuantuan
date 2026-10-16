import { applyUpdate, emptyTimeline, timelineText } from "../../shared/timeline";
import type { Message, PermissionAsk, RoomEvent, RoomState, SessionView, TerminalSnapshot } from "./api";
import { mergeMessages, upsertMessage } from "./messageMerge";

export interface MessagePage {
  messages: Message[];
  nextBeforeSeq: number | null;
}

export interface ChatSnapshot extends MessagePage {
  state: RoomState;
  sessions: Record<string, SessionView>;
  asks: PermissionAsk[];
}

export interface ChatState extends Omit<ChatSnapshot, "nextBeforeSeq"> {
  roomId: string;
  terminals: Record<string, TerminalSnapshot>;
  loading: { id: number; events: RoomEvent[] } | null;
  history: {
    initialized: boolean;
    nextBeforeSeq: number | null;
    loading: { id: number; beforeSeq: number } | null;
    error: string | null;
  };
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
    history: { initialized: false, nextBeforeSeq: null, loading: null, error: null },
  };
}

type Action =
  | { type: "load"; roomId: string; id: number }
  | { type: "snapshot"; roomId: string; id: number; data: ChatSnapshot }
  | { type: "load.failed"; roomId: string; id: number }
  | { type: "history.load"; roomId: string; id: number; beforeSeq: number }
  | { type: "history.page"; roomId: string; id: number; data: MessagePage }
  | { type: "history.failed"; roomId: string; id: number; error: string }
  | { type: "event"; event: RoomEvent };

/** Store assigns contiguous room seqs. Fill reconnect gaps before extending the oldest fetched boundary. */
export function historyCursor(messages: Message[], oldestBeforeSeq: number | null): number | null {
  for (let index = messages.length - 1; index > 0; index--) {
    const newer = messages[index];
    const older = messages[index - 1];
    if (newer && older && newer.seq > older.seq + 1) return newer.seq;
  }
  return oldestBeforeSeq;
}

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
  if (action.type === "history.load") {
    if (
      !current.history.initialized ||
      current.history.loading ||
      action.beforeSeq !== historyCursor(current.messages, current.history.nextBeforeSeq)
    )
      return current;
    return {
      ...current,
      history: { ...current.history, loading: { id: action.id, beforeSeq: action.beforeSeq }, error: null },
    };
  }
  if (action.type === "history.page" || action.type === "history.failed") {
    if (action.id !== current.history.loading?.id) return current;
    if (action.type === "history.failed")
      return { ...current, history: { ...current.history, loading: null, error: action.error } };
    return {
      ...current,
      messages: mergeMessages(action.data.messages, current.messages, roomId),
      history: {
        initialized: true,
        nextBeforeSeq:
          current.history.nextBeforeSeq === null || action.data.nextBeforeSeq === null
            ? null
            : Math.min(current.history.nextBeforeSeq, action.data.nextBeforeSeq),
        loading: null,
        error: null,
      },
    };
  }
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
    state: action.data.state,
    sessions: action.data.sessions,
    asks: action.data.asks,
    messages: mergeMessages(action.data.messages, current.messages, roomId),
    loading: null,
    // Reconnect refreshes the tail; it must not move a reader's older-history boundary forward.
    history: current.history.initialized
      ? current.history
      : { ...current.history, initialized: true, nextBeforeSeq: action.data.nextBeforeSeq },
  };
  for (const event of current.loading.events) {
    if (event.type !== "message" && event.type !== "update") next = applyEvent(next, event);
  }
  return next;
}
