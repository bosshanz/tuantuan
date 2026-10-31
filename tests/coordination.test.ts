import { afterEach, describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { HarnessHost } from "../server/host";
import { MAX_AGENT_HOPS, Orchestrator, type RoomEvent } from "../server/orchestrator";
import { Store } from "../server/store";
import { agentInput, until } from "./helpers";

type PromptArgs = Parameters<HarnessHost["prompt"]>;
class ControlledHost {
  calls: {
    agent: PromptArgs[1];
    blocks: PromptArgs[3];
    update: PromptArgs[4];
    signal: AbortSignal;
    resolve: (value: { stopReason: acp.StopReason }) => void;
    reject: (error: Error) => void;
  }[] = [];
  prompt(...args: PromptArgs) {
    const [, agent, , blocks, update, signal] = args;
    return new Promise<{ stopReason: acp.StopReason }>((resolve, reject) => {
      this.calls.push({ agent, blocks, update, signal, resolve, reject });
    });
  }
  finish(index: number, text = `result-${index}`) {
    const call = this.calls[index];
    if (!call) throw new Error(`missing prompt ${index}`);
    call.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    call.resolve({ stopReason: "end_turn" });
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
function fixture(names = ["Lead", "Dev", "Test"]) {
  const store = new Store(":memory:");
  const agents = names.map((name) => store.createAgent(agentInput(name)));
  const room = store.createRoom(
    "统筹",
    agents.map((a) => a.id),
    { mainAgentId: agents[0]?.id },
  );
  const host = new ControlledHost();
  const events: RoomEvent[] = [];
  const scheduler = new Orchestrator(store, host as unknown as HarnessHost, (_roomId, event) => events.push(event));
  const agent = (name: string) => {
    const found = agents.find((a) => a.name === name);
    if (!found) throw new Error(`missing agent ${name}`);
    return found;
  };
  const context = (name: string) => scheduler.captureContext({ roomId: room.id, agentId: agent(name).id });
  const call = (name: string, tool: string, args: Record<string, unknown>) => scheduler.call(context(name), tool, args);
  const handoff = (to: string, task = `交给 ${to} 的任务`, from = names[0] as string) =>
    call(from, "handoff", { agent: to, task });
  const tasks = (runId?: string) => scheduler.state(room.id).tasks.filter((t) => !runId || t.runId === runId);
  const task = (name: string, runId?: string) => tasks(runId).findLast((t) => t.agentName === name);
  const say = (text: string) => scheduler.postHumanMessage(room.id, "用户", text);
  const replies = (runId: string) =>
    store.recentMessages(room.id, 100).filter((m) => m.runId === runId && m.senderKind === "agent");
  const f = { store, agents, agent, room, host, scheduler, events, context, call, handoff, tasks, task, say, replies };
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

describe("unmentioned group requests are coordinated by their frozen leader", () => {
  test("publishes and persists the handoff source on the first streaming message", async () => {
    const f = fixture();
    const run = f.say("请完成任务");
    await f.handoff("Dev", "实现功能");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    const devStarts = f.events.filter(
      (event) => event.type === "message" && event.message.senderId === f.agent("Dev").id,
    );
    expect(devStarts).toHaveLength(1);
    const start = devStarts[0];
    expect(start?.type).toBe("message");
    if (start?.type !== "message") throw new Error("missing delegated message");
    const source = { agentId: f.agent("Lead").id, agentName: "Lead", task: "实现功能" };
    expect(start.message).toMatchObject({ runId: run.id, status: "streaming", timeline: { handoffFrom: source } });
    expect(f.store.getMessage(start.message.id)?.timeline?.handoffFrom).toEqual(source);
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
  });

  test("a parallel batch settles completely before exactly one leader review", async () => {
    const f = fixture();
    const run = f.say("实现并验证这个功能");
    const root = f.task("Lead", run.id);
    expect(root).toMatchObject({ parentTaskId: null, coordination: "lead" });
    expect(f.host.text(0)).toContain('<tuantuan-coordination mode="leader" phase="initial">');
    expect(f.host.text(0)).toContain("<tuantuan-task>\n[用户]: 实现并验证这个功能\n</tuantuan-task>");
    await f.handoff("Dev", "实现功能");
    await f.handoff("Test", "验证功能");
    expect(f.host.calls).toHaveLength(1);
    f.host.finish(0, "已安排开发与验证");
    await until(() => f.host.calls.length === 3);
    expect(f.host.calls.slice(1).map((c) => c.agent.name)).toEqual(["Dev", "Test"]);
    for (const name of ["Dev", "Test"])
      expect(f.task(name, run.id)).toMatchObject({ parentTaskId: root?.id, coordination: "work" });
    expect(f.host.text(1)).toContain('<tuantuan-coordination mode="member" phase="initial">');
    expect(f.host.text(1)).toContain("实现功能");
    const leaderResult = f.replies(run.id)[0];
    expect(JSON.parse(await f.call("Dev", "read_result", { messageId: leaderResult?.id })).content).toBe(
      "已安排开发与验证",
    );
    await expect(f.handoff("Test", "越权继续分工", "Dev")).rejects.toThrow();
    f.host.finish(2, "验证通过");
    await until(() => f.replies(run.id).some((m) => m.content === "验证通过"));
    expect(f.host.calls).toHaveLength(3);
    f.host.finish(1, "实现完成");
    await until(() => f.host.calls.length === 4);
    expect(f.host.calls[3]?.agent.name).toBe("Lead");
    expect(f.task("Lead", run.id)).toMatchObject({ parentTaskId: root?.id, coordination: "review" });
    const review = f.host.text(3);
    expect(review).toContain('<tuantuan-coordination mode="leader" phase="review">');
    // The same communication guidance accompanies the leader, both members and the follow-up,
    // without replacing their individual coordination or checkpoint requirements.
    for (let i = 0; i < 4; i++) {
      expect(f.host.text(i)).toContain("<tuantuan-response>");
      expect(f.host.text(i)).toContain("用 save_context(goal, decisions, pending) 保存完整任务快照");
    }
    for (const text of ["Dev", "Test", "实现功能", "验证功能", "实现完成", "验证通过"]) expect(review).toContain(text);
    for (const reply of f.replies(run.id).filter((m) => m.senderId !== f.agent("Lead").id))
      expect(review).toContain(reply.id);
    f.host.finish(3, "最终汇总");
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(4);
    expect(f.replies(run.id).map((m) => m.content)).toEqual(["已安排开发与验证", "实现完成", "验证通过", "最终汇总"]);
  });

  test("errors and queued cancellations are reported; cancelled members cannot be automatically reassigned", async () => {
    const f = fixture();
    const occupied = f.say("@Test 独立任务占用测试成员");
    const run = f.say("需要两个成员完成");
    await f.handoff("Dev", "会失败的实现");
    await f.handoff("Test", "排队的测试");
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    expect(f.task("Test", run.id)).toMatchObject({ status: "queued", messageId: null });
    expect(f.scheduler.cancel(f.room.id, f.task("Test", run.id)?.id)).toBe(true);
    await Bun.sleep(0);
    expect(f.host.calls).toHaveLength(3);
    f.host.calls[2]?.reject(new Error("开发服务不可用"));
    await until(() => f.host.calls.length === 4);
    const review = f.host.text(3);
    for (const text of ["Dev", "Test", "error", "cancelled", "开发服务不可用", "排队的测试"])
      expect(review).toContain(text);
    const failed = f.replies(run.id).find((m) => m.status === "error");
    expect(JSON.parse(await f.call("Lead", "read_result", { messageId: failed?.id }))).toMatchObject({
      status: "error",
      error: "开发服务不可用",
      content: "",
      nextOffset: null,
    });
    expect(await f.handoff("Test", "自动重试已取消成员")).not.toContain("已交接给");
    expect(f.host.calls[0]?.signal.aborted).toBe(false);
    f.host.finish(3, "失败和取消的汇总");
    f.host.finish(0);
    await f.scheduler.idle(f.room.id);
    expect(f.replies(run.id).map((m) => m.status)).toEqual(["done", "error", "done"]);
    expect(f.replies(occupied.id)).toHaveLength(1);
    const manual = f.say("@Test 手动重新安排");
    expect(f.task("Test", manual.id)?.status).toBe("running");
    f.host.finish(4);
    await f.scheduler.idle(f.room.id);
  });

  test("running member cancellation still produces a review without cancelling its sibling", async () => {
    const f = fixture();
    const run = f.say("并行处理");
    await f.handoff("Dev");
    await f.handoff("Test");
    f.host.finish(0);
    await until(() => f.host.calls.length === 3);
    expect(f.scheduler.cancel(f.room.id, f.task("Dev", run.id)?.id)).toBe(true);
    expect(f.host.calls[1]?.signal.aborted).toBe(true);
    expect(f.host.calls[2]?.signal.aborted).toBe(false);
    f.host.finish(1, "取消后的迟到结果");
    await until(() => f.replies(run.id)[1]?.status === "cancelled");
    expect(f.host.calls).toHaveLength(3);
    f.host.finish(2, "保留的成员结果");
    await until(() => f.host.calls.length === 4);
    expect(f.host.text(3)).toContain("cancelled");
    expect(f.host.text(3)).toContain("保留的成员结果");
    expect(f.host.text(3)).not.toContain("取消后的迟到结果");
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
  });

  test("cancelling the last queued worker immediately reviews its null-message result", async () => {
    const f = fixture();
    f.say("@Dev 独立任务占用成员");
    const run = f.say("只分配一个排队成员");
    await f.handoff("Dev", "尚未开始的工作");
    f.host.finish(1);
    await until(() => f.task("Dev", run.id)?.status === "queued");
    expect(f.scheduler.cancel(f.room.id, f.task("Dev", run.id)?.id)).toBe(true);
    await until(() => f.host.calls.length === 3);
    const results = f.host.text(2).match(/<tuantuan-results>\n([\s\S]*?)\n<\/tuantuan-results>/)?.[1];
    expect(JSON.parse(results ?? "[]")).toEqual([
      expect.objectContaining({
        agentName: "Dev",
        task: "尚未开始的工作",
        status: "cancelled",
        messageId: null,
        content: "",
      }),
    ]);
    expect(f.host.calls[0]?.signal.aborted).toBe(false);
    f.host.finish(2);
    f.host.finish(0);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(3);
  });

  test("a group reduced to a DM preserves the active run's review and result tools only", async () => {
    const f = fixture(["Lead", "Dev"]);
    const run = f.say("协作完成后给出汇总");
    await f.handoff("Dev", "提供实现证据");
    f.host.finish(0, "已经安排成员处理");
    await until(() => f.host.calls.length === 2);
    const work = f.host.calls[1];
    if (!work) throw new Error("missing member prompt");
    work.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "取消前的部分证据" } });
    const reduced = f.store.setRoomAgents(f.room.id, [f.agent("Lead").id]);
    expect(reduced.kind).toBe("dm");
    expect(f.scheduler.cancelAgent(f.room.id, f.agent("Dev").id)).toBe(true);
    expect(work.signal.aborted).toBe(true);
    f.host.finish(1, "移除后的迟到结果");
    await until(() => f.host.calls.length === 3);
    expect(f.task("Lead", run.id)).toMatchObject({ coordination: "review", status: "running" });
    const review = f.host.text(2);
    expect(review).toContain('<tuantuan-coordination mode="leader" phase="review">');
    const cancelled = f.replies(run.id).find((m) => m.senderId === f.agent("Dev").id);
    expect(cancelled).toMatchObject({ status: "cancelled", content: "取消前的部分证据" });
    const results = review.match(/<tuantuan-results>\n([\s\S]*?)\n<\/tuantuan-results>/)?.[1];
    expect(JSON.parse(results ?? "[]")).toEqual([
      expect.objectContaining({
        agentName: "Dev",
        task: "提供实现证据",
        status: "cancelled",
        messageId: cancelled?.id,
        content: "取消前的部分证据",
      }),
    ]);
    expect(f.scheduler.tools(f.context("Lead")).map((t) => t.name)).toContain("read_result");
    expect(JSON.parse(await f.call("Lead", "read_result", { messageId: cancelled?.id }))).toMatchObject({
      status: "cancelled",
      content: "取消前的部分证据",
      nextOffset: null,
    });
    const dm = f.say("接下来的单聊请求");
    expect(f.task("Lead", dm.id)?.status).toBe("queued");
    f.host.finish(2, "汇总成员已取消及部分证据");
    await until(() => f.host.calls.length === 4);
    expect(f.host.calls[3]?.blocks[0]).toEqual({ type: "text", text: "接下来的单聊请求" });
    expect(f.host.text(3)).toContain("<tuantuan-response>");
    expect(f.scheduler.tools(f.context("Lead"))).toEqual([]);
    await expect(f.call("Lead", "read_result", { messageId: cancelled?.id })).rejects.toThrow();
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(4);
  });

  test("review can reuse a member through the shared five-handoff budget, including its final review", async () => {
    const f = fixture();
    const run = f.say("逐轮改进实现");
    const rootId = f.task("Lead", run.id)?.id;
    for (let round = 0; round < MAX_AGENT_HOPS; round++) {
      const leaderIndex = round * 2;
      const leaderTask = f.task("Lead", run.id);
      expect(await f.handoff("Dev", `第 ${round + 1} 轮实现`)).toContain("已交接");
      f.host.finish(leaderIndex);
      await until(() => f.host.calls.length === leaderIndex + 2);
      expect(f.task("Dev", run.id)?.parentTaskId).toBe(leaderTask?.id);
      f.host.finish(leaderIndex + 1, `第 ${round + 1} 轮结果`);
      await until(() => f.host.calls.length === leaderIndex + 3);
      expect(f.task("Lead", run.id)).toMatchObject({ parentTaskId: rootId, coordination: "review" });
      expect(f.host.text(leaderIndex + 2)).toContain(`第 ${round + 1} 轮结果`);
    }
    expect(await f.handoff("Dev", "超出预算")).toContain("上限");
    f.host.finish(MAX_AGENT_HOPS * 2, "预算耗尽后的最终汇总");
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(1 + MAX_AGENT_HOPS * 2);
    expect(f.replies(run.id).at(-1)?.content).toBe("预算耗尽后的最终汇总");
  });

  test("reviews join the original leader FIFO and collect results only from their own run", async () => {
    const f = fixture();
    const first = f.say("第一项原始请求");
    await f.handoff("Dev", "第一项开发");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    const second = f.say("第二项独立请求");
    expect(f.host.calls[2]?.agent.name).toBe("Lead");
    await f.handoff("Test", "第二项测试");
    f.host.finish(1, "第一项专属结果");
    await until(() => f.tasks(first.id).some((t) => t.status === "queued" && t.agentName === "Lead"));
    expect(f.host.calls).toHaveLength(3);
    f.host.finish(2);
    await until(() => f.host.calls.length === 5);
    const firstReviewIndex = f.host.calls.findIndex((c, i) => i > 2 && c.agent.name === "Lead");
    const secondWorkIndex = f.host.calls.findIndex((c, i) => i > 2 && c.agent.name === "Test");
    expect(firstReviewIndex).toBeGreaterThan(2);
    expect(secondWorkIndex).toBeGreaterThan(2);
    expect(f.host.text(firstReviewIndex)).toContain("第一项原始请求");
    expect(f.host.text(firstReviewIndex)).toContain("第一项专属结果");
    expect(f.host.text(firstReviewIndex)).not.toContain("第二项独立请求");
    f.host.finish(secondWorkIndex, "第二项专属结果");
    await until(() => f.tasks(second.id).some((t) => t.agentName === "Lead" && t.status === "queued"));
    f.host.finish(firstReviewIndex, "第一项汇总");
    await until(() => f.host.calls.length === 6);
    expect(f.host.text(5)).toContain("第二项独立请求");
    expect(f.host.text(5)).toContain("第二项专属结果");
    const results = f.host.text(5).match(/<tuantuan-results>\n([\s\S]*?)\n<\/tuantuan-results>/)?.[1];
    expect(results).toBeDefined();
    expect(JSON.parse(results ?? "[]")).toEqual([
      expect.objectContaining({ agentName: "Test", task: "第二项测试", content: "第二项专属结果" }),
    ]);
    expect(results).not.toContain("第一项专属结果");
    f.host.finish(5, "第二项汇总");
    await f.scheduler.idle(f.room.id);
    expect(f.replies(first.id).at(-1)?.content).toBe("第一项汇总");
    expect(f.replies(second.id).at(-1)?.content).toBe("第二项汇总");
  });

  test("changing the room leader only changes new runs and identity has no persistent leader claim", async () => {
    const f = fixture();
    const first = f.say("原群主负责的请求");
    await f.handoff("Dev");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    const updated = f.store.updateRoom(f.room.id, { mainAgentId: f.agent("Test").id });
    const second = f.say("新群主负责的请求");
    expect(f.task("Test", second.id)).toMatchObject({ coordination: "lead", status: "running" });
    expect(f.scheduler.identityFor(updated, f.agent("Test"))).not.toContain("你是本会话的主 Agent");
    expect(f.scheduler.identityFor(updated, f.agent("Test"))).not.toContain("没人被 @ 时由你回复");
    f.host.finish(1, "原群主需要的结果");
    await until(() => f.host.calls.length === 4);
    expect(f.host.calls[3]?.agent.name).toBe("Lead");
    expect(f.task("Lead", first.id)).toMatchObject({ coordination: "review" });
    f.host.finish(2);
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(4);
  });
});

describe("coordination cancellation boundaries", () => {
  test("the original leader task remains the cancellation ancestor for later batches", async () => {
    const f = fixture();
    const run = f.say("需要多轮协作");
    const rootId = f.task("Lead", run.id)?.id;
    await f.handoff("Dev");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    await f.handoff("Test", "第二批任务");
    f.host.finish(2);
    await until(() => f.host.calls.length === 4);
    expect(f.scheduler.cancel(f.room.id, rootId)).toBe(true);
    expect(f.host.calls[3]?.signal.aborted).toBe(true);
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(4);
    expect(f.replies(run.id).at(-1)?.status).toBe("cancelled");
  });

  for (const reason of ["cancel", "remove", "shutdown"] as const)
    test(`${reason} leader prevents a later review`, async () => {
      const f = fixture();
      const run = f.say("待取消的统筹任务");
      const rootId = f.task("Lead", run.id)?.id;
      await f.handoff("Dev");
      f.host.finish(0);
      await until(() => f.host.calls.length === 2);
      if (reason === "cancel") expect(f.scheduler.cancel(f.room.id, rootId)).toBe(true);
      if (reason === "remove") {
        f.store.setRoomAgents(
          f.room.id,
          f.agents.slice(1).map((a) => a.id),
        );
        f.scheduler.cancelAgent(f.room.id, f.agent("Lead").id);
      }
      if (reason === "shutdown") f.scheduler.shutdown();
      f.host.finish(1);
      await f.scheduler.idle(f.room.id);
      expect(f.host.calls).toHaveLength(2);
    });

  test("a queued review can be cancelled through the original ancestor without stopping an independent request", async () => {
    const f = fixture();
    const run = f.say("第一项统筹");
    const rootId = f.task("Lead", run.id)?.id;
    await f.handoff("Dev");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    const independent = f.say("@Lead 独立占用群主");
    f.host.finish(1);
    await until(() => f.tasks(run.id).some((t) => t.agentName === "Lead" && t.status === "queued"));
    expect(f.scheduler.cancel(f.room.id, rootId)).toBe(true);
    expect(f.task("Lead", independent.id)?.status).toBe("running");
    expect(f.host.calls[2]?.signal.aborted).toBe(false);
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(3);
  });
});

describe("direct routing stays direct", () => {
  for (const text of ["@Lead 显式找群主", "@Dev 显式找成员", "@所有人 所有成员"])
    test(text, async () => {
      const f = fixture();
      const run = f.say(text);
      for (let i = 0; i < f.host.calls.length; i++) {
        expect(f.host.text(i)).toContain('<tuantuan-coordination mode="direct" phase="initial">');
        expect(f.host.text(i)).toContain("<tuantuan-response>");
        f.host.finish(i);
      }
      await f.scheduler.idle(f.room.id);
      expect(f.replies(run.id)).toHaveLength(text.includes("@所有人") ? 3 : 1);
    });

  test("explicit leader mentions preserve direct handoff and never schedule automatic review", async () => {
    const f = fixture();
    f.say("@Lead 直接交接");
    await f.handoff("Dev");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    expect(f.host.text(1)).toContain('<tuantuan-coordination mode="direct" phase="initial">');
    await f.handoff("Test", "成员继续直接交接", "Dev");
    f.host.finish(1);
    await until(() => f.host.calls.length === 3);
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls.map((c) => c.agent.name)).toEqual(["Lead", "Dev", "Test"]);
  });

  test("DM requests and images stay intact alongside response guidance on every turn", async () => {
    const f = fixture(["Lead"]);
    const image = { mimeType: "image/png", data: Buffer.from("original-image").toString("base64") };
    f.scheduler.postHumanMessage(f.room.id, "用户", "保持单聊", [image]);
    expect(f.host.calls[0]?.blocks.slice(0, 2)).toEqual([
      { type: "text", text: "保持单聊" },
      { type: "image", ...image },
    ]);
    expect(f.host.text(0)).toContain("<tuantuan-response>");
    expect(f.host.text(0)).not.toContain("<tuantuan-coordination");
    expect(f.scheduler.tools(f.context("Lead"))).toEqual([]);
    f.host.finish(0);
    await f.scheduler.idle(f.room.id);
    f.say("继续，详细说明");
    expect(f.host.calls[1]?.blocks[0]).toEqual({ type: "text", text: "继续，详细说明" });
    expect(f.host.text(1)).toContain("<tuantuan-response>");
    expect(f.host.text(1)).toContain("用户明确要求详细时按其要求");
    f.host.finish(1);
    await f.scheduler.idle(f.room.id);
    expect(f.host.calls).toHaveLength(2);
  });

  test("native DM commands reach the host as one original text block", async () => {
    const f = fixture(["Lead"]);
    for (const command of ["/usage", "/mcp reconnect example", "/not-yet-declared argument"]) {
      const index = f.host.calls.length;
      f.say(command);
      expect(f.host.calls[index]?.blocks).toEqual([{ type: "text", text: command }]);
      f.host.finish(index);
      await f.scheduler.idle(f.room.id);
    }
    f.say("继续普通任务");
    expect(f.host.calls[3]?.blocks[0]).toEqual({ type: "text", text: "继续普通任务" });
    expect(f.host.text(3)).toContain("<tuantuan-response>");
    f.host.finish(3);
    await f.scheduler.idle(f.room.id);
  });

  test("slash detection preserves image blocks and treats quoted slash text as a model request", async () => {
    const f = fixture(["Lead"]);
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.from("command-image").toString("base64"),
    };
    const first = f.scheduler.postHumanMessage(f.room.id, "用户", "/usage", [image]);
    expect(f.host.calls[0]?.blocks).toEqual([{ type: "text", text: "/usage" }, image]);
    f.host.finish(0);
    await f.scheduler.idle(f.room.id);
    f.scheduler.postHumanMessage(f.room.id, "用户", "/usage", [], first.id);
    expect(f.host.text(1)).toContain("以下是用户本次引用的历史消息摘录");
    expect(f.host.text(1)).toContain("<tuantuan-response>");
    f.host.finish(1);
    await f.scheduler.idle(f.room.id);
  });

  test("wrapped group slash requests and BYOK slash text still receive response guidance", async () => {
    const group = fixture();
    group.say("/usage");
    expect(group.host.text(0)).toContain("<tuantuan-task>\n[用户]: /usage\n</tuantuan-task>");
    expect(group.host.text(0)).toContain("<tuantuan-response>");
    group.host.finish(0);
    await group.scheduler.idle(group.room.id);

    const dm = fixture(["Lead"]);
    dm.store.updateAgent(dm.agent("Lead").id, agentInput("Lead", { harness: "custom" }));
    dm.say("/usage");
    expect(dm.host.calls[0]?.blocks[0]).toEqual({ type: "text", text: "/usage" });
    expect(dm.host.text(0)).toContain("<tuantuan-response>");
    dm.host.finish(0);
    await dm.scheduler.idle(dm.room.id);
  });
});

