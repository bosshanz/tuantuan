#!/usr/bin/env bun
/**
 * Deterministic ACP agent for tests, e2e and trying the UI without any account. Run over stdio:
 *   bun server/mock-agent.ts
 * It replies 「收到：「<text>」」 and exercises every client feature on request:
 *   /plan  — plan checklist        /edit — diff tool call behind a permission prompt, then writes mock-edit.txt
 *   /run   — terminal tool call    /slow — streams for ~6s (to test cancel)
 *   /ask   — form elicitation      /ask_unknown — elicitation with a future field type
 * Tuantuan MCP tools (group rooms), called through whatever server session/new passed in:
 *   /handoff Name task   /handoff_context {agent,task,context}   /context {goal,decisions,pending}
 *   /members   /coordinate NameA NameB
 * An identity doc containing [[handoff:Name task]] makes it hand off on every turn (loop tests).
 * Env: MOCK_AGENT_MCP_HTTP=1 advertises HTTP MCP support (default: stdio only, the ACP baseline);
 *      MOCK_AGENT_AUTH_FILE=path requires `authenticate` (method mock-login) before session/new works.
 *      MOCK_AGENT_SESSION_DIR=path opts tests into session persistence across isolated processes.
 *      MOCK_AGENT_SESSION_ERROR=text returns that diagnostic from session/new (test-only).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

if (process.argv.includes("--version")) {
  console.log("mock-agent 1.0");
  process.exit(0);
}

interface Sess {
  cwd: string;
  mcpServers: acp.McpServer[];
  mcp: Map<string, McpClient>;
  identity: string;
  /** Session-cumulative cost, reported on usage_update like Claude Code / OpenCode. */
  cost?: number;
  history: acp.SessionUpdate[];
  config: Record<string, string>;
  abort: AbortController | null;
  title: string | null;
}
const sessions = new Map<string, Sess>();
const sessionDir = process.env.MOCK_AGENT_SESSION_DIR;
let loads = 0;

function storedSession(id: string): Sess | undefined {
  if (!sessionDir || !/^mock-[\da-f]{8}$/.test(id)) return;
  const file = join(sessionDir, `${id}.json`);
  if (!existsSync(file)) return;
  const saved = JSON.parse(readFileSync(file, "utf8"));
  return { ...saved, mcpServers: [], mcp: new Map(), abort: null };
}

