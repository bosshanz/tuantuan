import { describe, expect, test } from "bun:test";
import { agentActivity, messageExpression } from "../web/src/avatarState";

const msg = (status: string, content = "", senderId = "a") =>
  ({ status, content, senderKind: "agent", senderId }) as Parameters<typeof messageExpression>[0];

describe("avatar state -> expression", () => {
  test("a reply waiting for its first token thinks, then speaks while streaming; only these are live", () => {
    expect(messageExpression(msg("streaming"))).toEqual({ expression: "thinking", live: true });
    expect(messageExpression(msg("streaming", "你好"))).toEqual({ expression: "speaking", live: true });
    expect(messageExpression(msg("done", "ok"))).toEqual({ expression: "idle", live: false });
    expect(messageExpression(msg("error"))).toEqual({ expression: "sad", live: false });
    expect(messageExpression(msg("cancelled", "部分")).live).toBe(false);
  });
  test("member activity follows the agent's latest reply", () => {
    expect(agentActivity("a", [])).toBe("idle");
    expect(agentActivity("a", [msg("done", "x"), msg("streaming")])).toBe("thinking");
    expect(agentActivity("a", [msg("streaming", "x")])).toBe("speaking");
    expect(agentActivity("a", [msg("error")])).toBe("sad");
    expect(agentActivity("a", [msg("interrupted", "x")])).toBe("surprised");
    expect(agentActivity("a", [msg("done", "x")], { unavailable: true })).toBe("sleepy");
    expect(agentActivity("a", [msg("streaming")], { unavailable: true })).toBe("thinking");
    expect(agentActivity("a", [msg("streaming", "", "b")])).toBe("idle");
  });
});
