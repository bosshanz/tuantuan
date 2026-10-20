import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttentionService } from "../server/attention";
import type { ElicitationAsk, PermissionAsk } from "../server/host";
import { type Message, Store } from "../server/store";
import { agentInput } from "./helpers";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});

function fixture(path = ":memory:") {
  const store = new Store(path);
  stores.push(store);
  const agent = store.createAgent(agentInput("Worker"));
  const project = store.createProject("Project", tmpdir());
  const room = store.createRoom("Conversation", [agent.id], { projectId: project.id });
  const asks: PermissionAsk[] = [];
  const questions: ElicitationAsk[] = [];
  const service = new AttentionService(store, {
    pendingAsks: (id) => asks.filter((ask) => ask.roomId === id),
    pendingElicitations: (id) => questions.filter((ask) => ask.roomId === id),
  });
  const message = (status: Message["status"], error: string | null = null, roomId = room.id) => {
    const inserted = store.insertMessage({
      roomId,
      runId: crypto.randomUUID(),
      hop: 1,
      senderKind: "agent",
      senderId: agent.id,
      senderName: agent.name,
      content: "",
      status,
    });
    store.db.query("UPDATE messages SET error = ? WHERE id = ?").run(error, inserted.id);
    return inserted;
  };
  return { store, agent, project, room, asks, questions, service, message };
}

test("attention aggregates different conversations and exposes only minimal Host request summaries", () => {
  const f = fixture();
  const other = f.store.createRoom("Other", [f.agent.id], { projectId: f.project.id });
  f.asks.push({
    id: "permission",
    roomId: f.room.id,
    agentId: f.agent.id,
    toolCall: { toolCallId: "tool", title: "secret-key", rawInput: { token: "secret-key" } },
    options: [{ optionId: "allow", name: "secret-key", kind: "allow_once" }],
  });
  f.questions.push({
    id: "question",
    roomId: other.id,
    agentId: f.agent.id,
    message: "secret-question",
    fields: [{ kind: "string", name: "token", title: "Secret", required: true, default: "secret-key" }],
  });
  const failed = f.message("error", "failed", other.id);
  const snapshot = f.service.list();
  expect(snapshot.totalCount).toBe(3);
  expect(snapshot.active).toHaveLength(2);
  expect(snapshot.active.find((item) => item.kind === "permission")).toMatchObject({
    kind: "permission",
    roomName: "Conversation",
    projectName: "Project",
    agentName: "Worker",
    askId: "permission",
  });
  expect(snapshot.active.find((item) => item.kind === "question")).toMatchObject({
    kind: "question",
    roomId: other.id,
    askId: "question",
  });
  expect(snapshot.failures[0]?.messageId).toBe(failed.id);
  expect(JSON.stringify(snapshot)).not.toContain("secret");
  expect(JSON.stringify(snapshot)).not.toContain("fields");
  expect(JSON.stringify(snapshot)).not.toContain("rawInput");
  f.asks.length = 0;
  f.questions.length = 0;
  expect(f.service.list().totalCount).toBe(1);
  expect(f.service.list().active).toEqual([]);
});

test("only error and interrupted Agent messages are failures, with notification-compatible auth classification", () => {
  const f = fixture();
  const failure = f.message("error", "command failed");
  const auth = f.message("error", "Missing API key: PROVIDER_API_KEY");
  const login = f.message("error", "401 Unauthorized, log in");
  const interrupted = f.message("interrupted", "service restarted");
  f.message("done");
  f.message("streaming");
  f.message("cancelled");
  // A later successful reply from the same Agent does not resolve older failures.
  f.message("done");
  const human = f.message("error");
  f.store.db.query("UPDATE messages SET sender_kind = 'human' WHERE id = ?").run(human.id);
  const system = f.message("error");
  f.store.db.query("UPDATE messages SET sender_kind = 'system' WHERE id = ?").run(system.id);
  const snapshot = f.service.list();
  expect(snapshot.totalCount).toBe(4);
  const kinds = new Map(snapshot.failures.map((item) => [item.messageId, item.kind]));
  expect(kinds.get(failure.id)).toBe("error");
  expect(kinds.get(auth.id)).toBe("auth");
  expect(kinds.get(login.id)).toBe("auth");
  expect(kinds.get(interrupted.id)).toBe("interrupted");
});

