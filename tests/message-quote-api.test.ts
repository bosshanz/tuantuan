import { afterAll, expect, test } from "bun:test";
import { serve } from "../server/app";
import type { Message } from "../server/store";
import { emptyTimeline, type Timeline, timelineText } from "../shared/timeline";
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
const phaseSource = (roomId: string, senderId: string, status: Message["status"] = "done") => {
  const timeline: Timeline = {
    ...emptyTimeline(),
    parts: [
      { kind: "text", text: "FIRST_PHASE_UNIQUE\n" },
      { kind: "tool", toolCallId: "phase-boundary" },
      { kind: "text", text: "SELECTED_PHASE_UNIQUE\n第二段结果" },
      { kind: "image", mimeType: "image/png", data: "selected" },
      { kind: "thought", text: "INTERNAL_THOUGHT" },
      { kind: "image", mimeType: "image/png", data: "image-only" },
    ],
  };
  return app.store.updateReply(insert(roomId, "", { senderKind: "agent", senderId, status }).id, {
    content: timelineText(timeline),
    status,
    timeline,
  });
};

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

test("API snapshots only the selected Agent phase, ignores forged quote data and retains the phase on refresh", async () => {
  const a = app.store.createAgent(agentInput("PhaseAlice"));
  const room = app.store.createRoom("phase references", [a.id]);
  const source = phaseSource(room.id, a.id);
  const response = await post(room.id, {
    content: "请继续第二段",
    replyToId: source.id,
    replyToPartIndex: 2,
    quote: { text: "伪造整轮正文", partIndex: 0 },
  });
  expect(response.status).toBe(201);
  const sent = (await response.json()) as Message;
  expect(sent.quote).toEqual({
    messageId: source.id,
    senderName: source.senderName,
    senderKind: "agent",
    text: "SELECTED_PHASE_UNIQUE 第二段结果",
    partIndex: 2,
  });
  await app.orchestrator.idle(room.id);
  const imageResponse = await post(room.id, { content: "引用图片段", replyToId: source.id, replyToPartIndex: 5 });
  expect(imageResponse.status).toBe(201);
  expect(((await imageResponse.json()) as Message).quote).toMatchObject({ text: "（图片）", partIndex: 5 });
  await app.orchestrator.idle(room.id);
  const loaded = (await (await fetch(`${base}/api/rooms/${room.id}/messages`)).json()) as { messages: Message[] };
  expect(loaded.messages.find((message) => message.id === sent.id)?.quote).toEqual(sent.quote);
});

test("API rejects invalid phase references without inserting messages or starting tasks", async () => {
  const a = app.store.createAgent(agentInput("PhaseValidation"));
  const room = app.store.createRoom("phase validation", [a.id]);
  const other = app.store.createRoom("foreign phases", [a.id]);
  const source = phaseSource(room.id, a.id);
  const foreign = phaseSource(other.id, a.id);
  const human = insert(room.id, "human source");
  const system = insert(room.id, "system source", { senderKind: "system" });
  const unfinished = ["streaming", "error", "cancelled", "interrupted"].map((status) =>
    phaseSource(room.id, a.id, status as Message["status"]),
  );
  const invalid = [
    { replyToPartIndex: 2 },
    { replyToId: null, replyToPartIndex: 2 },
    ...[-1, 1, 3, 4, 99, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null].map((replyToPartIndex) => ({
      replyToId: source.id,
      replyToPartIndex,
    })),
    ...[foreign.id, human.id, system.id, ...unfinished.map((message) => message.id), "missing"].map((replyToId) => ({
      replyToId,
      replyToPartIndex: 2,
    })),
  ];
  const before = app.store.recentMessages(room.id, 100);
  for (const input of invalid) {
    const response = await post(room.id, { content: "不应写入", ...input });
    expect(response.status).toBe(400);
  }
  expect(app.store.recentMessages(room.id, 100)).toEqual(before);
  expect(app.orchestrator.state(room.id).tasks).toEqual([]);
});

test("Agent reference context contains the selected phase instead of the whole reply", () => {
  const a = app.store.createAgent(agentInput("PhaseContext"));
  const b = app.store.createAgent(agentInput("PhaseOther"));
  const room = app.store.createRoom("selected context", [a.id, b.id]);
  const source = phaseSource(room.id, a.id);
  for (let i = 0; i < 36; i++) insert(room.id, `无关历史 ${i}`);
  insert(room.id, "Agent 上次发言", { senderKind: "agent", senderId: a.id });
  const human = insert(room.id, "只讨论选段", { replyToId: source.id, replyToPartIndex: 2 });
  const text = app.orchestrator
    .promptFor(room, a, human, [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  expect(text).toContain('"text":"SELECTED_PHASE_UNIQUE 第二段结果"');
  expect(text).toContain("只讨论选段");
  expect(text).not.toContain("FIRST_PHASE_UNIQUE");
  expect(text).not.toContain("INTERNAL_THOUGHT");
  expect(text).not.toContain("无关历史");
});
