import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import { MAX_AGENT_HOPS, RELAY_MAX_CHARS } from "../server/orchestrator";
import type { Agent, Message, Room } from "../server/store";
import { missingKeyVar } from "../shared/auth";
import type { ReplayTurn } from "../shared/timeline";
import { agentInput, MOCK_AUTH_FILE, until } from "./helpers";

const { app, server } = serve({ dbPath: ":memory:" }, 0);
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
const room = async (name: string, agentIds: string[], extra = {}) =>
  (await api<Room>("POST", "/api/rooms", { name, agentIds, ...extra })).data;
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
      const g = await room("交接", [a.id, b.id], { mainAgentId: a.id });
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
      expect(ms).toHaveLength(4);
      expect(ms[3]).toMatchObject({ senderName: a.name, status: "done", runId: ra?.runId });
      expect(ms[3]?.content).toStartWith("群主汇总：");
      expect(ms[3]?.content).toContain(rb?.content ?? "missing member result");
      expect(Date.now() - before).toBeLessThan(15000);
    });

  test("the mock leader collects two real MCP handoffs in one final summary", async () => {
    const lead = await agent("Coordinator");
    const dev = await agent("Implementer");
    const reviewer = await agent("Reviewer");
    const g = await room("coordinated ACP", [lead.id, dev.id, reviewer.id], { mainAgentId: lead.id });
    const ms = await say(g.id, `/coordinate ${dev.name} ${reviewer.name}`);
    const replies = ms.filter((m) => m.senderKind === "agent");
    expect(replies.map((m) => m.senderName)).toEqual([lead.name, dev.name, reviewer.name, lead.name]);
    expect(replies.every((m) => m.status === "done" && m.runId === ms[0]?.id)).toBe(true);
    expect(tools(replies[0]).map((t) => t.title)).toEqual(["tuantuan/handoff", "tuantuan/handoff"]);
    const summary = replies[3];
    expect(summary?.content).toStartWith("群主汇总：");
    for (const result of replies.slice(1, 3)) {
      expect(summary?.content).toContain(`${result.senderName} [done]：${result.content}`);
    }
  });

  test("only other members: unknown name and self are refused; nothing else triggers", async () => {
    const a = await agent("Solo");
    const b = await agent("Other");
    const g = await room("g", [a.id, b.id], { mainAgentId: a.id });
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
    const g = await room("g", [a.id, b.id], { mainAgentId: a.id });
    const ms = await say(g.id, "/members");
    expect(ms.at(-1)?.content).toContain("@Lead（你）（主 Agent）");
    expect(ms.at(-1)?.content).toContain("@Dev");
  });

  test("ping-pong hand-offs stop at the hop limit with a notice", async () => {
    const p = await agent("Ping", { identity: "[[handoff:Pong 该你了]]" });
    const q = await agent("Pong", { identity: "[[handoff:Ping 该你了]]" });
    const g = await room("loop", [p.id, q.id], { mainAgentId: p.id });
    const ms = await say(g.id, "@Ping 开始");
    const replies = ms.filter((m) => m.senderKind === "agent");
    expect(replies).toHaveLength(1 + MAX_AGENT_HOPS);
    expect(replies.map((r) => r.senderName).slice(0, 3)).toEqual(["Ping", "Pong", "Ping"]);
    expect(ms.some((m) => m.senderKind === "system" && m.content.includes(`最多 ${MAX_AGENT_HOPS} 次`))).toBe(true);
  });

  test("@所有人 round: a hand-off to someone who already answered does not trigger them again", async () => {
    const a = await agent("First", { identity: "[[handoff:Second 再看看]]" });
    const b = await agent("Second");
    const g = await room("all", [a.id, b.id]);
    const ms = await say(g.id, "@所有人 报到");
    expect(ms.filter((m) => m.senderKind === "agent").map((m) => m.senderName)).toEqual(["First", "Second"]);
  });

  test("a new message queues behind the same agent without interrupting", async () => {
    const a = await agent("Slowpoke");
    const b = await agent("Waiter");
    const g = await room("int", [a.id, b.id], { mainAgentId: a.id });
    await api("POST", `/api/rooms/${g.id}/messages`, { senderName: "Andy", content: "/slow" });
    await until(() => app.orchestrator.state(g.id).activeRunId);
    await Bun.sleep(300);
    const ms = await say(g.id, "算了");
    const first = ms.find((m) => m.senderKind === "agent");
    expect(first).toMatchObject({ status: "done", error: null });
    expect(ms.at(-1)?.content).toBe("收到：「算了」（mock-fast）");
  }, 12_000);

  test("real mock ACP streams two members concurrently and targeted stop preserves the sibling", async () => {
    const a = await agent("ParallelA");
    const b = await agent("ParallelB");
    const g = await room("parallel ACP", [a.id, b.id]);
    await api("POST", `/api/rooms/${g.id}/messages`, { senderName: "Andy", content: "/slow @所有人" });
    await until(
      () =>
        app.store.recentMessages(g.id, 10).filter((m) => m.status === "streaming" && m.content.length > 0).length === 2,
    );
    const tasks = app.orchestrator.state(g.id).tasks;
    expect(tasks).toHaveLength(2);
    const stopping = tasks.find((t) => t.agentId === a.id);
    const sibling = tasks.find((t) => t.agentId === b.id);
    expect(stopping?.messageId).toBeDefined();
    expect(sibling?.messageId).toBeDefined();
    expect((await api("POST", `/api/rooms/${g.id}/cancel`, {})).status).toBe(400);
    expect(
      (await api<{ cancelled: boolean }>("POST", `/api/rooms/${g.id}/cancel`, { taskId: stopping?.id })).data.cancelled,
    ).toBe(true);
    await app.orchestrator.idle(g.id);
    expect(app.store.getMessage(stopping?.messageId as string)?.status).toBe("cancelled");
    expect(app.store.getMessage(sibling?.messageId as string)?.status).toBe("done");
  }, 12_000);

  test("DMs get no Tuantuan tools", async () => {
    const a = await agent("Lonely");
    const d = await room("dm", [a.id]);
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

describe("group relay (会话转述)", () => {
  test("only what the agent has not seen, newest kept under the size cap", async () => {
    const a = await agent("Reader");
    const b = await agent("Talker");
    const g = await room("relay", [a.id, b.id], { mainAgentId: b.id });
    await say(g.id, "@Reader 第一句");
    for (let i = 0; i < 6; i++) await say(g.id, `${"长".repeat(2500)}${i}`);
    const ms = await say(g.id, "@Reader 最后");
    const t = thought(ms.at(-1));
    expect(t).toContain("你上次发言之后，会话里的新消息（更早的");
    expect(t).not.toContain("第一句");
    expect(t).toContain("（中间已省略）");
    expect(t).toContain("[Talker（Agent）]");
    expect(t).toContain("[Andy]: @Reader 最后");
    expect(t.length).toBeLessThan(RELAY_MAX_CHARS + 1000);
  });
});

describe("onboarding auth", () => {
  test("logged out → authenticate via the harness's agent-driven method → logged in", async () => {
    rmSync(MOCK_AUTH_FILE, { force: true });
    try {
      const t = (
        await api<{ loggedIn: boolean; sessionError: string | null; authMethods: { id: string; type: string }[] }>(
          "POST",
          "/api/harnesses/mock/test",
        )
      ).data;
      expect(t.loggedIn).toBe(false);
      expect(t.sessionError).toBe("Authentication required");
      expect(t.authMethods).toEqual([expect.objectContaining({ id: "mock-login", type: "agent" })]);
      const r = (
        await api<{ loggedIn: boolean; sessionError: string | null }>("POST", "/api/harnesses/mock/authenticate", {
          methodId: "mock-login",
        })
      ).data;
      expect(r.loggedIn).toBe(true);
      expect(r.sessionError).toBeNull();
      expect((await api("POST", "/api/harnesses/mock/authenticate", { methodId: "nope" })).status).toBe(400);
    } finally {
      writeFileSync(MOCK_AUTH_FILE, "ok");
    }
  });

  test("agent-driven login keeps a missing-key session diagnostic even when it contains auth.type", async () => {
    const previous = app.store.getSetting<Record<string, Record<string, string>>>("harnessEnv", {});
    const diagnostic =
      "auth.type is set to 'gemini-api-key', but the GEMINI_API_KEY environment variable is not set. Set GEMINI_API_KEY before starting.";
    app.store.setSetting("harnessEnv", {
      ...previous,
      mock: { ...previous.mock, MOCK_AGENT_SESSION_ERROR: diagnostic },
    });
    try {
      const response = await api<{
        ok: boolean;
        loggedIn: boolean | null;
        sessionError: string | null;
        authError: string | null;
        authMethods: { id: string; type: string; vars: string[] | null }[];
      }>("POST", "/api/harnesses/mock/authenticate", { methodId: "mock-login" });
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        ok: true,
        loggedIn: false,
        authError: null,
        sessionError: `Internal error: ${diagnostic}`,
        authMethods: [{ id: "mock-login", type: "agent", vars: null }],
      });
      expect(missingKeyVar(response.data.sessionError ?? "")).toBe("GEMINI_API_KEY");
    } finally {
      app.store.setSetting("harnessEnv", previous);
    }
  });

  for (const [diagnostic, loggedIn] of [
    ["Mock author metadata unavailable", null],
    ["Authentication required (legacy adapter)", false],
  ] as const)
    test(`preserves session diagnostic and classifies ${diagnostic}`, async () => {
      const previous = app.store.getSetting<Record<string, Record<string, string>>>("harnessEnv", {});
      app.store.setSetting("harnessEnv", {
        ...previous,
        mock: { ...previous.mock, MOCK_AGENT_SESSION_ERROR: diagnostic },
      });
      try {
        const response = await api<{ ok: boolean; loggedIn: boolean | null; sessionError: string | null }>(
          "POST",
          "/api/harnesses/mock/test",
        );
        expect(response.status).toBe(200);
        expect(response.data).toMatchObject({
          ok: true,
          loggedIn,
          sessionError: `Internal error: ${diagnostic}`,
        });
      } finally {
        app.store.setSetting("harnessEnv", previous);
      }
    });
});