function saveSession(id: string, s: Sess) {
  if (!sessionDir) return;
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `${id}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  const { cwd, identity, cost, history, config, title } = s;
  writeFileSync(temporary, JSON.stringify({ cwd, identity, cost, history, config, title }));
  renameSync(temporary, file);
}

function restoredSession(id: string): Sess | undefined {
  const saved = storedSession(id);
  if (saved) sessions.set(id, saved);
  return saved ?? sessions.get(id);
}

const COMMANDS: acp.AvailableCommand[] = [
  { name: "plan", description: "演示计划清单" },
  { name: "edit", description: "演示改文件（需要授权）" },
  { name: "run", description: "演示运行命令" },
  { name: "slow", description: "慢速回复，用来测试取消" },
  { name: "ask", description: "演示提问卡片" },
  { name: "ask_unknown", description: "演示不支持的问题类型" },
  { name: "context", description: "演示保存任务笔记（群聊）" },
];

function configOptions(s: Sess): acp.SessionConfigOption[] {
  return [
    {
      id: "mode",
      name: "模式",
      category: "mode",
      type: "select",
      currentValue: s.config.mode ?? "ask",
      options: [
        { value: "ask", name: "询问", description: "改动前征求同意" },
        { value: "auto", name: "自动", description: "直接执行" },
        { value: "bypassPermissions", name: "Bypass permissions", description: "Accepts all permissions" },
      ],
    },
    {
      id: "model",
      name: "模型",
      category: "model",
      type: "select",
      currentValue: s.config.model ?? "mock-fast",
      options: [
        { value: "mock-fast", name: "Mock Fast" },
        { value: "mock-smart", name: "Mock Smart" },
        // Simulates an upstream that never answers and ignores session/cancel.
        { value: "mock-stuck", name: "Mock Stuck" },
        // The harness rejects switching to this one.
        { value: "mock-broken", name: "Mock Broken" },
        // Real-looking ids from each vendor (the mock answers them all) so the logos can be checked.
        ...[
          ["claude-sonnet-4-5", "Claude Sonnet 4.5"],
          ["gpt-5.5", "GPT-5.5"],
          ["gemini-2.5-pro", "Gemini 2.5 Pro"],
          ["grok-code-fast-1", "Grok Code Fast"],
          ["glm-4.6", "GLM-4.6"],
          ["moonshotai/kimi-k2", "Kimi K2"],
          ["qwen3-coder-plus", "Qwen3 Coder"],
          ["deepseek-chat", "DeepSeek V3"],
          ["MiniMax-M2", "MiniMax M2"],
          ["doubao-seed-1.6", "豆包 Seed 1.6"],
          ["mistralai/devstral-medium", "Devstral Medium"],
          ["meta-llama/llama-4-maverick", "Llama 4 Maverick"],
        ].map(([value, name]) => ({ value: value as string, name: name as string })),
      ],
    },
    {
      id: "effort",
      name: "推理强度",
      category: "thought_level",
      type: "select",
      currentValue: s.config.effort ?? "medium",
      options: [
        { value: "low", name: "低" },
        { value: "medium", name: "中" },
        { value: "high", name: "高" },
      ],
    },
  ];
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("cancelled"));
    });
  });

function newSess(cwd: string, mcpServers: acp.McpServer[]): [string, Sess] {
  const id = `mock-${crypto.randomUUID().slice(0, 8)}`;
  const s: Sess = { cwd, mcpServers, mcp: new Map(), identity: "", history: [], config: {}, abort: null, title: null };
  sessions.set(id, s);
  saveSession(id, s);
  return [id, s];
}

/** Minimal MCP client: stdio (newline-delimited JSON-RPC) or Streamable HTTP with JSON responses. */
interface McpClient {
  call(method: string, params: unknown): Promise<unknown>;
}

function mcpClient(server: acp.McpServer): McpClient {
  let nextId = 1;
  if ("type" in server && (server.type === "http" || server.type === "sse")) {
    const post = async (body: unknown) => {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      });
      return res.status === 202 ? null : ((await res.json()) as { result?: unknown; error?: { message: string } });
    };
    let ready: Promise<unknown> | null = null;
    return {
      async call(method, params) {
        ready ??= post({
          jsonrpc: "2.0",
          id: nextId++,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock-agent", version: "1" } },
        }).then(() => post({ jsonrpc: "2.0", method: "notifications/initialized" }));
        await ready;
        const r = await post({ jsonrpc: "2.0", id: nextId++, method, params });
        if (r?.error) throw new Error(r.error.message);
        return r?.result;
      },
    };
  }
  const stdio = server as acp.McpServerStdio;
  const proc = Bun.spawn([stdio.command, ...stdio.args], {
    env: { ...process.env, ...Object.fromEntries(stdio.env.map((e) => [e.name, e.value])) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  void (async () => {
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += new TextDecoder().decode(chunk);
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } };
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  })();
  const send = (m: unknown) => {
    (proc.stdin as import("bun").FileSink).write(`${JSON.stringify(m)}\n`);
    (proc.stdin as import("bun").FileSink).flush();
  };
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((res, rej) => {
      const id = nextId++;
      pending.set(id, (r) => (r.error ? rej(new Error(r.error.message)) : res(r.result)));
      send({ jsonrpc: "2.0", id, method, params });
    });
  const ready = request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mock-agent", version: "1" },
  }).then(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return {
    async call(method, params) {
      await ready;
      return request(method, params);
    },
  };
}

/** Calls a tool on the session's "tuantuan" MCP server; returns [ok, text]. */
async function callTool(s: Sess, name: string, args: Record<string, unknown>): Promise<[boolean, string]> {
  const server = s.mcpServers.find((m) => m.name === "tuantuan");
  if (!server) return [false, "没有 tuantuan MCP 服务"];
  let c = s.mcp.get(server.name);
  if (!c) {
    c = mcpClient(server);
    s.mcp.set(server.name, c);
  }
  try {
    const r = (await c.call("tools/call", { name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    return [!r.isError, r.content.map((x) => x.text).join("")];
  } catch (e) {
    return [false, (e as Error).message];
  }
}

const authFile = process.env.MOCK_AGENT_AUTH_FILE;
const needsAuth = () => !!authFile && !existsSync(authFile);
// MOCK_AGENT_KEY_VAR=NAME: like glm-acp-agent — an API-key (env_var) login plus a terminal
// `--setup`; sessions open without it, prompts fail with "No API key found".
const keyVar = process.env.MOCK_AGENT_KEY_VAR;
if (keyVar && process.argv.includes("--setup")) {
  console.log("mock setup: 在这里输入 Key（测试）");
  process.exit(0);
}

const input = new WritableStream<Uint8Array>({
  write(chunk) {
    process.stdout.write(chunk);
  },
});
const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (d: Buffer) => controller.enqueue(new Uint8Array(d)));
    process.stdin.on("end", () => controller.close());
  },
});

acp
  .agent({ name: "mock-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "mock-agent", title: "Mock", version: "1.0" },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: process.env.MOCK_AGENT_IMAGE !== "0", embeddedContext: true },
      mcpCapabilities: { http: process.env.MOCK_AGENT_MCP_HTTP === "1" },
      sessionCapabilities: { list: {}, resume: {} },
    },
    authMethods: keyVar
      ? ([
          { id: "mock-key", name: "Mock API Key", type: "env_var", vars: [{ name: keyVar }] },
          { id: "mock-setup", name: "Mock 设置", type: "terminal", args: ["--setup"] },
        ] as unknown as acp.AuthMethod[])
      : authFile
        ? [{ id: "mock-login", name: "Mock 登录", description: "立即登录（测试用）" }]
        : [],
  }))
  .onRequest(acp.methods.agent.authenticate, async (ctx) => {
    if (ctx.params.methodId !== "mock-login") throw acp.RequestError.invalidParams(ctx.params.methodId);
    if (authFile) await Bun.write(authFile, "ok");
    return {};
  })
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    if (process.env.MOCK_AGENT_SESSION_DELAY_MS) await Bun.sleep(Number(process.env.MOCK_AGENT_SESSION_DELAY_MS));
    if (process.env.MOCK_AGENT_SESSION_ERROR)
      throw acp.RequestError.internalError(undefined, process.env.MOCK_AGENT_SESSION_ERROR);
    if (needsAuth()) throw acp.RequestError.authRequired();
    const [sessionId, s] = newSess(ctx.params.cwd, ctx.params.mcpServers);
    setTimeout(() => {
      void ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "available_commands_update", availableCommands: COMMANDS },
      });
    }, Number(process.env.MOCK_AGENT_COMMAND_DELAY_MS) || 0);
    return { sessionId, configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.list, () => {
    const known = new Map(sessions);
    if (sessionDir && existsSync(sessionDir))
      for (const file of readdirSync(sessionDir)) {
        const id = file.replace(/\.json$/, "");
        const saved = storedSession(id);
        if (saved && !known.has(id)) known.set(id, saved);
      }
    return { sessions: [...known.entries()].map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title })) };
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    const failureGate = process.env.MOCK_AGENT_FIRST_LOAD_FAILURE_GATE;
    if (++loads === 1 && failureGate) {
      await Bun.write(`${failureGate}.waiting`, "ready");
      while (!existsSync(failureGate)) await Bun.sleep(10);
      throw new Error("mock delayed load failure");
    }
    const s = restoredSession(ctx.params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    s.mcpServers = ctx.params.mcpServers;
    s.mcp.clear();
    for (const update of s.history)
      await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
    return { configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.resume, (ctx) => {
    const s = restoredSession(ctx.params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    s.mcpServers = ctx.params.mcpServers ?? [];
    s.mcp.clear();
    return { configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    if (ctx.params.value === "mock-broken") throw new acp.RequestError(-32602, "Invalid model: mock-broken");
    s.config[ctx.params.configId] = String(ctx.params.value);
    saveSession(ctx.params.sessionId, s);
    return { configOptions: configOptions(s) };
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    if (process.env.MOCK_AGENT_IGNORE_CANCEL !== "1") sessions.get(ctx.params.sessionId)?.abort?.abort();
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    if (keyVar && !process.env[keyVar]) {
      console.error(
        `[error] No API key found. Set the ${keyVar} environment variable, or run mock-acp --setup to store one.`,
      );
      throw acp.RequestError.internalError(undefined, `No API key found. Set the ${keyVar} environment variable.`);
    }
    const { sessionId } = ctx.params;
    const s = sessions.get(sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(sessionId);
    if (s.config.model === "mock-stuck") return await new Promise<never>(() => {});
    const abort = new AbortController();
    s.abort = abort;
    const send = async (update: acp.SessionUpdate) => {
      s.history.push(update);
      await ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
    };
    const blocks = ctx.params.prompt;
    const fullText = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    // The identity doc arrives wrapped in <tuantuan-identity>; the user's words follow it.
    const identity = fullText.match(/<tuantuan-identity>([\s\S]*?)<\/tuantuan-identity>/)?.[1];
    if (identity) s.identity = identity;
    const coordination = [
      ...fullText.matchAll(/<tuantuan-coordination\b([^>]*)>([\s\S]*?)<\/tuantuan-coordination>/g),
    ].at(-1);
    const reviewing = /\bphase="review"/.test(coordination?.[1] ?? "");
    const handoffTask = fullText.match(/<tuantuan-handoff from="([^"]*)">\n?([\s\S]*?)\n?<\/tuantuan-handoff>/);
    const text = fullText
      .replace(/<tuantuan-identity>[\s\S]*?<\/tuantuan-identity>\s*/g, "")
      .replace(/<tuantuan-skills>[\s\S]*?<\/tuantuan-skills>\s*/g, "")
      .replace(/<tuantuan-coordination\b[^>]*>[\s\S]*?<\/tuantuan-coordination>\s*/g, "")
      .replace(/<tuantuan-response>[\s\S]*?<\/tuantuan-response>\s*/g, "")
      .trim();
    // A queued group turn carries its own request, even after newer messages have arrived.
    const taskBlock = text.match(/<tuantuan-task>\n([\s\S]*?)\n<\/tuantuan-task>/)?.[1];
    const taskText = taskBlock?.match(/(?:^|\n)\[[^\]\n]+\]: ([\s\S]*)$/)?.[1];
    const latest = handoffTask
      ? ""
      : (taskText ?? (text.split(/\n\n/).at(-1) ?? "").replace(/^\[[^\]]+\]: /, "")).trim();
    const images = blocks.filter((b) => b.type === "image").length;
    for (const b of blocks) s.history.push({ sessionUpdate: "user_message_chunk", content: b });
    s.title ??= text.slice(0, 30);
    const chunk = (t: string) => send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
    try {
      let summary: string | null = null;
      if (reviewing) {
        // Test hook: hold the leader's review turn open until the e2e has observed the "following up" state.
        const reviewGate = process.env.MOCK_AGENT_REVIEW_GATE;
        if (reviewGate) {
          await Bun.write(`${reviewGate}.waiting`, "ready");
          while (!existsSync(reviewGate)) await sleep(10, abort.signal);
        }
        const resultsText = coordination?.[2]?.match(/<tuantuan-results>\s*([\s\S]*?)\s*<\/tuantuan-results>/)?.[1];
        if (!resultsText) throw new Error("mock coordination review is missing member results");
        const results = JSON.parse(resultsText) as {
          agentName: string;
          status: string;
          content: string;
          error: string | null;
        }[];
        summary = `群主汇总：\n${results
          .map((result) => `${result.agentName} [${result.status}]：${result.content || result.error || "（无输出）"}`)
          .join("\n")}`;
      }
      await send({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: `用户说「${text}」，我来处理。` },
      });
      await sleep(60, abort.signal);
      const cmd = reviewing ? undefined : latest.match(/^\/(\w+)/)?.[1];
      const arg = latest.replace(/^\/\w+\s*/, "");
      let n = 0;
      const tool = async (name: string, args: Record<string, unknown>) => {
        const toolCallId = `mcp-${++n}`;
        await send({
          sessionUpdate: "tool_call",
          toolCallId,
          title: `tuantuan/${name}`,
          kind: "other",
          status: "in_progress",
          rawInput: args,
        });
        const [ok, out] = await callTool(s, name, args);
        await send({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: ok ? "completed" : "failed",
          content: [{ type: "content", content: { type: "text", text: out } }],
        });
        return [ok, out] as const;
      };
      const loop = reviewing ? null : s.identity.match(/\[\[handoff:(\S+) ([^\]]+)\]\]/);
      if (loop) {
        await tool("handoff", { agent: loop[1], task: loop[2] });
      } else if (cmd === "handoff") {
        const [, who = "", task = ""] = arg.match(/^@?(\S+)\s*([\s\S]*)$/) ?? [];
        await tool("handoff", { agent: who, task: task || "请接手" });
      } else if (cmd === "handoff_context") {
        const args = JSON.parse(arg) as { agent: string; task: string; context: Record<string, unknown> };
        const [saved, saveError] = await tool("save_context", args.context);
        if (!saved) throw new Error(saveError);
        const [accepted, handoffError] = await tool("handoff", args);
        if (!accepted) throw new Error(handoffError);
      } else if (cmd === "context") {
        const args = JSON.parse(arg) as Record<string, unknown>;
        const [saved, saveError] = await tool("save_context", args);
        if (!saved) throw new Error(saveError);
        await chunk("任务笔记已保存。");
      } else if (cmd === "ask" || cmd === "ask_unknown") {
        const form = await ctx.client.request(acp.methods.client.elicitation.create, {
          sessionId,
          message: cmd === "ask" ? "请确认本次发布的方式" : "这个字段来自更新版本的协议",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties:
              cmd === "ask"
                ? {
                    target: { type: "string", title: "发布范围", enum: ["all", "canary"] },
                    channel: {
                      type: "string",
                      title: "发布频道",
                      oneOf: [
                        { const: "stable", title: "稳定版", description: "面向所有用户" },
                        { const: "beta", title: "测试版" },
                      ],
                    },
                    note: { type: "string", title: "补充说明", minLength: 2, maxLength: 20, pattern: "确认" },
                    batches: { type: "integer", title: "批次数量", minimum: 1, maximum: 5, default: 2 },
                    ratio: { type: "number", title: "灰度比例", minimum: 0, maximum: 1 },
                    confirm: { type: "boolean", title: "确认发布", default: true },
                    tags: {
                      type: "array",
                      title: "标签",
                      minItems: 1,
                      maxItems: 2,
                      items: { type: "string", enum: ["移动端", "桌面端", "服务端"] },
                    },
                    when: {
                      type: "string",
                      title: "执行时间",
                      format: "date-time",
                      default: "2026-10-17T10:00:00+08:00",
                    },
                  }
                : { future: { type: "mystery", title: "未来字段" } },
            required: cmd === "ask" ? ["target", "note"] : [],
          },
        });
        const answer = form.action === "accept" ? ` ${JSON.stringify(form.content ?? {})}` : "";
        await chunk(`提问结果：${form.action}${answer}`);
      } else if (cmd === "members") {
        const [, out] = await tool("list_members", {});
        await chunk(`成员：${out.replaceAll("\n", "；")}。`);
      } else if (cmd === "coordinate") {
        const names = arg
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((name) => name.replace(/^@/, ""));
        if (names.length !== 2) throw new Error("/coordinate needs two member names");
        for (const name of names) await tool("handoff", { agent: name, task: `${name} 的协作任务` });
      } else if (cmd === "env") {
        const key = arg.trim() || "ANTHROPIC_BASE_URL";
        await chunk(`${key}=${process.env[key] ?? ""}`);
      }
      if (cmd === "plan") {
        const steps = ["读需求", "写代码", "跑测试"];
        for (let done = 0; done <= steps.length; done++) {
          await send({
            sessionUpdate: "plan",
            entries: steps.map((content, i) => ({
              content,
              priority: "medium" as const,
              status: i < done ? ("completed" as const) : i === done ? ("in_progress" as const) : ("pending" as const),
            })),
          });
          await sleep(80, abort.signal);
        }
      } else if (cmd === "edit") {
        const toolCallId = "edit-1";
        const path = `${s.cwd}/mock-edit.txt`;
        const diff: acp.ToolCallContent = { type: "diff", path, oldText: "hello\n", newText: "hello\ntuantuan\n" };
        await send({
          sessionUpdate: "tool_call",
          toolCallId,
          title: "编辑 mock-edit.txt",
          kind: "edit",
          status: "pending",
          content: [diff],
          locations: [{ path }],
        });
        const res = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId, title: "编辑 mock-edit.txt", kind: "edit", content: [diff] },
          options: [
            { optionId: "allow", name: "允许", kind: "allow_once" },
            { optionId: "always", name: "总是允许", kind: "allow_always" },
            { optionId: "reject", name: "拒绝", kind: "reject_once" },
          ],
        });
        const ok = res.outcome.outcome === "selected" && res.outcome.optionId !== "reject";
        if (ok)
          await ctx.client.request(acp.methods.client.fs.writeTextFile, { sessionId, path, content: diff.newText });
        await send({ sessionUpdate: "tool_call_update", toolCallId, status: ok ? "completed" : "failed" });
        await chunk(ok ? "已修改 mock-edit.txt。" : "好的，没有修改。");
      } else if (cmd === "run") {
        const toolCallId = "run-1";
        const { terminalId } = await ctx.client.request(acp.methods.client.terminal.create, {
          sessionId,
          command: "echo",
          args: ["hello from terminal"],
        });
        await send({
          sessionUpdate: "tool_call",
          toolCallId,
          title: "echo hello from terminal",
          kind: "execute",
          status: "in_progress",
          content: [{ type: "terminal", terminalId }],
        });
        const exit = await ctx.client.request(acp.methods.client.terminal.waitForExit, { sessionId, terminalId });
        await send({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: exit.exitCode === 0 ? "completed" : "failed",
        });
        await ctx.client.request(acp.methods.client.terminal.release, { sessionId, terminalId });
        await chunk("命令跑完了。");
      } else if (cmd === "slow") {
        for (let i = 0; i < 60; i++) {
          await chunk(`${i} `);
          await sleep(100, abort.signal);
        }
      }
      const what = handoffTask ? `接手 @${handoffTask[1]} 的任务「${handoffTask[2]}」` : `收到：「${latest || text}」`;
      const reply = summary ?? `${what}${images ? `，还有 ${images} 张图片` : ""}（${s.config.model ?? "mock-fast"}）`;
      const size = reply.length > 200 ? 400 : 6;
      for (const part of reply.match(new RegExp(`.{1,${size}}`, "gsu")) ?? []) {
        await chunk(part);
        await sleep(15, abort.signal);
      }
      // Deterministic per-turn usage (so dashboards / e2e have data): bigger model, more tokens.
      const model = s.config.model ?? "mock-fast";
      const k = model === "mock-smart" ? 3 : 1;
      const turnUsage = {
        inputTokens: 800 * k + text.length * 4,
        outputTokens: 150 * k + reply.length * 2,
        cachedReadTokens: 400 * k,
        cachedWriteTokens: 100 * k,
        thoughtTokens: 50 * k,
        totalTokens: 0,
      };
      turnUsage.totalTokens =
        turnUsage.inputTokens + turnUsage.outputTokens + turnUsage.cachedReadTokens + turnUsage.cachedWriteTokens;
      s.cost = Math.round(((s.cost ?? 0) + 0.0012 * k) * 1e6) / 1e6;
      await send({
        sessionUpdate: "usage_update",
        used: 1200 + s.history.length * 10,
        size: 200_000,
        cost: { amount: s.cost, currency: "USD" },
      });
      await send({ sessionUpdate: "session_info_update", title: s.title });
      return {
        stopReason: "end_turn" as const,
        usage: turnUsage,
        _meta: { quota: { token_count: turnUsage, model_usage: [{ model, token_count: turnUsage }] } },
      };
    } catch (e) {
      if (abort.signal.aborted) return { stopReason: "cancelled" as const };
      throw e;
    } finally {
      s.abort = null;
      saveSession(sessionId, s);
    }
  })
  .connect(acp.ndJsonStream(input, output));
