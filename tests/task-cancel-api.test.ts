import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { serve } from "../server/app";
import type { HarnessHost } from "../server/host";
import type { RoomState } from "../server/orchestrator";
import type { Agent, Message, Project, Room } from "../server/store";
import { agentInput, until } from "./helpers";

type PromptArgs = Parameters<HarnessHost["prompt"]>;
interface ControlledCall {
  roomId: string;
  agentId: string;
  text: string;
  signal: AbortSignal;
  update: PromptArgs[4];
  resolve: (result: { stopReason: acp.StopReason }) => void;
}

const cleanups: (() => Promise<void>)[] = [];
function fixture() {
  const { app, server } = serve({ dbPath: ":memory:" }, 0);
  const base = `http://127.0.0.1:${server.port}`;
  const calls: ControlledCall[] = [];
  const roomIds = new Set<string>();
  const dirs: string[] = [];
  // Replace only the provider boundary. HTTP routing, orchestration and SQLite stay real.
  app.host.prompt = (...args: PromptArgs) => {
    const [room, agent, , blocks, update, signal] = args;
    return new Promise((resolve) => {
      calls.push({
        roomId: room.id,
        agentId: agent.id,
        text: blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
        signal,
        update,
        resolve,
      });
    });
  };
  const raw = async (method: string, path: string, body?: string) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body });
    return { status: response.status, data: await response.json() };
  };
  const api = <T>(method: string, path: string, body?: unknown) =>
    raw(method, path, body === undefined ? undefined : JSON.stringify(body)) as Promise<{ status: number; data: T }>;
  const agent = async (name: string) => (await api<Agent>("POST", "/api/agents", agentInput(name))).data;
  const room = async (name: string, members: Agent[], projectId?: string) => {
    const response = await api<Room>("POST", "/api/rooms", { name, agentIds: members.map((a) => a.id), projectId });
    expect(response.status).toBe(201);
    roomIds.add(response.data.id);
    return response.data;
  };
  const say = async (room: Room, content: string) => {
    const response = await api<Message>("POST", `/api/rooms/${room.id}/messages`, { content });
    expect(response.status).toBe(201);
    return response.data;
  };
  const state = async (room: Room) =>
    (await api<{ state: RoomState }>("GET", `/api/rooms/${room.id}/messages`)).data.state;
  const finish = (index: number) => {
    const call = calls[index];
    if (!call) throw new Error(`missing call ${index}`);
    call.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late provider completion" } });
    call.resolve({ stopReason: "end_turn" });
  };
  const project = async (name: string) => {
    const cwd = mkdtempSync(join(tmpdir(), "tuantuan-cancel-api-"));
    dirs.push(cwd);
    return (await api<Project>("POST", "/api/projects", { name, cwd })).data;
  };
  cleanups.push(async () => {
    app.orchestrator.shutdown();
    for (let i = 0; i < calls.length; i++) finish(i);
    await Promise.all([...roomIds].map((id) => app.orchestrator.idle(id)));
    app.host.shutdown();
    app.registry.stop();
    await app.projectTerminals.shutdown();
    server.stop(true);
    app.store.db.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  return { app, calls, raw, api, agent, room, say, state, finish, project };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("task cancellation HTTP scope", () => {
  test("group requests require a taskId; invalid requests and another room's task cannot cancel current work", async () => {
    const f = fixture();
    const a = await f.agent("A");
    const b = await f.agent("B");
    const one = await f.room("one", [a, b]);
    const two = await f.room("two", [a, b]);
    await f.say(one, "@所有人 正在处理");
    await f.say(two, "@A 另一个会话");
    const before = await f.state(one);
    const foreignId = (await f.state(two)).tasks[0]?.id;
    expect((await f.raw("POST", `/api/rooms/${one.id}/cancel`)).status).toBe(400);
    expect((await f.raw("POST", `/api/rooms/${one.id}/cancel`, "{bad json")).status).toBe(400);
    expect((await f.api("POST", `/api/rooms/${one.id}/cancel`, { taskId: 123 })).status).toBe(400);
    const foreign = await f.api("POST", `/api/rooms/${one.id}/cancel`, { taskId: foreignId });
    expect(foreign).toEqual({ status: 200, data: { cancelled: false } });
    expect(await f.state(one)).toEqual(before);
    expect(f.calls.every((call) => !call.signal.aborted)).toBe(true);
  });

  test("targeting a queued task preserves independent running work and the rest of its agent's queue", async () => {
    const f = fixture();
    const a = await f.agent("A");
    const b = await f.agent("B");
    const room = await f.room("group", [a, b]);
    await f.say(room, "@A 当前A");
    await f.say(room, "@B 独立运行B");
    const dropped = await f.say(room, "@A 取消这条排队");
    const kept = await f.say(room, "@A 保留这条排队");
    const taskId = (await f.state(room)).tasks.find((task) => task.runId === dropped.id)?.id;
    expect((await f.api("POST", `/api/rooms/${room.id}/cancel`, { taskId })).data).toEqual({ cancelled: true });
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((call) => !call.signal.aborted)).toBe(true);
    const remaining = await f.state(room);
    expect(remaining.queued).toBe(1);
    expect(remaining.tasks.some((task) => task.runId === dropped.id)).toBe(false);
    expect(remaining.tasks.find((task) => task.runId === kept.id)?.status).toBe("queued");
    f.finish(0);
    await until(() => f.calls.length === 3);
    expect(f.calls[2]?.text).toContain("保留这条排队");
    expect(f.calls[1]?.signal.aborted).toBe(false);
    expect(
      f.app.store
        .recentMessages(room.id, 20)
        .some((message) => message.runId === dropped.id && message.senderKind === "agent"),
    ).toBe(false);
  });

  test("DM empty-body stop cancels its current task and leaves its independent queued message", async () => {
    const f = fixture();
    const a = await f.agent("A");
    const room = await f.room("dm", [a]);
    await f.say(room, "当前");
    const next = await f.say(room, "下一条独立请求");
    expect((await f.raw("POST", `/api/rooms/${room.id}/cancel`)).data).toEqual({ cancelled: true });
    expect(f.calls[0]?.signal.aborted).toBe(true);
    expect((await f.state(room)).tasks.find((task) => task.runId === next.id)?.status).toBe("queued");
    f.finish(0);
    await until(() => f.calls.length === 2);
    expect(f.calls[1]?.text).toBe("下一条独立请求");
    expect(f.calls[1]?.signal.aborted).toBe(false);
  });

  test("removing a member stops its waiting dependency branch and current task, preserving other members' work", async () => {
    const f = fixture();
    const a = await f.agent("A");
    const b = await f.agent("B");
    const c = await f.agent("C");
    const room = await f.room("members", [a, b, c]);
    await f.say(room, "@A 交接来源");
    await f.app.orchestrator.call({ roomId: room.id, agentId: a.id }, "handoff", { agent: "C", task: "来源A的依赖" });
    f.finish(0);
    await until(() => f.calls.length === 2);
    await f.say(room, "@B 独立B");
    const queuedC = await f.say(room, "@C 独立C排队");
    await f.say(room, "@A 另一个A任务");
    expect((await f.api("PUT", `/api/rooms/${room.id}/agents`, { agentIds: [b.id, c.id] })).status).toBe(200);
    expect(f.calls[1]?.signal.aborted).toBe(true); // C depends on completed source A.
    expect(f.calls[2]?.signal.aborted).toBe(false); // Independent B.
    expect(f.calls[3]?.signal.aborted).toBe(true); // A's other root.
    expect((await f.state(room)).tasks.find((task) => task.runId === queuedC.id)?.status).toBe("queued");
    f.finish(1);
    f.finish(3);
    await until(() => f.calls.length === 5);
    expect(f.calls[4]?.agentId).toBe(c.id);
    expect(f.calls[4]?.signal.aborted).toBe(false);
    expect(f.calls[2]?.signal.aborted).toBe(false);
  });

  test("deleting an agent stops that agent across rooms without cancelling other members", async () => {
    const f = fixture();
    const a = await f.agent("A");
    const b = await f.agent("B");
    const one = await f.room("one", [a, b]);
    const two = await f.room("two", [a, b]);
    await f.say(one, "@所有人 one");
    await f.say(two, "@所有人 two");
    await f.say(one, "@A one排队");
    await f.say(two, "@A two排队");
    expect((await f.api("DELETE", `/api/agents/${a.id}`)).status).toBe(200);
    expect(f.app.store.getAgent(a.id)).toBeNull();
    expect(f.calls.filter((call) => call.agentId === a.id).every((call) => call.signal.aborted)).toBe(true);
    expect(f.calls.filter((call) => call.agentId === b.id).every((call) => !call.signal.aborted)).toBe(true);
    expect((await f.state(one)).queued).toBe(0);
    expect((await f.state(two)).queued).toBe(0);
    for (let i = 0; i < f.calls.length; i++) f.finish(i);
    await Promise.all([f.app.orchestrator.idle(one.id), f.app.orchestrator.idle(two.id)]);
    expect(f.calls).toHaveLength(4);
  });

  test("deleting a room cancels all its running and queued tasks, while another room continues", async () => {
    const f = fixture();
    const a = await f.agent("A");
    const b = await f.agent("B");
    const deleted = await f.room("delete", [a, b]);
    const kept = await f.room("keep", [a, b]);
    await f.say(deleted, "@所有人 当前");
    await f.say(kept, "@A 另一个房间");
    await f.say(deleted, "@所有人 排队");
    expect((await f.api("DELETE", `/api/rooms/${deleted.id}`)).status).toBe(200);
    expect(f.calls[0]?.signal.aborted).toBe(true);
    expect(f.calls[1]?.signal.aborted).toBe(true);
    expect(f.calls[2]?.signal.aborted).toBe(false);
    f.finish(0);
    f.finish(1);
    await f.app.orchestrator.idle(deleted.id);
    expect(f.calls).toHaveLength(3);
    expect((await f.api("GET", `/api/rooms/${deleted.id}/messages`)).status).toBe(404);
    expect((await f.state(kept)).tasks[0]?.status).toBe("running");
  });

  test("changing a project directory cancels all its rooms, preserving a different project's work", async () => {
    const f = fixture();
    const a = await f.agent("A");
    const b = await f.agent("B");
    const changed = await f.project("changed");
    const other = await f.project("other");
    const one = await f.room("one", [a, b], changed.id);
    const two = await f.room("two", [a, b], changed.id);
    const kept = await f.room("keep", [a, b], other.id);
    await f.say(one, "@A one");
    await f.say(two, "@B two");
    await f.say(kept, "@A keep");
    await f.say(one, "@A one排队");
    await f.say(two, "@B two排队");
    expect((await f.api("PATCH", `/api/projects/${changed.id}`, { cwd: other.cwd })).status).toBe(200);
    expect(f.calls[0]?.signal.aborted).toBe(true);
    expect(f.calls[1]?.signal.aborted).toBe(true);
    expect(f.calls[2]?.signal.aborted).toBe(false);
    expect((await f.state(one)).queued).toBe(0);
    expect((await f.state(two)).queued).toBe(0);
    f.finish(0);
    f.finish(1);
    await Promise.all([f.app.orchestrator.idle(one.id), f.app.orchestrator.idle(two.id)]);
    expect(f.calls).toHaveLength(3);
    expect((await f.state(kept)).tasks[0]?.status).toBe("running");
  });
});
