import { afterAll, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { serve } from "../server/app";
import { filePromptBlock, nativeFileBlocks } from "../server/attachments";
import { HarnessHost } from "../server/host";
import type { Message } from "../server/store";
import type { FileAttachment } from "../shared/attachments";
import { emptyTimeline } from "../shared/timeline";
import { agentInput } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "tt-attachment-api-"));
const cwd = join(scratch, "project");
mkdirSync(cwd);
const { app, server } = serve({ dbPath: join(scratch, "data", "chat.sqlite") }, 0);
const base = `http://127.0.0.1:${server.port}`;
const project = app.store.createProject("attachments", cwd);
const recoveryHosts: HarnessHost[] = [];
afterAll(async () => {
  for (const host of recoveryHosts) host.shutdown();
  app.host.shutdown();
  server.stop(true);
  await Bun.sleep(100);
  app.store.db.close();
  rmSync(scratch, { recursive: true, force: true });
});

test("a rebuilt Harness restores only transcript-owned attachment files and rejects linked replacements", async () => {
  const agent = app.store.createAgent(
    agentInput("RecoveredAttachments", {
      env: { MOCK_AGENT_SESSION_DIR: join(scratch, "recovery-sessions") },
    }),
  );
  const room = app.store.createRoom("attachment recovery", [agent.id], { projectId: project.id });
  const otherRoom = app.store.createRoom("other attachments", [agent.id], { projectId: project.id });
  const binary = file("original.pdf", "%PDF-restore\0", "application/pdf");
  const persist = (roomId: string) => {
    const human = app.store.insertMessage({
      roomId,
      runId: crypto.randomUUID(),
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "Owner",
      content: "read the attachment",
      status: "done",
    });
    return app.store.updateReply(human.id, {
      content: human.content,
      status: "done",
      timeline: { ...emptyTimeline(), parts: [{ kind: "file", ...binary }] },
    });
  };
  const original = persist(room.id);
  const foreign = persist(otherRoom.id);
  const dataDir = join(scratch, "data");
  const originalBlock = filePromptBlock(binary, room.id, original.id, 0);
  const materialized = nativeFileBlocks([originalBlock], dataDir, room.id, true);
  const link = materialized.blocks[0];
  if (link?.type !== "resource_link") throw new Error("missing recovery original");
  const path = fileURLToPath(link.uri);
  const foreignPath = nativeFileBlocks(
    [filePromptBlock(binary, otherRoom.id, foreign.id, 0)],
    dataDir,
    otherRoom.id,
    true,
  ).readPaths[0];
  if (!foreignPath) throw new Error("missing foreign original");
  const host = () => {
    const h = new HarnessHost(app.store, dataDir, { session() {}, permission() {}, terminal() {} });
    recoveryHosts.push(h);
    return h;
  };
  const firstHost = host();
  const first = await firstHost.session(room, agent, "test");
  const firstSessionId = first.slot.view.sessionId;
  await firstHost.prompt(
    room,
    agent,
    "test",
    [{ type: "text", text: "read attachment" }, originalBlock],
    () => {},
    new AbortController().signal,
  );
  firstHost.shutdown();
  await first.proc.acp.exited;
  const unreferenced = join(dirname(path), "unreferenced.txt");
  writeFileSync(unreferenced, "not part of the transcript");
  const secondHost = host();
  const second = await secondHost.session(room, agent, "test");
  expect(second.slot.view.sessionId).toBe(firstSessionId);
  const read = second.proc.acp as unknown as {
    readTextFile(params: { sessionId: string; path: string }): Promise<{ content: string }>;
  };
  const sessionId = second.slot.view.sessionId as string;
  expect(await read.readTextFile({ sessionId, path })).toEqual({ content: "%PDF-restore\0" });
  await expect(read.readTextFile({ sessionId, path: foreignPath })).rejects.toThrow();
  await expect(read.readTextFile({ sessionId, path: unreferenced })).rejects.toThrow();
  secondHost.shutdown();
  await second.proc.acp.exited;

  unlinkSync(path);
  symlinkSync(unreferenced, path);
  const thirdHost = host();
  await expect(thirdHost.session(room, agent, "test")).rejects.toThrow("附件原件不可用");
  expect(readFileSync(unreferenced, "utf8")).toBe("not part of the transcript");
  unlinkSync(path);
  const repaired = await thirdHost.session(room, agent, "test");
  expect(readFileSync(path)).toEqual(Buffer.from(binary.data, "base64"));
  const repairedRead = repaired.proc.acp as unknown as typeof read;
  expect(await repairedRead.readTextFile({ sessionId: repaired.slot.view.sessionId as string, path })).toEqual({
    content: "%PDF-restore\0",
  });
});

