import { afterAll, beforeAll, expect, test } from "bun:test";
import { serve } from "../server/app";
import type { RoomEvent } from "../server/orchestrator";
import type { Agent, Message, Room } from "../server/store";
import { elicitationFields, validateElicitation } from "../shared/elicitation";
import { agentInput, until } from "./helpers";

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

function fixture(name: string): { agent: Agent; room: Room } {
  const agent = app.store.createAgent(agentInput(name));
  const room = app.store.createRoom(name, [agent.id], { mainAgentId: agent.id });
  return { agent, room };
}

type WsEvent = RoomEvent | { type: "subscribed"; roomId?: string };
const events: WsEvent[] = [];
let ws: WebSocket;
const subscribed = new Set<string>();
async function watch(roomId: string) {
  if (subscribed.has(roomId)) return;
  subscribed.add(roomId);
  ws.send(JSON.stringify({ type: "subscribe", roomId }));
  await until(() => events.some((e) => e.type === "subscribed" && e.roomId === roomId));
}

/** The latest agent reply containing `text`, if it is already committed. */
function reply(roomId: string, text: string): Message | undefined {
  return app.store
    .recentMessages(roomId, 100)
    .find((m) => m.senderKind === "agent" && m.status === "done" && m.content.includes(text));
}

beforeAll(async () => {
  ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  ws.addEventListener("message", (e) => events.push(JSON.parse(String(e.data)) as WsEvent));
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
});

test("a form question is pushed and snapshotted, rejects bad input, and its answer reaches the agent", async () => {
  const { room } = fixture("AskForm");
  await watch(room.id);
  app.orchestrator.postHumanMessage(room.id, "Andy", "/ask");
  const ask = await until(() => app.host.pendingElicitations(room.id)[0]);
  expect(ask.fields.map((field) => field.kind)).toEqual([
    "string",
    "string",
    "string",
    "integer",
    "number",
    "boolean",
    "multi",
    "string",
  ]);
  // Pushed live and present in a fresh snapshot, so a refresh reopens the card.
  await until(() => events.find((e) => e.type === "elicitation" && e.ask?.id === ask.id));
  const snapshot = await api<{ elicitations: { id: string }[] }>("GET", `/api/rooms/${room.id}/messages`);
  expect(snapshot.data.elicitations.map((e) => e.id)).toContain(ask.id);

  // Required fields and bounds are validated again on the server; the card stays open.
  const invalid = await api<{ issues: Record<string, { code: string }> }>("POST", `/api/elicitations/${ask.id}`, {
    action: "accept",
    content: { target: "canary", batches: 9 },
  });
  expect(invalid.status).toBe(400);
  expect(invalid.data.issues.note?.code).toBe("required");
  expect(invalid.data.issues.batches?.code).toBe("maximum");
  expect(app.host.pendingElicitations(room.id).map((e) => e.id)).toEqual([ask.id]);

  const wrongType = await api<{ issues: Record<string, { code: string }> }>("POST", `/api/elicitations/${ask.id}`, {
    action: "accept",
    content: { target: "canary", note: "确认发布", batches: ["3"] },
  });
  expect(wrongType.status).toBe(400);
  expect(wrongType.data.issues.batches?.code).toBe("invalid");
  expect(app.host.pendingElicitations(room.id).map((e) => e.id)).toEqual([ask.id]);

  const accepted = await api("POST", `/api/elicitations/${ask.id}`, {
    action: "accept",
    content: { target: "canary", note: "确认发布", batches: 3, ratio: 0.5, confirm: false, tags: ["移动端"] },
  });
  expect(accepted.status).toBe(200);
  expect(app.host.pendingElicitations(room.id)).toEqual([]);
  // A duplicate submit cannot answer the same request twice.
  expect((await api("POST", `/api/elicitations/${ask.id}`, { action: "cancel" })).status).toBe(404);
  await until(() => events.find((e) => e.type === "elicitation" && e.resolvedId === ask.id));

  await app.orchestrator.idle(room.id);
  const answer = await until(() => reply(room.id, "提问结果："));
  expect(answer.content).toContain("提问结果：accept");
  expect(answer.content).toContain('"target":"canary"');
  expect(answer.content).toContain('"confirm":false');
});

