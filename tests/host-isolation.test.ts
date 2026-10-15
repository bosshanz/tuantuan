import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { CUSTOM_HARNESS } from "../server/custom";
import { HarnessHost } from "../server/host";
import { Store } from "../server/store";
import { type ToolCtx, type ToolProvider, TuantuanMcp } from "../server/tuantuan-mcp";
import { agentInput, until } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "tt-host-isolation-"));
const store = new Store(join(scratch, "host.db"));
const host = new HarnessHost(store, scratch, { session() {}, permission() {}, terminal() {} });
const text = (value: string): acp.ContentBlock[] => [{ type: "text", text: value }];

afterAll(async () => {
  host.shutdown();
  await Bun.sleep(300);
  store.db.close();
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string, env: Record<string, string> = {}) {
  const cwd = join(scratch, name);
  mkdirSync(cwd);
  const agent = store.createAgent(agentInput(`${name}Shared`, { env }));
  const other = store.createAgent(agentInput(`${name}Other`));
  const project = store.createProject(name, cwd);
  const one = store.createRoom(`${name} one`, [agent.id, other.id], { projectId: project.id });
  const two = store.createRoom(`${name} two`, [agent.id, other.id], { projectId: project.id });
  return { agent, other, one, two };
}

test("forcing cancellation of one room keeps the same agent in another room and another agent replying", async () => {
  const { agent, other, one, two } = fixture("CancelIsolation", { MOCK_AGENT_IGNORE_CANCEL: "1" });
  await host.setConfig(one, agent, "", "model", "mock-stuck");
  const target = await host.session(one, agent, "");
  const peer = await host.session(two, agent, "");
  const otherAgent = await host.session(one, other, "");
  const stopped = new AbortController();
  const cancelled = host.prompt(one, agent, "", text("stuck"), () => {}, stopped.signal).catch((error: Error) => error);
  let sameRoomOutput = "";
  let otherRoomOutput = "";
  const append = (update: acp.SessionUpdate) =>
    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : "";
  const peerReply = host
    .prompt(
      two,
      agent,
      "",
      text("/slow"),
      (update) => {
        otherRoomOutput += append(update);
      },
      new AbortController().signal,
    )
    .catch((error: Error) => error);
  const otherReply = host
    .prompt(
      one,
      other,
      "",
      text("/slow"),
      (update) => {
        sameRoomOutput += append(update);
      },
      new AbortController().signal,
    )
    .catch((error: Error) => error);
  await until(() => target.slot.turn !== null && otherRoomOutput.includes("0 ") && sameRoomOutput.includes("0 "));
  stopped.abort(new DOMException("cancel only target", "AbortError"));
  expect(await cancelled).toBe(stopped.signal.reason);
  await target.proc.acp.exited;
  expect(target.proc.acp.proc.signalCode).toBe("SIGKILL");
  expect(await peerReply).toMatchObject({ stopReason: "end_turn" });
  expect(await otherReply).toMatchObject({ stopReason: "end_turn" });
  expect(peer.proc.acp.proc.exitCode).toBeNull();
  expect(otherAgent.proc.acp.proc.exitCode).toBeNull();
  expect(otherRoomOutput).toContain("59 ");
  expect(sameRoomOutput).toContain("59 ");
  expect(host.view(one.id, agent.id)).toBeNull();
  expect(host.view(two.id, agent.id)?.sessionId).toBe(peer.slot.view.sessionId);
}, 12_000);

test("concurrent prompts and session switching cannot replace an active turn callback", async () => {
  const { agent, one } = fixture("ActiveGuard");
  let updates = 0;
  const initial = host
    .prompt(
      one,
      agent,
      "",
      text("/edit"),
      () => {
        updates++;
      },
      new AbortController().signal,
    )
    .catch((error: Error) => error);
  const current = await host.session(one, agent, "");
  const ask = await until(() => host.pendingAsks(one.id)[0]);
  const callback = current.slot.turn;
  const configured = await host.setConfig(one, agent, "", "model", "mock-smart");
  expect(configured.configOptions.find((option) => option.id === "model")?.currentValue).toBe("mock-smart");
  const second = await host
    .prompt(one, agent, "", text("overlap"), () => {}, new AbortController().signal)
    .catch((error: Error) => error);
  const switched = await host.switchSession(one, agent, "", null).catch((error: Error) => error);
  const preserved = current.slot.turn === callback;
  host.answer(ask.id, null);
  // Let the original request settle even on the regression path, so failures do not leak turns.
  const result = await initial;
  expect(second).toMatchObject({ status: 409 });
  expect(switched).toMatchObject({ status: 409 });
  expect(callback).not.toBeNull();
  expect(preserved).toBe(true);
  expect(result).toMatchObject({ stopReason: "end_turn" });
  expect(updates).toBeGreaterThan(1);
  expect(host.view(one.id, agent.id)?.sessionId).toBe(current.slot.view.sessionId);
}, 12_000);

test("switching one room only detaches its own slot when another room loaded the same history session", async () => {
  const { agent, one, two } = fixture("SessionOwnership", {
    MOCK_AGENT_SESSION_DIR: join(scratch, "persisted-history"),
  });
  const first = await host.session(one, agent, "");
  const sessionId = first.slot.view.sessionId;
  if (!sessionId) throw new Error("session missing");
  await host.prompt(one, agent, "", text("shared history"), () => {}, new AbortController().signal);
  expect((await host.listSessions(two, agent, "")).map((session) => session.sessionId)).toContain(sessionId);
  const loaded = await host.switchSession(two, agent, "", sessionId);
  const second = await host.session(two, agent, "");
  expect(second.proc.acp.proc.pid).not.toBe(first.proc.acp.proc.pid);
  expect(loaded.sessionId).toBe(sessionId);
  let output = "";
  const reply = host
    .prompt(
      two,
      agent,
      "",
      text("/edit"),
      (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
          output += update.content.text;
      },
      new AbortController().signal,
    )
    .catch((error: Error) => error);
  const ask = await until(() => host.pendingAsks(two.id)[0]);
  const currentTurn = second.slot.turn;
  await host.switchSession(one, agent, "", null);
  const attached = second.proc.sessions.get(sessionId) === second.slot;
  const preserved = second.slot.turn === currentTurn;
  host.answer(ask.id, null);
  const result = await reply;
  expect(attached).toBe(true);
  expect(preserved).toBe(true);
  expect(result).toMatchObject({ stopReason: "end_turn" });
  expect(output).toContain("没有修改");
  expect(host.view(two.id, agent.id)).toBe(loaded);
});

test("DM rooms also isolate processes while reusing the same room's warm session", async () => {
  const { agent, one } = fixture("DirectMessages");
  const first = store.createRoom("first DM", [agent.id], { projectId: one.projectId });
  const second = store.createRoom("second DM", [agent.id], { projectId: one.projectId });
  expect(first.kind).toBe("dm");
  const a = await host.session(first, agent, "");
  const b = await host.session(second, agent, "");
  expect(a.proc.acp.proc.pid).not.toBe(b.proc.acp.proc.pid);
  expect((await host.session(first, agent, "")).proc).toBe(a.proc);
});

test("BYOK prompts also reject concurrent turns and history reset until the active response finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const provider = Bun.serve({
    port: 0,
    async fetch() {
      requests++;
      await gate;
      return new Response('data: {"choices":[{"delta":{"content":"custom response"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    const agent = store.createAgent(
      agentInput("CustomGuard", {
        harness: CUSTOM_HARNESS,
        custom: {
          format: "openai-chat",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          model: "test-model",
          apiKey: "test-key",
        },
      }),
    );
    const room = store.createRoom("custom guarded", [agent.id]);
    let output = "";
    const first = host
      .prompt(
        room,
        agent,
        "",
        text("first"),
        (update) => {
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
            output += update.content.text;
        },
        new AbortController().signal,
      )
      .catch((error: Error) => error);
    await until(() => requests === 1);
    const overlapping = await host
      .prompt(room, agent, "", text("second"), () => {}, new AbortController().signal)
      .catch((error: Error) => error);
    const reset = await host.switchSession(room, agent, "", null).catch((error: Error) => error);
    release();
    expect(await first).toMatchObject({ stopReason: "end_turn" });
    expect(overlapping).toMatchObject({ status: 409 });
    expect(reset).toMatchObject({ status: 409 });
    expect(requests).toBe(1);
    expect(output).toBe("custom response");
    expect((await host.switchSession(room, agent, "", null)).harness).toBe(CUSTOM_HARNESS);
  } finally {
    release();
    provider.stop(true);
  }
});

