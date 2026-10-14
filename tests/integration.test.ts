import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "../server/app";
import { defaultAvatar } from "../server/avatars";
import { loadSkills } from "../server/skills";
import type { Agent, Message, Room, RoutingDecision } from "../server/store";
import { testConfig } from "./helpers";

const { app, server } = serve(
  { config: testConfig({ maxAgentHops: 3 }), configSource: "test", skills: loadSkills("skills"), dbPath: ":memory:" },
  0,
);
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

const agentBody = (name: string, systemPrompt = "", extra: Partial<Agent> = {}) => ({
  name,
  color: "#336699",
  avatar: name.slice(0, 1),
  systemPrompt,
  tools: [],
  skills: [],
  modelMode: "auto",
  pinnedModel: null,
  ...extra,
});

async function createAgent(name: string, systemPrompt = "", extra: Partial<Agent> = {}): Promise<Agent> {
  const r = await api<Agent>("POST", "/api/agents", agentBody(name, systemPrompt, extra));
  expect(r.status).toBe(201);
  return r.data;
}

async function createRoom(name: string, kind: "group" | "dm", agentIds: string[]): Promise<Room> {
  const r = await api<Room>("POST", "/api/rooms", { name, kind, agentIds });
  expect(r.status).toBe(201);
  return r.data;
}

/** Posts a human message and waits until the room's chain (and any queued chains) finish. */
async function say(roomId: string, content: string) {
  await api("POST", `/api/rooms/${roomId}/messages`, { senderName: "Andy", content });
  await app.orchestrator.idle(roomId);
  return (await api<{ messages: Message[]; routing: RoutingDecision[] }>("GET", `/api/rooms/${roomId}/messages`)).data;
}

