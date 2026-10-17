import { afterAll, expect, test } from "bun:test";
import { serve } from "../server/app";
import type { Message } from "../server/store";
import { emptyTimeline } from "../shared/timeline";
import { agentInput } from "./helpers";

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

/** A human request that was interrupted before the agent answered, as the transcript stores it. */
function interruptedRun(roomId: string, agentId: string, agentName: string, content: string) {
  const human = app.store.insertMessage({
    roomId,
    runId: crypto.randomUUID(),
    hop: 0,
    senderKind: "human",
    senderId: null,
    senderName: "Andy",
    content,
    status: "done",
  });
  const interrupted = app.store.insertMessage({
    roomId,
    runId: human.id,
    hop: 1,
    senderKind: "agent",
    senderId: agentId,
    senderName: agentName,
    content: "",
    status: "interrupted",
  });
  return { human: app.store.getMessage(human.id) as Message, interrupted };
}

test("retry re-posts the original request as a new run that quotes it (DM)", async () => {
  const agent = app.store.createAgent(agentInput("RetrySolo"));
  const room = app.store.createRoom("单聊重试", [agent.id], { mainAgentId: agent.id });
  const { human, interrupted } = interruptedRun(room.id, agent.id, agent.name, "执行发布巡检");
  app.store.updateReply(human.id, {
    content: human.content,
    status: "done",
    timeline: { ...emptyTimeline(), parts: [{ kind: "image", mimeType: "image/png", data: "aGk=" }] },
  });
  const original = app.store.getMessage(human.id) as Message;

  const retried = await api<Message>("POST", `/api/rooms/${room.id}/messages/${interrupted.id}/retry`);
  expect(retried.status).toBe(201);
  expect(retried.data).toMatchObject({
    senderKind: "human",
    senderName: "Andy",
    content: "执行发布巡检",
    quote: { messageId: original.id, text: "执行发布巡检" },
  });
  // A new run, not a continuation of the interrupted one.
  expect(retried.data.id).not.toBe(original.id);
  expect(retried.data.runId).toBe(retried.data.id);
  // Attached images follow the request so the new run sees the same input.
  expect(retried.data.timeline?.parts).toEqual([{ kind: "image", mimeType: "image/png", data: "aGk=" }]);

  await app.orchestrator.idle(room.id);
  const replies = app.store
    .recentMessages(room.id, 50)
    .filter((m) => m.runId === retried.data.id && m.senderKind === "agent");
  expect(replies[0]).toMatchObject({ senderId: agent.id, status: "done" });
});

test("only an interrupted agent message can be retried", async () => {
  const agent = app.store.createAgent(agentInput("RetryGuard"));
  const room = app.store.createRoom("重试校验", [agent.id], { mainAgentId: agent.id });
  const { human, interrupted } = interruptedRun(room.id, agent.id, agent.name, "原请求");

  // Only agent replies expose retry; a human message is not a retryable request.
  expect((await api("POST", `/api/rooms/${room.id}/messages/${human.id}/retry`)).status).toBe(404);
  expect((await api("POST", `/api/rooms/${room.id}/messages/missing/retry`)).status).toBe(404);

  app.store.updateReply(interrupted.id, { content: "完成", status: "done", timeline: emptyTimeline() });
  expect((await api("POST", `/api/rooms/${room.id}/messages/${interrupted.id}/retry`)).status).toBe(400);
});

test("retry keeps the original mentions and the group leader fallback", async () => {
  const lead = app.store.createAgent(agentInput("RetryLead"));
  const mate = app.store.createAgent(agentInput("RetryMate"));
  const room = app.store.createRoom("群聊重试", [lead.id, mate.id], { mainAgentId: lead.id });

  const directed = interruptedRun(room.id, mate.id, mate.name, `@${mate.name} 检查日志`);
  const directedRetry = await api<Message>("POST", `/api/rooms/${room.id}/messages/${directed.interrupted.id}/retry`);
  expect(directedRetry.status).toBe(201);
  expect(directedRetry.data.content).toBe(`@${mate.name} 检查日志`);
  await app.orchestrator.idle(room.id);
  expect(
    app.store
      .recentMessages(room.id, 50)
      .filter((m) => m.runId === directedRetry.data.id && m.senderKind === "agent")
      .map((m) => m.senderId),
  ).toEqual([mate.id]);

  // No @ in a group still goes to the main agent, exactly like the original request did.
  const open = interruptedRun(room.id, lead.id, lead.name, "帮我看看发布状态");
  const openRetry = await api<Message>("POST", `/api/rooms/${room.id}/messages/${open.interrupted.id}/retry`);
  expect(openRetry.status).toBe(201);
  await app.orchestrator.idle(room.id);
  expect(
    app.store
      .recentMessages(room.id, 50)
      .filter((m) => m.runId === openRetry.data.id && m.senderKind === "agent")
      .map((m) => m.senderId),
  ).toEqual([lead.id]);
});

test("an interrupted message whose run predates a stored request is a conflict", async () => {
  const agent = app.store.createAgent(agentInput("RetryMissingRun"));
  const room = app.store.createRoom("找不到原请求", [agent.id], { mainAgentId: agent.id });
  const stray = app.store.insertMessage({
    roomId: room.id,
    runId: "missing-run",
    hop: 1,
    senderKind: "agent",
    senderId: agent.id,
    senderName: agent.name,
    content: "",
    status: "interrupted",
  });
  const response = await api<{ error: string }>("POST", `/api/rooms/${room.id}/messages/${stray.id}/retry`);
  expect(response.status).toBe(409);
  expect(response.data.error).toBe("找不到原请求");
});
