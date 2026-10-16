import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { AcpProcess, withTimeout } from "../server/acp";
import { bundledAdapter, harnessSpec } from "../server/harness";
import { claudeConfigOptions, claudeProviderEnv } from "../server/provider-claude";
import type { ProviderSecret } from "../server/providers";

// Pinned ACP + SDK + CLI, disposable home and a local Anthropic endpoint. No paid model call.
// TUANTUAN_REAL_CLAUDE_PROVIDER=1 bun test tests/provider-claude-real.test.ts
const enabled = process.env.TUANTUAN_REAL_CLAUDE_PROVIDER === "1";

test.skipIf(!enabled || process.platform === "win32")(
  "real Claude custom-model capabilities, native effort and raw Anthropic request",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-claude-provider-real-"));
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    mkdirSync(home);
    mkdirSync(cwd);
    const hits: { path: string; body: Record<string, unknown> }[] = [];
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const path = new URL(request.url).pathname;
        hits.push({ path, body });
        if (!path.endsWith("/messages")) return Response.json({ data: [], models: [] });
        const message = {
          id: `fixture-${hits.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        const event = (type: string, data: Record<string, unknown>) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        return new Response(
          event("message_start", { message }) +
            event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
            event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "local fixture reply" } }) +
            event("content_block_stop", { index: 0 }) +
            event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) +
            event("message_stop", {}),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    let process: AcpProcess | undefined;
    try {
      const provider: ProviderSecret = {
        id: "claude-local",
        name: "Local fixture",
        preset: "custom",
        apiKey: "unused-fixture-key",
        mgmtKey: "",
        anthropicBaseUrl: `http://127.0.0.1:${mock.port}`,
        openaiBaseUrl: "https://unused.invalid/v1",
        model: "custom-thinker",
        smallModel: "custom-plain",
        wireApi: "responses",
        modelCatalog: { "custom-thinker": "deepseek/deepseek-v4-pro", "custom-plain": "openai/gpt-4.1" },
        createdAt: 0,
        updatedAt: 0,
      };
      const env = claudeProviderEnv(provider, {
        HOME: home,
        PATH: globalThis.process.env.PATH ?? "/usr/bin:/bin",
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        ANTHROPIC_BASE_URL: provider.anthropicBaseUrl,
        ANTHROPIC_AUTH_TOKEN: provider.apiKey,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: provider.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: provider.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: provider.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.smallModel,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      });
      const spec = harnessSpec("claude-code");
      const adapter = spec && bundledAdapter(spec);
      if (!adapter) throw new Error("Missing pinned Claude ACP adapter");
      const command = [globalThis.process.execPath, adapter.script];
      if (globalThis.process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
        command.unshift(
          "/usr/bin/sandbox-exec",
          "-p",
          '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))',
        );
      process = new AcpProcess(
        { command: command[0] as string, args: command.slice(1), env, cwd },
        { onUpdate() {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
      );
      await process.initialize();
      const session = await withTimeout(
        process.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
          _meta: { claudeCode: { options: { settingSources: [], settings: { apiKeyHelper: "", env } } } },
        }),
        45_000,
        "Claude fixture session timed out",
      );
      const select = (configId: string, value: string) =>
        withTimeout(
          (process as AcpProcess).agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId,
            value,
          }),
          20_000,
          "Claude fixture selection timed out",
        );
      const selected = await select("model", provider.model);
      expect(selected.configOptions.find((option) => option.id === "model")?.currentValue).toBe(provider.model);
      const visible = claudeConfigOptions(provider, selected.configOptions, env);
      const effort = visible.find((option) => option.id === "effort");
      expect(effort?.type).toBe("select");
      const values =
        effort?.type === "select"
          ? effort.options.flatMap((item) => ("options" in item ? item.options : [item])).map((item) => item.value)
          : [];
      expect(values).toEqual(["default", "low", "high", "max"]);
      await expect(select("effort", "off")).rejects.toThrow();
      expect((await select("effort", "low")).configOptions.find((option) => option.id === "effort")?.currentValue).toBe(
        "low",
      );
      const plain = await select("model", "haiku");
      expect(plain.configOptions.some((option) => option.id === "effort")).toBe(false);
      const returned = await select("model", provider.model);
      expect(returned.configOptions.some((option) => option.id === "effort")).toBe(true);
      await select("effort", "low");
      await withTimeout(
        process.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Reply with local fixture reply only. Do not use tools." }],
        }),
        45_000,
        "Claude fixture prompt timed out",
      );
      expect(hits).toContainEqual(
        expect.objectContaining({
          path: "/v1/messages",
          body: expect.objectContaining({
            model: provider.model,
            thinking: expect.objectContaining({ type: "adaptive" }),
            output_config: { effort: "low" },
          }),
        }),
      );
    } finally {
      process?.kill();
      await process?.exited;
      mock.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
