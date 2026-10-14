import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { serve } from "../server/app";
import { MAX_AGENT_HOPS, RELAY_MAX_CHARS } from "../server/orchestrator";
import type { Agent, Message, Room } from "../server/store";
import type { ReplayTurn } from "../shared/timeline";
import { agentInput, MOCK_AUTH_FILE, until } from "./helpers";

const { app, server } = serve({ dbPath: ":memory:", deviceAckTimeoutMs: 1000 }, 0);
const base = `http://localhost:${server.port}`;
afterAll(() => {
  app.host.shutdown();
  server.stop(true);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}
const agent = async (name: string, extra: Parameters<typeof agentInput>[1] = {}) =>
  (await api<Agent>("POST", "/api/agents", agentInput(name, extra))).data;
const room = async (name: string, kind: "group" | "dm", agentIds: string[], extra = {}) =>
  (await api<Room>("POST", "/api/rooms", { name, kind, agentIds, ...extra })).data;
async function say(roomId: string, content: string) {
  expect((await api("POST", `/api/rooms/${roomId}/messages`, { senderName: "Andy", content })).status).toBe(201);
  await app.orchestrator.idle(roomId);
  return (await api<{ messages: Message[] }>("GET", `/api/rooms/${roomId}/messages`)).data.messages;
}
const thought = (m: Message | undefined) =>
  m?.timeline?.parts
    .filter((p) => p.kind === "thought")
    .map((p) => ("text" in p ? p.text : ""))
    .join("") ?? "";
const tools = (m: Message | undefined) => Object.values(m?.timeline?.tools ?? {});

describe("handoff through Tuantuan's MCP server", () => {
  for (const transport of ["stdio", "http"] as const)
    test(`${transport}: handoff triggers the other member with the task; cards on both replies`, async () => {
      const env: Record<string, string> = transport === "http" ? { MOCK_AGENT_MCP_HTTP: "1" } : {};
      const a = await agent(`A_${transport}`, { env });
      const b = await agent(`B_${transport}`, { env });
      const g = await room("交接", "group", [a.id, b.id], { mainAgentId: a.id });
      const before = Date.now();
      const ms = await say(g.id, `/handoff ${b.name} 写个测试`);
      const [, ra, rb] = ms;
      expect(ra).toMatchObject({ senderName: a.name, status: "done", hop: 1 });
      expect(tools(ra)).toEqual([
        expect.objectContaining({
          title: "tuantuan/handoff",
          status: "completed",
          rawInput: { agent: b.name, task: "写个测试" },
        }),
      ]);
      expect(ra?.timeline?.handoffs).toEqual([{ agentId: b.id, agentName: b.name, task: "写个测试" }]);
      expect(rb).toMatchObject({ senderName: b.name, status: "done", hop: 2 });
      expect(rb?.content).toBe(`接手 @${a.name} 的任务「写个测试」（mock-fast）`);
      expect(rb?.timeline?.handoffFrom).toEqual({ agentId: a.id, agentName: a.name, task: "写个测试" });
      // B also gets the relay of what happened since it last spoke (it never did).
      expect(thought(rb)).toContain(`/handoff ${b.name} 写个测试`);
      expect(ms).toHaveLength(3);
      expect(Date.now() - before).toBeLessThan(15000);
    });

  test("only other members: unknown name and self are refused; nothing else triggers", async () => {
    const a = await agent("Solo");
    const b = await agent("Other");
    const g = await room("g", "group", [a.id, b.id], { mainAgentId: a.id });
    let ms = await say(g.id, "/handoff Nobody 做事");
    expect(ms).toHaveLength(2);
    const t = tools(ms[1])[0];
    expect(t?.status).toBe("failed");
    expect(JSON.stringify(t?.content)).toContain("可以交接给：Other");
    ms = await say(g.id, "/handoff Solo 做事");
    expect(ms).toHaveLength(4);
    expect(JSON.stringify(tools(ms[3])[0]?.content)).toContain("不能交接给自己");
  });

  test("list_members names everyone and the main agent", async () => {
    const a = await agent("Lead");
    const b = await agent("Dev");
    const g = await room("g", "group", [a.id, b.id], { mainAgentId: a.id });
    const ms = await say(g.id, "/members");
    expect(ms.at(-1)?.content).toContain("@Lead（你）（主 Agent）");
    expect(ms.at(-1)?.content).toContain("@Dev");
  });

  test("ping-pong hand-offs stop at the hop limit with a notice", async () => {
    const p = await agent("Ping", { identity: "[[handoff:Pong 该你了]]" });
    const q = await agent("Pong", { identity: "[[handoff:Ping 该你了]]" });
    const g = await room("loop", "group", [p.id, q.id], { mainAgentId: p.id });
    const ms = await say(g.id, "开始");
    const replies = ms.filter((m) => m.senderKind === "agent");
    expect(replies).toHaveLength(1 + MAX_AGENT_HOPS);
    expect(replies.map((r) => r.senderName).slice(0, 3)).toEqual(["Ping", "Pong", "Ping"]);
    expect(ms.at(-1)).toMatchObject({ senderKind: "system" });
    expect(ms.at(-1)?.content).toContain(`最多 ${MAX_AGENT_HOPS} 次`);
  });

  test("@所有人 round: a hand-off to someone who already answered does not trigger them again", async () => {
    const a = await agent("First", { identity: "[[handoff:Second 再看看]]" });
    const b = await agent("Second");
    const g = await room("all", "group", [a.id, b.id]);
    const ms = await say(g.id, "@所有人 报到");
    expect(ms.filter((m) => m.senderKind === "agent").map((m) => m.senderName)).toEqual(["First", "Second"]);
  });

  test("a new message interrupts the chain and drops pending hand-offs", async () => {
    const a = await agent("Slowpoke");
    const b = await agent("Waiter");
    const g = await room("int", "group", [a.id, b.id], { mainAgentId: a.id });
    await api("POST", `/api/rooms/${g.id}/messages`, { senderName: "Andy", content: "/slow" });
    await until(() => app.orchestrator.state(g.id).activeRunId);
    await Bun.sleep(300);
    const ms = await say(g.id, "算了");
    const first = ms.find((m) => m.senderKind === "agent");
    expect(first).toMatchObject({ status: "cancelled", error: "被新消息打断" });
    expect(ms.at(-1)?.content).toBe("收到：「算了」（mock-fast）");
  });

  test("DMs get no Tuantuan tools", async () => {
    const a = await agent("Lonely");
    const d = await room("dm", "dm", [a.id]);
    const ms = await say(d.id, "/members");
    expect(JSON.stringify(tools(ms.at(-1))[0]?.content)).toContain("没有 tuantuan MCP 服务");
  });

  test("MCP endpoint rejects unknown tokens and non-POST", async () => {
    expect((await fetch(`${base}/mcp/nope`, { method: "POST", body: "{}" })).status).toBe(404);
    const token = app.mcp.tokenFor({ roomId: "x", agentId: "y" });
    expect((await fetch(`${base}/mcp/${token}`)).status).toBe(405);
    const r = await fetch(`${base}/mcp/${token}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(await r.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  });
});

describe("group relay (群聊转述)", () => {
  test("only what the agent has not seen, newest kept under the size cap", async () => {
    const a = await agent("Reader");
    const b = await agent("Talker");
    const g = await room("relay", "group", [a.id, b.id], { mainAgentId: b.id });
    await say(g.id, "@Reader 第一句");
    for (let i = 0; i < 6; i++) await say(g.id, `${"长".repeat(2500)}${i}`);
    const ms = await say(g.id, "@Reader 最后");
    const t = thought(ms.at(-1));
    expect(t).toContain("你上次发言之后，群里的新消息（更早的");
    expect(t).not.toContain("第一句");
    expect(t).toContain("（已截断）");
    expect(t).toContain("[Talker（Agent）]");
    expect(t).toContain("[Andy]: @Reader 最后");
    expect(t.length).toBeLessThan(RELAY_MAX_CHARS + 1000);
  });
});

describe("robot tools", () => {
  test("set_expression / play_action reach the device and wait for its ack; speak sets what is read aloud", async () => {
    const a = await agent("Robo");
    const sent: { type: string; id?: string; name?: string; spoken?: string; status?: string }[] = [];
    const conn = app.devices.open({
      send: (d) => {
        const m = JSON.parse(d);
        sent.push(m);
        if (m.type === "expression" || m.type === "action")
          app.devices.handle(conn, JSON.stringify({ type: "ack", id: m.id, ok: true }));
      },
      close: () => {},
    });
    app.devices.handle(
      conn,
      JSON.stringify({
        type: "hello",
        protocol: 1,
        deviceId: "dev-1",
        agentId: a.id,
        capabilities: { expressions: ["happy"], actions: ["dance"], asr: false, tts: true },
      }),
    );
    const roomId = conn.session?.roomId as string;
    let ms = await say(roomId, "/express happy");
    expect(sent.find((m) => m.type === "expression")).toMatchObject({ name: "happy" });
    expect(tools(ms.at(-1))[0]).toMatchObject({ title: "tuantuan/set_expression", status: "completed" });
    ms = await say(roomId, "/act dance");
    expect(sent.find((m) => m.type === "action")).toMatchObject({ name: "dance" });
    ms = await say(roomId, "/act fly");
    expect(tools(ms.at(-1))[0]?.status).toBe("failed");
    ms = await say(roomId, "/say 我跳完了");
    expect(ms.at(-1)?.timeline?.spoken).toBe("我跳完了");
    const end = sent.filter((m) => m.type === "reply.end").at(-1);
    expect(end?.spoken).toBe("我跳完了");
    // Without speak, the device gets a short speakable version of the reply.
    await say(roomId, "```js\nconsole.log(1)\n```");
    expect(sent.filter((m) => m.type === "reply.end").at(-1)?.spoken).toContain("（代码略）");
  });
});

describe("onboarding auth", () => {
  test("logged out → authenticate via the harness's agent-driven method → logged in", async () => {
    rmSync(MOCK_AUTH_FILE, { force: true });
    try {
      const t = (
        await api<{ loggedIn: boolean; authMethods: { id: string; type: string }[] }>(
          "POST",
          "/api/harnesses/mock/test",
        )
      ).data;
      expect(t.loggedIn).toBe(false);
      expect(t.authMethods).toEqual([expect.objectContaining({ id: "mock-login", type: "agent" })]);
      const r = (
        await api<{ loggedIn: boolean }>("POST", "/api/harnesses/mock/authenticate", { methodId: "mock-login" })
      ).data;
      expect(r.loggedIn).toBe(true);
      expect((await api("POST", "/api/harnesses/mock/authenticate", { methodId: "nope" })).status).toBe(400);
    } finally {
      writeFileSync(MOCK_AUTH_FILE, "ok");
    }
  });
});

describe("session/load replay", () => {
  test("history the harness replays shows up, minus turns the room already has", async () => {
    const a = await agent("Historian");
    const r1 = await room("r1", "dm", [a.id]);
    await say(r1.id, "外部历史");
    const s1 = (await api<{ sessionId: string }>("GET", `/api/rooms/${r1.id}/agents/${a.id}/session`)).data.sessionId;
    const r2 = await room("r2", "dm", [a.id]);
    await say(r2.id, "本地消息");
    const list = (await api<{ sessionId: string }[]>("GET", `/api/rooms/${r2.id}/agents/${a.id}/history`)).data;
    expect(list.map((x) => x.sessionId)).toContain(s1);
    await api("POST", `/api/rooms/${r2.id}/agents/${a.id}/session`, { sessionId: s1 });
    const replay = (await api<ReplayTurn[]>("GET", `/api/rooms/${r2.id}/agents/${a.id}/replay`)).data;
    expect(replay.map((t) => t.user)).toEqual(["外部历史"]);
    expect(replay[0]?.reply.parts.some((p) => p.kind === "text")).toBe(true);
    // Back in r1 the same session's turns are already in the transcript: nothing extra.
    await api("POST", `/api/rooms/${r1.id}/agents/${a.id}/session`, { sessionId: s1 });
    expect((await api<ReplayTurn[]>("GET", `/api/rooms/${r1.id}/agents/${a.id}/replay`)).data).toEqual([]);
  });
});
