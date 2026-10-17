import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { AcpProcess, withTimeout } from "../server/acp";
import { opencodeReasoningModel } from "../server/provider-opencode";
import { providerReasoningDefaults } from "../server/provider-reasoning";
import { prepareProviderRuntime } from "../server/provider-runtime";
import type { ProviderSecret } from "../server/providers";

// Optional real OpenCode binary; every model request goes to this test's loopback server.
// TUANTUAN_REAL_PROVIDER_RUNTIMES=1 TUANTUAN_TEST_OPENCODE=/path/to/opencode bun test tests/provider-opencode-reasoning-real.test.ts
const binary = process.env.TUANTUAN_TEST_OPENCODE || Bun.which("opencode");
const enabled = process.env.TUANTUAN_REAL_PROVIDER_RUNTIMES === "1" && !!binary;

type Body = Record<string, unknown> & { messages?: Record<string, unknown>[] };
const sse = (events: unknown[]) =>
  new Response(`${events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
  test.skipIf(!enabled)(
    `real OpenCode reasoning: ${api} defaults, ACP levels, off${api === "openai-completions" ? " and tool replay" : " request routing"}`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tt-opencode-thinking-"));
      const cwd = join(root, "cwd");
      const configDir = join(root, "config");
      mkdirSync(cwd);
      mkdirSync(configDir);
      writeFileSync(join(cwd, "fixture.txt"), "local tool fixture\n");
      const hits: { path: string; body: Body }[] = [];
      let toolTurn = false;
      let toolSent = false;
      const mock = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const body = (await request.json()) as Body;
          hits.push({ path, body });
          if (api !== "openai-completions") {
            // The request is the assertion target; no external model is contacted.
            return Response.json(
              { error: { type: "invalid_request_error", message: "fixture recorded request" } },
              { status: 400 },
            );
          }
          const common = { id: "fixture-response", object: "chat.completion.chunk", model: body.model, created: 0 };
          const chunk = (delta: unknown, finish_reason: string | null = null) => ({
            ...common,
            choices: [{ index: 0, delta, finish_reason }],
          });
          const off = (body.thinking as { type?: string } | undefined)?.type === "disabled";
          const reasoning = off ? [] : [chunk({ reasoning_content: "fixture reasoning" })];
          if (toolTurn && body.model === "deepseek-v4-pro" && !toolSent) {
            toolSent = true;
            return sse([
              ...reasoning,
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "fixture-read",
                    type: "function",
                    function: { name: "read", arguments: JSON.stringify({ filePath: join(cwd, "fixture.txt") }) },
                  },
                ],
              }),
              chunk({}, "tool_calls"),
            ]);
          }
          return sse([...reasoning, chunk({ content: "fixture final answer" }), chunk({}, "stop")]);
        },
      });
      const provider: ProviderSecret = {
        id: "reasoning-fixture",
        name: "Local reasoning fixture",
        preset: "deepseek",
        openaiBaseUrl: api === "anthropic-messages" ? "" : `http://127.0.0.1:${mock.port}/v1`,
        anthropicBaseUrl: api === "anthropic-messages" ? `http://127.0.0.1:${mock.port}` : "",
        wireApi: api === "openai-responses" ? "responses" : "chat",
        apiKey: "fixture-only-key",
        mgmtKey: "",
        model: "deepseek-v4-pro",
        smallModel: "deepseek-flash",
        createdAt: 0,
        updatedAt: 0,
      };
      const env: Record<string, string> = {
        PATH: process.env.PATH || "",
        XDG_CONFIG_HOME: configDir,
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      };
      const version = await new Response(
        Bun.spawn([binary as string, "--version"], { env, stdout: "pipe" }).stdout,
      ).text();
      const v2 = /(?:^|\s)v?2\./.test(version);
      const runtime = await prepareProviderRuntime(provider, "opencode", env, version);
      // The helper can be verified independently while runtime integration is edited elsewhere.
      const config = JSON.parse(runtime.env.OPENCODE_CONFIG_CONTENT || "{}");
      const definition = (v2 ? config.providers : config.provider).tuantuan;
      for (const model of [provider.model, provider.smallModel])
        Object.assign(definition.models[model], opencodeReasoningModel(provider, model, api, v2));
      const replies: string[] = [];
      const thought: string[] = [];
      const engine = new AcpProcess(
        {
          command: binary as string,
          args: ["acp"],
          env: { ...runtime.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
          cwd,
        },
        {
          onUpdate: ({ update }) => {
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
              replies.push(update.content.text);
            if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text")
              thought.push(update.content.text);
          },
          requestPermission: async (request) => {
            const allow = request.options.find((option) => option.kind === "allow_once");
            return allow
              ? { outcome: { outcome: "selected", optionId: allow.optionId } }
              : { outcome: { outcome: "cancelled" } };
          },
        },
      );
      let options: SessionConfigOption[] = [];
      const selections: { value: string; currentValue: string | boolean | undefined }[] = [];
      try {
        await engine.initialize(20_000);
        const session = await withTimeout(
          engine.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
          20_000,
          "reasoning session/new",
        );
        options = session.configOptions ?? [];
        const effort = options.find((option) => option.id === "effort");
        expect(effort?.type, engine.stderr).toBe("select");
        if (effort?.type !== "select") throw new Error("OpenCode did not expose effort");
        const values = effort.options
          .flatMap((option) => ("options" in option ? option.options : [option]))
          .map((option) => option.value);
        for (const value of ["high", "none", "low", "max"]) expect(values).toContain(value);
        expect(values).not.toContain("medium");
        const prompt = async () => {
          replies.length = 0;
          thought.length = 0;
          await withTimeout(
            engine.agent.request(methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "Reply using the local fixture. Only read the fixture if requested." }],
            }),
            20_000,
            "local reasoning prompt",
          ).catch((error) => {
            if (api === "openai-completions") throw new Error(`${error}\n${engine.stderr}`);
          });
        };
        const assertWire = (effort: string) => {
          const body = hits.filter((hit) => hit.body.model === provider.model).at(-1)?.body;
          expect(body, engine.stderr).toBeDefined();
          expect(body?.model).toBe(provider.model);
          if (api === "openai-completions") {
            expect(body?.reasoning_effort).toBe(effort);
            expect(body?.thinking).toEqual({ type: effort === "none" ? "disabled" : "enabled" });
          } else if (api === "openai-responses") {
            expect(body?.reasoning).toMatchObject({ effort });
          } else {
            expect(body?.thinking).toMatchObject({ type: effort === "none" ? "disabled" : "adaptive" });
            expect(body?.output_config).toMatchObject({ effort: effort === "none" ? "high" : effort });
          }
        };
        // HarnessHost applies this real selection only for fresh sessions; OpenCode's
        // own first-variant fallback otherwise wins over model-level options in V1.
        const defaults = providerReasoningDefaults(provider, "opencode", options);
        expect(defaults[effort.id]).toBe("high");
        const select = async (configId: string, value: string) => {
          const result = await engine.agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId,
            value,
          });
          const currentValue = result.configOptions.find((option) => option.id === configId)?.currentValue;
          expect(currentValue).toBe(value);
          selections.push({ value, currentValue });
        };
        for (const [configId, value] of Object.entries(defaults)) await select(configId, value);
        await prompt();
        assertWire("high");
        for (const value of ["none", "low", "max", "default", "high"]) {
          await select(effort.id, value);
          await prompt();
          assertWire(value === "default" ? "high" : value);
          if (api === "openai-completions") {
            expect(replies.join("")).toContain("fixture final answer");
            expect(thought.join("").includes("fixture reasoning")).toBe(value !== "none");
          }
        }
        if (api === "openai-completions") {
          toolTurn = true;
          await prompt();
          expect(toolSent).toBe(true);
          const replay = hits.filter((hit) => hit.body.model === provider.model).at(-1)?.body.messages ?? [];
          const assistant = replay.find(
            (message) =>
              Array.isArray(message.tool_calls) &&
              message.tool_calls.some((call: { id: string }) => call.id === "fixture-read"),
          );
          expect(assistant).toMatchObject({ role: "assistant", reasoning_content: "fixture reasoning" });
          expect(replay.some((message) => message.role === "tool" && message.tool_call_id === "fixture-read")).toBe(
            true,
          );
          // Even previous assistant turns without tools must keep their reasoning in tool-enabled requests.
          expect(
            replay.filter((message) => message.role === "assistant").every((message) => "reasoning_content" in message),
          ).toBe(true);
        }
      } finally {
        const evidence = process.env?.TUANTUAN_TEST_REASONING_EVIDENCE;
        if (evidence)
          writeFileSync(
            `${evidence}-${v2 ? "v2" : "v1"}-${api}.json`,
            JSON.stringify({ version, options, selections, hits, stderr: engine.stderr }, null, 2),
          );
        engine.kill();
        await withTimeout(engine.exited, 5_000, "reasoning fixture exit");
        runtime.cleanup();
        mock.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
}
