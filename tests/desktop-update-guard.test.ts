import { afterEach, describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { serve } from "../server/app";
import type { HarnessHost } from "../server/host";
import { Orchestrator } from "../server/orchestrator";
import { Store, ValidationError } from "../server/store";
import { agentInput, until } from "./helpers";

const TOKEN = "desktop-main-process-test-secret";
const UPDATE_ROUTES = [
  ["GET", "update-activity"],
  ["POST", "update-prepare"],
  ["POST", "update-resume"],
] as const;
type Activity = { activeTasks: number; prepared: boolean };
type PromptArgs = Parameters<HarnessHost["prompt"]>;
const cleanups: (() => Promise<void>)[] = [];

function fixture(options: { desktopUpdateToken?: string; realHost?: boolean } = { desktopUpdateToken: TOKEN }) {
  const { app, server } = serve({ dbPath: ":memory:", desktopUpdateToken: options.desktopUpdateToken }, 0);
  const base = `http://127.0.0.1:${server.port}`;
  const calls: { signal: AbortSignal; agentId: string; resolve: (result: { stopReason: acp.StopReason }) => void }[] =
    [];
  const rooms: string[] = [];
  if (!options.realHost)
    app.host.prompt = (...args: PromptArgs) =>
      new Promise((resolve) => calls.push({ signal: args[5], agentId: args[1].id, resolve }));
  async function api<T = unknown>(method: string, path: string, body?: unknown, authorization?: string) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as T };
  }
  const update = (method: string, action: string) =>
    api<Activity>(method, `/api/desktop/${action}`, undefined, `Bearer ${TOKEN}`);
  const room = (name: string, names = ["A"]) => {
    const agents = names.map((agent) => app.store.createAgent(agentInput(`${name}${agent}`)));
    const room = app.store.createRoom(
      name,
      agents.map((agent) => agent.id),
    );
    rooms.push(room.id);
    return { room, agents };
  };
  const finish = (index: number) => {
    const call = calls[index];
    if (!call) throw new Error(`missing prompt ${index}`);
    call.resolve({ stopReason: "end_turn" });
  };
  cleanups.push(async () => {
    app.orchestrator.shutdown();
    for (const call of calls) call.resolve({ stopReason: "cancelled" });
    await Promise.all(rooms.map((id) => app.orchestrator.idle(id)));
    app.host.shutdown();
    app.installer.shutdown();
    app.registry.stop();
    await app.projectTerminals.shutdown();
    server.stop(true);
    app.store.db.close();
  });
  return { app, server, base, calls, api, update, room, finish };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("desktop update server guard", () => {
  test("ordinary browser servers have no update-control endpoints", async () => {
    const f = fixture({ desktopUpdateToken: "" });
    for (const [method, action] of UPDATE_ROUTES) expect((await f.update(method, action)).status).toBe(404);
    expect(f.app.orchestrator.desktopUpdateActivity()).toEqual({ activeTasks: 0, prepared: false });
  });

  test("every endpoint requires the main-process bearer token and public responses never reveal it", async () => {
    const f = fixture();
    for (const [method, action] of UPDATE_ROUTES) {
      const path = `/api/desktop/${action}`;
      expect((await f.api(method, path)).status).toBe(401);
      expect((await f.api(method, path, undefined, "Bearer wrong-token")).status).toBe(401);
      expect((await f.api(method, `${path}?token=${TOKEN}`)).status).toBe(401);
      const response = await f.update(method, action);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.data)).not.toContain(TOKEN);
    }
    for (const path of ["/api/meta", "/api/profile", "/api/health"])
      expect(JSON.stringify((await f.api("GET", path)).data)).not.toContain(TOKEN);
    expect(f.app.orchestrator.desktopUpdateActivity().prepared).toBe(false);
  });

  test("the server process token is captured privately when creating the app", async () => {
    const previous = process.env.TUANTUAN_DESKTOP_UPDATE_TOKEN;
    let f: ReturnType<typeof fixture>;
    try {
      process.env.TUANTUAN_DESKTOP_UPDATE_TOKEN = TOKEN;
      f = fixture({});
    } finally {
      if (previous === undefined) delete process.env.TUANTUAN_DESKTOP_UPDATE_TOKEN;
      else process.env.TUANTUAN_DESKTOP_UPDATE_TOKEN = previous;
    }
    expect(await f.update("GET", "update-activity")).toEqual({
      status: 200,
      data: { activeTasks: 0, prepared: false },
    });
  });

  test("idle prepare locks new messages and retries before persistence; resume restores entry", async () => {
    const f = fixture();
    const { room, agents } = f.room("idle");
    const human = f.app.store.insertMessage({
      roomId: room.id,
      runId: "old-run",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "用户",
      content: "原请求",
      status: "done",
    });
    const interrupted = f.app.store.insertMessage({
      roomId: room.id,
      runId: human.id,
      hop: 1,
      senderKind: "agent",
      senderId: agents[0]?.id ?? null,
      senderName: "Agent",
      content: "",
      status: "interrupted",
    });
    const before = f.app.store.recentMessages(room.id, 100);
    for (let i = 0; i < 2; i++)
      expect(await f.update("POST", "update-prepare")).toEqual({
        status: 200,
        data: { activeTasks: 0, prepared: true },
      });
    expect(() => f.app.orchestrator.postHumanMessage(room.id, "用户", "直接调用")).toThrow("正在安装桌面更新");
    const rejected = await f.api<{ error: string }>("POST", `/api/rooms/${room.id}/messages`, { content: "新请求" });
    expect(rejected.status).toBe(503);
    expect(rejected.data.error).toContain("正在安装桌面更新");
    expect((await f.api("POST", `/api/rooms/${room.id}/messages/${interrupted.id}/retry`)).status).toBe(503);
    expect(f.app.store.recentMessages(room.id, 100)).toEqual(before);
    expect(f.calls).toHaveLength(0);
    expect(await f.update("POST", "update-resume")).toEqual({ status: 200, data: { activeTasks: 0, prepared: false } });
    expect((await f.update("POST", "update-resume")).status).toBe(200);
    expect((await f.api("POST", `/api/rooms/${room.id}/messages`, { content: "恢复后的请求" })).status).toBe(201);
    expect(f.calls).toHaveLength(1);
  });

  test("a request still reading its body cannot cross the atomic prepare boundary", async () => {
    const f = fixture();
    const { room } = f.room("inflight");
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    });
    const posting = f.app.fetch(
      new Request(`${f.base}/api/rooms/${room.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
      }),
      f.server,
    );
    expect((await f.update("POST", "update-prepare")).status).toBe(200);
    body.enqueue(new TextEncoder().encode(JSON.stringify({ content: "在途请求" })));
    body.close();
    expect((await posting)?.status).toBe(503);
    expect(f.app.store.recentMessages(room.id, 100)).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  test("all rooms and queues block installation without cancellation or automatic installation later", async () => {
    const f = fixture();
    const one = f.room("one").room;
    const two = f.room("two").room;
    f.app.orchestrator.postHumanMessage(one.id, "用户", "运行中");
    f.app.orchestrator.postHumanMessage(one.id, "用户", "排队中");
    f.app.orchestrator.postHumanMessage(two.id, "用户", "其他房间");
    expect(await f.update("GET", "update-activity")).toEqual({
      status: 200,
      data: { activeTasks: 3, prepared: false },
    });
    expect((await f.update("POST", "update-prepare")).status).toBe(409);
    expect(f.calls.every((call) => !call.signal.aborted)).toBe(true);
    f.finish(0);
    await until(() => f.calls.length === 3);
    expect((await f.update("POST", "update-prepare")).status).toBe(409);
    f.finish(1);
    f.finish(2);
    await Promise.all([f.app.orchestrator.idle(one.id), f.app.orchestrator.idle(two.id)]);
    expect(await f.update("GET", "update-activity")).toEqual({
      status: 200,
      data: { activeTasks: 0, prepared: false },
    });
    expect((await f.update("POST", "update-prepare")).status).toBe(200);
  });

  test("cancelling and deleted rooms remain busy until execution cleanup finishes", async () => {
    const f = fixture();
    const { room } = f.room("deleted");
    f.app.orchestrator.postHumanMessage(room.id, "用户", "取消后仍在收尾");
    expect(f.app.orchestrator.cancel(room.id)).toBe(true);
    expect(f.calls[0]?.signal.aborted).toBe(true);
    expect(f.app.orchestrator.state(room.id).tasks[0]?.status).toBe("cancelling");
    expect((await f.update("POST", "update-prepare")).status).toBe(409);
    expect((await f.api("DELETE", `/api/rooms/${room.id}`)).status).toBe(200);
    expect(f.app.store.getRoom(room.id)).toBeNull();
    expect(await f.update("GET", "update-activity")).toEqual({
      status: 200,
      data: { activeTasks: 1, prepared: false },
    });
    expect((await f.update("POST", "update-prepare")).status).toBe(409);
    f.finish(0);
    await f.app.orchestrator.idle(room.id);
    expect((await f.update("POST", "update-prepare")).status).toBe(200);
  });

  test("accepted handoffs, waiting ancestors and coordinator reviews all block installation", async () => {
    const f = fixture();
    const { room, agents } = f.room("handoff", ["Leader", "Worker"]);
    const leader = agents[0];
    const worker = agents[1];
    if (!leader || !worker) throw new Error("missing agents");
    f.app.orchestrator.postHumanMessage(room.id, "用户", "协调完成");
    await f.app.orchestrator.call({ roomId: room.id, agentId: leader.id }, "handoff", {
      agent: worker.name,
      task: "成员工作",
    });
    expect((await f.update("POST", "update-prepare")).status).toBe(409);
    f.finish(0);
    await until(() => f.calls.length === 2);
    expect(f.app.orchestrator.state(room.id).tasks.map((task) => task.status)).toEqual(["waiting", "running"]);
    expect((await f.update("GET", "update-activity")).data.activeTasks).toBe(2);
    expect((await f.update("POST", "update-prepare")).status).toBe(409);
    f.finish(1);
    await until(() => f.calls.length === 3);
    expect(f.calls[2]?.agentId).toBe(leader.id);
    expect(f.app.orchestrator.state(room.id).tasks.some((task) => task.coordination === "review")).toBe(true);
    expect((await f.update("POST", "update-prepare")).status).toBe(409);
    expect(f.calls.every((call) => !call.signal.aborted)).toBe(true);
    f.finish(2);
    await f.app.orchestrator.idle(room.id);
    expect((await f.update("POST", "update-prepare")).status).toBe(200);
  });

  test("real mock-ACP permission and question waits cannot be interrupted by update prepare", async () => {
    const f = fixture({ desktopUpdateToken: TOKEN, realHost: true });
    const permissionRoom = f.room("Permission").room;
    const questionRoom = f.room("Question").room;
    f.app.orchestrator.postHumanMessage(permissionRoom.id, "用户", "/edit");
    f.app.orchestrator.postHumanMessage(questionRoom.id, "用户", "/ask");
    const permission = await until(() => f.app.host.pendingAsks(permissionRoom.id)[0]);
    const question = await until(() => f.app.host.pendingElicitations(questionRoom.id)[0]);
    expect((await f.update("GET", "update-activity")).data.activeTasks).toBe(2);
    expect((await f.update("POST", "update-prepare")).status).toBe(409);
    expect(f.app.host.pendingAsks(permissionRoom.id)[0]?.id).toBe(permission.id);
    expect(f.app.host.pendingElicitations(questionRoom.id)[0]?.id).toBe(question.id);
    f.app.orchestrator.cancel(permissionRoom.id);
    f.app.orchestrator.cancel(questionRoom.id);
    await Promise.all([f.app.orchestrator.idle(permissionRoom.id), f.app.orchestrator.idle(questionRoom.id)]);
    expect((await f.update("POST", "update-prepare")).status).toBe(200);
  });

  test("terminal task state does not hide an execution promise awaiting final cleanup", async () => {
    const store = new Store(":memory:");
    const agent = store.createAgent(agentInput("finalizer"));
    const room = store.createRoom("finalizer", [agent.id]);
    let finish!: (result: { stopReason: acp.StopReason }) => void;
    const host = {
      prompt: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const observations: { visibleTasks: number; activity: Activity; prepareStatus: number }[] = [];
    const scheduler = new Orchestrator(store, host as unknown as HarnessHost, (_roomId, event) => {
      if (event.type !== "message" || event.message.senderKind !== "agent" || event.message.status !== "done") return;
      // runAgentTurn settles first, then execute; sample before its promise finalizer releases the lane.
      queueMicrotask(() =>
        queueMicrotask(() => {
          let prepareStatus = 200;
          try {
            scheduler.prepareDesktopUpdate();
          } catch (error) {
            prepareStatus = error instanceof ValidationError ? error.status : 500;
          }
          observations.push({
            visibleTasks: scheduler.state(room.id).tasks.length,
            activity: scheduler.desktopUpdateActivity(),
            prepareStatus,
          });
        }),
      );
    });
    try {
      scheduler.postHumanMessage(room.id, "用户", "结束");
      finish({ stopReason: "end_turn" });
      await scheduler.idle(room.id);
      expect(observations).toEqual([
        { visibleTasks: 0, activity: { activeTasks: 1, prepared: false }, prepareStatus: 409 },
      ]);
      expect(scheduler.prepareDesktopUpdate()).toEqual({ activeTasks: 0, prepared: true });
    } finally {
      scheduler.shutdown();
      store.db.close();
    }
  });
});
