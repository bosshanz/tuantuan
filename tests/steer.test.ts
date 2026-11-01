import { afterEach, describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { serve } from "../server/app";
import type { HarnessHost } from "../server/host";
import { Orchestrator, type RoomEvent } from "../server/orchestrator";
import type { Agent, Message } from "../server/store";
import { Store } from "../server/store";
import { agentInput, until } from "./helpers";

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

type PromptArgs = Parameters<HarnessHost["prompt"]>;
class ControlledHost {
  calls: {
    room: PromptArgs[0];
    agent: PromptArgs[1];
    blocks: PromptArgs[3];
    update: PromptArgs[4];
    signal: AbortSignal;
    result: Deferred<{ stopReason: acp.StopReason }>;
  }[] = [];
  prompt(...args: PromptArgs) {
    const [room, agent, , blocks, update, signal] = args;
    const result = new Deferred<{ stopReason: acp.StopReason }>();
    this.calls.push({ room, agent, blocks, update, signal, result });
    return result.promise;
  }
  finish(index: number, text = "完成") {
    const call = this.calls[index];
    if (!call) throw new Error(`missing prompt ${index}`);
    call.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    call.result.resolve({ stopReason: "end_turn" });
  }
  text(index: number) {
    return (
      this.calls[index]?.blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n") ?? ""
    );
  }
}

const fixtures: { store: Store; scheduler: Orchestrator; room: { id: string }; host: ControlledHost }[] = [];
function fixture(names = ["A", "B", "C", "D", "E"]) {
  const store = new Store(":memory:");
  const agents = names.map((name) => store.createAgent(agentInput(name)));
  const room = store.createRoom(
    "调度",
    agents.map((a) => a.id),
    { mainAgentId: agents[0]?.id },
  );
  const host = new ControlledHost();
  const events: RoomEvent[] = [];
  const scheduler = new Orchestrator(store, host as unknown as HarnessHost, (_roomId, event) => events.push(event));
  const say = (text: string) => scheduler.postHumanMessage(room.id, "用户", text);
  const steer = (content: string, targetTaskId: string, requestId?: string) =>
    scheduler.steer(room.id, "用户", content, [], [], undefined, undefined, targetTaskId, requestId);
  const handoff = (from: string, to: string, task = `${to} 的交接任务`) => {
    const agent = agents.find((a) => a.name === from);
    if (!agent) throw new Error("missing sender");
    return scheduler.call({ roomId: room.id, agentId: agent.id }, "handoff", { agent: to, task });
  };
  const task = (name: string, runId?: string) =>
    scheduler.state(room.id).tasks.find((t) => t.agentName === name && (!runId || t.runId === runId));
  const f = { store, agents, room, host, scheduler, events, say, steer, handoff, task };
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.scheduler.shutdown();
    for (let i = 0; i < f.host.calls.length; i++) f.host.finish(i);
    await f.scheduler.idle(f.room.id);
    f.store.db.close();
  }
});

