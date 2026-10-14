#!/usr/bin/env bun
/**
 * Deterministic ACP agent for tests, e2e and trying the UI without any account. Run over stdio:
 *   bun server/mock-agent.ts
 * It replies 「收到：「<text>」」 and exercises every client feature on request:
 *   /plan  — plan checklist        /edit — diff tool call behind a permission prompt, then writes mock-edit.txt
 *   /run   — terminal tool call    /slow — streams for ~6s (to test cancel)
 * Prompts mentioning [[handoff:Name task]] are echoed so group tests can see them.
 */
import * as acp from "@agentclientprotocol/sdk";

if (process.argv.includes("--version")) {
  console.log("mock-agent 1.0");
  process.exit(0);
}

interface Sess {
  cwd: string;
  history: acp.SessionUpdate[];
  config: Record<string, string>;
  abort: AbortController | null;
  title: string | null;
}
const sessions = new Map<string, Sess>();

const COMMANDS: acp.AvailableCommand[] = [
  { name: "plan", description: "演示计划清单" },
  { name: "edit", description: "演示改文件（需要授权）" },
  { name: "run", description: "演示运行命令" },
  { name: "slow", description: "慢速回复，用来测试取消" },
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

function newSess(cwd: string): [string, Sess] {
  const id = `mock-${crypto.randomUUID().slice(0, 8)}`;
  const s: Sess = { cwd, history: [], config: {}, abort: null, title: null };
  sessions.set(id, s);
  return [id, s];
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
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true },
      sessionCapabilities: { list: {}, resume: {} },
    },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    const [sessionId, s] = newSess(ctx.params.cwd);
    setTimeout(() => {
      void ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "available_commands_update", availableCommands: COMMANDS },
      });
    }, 0);
    return { sessionId, configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.list, () => ({
    sessions: [...sessions.entries()].map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title })),
  }))
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    for (const update of s.history)
      await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
    return { configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.resume, (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    return { configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    s.config[ctx.params.configId] = String(ctx.params.value);
    return { configOptions: configOptions(s) };
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    sessions.get(ctx.params.sessionId)?.abort?.abort();
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params;
    const s = sessions.get(sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(sessionId);
    const abort = new AbortController();
    s.abort = abort;
    const send = async (update: acp.SessionUpdate) => {
      s.history.push(update);
      await ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
    };
    const blocks = ctx.params.prompt;
    const fullText = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    // The identity doc arrives wrapped in <tuantuan-identity>; the user's words follow it.
    const text = fullText.replace(/<tuantuan-[a-z]+>[\s\S]*?<\/tuantuan-[a-z]+>\s*/g, "").trim();
    const images = blocks.filter((b) => b.type === "image").length;
    for (const b of blocks) s.history.push({ sessionUpdate: "user_message_chunk", content: b });
    s.title ??= text.slice(0, 30);
    const chunk = (t: string) => send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
    try {
      await send({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: `用户说「${text}」，我来处理。` },
      });
      await sleep(60, abort.signal);
      const cmd = text.match(/^\/(\w+)/)?.[1];
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
      const reply = `收到：「${text}」${images ? `，还有 ${images} 张图片` : ""}（${s.config.model ?? "mock-fast"}）`;
      for (const part of reply.match(/.{1,6}/gsu) ?? []) {
        await chunk(part);
        await sleep(15, abort.signal);
      }
      await send({
        sessionUpdate: "usage_update",
        used: 1200 + s.history.length * 10,
        size: 200_000,
        cost: { amount: 0.0012, currency: "USD" },
      });
      await send({ sessionUpdate: "session_info_update", title: s.title });
      return { stopReason: "end_turn" as const, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } };
    } catch (e) {
      if (abort.signal.aborted) return { stopReason: "cancelled" as const };
      throw e;
    } finally {
      s.abort = null;
    }
  })
  .connect(acp.ndJsonStream(input, output));
