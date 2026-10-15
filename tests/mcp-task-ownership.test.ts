import { afterEach, describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { HarnessHost } from "../server/host";
import { Orchestrator } from "../server/orchestrator";
import { Store } from "../server/store";
import { TuantuanMcp } from "../server/tuantuan-mcp";
import { agentInput, until } from "./helpers";

type PromptArgs = Parameters<HarnessHost["prompt"]>;
const cleanups: (() => Promise<void>)[] = [];
function fixture() {
  const store = new Store(":memory:");
  const agents = ["A", "B", "C"].map((name) => store.createAgent(agentInput(name)));
  const a = agents[0];
  if (!a) throw new Error("missing A");
  const room = store.createRoom(
    "ownership",
    agents.map((agent) => agent.id),
  );
  const calls: { agentId: string; resolve: (result: { stopReason: acp.StopReason }) => void }[] = [];
  const host = {
    prompt: (...args: PromptArgs) =>
      new Promise<{ stopReason: acp.StopReason }>((resolve) => calls.push({ agentId: args[1].id, resolve })),
  };
  const scheduler = new Orchestrator(store, host as unknown as HarnessHost, () => {});
  const mcp = new TuantuanMcp();
  mcp.provider = scheduler;
  const token = mcp.tokenFor({ roomId: room.id, agentId: a.id });
  const say = (content: string) => scheduler.postHumanMessage(room.id, "用户", `@A ${content}`);
  const finish = (index: number) => calls[index]?.resolve({ stopReason: "end_turn" });
  const delayedRequest = () => {
    let complete!: (body: unknown) => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        complete = (payload) => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
          controller.close();
        };
      },
    });
    // Enter handle while the stream is unreadable. Task ownership must be fixed before JSON arrives.
    const response = mcp.handle(token, new Request("http://localhost/mcp/test", { method: "POST", body }));
    return { complete, response };
  };
  const handoff = (id = 1, target = "B") => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "handoff", arguments: { agent: target, task: `交给${target}` } },
  });
  cleanups.push(async () => {
    scheduler.shutdown();
    for (let i = 0; i < calls.length; i++) finish(i);
    await scheduler.idle(room.id);
    store.db.close();
  });
  return { a, agents, room, scheduler, mcp, token, say, finish, calls, delayedRequest, handoff };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type ToolResult = { id: number; result: { isError: boolean; content: { type: string; text: string }[] } };

describe("MCP request task ownership", () => {
  test("a request begun in a cancelled turn cannot hand off from the next queued turn", async () => {
    const f = fixture();
    const old = f.say("旧任务");
    f.say("独立排队任务");
    const request = f.delayedRequest();
    const oldTask = f.scheduler.state(f.room.id).tasks.find((task) => task.runId === old.id);
    expect(f.scheduler.cancel(f.room.id, oldTask?.id)).toBe(true);
    f.finish(0);
    await until(() => f.calls.length === 2);
    request.complete(f.handoff());
    const result = (await (await request.response).json()) as ToolResult;
    expect(result.result.isError).toBe(true);
    f.finish(1);
    await f.scheduler.idle(f.room.id);
    expect(f.calls.map((call) => call.agentId)).toEqual([f.a.id, f.a.id]);
  });

  test("a request begun while idle cannot gain ownership when a task starts before its body arrives", async () => {
    const f = fixture();
    const request = f.delayedRequest();
    f.say("后来开始的任务");
    request.complete(f.handoff());
    const result = (await (await request.response).json()) as ToolResult;
    expect(result.result.isError).toBe(true);
    f.finish(0);
    await f.scheduler.idle(f.room.id);
    expect(f.calls).toHaveLength(1);
  });

  test("every item in a delayed JSON-RPC batch keeps the same original owner", async () => {
    const f = fixture();
    const old = f.say("旧任务");
    f.say("独立排队任务");
    const request = f.delayedRequest();
    f.scheduler.cancel(f.room.id, f.scheduler.state(f.room.id).tasks.find((task) => task.runId === old.id)?.id);
    f.finish(0);
    await until(() => f.calls.length === 2);
    request.complete([f.handoff(1, "B"), f.handoff(2, "C")]);
    const results = (await (await request.response).json()) as ToolResult[];
    expect(results.map((result) => result.result.isError)).toEqual([true, true]);
    f.finish(1);
    await f.scheduler.idle(f.room.id);
    expect(f.calls).toHaveLength(2);
  });

  test("a same-turn request remains valid and dispatches its handoff only after the source completes", async () => {
    const f = fixture();
    const root = f.say("正常任务");
    const request = f.delayedRequest();
    request.complete(f.handoff());
    const result = (await (await request.response).json()) as ToolResult;
    expect(result.result.isError).toBe(false);
    expect(f.calls).toHaveLength(1);
    f.finish(0);
    await until(() => f.calls.length === 2);
    expect(f.calls[1]?.agentId).toBe(f.agents[1]?.id);
    expect(f.scheduler.state(f.room.id).tasks.find((task) => task.agentId === f.agents[1]?.id)?.runId).toBe(root.id);
    f.finish(1);
    await f.scheduler.idle(f.room.id);
  });
});