describe("immediate steer", () => {
  test("DM steer stops the current task and runs the new instruction before earlier queued work", async () => {
    const f = fixture(["A"]);
    const first = f.say("当前任务");
    f.say("排队B");
    f.say("排队C");
    const running = f.task("A");
    expect(running?.status).toBe("running");
    const steered = f.steer("引导G", running?.id ?? "");
    expect(steered.timeline?.steer).toMatchObject({
      taskId: running?.id,
      runId: first.id,
      agentName: "A",
      stage: "stopping",
    });
    expect(f.host.calls[0]?.signal.aborted).toBe(true);
    expect(f.host.calls[0]?.signal.reason).toMatchObject({ message: "被新消息打断" });
    // The lane stays reserved: nothing else may start while the old turn is still in flight.
    expect(f.host.calls).toHaveLength(1);
    const steerTask = f.scheduler.state(f.room.id).tasks.find((t) => t.runId === steered.id);
    expect(steerTask).toMatchObject({ status: "queued", steer: { targetTaskId: running?.id } });
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    expect(f.host.text(1)).toContain("引导G");
    expect(f.host.text(1)).toContain("<tuantuan-steer>");
    expect(f.host.text(1)).not.toContain("排队B");
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    expect(f.host.text(2)).toContain("排队B");
    f.host.finish(2);
    await until(() => f.host.calls.length === 4);
    expect(f.host.text(3)).toContain("排队C");
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
    expect(f.store.getMessage(steered.id)?.timeline?.steer?.stage).toBe("sent");
    // Connected clients see the stage transition as a message event, not only the POST caller.
    expect(
      f.events.some(
        (e) => e.type === "message" && e.message.id === steered.id && e.message.timeline?.steer?.stage === "sent",
      ),
    ).toBe(true);
  });

  test("steering a coordinated root stops dependent members and waits for their executions", async () => {
    const f = fixture();
    const root = f.say("统筹请求");
    await f.handoff("A", "B");
    await f.handoff("A", "C");
    f.host.finish(0);
    await until(() => f.host.calls.length === 3);
    const lead = f.task("A", root.id);
    expect(lead?.status).toBe("waiting");
    const steered = f.steer("改方向：新指令", lead?.id ?? "", "req-root");
    expect(steered.timeline?.steer).toMatchObject({ taskId: lead?.id, runId: root.id, agentName: "A" });
    expect(f.host.calls[1]?.signal.aborted).toBe(true);
    expect(f.host.calls[2]?.signal.aborted).toBe(true);
    // A's own lane is free but the steer must wait for the members' executions to exit.
    f.host.finish(1);
    await Bun.sleep(0);
    expect(f.host.calls).toHaveLength(3);
    f.host.finish(2);
    await until(() => f.host.calls.length === 4);
    expect(f.host.calls[3]?.agent.name).toBe("A");
    expect(f.host.text(3)).toContain("改方向：新指令");
    expect(f.host.text(3)).toContain('mode="leader"');
    // A retry with the same request id returns the accepted instruction instead of duplicating.
    expect(f.steer("改方向：新指令", lead?.id ?? "", "req-root").id).toBe(steered.id);
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
    // The cancelled members' replies stay readable with the interruption reason.
    const replies = f.store
      .recentMessages(f.room.id, 20)
      .filter((m) => m.runId === root.id && m.senderKind === "agent");
    expect(replies.map((m) => m.status)).toEqual(["done", "cancelled", "cancelled"]);
  });

  test("steering a member branch cancels only that branch while siblings and the review continue", async () => {
    const f = fixture();
    const root = f.say("统筹请求");
    await f.handoff("A", "B");
    await f.handoff("A", "C");
    f.host.finish(0);
    await until(() => f.host.calls.length === 3);
    const memberB = f.task("B", root.id);
    f.steer("@B 换个做法", memberB?.id ?? "");
    expect(f.host.calls[1]?.signal.aborted).toBe(true);
    expect(f.host.calls[2]?.signal.aborted).toBe(false);
    f.host.finish(1);
    await until(() => f.host.calls.length === 4);
    expect(f.host.calls[3]?.agent.name).toBe("B");
    expect(f.host.text(3)).toContain("@B 换个做法");
    expect(f.host.text(3)).toContain('mode="direct"');
    f.host.finish(3);
    f.host.finish(2);
    // The original run's review still follows its remaining members.
    await until(() => f.host.calls.length === 5);
    expect(f.host.calls[4]?.agent.name).toBe("A");
    expect(f.host.text(4)).toContain('phase="review"');
    f.host.finish(4);
    await f.scheduler.idle(f.room.id);
  });

  test("recipient must resolve to exactly the steered agent", async () => {
    const f = fixture();
    const root = f.say("统筹请求");
    await f.handoff("A", "B");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    const memberB = f.task("B", root.id);
    const humans = () => f.store.recentMessages(f.room.id, 20).filter((m) => m.senderKind === "human").length;
    expect(() => f.steer("没有@成员", memberB?.id ?? "")).toThrow("新指令需要发给 @B");
    expect(() => f.steer("@B @C 多目标", memberB?.id ?? "")).toThrow("一次只能引导一个目标");
    expect(() => f.steer("@所有人 群发", memberB?.id ?? "")).toThrow("一次只能引导一个目标");
    expect(() => f.steer("@C 另一个成员", memberB?.id ?? "")).toThrow("新指令需要发给 @B");
    expect(humans()).toBe(1);
    expect(f.host.calls[1]?.signal.aborted).toBe(false);
    f.host.finish(1);
    // The completed member batch still triggers the coordinator's follow-up.
    await until(() => f.host.calls.length === 3);
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
  });

  test("queued-only and finished targets cannot be steered, and one pending steer per chain", async () => {
    const f = fixture(["A"]);
    f.say("当前");
    const queued = f.say("排队");
    const queuedTask = f.task("A", queued.id);
    expect(queuedTask?.status).toBe("queued");
    expect(() => f.steer("太早", queuedTask?.id ?? "")).toThrow("尚未开始");
    const running = f.task("A");
    const first = f.steer("引导", running?.id ?? "");
    expect(() => f.steer("重复引导", running?.id ?? "")).toThrow("已有进行中的引导");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    f.host.finish(1);
    // The earlier queued message then gets the lane back.
    await until(() => f.host.calls.length === 3);
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
    expect(first.timeline?.steer?.stage).toBe("stopping");
    expect(f.store.getMessage(first.id)?.timeline?.steer?.stage).toBe("sent");
    expect(() => f.steer("太晚", running?.id ?? "")).toThrow("已结束或不存在");
    expect(() => f.steer("仍然太晚", queuedTask?.id ?? "")).toThrow("已结束或不存在");
  });

  test("one pending steer per chain: overlapping targets are rejected, disjoint chains are allowed", async () => {
    const f = fixture();
    const root = f.say("统筹请求");
    await f.handoff("A", "B");
    f.say("@C 独立任务");
    f.host.finish(0);
    await until(() => f.host.calls.length === 3);
    const memberB = f.task("B", root.id);
    const taskC = f.task("C");
    // Steering a member claims only its branch.
    f.steer("@B 换个做法", memberB?.id ?? "");
    // The waiting coordinator's chain overlaps that branch, so it cannot be steered on top.
    const lead = f.task("A", root.id);
    expect(lead?.status).toBe("waiting");
    expect(() => f.steer("根上换方向", lead?.id ?? "")).toThrow("已有进行中的引导");
    // A chain in an unrelated run is unaffected.
    const cSteer = f.steer("@C 换思路", taskC?.id ?? "");
    expect(cSteer.timeline?.steer).toMatchObject({ taskId: taskC?.id, agentName: "C" });
    // calls: 0=A lead, 1=C direct, 2=B member — the member is enqueued only after the lead's turn.
    f.host.finish(1);
    await until(() => f.host.calls.length === 4);
    expect(f.host.calls[3]?.agent.name).toBe("C");
    expect(f.host.text(3)).toContain("@C 换思路");
    f.host.finish(2);
    // B's steer starts first; the original run then still reviews its settled branch on A's lane.
    await until(() => f.host.calls.length === 6);
    expect(f.host.calls[4]?.agent.name).toBe("B");
    expect(f.host.calls[5]?.agent.name).toBe("A");
    f.host.finish(3);
    f.host.finish(4);
    f.host.finish(5);
    await f.scheduler.idle(f.room.id);
  });

  test("steering the coordinator root also blocks a still-visible member of the chain", async () => {
    const f = fixture();
    const root = f.say("统筹请求");
    await f.handoff("A", "B");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    const lead = f.task("A", root.id);
    const memberB = f.task("B", root.id);
    f.steer("根上换方向", lead?.id ?? "");
    // The member is still visible in the task list but belongs to the claimed chain.
    expect(f.scheduler.state(f.room.id).tasks.some((t) => t.id === memberB?.id)).toBe(true);
    expect(() => f.steer("@B 换个做法", memberB?.id ?? "")).toThrow("已有进行中的引导");
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    expect(f.host.calls[2]?.agent.name).toBe("A");
    expect(f.host.text(2)).toContain("根上换方向");
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
  });

  test("an exited steered member stays in the room state while its steer is pending", async () => {
    const f = fixture();
    const root = f.say("统筹请求");
    await f.handoff("A", "B");
    await f.handoff("A", "C");
    f.host.finish(0);
    await until(() => f.host.calls.length === 3);
    const lead = f.task("A", root.id);
    const memberB = f.task("B", root.id);
    f.steer("@B 换个做法", memberB?.id ?? "");
    // B's execution exits (calls: 0=A lead, 1=B, 2=C) while C still runs. B leaves the active
    // set but the pending steer keeps it published with its ancestry, so the client's chain
    // check still excludes A instead of offering a target acceptance would reject.
    f.host.finish(1);
    const published = () => f.scheduler.state(f.room.id).tasks.find((t) => t.id === memberB?.id);
    await until(() => published() !== undefined);
    expect(published()?.parentTaskId).toBe(lead?.id);
    expect(() => f.steer("根上换方向", lead?.id ?? "")).toThrow("已有进行中的引导");
    // The steer only waits its own chain: it starts on B's lane while C still runs, and the
    // original run's review follows once C settles (calls 3=B steer, 4=A review).
    f.host.finish(2);
    await until(() => f.host.calls.length === 5);
    expect(f.host.calls[3]?.agent.name).toBe("B");
    expect(f.host.text(3)).toContain("@B 换个做法");
    expect(f.host.calls[4]?.agent.name).toBe("A");
    f.host.finish(3);
    f.host.finish(4);
    await f.scheduler.idle(f.room.id);
  });

  test("promoting a queued message steers the chain ahead of it and jumps older queued work", async () => {
    const f = fixture(["A"]);
    const first = f.say("当前任务");
    f.say("排队B");
    const queued = f.say("排队C");
    const running = f.task("A");
    const queuedTask = f.task("A", queued.id);
    expect(queuedTask?.status).toBe("queued");
    const promoted = f.scheduler.steerQueued(f.room.id, queuedTask?.id ?? "", running?.id ?? "");
    // The queued message is promoted in place: same message, now carrying the steer badge.
    expect(promoted.id).toBe(queued.id);
    expect(promoted.timeline?.steer).toMatchObject({
      taskId: running?.id,
      runId: first.id,
      agentName: "A",
      stage: "stopping",
    });
    expect(f.host.calls[0]?.signal.aborted).toBe(true);
    expect(f.host.calls[0]?.signal.reason).toMatchObject({ message: "被新消息打断" });
    expect(
      f.events.some(
        (e) => e.type === "message" && e.message.id === queued.id && e.message.timeline?.steer?.stage === "stopping",
      ),
    ).toBe(true);
    // Its task stays queued but now waits on the interrupted chain.
    expect(f.task("A", queued.id)?.steer).toMatchObject({ targetTaskId: running?.id });
    expect(f.host.calls).toHaveLength(1);
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    // The promoted message starts before the earlier queued one on the same lane.
    expect(f.host.text(1)).toContain("排队C");
    expect(f.host.text(1)).toContain("<tuantuan-steer>");
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    expect(f.host.text(2)).toContain("排队B");
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
    expect(f.store.getMessage(queued.id)?.timeline?.steer?.stage).toBe("sent");
  });

  test("queued promotion is limited to the same agent lane and rejectable once claimed", async () => {
    const f = fixture(["A", "B"]);
    f.say("@A 任务A");
    f.say("@B 任务B");
    await until(() => f.host.calls.length === 2);
    const queued = f.say("@B 排队B");
    const taskA = f.task("A");
    const taskB = f.task("B");
    const queuedTaskB = f.task("B", queued.id);
    // A queued message can only interrupt the chain on its own agent's lane.
    expect(() => f.scheduler.steerQueued(f.room.id, queuedTaskB?.id ?? "", taskA?.id ?? "")).toThrow("同一 Agent");
    // Nor a target that is itself only queued.
    const alsoQueued = f.say("@B 排队C");
    expect(() =>
      f.scheduler.steerQueued(f.room.id, queuedTaskB?.id ?? "", f.task("B", alsoQueued.id)?.id ?? ""),
    ).toThrow("尚未开始");
    f.scheduler.steerQueued(f.room.id, queuedTaskB?.id ?? "", taskB?.id ?? "");
    // Already promoted — it is a pending steer now, not a plain queued task.
    expect(() => f.scheduler.steerQueued(f.room.id, queuedTaskB?.id ?? "", taskB?.id ?? "")).toThrow("不在排队中");
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    expect(f.host.text(2)).toContain("排队B");
    f.host.finish(0);
    f.host.finish(2);
    // The older queued message then takes B's lane and is finished too.
    await until(() => f.host.calls.length === 4);
    expect(f.host.text(3)).toContain("排队C");
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
  });

  test("cancelling a pending steer marks it interrupted and frees the lane", async () => {
    const f = fixture(["A"]);
    f.say("当前");
    const running = f.task("A");
    const steered = f.steer("引导", running?.id ?? "");
    const steerTask = f.scheduler.state(f.room.id).tasks.find((t) => t.runId === steered.id);
    expect(steerTask?.status).toBe("queued");
    expect(f.scheduler.cancel(f.room.id, steerTask?.id)).toBe(true);
    expect(f.store.getMessage(steered.id)?.timeline?.steer?.stage).toBe("interrupted");
    // The interrupted badge reaches connected clients immediately, not after a reload.
    expect(
      f.events.some(
        (e) =>
          e.type === "message" && e.message.id === steered.id && e.message.timeline?.steer?.stage === "interrupted",
      ),
    ).toBe(true);
    f.host.finish(0);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(1);
    // The aborted steer can be replaced by an ordinary message afterwards.
    f.say("普通消息");
    await until(() => f.host.calls.length === 2);
    expect(f.host.text(1)).toContain("普通消息");
    f.host.finish(1);
    await f.scheduler.idle(f.room.id);
  });
});

