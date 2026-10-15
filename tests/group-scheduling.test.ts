import { afterEach, describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { HarnessHost } from "../server/host";
import { MAX_AGENT_HOPS, Orchestrator, type RoomEvent } from "../server/orchestrator";
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

const fixtures: { store: Store; host: ControlledHost; scheduler: Orchestrator; room: { id: string } }[] = [];
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
  const handoff = (from: string, to: string, task = `${to} 的交接任务`) => {
    const agent = agents.find((a) => a.name === from);
    if (!agent) throw new Error("missing sender");
    return scheduler.call({ roomId: room.id, agentId: agent.id }, "handoff", { agent: to, task });
  };
  const task = (name: string, runId?: string) =>
    scheduler.state(room.id).tasks.find((t) => t.agentName === name && (!runId || t.runId === runId));
  const f = { store, agents, room, host, scheduler, events, say, handoff, task };
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

describe("per-agent room scheduling", () => {
  test("different agents run concurrently, same agent is FIFO, and new messages do not interrupt", async () => {
    const f = fixture();
    const first = f.say("@A @B 第一条");
    expect(f.host.calls.map((c) => c.agent.name)).toEqual(["A", "B"]);
    const second = f.say("@A 第二条");
    f.say("@C 独立第三条");
    expect(f.host.calls.map((c) => c.agent.name)).toEqual(["A", "B", "C"]);
    expect(f.scheduler.state(f.room.id).queued).toBe(1);
    expect(f.task("A", second.id)).toMatchObject({ status: "queued", messageId: null, parentTaskId: null });
    const originalId = f.task("A", first.id)?.id;
    expect(f.host.calls.every((c) => !c.signal.aborted)).toBe(true);
    let idle = false;
    const waiting = f.scheduler.idle(f.room.id).then(() => {
      idle = true;
    });
    f.host.finish(0);
    await until(() => f.host.calls.length === 4);
    expect(f.host.calls[3]?.agent.name).toBe("A");
    expect(f.task("A", first.id)).toBeUndefined();
    expect(f.task("A", second.id)?.id).not.toBe(originalId);
    expect(f.host.text(3)).toContain("<tuantuan-task>\n[用户]: @A 第二条\n</tuantuan-task>");
    expect(f.host.text(3)).not.toContain("独立第三条");
    f.host.finish(3);
    f.host.finish(2);
    await Bun.sleep(0);
    expect(idle).toBe(false);
    f.host.finish(1);
    await waiting;
    expect(f.scheduler.state(f.room.id)).toEqual({ activeRunId: null, queued: 0, tasks: [] });
  });

  test("cancelling one queued task preserves current and later independent messages", async () => {
    const f = fixture();
    f.say("@A 当前");
    const dropped = f.say("@A 取消排队");
    const later = f.say("@A 保留排队");
    const id = f.task("A", dropped.id)?.id;
    expect(id).toBeDefined();
    expect(f.scheduler.cancel(f.room.id)).toBe(false);
    expect(f.scheduler.cancel(f.room.id, id)).toBe(true);
    expect(f.scheduler.cancel(f.room.id, id)).toBe(false);
    expect(f.host.calls[0]?.signal.aborted).toBe(false);
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    expect(f.task("A", later.id)?.status).toBe("running");
    expect(f.host.text(1)).toContain("保留排队");
    expect(
      f.store.recentMessages(f.room.id, 20).filter((m) => m.runId === dropped.id && m.senderKind === "agent"),
    ).toEqual([]);
    f.host.finish(1);
    await f.scheduler.idle(f.room.id);
  });

  test("stopping a completed ancestor cancels queued children and running descendants only", async () => {
    const f = fixture();
    const independent = f.say("@B 独立占用B");
    const root = f.say("@A @D 共同请求");
    const parent = f.task("A", root.id);
    if (!parent) throw new Error("missing parent");
    await f.handoff("A", "B");
    await f.handoff("A", "C");
    expect(f.host.calls).toHaveLength(3); // B, A, D; handoffs wait for A to finish.
    f.host.finish(1, "A 的交接上下文");
    await until(() => f.host.calls.length === 4);
    expect(f.task("A", root.id)).toMatchObject({ id: parent.id, status: "waiting" });
    expect(f.task("B", root.id)).toMatchObject({ status: "queued", parentTaskId: parent.id });
    expect(f.host.text(3)).toContain("A 的交接上下文");
    await f.handoff("C", "E");
    f.host.finish(3);
    await until(() => f.host.calls.length === 5);
    expect(f.task("E", root.id)?.parentTaskId).toBe(f.task("C", root.id)?.id);
    expect(f.scheduler.cancel(f.room.id, parent.id)).toBe(true);
    expect(f.host.calls[4]?.signal.aborted).toBe(true);
    expect(f.task("E", root.id)?.status).toBe("cancelling");
    expect(f.task("B", root.id)).toBeUndefined();
    expect(f.task("B", independent.id)?.status).toBe("running");
    expect(f.host.calls[0]?.signal.aborted).toBe(false);
    expect(f.host.calls[2]?.signal.aborted).toBe(false);
    f.host.finish(4);
    f.host.finish(0);
    await until(() => !f.task("A", root.id));
    expect(f.host.calls).toHaveLength(5);
    expect(f.task("D", root.id)?.status).toBe("running");
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
  });

  test("a handoff to an existing root is ignored without creating a cancellation dependency", async () => {
    const f = fixture();
    const root = f.say("@A @B 处理");
    const a = f.task("A", root.id);
    expect(await f.handoff("A", "B")).toContain("忽略");
    expect(f.scheduler.cancel(f.room.id, a?.id)).toBe(true);
    expect(f.host.calls[1]?.signal.aborted).toBe(false);
    f.host.finish(0);
    f.host.finish(1);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(2);
  });

  test("parallel parents reserve one shared handoff budget and deduplicate pending targets", async () => {
    const f = fixture(["A", "B", "C", "D", "E", "F", "G", "H"]);
    f.say("@A @B 预算");
    const results = await Promise.all([
      f.handoff("A", "C"),
      f.handoff("B", "C"),
      f.handoff("A", "D"),
      f.handoff("B", "E"),
      f.handoff("A", "F"),
      f.handoff("B", "G"),
      f.handoff("B", "H"),
    ]);
    expect(results[1]).toContain("忽略");
    expect(results[6]).toContain("上限");
    f.host.finish(0);
    f.host.finish(1);
    await until(() => f.host.calls.length === 2 + MAX_AGENT_HOPS);
    expect(
      f.host.calls
        .slice(2)
        .map((c) => c.agent.name)
        .sort(),
    ).toEqual(["C", "D", "E", "F", "G"]);
    for (let i = 2; i < f.host.calls.length; i++) f.host.finish(i);
    await f.scheduler.idle(f.room.id);
  });

  test("failed sources release reserved handoffs for the remaining independent root", async () => {
    const f = fixture(["A", "B", "C", "D", "E", "F", "G", "H"]);
    f.say("@A @B 共享请求");
    for (const name of ["C", "D", "E", "F", "G"]) await f.handoff("A", name);
    expect(await f.handoff("B", "H")).toContain("上限");
    f.host.calls[0]?.result.reject(new Error("A failed before dispatch"));
    await until(() => !f.task("A"));
    expect(await f.handoff("B", "C")).toContain("已交接");
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    expect(f.host.calls[2]?.agent.name).toBe("C");
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
  });

  test("handoffs join the target's existing FIFO and preserve the original request after its own earlier reply", async () => {
    const f = fixture();
    const root = f.say("@A 原始请求");
    await f.handoff("A", "B");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    f.say("@A 后来的独立请求");
    expect(f.host.calls[2]?.agent.name).toBe("A");
    await f.handoff("B", "A", "返回原始任务");
    f.host.finish(1);
    await until(() =>
      f.scheduler
        .state(f.room.id)
        .tasks.some((t) => t.agentName === "A" && t.runId === root.id && t.status === "queued"),
    );
    expect(
      f.scheduler
        .state(f.room.id)
        .tasks.filter((t) => t.agentName === "A")
        .map((t) => t.status),
    ).toEqual(["waiting", "running", "queued"]);
    f.host.finish(2);
    await until(() => f.host.calls.length === 4);
    expect(f.host.text(3)).toContain("<tuantuan-task>\n[用户]: @A 原始请求\n</tuantuan-task>");
    expect(f.host.text(3)).toContain("返回原始任务");
    expect(f.host.text(3)).not.toContain("后来的独立请求");
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
  });

  test("@所有人 runs every member once even when a completed member is handed back work", async () => {
    const f = fixture(["A", "B", "C"]);
    f.say("@所有人 开始");
    f.host.finish(0);
    await until(() => !f.task("A"));
    expect(await f.handoff("B", "A")).toContain("忽略");
    f.host.finish(1);
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(3);
  });

  test("failed and cancelled sources do not dispatch handoffs, and late tools/updates are rejected", async () => {
    const f = fixture();
    const first = f.say("@A 错误");
    await f.handoff("A", "B");
    f.host.calls[0]?.result.reject(new Error("provider failed"));
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(1);
    expect(f.store.recentMessages(f.room.id, 1)[0]).toMatchObject({ status: "error", runId: first.id });
    const cancelled = f.say("@A 停止");
    await f.handoff("A", "B");
    f.say("@A 下一个");
    expect(f.scheduler.cancel(f.room.id, f.task("A", cancelled.id)?.id)).toBe(true);
    await expect(f.handoff("A", "C")).rejects.toThrow("未取消");
    f.host.finish(1, "取消后的迟到文本");
    await until(() => f.host.calls.length === 3);
    expect(
      f.store.recentMessages(f.room.id, 10).find((m) => m.runId === cancelled.id && m.senderKind === "agent"),
    ).toMatchObject({ status: "cancelled", content: "" });
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls.map((c) => c.agent.name)).toEqual(["A", "A", "A"]);
  });

  test("idle includes children enqueued after the wait began and messages posted during the wait", async () => {
    const f = fixture();
    f.say("@A 初始");
    let resolved = false;
    const waiting = f.scheduler.idle(f.room.id).then(() => {
      resolved = true;
    });
    await f.handoff("A", "B");
    f.say("@C 后续独立消息");
    f.host.finish(0);
    await until(() => f.host.calls.length === 3);
    f.host.finish(1);
    await Bun.sleep(0);
    expect(resolved).toBe(false);
    f.host.finish(2);
    await waiting;
  });

  test("queued tasks revalidate membership; deleted rooms never receive late reply writes", async () => {
    const f = fixture();
    f.say("@A 当前");
    f.say("@A 已移除");
    f.store.setRoomAgents(
      f.room.id,
      f.agents.slice(1).map((a) => a.id),
    );
    f.host.finish(0);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(1);
    f.say("@B 删除会话");
    f.scheduler.cancelAll(f.room.id);
    f.store.deleteRoom(f.room.id);
    const eventCount = f.events.length;
    f.host.finish(1);
    await f.scheduler.idle(f.room.id);
    expect(f.events.slice(eventCount).filter((e) => e.type === "message" || e.type === "update")).toEqual([]);
  });

  test("routing, quoted original requests, and long queued input stay attached to their own tasks", async () => {
    const f = fixture();
    const quoted = f.say("@B 作为引用的材料");
    f.host.finish(0);
    await f.scheduler.idle(f.room.id);
    const root = f.scheduler.postHumanMessage(
      f.room.id,
      "用户",
      `@A ${"完整原文".repeat(700)} 尾部关键请求`,
      [],
      quoted.id,
    );
    f.say("@A 后来的消息");
    expect(f.host.text(1)).toContain("作为引用的材料");
    expect(f.host.text(1)).toContain(root.content);
    expect(f.host.text(1)).not.toContain("后来的消息");
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
    f.say("无提及由主Agent处理");
    expect(f.host.calls[3]?.agent.name).toBe("A");
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
  });

  test("DM default stop cancels only the current task; shutdown prevents queued or future work", async () => {
    const f = fixture(["A"]);
    f.say("当前");
    f.say("随后");
    expect(f.scheduler.cancel(f.room.id)).toBe(true);
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    f.say("关闭时排队");
    f.scheduler.shutdown();
    expect(f.host.calls[1]?.signal.aborted).toBe(true);
    expect(() => f.say("关闭后")).toThrow("服务正在关闭");
    f.host.finish(1);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(2);
  });
});
