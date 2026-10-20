import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  handleConversationFileContent,
  handleConversationFilePreview,
  handleConversationFiles,
} from "../server/conversation-files";
import { type Message, Store } from "../server/store";
import {
  CONVERSATION_FILE_DOWNLOAD_MAX_BYTES,
  type ConversationFile,
  type ConversationFilesPage,
} from "../shared/conversationFiles";
import { FILE_PREVIEW_MAX_BYTES, getFilePreviewType } from "../shared/filePreview";
import { emptyTimeline, type Timeline } from "../shared/timeline";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tt-conversation-files-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const database = join(root, "chat.sqlite");
  let store = new Store(database);
  cleanup.push(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = store.createProject("files", cwd);
  const room = store.createRoom("original", [], { projectId: project.id });
  const other = store.createRoom("other", [], { projectId: project.id });
  const insert = (parts: Timeline["parts"] = [], patch: Partial<Message> = {}, tools: Timeline["tools"] = {}) => {
    const message = store.insertMessage({
      roomId: room.id,
      runId: "files-fixture",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "Owner",
      content: "",
      status: "done",
      ...patch,
    });
    return store.updateReply(message.id, {
      content: patch.content ?? "",
      status: patch.status ?? "done",
      timeline: { ...emptyTimeline(), parts, tools },
    });
  };
  const request = (params: Record<string, string> = {}, roomId = room.id) =>
    handleConversationFiles(
      store,
      roomId,
      new URL(`http://localhost/api/rooms/${roomId}/files?${new URLSearchParams(params)}`),
    );
  const page = async (params: Record<string, string> = {}, roomId = room.id) => {
    const response = request(params, roomId);
    expect(response.status).toBe(200);
    return (await response.json()) as ConversationFilesPage;
  };
  const all = async (limit = 30) => {
    const items: ConversationFile[] = [];
    let cursor: string | null = null;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = await page({ limit: String(limit), ...(cursor ? { cursor } : {}) });
      items.push(...current.items);
      cursor = current.nextCursor;
      if (!cursor) return items;
    }
    throw new Error("cursor did not terminate");
  };
  return {
    root,
    cwd,
    room,
    other,
    insert,
    request,
    page,
    all,
    download: (item: ConversationFile, roomId = room.id) => handleConversationFileContent(store, roomId, item.id),
    preview: (item: ConversationFile, roomId = room.id) => handleConversationFilePreview(store, roomId, item.id),
    get store() {
      return store;
    },
    reopen() {
      store.db.close();
      store = new Store(database);
    },
  };
}

const attachment = (name: string, bytes: Uint8Array | string, mimeType = "application/octet-stream") => ({
  kind: "file" as const,
  name,
  mimeType,
  data: Buffer.from(bytes).toString("base64"),
});

