import { describe, expect, test } from "bun:test";
import type { Message } from "../server/store";
import { mergeMessages, upsertMessage } from "../web/src/messageMerge";

const msg = (id: string, createdAt: number, extra: Partial<Message> = {}): Message =>
  ({ id, roomId: "r", createdAt, content: "", status: "done", ...extra }) as Message;

describe("message merge (snapshot vs live events)", () => {
  test("a stale snapshot does not drop messages that arrived live while it was in flight", () => {
    const snapshot = [msg("a", 1)];
    const live = [msg("a", 1), msg("b", 2, { content: "hi" }), msg("c", 3, { status: "streaming", content: "hel" })];
    expect(mergeMessages(snapshot, live, "r").map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
  test("keeps the finished / longer copy of the same message", () => {
    const snap = [msg("c", 3, { status: "streaming", content: "" })];
    const live = [msg("c", 3, { status: "streaming", content: "hello" })];
    expect(mergeMessages(snap, live, "r")[0]?.content).toBe("hello");
    const done = msg("c", 3, { status: "done", content: "hello world" });
    expect(upsertMessage(live, done)[0]).toBe(done);
    expect(upsertMessage([done], msg("c", 3, { status: "streaming", content: "he" }))[0]).toBe(done);
  });
  test("ignores other rooms and keeps chronological order", () => {
    const out = mergeMessages([msg("a", 1), msg("c", 3)], [msg("b", 2), msg("x", 0, { roomId: "other" })], "r");
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
  test("uses sequence order even when timestamps tie or the clock moved backwards", () => {
    const out = mergeMessages(
      [msg("c", 0, { seq: 3 }), msg("b", 100, { seq: 2 }), msg("b", 100, { seq: 2 })],
      [msg("a", 100, { seq: 1 }), msg("d", 0, { seq: 4 })],
      "r",
    );
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(upsertMessage(out, msg("between", 100, { seq: 0 })).map((m) => m.id)).toEqual([
      "between",
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