function customToolFixture(name: string, tools: ToolProvider, beforeResponse: () => Promise<void> = async () => {}) {
  const bridge = new TuantuanMcp();
  bridge.provider = tools;
  const customHost = new HarnessHost(store, scratch, { session() {}, permission() {}, terminal() {} }, bridge);
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      requests++;
      await beforeResponse();
      const events = body.messages.some((message) => message.role === "tool")
        ? [{ choices: [{ delta: { content: "finished" } }] }]
        : [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "handoff-1",
                        function: { name: "handoff", arguments: '{"agent":"Peer","task":"old handoff"}' },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ];
      return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const agent = store.createAgent(
    agentInput(name, {
      harness: CUSTOM_HARNESS,
      custom: {
        format: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        model: "test-model",
        apiKey: "test-key",
      },
    }),
  );
  const peer = store.createAgent(agentInput(`${name}Peer`));
  const room = store.createRoom(name, [agent.id, peer.id]);
  return {
    customHost,
    agent,
    room,
    requests: () => requests,
    close() {
      customHost.shutdown();
      server.stop(true);
    },
  };
}

const handoffTool = { name: "handoff", description: "handoff", inputSchema: { type: "object" } };

test("BYOK binds tools to the task captured before an asynchronous model response", async () => {
  let currentTask = "original-task";
  let captures = 0;
  const seen: ToolCtx[] = [];
  const accepted: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = customToolFixture(
    "BoundCustomTask",
    {
      captureContext(ctx) {
        captures++;
        return { ...ctx, taskId: currentTask };
      },
      tools() {
        return [handoffTool];
      },
      async call(ctx) {
        seen.push({ ...ctx });
        // Legacy callers omit taskId and would resolve the current task at call time.
        const taskId = ctx.taskId === undefined ? currentTask : ctx.taskId;
        if (taskId !== currentTask) throw new Error("任务已结束，不能继续交接");
        accepted.push(taskId);
        return "accepted";
      },
    },
    () => gate,
  );
  try {
    const result = fixture.customHost.prompt(
      fixture.room,
      fixture.agent,
      "",
      text("handoff"),
      () => {},
      new AbortController().signal,
    );
    await until(() => fixture.requests() === 1);
    currentTask = "replacement-task";
    release();
    expect(await result).toMatchObject({ stopReason: "end_turn" });
    expect(captures).toBe(1);
    expect(seen).toEqual([{ roomId: fixture.room.id, agentId: fixture.agent.id, taskId: "original-task" }]);
    expect(accepted).toEqual([]);
  } finally {
    release();
    fixture.close();
  }
});

test("cancelling at a BYOK tool notification prevents the subsequent tool callback", async () => {
  const calls: string[] = [];
  const fixture = customToolFixture("CancelledCustomTool", {
    captureContext(ctx) {
      return { ...ctx, taskId: "cancelled-task" };
    },
    tools() {
      return [handoffTool];
    },
    async call(_ctx, name) {
      calls.push(name);
      return "unexpected handoff";
    },
  });
  const controller = new AbortController();
  try {
    const result = await fixture.customHost
      .prompt(
        fixture.room,
        fixture.agent,
        "",
        text("handoff"),
        (update) => {
          if (update.sessionUpdate === "tool_call") controller.abort(new DOMException("cancel tool", "AbortError"));
        },
        controller.signal,
      )
      .catch((error: Error) => error);
    expect(controller.signal.aborted).toBe(true);
    expect(result).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  } finally {
    fixture.close();
  }
});