test("dismiss is explicit, idempotent and persistent while preserving the original message", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-attention-"));
  try {
    const f = fixture(join(dir, "test.db"));
    const failed = f.message("error", "failure");
    const interrupted = f.message("interrupted", "interrupted");
    expect(f.service.list().totalCount).toBe(2);
    expect(f.service.list().totalCount).toBe(2); // Looking at the item does not dismiss it.
    expect(f.service.dismiss(failed.id)).toEqual({ ok: true });
    expect(f.service.dismiss(failed.id)).toEqual({ ok: true });
    expect(f.service.list().failures.map((item) => item.messageId)).toEqual([interrupted.id]);
    expect(f.store.getMessage(failed.id)).toMatchObject({ status: "error", error: "failure" });
    f.store.db.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = new Store(join(dir, "test.db"));
    stores.push(reopened);
    const service = new AttentionService(reopened, { pendingAsks: () => [], pendingElicitations: () => [] });
    expect(service.list().failures.map((item) => item.messageId)).toEqual([interrupted.id]);
    service.dismiss(interrupted.id);
    expect(service.list().totalCount).toBe(0);
  } finally {
    for (const store of stores.splice(0)) store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dismiss rejects missing, successful, cancelled, streaming and non-Agent messages", () => {
  const f = fixture();
  expect(() => f.service.dismiss("missing")).toThrow("待办消息不存在");
  for (const status of ["done", "cancelled", "streaming"] as const)
    expect(() => f.service.dismiss(f.message(status).id)).toThrow("只有失败或中断");
  const human = f.message("error");
  f.store.db.query("UPDATE messages SET sender_kind = 'human' WHERE id = ?").run(human.id);
  expect(() => f.service.dismiss(human.id)).toThrow("只有失败或中断");
  expect(f.store.db.query("SELECT * FROM message_attention_dismissals").all()).toEqual([]);
});

test("deleting a message or room cascades its dismissal and does not leave attention entries", () => {
  const f = fixture();
  const one = f.message("error");
  const two = f.message("interrupted");
  f.service.dismiss(one.id);
  f.service.dismiss(two.id);
  f.store.db.query("DELETE FROM messages WHERE id = ?").run(one.id);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM message_attention_dismissals").get()).toEqual({ n: 1 });
  f.store.deleteRoom(f.room.id);
  expect(f.store.db.query("SELECT * FROM message_attention_dismissals").all()).toEqual([]);
  expect(f.service.list().totalCount).toBe(0);
});

test("failure pagination is bounded, stable for equal timestamps and keeps the full total and live requests", () => {
  const f = fixture();
  for (let index = 0; index < 65; index++) {
    const message = f.message("error", `failure ${index}`);
    f.store.db.query("UPDATE messages SET created_at = 1000 WHERE id = ?").run(message.id);
  }
  f.questions.push({ id: "ask", roomId: f.room.id, agentId: f.agent.id, message: "question", fields: [] });
  const first = f.service.list();
  expect(first.failures).toHaveLength(30);
  expect(first.active).toHaveLength(1);
  expect(first.totalCount).toBe(66);
  expect(first.nextCursor).not.toBeNull();
  f.service.dismiss(first.failures[0]?.messageId ?? "");
  const second = f.service.list({ cursor: first.nextCursor });
  expect(second.failures).toHaveLength(30);
  expect(second.active).toHaveLength(1);
  expect(second.totalCount).toBe(65);
  f.questions.length = 0;
  const third = f.service.list({ cursor: second.nextCursor });
  expect(third.active).toEqual([]);
  expect(third.failures).toHaveLength(5);
  expect(third.nextCursor).toBeNull();
  const ids = [...first.failures, ...second.failures, ...third.failures].map((item) => item.messageId);
  expect(new Set(ids).size).toBe(65);
  expect(f.service.list({ limit: 50 }).failures).toHaveLength(50);
  for (const limit of [0, -1, 51, 1.5, Number.NaN]) expect(() => f.service.list({ limit })).toThrow();
  for (const cursor of ["", "invalid", Buffer.from('{"at":-1,"id":"x"}').toString("base64url")])
    expect(() => f.service.list({ cursor })).toThrow("分页位置无效");
});
