import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CUSTOM_FORMATS,
  CUSTOM_HISTORY_MAX_CHARS,
  CUSTOM_HISTORY_MAX_TURNS,
  type CustomSecret,
  historyChars,
} from "../server/custom";
import { HarnessHost } from "../server/host";
import { Orchestrator } from "../server/orchestrator";
import { type Agent, type Room, Store } from "../server/store";
import { TuantuanMcp } from "../server/tuantuan-mcp";
import { agentInput, until } from "./helpers";

/** BYOK context: whole completed turns, persisted per (room, agent), bounded by count and size. */

const scratch = mkdtempSync(join(tmpdir(), "tt-custom-history-"));
const dataDir = join(scratch, "data");
mkdirSync(dataDir, { recursive: true });
const stores: Store[] = [];
const servers: { stop: () => void }[] = [];

afterAll(() => {
  for (const s of servers) s.stop();
  for (const s of stores) s.db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** SSE API mock: plain turns echo "pong"; a user text with `skill:<name>` triggers one load_skill round. */
function api(format: CustomSecret["format"]) {
  const calls: Record<string, unknown>[] = [];
  const knobs = { failNext: false, hang: false, blockNext: null as null | Promise<void> };
  const sseHeaders = { "content-type": "text/event-stream" };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      calls.push(body);
      if (knobs.failNext) {
        knobs.failNext = false;
        return Response.json({ error: { message: "接口坏了" } }, { status: 500 });
      }
      if (knobs.hang)
        return new Response(
          new ReadableStream({
            start() {
              /* headers sent, body never completes */
            },
          }),
          { headers: sseHeaders },
        );
      // Hold the next response until the test releases it (mid-turn reset scenarios).
      const blocker = knobs.blockNext;
      if (blocker) {
        knobs.blockNext = null;
        await blocker;
      }
      const hadTool = hasToolResult(format, body);
      const skill = !hadTool && String(latestUserText(format, body) ?? "").match(/skill:(\w+)/)?.[1];
      if (skill) return new Response(streamToolCall(format, skill), { headers: sseHeaders });
      return new Response(streamText(format, hadTool ? "done" : "pong"), { headers: sseHeaders });
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return { url: `http://127.0.0.1:${server.port}/v1`, calls, knobs };
}

/** OpenAI-chat user texts of the last request, in order. */
const chatUsers = (calls: Record<string, unknown>[]) =>
  ((calls.at(-1) as { messages?: { role: string; content: string }[] } | undefined)?.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => m.content);

function latestUserText(format: CustomSecret["format"], body: Record<string, unknown>): string {
  if (format === "openai-responses")
    return (
      (body.input as { role?: string; content?: string }[] | undefined)?.filter((i) => i.role === "user").at(-1)
        ?.content ?? ""
    );
  const messages = (body.messages as { role?: string; content?: unknown }[] | undefined) ?? [];
  return messages.filter((m) => m.role === "user").at(-1)?.content as string;
}

function hasToolResult(format: CustomSecret["format"], body: Record<string, unknown>): boolean {
  if (format === "openai-chat") return ((body.messages as { role?: string }[]) ?? []).some((m) => m.role === "tool");
  if (format === "openai-responses")
    return ((body.input as { type?: string }[]) ?? []).some((i) => i.type === "function_call_output");
  return ((body.messages as { content?: unknown }[]) ?? []).some((m) =>
    Array.isArray(m.content) ? m.content.some((c: { type?: string }) => c.type === "tool_result") : false,
  );
}

function sseData(json: unknown) {
  return `data: ${JSON.stringify(json)}\n\n`;
}

function streamText(format: CustomSecret["format"], text: string) {
  if (format === "openai-chat")
    return (
      sseData({ choices: [{ delta: { content: text } }] }) +
      sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n"
    );
  if (format === "openai-responses")
    return (
      `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: text })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({})}\n\n`
    );
  return (
    `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: "text_delta", text } })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: "end_turn" } })}\n\n`
  );
}

function streamToolCall(format: CustomSecret["format"], skill: string) {
  const args = JSON.stringify({ name: skill });
  if (format === "openai-chat")
    return (
      sseData({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "load_skill", arguments: "" } }] } }],
      }) +
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] }) +
      sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n"
    );
  if (format === "openai-responses")
    return (
      `event: response.output_item.done\ndata: ${JSON.stringify({
        item: { type: "function_call", call_id: "c1", name: "load_skill", arguments: args },
      })}\n\n` + `event: response.completed\ndata: ${JSON.stringify({})}\n\n`
    );
  return (
    `event: content_block_start\ndata: ${JSON.stringify({
      content_block: { type: "tool_use", id: "c1", name: "load_skill", input: {} },
    })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: "input_json_delta", partial_json: args } })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: "tool_use" } })}\n\n`
  );
}

