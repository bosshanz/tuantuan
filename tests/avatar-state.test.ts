import { describe, expect, test } from "bun:test";
import { agentActivity, avatarState, roomAvatarState } from "../web/src/avatarState";

const msg = (status: string, content = "", senderId = "a") =>
  ({ status, content, senderKind: "agent", senderId }) as Parameters<typeof avatarState>[0] & object;
const toolMsg = (status: "pending" | "in_progress" | "completed") => ({
  ...msg("streaming"),
  timeline: {
    parts: [{ kind: "tool" as const, toolCallId: "t" }],
    tools: { t: { toolCallId: "t", title: "ls", kind: "execute", status, content: [], locations: [] } },
    plan: null,
  } as never,
});

describe("avatar state derivation", () => {
  test("a reply in flight thinks, runs tools, then speaks; only in-flight states are live", () => {
    expect(avatarState(msg("streaming"))).toEqual({ expression: "thinking", live: true });
    expect(avatarState(toolMsg("in_progress"))).toEqual({ expression: "working", live: true });
    expect(avatarState(toolMsg("completed"))).toEqual({ expression: "thinking", live: true });
    expect(avatarState(msg("streaming", "你好"))).toEqual({ expression: "speaking", live: true });
    expect(avatarState(msg("done", "ok"))).toEqual({ expression: "idle", live: false });
    expect(avatarState(msg("error"))).toEqual({ expression: "sad", live: false });
    expect(avatarState(undefined)).toEqual({ expression: "idle", live: false });
  });

  test("cancelled or interrupted replies settle back to idle instead of looking surprised", () => {
    expect(avatarState(msg("cancelled", "部分")).expression).toBe("idle");
    expect(avatarState(msg("interrupted", "x")).expression).toBe("idle");
  });

  test("a pending permission request or question wins over everything else", () => {
    expect(avatarState(msg("streaming", "x"), { awaiting: true })).toEqual({ expression: "awaiting", live: true });
    expect(avatarState(toolMsg("pending"), { awaiting: true }).expression).toBe("awaiting");
    expect(avatarState(undefined, { awaiting: true, unavailable: true }).expression).toBe("awaiting");
  });

  test("unavailable only applies when the agent is not replying", () => {
    expect(avatarState(msg("done", "x"), { unavailable: true }).expression).toBe("sleepy");
    expect(avatarState(msg("error"), { unavailable: true }).expression).toBe("sleepy");
    expect(avatarState(msg("streaming"), { unavailable: true }).expression).toBe("thinking");
  });

  test("member activity follows the agent's own latest reply", () => {
    expect(agentActivity("a", []).expression).toBe("idle");
    expect(agentActivity("a", [msg("done", "x"), msg("streaming")]).expression).toBe("thinking");
    expect(agentActivity("a", [msg("streaming", "x"), msg("streaming", "", "b")]).expression).toBe("speaking");
    expect(agentActivity("a", [msg("streaming", "", "b")]).expression).toBe("idle");
    expect(agentActivity("a", [msg("error")]).expression).toBe("sad");
    expect(agentActivity("a", [msg("streaming")], { awaiting: true }).expression).toBe("awaiting");
  });

  test("sidebar state comes from the room snapshot instead of always thinking", () => {
    expect(roomAvatarState({})).toEqual({ expression: "idle", live: false });
    expect(roomAvatarState({ busy: true })).toEqual({ expression: "working", live: true });
    expect(roomAvatarState({ busy: true, last: { status: "streaming", text: "" } }).expression).toBe("thinking");
    expect(roomAvatarState({ busy: true, last: { status: "streaming", text: "hi" } }).expression).toBe("speaking");
    expect(roomAvatarState({ busy: true, awaiting: true }).expression).toBe("awaiting");
    expect(roomAvatarState({ busy: false, last: { status: "error", text: "" } }).expression).toBe("sad");
    expect(roomAvatarState({ busy: false, last: { status: "cancelled", text: "x" } }).expression).toBe("idle");
  });
});
