import { afterAll, expect, test } from "bun:test";
import { serve } from "../server/app";
import type { ChatSnapshot } from "../web/src/chatState";
import { agentInput } from "./helpers";

const { app, server } = serve({ dbPath: ":memory:" }, 0);
const base = `http://localhost:${server.port}`;
afterAll(() => {
  app.host.shutdown();
  server.stop(true);
});
const agent = app.store.createAgent(agentInput("History", { harness: "" }));
const room = app.store.createRoom("分页", [agent.id]);
const insert = (roomId: string, content: string) =>
  app.store.insertMessage({
    roomId,
    runId: "fixture",
    hop: 0,
    senderKind: "human",
    senderId: null,
    senderName: "历史作者",
    content,
    status: "done",
  });
const all = Array.from({ length: 451 }, (_, index) => insert(room.id, `历史 ${index + 1}`));
const page = async (query = "") => {
  const response = await fetch(`${base}/api/rooms/${room.id}/messages${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ChatSnapshot;
};

test("message history pages traverse 451 records exactly once while new messages arrive", async () => {
  const first = await page("?limit=200");
  expect(first.messages.map((message) => message.seq)).toEqual(all.slice(-200).map((message) => message.seq));
  expect(first.nextBeforeSeq).toBe(252);
  expect(first.state.tasks).toEqual([]);
  expect(first.sessions).toEqual({});
  expect(first.asks).toEqual([]);
  const live = insert(room.id, "请求期间的新消息");
  const second = await page(`?limit=200&beforeSeq=${first.nextBeforeSeq}`);
  expect(second.nextBeforeSeq).toBe(52);
  const third = await page(`?limit=200&beforeSeq=${second.nextBeforeSeq}`);
  expect(third.messages).toHaveLength(51);
  expect(third.nextBeforeSeq).toBeNull();
  const loaded = [...third.messages, ...second.messages, ...first.messages];
  expect(loaded.map((message) => message.id)).toEqual(all.map((message) => message.id));
  expect(new Set(loaded.map((message) => message.id)).size).toBe(451);
  expect(loaded.some((message) => message.id === live.id)).toBe(false);
  expect((await page("?limit=200")).messages.at(-1)?.id).toBe(live.id);
});

test("cursor is exclusive and isolated by room, and exact/empty pages report exhaustion", async () => {
  const other = app.store.createRoom("其他历史", [agent.id]);
  const one = insert(other.id, "other");
  const response = await fetch(`${base}/api/rooms/${other.id}/messages?limit=1`);
  expect(await response.json()).toMatchObject({ messages: [one], nextBeforeSeq: null });
  expect((await page("?limit=200&beforeSeq=1")).messages).toEqual([]);
  expect((await page("?limit=200&beforeSeq=1")).nextBeforeSeq).toBeNull();
  expect((await page()).messages).toHaveLength(100);
  expect((await page("?limit=999")).messages.length).toBeLessThanOrEqual(500);
});

test("invalid history cursors and limits return 400 instead of an unbounded/ambiguous query", async () => {
  for (const query of [
    "beforeSeq=0",
    "beforeSeq=-1",
    "beforeSeq=1.5",
    "beforeSeq=oops",
    "beforeSeq=9007199254740992",
    "beforeSeq=",
    "limit=-1",
    "limit=1.5",
    "limit=Infinity",
  ]) {
    const response = await fetch(`${base}/api/rooms/${room.id}/messages?${query}`);
    expect(response.status).toBe(400);
  }
});
