import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { AcpProcess, withTimeout } from "../server/acp";
import { captureModelCatalog } from "../server/model-catalog";
import { catalogSnapshot } from "../server/model-catalog-schema";
import { prepareProviderRuntime } from "../server/provider-runtime";
import { type ProviderSecret, providerConfigOptions } from "../server/providers";

// Installed Pi + pi-acp 0.0.34, an isolated home, and localhost-only model fixtures.
// TUANTUAN_REAL_PROVIDER_RUNTIMES=1 TUANTUAN_TEST_PI_ACP=/path/to/pi-acp/dist/index.js bun test tests/provider-pi-reasoning-catalog-real.test.ts
const piAcp = process.env.TUANTUAN_TEST_PI_ACP;
const pi = Bun.which("pi");
const enabled = process.env.TUANTUAN_REAL_PROVIDER_RUNTIMES === "1" && piAcp && pi;

const cases = [
  {
    model: "glm-5.3",
    catalog: "zhipuai/glm-5.3",
    format: "zai",
    choices: ["low", "high", "max"],
    selected: ["max", "high", "low"],
  },
  {
    model: "qwen3.8-max",
    catalog: "alibaba-cn/qwen3.8-max",
    format: "qwen",
    choices: ["off", "low", "medium", "xhigh"],
    selected: ["xhigh", "medium", "low", "off"],
  },
  {
    model: "kimi-k2.6",
    catalog: "moonshotai-cn/kimi-k2.6",
    format: "toggle",
    choices: ["off", "high"],
    selected: ["high", "off"],
  },
  {
    model: "claude-sonnet-4-5",
    catalog: "anthropic/claude-sonnet-4-5",
    format: "budget",
    choices: ["off", "minimal", "low", "medium", "high"],
    selected: ["high", "off", "low"],
  },
  {
    model: "fixture-budget-minmax",
    catalog: "fixture/fixture-budget-minmax",
    format: "budget",
    choices: ["off", "minimal", "low", "medium", "high"],
    selected: ["high", "off", "low"],
    bounds: { min: 4096, max: 6144, output: 16384 },
  },
  {
    model: "fixture-budget-output",
    catalog: "fixture/fixture-budget-output",
    format: "budget",
    choices: ["off", "minimal", "low", "medium", "high"],
    selected: ["high", "off", "low"],
    bounds: { min: 1024, max: 100000, output: 4096 },
  },
  {
    model: "fixture-budget-no-room",
    catalog: "fixture/fixture-budget-no-room",
    format: "budget",
    choices: ["off", "minimal", "low", "medium", "high"],
    selected: ["high"],
    bounds: { min: 4096, max: 6144, output: 16384 },
    insufficientContext: true,
  },
] as const;

function thinkingOption(options: acp.SessionConfigOption[] | null | undefined) {
  const option = options?.find((item) => item.category === "thought_level" || /thinking/.test(item.id));
  if (option?.type !== "select") throw new Error("Pi did not return a native thinking selector");
  return option;
}

