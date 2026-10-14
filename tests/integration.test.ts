import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProcess } from "../server/acp";
import { serve } from "../server/app";
import type { SessionView } from "../server/host";
import type { RoomEvent } from "../server/orchestrator";
import type { Agent, Message, Project, Room } from "../server/store";
import { agentInput, until, WORKSPACES } from "./helpers";

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

async function createAgent(name: string, extra: Parameters<typeof agentInput>[1] = {}): Promise<Agent> {
  const r = await api<Agent>("POST", "/api/agents", agentInput(name, extra));
  expect(r.status).toBe(201);
  return r.data;
}

async function createRoom(name: string, agentIds: string[], extra: { cwd?: string; [k: string]: unknown } = {}) {
  const { cwd, ...rest } = extra;
  const projectId = cwd ? (await api<Project>("POST", "/api/projects", { name, cwd })).data.id : undefined;
  const r = await api<Room>("POST", "/api/rooms", { name, agentIds, projectId, ...rest });
  expect(r.status).toBe(201);
  return r.data;
}

const events: RoomEvent[] = [];
let ws: WebSocket;
const subscribed = new Set<string>();
async function watch(roomId: string) {
  if (subscribed.has(roomId)) return;
  subscribed.add(roomId);
  ws.send(JSON.stringify({ type: "subscribe", roomId }));
  await until(() =>
    events.some((e) => (e as { type: string }).type === "subscribed" && (e as { roomId?: string }).roomId === roomId),
  );
}

async function say(roomId: string, content: string, images: { mimeType: string; data: string }[] = []) {
  const r = await api<Message>("POST", `/api/rooms/${roomId}/messages`, { senderName: "Andy", content, images });
  expect(r.status).toBe(201);
  await app.orchestrator.idle(roomId);
  return (await api<{ messages: Message[] }>("GET", `/api/rooms/${roomId}/messages`)).data.messages;
}

beforeAll(async () => {
  ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  ws.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
});

describe("BYOK agent", () => {
  test("key is masked, replies stream, and handoff runs as a native tool call", async () => {
    let round = 0;
    const llm = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: { role: string }[]; tools?: unknown[] };
        const hasTool = body.messages.some((m) => m.role === "tool");
        round++;
        const chunks =
          body.tools && !hasTool
            ? [
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "t1",
                            function: { name: "handoff", arguments: '{"agent":"Mate","task":"接手"}' },
                          },
                        ],
                      },
                    },
                  ],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]
            : [{ choices: [{ delta: { content: "byok 回复" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
        return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const r = await api<Agent>("POST", "/api/agents", {
        ...agentInput("Byok"),
        harness: "custom",
        custom: {
          format: "openai-chat",
          baseUrl: `http://127.0.0.1:${llm.port}/v1`,
          model: "m",
          apiKey: "sk-secret-123456",
        },
      });
      expect(r.status).toBe(201);
      expect(JSON.stringify(r.data)).not.toContain("sk-secret-123456");
      expect(r.data.custom?.keyHint).toBe("sk-••••3456");
      // Saving without a key keeps the stored one.
      const u = await api<Agent>("PUT", `/api/agents/${r.data.id}`, {
        ...agentInput("Byok"),
        harness: "custom",
        custom: { format: "openai-chat", baseUrl: `http://127.0.0.1:${llm.port}/v1`, model: "m2" },
      });
      expect(u.data.custom?.keyHint).toBe("sk-••••3456");
      const t = await api<{ ok: boolean; reply: string }>("POST", "/api/custom/test", {
        format: "openai-chat",
        baseUrl: `http://127.0.0.1:${llm.port}/v1`,
        model: "m",
        agentId: r.data.id,
      });
      expect(t.data).toMatchObject({ ok: true, reply: "byok 回复" });

      const dmRoom = await createRoom("byok-dm", [r.data.id]);
      expect((await say(dmRoom.id, "你好")).at(-1)?.content).toBe("byok 回复");

      const mate = await createAgent("Mate");
      const g = await createRoom("byok-g", [r.data.id, mate.id], { mainAgentId: r.data.id });
      const ms = await say(g.id, "开始");
      expect(ms.some((m) => m.senderName === "Mate" && m.status === "done")).toBe(true);
      expect(round).toBeGreaterThan(2);
    } finally {
      llm.stop(true);
    }
  });
});