describe("read_result is bounded to the current group run", () => {
  test("long settled results are clipped in review and can be read completely in validated pages", async () => {
    const f = fixture();
    const run = f.say("读取长结果");
    const initialContext = f.context("Lead");
    await f.handoff("Dev", "给出长输出");
    f.host.finish(0);
    await until(() => f.host.calls.length === 2);
    const content = `${"x".repeat(6000)}界${"尾".repeat(6100)}`;
    f.host.finish(1, content);
    await until(() => f.host.calls.length === 3);
    const result = f.replies(run.id)[1];
    if (!result) throw new Error("missing work reply");
    await expect(f.scheduler.call(initialContext, "read_result", { messageId: result.id })).rejects.toThrow();
    const review = f.host.text(2);
    expect(review).toContain("read_result");
    expect(review).toContain(result.id);
    expect(review).not.toContain(content);
    expect(review).not.toContain("尾".repeat(100));
    const results = review.match(/<tuantuan-results>\n([\s\S]*?)\n<\/tuantuan-results>/)?.[1];
    expect(JSON.parse(results ?? "[]")).toEqual([
      expect.objectContaining({ messageId: result.id, content: content.slice(0, 6000), truncated: true }),
    ]);
    let joined = "";
    let offset: number | null = 0;
    do {
      const page = JSON.parse(await f.call("Lead", "read_result", { messageId: result.id, offset })) as {
        content: string;
        nextOffset: number | null;
      };
      expect(page.content.length).toBeLessThanOrEqual(6000);
      expect(page.content).toBe(content.slice(offset, offset + 6000));
      joined += page.content;
      expect(page.nextOffset).toBe(offset + page.content.length < content.length ? offset + page.content.length : null);
      offset = page.nextOffset;
    } while (offset !== null);
    expect(joined).toBe(content);
    const end = JSON.parse(await f.call("Lead", "read_result", { messageId: result.id, offset: content.length }));
    expect(end).toMatchObject({ content: "", nextOffset: null });
    for (const invalid of [-1, 0.5, "0", null, content.length + 1])
      await expect(f.call("Lead", "read_result", { messageId: result.id, offset: invalid })).rejects.toThrow();
    f.host.finish(2);
    await f.scheduler.idle(f.room.id);
  });

  test("advertising is stable, but reads reject other runs, human/streaming replies, late owners and removed members", async () => {
    const f = fixture();
    const memberCtx = { roomId: f.room.id, agentId: f.agent("Dev").id };
    const before = f.scheduler.tools(memberCtx).map((t) => t.name);
    expect(before).toContain("read_result");
    const first = f.say("@Lead 旧请求");
    const oldCtx = f.context("Lead");
    const oldReplyId = f.task("Lead", first.id)?.messageId;
    f.host.finish(0, "旧请求的已完成结果");
    await f.scheduler.idle(f.room.id);
    const run = f.say("@Lead 当前请求");
    expect(f.scheduler.tools(memberCtx).map((t) => t.name)).toEqual(before);
    await expect(f.call("Lead", "read_result", { messageId: oldReplyId })).rejects.toThrow();
    await expect(f.call("Lead", "read_result", { messageId: run.id })).rejects.toThrow();
    await expect(f.call("Lead", "read_result", { messageId: f.task("Lead", run.id)?.messageId })).rejects.toThrow();
    await expect(f.scheduler.call(oldCtx, "read_result", { messageId: oldReplyId })).rejects.toThrow();
    await expect(f.call("Dev", "read_result", { messageId: oldReplyId })).rejects.toThrow();
    await expect(
      f.scheduler.call({ roomId: f.room.id, agentId: "outsider" }, "read_result", { messageId: oldReplyId }),
    ).rejects.toThrow();
    f.store.setRoomAgents(f.room.id, [f.agent("Dev").id, f.agent("Test").id]);
    expect(f.scheduler.tools(f.context("Lead"))).toEqual([]);
    await expect(f.call("Lead", "read_result", { messageId: oldReplyId })).rejects.toThrow();
    f.host.finish(1);
    await f.scheduler.idle(f.room.id);
    const dm = fixture(["Only"]);
    dm.say("单聊");
    await expect(dm.call("Only", "read_result", { messageId: run.id })).rejects.toThrow();
    dm.host.finish(0);
    await dm.scheduler.idle(dm.room.id);
  });
});

