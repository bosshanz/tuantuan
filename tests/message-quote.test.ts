import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, MIGRATIONS, Store } from "../server/store";
import { canQuoteMessage, MESSAGE_QUOTE_LIMIT, messageQuote } from "../shared/messageQuote";
import { emptyTimeline } from "../shared/timeline";
import { agentInput } from "./helpers";

function fixture(path = ":memory:") {
  const store = new Store(path);
  const a = store.createAgent(agentInput("A"));
  const b = store.createAgent(agentInput("B"));
  const room = store.createRoom("引用群聊", [a.id, b.id]);
  const insert = (extra: Partial<Parameters<Store["insertMessage"]>[0]> = {}) =>
    store.insertMessage({
      roomId: room.id,
      runId: "test",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "我",
      content: "原文 @B",
      status: "done",
      ...extra,
    });
  return { store, a, b, room, insert };
}

test("quote projection is bounded, Unicode-safe and contains only the referenced message", () => {
  const { store, insert } = fixture();
  try {
    const source = insert({ senderName: "名字".repeat(70), content: ` \n${"😀".repeat(500)}\n @B ` });
    const quote = messageQuote(source);
    expect(Array.from(quote?.text ?? "")).toHaveLength(MESSAGE_QUOTE_LIMIT);
    expect(quote?.text.endsWith("…")).toBe(true);
    expect(Array.from(quote?.senderName ?? "")).toHaveLength(80);
    expect(quote?.text).not.toContain("\n");
    const quoted = insert({ content: "只引用这一层", replyToId: source.id });
    expect(messageQuote(quoted)?.text).toBe("只引用这一层");
    expect(messageQuote(insert({ content: "\n  " }))?.text).toBe("（无文本内容）");
    for (const status of ["streaming", "error", "cancelled", "interrupted"] as const)
      expect(canQuoteMessage({ senderKind: "agent", status })).toBe(false);
    expect(canQuoteMessage({ senderKind: "system", status: "done" })).toBe(false);
  } finally {
    store.db.close();
  }
});

test("server validates references atomically and rejects cross-room, unfinished and system sources", () => {
  const { store, a, room, insert } = fixture();
  try {
    const other = store.createRoom("other", [a.id]);
    const foreign = insert({ roomId: other.id });
    const invalid = [
      foreign.id,
      "missing",
      ...["streaming", "error", "cancelled", "interrupted"].map(
        (status) => insert({ status: status as Message["status"], senderKind: "agent", senderId: a.id }).id,
      ),
      insert({ senderKind: "system" }).id,
    ];
    const before = store.recentMessages(room.id, 100).length;
    for (const replyToId of invalid) expect(() => insert({ replyToId })).toThrow();
    expect(store.recentMessages(room.id, 100)).toHaveLength(before);
    const valid = insert();
    expect(() => insert({ roomId: other.id, replyToId: foreign.id })).toThrow("仅用于群聊");
    expect(() => insert({ senderKind: "agent", replyToId: valid.id })).toThrow();
    expect(insert({ replyToId: valid.id }).seq).toBe(valid.seq + 1);
  } finally {
    store.db.close();
  }
});

test("migration 17 upgrades existing databases and quote snapshots survive source changes and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "tuantuan-quote-"));
  const path = join(dir, "store.db");
  try {
    const db = new Database(path);
    for (const migration of MIGRATIONS.slice(0, 16)) db.exec(migration);
    db.exec("PRAGMA user_version = 16");
    db.close();
    const { store, insert } = fixture(path);
    const source = insert();
    expect(source.quote).toBeNull();
    const reply = insert({ content: "新内容", replyToId: source.id });
    expect(reply.quote).toMatchObject({ messageId: source.id, text: "原文 @B", senderName: "我" });
    store.updateReply(source.id, { content: "后来修改", status: "done", timeline: emptyTimeline() });
    store.db.close();
    const reopened = new Store(path);
    expect(reopened.getMessage(reply.id)?.quote).toEqual(reply.quote);
    expect(reopened.db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    reopened.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
