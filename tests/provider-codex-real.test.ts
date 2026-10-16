import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { AcpProcess, withTimeout } from "../server/acp";
import { killProcessTree, processGroupOptions } from "../server/process-tree";
import { prepareCodexProviderRuntime } from "../server/provider-codex";
import type { ProviderSecret } from "../server/providers";
import { codexProviderSet } from "../server/providers";

// Uses the pinned real CLI/adapter, a disposable home and a local HTTP fixture.
// TUANTUAN_REAL_CODEX_PROVIDER=1 bun test tests/provider-codex-real.test.ts
const enabled = process.env.TUANTUAN_REAL_CODEX_PROVIDER === "1";
const sandbox = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

function command(args: string[], local = false) {
  if (!sandbox) return args;
  const policy = `(version 1) (allow default) (deny network*)${
    local ? ' (allow network-outbound (remote ip "localhost:*"))' : ""
  }`;
  return ["/usr/bin/sandbox-exec", "-p", policy, ...args];
}

for (const fixture of [
  {
    preset: "deepseek",
    model: "deepseek-v4-pro",
    smallModel: "deepseek-flash",
    efforts: ["none", "low", "high", "max"],
  },
  {
    preset: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    smallModel: "",
    efforts: ["none", "low", "medium", "high", "max"],
  },
])
  test.skipIf(!enabled || process.platform === "win32")(
    `real Codex ${fixture.preset} catalog, reasoning controls, explicit resume selection and native instruction overrides`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tt-codex-provider-real-"));
      const home = join(root, "home");
      const codexHome = join(home, ".codex");
      const cwd = join(root, "cwd");
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(cwd);
      const configPath = join(codexHome, "config.toml");
      const authPath = join(codexHome, "auth.json");
      const config = 'model = "native-unrelated-model"\n';
      writeFileSync(configPath, config);
      writeFileSync(authPath, "{}");
      const hits: { model?: string; reasoning?: { effort?: string }; path: string }[] = [];
      const messages: { instructions?: string; input?: unknown[] }[] = [];
      let responseId = 0;
      const mock = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (request.method === "GET") return Response.json({ object: "list", data: [] });
          const body = (await request.json()) as {
            model?: string;
            reasoning?: { effort?: string };
            instructions?: string;
            input?: unknown[];
          };
          hits.push({ model: body.model, reasoning: body.reasoning, path });
          messages.push({ instructions: body.instructions, input: body.input });
          if (!path.endsWith("/responses")) return new Response("Not found", { status: 404 });
          const id = `fixture-response-${++responseId}`;
          const item = {
            id: `${id}-message`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "local fixture reply", annotations: [] }],
          };
          const response = {
            id,
            object: "response",
            created_at: 1,
            status: "completed",
            model: body.model,
            output: [item],
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              total_tokens: 3,
              output_tokens_details: { reasoning_tokens: 0 },
            },
          };
          const events = [
            ["response.created", { response: { ...response, status: "in_progress", output: [] } }],
            ["response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
            [
              "response.output_text.delta",
              { item_id: item.id, output_index: 0, content_index: 0, delta: "local fixture reply" },
            ],
            ["response.output_item.done", { output_index: 0, item }],
            ["response.completed", { response }],
          ];
          return new Response(
            events
              .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const provider: ProviderSecret = {
        id: "codex-fixture",
        name: "Codex fixture",
        preset: fixture.preset,
        openaiBaseUrl: `http://127.0.0.1:${mock.port}/v1`,
        anthropicBaseUrl: "",
        model: fixture.model,
        smallModel: fixture.smallModel,
        wireApi: "responses",
        apiKey: "sk-local-codex-fixture",
        mgmtKey: "",
        createdAt: 0,
        updatedAt: 0,
      };
      const env = {
        PATH: "/usr/bin:/bin",
        HOME: home,
        CODEX_HOME: codexHome,
        CODEX_CONFIG: JSON.stringify({ model: provider.model }),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        RUST_LOG: "error",
      };
      const require = createRequire(import.meta.url);
      const adapter = require.resolve("@agentclientprotocol/codex-acp/dist/index.js");
      const runtime = prepareCodexProviderRuntime(provider, env, { command: process.execPath, args: [adapter], cwd });
      let acp: AcpProcess | undefined;
      const close = async () => {
        if (!acp) return;
        acp.kill();
        await acp.exited;
        acp = undefined;
      };
      const launch = async (config?: object) => {
        const [executable, ...args] = command([process.execPath, adapter], true);
        acp = new AcpProcess(
          {
            command: executable as string,
            args,
            env: config ? { ...runtime.env, CODEX_CONFIG: JSON.stringify(config) } : runtime.env,
            cwd,
          },
          { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
        );
        try {
          await acp.initialize(20000);
        } catch (error) {
          throw new Error(`${String(error)}\n${acp.stderr}`);
        }
        await acp.agent.request(methods.agent.providers.set, codexProviderSet(provider));
        return acp;
      };
      try {
        const [executable, ...args] = command([runtime.env.CODEX_PATH as string, "app-server"]);
        const native = Bun.spawn([executable as string, ...args], {
          cwd,
          env: runtime.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          ...processGroupOptions,
        });
        try {
          native.stdin.write(
            `${[
              {
                id: 1,
                method: "initialize",
                params: {
                  clientInfo: { name: "tuantuan-fixture", version: "0" },
                  capabilities: { experimentalApi: true },
                },
              },
              { method: "initialized", params: {} },
              { id: 2, method: "model/list", params: { includeHidden: true } },
            ]
              .map((message) => JSON.stringify(message))
              .join("\n")}\n`,
          );
          const listed = await withTimeout(
            (async () => {
              let buffer = "";
              const decoder = new TextDecoder();
              for await (const chunk of native.stdout) {
                buffer += decoder.decode(chunk, { stream: true });
                while (buffer.includes("\n")) {
                  const split = buffer.indexOf("\n");
                  const line = buffer.slice(0, split);
                  buffer = buffer.slice(split + 1);
                  const message = JSON.parse(line);
                  if (message.id === 2) return message;
                }
              }
              throw new Error(`model/list exited: ${await new Response(native.stderr).text()}`);
            })(),
            15000,
            "offline native model/list",
          );
          expect(listed.error).toBeUndefined();
          expect(listed.result.data.map((model: { id: string }) => model.id)).toEqual(
            [fixture.model, fixture.smallModel].filter(Boolean),
          );
          expect(listed.result.data[0].defaultReasoningEffort).toBe("high");
          expect(
            listed.result.data[0].supportedReasoningEfforts.map(
              (value: { reasoningEffort: string }) => value.reasoningEffort,
            ),
          ).toEqual(fixture.efforts);
        } finally {
          killProcessTree(native);
          await native.exited;
        }
        let running = await launch();
        const created = await withTimeout(
          running.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
          20000,
          "fixture session/new",
        );
        const reasoning = created.configOptions?.find((option) => option.id === "reasoning_effort");
        expect(reasoning?.currentValue).toBe("high");
        const prompt = async (effort: string) => {
          const configured = await running.agent.request(methods.agent.session.setConfigOption, {
            sessionId: created.sessionId,
            configId: "reasoning_effort",
            value: effort,
          });
          expect(configured.configOptions.find((option) => option.id === "reasoning_effort")?.currentValue).toBe(
            effort,
          );
          const before = hits.length;
          const completed = await withTimeout(
            running.agent.request(methods.agent.session.prompt, {
              sessionId: created.sessionId,
              prompt: [{ type: "text", text: "Reply briefly. No tools." }],
            }),
            20000,
            `local fixture ${effort} prompt`,
          );
          expect(completed.stopReason).toBe("end_turn");
          expect(hits.slice(before)).toContainEqual({
            path: "/v1/responses",
            model: fixture.model,
            reasoning: { effort },
          });
        };
        for (const effort of [...fixture.efforts.filter((value) => value !== "none"), "none"]) await prompt(effort);
        expect(messages.at(-1)?.instructions).toBe(
          readFileSync(new URL("../server/provider-codex-prompt-0.160.1.txt", import.meta.url), "utf8"),
        );
        await close();
        running = await launch();
        const resumed = await withTimeout(
          running.agent.request(methods.agent.session.resume, { sessionId: created.sessionId, cwd, mcpServers: [] }),
          20000,
          "fixture session/resume",
        );
        // Codex 0.160.1 reloads the catalog default on resume. Host must reapply
        // the room's explicit user selection before sending its next prompt.
        expect(resumed.configOptions?.find((option) => option.id === "reasoning_effort")?.currentValue).toBe("high");
        await prompt("none");
        await close();
        const instructionsPath = join(root, "native-instructions.txt");
        const override = "Fixture native model instruction override.";
        const developer = "Fixture developer instruction extension.";
        writeFileSync(instructionsPath, override);
        running = await launch({
          model: provider.model,
          model_reasoning_effort: "low",
          model_instructions_file: instructionsPath,
          developer_instructions: developer,
        });
        const custom = await running.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
        expect(custom.configOptions?.find((option) => option.id === "reasoning_effort")?.currentValue).toBe("low");
        const beforeCustom = hits.length;
        const customReply = await withTimeout(
          running.agent.request(methods.agent.session.prompt, {
            sessionId: custom.sessionId,
            prompt: [{ type: "text", text: "Reply briefly. No tools." }],
          }),
          20000,
          "fixture native instructions prompt",
        );
        expect(customReply.stopReason).toBe("end_turn");
        expect(hits.slice(beforeCustom)).toContainEqual({
          path: "/v1/responses",
          model: fixture.model,
          reasoning: { effort: "low" },
        });
        expect(messages.at(-1)?.instructions).toBe(override);
        expect(JSON.stringify(messages.at(-1)?.input)).toContain(developer);
        expect(readFileSync(configPath, "utf8")).toBe(config);
        expect(readFileSync(authPath, "utf8")).toBe("{}");
      } finally {
        await close();
        runtime.cleanup();
        mock.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    90000,
  );