describe("conversation file preview", () => {
  test("classifies Markdown, HTML, common source, MIME hints, text and configuration files", () => {
    const cases: [string, string, ReturnType<typeof getFilePreviewType>][] = [
      ["REPORT.MD", "application/octet-stream", { kind: "markdown" }],
      ["notes.markdown", "", { kind: "markdown" }],
      ["page.htm", "", { kind: "html" }],
      ["page.html", "", { kind: "html" }],
      ["main.tsx", "", { kind: "code", language: "typescript" }],
      ["script.py", "", { kind: "code", language: "python" }],
      ["main.rs", "", { kind: "code", language: "rust" }],
      ["package.json", "", { kind: "code", language: "json" }],
      ["settings.yaml", "", { kind: "code", language: "yaml" }],
      ["Dockerfile", "", { kind: "code", language: "dockerfile" }],
      ["Dockerfile.dev", "", { kind: "code", language: "dockerfile" }],
      ["Makefile", "", { kind: "code", language: "makefile" }],
      [".gitignore", "application/octet-stream", { kind: "text" }],
      [".env.local", "application/octet-stream", { kind: "code", language: "ini" }],
      [".editorconfig", "", { kind: "code", language: "ini" }],
      [".bashrc", "", { kind: "code", language: "bash" }],
      ["server.log", "", { kind: "text" }],
      ["unknown", "text/markdown; charset=utf-8", { kind: "markdown" }],
      ["unknown", "text/html", { kind: "html" }],
      ["unknown", "application/ld+json", { kind: "code", language: "json" }],
      ["unknown", "text/plain", { kind: "text" }],
      ["archive.zip", "application/zip", null],
      ["photo.png", "image/png", null],
      ["report.pdf", "application/pdf", null],
      ["unknown.constructor", "application/octet-stream", null],
    ];
    for (const [name, mimeType, expected] of cases) expect(getFilePreviewType(name, mimeType)).toEqual(expected);
  });

  test("returns persisted attachment previews as JSON with strict UTF-8 and BOM support", async () => {
    const f = fixture();
    const html = "<!doctype html><script>alert('inert JSON')</script><h1>报告</h1>";
    const markdown = "# 标题\n\n正文 🌲\t\r\n";
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(markdown)]);
    f.insert([
      attachment("note.md", bom, "text/markdown"),
      attachment("page.html", html, "text/html"),
      attachment("main.ts", "const value = 42;", "application/octet-stream"),
      attachment("empty.txt", "", "text/plain"),
    ]);
    f.reopen();
    const files = await f.all();
    const markdownFile = files.find((item) => item.name === "note.md") as ConversationFile;
    expect(await f.preview(markdownFile).json()).toEqual({ kind: "markdown", text: markdown, size: bom.length });
    const htmlResponse = f.preview(files.find((item) => item.name === "page.html") as ConversationFile);
    expect(htmlResponse.headers.get("content-type")).toStartWith("application/json");
    expect(htmlResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htmlResponse.headers.get("cache-control")).toBe("no-store");
    expect(await htmlResponse.json()).toEqual({ kind: "html", text: html, size: Buffer.byteLength(html) });
    expect(await f.preview(files.find((item) => item.name === "main.ts") as ConversationFile).json()).toEqual({
      kind: "code",
      language: "typescript",
      text: "const value = 42;",
      size: 17,
    });
    expect(await f.preview(files.find((item) => item.name === "empty.txt") as ConversationFile).json()).toEqual({
      kind: "text",
      text: "",
      size: 0,
    });
    expect(new Uint8Array(await f.download(markdownFile).arrayBuffer())).toEqual(new Uint8Array(bom));
  });

  test("rejects binary controls, NUL, invalid UTF-8 and unsupported types without weakening downloads", async () => {
    const f = fixture();
    const invalid: [string, Uint8Array | string, string][] = [
      ["nul.txt", Uint8Array.of(65, 0, 66), "文件包含二进制或控制字符，无法预览"],
      ["bell.txt", Uint8Array.of(65, 7, 66), "文件包含二进制或控制字符，无法预览"],
      ["del.txt", Uint8Array.of(65, 127, 66), "文件包含二进制或控制字符，无法预览"],
      ["c1.txt", "A\u0085B", "文件包含二进制或控制字符，无法预览"],
      ["invalid.txt", Uint8Array.of(0xc3, 0x28), "文件不是有效的 UTF-8 文本"],
      ["utf16.txt", Uint8Array.of(0xff, 0xfe, 65, 0), "文件不是有效的 UTF-8 文本"],
      ["binary.pdf", "%PDF-1.7", "此文件类型不支持预览"],
    ];
    f.insert(invalid.map(([name, bytes]) => attachment(name, bytes)));
    const files = await f.all();
    for (const [name, bytes, error] of invalid) {
      const item = files.find((file) => file.name === name) as ConversationFile;
      const preview = f.preview(item);
      expect(preview.status).toBe(415);
      expect(await preview.json()).toEqual({ error });
      expect(new Uint8Array(await f.download(item).arrayBuffer())).toEqual(new Uint8Array(Buffer.from(bytes)));
    }
  });

  test("accepts exactly 1 MiB and rejects oversized metadata before selecting attachment payloads", async () => {
    const f = fixture();
    f.insert([
      attachment("exact.txt", "a".repeat(FILE_PREVIEW_MAX_BYTES)),
      attachment("large.txt", "a".repeat(FILE_PREVIEW_MAX_BYTES + 1)),
    ]);
    const files = await f.all();
    const exact = files.find((item) => item.name === "exact.txt") as ConversationFile;
    const large = files.find((item) => item.name === "large.txt") as ConversationFile;
    const sources = spyOn(f.store, "conversationFileSources");
    try {
      const denied = f.preview(large);
      expect(denied.status).toBe(413);
      expect(await denied.json()).toEqual({ error: "文件超过 1 MiB 预览上限" });
      expect(sources.mock.calls.every((args) => args[5] !== true)).toBe(true);
      const response = f.preview(exact);
      expect(response.status).toBe(200);
      const preview = await response.json();
      expect(preview.size).toBe(FILE_PREVIEW_MAX_BYTES);
      expect(preview.text).toHaveLength(FILE_PREVIEW_MAX_BYTES);
      expect(sources.mock.calls.some((args) => args[5] === true && args[6] === FILE_PREVIEW_MAX_BYTES)).toBe(true);
    } finally {
      sources.mockRestore();
    }
  });

  test("bounds project file reads even when the file grows after its descriptor check", async () => {
    const f = fixture();
    const path = join(f.cwd, "growth.txt");
    writeFileSync(path, "safe");
    f.insert([], { senderKind: "agent", content: "[growth](growth.txt)" });
    const file = (await f.all())[0] as ConversationFile;
    const actualRead = fs.readSync;
    let grown = false;
    let requested = 0;
    const read = spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      if (!grown) {
        grown = true;
        writeFileSync(path, "a".repeat(FILE_PREVIEW_MAX_BYTES + 100));
      }
      requested += length;
      return actualRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);
    try {
      expect(f.preview(file).status).toBe(413);
      expect(grown).toBe(true);
      expect(requested).toBeLessThanOrEqual(FILE_PREVIEW_MAX_BYTES + 1);
    } finally {
      read.mockRestore();
    }
  });

  test("rejects oversized project file metadata before reading its descriptor", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "large.txt"), "a".repeat(FILE_PREVIEW_MAX_BYTES + 1));
    f.insert([], { senderKind: "agent", content: "[large](large.txt)" });
    const file = (await f.all())[0] as ConversationFile;
    const read = spyOn(fs, "readSync");
    try {
      const response = f.preview(file);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "文件超过 1 MiB 预览上限" });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  test("reuses exact persisted IDs, room boundaries and current project path checks", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "note.md"), "current first");
    writeFileSync(join(f.root, "outside.md"), "outside secret");
    mkdirSync(join(f.cwd, "directory"));
    symlinkSync(join(f.root, "outside.md"), join(f.cwd, "escape.md"));
    f.insert([attachment("note.md", "original attachment")]);
    const message = f.insert([], {
      senderKind: "agent",
      content: `[current](note.md) [outside](<${join(f.root, "outside.md")}>) [linked](escape.md) [missing](missing.md) [dir](directory)`,
    });
    const files = await f.all();
    const current = files.find((item) => item.name === "note.md" && item.source === "agent") as ConversationFile;
    const original = files.find((item) => item.name === "note.md" && item.source === "attachment") as ConversationFile;
    writeFileSync(join(f.cwd, "note.md"), "current new");
    expect(await f.preview(current).json()).toEqual({ kind: "markdown", text: "current new", size: 11 });
    expect(await f.preview(original).json()).toEqual({ kind: "markdown", text: "original attachment", size: 19 });
    writeFileSync(join(f.cwd, "note.md"), Uint8Array.of(0xc3, 0x28));
    expect(f.preview(current).status).toBe(415);
    expect(f.preview(current, f.other.id).status).toBe(404);
    for (const file of files.filter((item) => item.name !== "note.md"))
      expect(f.preview(file).status).toBe(file.name === "missing.md" ? 404 : 403);
    unlinkSync(join(f.cwd, "note.md"));
    symlinkSync(join(f.root, "outside.md"), join(f.cwd, "note.md"));
    expect(f.preview(current).status).toBe(403);
    expect(handleConversationFilePreview(f.store, f.room.id, "invalid!").status).toBe(400);
    f.store.db.query("DELETE FROM messages WHERE id = ?").run(message.id);
    expect(f.preview(current).status).toBe(404);
  });
});