describe("onboarding", () => {
  test("shows until finished or skipped, then stays done", async () => {
    expect((await api<{ onboarded: boolean }>("GET", "/api/meta")).data.onboarded).toBe(false);
    expect((await api("POST", "/api/onboarding")).status).toBe(200);
    expect((await api<{ onboarded: boolean }>("GET", "/api/meta")).data.onboarded).toBe(true);
  });
});

describe("projects", () => {
  test("conversations default to 草稿; new projects get their own folder or an existing one", async () => {
    const a = await createAgent("WsBot");
    const d = await createRoom("草稿会话", [a.id]);
    expect(d.projectId).toBe("drafts");
    expect(d.cwd).toBe(join(WORKSPACES, "drafts"));
    expect(d.kind).toBe("dm");
    const p1 = (await api<Project>("POST", "/api/projects", { name: "产品 研发/x" })).data;
    const p2 = (await api<Project>("POST", "/api/projects", { name: "产品 研发/x" })).data;
    expect(p1.cwd).toBe(join(WORKSPACES, "产品-研发-x"));
    expect(p2.cwd).toBe(join(WORKSPACES, "产品-研发-x-2"));
    for (const p of [p1, p2]) expect(existsSync(p.cwd)).toBe(true);
    const own = mkdtempSync(join(tmpdir(), "tuantuan-own-"));
    const p3 = (await api<Project>("POST", "/api/projects", { name: "own", cwd: own })).data;
    expect(p3.cwd).toBe(own);
    expect((await api("POST", "/api/projects", { name: "bad", cwd: "/no/such/dir" })).status).toBe(400);
    const b = await createAgent("WsBot-b");
    const g = await createRoom("双人", [a.id, b.id], { projectId: p3.id, mainAgentId: b.id });
    expect(g).toMatchObject({ kind: "group", cwd: own, mainAgentId: b.id });
    expect((await api("DELETE", "/api/projects/drafts")).status).toBe(400);
  });

  test("changing a project's folder resets its conversations' harness sessions", async () => {
    const a = await createAgent("WsBot2");
    const p = (await api<Project>("POST", "/api/projects", { name: "reset" })).data;
    const d = await createRoom("x", [a.id], { projectId: p.id });
    await say(d.id, "hi");
    expect(app.store.getAcpSession(d.id, a.id)).toBeTruthy();
    expect((await api("PATCH", `/api/projects/${p.id}`, { name: "renamed" })).status).toBe(200);
    expect(app.store.getAcpSession(d.id, a.id)).toBeTruthy();
    const other = mkdtempSync(join(tmpdir(), "tuantuan-pick-"));
    const r = await api<Project>("PATCH", `/api/projects/${p.id}`, { cwd: other });
    expect(r.data).toMatchObject({ name: "renamed", cwd: other });
    expect(app.store.getRoom(d.id)?.cwd).toBe(other);
    expect(app.store.getAcpSession(d.id, a.id)).toBeFalsy();
  });

  test("legacy rooms become projects by folder and keep their sessions", async () => {
    const { Store } = await import("../server/store");
    const { ensureDrafts, migrateRoomsToProjects } = await import("../server/workspace");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const s = new Store(":memory:");
    ensureDrafts(s);
    const x = s.createAgent(agentInput("X"));
    const y = s.createAgent(agentInput("Y"));
    const shared = mkdtempSync(join(tmpdir(), "tuantuan-legacy-"));
    const emptyDm = join(WORKSPACES, "dm", "X");
    const usedDm = join(WORKSPACES, "dm", "Y");
    const group = join(WORKSPACES, "groups", "老群");
    for (const d of [emptyDm, usedDm, group]) mkdirSync(d, { recursive: true });
    writeFileSync(join(usedDm, "a.txt"), "x");
    const legacy = (name: string, ids: string[], cwd: string) => {
      const r = s.createRoom(name, ids);
      s.db.query("UPDATE rooms SET project_id = NULL, cwd = ? WHERE id = ?").run(cwd, r.id);
      s.setAcpSession(r.id, ids[0] as string, "mock", `sess-${name}`);
      return r.id;
    };
    const ids = [
      legacy("a", [x.id], shared),
      legacy("b", [x.id, y.id], shared),
      legacy("c", [x.id], emptyDm),
      legacy("d", [y.id], usedDm),
      legacy("e", [x.id, y.id], group),
    ];
    migrateRoomsToProjects(s);
    const rooms = ids.map((id) => s.getRoom(id));
    expect(rooms[0]?.projectId).toBe(rooms[1]?.projectId as string);
    expect(s.getProject(rooms[0]?.projectId as string)?.cwd).toBe(shared);
    expect(rooms[2]?.projectId).toBe("drafts");
    expect(s.getProject(rooms[3]?.projectId as string)).toMatchObject({ name: "Y", cwd: usedDm });
    expect(s.getProject(rooms[4]?.projectId as string)).toMatchObject({ name: "e", cwd: group });
    expect(s.getAcpSession(ids[0] as string, x.id)).toBeTruthy();
  });
});

