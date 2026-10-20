import { afterEach, describe, expect, test } from "bun:test";
import { handleMessageSearch } from "../server/message-search";
import { type Message, Store } from "../server/store";
import { MESSAGE_SEARCH_SNIPPET_LENGTH, type MessageSearchPage } from "../shared/messageSearch";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const project = store.createProject("搜索项目", "/tmp/message-search");
  const room = store.createRoom("产品讨论", [], { projectId: project.id });
  const other = store.createRoom("其他会话", []);
  const insert = (content: string, patch: Partial<Message> = {}) => {
    const message = store.insertMessage({
      roomId: room.id,
      runId: "search-fixture",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "小团",
      content,
      status: "done",
      ...patch,
    });
    if (patch.createdAt !== undefined)
      store.db.query("UPDATE messages SET created_at = ? WHERE id = ?").run(patch.createdAt, message.id);
    return { ...message, ...(patch.createdAt === undefined ? {} : { createdAt: patch.createdAt }) };
  };
  const request = (params: Record<string, string> = {}) =>
    handleMessageSearch(store, new URL(`http://localhost/api/messages/search?${new URLSearchParams(params)}`));
  const search = async (params: Record<string, string>) => {
    const response = request(params);
    expect(response.status).toBe(200);
    return (await response.json()) as MessageSearchPage;
  };
  return { store, room, other, insert, request, search };
}

