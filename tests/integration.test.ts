import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProcess } from "../server/acp";
import { serve } from "../server/app";
import type { SessionView } from "../server/host";
import type { RoomEvent } from "../server/orchestrator";
import type { Agent, Message, Room } from "../server/store";
import { agentInput, until } from "./helpers";

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

async function createRoom(name: string, kind: "group" | "dm", agentIds: string[], extra = {}): Promise<Room> {
  const r = await api<Room>("POST", "/api/rooms", { name, kind, agentIds, ...extra });
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

describe("ACP harness integration (mock ACP agent)", () => {
  let dmAgent: Agent;
  let dm: Room;
  const cwd = mkdtempSync(join(tmpdir(), "tuantuan-cwd-"));

  test("DM: reply streams as ACP updates and is persisted with its timeline; session exposes config + commands", async () => {
    dmAgent = await createAgent("Coder", { cwd, identity: "你说话简洁。" });
    dm = await createRoom("私聊", "dm", [dmAgent.id]);
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

  test("permission: allow writes the file inside the agent cwd; reject leaves it alone", async () => {
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
    const g = await createRoom("群", "group", [a.id, b.id], { mainAgentId: b.id });
    let ms = await say(g.id, "大家好");
    expect(ms.at(-1)).toMatchObject({ senderName: "Bob", content: "收到：「[Andy]: 大家好」（mock-fast）" });
    ms = await say(g.id, "@Alice 你来");
    expect(ms.at(-1)?.senderName).toBe("Alice");
    expect(ms.at(-1)?.content).toContain("[Bob]: 收到");
    const patched = (await api<Room>("PATCH", `/api/rooms/${g.id}`, { mainAgentId: a.id })).data;
    expect(patched.mainAgentId).toBe(a.id);
    expect((await say(g.id, "再来")).at(-1)?.senderName).toBe("Alice");
  });

  test("an agent without a harness explains what to do", async () => {
    const x = await createAgent("Lonely", { harness: "" });
    const r = await createRoom("x", "dm", [x.id]);
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