describe("session/load replay", () => {
  test("history the harness replays shows up, minus turns the room already has", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "tuantuan-collab-sessions-"));
    try {
      const a = await agent("Historian", { env: { MOCK_AGENT_SESSION_DIR: sessionDir } });
      const skillDir = join(sessionDir, "selected-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: history-skill\ndescription: private selection\n---\nBody");
      expect((await api("POST", `/api/agents/${a.id}/skills`, { action: "enable", key: skillDir })).status).toBe(200);
      const r1 = await room("r1", [a.id]);
      const initial = await say(r1.id, "外部历史");
      expect(initial.at(-1)?.content).toBe("收到：「外部历史」（mock-fast）");
      expect(thought(initial.at(-1))).not.toContain("tuantuan-response");
      const s1 = (await api<{ sessionId: string }>("GET", `/api/rooms/${r1.id}/agents/${a.id}/session`)).data.sessionId;
      const r2 = await room("r2", [a.id], { projectId: r1.projectId }); // same project folder → the harness lists r1's session
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
      // Group follow-ups also survive session/load, without exposing their internal role/result prompts.
      const member = await agent("HistoryMember");
      await api("PUT", `/api/rooms/${r1.id}/agents`, { agentIds: [a.id, member.id] });
      await say(r1.id, `/handoff ${member.name} 协作历史`);
      await api("POST", `/api/rooms/${r2.id}/agents/${a.id}/session`, { sessionId: s1 });
      const groupReplay = (await api<ReplayTurn[]>("GET", `/api/rooms/${r2.id}/agents/${a.id}/replay`)).data;
      expect(groupReplay.some((turn) => turn.user.includes("协作历史"))).toBe(true);
      expect(groupReplay.every((turn) => !turn.user.includes("tuantuan-coordination"))).toBe(true);
      expect(groupReplay.every((turn) => !turn.user.includes("tuantuan-results"))).toBe(true);
      expect(groupReplay.every((turn) => !turn.user.includes("tuantuan-response"))).toBe(true);
      expect(groupReplay.every((turn) => !turn.user.includes("tuantuan-skills") && !turn.user.includes(skillDir))).toBe(
        true,
      );
      expect(
        groupReplay.some((turn) =>
          turn.reply.parts.some((part) => part.kind === "text" && part.text.includes("群主汇总")),
        ),
      ).toBe(true);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