describe("persisted message body search", () => {
  test("finds Chinese and ASCII case-insensitive substrings, with literal wildcard and SQL-looking text", async () => {
    const { insert, search } = fixture();
    const literal = insert("讨论中文接口与 ReleasePlan，完成 100%_exact\\path；' OR 1=1 --");
    insert("讨论其他计划，完成 100ABCexactpath");
    for (const query of ["中文接口", "releaseplan", "RELEASEPLAN", "%_", "\\path", "' OR 1=1 --"])
      expect((await search({ q: query })).items.map((item) => item.messageId)).toEqual([literal.id]);
  });

  test("searches beyond the initial 200 messages and isolates a selected room", async () => {
    const { room, other, insert, search } = fixture();
    const first = insert("古老针叶林", { createdAt: 1 });
    for (let index = 0; index < 250; index++) insert(`新的消息 ${index}`);
    const elsewhere = insert("古老针叶林也在别处", { roomId: other.id });
    expect(new Set((await search({ q: "针叶林" })).items.map((item) => item.messageId))).toEqual(
      new Set([first.id, elsewhere.id]),
    );
    expect((await search({ q: "针叶林", roomId: room.id })).items.map((item) => item.messageId)).toEqual([first.id]);
  });

  test("returns source metadata and a bounded first-match snippet without timeline, attachments or full body", async () => {
    const { store, room, insert, search } = fixture();
    const message = insert(`${"前".repeat(2000)}目标正文${"后".repeat(4000)}`, {
      senderKind: "agent",
      senderName: "助理",
    });
    store.db
      .query("UPDATE messages SET timeline = ? WHERE id = ?")
      .run('{"parts":[{"kind":"thought","text":"私有思考词"},{"kind":"file","data":"附件秘密词"}]}', message.id);
    const page = await search({ q: "目标正文" });
    expect(page.items).toHaveLength(1);
    const result = page.items[0];
    expect(result).toMatchObject({
      messageId: message.id,
      roomId: room.id,
      roomName: "产品讨论",
      projectName: "搜索项目",
      senderName: "助理",
      senderKind: "agent",
      seq: message.seq,
      createdAt: message.createdAt,
    });
    expect(result?.snippet).toContain("目标正文");
    expect(result?.snippet.startsWith("…")).toBe(true);
    expect(result?.snippet.endsWith("…")).toBe(true);
    expect(Array.from(result?.snippet ?? "").length).toBeLessThanOrEqual(MESSAGE_SEARCH_SNIPPET_LENGTH + 2);
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("timeline");
    expect(result).not.toHaveProperty("quote");
    expect((await search({ q: "私有思考词" })).items).toEqual([]);
    expect((await search({ q: "附件秘密词" })).items).toEqual([]);
    // Corrupt/huge historical timelines do not need parsing to search the body column.
    store.db.query("UPDATE messages SET timeline = ? WHERE id = ?").run("not-json", message.id);
    expect((await search({ q: "目标正文" })).items).toHaveLength(1);
  });

  test("snippets preserve emoji and contain the entire longest accepted literal match", async () => {
    const { insert, search } = fixture();
    const query = "中".repeat(200);
    insert(`${"🌲".repeat(500)}${query}${"🌲".repeat(500)}`);
    const result = (await search({ q: query })).items[0];
    expect(result?.snippet).toContain(query);
    expect(result?.snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  test("excludes system and streaming messages, with ended partial replies still searchable", async () => {
    const { insert, search } = fixture();
    insert("搜索标记", { senderKind: "system" });
    insert("搜索标记", { senderKind: "agent", status: "streaming" });
    const accepted = ["done", "error", "cancelled", "interrupted"].map((status) =>
      insert("搜索标记", { senderKind: "agent", status: status as Message["status"] }),
    );
    expect(new Set((await search({ q: "搜索标记" })).items.map((item) => item.messageId))).toEqual(
      new Set(accepted.map((message) => message.id)),
    );
  });

  test("paginates cross-room duplicate sequences and timestamps exactly once while newer rows arrive", async () => {
    const { room, other, insert, search } = fixture();
    const messages = Array.from({ length: 451 }, (_, index) =>
      insert("共同关键词", {
        id: `search-${index.toString().padStart(4, "0")}`,
        roomId: index % 2 ? room.id : other.id,
        createdAt: Math.floor(index / 100) + 1,
      }),
    );
    const first = await search({ q: "共同关键词", limit: "30" });
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    const live = insert("共同关键词，新来的", { createdAt: 100 });
    const all = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await search({ q: "共同关键词", limit: "30", cursor });
      all.push(...page.items);
      cursor = page.nextCursor;
    }
    const expected = messages.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    expect(all.map((item) => item.messageId)).toEqual(expected.map((message) => message.id));
    expect(new Set(all.map((item) => item.messageId)).size).toBe(451);
    expect(all.some((item) => item.messageId === live.id)).toBe(false);
  });

  test("cursor remains usable after its message is deleted and ignores deleted rooms", async () => {
    const { store, other, insert, search, request } = fixture();
    const old = insert("删除关键词", { createdAt: 1 });
    const middle = insert("删除关键词", { createdAt: 2 });
    insert("删除关键词", { roomId: other.id, createdAt: 3 });
    const page = await search({ q: "删除关键词", limit: "2" });
    expect(page.items.at(-1)?.messageId).toBe(middle.id);
    store.db.query("DELETE FROM messages WHERE id = ?").run(middle.id);
    store.deleteRoom(other.id);
    expect(
      (await search({ q: "删除关键词", cursor: page.nextCursor as string })).items.map((item) => item.messageId),
    ).toEqual([old.id]);
    expect(request({ q: "删除关键词", roomId: other.id }).status).toBe(404);
  });

  test("empty queries return an empty page; missing room filters remain explicit 404s", async () => {
    const { insert, search, request } = fixture();
    insert("any message");
    for (const q of ["", "   ", "\n\t"]) expect(await search({ q })).toEqual({ items: [], nextCursor: null });
    expect(request({ q: "", roomId: "missing" }).status).toBe(404);
    expect(request({ q: "message", roomId: "" }).status).toBe(400);
    expect((await search({ q: " message " })).items).toHaveLength(1);
  });

  test("validates query, limit, cursor shape and the cursor's original query and scope", async () => {
    const { room, other, insert, search, request } = fixture();
    insert("keyword");
    insert("keyword");
    const cursor = (await search({ q: "keyword", roomId: room.id, limit: "1" })).nextCursor as string;
    const invalidRequests: Record<string, string>[] = [
      { q: "x".repeat(201) },
      { q: "a\0b" },
      { q: "keyword", limit: "0" },
      { q: "keyword", limit: "-1" },
      { q: "keyword", limit: "101" },
      { q: "keyword", limit: "1.1" },
      { q: "keyword", limit: "Infinity" },
      { q: "keyword", limit: "" },
      { q: "keyword", limit: "01" },
      { q: "keyword", limit: "9007199254740992" },
      { q: "keyword", cursor: "" },
      { q: "keyword", cursor: "not!base64" },
      { q: "keyword", cursor: "a".repeat(2001) },
      { q: "keyword", cursor },
      { q: "changed", roomId: room.id, cursor },
      { q: "keyword", roomId: other.id, cursor },
    ];
    for (const params of invalidRequests) expect(request(params).status).toBe(400);
    const valid = JSON.parse(Buffer.from(cursor, "base64url").toString());
    for (const patch of [
      { version: 2 },
      { createdAt: -1 },
      { createdAt: 0.5 },
      { messageId: "" },
      { messageId: 123 },
    ]) {
      const raw = Buffer.from(JSON.stringify({ ...valid, ...patch })).toString("base64url");
      expect(request({ q: "keyword", roomId: room.id, cursor: raw }).status).toBe(400);
    }
    for (const value of [null, [], 4, "abc", { version: 1 }])
      expect(request({ q: "keyword", cursor: Buffer.from(JSON.stringify(value)).toString("base64url") }).status).toBe(
        400,
      );
  });

  test("exact and exhausted pages have no next cursor; request limit never returns extra metadata rows", async () => {
    const { insert, search } = fixture();
    for (let index = 0; index < 30; index++) insert("默认条数");
    expect((await search({ q: "默认条数" })).items).toHaveLength(30);
    expect((await search({ q: "默认条数" })).nextCursor).toBeNull();
    expect(await search({ q: "missing" })).toEqual({ items: [], nextCursor: null });
    expect((await search({ q: "默认条数", limit: "1" })).items).toHaveLength(1);
  });
});