for (const fixture of cases) {
  test.skipIf(!enabled)(
    `real Pi catalog ${fixture.model}: supported controls, actual request and explicit choice after reload`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tt-pi-catalog-real-"));
      const home = join(root, "home");
      const cwd = join(root, "cwd");
      const piDir = join(home, ".pi", "agent");
      mkdirSync(piDir, { recursive: true });
      mkdirSync(cwd);
      const settings = JSON.stringify({
        defaultThinkingLevel: "high",
        ...("bounds" in fixture ? { thinkingBudgets: { low: 1, high: 500000 } } : {}),
        ...("insufficientContext" in fixture ? { compaction: { enabled: false } } : {}),
      });
      writeFileSync(join(piDir, "settings.json"), settings);
      const hits: { path: string; body: Record<string, unknown> }[] = [];
      const mock = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as Record<string, unknown>;
          hits.push({ path: new URL(request.url).pathname, body });
          if (fixture.format === "budget") {
            const event = (type: string, data: Record<string, unknown>) =>
              `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
            return new Response(
              event("message_start", {
                message: {
                  id: "fixture",
                  type: "message",
                  role: "assistant",
                  model: body.model,
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              }) +
                event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
                event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "local fixture reply" } }) +
                event("content_block_stop", { index: 0 }) +
                event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) +
                event("message_stop", {}),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          const common = { id: "fixture", object: "chat.completion.chunk", model: body.model, created: 0 };
          return new Response(
            `${[
              {
                ...common,
                choices: [
                  { index: 0, delta: { role: "assistant", content: "local fixture reply" }, finish_reason: null },
                ],
              },
              {
                ...common,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
            ]
              .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
              .join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const base = `http://127.0.0.1:${mock.port}`;
      const provider: ProviderSecret = {
        id: "pi-catalog-fixture",
        name: "Catalog fixture",
        preset: "custom",
        apiKey: "unused-fixture-key",
        mgmtKey: "",
        model: fixture.model,
        smallModel: "",
        wireApi: "chat",
        openaiBaseUrl: fixture.format === "budget" ? "" : `${base}/v1`,
        anthropicBaseUrl: `${base}/anthropic`,
        modelCatalog: { [fixture.model]: fixture.catalog },
        createdAt: 0,
        updatedAt: 0,
      };
      if ("bounds" in fixture) {
        captureModelCatalog(
          provider,
          catalogSnapshot(
            JSON.stringify({
              fixture: {
                name: "Bounded budget fixture",
                models: {
                  [fixture.model]: {
                    name: fixture.model,
                    reasoning: true,
                    reasoning_options: [{ type: "budget_tokens", min: fixture.bounds.min, max: fixture.bounds.max }],
                    limit: { context: "insufficientContext" in fixture ? 512 : 128000, output: fixture.bounds.output },
                    modalities: { input: ["text"] },
                  },
                },
              },
            }),
            "2026-10-17T00:00:00Z",
          ),
        );
      }
      const env = {
        HOME: home,
        PATH: process.env.PATH ?? "",
        PI_OFFLINE: "1",
        PI_ACP_PI_COMMAND: pi as string,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      };
      const updates: acp.SessionUpdate[] = [];
      const launch = async () => {
        const runtime = await prepareProviderRuntime(provider, "pi", env);
        const command = [process.execPath, piAcp as string];
        if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
          command.unshift(
            "/usr/bin/sandbox-exec",
            "-p",
            '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))',
          );
        const acp = new AcpProcess(
          { command: command[0] as string, args: command.slice(1), cwd, env: runtime.env },
          {
            onUpdate(notification) {
              updates.push(notification.update);
            },
            requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
          },
        );
        return { runtime, acp };
      };
      let running = await launch();
      const stop = async () => {
        running.acp.kill();
        await withTimeout(running.acp.exited, 5000, "Pi fixture exit timed out");
        running.runtime.cleanup();
      };
      const assertRequest = (body: Record<string, unknown>, level: string) => {
        expect(body.model).toBe(fixture.model);
        if (fixture.format === "zai") {
          expect(body.thinking).toMatchObject({ type: "enabled" });
          expect(body.reasoning_effort).toBe(level);
        } else if (fixture.format === "qwen") {
          expect(body.enable_thinking).toBe(level !== "off");
          expect(body.reasoning_effort).toBe(level === "off" ? undefined : level);
        } else if (fixture.format === "toggle") {
          expect(body.thinking).toEqual({ type: level === "off" ? "disabled" : "enabled" });
          expect(body.reasoning_effort).toBeUndefined();
        } else {
          const nativeBudget = { minimal: 1024, low: 2048, medium: 8192, high: 16384 }[level];
          const budget =
            "bounds" in fixture && nativeBudget !== undefined
              ? Math.min(fixture.bounds.max, fixture.bounds.output - 1024, Math.max(fixture.bounds.min, nativeBudget))
              : nativeBudget;
          expect(body.thinking).toMatchObject(
            level === "off" ? { type: "disabled" } : { type: "enabled", budget_tokens: budget },
          );
          expect(body.output_config).toBeUndefined();
          if ("bounds" in fixture) expect(body.max_tokens).toBeLessThanOrEqual(fixture.bounds.output);
        }
      };
      try {
        await running.acp.initialize(15_000);
        const session = await running.acp.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
        const option = thinkingOption(session.configOptions);
        expect(
          option.options.flatMap((item) => ("options" in item ? item.options : [item])).map((item) => item.value),
        ).toEqual([...fixture.choices]);
        if (fixture.format === "toggle") {
          const visible = thinkingOption(providerConfigOptions(provider, "pi", session.configOptions ?? []));
          expect(visible.options).toContainEqual(expect.objectContaining({ value: "high", name: "On" }));
        }
        expect(running.runtime.reasoningPreferences).toEqual({});
        if ("insufficientContext" in fixture) {
          await running.acp.agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: option.id,
            value: "high",
          });
          await withTimeout(
            running.acp.agent.request(methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "Reply briefly. Do not use tools." }],
            }),
            20_000,
            "Pi insufficient-budget fixture timed out",
          );
          expect(hits).toEqual([]);
          expect(updates).toContainEqual(
            expect.objectContaining({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Thinking budget does not fit the remaining output allowance." },
            }),
          );
          return;
        }
        const prompt = async () => {
          const start = hits.length;
          await withTimeout(
            running.acp.agent.request(methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "Reply with local fixture reply. Do not use tools." }],
            }),
            20_000,
            "Pi fixture prompt timed out",
          );
          expect(hits.length, running.acp.stderr).toBeGreaterThan(start);
          return hits[start]?.body as Record<string, unknown>;
        };
        for (const level of fixture.selected) {
          const changed = await running.acp.agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: option.id,
            value: level,
          });
          expect(thinkingOption(changed.configOptions).currentValue).toBe(level);
          assertRequest(await prompt(), level);
        }
        const selected = fixture.selected.at(-1) as string;
        await stop();
        running = await launch();
        await running.acp.initialize(15_000);
        const restored = await running.acp.agent.request(methods.agent.session.load, {
          sessionId: session.sessionId,
          cwd,
          mcpServers: [],
        });
        expect(thinkingOption(restored.configOptions).currentValue).toBe(selected);
        assertRequest(await prompt(), selected);
        expect(readFileSync(join(piDir, "settings.json"), "utf8")).toBe(settings);
      } finally {
        await stop();
        mock.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
}
