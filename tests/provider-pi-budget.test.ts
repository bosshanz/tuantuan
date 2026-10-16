import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureModelCatalog } from "../server/model-catalog";
import { catalogSnapshot } from "../server/model-catalog-schema";
import { prepareProviderRuntime } from "../server/provider-runtime";
import type { ProviderSecret } from "../server/providers";

function boundedProvider(): ProviderSecret {
  return captureModelCatalog(
    {
      id: "budget-fixture",
      name: "Budget fixture",
      preset: "custom",
      model: "budget-model",
      smallModel: "",
      anthropicBaseUrl: "http://127.0.0.1/anthropic",
      openaiBaseUrl: "",
      wireApi: "chat",
      apiKey: "unused-key",
      mgmtKey: "",
      modelCatalog: { "budget-model": "fixture/budget-model" },
      createdAt: 0,
      updatedAt: 0,
    },
    catalogSnapshot(
      JSON.stringify({
        fixture: {
          name: "Budget fixture",
          models: {
            "budget-model": {
              name: "Budget fixture",
              reasoning: true,
              reasoning_options: [{ type: "budget_tokens", min: 4096, max: 6144 }],
              limit: { context: 128000, output: 16384 },
              modalities: { input: ["text"] },
            },
          },
        },
      }),
      "2026-10-17T00:00:00Z",
    ),
  );
}

function fakePi(root: string) {
  const executable = join(root, "pi");
  writeFileSync(
    executable,
    `#!${process.execPath}
const args = process.argv.slice(2);
const { default: setup } = await import(args[args.indexOf("--extension") + 1]);
const scenario = JSON.parse(args.at(-1));
let hook, aborted = false, registration;
const notifications = [];
setup({
  registerProvider(id, config) { registration = config; },
  on(name, handler) { if (name === "before_provider_request") hook = handler; },
  getThinkingLevel() { return scenario.level; },
});
const result = hook?.({ payload: scenario.payload }, {
  model: { provider: scenario.provider || "tuantuan", api: scenario.api || "anthropic-messages" },
  abort() { aborted = true; }, ui: { notify(message, type) { notifications.push({ message, type }); } },
});
console.log(JSON.stringify({ result, aborted, notifications, registration }));
`,
    { mode: 0o700 },
  );
  return executable;
}

const payload = (max_tokens = 16384, budget_tokens = 1) => ({
  model: "budget-model",
  max_tokens,
  thinking: { type: "enabled", budget_tokens, display: "summarized" },
  messages: [],
});

test.skipIf(process.platform === "win32")(
  "Pi's generated public request hook enforces catalog budgets without changing off or other deployments",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-pi-budget-hook-"));
    const runtime = prepareProviderRuntime(boundedProvider(), "pi", {
      HOME: root,
      PATH: process.env.PATH ?? "",
      PI_ACP_PI_COMMAND: fakePi(root),
    });
    const run = async (scenario: Record<string, unknown>) => {
      const child = Bun.spawn([runtime.env.PI_ACP_PI_COMMAND as string, JSON.stringify(scenario)], {
        env: runtime.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
      return JSON.parse(output);
    };
    try {
      for (const [level, expected] of [
        ["minimal", 4096],
        ["low", 4096],
        ["medium", 6144],
        ["high", 6144],
      ] as const) {
        const result = await run({ level, payload: payload() });
        expect(result.result.thinking).toEqual({ type: "enabled", budget_tokens: expected, display: "summarized" });
        expect(result.result.max_tokens).toBe(16384);
        expect(result.registration._thinkingBudgets).toBeUndefined();
        expect(result.aborted).toBe(false);
      }
      expect((await run({ level: "high", payload: payload(7000) })).result.thinking.budget_tokens).toBe(5976);
      expect((await run({ level: "high", payload: payload(99999) })).result.max_tokens).toBe(16384);
      for (const scenario of [
        { level: "off", payload: { ...payload(), thinking: { type: "disabled" } } },
        { level: "high", payload: { ...payload(), thinking: { type: "adaptive" } } },
        { level: "high", payload: { ...payload(), model: "unknown" } },
        { level: "high", payload: { ...payload(), model: "constructor" } },
        { level: "high", payload: payload(), provider: "native-other-provider" },
        { level: "high", payload: payload(), api: "openai-completions" },
      ]) {
        const result = await run(scenario);
        expect(result.result).toBeUndefined();
        expect(result.aborted).toBe(false);
      }
      const insufficient = await run({ level: "high", payload: payload(5000) });
      expect(insufficient.result).toBeUndefined();
      expect(insufficient.aborted).toBe(true);
      expect(insufficient.notifications).toContainEqual(expect.objectContaining({ type: "error" }));
    } finally {
      runtime.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Pi explicit settings suppress recommendations while native precedence and project trust remain authoritative",
  () => {
    const root = mkdtempSync(join(tmpdir(), "tt-pi-native-thinking-"));
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    const agentDir = join(home, ".pi", "agent");
    const explicitDir = join(home, "custom-agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(explicitDir);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const executable = fakePi(root);
    const check = (env: Record<string, string>) => {
      const runtime = prepareProviderRuntime(
        boundedProvider(),
        "pi",
        { HOME: home, PATH: process.env.PATH ?? "", PI_ACP_PI_COMMAND: executable, ...env },
        undefined,
        { command: executable, args: [], cwd },
      );
      runtime.cleanup();
      return runtime.reasoningPreferences;
    };
    try {
      expect(check({})).toBeUndefined();
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ thinkingBudgets: { low: 1 } }));
      expect(check({})).toBeUndefined();
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "off" }));
      expect(check({})).toEqual({});
      expect(check({ PI_CODING_AGENT_DIR: explicitDir })).toBeUndefined();
      writeFileSync(join(explicitDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
      expect(check({ PI_CODING_AGENT_DIR: "~/custom-agent" })).toEqual({});
      rmSync(join(agentDir, "settings.json"));
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "off" }));
      expect(check({})).toEqual({});
      writeFileSync(join(cwd, ".pi", "settings.json"), "malformed native settings");
      expect(check({})).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