describe("member reflux includes reported file change paths", () => {
  test("successful member edit tools attach path counts without diffs", async () => {
    const f = fixture(["Lead", "Dev"]);
    f.say("改一下文件");
    await f.handoff("Dev", "编辑 a.ts");
    f.host.finish(0, "已安排");
    await until(() => f.host.calls.length === 2);
    const member = f.host.calls[1];
    member?.update({
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit a.ts",
      kind: "edit",
      status: "completed",
      locations: [{ path: "a.ts" }],
      content: [{ type: "diff", path: "a.ts", oldText: "1", newText: "2" }],
    });
    member?.update({
      sessionUpdate: "tool_call",
      toolCallId: "shell-1",
      title: "sed",
      kind: "execute",
      status: "completed",
      locations: [{ path: "b.ts" }],
      content: [],
    });
    f.host.finish(1, "改完了");
    await until(() => f.host.calls.length === 3);
    const results = f.host.text(2).match(/<tuantuan-results>\n([\s\S]*?)\n<\/tuantuan-results>/)?.[1];
    const reports = JSON.parse(results ?? "[]") as { fileChanges?: { path: string; count: number }[] }[];
    expect(reports[0]?.fileChanges).toEqual([{ path: "a.ts", count: 1 }]);
    expect(JSON.stringify(reports[0])).not.toContain("oldText");
    expect(f.host.text(2)).toContain("fileChanges 仅列出成员通过 edit 工具报告的路径与次数");
  });
});
