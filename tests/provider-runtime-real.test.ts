import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { AcpProcess, withTimeout } from "../server/acp";
import { prepareProviderRuntime, providerRuntimeModel } from "../server/provider-runtime";
import type { ProviderSecret } from "../server/providers";

/**
 * Real optional engines, synthetic user config, and local model APIs only.
 * Chat returns a completed text stream; other protocols reject after recording routing.
 * TUANTUAN_REAL_PROVIDER_RUNTIMES=1 TUANTUAN_TEST_PI_ACP=/path/to/pi-acp/dist/index.js bun test tests/provider-runtime-real.test.ts
 * TUANTUAN_TEST_OPENCODE can select a specific Registry binary (including V1).
 */
const enabled = process.env.TUANTUAN_REAL_PROVIDER_RUNTIMES === "1";
const opencode = process.env.TUANTUAN_TEST_OPENCODE || Bun.which("opencode");
const piAcp = process.env.TUANTUAN_TEST_PI_ACP;
const pi = Bun.which("pi");

for (const harness of ["opencode", "pi"] as const) {
  for (const protocol of ["chat", "responses", "anthropic"] as const) {
    test.skipIf(!enabled || (harness === "opencode" ? !opencode : !piAcp || !pi))(
      `real ${harness}: ${protocol} URL/key/model, native config, ACP selection and reload`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "tt-provider-runtime-real-"));
        const home = join(root, "home");
        const cwd = join(root, "cwd");
        const piDir = join(home, ".pi", "agent");
        mkdirSync(join(home, ".config", "opencode"), { recursive: true });
        mkdirSync(join(piDir, "extensions"), { recursive: true });
        mkdirSync(cwd);
        const settings = JSON.stringify({ defaultProvider: "native-resource", defaultModel: "native-model" });
        writeFileSync(join(piDir, "settings.json"), settings);
        const auth = JSON.stringify({ "native-resource": { type: "api_key", key: "sk-native-fixture" } });
        writeFileSync(join(piDir, "auth.json"), auth);
        writeFileSync(
          join(piDir, "extensions", "native.js"),
          `export default (pi) => pi.registerProvider("native-resource", {
  baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture-native-key",
  models: [{id: "native-model", name: "Native resource", reasoning: false, input: ["text"],
    contextWindow: 128000, maxTokens: 8192, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]
});\n`,
        );
        const hits: { path: string; key: string | null; model: unknown }[] = [];
        const mock = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const body = (await request.json().catch(() => ({}))) as { model?: unknown; stream?: boolean };
            hits.push({
              path: new URL(request.url).pathname,
              key: request.headers.get("authorization") ?? request.headers.get("x-api-key"),
              model: body.model,
            });
            if (new URL(request.url).pathname.endsWith("/chat/completions")) {
              const common = { id: "fixture-chat", model: body.model, created: 0 };
              if (!body.stream) {
                return Response.json({
                  ...common,
                  object: "chat.completion",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "runtime fixture reply" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                });
              }
              const chunks = [
                {
                  ...common,
                  object: "chat.completion.chunk",
                  choices: [
                    { index: 0, delta: { role: "assistant", content: "runtime fixture reply" }, finish_reason: null },
                  ],
                },
                {
                  ...common,
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                },
              ];
              return new Response(
                `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
                {
                  headers: { "content-type": "text/event-stream" },
                },
              );
            }
            return Response.json(
              { type: "error", error: { type: "invalid_request_error", message: "local fixture stopped request" } },
              { status: 400 },
            );
          },
        });
        const base = `http://127.0.0.1:${mock.port}`;
        const profile: ProviderSecret = {
          id: "local-fixture",
          name: "Local fixture",
          preset: "custom",
          anthropicBaseUrl: `${base}/initial/anthropic`,
          openaiBaseUrl: protocol === "anthropic" ? "" : `${base}/initial/v1`,
          wireApi: protocol === "responses" ? "responses" : "chat",
          apiKey: "sk-profile-fixture",
          mgmtKey: "",
          model: "fixture-main",
          smallModel: "fixture-fast",
          createdAt: 0,
          updatedAt: 0,
        };
        const env: Record<string, string> = {
          HOME: home,
          PATH: process.env.PATH || "",
          TMPDIR: tmpdir(),
          LANG: "en_US.UTF-8",
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_STATE_HOME: join(home, ".local", "state"),
          XDG_CACHE_HOME: join(home, ".cache"),
          PI_OFFLINE: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          ...(pi ? { PI_ACP_PI_COMMAND: pi } : {}),
        };
        const version =
          harness === "opencode"
            ? await new Response(Bun.spawn([opencode as string, "--version"], { env, stdout: "pipe" }).stdout).text()
            : null;
        const nativeConfig = JSON.stringify(
          version?.trim().startsWith("1.")
            ? {
                $schema: "https://opencode.ai/config.json",
                model: "openai/native-model",
                enabled_providers: ["openai"],
                disabled_providers: ["tuantuan"],
              }
            : { $schema: "https://opencode.ai/config.json", username: "native-fixture" },
        );
        const nativeConfigPath = join(home, ".config", "opencode", "opencode.json");
        writeFileSync(nativeConfigPath, nativeConfig);
        const replies: string[] = [];
        const launch = async (p: ProviderSecret) => {
          const runtime = await prepareProviderRuntime(p, harness, env, version);
          const acp = new AcpProcess(
            {
              command: harness === "opencode" ? (opencode as string) : process.execPath,
              args: harness === "opencode" ? ["acp"] : [piAcp as string],
              env: runtime.env,
              cwd,
            },
            {
              onUpdate: ({ update }) => {
                if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
                  replies.push(update.content.text);
              },
              requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            },
          );
          return { acp, runtime };
        };
        let running: Awaited<ReturnType<typeof launch>> | undefined;
        const close = async () => {
          if (!running) return;
          running.acp.kill();
          await withTimeout(running.acp.exited, 5_000, "fixture engine exit");
          running.runtime.cleanup();
          running = undefined;
        };
        const prompt = async (sessionId: string, model: string, prefix: string, key: string) => {
          if (!running) throw new Error("fixture process is missing");
          replies.length = 0;
          let failure = "";
          await withTimeout(
            running.acp.agent.request(methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "Reply with ok. Do not use tools." }],
            }),
            20_000,
            "local mock prompt",
          ).catch((error) => {
            failure = String(error);
          });
          const suffix =
            protocol === "anthropic"
              ? "/anthropic/v1/messages"
              : protocol === "chat"
                ? "/v1/chat/completions"
                : "/v1/responses";
          expect(
            hits.some((hit) => hit.path === prefix + suffix && hit.model === model && hit.key?.includes(key)),
            `${failure}\n${running.acp.stderr}\n${JSON.stringify(hits)}`,
          ).toBe(true);
          if (protocol === "chat") {
            expect(failure).toBe("");
            expect(replies.join("")).toContain("runtime fixture reply");
          }
        };
        try {
          running = await launch(profile);
          await running.acp.initialize(15_000);
          const session = await withTimeout(
            running.acp.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
            20_000,
            "real fixture session/new",
          );
          const model = session.configOptions?.find((option) => option.category === "model");
          expect(model?.currentValue).toBe(providerRuntimeModel(profile.model));
          if (harness === "pi") expect(JSON.stringify(model)).toContain("native-resource/native-model");
          await prompt(session.sessionId, profile.model, "/initial", profile.apiKey);
          await running.acp.agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: "model",
            value: providerRuntimeModel(profile.smallModel),
          });
          await prompt(session.sessionId, profile.smallModel, "/initial", profile.apiKey);
          await close();
          const edited = {
            ...profile,
            model: "fixture-edited",
            smallModel: "fixture-edited-fast",
            apiKey: "sk-edited-fixture",
            anthropicBaseUrl: `${base}/edited/anthropic`,
            openaiBaseUrl: protocol === "anthropic" ? "" : `${base}/edited/v1`,
          };
          running = await launch(edited);
          await running.acp.initialize(15_000);
          await withTimeout(
            running.acp.agent.request(methods.agent.session.load, {
              sessionId: session.sessionId,
              cwd,
              mcpServers: [],
            }),
            20_000,
            "real fixture session/load",
          );
          // Native session selection may restore the previous model. The host deliberately
          // reapplies the profile before its own optional conversation preference.
          await running.acp.agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: "model",
            value: providerRuntimeModel(edited.model),
          });
          await prompt(session.sessionId, edited.model, "/edited", edited.apiKey);
          expect(readFileSync(join(piDir, "settings.json"), "utf8")).toBe(settings);
          expect(existsSync(join(piDir, "models.json"))).toBe(false);
          expect(readFileSync(join(piDir, "auth.json"), "utf8")).toBe(auth);
          expect(readFileSync(nativeConfigPath, "utf8")).toBe(nativeConfig);
        } finally {
          await close();
          mock.stop(true);
          rmSync(root, { recursive: true, force: true });
        }
      },
      120_000,
    );
  }
}

