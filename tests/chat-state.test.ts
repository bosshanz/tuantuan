import { describe, expect, test } from "bun:test";
import type { Message, PermissionAsk, RoomEvent, RoomState, SessionView } from "../web/src/api";
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
  state: { activeRunId: null, queued: 0, tasks: [] },
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
      event({ type: "room.state", roomId: "r", state: { activeRunId: "run", queued: 2, tasks: [] } }),
    );
    current = chatReducer(current, event({ type: "permission", roomId: "r", ask: ask("live") }));
    current = chatReducer(current, event({ type: "session", roomId: "r", agentId: "a", view }));
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data: snapshot([ask("older")]) });
    expect(current.state).toEqual({ activeRunId: "run", queued: 2, tasks: [] });
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
    current = chatReducer(
      current,
      event({ type: "room.state", roomId: "r", state: { activeRunId: null, queued: 0, tasks: [] } }),
    );
    const data = { ...snapshot(), state: { activeRunId: "old-run", queued: 1, tasks: [] } };
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data });
    expect(current.state).toEqual({ activeRunId: null, queued: 0, tasks: [] });
  });

  test("reconnect's newer snapshot wins over an older response arriving last", () => {
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    current = chatReducer(current, { type: "load", roomId: "r", id: 2 });
    const latest = { ...snapshot(), state: { activeRunId: "latest", queued: 0, tasks: [] } };
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

describe("per-Agent task state across snapshots", () => {
  const task = (
    id: string,
    status: RoomState["tasks"][number]["status"],
    agentId = "a",
    parentTaskId: string | null = null,
  ): RoomState["tasks"][number] => ({
    id,
    runId: `run-${id}`,
    parentTaskId,
    agentId,
    agentName: agentId.toUpperCase(),
    messageId: status === "queued" ? null : `message-${id}`,
    status,
    text: `本次请求 ${id}`,
  });
  const stateEvent = (tasks: RoomState["tasks"]) =>
    event({
      type: "room.state",
      roomId: "r",
      state: {
        activeRunId: tasks.find((t) => t.status === "running" || t.status === "cancelling")?.runId ?? null,
        queued: tasks.filter((t) => t.status === "queued").length,
        tasks,
      },
    });

  test("initialization uses an empty task list and an idle slow snapshot preserves parallel and queued tasks", () => {
    expect(emptyChat("r").state.tasks).toEqual([]);
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    // A task is visible before its Harness has opened a message.
    const tasks = [
      { ...task("first", "running"), messageId: null },
      task("parallel", "running", "b"),
      task("followup", "queued"),
    ];
    current = chatReducer(current, stateEvent(tasks));
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data: snapshot() });
    expect(current.state.tasks).toEqual(tasks);
    expect(current.state.queued).toBe(1);
  });

  test("a targeted cancellation and queue removal cannot be undone by a busy slow snapshot", () => {
    const first = task("first", "running");
    const parallel = task("parallel", "running", "b");
    const independent = task("independent", "queued");
    const removed = task("removed", "queued");
    const old = {
      ...snapshot(),
      state: { activeRunId: first.runId, queued: 2, tasks: [first, parallel, independent, removed] },
    };
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    current = chatReducer(current, stateEvent([{ ...first, status: "cancelling" }, parallel, independent]));
    current = chatReducer(current, stateEvent([parallel, { ...independent, status: "running" }]));
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data: old });
    expect(current.state.tasks.map((t) => [t.id, t.status])).toEqual([
      ["parallel", "running"],
      ["independent", "running"],
    ]);
    expect(current.state.queued).toBe(0);
  });

  test("handoff ancestors and their children survive reconnect while completed tasks stay removed", () => {
    const parent = task("source", "waiting");
    const child = task("handoff", "queued", "b", parent.id);
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    const stale = { ...snapshot(), state: { activeRunId: null, queued: 1, tasks: [parent, child] } };
    current = chatReducer(current, { type: "load", roomId: "r", id: 2 });
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 2, data: stale });
    expect(current.state.tasks).toEqual([parent, child]);
    current = chatReducer(current, stateEvent([]));
    expect(chatReducer(current, { type: "snapshot", roomId: "r", id: 1, data: stale })).toBe(current);
    expect(current.state.tasks).toEqual([]);
  });

  test("failed reconnect retains live tasks and a late task event from another room is ignored", () => {
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    current = chatReducer(current, stateEvent([task("live", "running")]));
    current = chatReducer(current, { type: "load.failed", roomId: "r", id: 1 });
    const nextRoom = emptyChat("next");
    expect(chatReducer(nextRoom, stateEvent([task("old", "running")]))).toBe(nextRoom);
    expect(current.state.tasks.map((t) => t.id)).toEqual(["live"]);
  });
});
