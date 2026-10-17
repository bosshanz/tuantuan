import { describe, expect, test } from "bun:test";
import type { ElicitationAsk, Message, PermissionAsk, RoomEvent, RoomState, SessionView } from "../web/src/api";
import { type ChatSnapshot, chatReducer, emptyChat, historyCursor } from "../web/src/chatState";

const ask = (id: string): PermissionAsk => ({
  id,
  roomId: "r",
  agentId: "a",
  toolCall: { toolCallId: id },
  options: [],
});
const snapshot = (asks: PermissionAsk[] = []): ChatSnapshot => ({
  messages: [],
  nextBeforeSeq: null,
  state: { activeRunId: null, queued: 0, tasks: [] },
  sessions: {},
  asks,
  elicitations: [],
  conclusion: null,
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

describe("older message pages", () => {
  const message = (seq: number, extra: Partial<Message> = {}): Message =>
    ({ id: `m${seq}`, roomId: "r", seq, createdAt: 100, content: `${seq}`, status: "done", ...extra }) as Message;
  const loaded = () => {
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    current = chatReducer(current, {
      type: "snapshot",
      roomId: "r",
      id: 1,
      data: { ...snapshot(), messages: [message(4), message(5)], nextBeforeSeq: 4 },
    });
    return current;
  };

  test("a page merges by id/seq and cannot replace live messages, state, permissions or sessions", () => {
    let current = chatReducer(loaded(), { type: "history.load", roomId: "r", id: 2, beforeSeq: 4 });
    current = chatReducer(current, event({ type: "message", message: message(6) }));
    current = chatReducer(
      current,
      event({
        type: "update",
        roomId: "r",
        messageId: "m4",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "newer text" } },
      }),
    );
    current = chatReducer(
      current,
      event({ type: "room.state", roomId: "r", state: { activeRunId: "live", queued: 1, tasks: [] } }),
    );
    current = chatReducer(current, event({ type: "permission", roomId: "r", ask: ask("live") }));
    const view = { sessionId: "live" } as SessionView;
    current = chatReducer(current, event({ type: "session", roomId: "r", agentId: "a", view }));
    current = chatReducer(current, {
      type: "history.page",
      roomId: "r",
      id: 2,
      data: { ...snapshot(), messages: [message(3), message(2), message(4), message(2)], nextBeforeSeq: 2 },
    });
    expect(current.messages.map((m) => m.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(current.messages.find((m) => m.seq === 4)?.content).toBe("newer text");
    expect(current.state.activeRunId).toBe("live");
    expect(current.asks.map((a) => a.id)).toEqual(["live"]);
    expect(current.sessions.a).toBe(view);
    expect(current.history.nextBeforeSeq).toBe(2);
  });

  test("a reconnect snapshot arriving after a page retains the older window and cursor, including exhaustion", () => {
    let current = chatReducer(loaded(), { type: "load", roomId: "r", id: 2 });
    current = chatReducer(current, { type: "history.load", roomId: "r", id: 3, beforeSeq: 4 });
    current = chatReducer(current, {
      type: "history.page",
      roomId: "r",
      id: 3,
      data: { messages: [message(1), message(2), message(3)], nextBeforeSeq: null },
    });
    current = chatReducer(current, {
      type: "snapshot",
      roomId: "r",
      id: 2,
      data: { ...snapshot(), messages: [message(4), message(5), message(6)], nextBeforeSeq: 4 },
    });
    expect(current.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(current.history.nextBeforeSeq).toBeNull();
  });

  test("reconnect before a pending page preserves its request; duplicate/late requests and other rooms are ignored", () => {
    let current = chatReducer(loaded(), { type: "history.load", roomId: "r", id: 2, beforeSeq: 4 });
    expect(chatReducer(current, { type: "history.load", roomId: "r", id: 3, beforeSeq: 4 })).toBe(current);
    current = chatReducer(current, { type: "load", roomId: "r", id: 3 });
    current = chatReducer(current, { type: "snapshot", roomId: "r", id: 3, data: { ...snapshot(), nextBeforeSeq: 5 } });
    expect(current.history.loading?.id).toBe(2);
    const page = {
      type: "history.page" as const,
      roomId: "r",
      id: 2,
      data: { messages: [message(3)], nextBeforeSeq: 3 },
    };
    const nextRoom = emptyChat("next");
    expect(chatReducer(nextRoom, page)).toBe(nextRoom);
    current = chatReducer(current, page);
    expect(current.messages.map((m) => m.seq)).toEqual([3, 4, 5]);
    expect(chatReducer(current, page)).toBe(current);
  });

  test("a failed page leaves messages and cursor intact and can be retried", () => {
    const before = loaded();
    let current = chatReducer(before, { type: "history.load", roomId: "r", id: 2, beforeSeq: 4 });
    current = chatReducer(current, { type: "history.failed", roomId: "r", id: 2, error: "temporary" });
    expect(current.messages).toBe(before.messages);
    expect(current.history).toMatchObject({ nextBeforeSeq: 4, loading: null, error: "temporary" });
    current = chatReducer(current, { type: "history.load", roomId: "r", id: 3, beforeSeq: 4 });
    expect(current.history).toMatchObject({ loading: { id: 3, beforeSeq: 4 }, error: null });
    expect(chatReducer(current, { type: "history.failed", roomId: "r", id: 2, error: "old" })).toBe(current);
  });

  test("a reconnect after 250 unseen records fills the skipped window before older history", () => {
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => message(from + index));
    let current = chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
    current = chatReducer(current, {
      type: "snapshot",
      roomId: "r",
      id: 1,
      data: { ...snapshot(), messages: range(52, 451), nextBeforeSeq: 52 },
    });
    current = chatReducer(current, { type: "load", roomId: "r", id: 2 });
    current = chatReducer(current, {
      type: "snapshot",
      roomId: "r",
      id: 2,
      data: { ...snapshot(), messages: range(502, 701), nextBeforeSeq: 502 },
    });
    expect(historyCursor(current.messages, current.history.nextBeforeSeq)).toBe(502);
    current = chatReducer(current, { type: "history.load", roomId: "r", id: 3, beforeSeq: 502 });
    current = chatReducer(current, {
      type: "history.page",
      roomId: "r",
      id: 3,
      data: { messages: range(302, 501), nextBeforeSeq: 302 },
    });
    expect(current.messages.map((m) => m.seq)).toEqual(range(52, 701).map((m) => m.seq));
    expect(historyCursor(current.messages, current.history.nextBeforeSeq)).toBe(52);
    current = chatReducer(current, { type: "history.load", roomId: "r", id: 4, beforeSeq: 52 });
    current = chatReducer(current, {
      type: "history.page",
      roomId: "r",
      id: 4,
      data: { messages: range(1, 51), nextBeforeSeq: null },
    });
    expect(current.messages.map((m) => m.seq)).toEqual(range(1, 701).map((m) => m.seq));
    expect(historyCursor(current.messages, current.history.nextBeforeSeq)).toBeNull();
    // Exhaustion of older history must not hide a later reconnect gap.
    current = chatReducer(current, { type: "load", roomId: "r", id: 5 });
    current = chatReducer(current, {
      type: "snapshot",
      roomId: "r",
      id: 5,
      data: { ...snapshot(), messages: range(752, 951), nextBeforeSeq: 752 },
    });
    expect(historyCursor(current.messages, current.history.nextBeforeSeq)).toBe(752);
    current = chatReducer(current, { type: "history.load", roomId: "r", id: 6, beforeSeq: 752 });
    current = chatReducer(current, {
      type: "history.page",
      roomId: "r",
      id: 6,
      data: { messages: range(552, 751), nextBeforeSeq: 552 },
    });
    expect(current.messages.map((m) => m.seq)).toEqual(range(1, 951).map((m) => m.seq));
    expect(historyCursor(current.messages, current.history.nextBeforeSeq)).toBeNull();
  });
});

describe("elicitation and conclusion state", () => {
  const load = () => chatReducer(emptyChat("r"), { type: "load", roomId: "r", id: 1 });
  const elicitation = (id: string): ElicitationAsk => ({
    id,
    roomId: "r",
    agentId: "a",
    message: "请确认",
    fields: [],
  });
  const message = (seq: number, extra: Partial<Message> = {}): Message =>
    ({
      id: `m${seq}`,
      roomId: "r",
      seq,
      createdAt: 100,
      content: `${seq}`,
      status: "done",
      runId: "run",
      hop: 1,
      senderKind: "agent",
      senderId: "a",
      senderName: "A",
      timeline: { parts: [], tools: {}, plan: null },
      ...extra,
    }) as Message;
  const note = (seq: number, goal: string, extra: Partial<Message> = {}, reviewOf?: string[]): Message =>
    message(seq, {
      ...extra,
      timeline: {
        parts: [],
        tools: {},
        plan: null,
        ...(reviewOf ? { reviewOf } : {}),
        taskContext: { goal, decisions: [], pending: [] },
      },
    });

  test("a slow snapshot keeps a live question; a resolved question cannot come back", () => {
    let current = load();
    current = chatReducer(current, event({ type: "elicitation", roomId: "r", ask: elicitation("live") }));
    current = chatReducer(current, {
      type: "snapshot",
      roomId: "r",
      id: 1,
      data: { ...snapshot(), elicitations: [elicitation("older")] },
    });
    expect(current.elicitations.map((e) => e.id)).toEqual(["older", "live"]);

    let resolved = load();
    resolved = chatReducer(resolved, event({ type: "elicitation", roomId: "r", ask: null, resolvedId: "older" }));
    resolved = chatReducer(resolved, event({ type: "elicitation", roomId: "r", ask: elicitation("live") }));
    resolved = chatReducer(resolved, event({ type: "elicitation", roomId: "r", ask: null, resolvedId: "live" }));
    resolved = chatReducer(resolved, {
      type: "snapshot",
      roomId: "r",
      id: 1,
      data: { ...snapshot(), elicitations: [elicitation("older")] },
    });
    expect(resolved.elicitations).toEqual([]);
  });

  test("the card follows the newest accepted root note and keeps a quiet round's previous note", () => {
    let current = load();
    current = chatReducer(current, event({ type: "message", message: note(2, "第一轮") }));
    expect(current.conclusion).toEqual({
      messageId: "m2",
      seq: 2,
      context: { goal: "第一轮", decisions: [], pending: [] },
    });
    // Member hand-off notes stay on their own messages.
    current = chatReducer(current, event({ type: "message", message: note(3, "成员", { hop: 2 }) }));
    expect(current.conclusion?.messageId).toBe("m2");
    // A round without a new accepted note leaves the previous conclusion pinned.
    current = chatReducer(current, event({ type: "message", message: message(4) }));
    expect(current.conclusion?.messageId).toBe("m2");
    // The coordinator's follow-up after member results is a valid new conclusion.
    current = chatReducer(current, event({ type: "message", message: note(5, "汇总", { hop: 2 }, ["成员"]) }));
    expect(current.conclusion?.context.goal).toBe("汇总");
    // A late older event cannot replace a newer conclusion.
    current = chatReducer(current, event({ type: "message", message: note(1, "旧笔记") }));
    expect(current.conclusion?.messageId).toBe("m5");
  });

  test("a malformed legacy note neither becomes nor hides the conclusion", () => {
    let current = load();
    current = chatReducer(current, event({ type: "message", message: note(2, "有效") }));
    const malformed = message(3, {
      timeline: {
        parts: [],
        tools: {},
        plan: null,
        taskContext: { goal: 1, decisions: "x" },
      } as unknown as Message["timeline"],
    });
    current = chatReducer(current, event({ type: "message", message: malformed }));
    expect(current.conclusion?.messageId).toBe("m2");
  });

  test("a snapshot derives the conclusion from messages and keeps the newest of server, live and derived", () => {
    let current = load();
    current = chatReducer(current, event({ type: "message", message: note(5, "live 新") }));
    current = chatReducer(current, {
      type: "snapshot",
      roomId: "r",
      id: 1,
      data: {
        ...snapshot(),
        messages: [note(3, "server 旧")],
        conclusion: { messageId: "m3", seq: 3, context: { goal: "server 旧", decisions: [], pending: [] } },
      },
    });
    expect(current.conclusion).toMatchObject({ messageId: "m5", context: { goal: "live 新" } });

    let derived = load();
    derived = chatReducer(derived, {
      type: "snapshot",
      roomId: "r",
      id: 1,
      data: { ...snapshot(), messages: [note(2, "来自消息")], conclusion: null },
    });
    expect(derived.conclusion).toMatchObject({ messageId: "m2", context: { goal: "来自消息" } });
  });
});
