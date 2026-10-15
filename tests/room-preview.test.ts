import { describe, expect, test } from "bun:test";
import { type Message, type Room, Store } from "../server/store";
import { messagePreview, newerPreview, previewText, type RoomPreview } from "../shared/roomPreview";
import { type RoomListState, roomListReducer } from "../web/src/roomListState";

const message = (extra: Partial<Message> = {}): Message => ({
  id: "m1",
  roomId: "r",
  seq: 1,
  runId: "run",
  hop: 1,
  senderKind: "agent",
  senderId: "a",
  senderName: "Bot",
  content: "new reply",
  status: "done",
  error: null,
  timeline: null,
  quote: null,
  createdAt: 100,
  ...extra,
});
const last = (extra: Partial<Message> = {}): RoomPreview => messagePreview(message(extra)) as RoomPreview;
const room = (id = "r", preview?: RoomPreview): Room => ({
  id,
  name: id,
  kind: "dm",
  agentIds: ["a"],
  mainAgentId: "a",
  projectId: null,
  cwd: "/tmp",
  createdAt: 0,
  last: preview,
});
const initial = (rooms: Room[] = [room()]): RoomListState => ({ rooms, loading: null });
const live = (state: RoomListState, preview: RoomPreview, roomId = "r") =>
  roomListReducer(state, { type: "event", event: { type: "room.preview", roomId, last: preview } });

describe("sidebar preview contract", () => {
  test("human, streaming, final, failure and cancellation have consistent summaries; system messages do not replace them", () => {
    expect(last({ senderKind: "human", senderName: "我" }).sender).toBeNull();
    expect(last({ content: "a\n  b" }).text).toBe("a b");
    expect(last({ content: "x".repeat(180) }).text).toHaveLength(120);
    expect(previewText(last({ content: "", status: "streaming" }))).toBe("正在回复…");
    expect(previewText(last({ content: "", status: "done" }))).toBe("（空回复）");
    expect(previewText(last({ content: "", status: "error", error: "provider unavailable" }))).toBe(
      "provider unavailable",
    );
    expect(previewText(last({ content: "", status: "cancelled" }))).toBe("已取消");
    expect(last({ content: "partial reply", status: "cancelled", error: "cancelled" }).text).toBe("partial reply");
    expect(messagePreview(message({ senderKind: "system" }))).toBeNull();
  });

  test("a completion from an older turn and late streaming placeholders cannot regress the preview", () => {
    const human = last({ id: "new-human", seq: 3, senderKind: "human" });
    expect(newerPreview(human, last({ seq: 2 }))).toBe(human);
    const done = last();
    expect(newerPreview(done, last({ status: "streaming", content: "" }))).toBe(done);
    const partial = last({ status: "streaming", content: "partial" });
    expect(newerPreview(partial, last({ status: "streaming", content: "" }))).toBe(partial);
    expect(newerPreview(partial, last({ content: "", status: "error", error: "failed" })).status).toBe("error");
  });

  test("list snapshots use the same summary as a global update and select the last non-system seq", () => {
    const store = new Store(":memory:");
    try {
      const r = store.createRoom("preview", []);
      const m = store.insertMessage({
        roomId: r.id,
        runId: "run",
        hop: 0,
        senderKind: "human",
        senderId: null,
        senderName: "我",
        content: "new\nmessage",
        status: "done",
      });
      store.insertMessage({
        roomId: r.id,
        runId: "run",
        hop: 0,
        senderKind: "system",
        senderId: null,
        senderName: "系统",
        content: "system notice",
        status: "done",
      });
      expect(store.listRooms()[0]?.last).toEqual(messagePreview(m) ?? undefined);
    } finally {
      store.db.close();
    }
  });
});

describe("room list snapshot versus global events", () => {
  test("foreground and background rooms both update without consulting notification settings", () => {
    let state = initial([room("r"), room("background")]);
    state = live(state, last(), "r");
    state = live(state, last({ id: "background-reply" }), "background");
    expect(state.rooms.map((r) => r.last?.messageId)).toEqual(["m1", "background-reply"]);
  });

  test("an initial slow snapshot replays previews and activity received before the room exists locally", () => {
    let state = roomListReducer(initial([]), { type: "load", id: 1 });
    state = live(state, last({ status: "streaming", content: "" }));
    state = roomListReducer(state, { type: "event", event: { type: "activity", roomId: "r", busy: true } });
    state = live(state, last({ content: "finished while loading" }));
    state = roomListReducer(state, { type: "event", event: { type: "activity", roomId: "r", busy: false } });
    state = roomListReducer(state, { type: "snapshot", id: 1, rooms: [room()] });
    expect(state.rooms[0]).toMatchObject({ busy: false, last: { text: "finished while loading", status: "done" } });
    expect(state.loading).toBeNull();
  });

  test("a slow streaming snapshot cannot undo a final event or a newer message sequence", () => {
    let state = roomListReducer(initial(), { type: "load", id: 1 });
    state = live(state, last({ seq: 3, status: "cancelled", content: "partial" }));
    state = roomListReducer(state, {
      type: "snapshot",
      id: 1,
      rooms: [room("r", last({ seq: 2, status: "streaming" }))],
    });
    expect(state.rooms[0]?.last).toMatchObject({ seq: 3, status: "cancelled", text: "partial" });
  });

  test("reconnect refreshes missed updates, and an older HTTP response arriving last is ignored", () => {
    let state = roomListReducer(initial(), { type: "load", id: 1 });
    state = roomListReducer(state, { type: "load", id: 2 });
    state = roomListReducer(state, {
      type: "snapshot",
      id: 2,
      rooms: [room("r", last({ seq: 7, content: "missed while offline" }))],
    });
    expect(roomListReducer(state, { type: "snapshot", id: 1, rooms: [room()] })).toBe(state);
    expect(state.rooms[0]?.last?.text).toBe("missed while offline");
  });

  test("failed refresh keeps live data; a deleted room is not resurrected by journal replay", () => {
    let state = roomListReducer(initial(), { type: "load", id: 1 });
    state = live(state, last());
    state = roomListReducer(state, { type: "load.failed", id: 1 });
    expect(state.rooms[0]?.last?.text).toBe("new reply");
    state = roomListReducer(state, { type: "load", id: 2 });
    state = live(state, last({ seq: 2 }));
    state = roomListReducer(state, { type: "snapshot", id: 2, rooms: [] });
    expect(state.rooms).toEqual([]);
  });
});
