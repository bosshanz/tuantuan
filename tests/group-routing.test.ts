import { afterAll, describe, expect, test } from "bun:test";
import { serve } from "../server/app";
import type { AppConfig } from "../server/config";
import { loadSkills } from "../server/skills";
import type { Agent, Message, Room } from "../server/store";
import { testConfig } from "./helpers";

// Exercises the real OpenAI-compatible path (not the mock) with a fake upstream whose replies
// look like what real chat models write in a group: quoting the user, echoing "[name]:", @-ing people.
const calls: string[] = [];
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]?.content ?? "";
    const name = /你的名字是「([^」]+)」/.exec(system)?.[1] ?? "?";
    calls.push(name);
    const script = /SCRIPT<<([\s\S]*?)>>/.exec(system)?.[1] ?? `我是 ${name}。`;
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
  test("no @ → nobody replies and no model is called", async () => {
    const a = await agent("Ann");
    const b = await agent("Ben");
    const room = await api<Room>("POST", "/api/rooms", { name: "g1", kind: "group", agentIds: [a.id, b.id] });
    const ms = await say(room, "大家好，今天开会吗？");
    expect(replies(ms)).toEqual([]);
    expect(calls).toEqual([]);
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
    const a = await agent("Ada", "@Bea 这个请你补充");
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
