import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { AcpProcess, withTimeout } from "../server/acp";

// Real, unmodified npm CLI; all model responses come from a local Messages fixture, never a paid model.
// TUANTUAN_REAL_DEEPSEEK_CLI=/absolute/path/to/@deepseek-ai/dsh/lib/bin.js \
// TUANTUAN_REAL_DEEPSEEK_NODE=/absolute/path/to/node bun test tests/deepseek-real.test.ts
// The pinned 0.2.1-rc.2 distribution requires Node >=22.19, including its native filesystem addon.
const cli = process.env.TUANTUAN_REAL_DEEPSEEK_CLI;
const node = process.env.TUANTUAN_REAL_DEEPSEEK_NODE ?? Bun.which("node");
type Tool = { name: string; input: Record<string, unknown> };
type Reply = { text: string; thought?: string } | { tools: Tool[] } | { stall: true };
interface ModelRequest {
  model: string;
  thinking?: { type: string };
  output_config?: { effort: string };
  messages: { role: string; content: unknown }[];
  tools?: { name: string; input_schema: unknown }[];
}

function response(body: ModelRequest, reply: Exclude<Reply, { stall: true }>, id: number) {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let data = event("message_start", {
    message: {
      id: `fixture-${id}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const blocks = "tools" in reply ? reply.tools : [...(reply.thought ? [{ thought: reply.thought }] : []), reply];
  for (const [index, block] of blocks.entries()) {
    const tool = "name" in block;
    const thought = "thought" in block && !("text" in block);
    data += event("content_block_start", {
      index,
      content_block: tool
        ? { type: "tool_use", id: `fixture-tool-${id}-${index}`, name: block.name, input: {} }
        : thought
          ? { type: "thinking", thinking: "" }
          : { type: "text", text: "" },
    });
    data += event("content_block_delta", {
      index,
      delta: tool
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : thought
          ? { type: "thinking_delta", thinking: block.thought }
          : { type: "text_delta", text: "text" in block ? block.text : "" },
    });
    data += event("content_block_stop", { index });
  }
  data += event("message_delta", {
    delta: { stop_reason: "tools" in reply ? "tool_use" : "end_turn" },
    usage: { output_tokens: 1 },
  });
  return new Response(data + event("message_stop", {}), { headers: { "content-type": "text/event-stream" } });
}

function select(options: acp.SessionConfigOption[] | null | undefined, id: string) {
  const option = options?.find((option) => option.id === id);
  if (option?.type !== "select") throw new Error(`Missing select option: ${id}`);
  return option;
}

async function until(get: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!get()) {
    if (Date.now() >= deadline) throw new Error(label);
    await Bun.sleep(10);
  }
}

const timed = <T>(result: Promise<T>) => withTimeout(result, 20_000, "DeepSeek ACP request");

test.skipIf(!cli || process.platform === "win32")(
  "real DeepSeek CLI: messages, model/reasoning, tools, permission decisions, cancellation, persisted resume and MCP",
  async () => {
    if (!cli || !node) throw new Error("Set TUANTUAN_REAL_DEEPSEEK_CLI and install Node >=22.19");
    const installed = JSON.parse(readFileSync(join(dirname(cli), "..", "package.json"), "utf8"));
    expect(installed.name).toBe("@deepseek-ai/dsh");
    expect(installed.version).toBe("0.2.1-rc.2");
    const version = Bun.spawnSync([node, "--version"]);
    const [major = 0, minor = 0] = version.stdout.toString().trim().replace(/^v/, "").split(".").map(Number);
    expect(version.success && (major > 22 || (major === 22 && minor >= 19))).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "tt-deepseek-real-"));
    const home = join(root, "home");
    const cwd = join(root, "workspace");
    mkdirSync(home);
    mkdirSync(cwd);
    const updates: acp.SessionNotification[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    const hits: { path: string; key: string | null; body: ModelRequest }[] = [];
    const fixtureErrors: string[] = [];
    const replies: Reply[] = [];
    let permission: "allow_once" | "reject_once" = "reject_once";
    let cancelledStreams = 0;
    let running: AcpProcess | undefined;
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as ModelRequest;
        hits.push({ path, key: request.headers.get("x-api-key"), body });
        const reply = replies.shift();
        if (!reply || path !== "/anthropic/v1/messages") {
          fixtureErrors.push(`Unexpected request ${path}, reply remaining: ${replies.length}`);
          return Response.json(
            { error: { type: "invalid_request_error", message: "Unexpected fixture request" } },
            { status: 400 },
          );
        }
        if ("stall" in reply)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(": waiting for session/cancel\n\n"));
              },
              cancel() {
                cancelledStreams++;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        return response(body, reply, hits.length);
      },
    });
    const env = {
      HOME: home,
      DSH_HOME: join(home, ".dsh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      PATH: `${dirname(node)}:/usr/bin:/bin`,
      DSH_TELEMETRY_DISABLED: "1",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.port}/anthropic`,
      DEEPSEEK_API_KEY: "sk-local-deepseek-fixture",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    const launch = async () => {
      const command = [node, resolve(cli), "--profile", "acp"];
      if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
        command.unshift(
          "/usr/bin/sandbox-exec",
          "-p",
          '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))',
        );
      running = new AcpProcess(
        { command: command[0] as string, args: command.slice(1), cwd, env },
        {
          onUpdate: (update) => updates.push(update),
          async requestPermission(request) {
            permissions.push(request);
            const option = request.options.find((option) => option.kind === permission);
            if (!option) throw new Error(`Missing permission choice: ${permission}`);
            return { outcome: { outcome: "selected", optionId: option.optionId } };
          },
        },
      );
      const initialized = await running.initialize(20_000).catch((error) => {
        throw new Error(`${error}\n${running?.stderr}`);
      });
      expect(initialized.agentInfo?.name).toBe("deepseek-harness-acp");
      expect(initialized.agentCapabilities?.sessionCapabilities).toMatchObject({ list: {}, resume: {}, close: {} });
      expect(initialized.agentCapabilities?.loadSession).not.toBe(true);
      expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true);
      expect(initialized.authMethods).toEqual([]);
      return running;
    };
    const closeProcess = async () => {
      if (!running) return;
      (running.proc.stdin as import("bun").FileSink).end();
      expect(await withTimeout(running.exited, 10_000, "DeepSeek clean exit")).toBe(0);
      expect(running.stderr).toBe("");
      running = undefined;
    };
    try {
      let engine = await launch();
      const created = await withTimeout(
        engine.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
        20_000,
        "DeepSeek session/new",
      );
      const sessionId = created.sessionId;
      const models = select(created.configOptions, "model").options.flatMap((entry) =>
        "options" in entry ? entry.options : [entry],
      );
      const pro = models.find((entry) => entry.value.includes("deepseek-v4-pro"));
      const flash = models.find((entry) => entry.value.includes('"deepseek-flash"'));
      expect(pro).toBeDefined();
      expect(flash).toBeDefined();
      if (!pro || !flash) throw new Error("Missing official DeepSeek model choices");
      expect(
        select(created.configOptions, "reasoning_effort").options.map((entry) => "value" in entry && entry.value),
      ).toEqual(["off", "low", "high", "max"]);
      const set = (configId: string, value: string) =>
        withTimeout(
          engine.agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value }),
          10_000,
          configId,
        );
      const prompt = async (text: string, planned: Reply[]) => {
        expect(replies).toHaveLength(0);
        replies.push(...planned);
        const result = await withTimeout(
          engine.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }),
          20_000,
          `DeepSeek prompt: ${text}`,
        );
        expect(replies).toHaveLength(0);
        return result;
      };
      await set("model", pro.value);
      expect(select((await set("reasoning_effort", "low")).configOptions, "reasoning_effort").currentValue).toBe("low");
      await expect(set("reasoning_effort", "unsupported-fixture-effort")).rejects.toThrow();
      expect(
        await prompt("Remember fixture message one.", [{ text: "fixture message one", thought: "fixture thought" }]),
      ).toMatchObject({ stopReason: "end_turn" });
      expect(hits.at(-1)?.body).toMatchObject({
        model: "deepseek-v4-pro",
        thinking: { type: "enabled" },
        output_config: { effort: "low" },
      });
      expect(
        updates.some(
          ({ update }) =>
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text" &&
            update.content.text === "fixture message one",
        ),
      ).toBe(true);
      expect(
        updates.some(
          ({ update }) =>
            update.sessionUpdate === "agent_thought_chunk" &&
            update.content.type === "text" &&
            update.content.text === "fixture thought",
        ),
      ).toBe(true);

      await set("model", flash.value);
      await set("reasoning_effort", "off");
      writeFileSync(join(cwd, "input.txt"), "fixture file contents");
      await prompt("Read the local fixture.", [
        { tools: [{ name: "read", input: { file_path: join(cwd, "input.txt") } }] },
        { text: "file read" },
      ]);
      expect(hits.at(-1)?.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" } });
      expect(JSON.stringify(hits.at(-1)?.body.messages)).toContain("fixture file contents");
      for (const decision of ["reject_once", "allow_once"] as const) {
        permission = decision;
        const path = join(cwd, `${decision}.txt`);
        await prompt(`Exercise ${decision}.`, [
          {
            tools: [
              {
                name: "write",
                input: {
                  file_path: path,
                  content: "approved fixture write",
                  sandbox_permissions: "danger-full-access",
                  justification: "Exercise isolated fixture permission handling.",
                },
              },
            ],
          },
          { text: `${decision} handled` },
        ]);
        expect(existsSync(path)).toBe(decision === "allow_once");
        if (decision === "allow_once") expect(readFileSync(path, "utf8")).toBe("approved fixture write");
      }
      expect(permissions).toHaveLength(2);
      expect(updates.some(({ update }) => update.sessionUpdate === "tool_call")).toBe(true);
      expect(
        updates.some(({ update }) => update.sessionUpdate === "tool_call_update" && update.status === "completed"),
      ).toBe(true);

      const beforeCancel = hits.length;
      replies.push({ stall: true });
      const pending = engine.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "Cancel this fixture request." }],
      });
      await until(() => hits.length > beforeCancel, "DeepSeek model request before cancellation");
      await engine.agent.notify(methods.agent.session.cancel, { sessionId });
      expect(await withTimeout(pending, 10_000, "DeepSeek session/cancel")).toMatchObject({ stopReason: "cancelled" });
      await until(() => cancelledStreams > 0, "DeepSeek closes cancelled model stream");
      await set("model", pro.value);
      await set("reasoning_effort", "max");
      await prompt("Persist after cancellation.", [{ text: "persisted fixture answer" }]);
      await timed(engine.agent.request(methods.agent.session.close, { sessionId }));
      await closeProcess();

      engine = await launch();
      const listed = await timed(engine.agent.request(methods.agent.session.list, { cwd }));
      expect(listed.sessions.map((session) => session.sessionId)).toContain(sessionId);
      const beforeResume = updates.length;
      const restored = await timed(
        engine.agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] }),
      );
      expect(select(restored.configOptions, "model").currentValue).toBe(pro.value);
      expect(select(restored.configOptions, "reasoning_effort").currentValue).toBe("max");
      expect(updates.slice(beforeResume).some(({ update }) => update.sessionUpdate === "agent_message_chunk")).toBe(
        false,
      );
      await prompt("Continue the persisted session.", [{ text: "resumed fixture answer" }]);
      expect(JSON.stringify(hits.at(-1)?.body.messages)).toContain("fixture message one");
      expect(JSON.stringify(hits.at(-1)?.body.messages)).toContain("persisted fixture answer");
      await timed(engine.agent.request(methods.agent.session.close, { sessionId }));

      const marker = join(root, "mcp.json");
      const mcpSession = await withTimeout(
        engine.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [
            {
              name: "fixture",
              command: process.execPath,
              args: [join(import.meta.dir, "fixtures", "deepseek-mcp.ts"), marker],
              env: [{ name: "DEEPSEEK_MCP_TOKEN", value: "isolated-mcp-env" }],
            },
          ],
        }),
        20_000,
        "DeepSeek MCP session/new",
      );
      const mcp = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; cwd: string; token: string };
      expect(mcp.cwd).toBe(realpathSync(cwd));
      expect(mcp.token).toBe("isolated-mcp-env");
      replies.push({ text: "MCP catalog available" });
      await timed(
        engine.agent.request(methods.agent.session.prompt, {
          sessionId: mcpSession.sessionId,
          prompt: [{ type: "text", text: "Inspect the MCP catalog." }],
        }),
      );
      const mcpTool = hits.at(-1)?.body.tools?.find((tool) => tool.name.includes("fixture_echo"));
      expect(mcpTool).toBeDefined();
      if (!mcpTool) throw new Error("Missing discovered MCP tool");
      replies.push(
        { tools: [{ name: mcpTool.name, input: { text: "ACP bridge" } }] },
        { text: "MCP result delivered" },
      );
      await timed(
        engine.agent.request(methods.agent.session.prompt, {
          sessionId: mcpSession.sessionId,
          prompt: [{ type: "text", text: "Call the fixture MCP tool." }],
        }),
      );
      expect(JSON.stringify(hits.at(-1)?.body.messages)).toContain("MCP fixture: ACP bridge");
      await timed(engine.agent.request(methods.agent.session.close, { sessionId: mcpSession.sessionId }));
      await until(() => {
        try {
          process.kill(mcp.pid, 0);
          return false;
        } catch {
          return true;
        }
      }, "DeepSeek closes MCP child");
      await closeProcess();
      expect(fixtureErrors).toEqual([]);
      expect(replies).toHaveLength(0);
      expect(hits.every((hit) => hit.path === "/anthropic/v1/messages" && hit.key === env.DEEPSEEK_API_KEY)).toBe(true);
    } finally {
      try {
        if (running) {
          running.kill();
          await withTimeout(running.exited, 10_000, "DeepSeek fixture cleanup");
        }
      } finally {
        mock.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
