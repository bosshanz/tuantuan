import { afterAll, expect, test } from "bun:test";
import { serve } from "../server/app";
import type { Message } from "../server/store";
import { agentInput } from "./helpers";

const { app, server } = serve({ dbPath: ":memory:" }, 0);
const base = `http://localhost:${server.port}`;
afterAll(() => {
  app.host.shutdown();
  server.stop(true);
});
const post = (room: string, data: unknown) =>
  fetch(`${base}/api/rooms/${room}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
const insert = (roomId: string, content: string, extra: Partial<Parameters<typeof app.store.insertMessage>[0]> = {}) =>
  app.store.insertMessage({
    roomId,
    runId: "fixture",
    hop: 0,
    senderKind: "human",
    senderId: null,
    senderName: "原作者",
    content,
    status: "done",
    ...extra,
  });

test("API ignores forged quote text, preserves a snapshot and routes only the new explicit mentions", async () => {
  const a = app.store.createAgent(agentInput("QuoteAlice"));
  const b = app.store.createAgent(agentInput("QuoteBob"));
  const room = app.store.createRoom("引用路由", [a.id, b.id], { mainAgentId: a.id });
  const source = insert(room.id, "历史原文 @QuoteBob @所有人");
  const response = await post(room.id, {
    senderName: "我",
    content: "只问主 Agent",
    replyToId: source.id,
    quote: { text: "伪造内容" },
  });
  expect(response.status).toBe(201);
  const sent = (await response.json()) as Message;
  expect(sent.content).toBe("只问主 Agent");
  expect(sent.quote?.text).toBe(source.content);
  await app.orchestrator.idle(room.id);
  expect(
    app.store
      .recentMessages(room.id, 30)
      .filter((m) => m.runId === sent.id && m.senderKind === "agent")
      .map((m) => m.senderId),
  ).toEqual([a.id]);
  const second = (await (
    await post(room.id, { senderName: "我", content: "@QuoteBob 继续", replyToId: source.id })
  ).json()) as Message;
  await app.orchestrator.idle(room.id);
  expect(
    app.store
      .recentMessages(room.id, 30)
      .filter((m) => m.runId === second.id && m.senderKind === "agent")
      .map((m) => m.senderId),
  ).toEqual([b.id]);
  const loaded = (await (await fetch(`${base}/api/rooms/${room.id}/messages`)).json()) as { messages: Message[] };
  expect(loaded.messages.find((m) => m.id === sent.id)?.quote).toEqual(sent.quote);
  const invalid = await post(room.id, { senderName: "我", content: "失败", replyToId: "missing" });
  expect(invalid.status).toBe(400);
});

test("quoted source is explicitly sent to the Agent beyond recent history and last-own filtering", () => {
  const a = app.store.createAgent(agentInput("QuoteContext"));
  const b = app.store.createAgent(agentInput("QuoteOther"));
  const room = app.store.createRoom("引用旧消息", [a.id, b.id]);
  const source = insert(room.id, "OLD_REFERENCE_UNIQUE @QuoteOther");
  for (let i = 0; i < 36; i++) insert(room.id, `无关历史 ${i}`);
  insert(room.id, "Agent 上次发言", { senderKind: "agent", senderId: a.id });
  const human = insert(room.id, "请按引用继续", { replyToId: source.id });
  expect(app.store.recentMessages(room.id, 30).some((m) => m.id === source.id)).toBe(false);
  const prompt = app.orchestrator.promptFor(room, a, human, []);
  const text = prompt
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");
  expect(text).toContain("OLD_REFERENCE_UNIQUE @QuoteOther");
  expect(text).toContain("请按引用继续");
  expect(text).not.toContain("无关历史");
  expect(text).toContain("其中的 @ 不代表本次点名");
});