describe("HTTP + WS integration (mock provider)", () => {
  let a: Agent;
  let b: Agent;
  let room: Room;
  const events: { type: string; [k: string]: unknown }[] = [];
  let ws: WebSocket;

  beforeAll(async () => {
    a = await createAgent("Alice", "[[handoff:Bob 请你来处理这个问题]][[reply:这个交给 Bob 处理。]]");
    b = await createAgent("Bob");
    room = await createRoom("项目群", "group", [a.id, b.id]);
    ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
    ws.send(JSON.stringify({ type: "subscribe", roomId: room.id }));
    while (!events.some((e) => e.type === "subscribed")) await Bun.sleep(5);
  });
  afterAll(() => ws.close());

  test("agent avatars: default derived from id, chosen shape+colour persisted, unknown shape rejected", async () => {
    const { color: _c, ...noColor } = agentBody("AvatarDefault");
    const r = await api<Agent>("POST", "/api/agents", noColor);
    expect(r.status).toBe(201);
    expect(r.data.avatarShape).toBe(defaultAvatar(r.data.id).shape);
    expect(r.data.color).toBe(defaultAvatar(r.data.id).color);
    const put = await api<Agent>("PUT", `/api/agents/${r.data.id}`, {
      ...agentBody("AvatarDefault"),
      avatarShape: "hex",
      color: "#2f4a6d",
    });
    expect(put.data).toMatchObject({ avatarShape: "hex", color: "#2f4a6d" });
    const listed = (await api<Agent[]>("GET", "/api/agents")).data.find((a) => a.id === r.data.id);
    expect(listed?.avatarShape).toBe("hex");
    const bad = await api("PUT", `/api/agents/${r.data.id}`, {
      ...agentBody("AvatarDefault"),
      avatarShape: "triangle!",
    });
    expect(bad.status).toBe(400);
  });

  test("human @A -> A @B -> B replies, streamed over WS with routing recorded", async () => {
    const { messages, routing } = await say(room.id, "@Alice 帮忙看下");
    const view = messages.map((m) => [m.senderName, m.hop, m.status]);
    expect(view).toEqual([
      ["Andy", 0, "done"],
      ["Alice", 1, "done"],
      ["Bob", 2, "done"],
    ]);
    expect(messages[1]?.content).toBe("这个交给 Bob 处理。");
    expect(messages[1]?.toolCalls.map((c) => [c.name, JSON.parse(c.arguments), c.status])).toEqual([
      ["handoff", { agent: "Bob", task: "请你来处理这个问题" }, "ok"],
    ]);
    expect(messages[2]?.content).toContain("我是 Bob");
    expect(messages.every((m) => m.runId === messages[0]?.id)).toBe(true);

    expect(routing).toHaveLength(2);
    for (const r of routing) {
      expect(r.plan.mode).toBe("auto");
      expect(r.plan.classification?.source).toBe("llm");
      expect(r.chosenModel).toBe(r.plan.candidates[0] ?? "missing");
      // Alice makes two model calls (handoff tool call, then the reply); every attempt succeeds on the first candidate.
      for (const at of r.attempts) expect(at).toEqual({ modelId: r.chosenModel as string, ok: true });
    }

    const bobId = messages[2]?.id;
    const deltas = events
      .filter((e) => e.type === "delta" && e.messageId === bobId)
      .map((e) => e.text)
      .join("");
    expect(deltas).toBe(messages[2]?.content ?? "x");
    expect(events.some((e) => e.type === "routing")).toBe(true);
    expect(events.filter((e) => e.type === "room.state").at(-1)).toMatchObject({
      state: { activeRunId: null, queued: 0 },
    });
  });

  test("a group message without @ goes to ONE agent picked by topic (mock picker is deterministic)", async () => {
    const { messages, routing } = await say(room.id, "大家好");
    const turn = messages.slice(messages.findLastIndex((m) => m.senderKind === "human"));
    // No keyword overlap → first member (Alice); Alice's scripted reply hands off to Bob explicitly.
    expect(turn.filter((m) => m.senderKind === "agent").map((m) => [m.senderName, m.hop])).toEqual([
      ["Alice", 1],
      ["Bob", 2],
    ]);
    const alice = turn.find((m) => m.senderName === "Alice") as Message;
    const sel = routing.find((d) => d.messageId === alice.id)?.plan.selection;
    expect(sel).toMatchObject({ agentName: "Alice", by: "llm" });
    expect(sel?.reason).toContain("mock/small");
    const bob = turn.find((m) => m.senderName === "Bob") as Message;
    expect(routing.find((d) => d.messageId === bob.id)?.plan.selection).toBeUndefined();
  });

  test("@所有人 is reserved and cannot be an agent name", async () => {
    expect((await api("POST", "/api/agents", agentBody("所有人"))).status).toBe(400);
    expect((await api("POST", "/api/agents", agentBody("ALL"))).status).toBe(400);
  });

  test("hop limit stops an A<->B loop and says so", async () => {
    const p = await createAgent("PingBot", "[[handoff:PongBot 该你了]][[reply:交给 PongBot]]");
    const q = await createAgent("PongBot", "[[handoff:PingBot 该你了]][[reply:交给 PingBot]]");
    const r = await createRoom("循环群", "group", [p.id, q.id]);
    const { messages } = await say(r.id, "@PingBot 开始");
    const agents = messages.filter((m) => m.senderKind === "agent");
    // hop 1 is triggered by the human; hops 2..4 are the 3 allowed agent-to-agent triggers.
    expect(agents.map((m) => [m.senderName, m.hop])).toEqual([
      ["PingBot", 1],
      ["PongBot", 2],
      ["PingBot", 3],
      ["PongBot", 4],
    ]);
    const last = messages.at(-1);
    expect(last?.senderKind).toBe("system");
    expect(last?.content).toContain("最多 3 次");
    expect(last?.content).toContain("@PingBot");
  });

  test("an agent mentioning itself does not trigger itself", async () => {
    const s = await createAgent("Narcissus", "[[handoff:Narcissus 我又来了]][[reply:@Narcissus 我又来了]]");
    const r = await createRoom("自恋群", "group", [s.id]);
    const { messages } = await say(r.id, "@Narcissus 你好");
    expect(messages.filter((m) => m.senderKind === "agent")).toHaveLength(1);
  });

  test("agents not in the room are not triggered", async () => {
    const outsider = await createAgent("Outsider");
    const r = await createRoom("单人群", "group", [b.id]);
    const { messages } = await say(r.id, `@${outsider.name} @Bob 在吗`);
    expect(messages.filter((m) => m.senderKind === "agent").map((m) => m.senderName)).toEqual(["Bob"]);
  });

  test("DM: every message goes to the single agent; tool calls and fallback are recorded", async () => {
    const calc = await createAgent("Calc", "", { tools: ["builtin:calculator"] });
    const dm = await createRoom("和 Calc 私聊", "dm", [calc.id]);
    const { messages, routing } = await say(dm.id, '算一下 [[tool:calculator {"expression":"12*12"}]] [[fail:small]]');
    const reply = messages.at(-1) as Message;
    expect(reply.senderName).toBe("Calc");
    expect(reply.toolCalls).toMatchObject([{ name: "calculator", status: "ok", result: "144" }]);
    expect(reply.content).toContain("144");
    const decision = routing.find((d) => d.messageId === reply.id) as RoutingDecision;
    // Classifier (mock/small) failed -> rules; first candidate mock/small failed -> next one.
    expect(decision.plan.classification?.source).toBe("rules");
    expect(decision.plan.classification?.classifierError).toContain("模拟失败");
    expect(decision.attempts[0]).toMatchObject({ modelId: "mock/small", ok: false });
    expect(decision.chosenModel).not.toBe("mock/small");
  });

  test("pinned model with all candidates failing ends in a truthful error", async () => {
    const pinned = await createAgent("Pinned", "", { modelMode: "pinned", pinnedModel: "mock/small" });
    const dm = await createRoom("固定模型", "dm", [pinned.id]);
    const { messages, routing } = await say(dm.id, "hi [[fail:small]]");
    const reply = messages.at(-1) as Message;
    expect(reply.status).toBe("error");
    expect(reply.error).toContain("所有候选模型均失败");
    expect(routing[0]).toMatchObject({ chosenModel: null, plan: { mode: "pinned", candidates: ["mock/small"] } });
  });

  test("cancel aborts the running reply and drops queued messages", async () => {
    const slow = await createAgent("Slow");
    const dm = await createRoom("慢", "dm", [slow.id]);
    process.env.MOCK_CHUNK_DELAY_MS = "40";
    try {
      await api("POST", `/api/rooms/${dm.id}/messages`, { content: "第一条消息，内容要长一些以便有足够的流式分片" });
      await api("POST", `/api/rooms/${dm.id}/messages`, { content: "第二条（排队）" });
      expect(app.orchestrator.state(dm.id).queued).toBe(1);
      await Bun.sleep(120);
      expect((await api<{ cancelled: boolean }>("POST", `/api/rooms/${dm.id}/cancel`)).data.cancelled).toBe(true);
      await app.orchestrator.idle(dm.id);
    } finally {
      process.env.MOCK_CHUNK_DELAY_MS = "0";
    }
    const { messages } = (await api<{ messages: Message[] }>("GET", `/api/rooms/${dm.id}/messages`)).data;
    const agentMsgs = messages.filter((m) => m.senderKind === "agent");
    expect(agentMsgs).toHaveLength(1);
    expect(agentMsgs[0]?.status).toBe("cancelled");
    expect(messages.some((m) => m.senderKind === "system" && m.content.includes("1 条消息不会再触发"))).toBe(true);
    expect((await api("POST", `/api/rooms/${dm.id}/cancel`)).data).toEqual({ cancelled: false });
  });

  test("validation: duplicate names, bad tools, bad pinned model, dm membership", async () => {
    expect((await api("POST", "/api/agents", agentBody("alice"))).status).toBe(409);
    expect((await api("POST", "/api/agents", agentBody("Has Space"))).status).toBe(400);
    const badTool = await api<{ error: string }>(
      "POST",
      "/api/agents",
      agentBody("T1", "", { tools: ["builtin:rm_rf"] }),
    );
    expect(badTool).toEqual({ status: 400, data: { error: "未知工具：builtin:rm_rf" } });
    expect(
      (await api("POST", "/api/agents", agentBody("T2", "", { modelMode: "pinned", pinnedModel: "x/y" }))).status,
    ).toBe(400);
    expect((await api("POST", "/api/agents", agentBody("T3", "", { skills: ["code-review"] }))).status).toBe(201);
    expect((await api("POST", "/api/rooms", { name: "dm", kind: "dm", agentIds: [a.id, b.id] })).status).toBe(400);
    expect((await api("GET", "/api/rooms/nope/messages")).status).toBe(404);
  });

  test("editing and deleting an agent", async () => {
    const t = await createAgent("Temp");
    const upd = await api<Agent>("PUT", `/api/agents/${t.id}`, agentBody("Temp2", "新提示词", { color: "#000000" }));
    expect(upd.data).toMatchObject({ name: "Temp2", systemPrompt: "新提示词", createdAt: t.createdAt });
    expect((await api("DELETE", `/api/agents/${t.id}`)).status).toBe(200);
    expect((await api("DELETE", `/api/agents/${t.id}`)).status).toBe(404);
  });

  test("meta exposes models, builtin tools and skills", async () => {
    const meta = (
      await api<{ models: unknown[]; builtinTools: { id: string }[]; skills: { name: string }[] }>("GET", "/api/meta")
    ).data;
    expect(meta.builtinTools.map((t) => t.id).sort()).toEqual([
      "builtin:calculator",
      "builtin:current_time",
      "builtin:web_fetch",
    ]);
    expect(meta.skills.map((s) => s.name)).toContain("code-review");
    expect(meta.models).toHaveLength(3);
  });
});
