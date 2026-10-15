import { describe, expect, test } from "bun:test";
import type { Message, PermissionAsk, RoomEvent, SessionView } from "../web/src/api";
import { type ChatSnapshot, chatReducer, emptyChat } from "../web/src/chatState";

const ask = (id: string): PermissionAsk => ({
  id,
  roomId: "r",
  agentId: "a",
  toolCall: { toolCallId: id },
  options: [],
});
const snapshot = (asks: PermissionAsk[] = []): ChatSnapshot => ({
  messages: [],
  state: { activeRunId: null, queued: 0 },
  sessions: {},
  asks,
});
const event = (value: RoomEvent) => ({ type: "event", event: value }) as const;

describe("chat snapshot and live event ordering", () => {
  test("a slow idle snapshot preserves the live run, permissions, and latest session", () => {
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    const view = { sessionId: "latest" } as SessionView;
    current = chatReducer(
      current,
      event({ type: "room.state", roomId: "r", state: { activeRunId: "run", queued: 2 } }),
    );
    current = chatReducer(current, event({ type: "permission", roomId: "r", ask: ask("live") }));
    current = chatReducer(current, event({ type: "session", roomId: "r", agentId: "a", view }));
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data: snapshot([ask("older")]) });
    expect(current.state).toEqual({ activeRunId: "run", queued: 2 });
    expect(current.asks.map((a) => a.id)).toEqual(["older", "live"]);
    expect(current.sessions.a).toBe(view);
    expect(current.loading).toBeNull();
  });

  test("a resolved permission stays resolved, including one created and resolved during loading", () => {
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    current = chatReducer(current, event({ type: "permission", roomId: "r", ask: null, resolvedId: "older" }));
    current = chatReducer(current, event({ type: "permission", roomId: "r", ask: ask("live") }));
    current = chatReducer(current, event({ type: "permission", roomId: "r", ask: null, resolvedId: "live" }));
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data: snapshot([ask("older")]) });
    expect(current.asks).toEqual([]);
  });

  test("a stale busy snapshot cannot undo a live cancellation", () => {
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    current = chatReducer(current, event({ type: "room.state", roomId: "r", state: { activeRunId: null, queued: 0 } }));
    const data = { ...snapshot(), state: { activeRunId: "old-run", queued: 1 } };
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data });
    expect(current.state).toEqual({ activeRunId: null, queued: 0 });
  });

  test("reconnect's newer snapshot wins over an older response arriving last", () => {
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    current = chatReducer(current, { type: "load", roomId: "r", id: 2 });
    const latest = { ...snapshot(), state: { activeRunId: "latest", queued: 0 } };
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 2, data: latest });
    expect(chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data: snapshot() })).toBe(current);
    expect(current.state.activeRunId).toBe("latest");
  });

  test("late responses and events from a previous room do not enter the next room", () => {
    const current = chatReducer(emptyChat("next"), { type: "load", roomId: "next", id: 1 });
    expect(chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data: snapshot([ask("older")]) })).toBe(
      current,
    );
    expect(chatReducer(current, event({ type: "permission", roomId: "r", ask: ask("older") }))).toBe(current);
    expect(chatReducer(current, event({ type: "message", message: { id: "m", roomId: "r" } as Message }))).toBe(
      current,
    );
  });

  test("failed loading keeps live state and releases its event journal", () => {
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    current = chatReducer(current, event({ type: "permission", roomId: "r", ask: ask("live") }));
    current = chatReducer(current, { type: "load.failed", roomId: "r", id: 1 });
    expect(current.asks.map((a) => a.id)).toEqual(["live"]);
    expect(current.loading).toBeNull();
  });
});
