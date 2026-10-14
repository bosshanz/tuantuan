import { afterAll, describe, expect, test } from "bun:test";
import { serve } from "../server/app";
import type { AppConfig } from "../server/config";
import { loadSkills } from "../server/skills";
import type { Agent, Message, Room } from "../server/store";
import { testConfig } from "./helpers";

// Exercises the real OpenAI-compatible path (not the mock) with a fake upstream whose replies
// look like what real chat models write in a group: quoting the user, echoing "[name]:", @-ing people.
const calls: string[] = [];
const lastSystemFor: Record<string, string> = {};
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as {
      messages: { role: string; content: string }[];
      tools?: { function: { name: string } }[];
    };
    const system = body.messages[0]?.content ?? "";
    const name = /你的名字是「([^」]+)」/.exec(system)?.[1] ?? "?";
    calls.push(name);
    lastSystemFor[name] = system;
    const script = /SCRIPT<<([\s\S]*?)>>/.exec(system)?.[1] ?? `我是 ${name}。`;
    // HANDOFF<<name|task>> → first call answers with a real tool call (if the handoff tool is offered).
    const ho = /HANDOFF<<([^|]+)\|([^>]*)>>/.exec(system);
    const offered = (body.tools ?? []).some((t) => t.function.name === "handoff");
    if (ho && offered && !body.messages.some((m) => m.role === "tool")) {
      const call = {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "handoff", arguments: JSON.stringify({ agent: ho[1], task: ho[2] }) },
      };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (system.includes("SLOW")) {
      // Streams slowly so a test can interject mid-generation.
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(ctrl) {
          for (let i = 0; i < 40; i++) {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `片段${i} ` } }] })}\n\n`));
            await Bun.sleep(25);
          }
          ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
          ctrl.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    const chunks = [script.slice(0, 3), script.slice(3)].filter(Boolean);
    return new Response(
      `${chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
process.env.GROUP_TEST_KEY = "k";
const config: AppConfig = {
  ...testConfig({ maxAgentHops: 5 }, {}),
  providers: [
    { id: "fake", type: "openai", baseUrl: `http://localhost:${upstream.port}/v1`, apiKeyEnv: "GROUP_TEST_KEY" },
    { id: "nokey", type: "openai", baseUrl: `http://localhost:${upstream.port}/v1`, apiKeyEnv: "GROUP_TEST_UNSET" },
  ],
  models: [
    {
      id: "fake/m",
      provider: "fake",
      model: "m",
      tags: ["chat", "coding", "reasoning"],
      costTier: 1,
      contextWindow: 100000,
    },
    { id: "nokey/m", provider: "nokey", model: "m", tags: ["chat"], costTier: 1, contextWindow: 100000 },
  ],
};
const { app, server } = serve({ config, configSource: "test", skills: loadSkills("skills"), dbPath: ":memory:" }, 0);
afterAll(() => {
  server.stop(true);
  upstream.stop(true);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://localhost:${server.port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}
const agent = (name: string, script?: string, pinned?: string) =>
  api<Agent>("POST", "/api/agents", {
    name,
    color: "#336699",
    avatar: name.slice(0, 1),
    systemPrompt: script ? `SCRIPT<<${script}>>` : "",
    tools: [],
    skills: [],
    modelMode: pinned ? "pinned" : "auto",
    pinnedModel: pinned ?? null,
  });
async function say(room: Room, content: string) {
  calls.length = 0;
  await api("POST", `/api/rooms/${room.id}/messages`, { senderName: "Andy", content });
  await app.orchestrator.idle(room.id);
  const { messages } = await api<{ messages: Message[] }>("GET", `/api/rooms/${room.id}/messages`);
  return messages.slice(messages.findLastIndex((m) => m.senderKind === "human"));
}
const replies = (ms: Message[]) => ms.filter((m) => m.senderKind === "agent").map((m) => [m.senderName, m.hop]);

describe("group routing on the real provider path", () => {
  test("no @ → exactly one member, picked by topic (rules when no classifier is configured)", async () => {
    const a = await agent("Ann", "负责前端页面和交互设计");
    const b = await agent("Ben", "负责数据库和后端接口性能");
    const room = await api<Room>("POST", "/api/rooms", { name: "g1", kind: "group", agentIds: [a.id, b.id] });
    const ms = await say(room, "数据库查询越来越慢了怎么办？");
    expect(replies(ms)).toEqual([["Ben", 1]]);
    expect(calls).toEqual(["Ben"]);
    const { routing } = await api<{ routing: { messageId: string; plan: { selection?: Record<string, unknown> } }[] }>(
      "GET",
      `/api/rooms/${room.id}/messages`,
    );
    const ben = ms.find((m) => m.senderName === "Ben") as Message;
    expect(routing.find((d) => d.messageId === ben.id)?.plan.selection).toMatchObject({
      by: "rules",
      agentName: "Ben",
    });
    // No overlap at all → deterministic default: first member.
    expect(replies(await say(room, "嗯嗯"))).toEqual([["Ann", 1]]);
  });

  test("@所有人 / @all → every member once in member order; hand-offs to someone who already answered are skipped", async () => {
    const a = await agent("Amy", "HANDOFF<<Bob2|这个你来补充>>SCRIPT<<交给 Bob2。>>");
    const b = await agent("Bob2", "HANDOFF<<Amy|再补充一点>>SCRIPT<<交给 Amy。>>");
    const c = await agent("Cat");
    const room = await api<Room>("POST", "/api/rooms", { name: "g5", kind: "group", agentIds: [a.id, b.id, c.id] });
    expect(replies(await say(room, "@所有人 周报写好了吗"))).toEqual([
      ["Amy", 1],
      ["Bob2", 1],
      ["Cat", 1],
    ]);
    expect(replies(await say(room, "@all status?"))).toHaveLength(3);
    // A quoted or code @所有人 is not a broadcast; it falls back to one picked responder.
    // (Amy and Bob2 then hand off explicitly to each other, bounded by maxAgentHops.)
    expect(replies(await say(room, "`@所有人` 这个写法是什么意思")).filter(([, hop]) => hop === 1)).toHaveLength(1);
  });

  test("a new message interrupts the running chain: in-flight reply kept as partial, pending hops dropped", async () => {
    const s = await agent("Slo", "SLOW");
    const t = await agent("Tia");
    const room = await api<Room>("POST", "/api/rooms", { name: "g6", kind: "group", agentIds: [s.id, t.id] });
    calls.length = 0;
    await api("POST", `/api/rooms/${room.id}/messages`, { senderName: "Andy", content: "@Slo @Tia 讲讲" });
    await Bun.sleep(200);
    await api("POST", `/api/rooms/${room.id}/messages`, { senderName: "Andy", content: "@Tia 算了，换个问题" });
    await app.orchestrator.idle(room.id);
    await Bun.sleep(20);
    const { messages } = await api<{ messages: Message[] }>("GET", `/api/rooms/${room.id}/messages`);
    const slo = messages.find((m) => m.senderName === "Slo") as Message;
    expect(slo.status).toBe("cancelled");
    expect(slo.error).toBe("被新消息打断");
    expect(slo.content).toContain("片段0");
    expect(slo.content).not.toContain("片段39");
    expect(messages.find((m) => m.senderKind === "system")?.content).toBe("被新消息打断，未执行的触发：@Tia");
    // Tia answered only the new message.
    const tia = messages.filter((m) => m.senderName === "Tia");
    expect(tia).toHaveLength(1);
    expect(messages.indexOf(tia[0] as Message)).toBeGreaterThan(
      messages.findIndex((m) => m.content.startsWith("@Tia 算了")),
    );
  });

  test("@one → only that agent, even if its reply quotes the user's @s or echoes a transcript line", async () => {
    const quoter = await agent(
      "Quinn",
      "> [Andy]: @Rex @Sam 大家好\n[Andy]: @Rex 你也说说\n收到，我来答。代码里写 `@Sam` 也不算。",
    );
    const r = await agent("Rex");
    const s = await agent("Sam");
    const room = await api<Room>("POST", "/api/rooms", {
      name: "g2",
      kind: "group",
      agentIds: [quoter.id, r.id, s.id],
    });
    const ms = await say(room, "@Quinn 你好");
    expect(replies(ms)).toEqual([["Quinn", 1]]);
    expect(calls).toEqual(["Quinn"]);
  });

  test("an explicit hand-off still chains; an agent already queued is not run twice", async () => {
    const a = await agent("Ada", "HANDOFF<<Bea|这个请你补充>>SCRIPT<<交给 Bea 补充。>>");
    const b = await agent("Bea");
    const c = await agent("Cid");
    const room = await api<Room>("POST", "/api/rooms", { name: "g3", kind: "group", agentIds: [a.id, b.id, c.id] });
    expect(replies(await say(room, "@Ada 请看下"))).toEqual([
      ["Ada", 1],
      ["Bea", 2],
    ]);
    // Human @Ada @Bea: Ada's hand-off to Bea must not make Bea answer twice.
    expect(replies(await say(room, "@Ada @Bea 你们怎么看"))).toEqual([
      ["Ada", 1],
      ["Bea", 1],
    ]);
  });

  test("Andy's case: an offer to @ someone in reply text is NOT a hand-off; only the handoff tool is", async () => {
    const pm = await agent(
      "产品经理",
      "SCRIPT<<你好！另外需要中英互译或文案润色的话，我可以让 @翻译助手 接手。说吧，这次要解决什么问题？>>",
    );
    const tr = await agent("翻译助手");
    const room = await api<Room>("POST", "/api/rooms", { name: "g7", kind: "group", agentIds: [pm.id, tr.id] });
    expect(replies(await say(room, "@产品经理 大家好"))).toEqual([["产品经理", 1]]);
    expect(calls).toEqual(["产品经理"]);
    // The same agent with an explicit handoff call does trigger the translator, who sees the task.
    const pm2 = await agent(
      "产品经理二号",
      "HANDOFF<<翻译助手|把这句话译成英文：你好>>SCRIPT<<这句交给翻译助手翻译。>>",
    );
    const room2 = await api<Room>("POST", "/api/rooms", { name: "g8", kind: "group", agentIds: [pm2.id, tr.id] });
    const ms = await say(room2, "@产品经理二号 帮我把“你好”翻成英文");
    expect(replies(ms)).toEqual([
      ["产品经理二号", 1],
      ["翻译助手", 2],
    ]);
    expect(lastSystemFor["翻译助手"]).toContain("「产品经理二号」把这项工作交给了你：把这句话译成英文：你好");
  });

  test("missing API key: only the mentioned agent answers, with a truthful error", async () => {
    const k = await agent("Kay", undefined, "nokey/m");
    const l = await agent("Lou", undefined, "nokey/m");
    const room = await api<Room>("POST", "/api/rooms", { name: "g4", kind: "group", agentIds: [k.id, l.id] });
    const ms = await say(room, "@Kay 在吗");
    const agentMsgs = ms.filter((m) => m.senderKind === "agent");
    expect(agentMsgs.map((m) => [m.senderName, m.status])).toEqual([["Kay", "error"]]);
    expect(agentMsgs[0]?.error).toContain("GROUP_TEST_UNSET");
  });
});