const file = (
  name = "notes.md",
  text = "# Context\n@Member only appears in the attachment",
  mimeType = "text/plain",
): FileAttachment => ({
  name,
  mimeType,
  data: Buffer.from(text).toString("base64"),
});

async function post(roomId: string, value: Record<string, unknown>) {
  const response = await fetch(`${base}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "", ...value }),
  });
  return { status: response.status, data: (await response.json()) as Message & { error?: string } };
}

test("file-only requests persist originals, preserve routing and retry the same attachments", async () => {
  const lead = app.store.createAgent(agentInput("AttachmentLead"));
  const other = app.store.createAgent(agentInput("Member"));
  const room = app.store.createRoom("files", [lead.id, other.id], { projectId: project.id, mainAgentId: lead.id });
  const attached = await app.host.session(room, lead, "test");
  const request = spyOn(attached.proc.acp.agent, "request");
  try {
    const originalFile = file("@Member.md");
    const result = await post(room.id, { files: [originalFile] });
    expect(result.status).toBe(201);
    expect(result.data.content).toBe("");
    expect(result.data.timeline?.parts).toEqual([{ kind: "file", ...originalFile }]);
    await app.orchestrator.idle(room.id);
    const replies = app.store.runMessages(room.id, result.data.id).filter((message) => message.senderKind === "agent");
    expect(replies.map((reply) => reply.senderId)).toEqual([lead.id]);
    const prompt = request.mock.calls.find(([method]) => method === methods.agent.session.prompt)?.[1] as PromptRequest;
    expect(
      prompt.prompt.some(
        (block) => block.type === "resource" && "text" in block.resource && block.resource.text.includes("@Member"),
      ),
    ).toBe(true);
    expect(existsSync(join(cwd, ".tuantuan"))).toBe(false);
    const previous = replies[0];
    if (!previous) throw new Error("missing reply");
    const interrupted = app.store.updateReply(previous.id, {
      content: previous.content,
      timeline: previous.timeline ?? emptyTimeline(),
      status: "interrupted",
    });
    const retry = await fetch(`${base}/api/rooms/${room.id}/messages/${interrupted.id}/retry`, { method: "POST" });
    expect(retry.status).toBe(201);
    const repeated = (await retry.json()) as Message;
    expect(repeated.id).not.toBe(result.data.id);
    expect(repeated.timeline?.parts).toEqual(result.data.timeline?.parts);
    await app.orchestrator.idle(room.id);
  } finally {
    request.mockRestore();
  }
});

test("malformed attachments and mixed count limits reject atomically before transcript writes", async () => {
  const agent = app.store.createAgent(agentInput("ValidateAttachments"));
  const room = app.store.createRoom("validate", [agent.id], { projectId: project.id });
  for (const invalid of [
    { files: [{ ...file(), name: "../escape" }] },
    { files: [{ ...file(), data: "invalid-base64" }] },
    { files: [{ ...file(), mimeType: "invalid" }] },
    { images: [{ mimeType: "image/svg+xml", data: "" }] },
    { images: Array(4).fill({ mimeType: "image/png", data: "" }), files: Array(5).fill(file()) },
  ]) {
    expect((await post(room.id, invalid)).status).toBe(400);
    expect(app.store.recentMessages(room.id, 10)).toEqual([]);
  }
});

test("binary files become managed paths with read-only ACP grants; unsupported images fail explicitly", async () => {
  const agent = app.store.createAgent(agentInput("BinaryAttachments", { env: { MOCK_AGENT_IMAGE: "0" } }));
  const room = app.store.createRoom("binary", [agent.id], { projectId: project.id });
  const attached = await app.host.session(room, agent, "test");
  const request = spyOn(attached.proc.acp.agent, "request");
  try {
    const binary = file("manual.pdf", "%PDF-1.7\0", "application/pdf");
    const result = await post(room.id, { files: [binary] });
    expect(result.status).toBe(201);
    await app.orchestrator.idle(room.id);
    const prompt = request.mock.calls.find(([method]) => method === methods.agent.session.prompt)?.[1] as PromptRequest;
    const link = prompt.prompt.find((block) => block.type === "resource_link");
    if (link?.type !== "resource_link") throw new Error("missing binary resource link");
    const path = new URL(link.uri);
    expect(readFileSync(path)).toEqual(Buffer.from(binary.data, "base64"));
    const files = attached.proc.acp as unknown as {
      readTextFile(p: { sessionId: string; path: string }): Promise<{ content: string }>;
      writeTextFile(p: { sessionId: string; path: string; content: string }): Promise<unknown>;
    };
    const sessionId = attached.slot.view.sessionId as string;
    expect(await files.readTextFile({ sessionId, path: path.pathname })).toEqual({ content: "%PDF-1.7\0" });
    await expect(files.writeTextFile({ sessionId, path: path.pathname, content: "overwrite" })).rejects.toThrow();
    const count = app.store.recentMessages(room.id, 100).length;
    const rejected = await post(room.id, { images: [{ mimeType: "image/png", data: "aGk=" }] });
    expect(rejected.status).toBe(400);
    expect(rejected.data.error).toContain("不支持图片");
    expect(app.store.recentMessages(room.id, 100).length).toBe(count);
    await expect(
      app.host.prompt(
        room,
        agent,
        "test",
        [{ type: "image", mimeType: "image/png", data: "aGk=" }],
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("不支持图片");
  } finally {
    request.mockRestore();
  }
});

test("custom API binary uploads fail before persistence rather than reporting an unreadable attachment as sent", async () => {
  const agent = app.store.createAgent(
    agentInput("CustomBinary", {
      harness: "custom",
      custom: { format: "openai-chat", baseUrl: "http://127.0.0.1:9", model: "fixture", apiKey: "fixture-key" },
    }),
  );
  const room = app.store.createRoom("custom binary", [agent.id], { projectId: project.id });
  const rejected = await post(room.id, { files: [file("manual.pdf", "%PDF", "application/pdf")] });
  expect(rejected.status).toBe(400);
  expect(rejected.data.error).toContain("仅支持 UTF-8 文本文件");
  expect(app.store.recentMessages(room.id, 10)).toEqual([]);
});

test("custom API receives complete UTF-8 file contents and images through the ordinary message route", async () => {
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const endpoint = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number]);
      return new Response(
        'data: {"choices":[{"delta":{"content":"file and image received"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  try {
    const agent = app.store.createAgent(
      agentInput("CustomAttachments", {
        harness: "custom",
        custom: {
          format: "openai-chat",
          baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
          model: "fixture",
          apiKey: "fixture-key",
        },
      }),
    );
    const room = app.store.createRoom("custom contents", [agent.id], { projectId: project.id });
    const view = await app.host.sessionView(room, agent, "test");
    expect(view.capabilities.image).toBe(true);
    const original = "const evidence = '完整文本';\n".repeat(150);
    const attachedFile = file("example.ts", original, "application/octet-stream");
    const result = await post(room.id, { files: [attachedFile], images: [{ mimeType: "image/png", data: "aGk=" }] });
    expect(result.status).toBe(201);
    await app.orchestrator.idle(room.id);
    const user = requests[0]?.messages.find((message) => message.role === "user");
    expect(JSON.stringify(user?.content)).toContain(JSON.stringify(original).slice(1, -1));
    expect(JSON.stringify(user?.content)).toContain("data:image/png;base64,aGk=");
    const reply = app.store.recentMessages(room.id, 1)[0];
    expect(reply?.status).toBe("done");
    expect(reply?.content).toBe("file and image received");
    expect(result.data.timeline?.parts).toContainEqual({ kind: "file", ...attachedFile });
  } finally {
    endpoint.stop(true);
  }
});
