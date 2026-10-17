import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { AcpProcess, withTimeout } from "../server/acp";
import type { ModelApi } from "../server/model-capabilities";
import { resolveModelCapabilities } from "../server/model-catalog";
import { prepareProviderRuntime } from "../server/provider-runtime";
import type { ProviderSecret } from "../server/providers";

// These tests launch the real CLI with isolated XDG directories and loopback HTTP.
// They prove ACP choices and request serialization; no paid model is contacted.
const binary = process.env.TUANTUAN_TEST_OPENCODE || Bun.which("opencode");
const enabled = process.env.TUANTUAN_REAL_PROVIDER_RUNTIMES === "1" && !!binary;

test.skipIf(!enabled || process.platform !== "darwin")(
  "real OpenCode config reader identifies an unknown-version schema without model requests",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-opencode-unknown-schema-"));
    const trace = join(root, "metadata-processes.jsonl");
    const wrapper = join(root, "opencode-metadata");
    writeFileSync(
      wrapper,
      `#!${process.execPath}
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
const args = process.argv.slice(2);
const scoped = args[0] === "debug" && readdirSync(process.env.OPENCODE_CONFIG_DIR).some(name => name.startsWith("service") && name.endsWith(".json") && JSON.parse(readFileSync(process.env.OPENCODE_CONFIG_DIR + "/" + name, "utf8")).disabled === true);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid: process.pid, home: process.env.HOME, args, scoped }) + "\\n");
const child = Bun.spawnSync([${JSON.stringify(binary)}, ...args], { env: process.env, stdout: "inherit", stderr: "inherit" });
process.exit(child.exitCode);
`,
      { mode: 0o700 },
    );
    const provider: ProviderSecret = {
      id: "metadata-only",
      name: "Metadata fixture",
      preset: "custom",
      model: "metadata-only",
      smallModel: "",
      anthropicBaseUrl: "",
      openaiBaseUrl: "http://127.0.0.1:9/v1",
      wireApi: "chat",
      apiKey: "unused-metadata-fixture",
      mgmtKey: "",
      createdAt: 0,
      updatedAt: 0,
    };
    try {
      const runtime = await prepareProviderRuntime(
        provider,
        "opencode",
        { HOME: root, PATH: process.env.PATH ?? "" },
        "unknown-future-version",
        { command: wrapper, args: ["acp"] },
      );
      const config = JSON.parse(runtime.env.OPENCODE_CONFIG_CONTENT as string);
      expect(config.providers?.tuantuan ?? config.provider?.tuantuan).toBeDefined();
      expect(config.model).toBe("tuantuan/metadata-only");
      runtime.cleanup();
      const launches = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(launches[0].args).toEqual(["service", "set", "disabled", "true"]);
      expect(launches.some((launch) => launch.scoped)).toBe(true);
      for (const launch of launches) {
        expect(existsSync(launch.home)).toBe(false);
        let running = true;
        for (let retry = 0; retry < 100 && running; retry++) {
          try {
            process.kill(-launch.pid, 0);
            await Bun.sleep(20);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            running = false;
          }
        }
        expect(running).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  25_000,
);

const cases: { reference: string; api: ModelApi; picks: string[] }[] = [
  { reference: "alibaba-cn/qwen3.8-max", api: "openai-completions", picks: ["xhigh", "none", "low"] },
  { reference: "zhipuai/glm-5.3", api: "openai-completions", picks: ["max", "low"] },
  { reference: "moonshotai-cn/kimi-k2.6", api: "openai-completions", picks: ["on", "none"] },
  { reference: "openai/gpt-5.4", api: "openai-completions", picks: ["xhigh", "none"] },
  { reference: "openai/gpt-5.4", api: "openai-responses", picks: ["xhigh", "none"] },
  { reference: "openrouter/anthropic/claude-sonnet-4.6", api: "openai-completions", picks: ["max", "none"] },
  { reference: "anthropic/claude-sonnet-4-6", api: "anthropic-messages", picks: ["max", "low"] },
  { reference: "anthropic/claude-sonnet-4-5", api: "anthropic-messages", picks: ["high", "none", "minimal"] },
  { reference: "moonshotai-cn/kimi-k2.6", api: "anthropic-messages", picks: ["on", "none"] },
];

for (const fixture of cases) {
  test.skipIf(!enabled)(
    `real OpenCode catalog controls: ${fixture.reference} / ${fixture.api}`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tt-opencode-catalog-"));
      const cwd = join(root, "cwd");
      mkdirSync(cwd);
      const hits: Record<string, unknown>[] = [];
      const mock = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          hits.push((await request.json()) as Record<string, unknown>);
          return Response.json(
            { error: { type: "invalid_request_error", message: "fixture recorded request" } },
            { status: 400 },
          );
        },
      });
      const model = fixture.reference.slice(fixture.reference.indexOf("/") + 1);
      const provider: ProviderSecret = {
        id: "catalog-fixture",
        name: "Catalog fixture",
        preset: "custom",
        model,
        smallModel: model,
        modelCatalog: { [model]: fixture.reference },
        openaiBaseUrl: fixture.api === "anthropic-messages" ? "" : `http://127.0.0.1:${mock.port}/v1`,
        anthropicBaseUrl: fixture.api === "anthropic-messages" ? `http://127.0.0.1:${mock.port}` : "",
        wireApi: fixture.api === "openai-responses" ? "responses" : "chat",
        apiKey: "fixture-only-key",
        mgmtKey: "",
        createdAt: 0,
        updatedAt: 0,
      };
      const capability = resolveModelCapabilities(provider, model, fixture.api);
      expect(capability).not.toBeNull();
      if (!capability) throw new Error("Fixture model missing from catalog");
      const env = {
        PATH: process.env.PATH || "",
        XDG_CONFIG_HOME: join(root, "config"),
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
      const runtime = await prepareProviderRuntime(provider, "opencode", env, version);
      const engine = new AcpProcess(
        { command: binary as string, args: ["acp"], env: runtime.env, cwd },
        { onUpdate() {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
      );
      let options: SessionConfigOption[] = [];
      const selections: unknown[] = [];
      try {
        await engine.initialize(20_000);
        const session = await withTimeout(
          engine.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
          20_000,
          "catalog session/new",
        );
        options = session.configOptions ?? [];
        const effort = options.find((option) => option.id === "effort");
        expect(effort?.type, engine.stderr).toBe("select");
        if (effort?.type !== "select") throw new Error("Missing catalog effort menu");
        const values = effort.options
          .flatMap((option) => ("options" in option ? option.options : [option]))
          .map((option) => option.value);
        expect(values.filter((value) => value !== "default").sort()).toEqual(
          capability.levels.map((level) => (level === "off" ? "none" : level)).sort(),
        );
        for (const pick of fixture.picks) {
          const selected = await engine.agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: effort.id,
            value: pick,
          });
          const current = selected.configOptions.find((option) => option.id === effort.id)?.currentValue;
          expect(current).toBe(pick);
          selections.push({ pick, current });
          const previous = hits.length;
          await withTimeout(
            engine.agent.request(methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "Return the local fixture response." }],
            }),
            20_000,
            "catalog prompt",
          ).catch(() => {});
          // V1 can issue a title request using the same model before the prompt.
          const body = hits
            .slice(previous)
            .filter((request) => request.model === model)
            .at(-1);
          expect(body, engine.stderr).toBeDefined();
          if (!body) throw new Error("CLI did not issue a model request");
          const off = pick === "none";
          if (fixture.api === "anthropic-messages") {
            expect(body.thinking).toMatchObject({
              type: off ? "disabled" : capability.format === "anthropic-adaptive" ? "adaptive" : "enabled",
            });
            if (capability.effort)
              expect(body.output_config).toMatchObject({ effort: off ? capability.defaultLevel : pick });
            else {
              // V1 itself injects a fixed high effort for Kimi model names. This
              // is native transport behavior, not an extra catalog picker level.
              if (/^1\./.test(version.trim()) && capability.providerId.startsWith("moonshotai"))
                expect(body.output_config).toEqual({ effort: "high" });
              else expect(body.output_config).toBeUndefined();
              if (!off) {
                const budget = capability.budgets?.[pick as keyof typeof capability.budgets];
                expect(body.thinking).toMatchObject({ budget_tokens: budget });
                expect(budget as number).toBeLessThan(body.max_tokens as number);
              }
            }
          } else if (fixture.api === "openai-responses") {
            expect(body.reasoning).toMatchObject({ effort: pick });
          } else if (capability.format === "openrouter") {
            expect(body.reasoning).toMatchObject(off ? { enabled: false } : { effort: pick });
          } else {
            if (capability.effort)
              expect(body.reasoning_effort).toBe(off && capability.format === "qwen" ? capability.defaultLevel : pick);
            else expect(body.reasoning_effort).toBeUndefined();
            if (capability.format === "qwen") expect(body.enable_thinking).toBe(!off);
            if (capability.format === "zai") expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
            if (capability.format === "deepseek") expect(body.thinking).toEqual({ type: off ? "disabled" : "enabled" });
          }
        }
      } finally {
        const evidence = process.env.TUANTUAN_TEST_REASONING_EVIDENCE;
        if (evidence)
          writeFileSync(
            `${evidence}-${version.trim()}-${fixture.reference.replaceAll("/", "_")}-${fixture.api}.json`,
            JSON.stringify({ version, capability, options, selections, hits, stderr: engine.stderr }, null, 2),
          );
        engine.kill();
        await withTimeout(engine.exited, 5_000, "catalog fixture exit");
        runtime.cleanup();
        mock.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
}
