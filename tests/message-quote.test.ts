import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, MIGRATIONS, Store, ValidationError } from "../server/store";
import { canQuoteMessage, MESSAGE_QUOTE_LIMIT, messageQuote } from "../shared/messageQuote";
import { emptyTimeline, type Timeline, timelineText } from "../shared/timeline";
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

const phasedTimeline = (): Timeline => ({
  ...emptyTimeline(),
  parts: [
    { kind: "text", text: "第一阶段不属于选段\n" },
    { kind: "tool", toolCallId: "check" },
    { kind: "text", text: "第二阶段\n" },
    { kind: "image", mimeType: "image/png", data: "selected-image" },
    { kind: "text", text: "只引用这里" },
    { kind: "thought", text: "不要引用内部思考" },
    { kind: "image", mimeType: "image/png", data: "image-only-phase" },
    { kind: "text", text: " \n" },
  ],
});

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
  // Humans may quote in a DM too: retrying an interrupted request references the original there.

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
    // `other` is a DM; a human quote there is the retry path and must stay valid.
    expect(insert({ roomId: other.id, replyToId: foreign.id }).quote?.text).toBe(foreign.content);
    expect(() => insert({ senderKind: "agent", replyToId: valid.id })).toThrow();
    expect(insert({ replyToId: valid.id }).seq).toBe(valid.seq + 1);
  } finally {
    store.db.close();
  }
});

test("Agent phase quotes use only the selected body group, including image-only fallback", () => {
  const { store, a, insert } = fixture();
  try {
    const timeline = phasedTimeline();
    const source = store.updateReply(insert({ senderKind: "agent", senderId: a.id }).id, {
      content: timelineText(timeline),
      status: "done",
      timeline,
    });
    expect(messageQuote(source, 2)).toEqual({
      messageId: source.id,
      senderName: source.senderName,
      senderKind: "agent",
      text: "第二阶段 只引用这里",
      partIndex: 2,
    });
    expect(messageQuote(source, 0)?.text).toBe("第一阶段不属于选段");
    expect(messageQuote(source, 6)).toMatchObject({ text: "（图片）", partIndex: 6 });
    expect(messageQuote(source)?.text).toBe("第一阶段不属于选段 第二阶段 只引用这里");
    expect(messageQuote(source)).not.toHaveProperty("partIndex");
    const long = {
      ...source,
      timeline: { ...emptyTimeline(), parts: [{ kind: "text" as const, text: "😀".repeat(500) }] },
    };
    expect(Array.from(messageQuote(long, 0)?.text ?? "")).toHaveLength(MESSAGE_QUOTE_LIMIT);
    expect(messageQuote(long, 0)?.text.endsWith("…")).toBe(true);
    for (const index of [-1, 1, 3, 4, 5, 7, 8, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(messageQuote(source, index)).toBeNull();
    expect(messageQuote(insert(), 0)).toBeNull();
    expect(messageQuote({ ...source, timeline: null }, 0)).toBeNull();
    for (const status of ["streaming", "error", "cancelled", "interrupted"] as const)
      expect(messageQuote({ ...source, status }, 2)).toBeNull();
  } finally {
    store.db.close();
  }
});

test("invalid phase references fail atomically instead of falling back to a whole-message quote", () => {
  const { store, a, room, insert } = fixture();
  try {
    const timeline = phasedTimeline();
    const source = store.updateReply(insert({ senderKind: "agent", senderId: a.id }).id, {
      content: timelineText(timeline),
      status: "done",
      timeline,
    });
    const other = store.createRoom("foreign", [a.id]);
    const foreign = insert({ roomId: other.id, senderKind: "agent", senderId: a.id });
    store.updateReply(foreign.id, { content: timelineText(timeline), status: "done", timeline });
    const human = insert();
    const unfinished = insert({ senderKind: "agent", senderId: a.id, status: "streaming" });
    store.updateReply(unfinished.id, { content: timelineText(timeline), status: "streaming", timeline });
    const invalid = [
      { replyToPartIndex: 2 },
      { replyToId: null, replyToPartIndex: 2 },
      ...[-1, 1, 3, 4, 7, 99, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((replyToPartIndex) => ({
        replyToId: source.id,
        replyToPartIndex,
      })),
      ...[foreign.id, human.id, unfinished.id, "missing"].map((replyToId) => ({ replyToId, replyToPartIndex: 2 })),
      { replyToId: source.id, replyToPartIndex: 2, senderKind: "agent" as const },
    ];
    const before = store.recentMessages(room.id, 100);
    for (const input of invalid) expect(() => insert(input)).toThrow(ValidationError);
    expect(store.recentMessages(room.id, 100)).toEqual(before);
    const quoted = insert({ replyToId: source.id, replyToPartIndex: 2 });
    expect(quoted.quote).toMatchObject({ text: "第二阶段 只引用这里", partIndex: 2 });
    expect(quoted.seq).toBe((before.at(-1)?.seq ?? 0) + 1);
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
    const timeline = phasedTimeline();
    const phaseSource = store.updateReply(insert({ senderKind: "agent" }).id, {
      content: timelineText(timeline),
      status: "done",
      timeline,
    });
    const phaseReply = insert({ content: "只问第二段", replyToId: phaseSource.id, replyToPartIndex: 2 });
    expect(phaseReply.quote).toMatchObject({ text: "第二阶段 只引用这里", partIndex: 2 });
    store.updateReply(phaseSource.id, { content: "来源后来改变", status: "done", timeline: emptyTimeline() });
    store.db.close();
    const reopened = new Store(path);
    expect(reopened.getMessage(reply.id)?.quote).toEqual(reply.quote);
    expect(reopened.getMessage(phaseReply.id)?.quote).toEqual(phaseReply.quote);
    expect(reopened.db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    reopened.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
