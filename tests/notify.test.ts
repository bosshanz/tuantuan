import { expect, test } from "bun:test";
import { notifyForMessage, preview } from "../shared/notify";
import { agentActivity, messageExpression } from "../web/src/avatarState";
import { bumpUnread, DEFAULT_NOTIFY, shouldNotify, totalUnread } from "../web/src/notifications";

const msg = (o: Partial<Parameters<typeof notifyForMessage>[1]>) => ({
  id: "m1",
  senderKind: "agent",
  senderId: "a1",
  senderName: "Bob",
  status: "done",
  content: "好的，**已经**改完了。",
  error: null,
  ...o,
});

test("finished replies, errors and auth problems become notifications; streaming / human do not", () => {
  expect(notifyForMessage("r", msg({}))).toMatchObject({ kind: "reply", agentName: "Bob", text: "好的，已经改完了。" });
  expect(notifyForMessage("r", msg({ status: "streaming" }))).toBeNull();
  expect(notifyForMessage("r", msg({ senderKind: "human" }))).toBeNull();
  expect(notifyForMessage("r", msg({ status: "cancelled" }))).toBeNull();
  expect(notifyForMessage("r", msg({ status: "error", error: "boom" }))).toMatchObject({ kind: "error" });
  expect(notifyForMessage("r", msg({ status: "error", error: "401 Unauthorized" }))).toMatchObject({ kind: "auth" });
  expect(preview("a".repeat(200)).length).toBe(90);
});

test("suppressed only while focused on that very conversation; per-category switches", () => {
  const e = {
    type: "notify" as const,
    kind: "reply" as const,
    roomId: "r1",
    agentId: "a",
    agentName: "Bob",
    text: "x",
    id: "1",
  };
  const settings = { ...DEFAULT_NOTIFY };
  expect(shouldNotify(e, { settings, focused: true, openRoomId: "r1" })).toBe(false);
  expect(shouldNotify(e, { settings, focused: false, openRoomId: "r1" })).toBe(true);
  expect(shouldNotify(e, { settings, focused: true, openRoomId: "r2" })).toBe(true);
  expect(shouldNotify(e, { settings: { ...settings, reply: false }, focused: false, openRoomId: null })).toBe(false);
  expect(shouldNotify(e, { settings: { ...settings, enabled: false }, focused: false, openRoomId: null })).toBe(false);
  expect(totalUnread(bumpUnread(bumpUnread({}, "a"), "b"))).toBe(2);
});

test("avatar shows working while a tool call runs", () => {
  const timeline = {
    parts: [{ kind: "tool" as const, toolCallId: "t" }],
    tools: { t: { toolCallId: "t", title: "ls", kind: "execute", status: "in_progress", content: [], locations: [] } },
    plan: null,
  };
  const m = { status: "streaming" as const, content: "", senderKind: "agent" as const, senderId: "a", timeline };
  expect(messageExpression(m).expression).toBe("working");
  expect(agentActivity("a", [m])).toBe("working");
  expect(messageExpression({ ...m, timeline: undefined }).expression).toBe("thinking");
});