test("a user closes the question and the agent receives cancel", async () => {
  const { room } = fixture("AskCancel");
  app.orchestrator.postHumanMessage(room.id, "Andy", "/ask");
  const ask = await until(() => app.host.pendingElicitations(room.id)[0]);
  expect((await api("POST", `/api/elicitations/${ask.id}`, { action: "cancel" })).status).toBe(200);
  expect(app.host.pendingElicitations(room.id)).toEqual([]);
  await app.orchestrator.idle(room.id);
  expect((await until(() => reply(room.id, "提问结果："))).content).toContain("提问结果：cancel");
});

test("an unsupported field type cannot be accepted but can be cancelled", async () => {
  const { room } = fixture("AskUnknown");
  app.orchestrator.postHumanMessage(room.id, "Andy", "/ask_unknown");
  const ask = await until(() => app.host.pendingElicitations(room.id)[0]);
  expect(ask.fields[0]?.kind).toBe("unsupported");
  const blocked = await api<{ issues: Record<string, { code: string }> }>("POST", `/api/elicitations/${ask.id}`, {
    action: "accept",
    content: {},
  });
  expect(blocked.status).toBe(400);
  expect(blocked.data.issues.future?.code).toBe("unsupported");
  expect(app.host.pendingElicitations(room.id).map((e) => e.id)).toEqual([ask.id]);
  expect((await api("POST", `/api/elicitations/${ask.id}`, { action: "cancel" })).status).toBe(200);
  await app.orchestrator.idle(room.id);
  expect((await until(() => reply(room.id, "提问结果："))).content).toContain("提问结果：cancel");
});

test("cancelling the task resolves the pending question instead of leaving the agent blocked", async () => {
  const { room } = fixture("AskTaskCancel");
  app.orchestrator.postHumanMessage(room.id, "Andy", "/ask");
  await until(() => app.host.pendingElicitations(room.id)[0]);
  expect(app.orchestrator.cancel(room.id)).toBe(true);
  expect(app.host.pendingElicitations(room.id)).toEqual([]);
  await app.orchestrator.idle(room.id);
});

test("releasing a room resolves pending questions", async () => {
  const { agent, room } = fixture("AskRelease");
  app.orchestrator.postHumanMessage(room.id, "Andy", "/ask");
  await until(() => app.host.pendingElicitations(room.id)[0]);
  app.host.releaseRoom(room.id, agent.id);
  expect(app.host.pendingElicitations(room.id)).toEqual([]);
  await app.orchestrator.idle(room.id);
});

test("form dates reject impossible calendar days and date-times require a time and offset", () => {
  const fields = elicitationFields({
    type: "object",
    properties: { day: { type: "string", format: "date" }, at: { type: "string", format: "date-time" } },
  });
  expect(validateElicitation(fields, { day: "2024-02-29", at: "2026-10-17T10:00:00+08:00" }).issues).toEqual({});
  expect(validateElicitation(fields, { at: "2026-10-17T02:00:00Z" }).issues).toEqual({});
  for (const day of ["2026-02-30", "2026-02-29", "2026-13-01"])
    expect(validateElicitation(fields, { day }).issues.day?.code).toBe("format");
  for (const at of ["2026-10-17", "2026-10-17T10:00", "2026-10-17T24:00:00Z", "2026-02-30T10:00:00Z"])
    expect(validateElicitation(fields, { at }).issues.at?.code).toBe("format");
});

test("numeric form fields reject arrays and booleans instead of coercing them to numbers", () => {
  const fields = elicitationFields({ type: "object", properties: { count: { type: "integer", minimum: 1 } } });
  for (const count of [[], ["3"], true])
    expect(validateElicitation(fields, { count }).issues.count?.code).toBe("invalid");
  expect(validateElicitation(fields, { count: "3" }).content).toEqual({ count: 3 });
});

test("string length counts Unicode characters and patterns may match a substring", () => {
  const fields = elicitationFields({
    type: "object",
    properties: {
      emoji: { type: "string", minLength: 1, maxLength: 1 },
      note: { type: "string", pattern: "确认" },
    },
  });
  expect(validateElicitation(fields, { emoji: "🚀", note: "确认发布" }).issues).toEqual({});
  expect(validateElicitation(fields, { emoji: "🚀🚀" }).issues.emoji?.code).toBe("max_length");
  expect(validateElicitation(fields, { note: "发布" }).issues.note?.code).toBe("pattern");
});