describe("conversation file list", () => {
  test("lists persisted history past 200 messages and pages every reference within a message without base64", async () => {
    const f = fixture();
    const first = f.insert([attachment("old.bin", "old payload")]);
    for (let index = 0; index < 250; index++) f.insert([], { content: `ordinary ${index}` });
    const many = f.insert(
      Array.from({ length: 81 }, (_, index) => attachment(`item-${index}.bin`, `payload ${index}`)),
    );
    f.reopen();
    const files = await f.all(7);
    expect(files).toHaveLength(82);
    expect(new Set(files.map((file) => file.id)).size).toBe(82);
    expect(files.slice(0, 81).every((file) => file.messageId === many.id)).toBe(true);
    expect(files.at(-1)?.messageId).toBe(first.id);
    expect(JSON.stringify(files)).not.toContain(Buffer.from("old payload").toString("base64"));
    expect(files.every((file) => !("data" in file) && !("timeline" in file))).toBe(true);
    expect((await f.page({ limit: "7" })).items.map((file) => file.id)).toEqual(
      files.slice(0, 7).map((file) => file.id),
    );
  });

  test("preserves duplicate names and exact user file/image bytes across restart", async () => {
    const f = fixture();
    const bytes = Uint8Array.from([0, 255, 1, 254, 10, 13, 128]);
    const old = f.insert([attachment("same.bin", bytes)]);
    const newer = f.insert([
      attachment("same.bin", "new content"),
      { kind: "image", mimeType: "image/png", data: Buffer.from(bytes).toString("base64") },
    ]);
    const before = await f.all();
    f.reopen();
    const files = await f.all();
    expect(files.map((file) => file.id)).toEqual(before.map((file) => file.id));
    expect(files.filter((file) => file.name === "same.bin")).toHaveLength(2);
    expect(files[0]?.messageId).toBe(newer.id);
    const original = files.find((file) => file.messageId === old.id) as ConversationFile;
    const image = files.find((file) => file.image) as ConversationFile;
    expect(original.size).toBe(bytes.length);
    expect(new Uint8Array(await f.download(original).arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await f.download(image).arrayBuffer())).toEqual(bytes);
    expect(image).toMatchObject({ source: "attachment", mimeType: "image/png", name: "image-2.png" });
  });

  test("finds explicit Agent outputs and completed edits/resources while excluding reads, failures, thought text and remote targets", async () => {
    const f = fixture();
    for (const name of [
      "body.txt",
      "edit.txt",
      "location.txt",
      "resource.txt",
      "file-url.txt",
      "read.txt",
      "failed.txt",
      "thought.txt",
    ])
      writeFileSync(join(f.cwd, name), name);
    const tool = (id: string, kind: string, status = "completed") => ({
      toolCallId: id,
      title: id,
      kind,
      status,
      locations: [],
      content: [],
    });
    f.insert(
      [
        { kind: "thought", text: "[thought](thought.txt)" },
        attachment("agent.bin", "from agent"),
        { kind: "image", mimeType: "image/webp", data: "AQID" },
      ],
      {
        senderKind: "agent",
        senderName: "Agent",
        content: `[body](body.txt) [URL](<${pathToFileURL(join(f.cwd, "file-url.txt"))}>) [remote](https://example.com/x.txt) bare.txt\n\`[example](example.txt)\`\n\`\`\`md\n[example](example.txt)\n\`\`\``,
      },
      {
        edit: {
          ...tool("edit", "edit"),
          content: [{ type: "diff", path: "edit.txt", oldText: "before", newText: "after" }],
          locations: [{ path: "location.txt", line: 1 }],
        },
        resource: {
          ...tool("resource", "execute"),
          content: [
            {
              type: "content",
              content: {
                type: "resource_link",
                name: "resource.txt",
                mimeType: "text/plain",
                uri: pathToFileURL(join(f.cwd, "resource.txt")).href,
              },
            },
          ],
        },
        read: {
          ...tool("read", "read"),
          content: [
            {
              type: "content",
              content: { type: "resource_link", name: "read.txt", uri: pathToFileURL(join(f.cwd, "read.txt")).href },
            },
          ],
        },
        failed: {
          ...tool("failed", "edit", "failed"),
          content: [{ type: "diff", path: "failed.txt", oldText: "", newText: "" }],
        },
      },
    );
    const files = await f.all();
    expect(new Set(files.map((file) => file.name))).toEqual(
      new Set(["body.txt", "file-url.txt", "edit.txt", "location.txt", "resource.txt", "agent.bin", "image-3.webp"]),
    );
    expect(files.every((file) => file.source === "agent" && file.senderName === "Agent")).toBe(true);
    expect(await f.download(files.find((file) => file.name === "resource.txt") as ConversationFile).text()).toBe(
      "resource.txt",
    );
  });

  test("does not truncate many links or long visible message bodies", async () => {
    const f = fixture();
    const boundary = `${"x".repeat(32760)}[boundary](boundary.txt) `;
    const message = f.insert([], {
      senderKind: "agent",
      content: boundary + Array.from({ length: 121 }, (_, index) => `[f](same-${index}.txt)`).join(" "),
    });
    const files = await f.all(5);
    expect(files).toHaveLength(122);
    expect(new Set(files.map((file) => file.id)).size).toBe(122);
    expect(files.every((file) => file.messageId === message.id && file.state === "missing")).toBe(true);
    expect(files.filter((file) => file.name === "boundary.txt")).toHaveLength(1);
  });

  test("ignores long fenced, indented and escaped Markdown examples while retaining a link directly after a fence", async () => {
    const f = fixture();
    for (const name of ["example.txt", "real.txt"]) writeFileSync(join(f.cwd, name), name);
    const content = `\`\`\`markdown\n${"x".repeat(40000)}\n[example](example.txt)\n\`\`\`\n[real](real.txt)\n    [example](example.txt)\nUse \\[example](example.txt) literally.`;
    f.insert([], { senderKind: "agent", content });
    const files = await f.all(1);
    expect(files.map((file) => file.name)).toEqual(["real.txt"]);
    expect(await f.download(files[0] as ConversationFile).text()).toBe("real.txt");
  });

  test("marks oversized local deliverables unavailable and rejects malformed inline payloads", async () => {
    const f = fixture();
    const huge = join(f.cwd, "large.bin");
    writeFileSync(huge, "");
    truncateSync(huge, CONVERSATION_FILE_DOWNLOAD_MAX_BYTES + 1);
    f.insert([{ kind: "file", name: "bad.bin", mimeType: "application/octet-stream", data: "AB==" }], {
      senderKind: "agent",
      content: "[large](large.bin)",
    });
    const files = await f.all();
    const large = files.find((file) => file.name === "large.bin") as ConversationFile;
    expect(large).toMatchObject({ state: "unavailable", size: CONVERSATION_FILE_DOWNLOAD_MAX_BYTES + 1 });
    expect(large.downloadUrl).toBeUndefined();
    expect(f.download(large).status).toBe(403);
    expect(await f.download(large).json()).toEqual({ error: "文件超过 100 MiB 下载上限" });
    const malformed = files.find((file) => file.name === "bad.bin") as ConversationFile;
    expect(malformed.state).toBe("unavailable");
    expect(f.download(malformed).status).toBe(403);
  });

  test("uses current Agent file bytes and reports missing, outside, symlink escapes and directories explicitly", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "current.txt"), "first");
    writeFileSync(join(f.root, "outside.txt"), "outside secret");
    mkdirSync(join(f.cwd, "directory"));
    symlinkSync(join(f.root, "outside.txt"), join(f.cwd, "escape.txt"));
    symlinkSync(f.root, join(f.cwd, "escape-dir"));
    f.insert([], {
      senderKind: "agent",
      content: `[current](current.txt) [missing](missing.txt) [outside](<${join(f.root, "outside.txt")}>) [traversal](../outside.txt) [linked](escape.txt) [directory](directory) [missing outside](escape-dir/not-created.txt)`,
    });
    const files = await f.all();
    const current = files.find((file) => file.name === "current.txt") as ConversationFile;
    expect(current).toMatchObject({ state: "available", size: 5 });
    writeFileSync(join(f.cwd, "current.txt"), "current bytes");
    expect(await f.download(current).text()).toBe("current bytes");
    const missing = files.find((file) => file.name === "missing.txt") as ConversationFile;
    expect(missing).toMatchObject({ state: "missing", size: null });
    expect(f.download(missing).status).toBe(404);
    for (const file of files.filter((file) => file.id !== current.id && file.id !== missing.id)) {
      expect(file).toMatchObject({ state: "unavailable", size: null });
      expect(file.downloadUrl).toBeUndefined();
      expect(f.download(file).status).toBe(403);
    }
    unlinkSync(join(f.cwd, "current.txt"));
    expect(f.download(current).status).toBe(404);
    symlinkSync(join(f.root, "outside.txt"), join(f.cwd, "current.txt"));
    expect(f.download(current).status).toBe(403);
  });

  test("downloads HTML only as an attachment with UTF-8 filename and nosniff", async () => {
    const f = fixture();
    const html = "<script>alert('never execute')</script>";
    f.insert([attachment("报告 '完成'.html", html, "text/html")]);
    const file = (await f.all())[0] as ConversationFile;
    const response = f.download(file);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toStartWith("attachment; filename=");
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%27%E5%AE%8C%E6%88%90%27.html",
    );
    expect(await response.text()).toBe(html);
    expect(file.image).toBe(false);
  });

  test("isolates rooms, rederives exact persisted references, and validates pagination inputs", async () => {
    const f = fixture();
    const message = f.insert([attachment("owned.txt", "owned")]);
    f.insert([attachment("foreign.txt", "foreign")], { roomId: f.other.id });
    const file = (await f.all())[0] as ConversationFile;
    expect(f.download(file, f.other.id).status).toBe(404);
    expect(handleConversationFileContent(f.store, f.room.id, "not!valid").status).toBe(400);
    const identity = JSON.parse(Buffer.from(file.id, "base64url").toString());
    for (const patch of [
      { key: "p:000000001234" },
      { offset: 100 },
      { messageId: "missing" },
      { seq: message.seq + 1 },
    ]) {
      const forged = Buffer.from(JSON.stringify({ ...identity, ...patch })).toString("base64url");
      expect(handleConversationFileContent(f.store, f.room.id, forged).status).toBe(404);
    }
    const first = await f.page({ limit: "1" });
    expect(first.nextCursor).not.toBeNull();
    expect(f.request({ cursor: first.nextCursor as string }, f.other.id).status).toBe(400);
    const invalidRequests: Record<string, string>[] = [
      { cursor: "" },
      { cursor: "wrong!" },
      { limit: "0" },
      { limit: "101" },
      { limit: "01" },
      { limit: "1.5" },
    ];
    for (const params of invalidRequests) expect(f.request(params).status).toBe(400);
    f.store.db.query("DELETE FROM messages WHERE id = ?").run(message.id);
    expect(f.download(file).status).toBe(404);
    expect(f.request({}, "missing-room").status).toBe(404);
  });

  test("skips file-free history and ignores malformed timelines and streaming/system sources", async () => {
    const f = fixture();
    f.insert([attachment("old.txt", "old")]);
    f.store.db.transaction(() => {
      for (let index = 0; index < 10001; index++) f.insert([], { content: "ordinary" });
    })();
    const corrupt = f.insert([], { senderKind: "agent", content: "no explicit link" });
    f.store.db.query("UPDATE messages SET timeline = 'not-json' WHERE id = ?").run(corrupt.id);
    f.insert([attachment("streaming.txt", "no")], { senderKind: "agent", status: "streaming" });
    f.insert([attachment("system.txt", "no")], { senderKind: "system" });
    const first = await f.page();
    expect(first.items.map((file) => file.name)).toEqual(["old.txt"]);
    expect(first.nextCursor).toBeNull();
    expect((await f.all()).map((file) => file.name)).toEqual(["old.txt"]);
  });

  test("keeps a bounded empty candidate page resumable", async () => {
    const f = fixture();
    f.insert([attachment("old.txt", "old")]);
    for (let index = 0; index < 40; index++)
      f.insert([], { senderKind: "agent", content: "[remote](https://example.com/file.txt)" });
    const first = await f.page();
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect((await f.all()).map((file) => file.name)).toEqual(["old.txt"]);
  });
});