describe("ACP harness integration (mock ACP agent)", () => {
  let dmAgent: Agent;
  let dm: Room;
  const cwd = mkdtempSync(join(tmpdir(), "tuantuan-cwd-"));

  test("DM: reply streams as ACP updates and is persisted with its timeline; session exposes config + commands", async () => {
    dmAgent = await createAgent("Coder", { identity: "你说话简洁。" });
    dm = await createRoom("单人", [dmAgent.id], { cwd });
    expect(dm.cwd).toBe(cwd);
    await watch(dm.id);
    const ms = await say(dm.id, "你好");
    const reply = ms.at(-1) as Message;
    expect(reply).toMatchObject({ senderKind: "agent", status: "done", content: "收到：「你好」（mock-fast）" });
    expect(reply.timeline?.parts.map((p) => p.kind)).toEqual(["thought", "text"]);
    expect(reply.timeline?.stopReason).toBe("end_turn");
    const updates = events.filter((e) => e.type === "update" && e.messageId === reply.id);
    expect(updates.length).toBeGreaterThan(2);
    const view = (await api<SessionView>("GET", `/api/rooms/${dm.id}/agents/${dmAgent.id}/session`)).data;
    expect(view.configOptions.map((o) => o.id)).toEqual(["mode", "model", "effort"]);
    expect(view.commands.map((c) => c.name)).toContain("plan");
    expect(view.usage?.size).toBe(200000);
    expect(view.capabilities).toMatchObject({ image: true, list: true, resume: true });
  });

  test("identity doc reaches a first-prompt harness once per session and never shows up as user text", async () => {
    const ms = await say(dm.id, "第二句");
    expect(ms.at(-1)?.content).toBe("收到：「第二句」（mock-fast）");
    expect(app.orchestrator.identityFor(dm, dmAgent)).toContain("你说话简洁。");
  });

  test("plan updates fold into a checklist", async () => {
    const reply = (await say(dm.id, "/plan")).at(-1) as Message;
    expect(reply.timeline?.plan?.map((e) => e.status)).toEqual(["completed", "completed", "completed"]);
  });

  test("permission: allow writes the file inside the room folder; reject leaves it alone", async () => {
    await Bun.write(join(cwd, "mock-edit.txt"), "hello\n");
    const before = events.length;
    await api("POST", `/api/rooms/${dm.id}/messages`, { content: "/edit" });
    const ask = await until(() => {
      const e = events.slice(before).find((x) => x.type === "permission" && x.ask);
      return e?.type === "permission" ? e.ask : null;
    });
    expect(ask.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect((await api("GET", `/api/rooms/${dm.id}/messages`)).data).toMatchObject({ asks: [{ id: ask.id }] });
    expect((await api("POST", `/api/permissions/${ask.id}`, { optionId: "allow" })).status).toBe(200);
    await app.orchestrator.idle(dm.id);
    expect(readFileSync(join(cwd, "mock-edit.txt"), "utf8")).toBe("hello\ntuantuan\n");
    const msgs = (await api<{ messages: Message[] }>("GET", `/api/rooms/${dm.id}/messages`)).data.messages;
    const reply = msgs.at(-1) as Message;
    const tool = Object.values(reply.timeline?.tools ?? {})[0];
    expect(tool).toMatchObject({ kind: "edit", status: "completed" });
    expect(tool?.content[0]).toMatchObject({ type: "diff", oldText: "hello\n" });

    await Bun.write(join(cwd, "mock-edit.txt"), "hello\n");
    const mark = events.length;
    await api("POST", `/api/rooms/${dm.id}/messages`, { content: "/edit" });
    const ask2 = await until(() => {
      const e = events.slice(mark).find((x) => x.type === "permission" && x.ask);
      return e?.type === "permission" ? e.ask : null;
    });
    await api("POST", `/api/permissions/${ask2.id}`, { optionId: "reject" });
    await app.orchestrator.idle(dm.id);
    expect(readFileSync(join(cwd, "mock-edit.txt"), "utf8")).toBe("hello\n");
    expect((await api("POST", `/api/permissions/${ask2.id}`, { optionId: "allow" })).status).toBe(404);
  });

  test("terminal: the agent runs a command through Tuantuan; output streams to the room", async () => {
    const mark = events.length;
    const reply = (await say(dm.id, "/run")).at(-1) as Message;
    expect(Object.values(reply.timeline?.tools ?? {})[0]).toMatchObject({ kind: "execute", status: "completed" });
    const term = events.slice(mark).findLast((e) => e.type === "terminal");
    expect(term?.type === "terminal" && term.terminal).toMatchObject({
      output: "hello from terminal\n",
      exitStatus: { exitCode: 0 },
    });
  });

  test("config options change the harness's behaviour", async () => {
    const view = (
      await api<SessionView>("POST", `/api/rooms/${dm.id}/agents/${dmAgent.id}/config`, {
        configId: "model",
        value: "mock-smart",
      })
    ).data;
    expect(view.configOptions.find((o) => o.id === "model")?.currentValue).toBe("mock-smart");
    expect((await say(dm.id, "嗨")).at(-1)?.content).toBe("收到：「嗨」（mock-smart）");
  });

  test("images go to harnesses that accept them", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const ms = await say(dm.id, "看图", [{ mimeType: "image/png", data: png }]);
    expect(ms.at(-2)?.timeline?.parts[0]).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(ms.at(-1)?.content).toContain("还有 1 张图片");
  });

  test("cancel sends session/cancel and the reply ends as cancelled", async () => {
    await api("POST", `/api/rooms/${dm.id}/messages`, { content: "/slow" });
    await until(() => app.store.recentMessages(dm.id, 1)[0]?.status === "streaming");
    await Bun.sleep(200);
    expect((await api("POST", `/api/rooms/${dm.id}/cancel`)).data).toEqual({ cancelled: true });
    await app.orchestrator.idle(dm.id);
    expect(app.store.recentMessages(dm.id, 1)[0]?.status).toBe("cancelled");
  });

  test("history: list sessions, start a new one, switch back; a dead process falls back to a fresh session", async () => {
    const list = (await api<{ sessionId: string }[]>("GET", `/api/rooms/${dm.id}/agents/${dmAgent.id}/history`)).data;
    const first = app.store.getAcpSession(dm.id, dmAgent.id)?.sessionId as string;
    expect(list.map((s) => s.sessionId)).toContain(first);
    const fresh = (
      await api<SessionView>("POST", `/api/rooms/${dm.id}/agents/${dmAgent.id}/session`, { sessionId: null })
    ).data;
    expect(fresh.sessionId).not.toBe(first);
    const back = (
      await api<SessionView>("POST", `/api/rooms/${dm.id}/agents/${dmAgent.id}/session`, { sessionId: first })
    ).data;
    expect(back.sessionId).toBe(first);
    app.host.shutdown();
    expect((await say(dm.id, "重启后")).at(-1)?.content).toBe("收到：「重启后」（mock-fast）");
  });

  test("group: no @ goes to the main agent, @ goes to the mentioned one, prompt carries what others said", async () => {
    const a = await createAgent("Alice");
    const b = await createAgent("Bob");
    const g = await createRoom("群", [a.id, b.id], { mainAgentId: b.id });
    let ms = await say(g.id, "大家好");
    expect(ms.at(-1)).toMatchObject({ senderName: "Bob", content: "收到：「大家好」（mock-fast）" });
    ms = await say(g.id, "@Alice 你来");
    expect(ms.at(-1)?.senderName).toBe("Alice");
    expect(ms.at(-1)?.content).toBe("收到：「@Alice 你来」（mock-fast）");
    // The relay (群聊转述) reaches the harness: the mock echoes its prompt as a thought.
    const thought = ms.at(-1)?.timeline?.parts.find((p) => p.kind === "thought");
    expect(thought && "text" in thought ? thought.text : "").toContain("[Bob（Agent）]: 收到");
    const patched = (await api<Room>("PATCH", `/api/rooms/${g.id}`, { mainAgentId: a.id })).data;
    expect(patched.mainAgentId).toBe(a.id);
    expect((await say(g.id, "再来")).at(-1)?.senderName).toBe("Alice");
  });

  test("an agent without a harness explains what to do", async () => {
    const x = await createAgent("Lonely", { harness: "" });
    const r = await createRoom("x", [x.id]);
    const reply = (await say(r.id, "hi")).at(-1);
    expect(reply).toMatchObject({ status: "error" });
    expect(reply?.error).toContain("还没有绑定 Harness");
  });

  test("validation: unknown harness, bad env names, duplicate names", async () => {
    expect((await api("POST", "/api/agents", agentInput("Z", { harness: "nope" }))).status).toBe(400);
    expect((await api("POST", "/api/agents", agentInput("Z", { env: { "BAD-NAME": "x" } }))).status).toBe(400);
    expect((await api("POST", "/api/agents", agentInput("coder"))).status).toBe(409);
  });

  test("harness registry: detection, path override and handshake for the mock harness", async () => {
    const list = (await api<{ id: string; path: string | null }[]>("GET", "/api/harnesses")).data;
    expect(list.map((h) => h.id)).toEqual(["claude-code", "codex", "grok", "opencode", "mock"]);
    expect(list.find((h) => h.id === "mock")?.path).toBeTruthy();
    const t = (await api<{ ok: boolean; agentInfo: { name: string } }>("POST", "/api/harnesses/mock/test")).data;
    expect(t).toMatchObject({ ok: true, agentInfo: { name: "mock-agent" } });
    const bad = (
      await api<{ id: string; error: string | null }[]>("PUT", "/api/harnesses/mock/path", { path: "/nope/bin" })
    ).data;
    expect(bad.find((h) => h.id === "mock")?.error).toContain("找不到");
    await api("PUT", "/api/harnesses/mock/path", { path: null });
  });
});

describe("client-side fs is confined to the agent's working directory", () => {
  test("paths outside cwd are refused", () => {
    const root = mkdtempSync(join(tmpdir(), "root"));
    const p = new AcpProcess(
      { command: process.execPath, args: ["--version"], env: {}, cwd: root },
      { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
    );
    expect(p.inside("a/b.txt")).toBe(join(root, "a/b.txt"));
    expect(() => p.inside("../etc/passwd")).toThrow();
    expect(() => p.inside("/etc/passwd")).toThrow();
    expect(() => p.inside(`${root}kit/x`)).toThrow();
    p.kill();
  });
});