describe("steer HTTP route", () => {
  const apis: { app: ReturnType<typeof serve>["app"]; server: ReturnType<typeof serve>["server"] }[] = [];
  afterEach(async () => {
    for (const { app, server } of apis.splice(0)) {
      app.orchestrator.shutdown();
      app.host.shutdown();
      app.registry.stop();
      await app.projectTerminals.shutdown();
      server.stop(true);
      app.store.db.close();
    }
  });

  test("accepts a steer, rejects bad payloads, and deduplicates by request id", async () => {
    const { app, server } = serve({ dbPath: ":memory:" }, 0);
    apis.push({ app, server });
    const base = `http://127.0.0.1:${server.port}`;
    const calls: { signal: AbortSignal; resolve: (r: { stopReason: acp.StopReason }) => void }[] = [];
    app.host.prompt = (...args: PromptArgs) =>
      new Promise((resolve) => {
        calls.push({ signal: args[5], resolve });
      });
    const api = async <T>(method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: (await response.json()) as T };
    };
    const a = (await api<Agent>("POST", "/api/agents", agentInput("A"))).data;
    const room = (await api<Message | { id: string }>("POST", "/api/rooms", { name: "dm", agentIds: [a.id] })).data as {
      id: string;
    };
    await api("POST", `/api/rooms/${room.id}/messages`, { content: "当前任务" });
    await until(() => calls.length === 1);
    const state = (
      await api<{ state: { tasks: { id: string; runId: string; status: string }[] } }>(
        "GET",
        `/api/rooms/${room.id}/messages`,
      )
    ).data.state;
    const taskId = state.tasks[0]?.id ?? "";
    expect((await api("POST", `/api/rooms/${room.id}/steer`, { content: "引导" })).status).toBe(400);
    expect(
      (await api("POST", `/api/rooms/${room.id}/steer`, { content: "引导", targetTaskId: "missing" })).status,
    ).toBe(409);
    const accepted = await api<Message>("POST", `/api/rooms/${room.id}/steer`, {
      content: "引导",
      targetTaskId: taskId,
      requestId: "req-1",
    });
    expect(accepted.status).toBe(201);
    expect(accepted.data.timeline?.steer).toMatchObject({ taskId, agentName: "A", stage: "stopping" });
    const retry = await api<Message>("POST", `/api/rooms/${room.id}/steer`, {
      content: "引导",
      targetTaskId: taskId,
      requestId: "req-1",
    });
    expect(retry.data.id).toBe(accepted.data.id);
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.resolve({ stopReason: "end_turn" });
    await until(() => calls.length === 2);
    calls[1]?.resolve({ stopReason: "end_turn" });
    await app.orchestrator.idle(room.id);
  });

  test("promotes a queued task in place via POST /steer/:taskId", async () => {
    const { app, server } = serve({ dbPath: ":memory:" }, 0);
    apis.push({ app, server });
    const base = `http://127.0.0.1:${server.port}`;
    const calls: { signal: AbortSignal; resolve: (r: { stopReason: acp.StopReason }) => void }[] = [];
    app.host.prompt = (...args: PromptArgs) =>
      new Promise((resolve) => {
        calls.push({ signal: args[5], resolve });
      });
    const api = async <T>(method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: (await response.json()) as T };
    };
    const a = (await api<Agent>("POST", "/api/agents", agentInput("A"))).data;
    const room = (await api<Message | { id: string }>("POST", "/api/rooms", { name: "dm", agentIds: [a.id] })).data as {
      id: string;
    };
    await api("POST", `/api/rooms/${room.id}/messages`, { content: "当前任务" });
    const queued = await api<Message>("POST", `/api/rooms/${room.id}/messages`, { content: "排队指令" });
    await until(() => calls.length === 1);
    const state = (
      await api<{ state: { tasks: { id: string; runId: string; status: string }[] } }>(
        "GET",
        `/api/rooms/${room.id}/messages`,
      )
    ).data.state;
    const running = state.tasks.find((t) => t.status === "running");
    const queuedTask = state.tasks.find((t) => t.runId === queued.data.id);
    expect(queuedTask?.status).toBe("queued");
    expect((await api("POST", `/api/rooms/${room.id}/steer/${queuedTask?.id}`, {})).status).toBe(400);
    expect(
      (await api("POST", `/api/rooms/${room.id}/steer/${queuedTask?.id}`, { targetTaskId: "missing" })).status,
    ).toBe(409);
    const promoted = await api<Message>("POST", `/api/rooms/${room.id}/steer/${queuedTask?.id}`, {
      targetTaskId: running?.id,
    });
    expect(promoted.status).toBe(200);
    // Same message, promoted: the queued task now carries the steer record, no duplicate is created.
    expect(promoted.data.id).toBe(queued.data.id);
    expect(promoted.data.timeline?.steer).toMatchObject({ taskId: running?.id, agentName: "A", stage: "stopping" });
    expect(
      (await api("POST", `/api/rooms/${room.id}/steer/${queuedTask?.id}`, { targetTaskId: running?.id })).status,
    ).toBe(409);
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.resolve({ stopReason: "end_turn" });
    await until(() => calls.length === 2);
    calls[1]?.resolve({ stopReason: "end_turn" });
    await app.orchestrator.idle(room.id);
  });
});