let n = 0;
function fixture(format: CustomSecret["format"] = "openai-chat", persist = true) {
  const store = new Store(join(scratch, persist ? `db-${++n}.db` : `:memory:`));
  stores.push(store);
  const a = api(format);
  const agent = store.createAgent(
    agentInput(`Bot${n}`, { harness: "custom", custom: { format, baseUrl: a.url, model: "m", apiKey: "sk-test" } }),
  );
  const project = store.createProject(`p${n}`, join(scratch, `ws${n}`));
  const room = store.createRoom(`r${n}`, [agent.id], { projectId: project.id });
  return { store, api: a, agent, room };
}

/** A fresh host over the same store = a service restart (BYOK context lives in SQLite only). */
function boot(store: Store) {
  const mcp = new TuantuanMcp();
  const host = new HarnessHost(store, dataDir, { session: () => {}, permission: () => {}, terminal: () => {} }, mcp);
  mcp.provider = new Orchestrator(store, host, () => {});
  return host;
}

const say = (host: HarnessHost, room: Room, agent: Agent, text: string, signal?: AbortSignal) =>
  host.prompt(room, agent, "", [{ type: "text" as const, text }], () => {}, signal ?? AbortSignal.timeout(20_000));

function addSkill(agentId: string, name: string, body: string) {
  const dir = join(dataDir, "agents", agentId, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`);
}

describe("BYOK conversation context", () => {
  test("keeps at most 20 whole turns and 65536 serialized characters, dropping the oldest", async () => {
    const f = fixture();
    const host = boot(f.store);
    for (let i = 1; i <= 25; i++) await say(host, f.room, f.agent, `u${i}`);
    const turns = f.store.getCustomHistory(f.room.id, f.agent.id);
    expect(turns).not.toBeNull();
    expect(turns).toHaveLength(CUSTOM_HISTORY_MAX_TURNS);
    expect(turns?.[0]?.[0]).toMatchObject({ kind: "user", text: "u6" });
    expect(historyChars(turns ?? [])).toBeLessThanOrEqual(CUSTOM_HISTORY_MAX_CHARS);
    // The last request carried whole old turns only: the oldest history item was u6, plus u25.
    expect(chatUsers(f.api.calls)).toEqual([...Array.from({ length: 19 }, (_, i) => `u${6 + i}`), "u25"]);
  });

  test("the serialized character cap evicts whole turns before the turn count cap", async () => {
    const f = fixture();
    const host = boot(f.store);
    for (let i = 1; i <= 8; i++) await say(host, f.room, f.agent, `${"x".repeat(12_000)}-${i}`);
    const turns = f.store.getCustomHistory(f.room.id, f.agent.id) ?? [];
    expect(turns.length).toBeLessThan(8);
    expect(turns.length).toBeGreaterThan(0);
    expect(historyChars(turns)).toBeLessThanOrEqual(CUSTOM_HISTORY_MAX_CHARS);
    expect(turns.at(-1)?.[0]).toMatchObject({ kind: "user", text: `${"x".repeat(12_000)}-8` });
  });

  for (const format of CUSTOM_FORMATS) {
    test(`${format}: tool calls and results stay paired across persistence and a restart`, async () => {
      const f = fixture(format);
      addSkill(f.agent.id, "greet", "hello-skill-body");
      const first = boot(f.store);
      await say(first, f.room, f.agent, "请 skill:greet");
      expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toHaveLength(1);

      const second = boot(f.store); // restart
      await say(second, f.room, f.agent, "再看一眼");
      const body = f.api.calls.at(-1) as Record<string, unknown>;
      const flat = JSON.stringify(body);
      expect(flat).toContain("hello-skill-body");
      expect(flat).toContain("load_skill");
      if (format === "openai-chat") {
        const messages = body.messages as {
          role: string;
          tool_calls?: { function: { name: string } }[];
          tool_call_id?: string;
        }[];
        const call = messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
        const result = messages.find((m) => m.role === "tool");
        expect(call?.tool_calls?.[0]?.function?.name).toBe("load_skill");
        expect(result?.tool_call_id).toBeTruthy();
        expect(messages.indexOf(result as never)).toBe(messages.indexOf(call as never) + 1);
        expect(messages.at(-1)).toMatchObject({ role: "user", content: "再看一眼" });
      } else if (format === "openai-responses") {
        const input = body.input as { type?: string; call_id?: string; role?: string }[];
        const call = input.findIndex((i) => i.type === "function_call");
        const output = input.findIndex((i) => i.type === "function_call_output");
        expect(call).toBeGreaterThan(-1);
        expect(input[output]).toMatchObject({ call_id: input[call]?.call_id });
        expect(output).toBe(call + 1);
        expect(input.at(-1)).toMatchObject({ role: "user" });
      } else {
        const messages = body.messages as { role: string; content: { type: string; id?: string }[] }[];
        const assistant = messages.find(
          (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_use"),
        );
        const toolUser = messages.find(
          (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"),
        );
        expect(assistant?.role).toBe("assistant");
        expect(toolUser?.role).toBe("user");
        const useId = assistant?.content.find((c) => c.type === "tool_use")?.id;
        expect(toolUser?.content.find((c) => c.type === "tool_result")).toMatchObject({
          tool_use_id: useId,
          content: "hello-skill-body",
        });
        expect(messages.at(-1)).toMatchObject({ role: "user" });
      }
    });
  }

  test("a restart continues exactly the committed turns", async () => {
    const f = fixture();
    const first = boot(f.store);
    for (const t of ["一", "二", "三"]) await say(first, f.room, f.agent, t);
    const second = boot(f.store);
    await say(second, f.room, f.agent, "四");
    expect(chatUsers(f.api.calls)).toEqual(["一", "二", "三", "四"]);
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toHaveLength(4);
  });

  test("an explicit new conversation stays empty across restarts", async () => {
    const f = fixture();
    const first = boot(f.store);
    await say(first, f.room, f.agent, "旧话题");
    await first.switchSession(f.room, f.agent, "", null);
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toEqual([]);
    const second = boot(f.store);
    await say(second, f.room, f.agent, "新话题");
    expect(chatUsers(f.api.calls)).toEqual(["新话题"]);
  });

  test("failed and cancelled turns keep the last successful context", async () => {
    const f = fixture();
    const host = boot(f.store);
    await say(host, f.room, f.agent, "好的");
    const before = f.store.getCustomHistory(f.room.id, f.agent.id);

    f.api.knobs.failNext = true;
    await expect(say(host, f.room, f.agent, "坏的")).rejects.toThrow(/接口坏了/);
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toEqual(before);

    f.api.knobs.hang = true;
    const ac = new AbortController();
    const hanging = say(host, f.room, f.agent, "挂起", ac.signal);
    await Bun.sleep(150);
    ac.abort(new DOMException("用户取消", "AbortError"));
    await expect(hanging).rejects.toThrow();
    f.api.knobs.hang = false;
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toEqual(before);

    await say(host, f.room, f.agent, "恢复");
    expect(chatUsers(f.api.calls)).toEqual(["好的", "恢复"]);
  });

  test("oversized input is refused before any request; oversized tool results refuse the commit", async () => {
    const f = fixture();
    addSkill(f.agent.id, "big", "y".repeat(70_000));
    const host = boot(f.store);
    const callsBefore = f.api.calls.length;

    await expect(say(host, f.room, f.agent, "z".repeat(CUSTOM_HISTORY_MAX_CHARS + 1))).rejects.toThrow(/上下文预算/);
    expect(f.api.calls.length).toBe(callsBefore);

    await expect(say(host, f.room, f.agent, "请 skill:big")).rejects.toThrow(/上下文预算/);
    // The oversized turn was streamed but not stored: nothing was committed yet.
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toEqual([]);
  });

  test("a missing row recovers a DM transcript once; later messages never leak back in", async () => {
    const f = fixture();
    const seed = (user: string, reply: string) => {
      f.store.insertMessage({
        roomId: f.room.id,
        runId: `run-${user}`,
        hop: 0,
        senderKind: "human",
        senderId: null,
        senderName: "我",
        content: user,
        status: "done",
      });
      f.store.insertMessage({
        roomId: f.room.id,
        runId: `run-${user}`,
        hop: 1,
        senderKind: "agent",
        senderId: f.agent.id,
        senderName: f.agent.name,
        content: reply,
        status: "done",
      });
    };
    seed("旧问1", "旧答1");
    seed("旧问2", "旧答2");

    const first = boot(f.store);
    await say(first, f.room, f.agent, "新问");
    expect(chatUsers(f.api.calls)).toEqual(["旧问1", "旧问2", "新问"]);

    seed("迟到", "迟答");
    const second = boot(f.store); // restart: the initialized row wins, no re-recovery
    await say(second, f.room, f.agent, "又问");
    expect(chatUsers(f.api.calls)).toEqual(["旧问1", "旧问2", "新问", "又问"]);
  });

  test("group rooms start empty (the relay carries context); lifecycle clears stored turns", async () => {
    const f = fixture();
    const other = f.store.createAgent(
      agentInput(`Other${n}`, {
        harness: "custom",
        custom: { format: "openai-chat", baseUrl: f.api.url, model: "m", apiKey: "sk-test" },
      }),
    );
    f.store.setRoomAgents(f.room.id, [f.agent.id, other.id]);
    const room = f.store.getRoom(f.room.id);
    if (!room) throw new Error("missing group room");
    expect(room.kind).toBe("group");
    for (const senderKind of ["human", "agent"] as const)
      f.store.insertMessage({
        roomId: room.id,
        runId: "legacy-group-run",
        hop: senderKind === "human" ? 0 : 1,
        senderKind,
        senderId: senderKind === "human" ? null : f.agent.id,
        senderName: senderKind === "human" ? "我" : f.agent.name,
        content: senderKind === "human" ? "旧群聊任务" : "旧群聊回复",
        status: "done",
      });
    const host = boot(f.store);
    await say(host, room, f.agent, "群聊第一句");
    expect(chatUsers(f.api.calls)).toEqual(["群聊第一句"]);
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toHaveLength(1);

    host.releaseRoom(f.room.id, f.agent.id); // member removed: cleared, and the old chat must
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toEqual([]); // not seed back on re-add
    const restarted = boot(f.store);
    await say(restarted, room, f.agent, "回来");
    expect(chatUsers(f.api.calls)).toEqual(["回来"]);
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toHaveLength(1);

    f.store.deleteRoom(f.room.id); // room deletion cascades
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toBeNull();
  });

  test("every upstream request stays within budget, evicting whole old turns mid-tool-chain", async () => {
    const f = fixture();
    addSkill(f.agent.id, "big", "y".repeat(40_000));
    const host = boot(f.store);
    await say(host, f.room, f.agent, "x".repeat(35_000));

    await say(host, f.room, f.agent, "请 skill:big");
    for (const call of f.api.calls)
      expect(JSON.stringify(call.messages).length).toBeLessThanOrEqual(CUSTOM_HISTORY_MAX_CHARS);
    // The evictable 35k old turn left when the 40k tool result came in; the new turn committed.
    expect(chatUsers(f.api.calls).some((u) => u.length === 35_000)).toBe(false);
    const turns = f.store.getCustomHistory(f.room.id, f.agent.id) ?? [];
    expect(historyChars(turns)).toBeLessThanOrEqual(CUSTOM_HISTORY_MAX_CHARS);
    expect(turns.at(-1)?.[0]).toMatchObject({ kind: "user", text: "请 skill:big" });
  });

  test("an oversized current tool round is refused before the follow-up request is sent", async () => {
    const f = fixture();
    addSkill(f.agent.id, "big", "y".repeat(70_000));
    const host = boot(f.store);

    await expect(say(host, f.room, f.agent, "请 skill:big")).rejects.toThrow(/上下文预算/);
    // Only the first (small) request went out; the one carrying the 70k tool result never did.
    expect(f.api.calls).toHaveLength(1);
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toEqual([]);
  });

  test("an oversized recovered turn is dropped, and a failed turn leaves a valid bounded row", async () => {
    const f = fixture();
    f.store.insertMessage({
      roomId: f.room.id,
      runId: "old",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "我",
      content: "x".repeat(70_000),
      status: "done",
    });
    f.store.insertMessage({
      roomId: f.room.id,
      runId: "old",
      hop: 1,
      senderKind: "agent",
      senderId: f.agent.id,
      senderName: f.agent.name,
      content: "answer",
      status: "done",
    });
    const host = boot(f.store);
    await expect(say(host, f.room, f.agent, "z".repeat(CUSTOM_HISTORY_MAX_CHARS + 1))).rejects.toThrow(/上下文预算/);
    const turns = f.store.getCustomHistory(f.room.id, f.agent.id) ?? [];
    expect(historyChars(turns)).toBeLessThanOrEqual(CUSTOM_HISTORY_MAX_CHARS);
    expect(turns).toEqual([]); // the single 70k recovered turn could not be kept
  });

  test("recovery pairs only successful runs: a failed reply's task never becomes context", async () => {
    const f = fixture();
    const put = (kind: "human" | "agent", content: string, status: "done" | "error", runId: string) =>
      f.store.insertMessage({
        roomId: f.room.id,
        runId,
        hop: kind === "human" ? 0 : 1,
        senderKind: kind,
        senderId: kind === "agent" ? f.agent.id : null,
        senderName: kind === "human" ? "我" : f.agent.name,
        content,
        status,
      });
    put("human", "failed old task", "done", "bad");
    put("agent", "partial answer", "error", "bad");
    put("human", "successful old task", "done", "good");
    put("agent", "successful answer", "done", "good");

    const host = boot(f.store);
    await say(host, f.room, f.agent, "new task");
    expect(chatUsers(f.api.calls)).toEqual(["successful old task", "new task"]);
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)?.[0]).toEqual([
      { kind: "user", text: "successful old task" },
      { kind: "assistant", text: "successful answer", calls: [] },
    ]);
  });

  test("aborting on the final buffered text cancels the turn instead of committing it", async () => {
    const f = fixture();
    const host = boot(f.store);
    await say(host, f.room, f.agent, "previous successful");
    const before = f.store.getCustomHistory(f.room.id, f.agent.id);

    const ac = new AbortController();
    let outcome = "resolved";
    try {
      await host.prompt(
        f.room,
        f.agent,
        "",
        [{ type: "text" as const, text: "cancelled task" }],
        (u) => {
          if (u.sessionUpdate === "agent_message_chunk") ac.abort(new DOMException("用户取消", "AbortError"));
        },
        ac.signal,
      );
    } catch {
      outcome = "rejected";
    }
    expect(ac.signal.aborted).toBe(true);
    expect(outcome).toBe("rejected");
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toEqual(before);
  });

  test("a turn completing after its slot was released must not overwrite the cleared state", async () => {
    const f = fixture();
    const host = boot(f.store);
    await say(host, f.room, f.agent, "kept turn");

    let unblock!: () => void;
    f.api.knobs.blockNext = new Promise<void>((resolve) => (unblock = resolve));
    const late = say(host, f.room, f.agent, "late turn");
    await until(() => f.api.calls.length === 2);
    host.releaseRoom(f.room.id, f.agent.id); // reset lands while the turn is in flight
    unblock(); // the upstream reply arrives after the reset
    await expect(late).rejects.toThrow(/会话已重置|本任务/);
    expect(f.store.getCustomHistory(f.room.id, f.agent.id)).toEqual([]);
  });
});