const opencodeV2 = process.env.TUANTUAN_TEST_OPENCODE_V2;
test.skipIf(!enabled || !opencodeV2)(
  "real opencode V2 keeps a higher-priority native provider policy visible as failure",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-opencode-provider-policy-"));
    const configDir = join(root, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    const native = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["openai"],
      disabled_providers: ["tuantuan"],
    });
    const configPath = join(configDir, "opencode.json");
    writeFileSync(configPath, native);
    const runtime = await prepareProviderRuntime(
      {
        id: "policy-fixture",
        name: "Policy fixture",
        preset: "custom",
        anthropicBaseUrl: "",
        openaiBaseUrl: "http://127.0.0.1:9/v1",
        apiKey: "sk-policy-fixture",
        mgmtKey: "",
        model: "fixture-main",
        smallModel: "",
        wireApi: "chat",
        createdAt: 0,
        updatedAt: 0,
      },
      "opencode",
      {
        HOME: root,
        PATH: process.env.PATH || "",
        XDG_CONFIG_HOME: join(root, ".config"),
        XDG_DATA_HOME: join(root, ".local", "share"),
        XDG_STATE_HOME: join(root, ".local", "state"),
        XDG_CACHE_HOME: join(root, ".cache"),
      },
      "2.0.29",
    );
    const acp = new AcpProcess(
      { command: opencodeV2 as string, args: ["acp"], env: runtime.env, cwd: root },
      { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
    );
    try {
      await acp.initialize(15_000);
      const select = async () => {
        const session = await acp.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
        await acp.agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: "model",
          value: providerRuntimeModel("fixture-main"),
        });
      };
      await expect(withTimeout(select(), 20_000, "native policy refusal")).rejects.toThrow(/model|provider/i);
      expect(readFileSync(configPath, "utf8")).toBe(native);
    } finally {
      acp.kill();
      await withTimeout(acp.exited, 5_000, "native policy engine exit");
      runtime.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);
