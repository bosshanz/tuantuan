import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareProviderRuntime, providerRuntimeModel } from "../server/provider-runtime";
import type { ProviderSecret } from "../server/providers";

const profile: ProviderSecret = {
  id: "p1",
  name: "Runtime fixture",
  preset: "custom",
  anthropicBaseUrl: "https://fixture.invalid/anthropic/",
  openaiBaseUrl: "https://fixture.invalid/v1/",
  apiKey: "sk-runtime-fixture",
  mgmtKey: "",
  model: "company/main",
  smallModel: "company/fast",
  wireApi: "chat",
  createdAt: 0,
  updatedAt: 0,
};

describe("process-local provider runtime", () => {
  test("other harnesses retain the original environment", async () => {
    const env = { HOME: "/native/home", OTHER: "value" };
    const runtime = await prepareProviderRuntime(profile, "codex", env);
    expect(runtime.env).toBe(env);
    runtime.cleanup();
    expect(providerRuntimeModel("company/model")).toBe("tuantuan/company/model");
  });

  for (const version of ["1.19.0", "opencode v2.0.29"]) {
    test(`OpenCode ${version ?? "unknown"} preserves unrelated config while selecting the profile`, async () => {
      const env = {
        HOME: "/native/home",
        OPENCODE_CONFIG_CONTENT: `{
          // The login shell can provide JSONC, just like OpenCode's config files.
          "model": "native/old",
          "provider": { "native": { "name": "Native V1" } },
          "providers": { "native": { "name": "Native V2" } },
          "agents": { "title": { "system": "keep this instruction" } },
          "enabled_providers": ["native"],
          "disabled_providers": ["tuantuan", "old"],
          "mcp": { "servers": {} },
        }`,
      };
      const runtime = await prepareProviderRuntime(profile, "opencode", env, version);
      const config = JSON.parse(runtime.env.OPENCODE_CONFIG_CONTENT as string);
      expect(config.model).toBe("tuantuan/company/main");
      expect(config.provider.native.name).toBe("Native V1");
      expect(config.providers.native.name).toBe("Native V2");
      expect(config.mcp).toEqual({ servers: {} });
      expect(runtime.env.HOME).toBe(env.HOME);
      expect(runtime.env.TUANTUAN_PROVIDER_API_KEY).toBe(profile.apiKey);
      expect(runtime.env.OPENCODE_CONFIG_CONTENT).not.toContain(profile.apiKey);
      expect(env).not.toHaveProperty("TUANTUAN_PROVIDER_API_KEY");
      if (version?.includes("v2")) {
        expect(config.providers.tuantuan.package).toBe("@opencode/ai/providers/openai-compatible");
        expect(config.providers.tuantuan.settings.baseURL).toBe("https://fixture.invalid/v1");
        expect(config.agents.title).toEqual({
          system: "keep this instruction",
          model: "tuantuan/company/fast",
        });
        expect(config.enabled_providers).toEqual(["native", "tuantuan"]);
        expect(config.disabled_providers).toEqual(["old"]);
      } else {
        expect(config.provider.tuantuan.npm).toBe("@ai-sdk/openai-compatible");
        expect(config.provider.tuantuan.options.baseURL).toBe("https://fixture.invalid/v1");
        expect(config.small_model).toBe("tuantuan/company/fast");
        expect(config.enabled_providers).toEqual(["native", "tuantuan"]);
        expect(config.disabled_providers).toEqual(["old"]);
      }
      runtime.cleanup();
    });
  }

  for (const [wireApi, openaiBaseUrl, npm, v2Package] of [
    ["responses", profile.openaiBaseUrl, "@ai-sdk/openai", "@opencode/ai/providers/openai-compatible/responses"],
    ["chat", "", "@ai-sdk/anthropic", "@opencode/ai/providers/anthropic-compatible"],
  ] as const) {
    test(`OpenCode selects ${npm} for the chosen wire protocol`, async () => {
      const p = { ...profile, wireApi, openaiBaseUrl, smallModel: profile.model };
      const v1 = await prepareProviderRuntime(p, "opencode", {}, "1.19.0");
      const c1 = JSON.parse(v1.env.OPENCODE_CONFIG_CONTENT as string);
      expect(c1.provider.tuantuan.npm).toBe(npm);
      expect(c1.provider.tuantuan.options.baseURL).toBe(
        openaiBaseUrl ? "https://fixture.invalid/v1" : "https://fixture.invalid/anthropic/v1",
      );
      expect(Object.keys(c1.provider.tuantuan.models)).toEqual([profile.model]);
      const v2 = await prepareProviderRuntime(p, "opencode", {}, "2.0.29");
      const c2 = JSON.parse(v2.env.OPENCODE_CONFIG_CONTENT as string);
      expect(c2.providers.tuantuan.package).toBe(v2Package);
      expect(c2.providers.tuantuan.settings.baseURL).toBe(c1.provider.tuantuan.options.baseURL);
      expect(c2.providers.tuantuan.settings.apiKey).toBe("{env:TUANTUAN_PROVIDER_API_KEY}");
    });
  }

  test("invalid inherited config and missing required fields fail visibly", async () => {
    await expect(prepareProviderRuntime(profile, "opencode", { OPENCODE_CONFIG_CONTENT: "[]" })).rejects.toThrow();
    await expect(prepareProviderRuntime(profile, "opencode", { OPENCODE_CONFIG_CONTENT: "{" })).rejects.toThrow();
    await expect(prepareProviderRuntime({ ...profile, model: "" }, "pi", {})).rejects.toThrow("主模型");
    await expect(
      prepareProviderRuntime({ ...profile, anthropicBaseUrl: "", openaiBaseUrl: "" }, "pi", {}),
    ).rejects.toThrow("API 地址");
    await expect(prepareProviderRuntime(profile, "pi", { PATH: "/missing/pi" })).rejects.toThrow("找不到 Pi");
  });

  test.skipIf(process.platform === "win32")(
    "Pi wrapper preserves native paths and arbitrary argv, loads a secret-free extension and cleans up",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tt-pi-launcher-"));
      const fakePi = join(root, "pi engine's executable");
      writeFileSync(
        fakePi,
        `#!${process.execPath}
const args = process.argv.slice(2);
const extension = args[args.indexOf('--extension') + 1];
const { default: setup } = await import(extension);
let registration;
setup({ registerProvider(id, config) { registration = { id, config }; } });
console.log(JSON.stringify({ args, registration, home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR }));
`,
        { mode: 0o700 },
      );
      const model = "company/model'; printf never-execute";
      const original = {
        HOME: join(root, "native-home"),
        PI_CODING_AGENT_DIR: join(root, "native-agent-dir"),
        PI_ACP_PI_COMMAND: fakePi,
        PATH: process.env.PATH || "",
      };
      const runtime = await prepareProviderRuntime({ ...profile, model }, "pi", original);
      const dir = dirname(runtime.env.PI_ACP_PI_COMMAND as string);
      try {
        expect(runtime.env.HOME).toBe(original.HOME);
        expect(runtime.env.PI_CODING_AGENT_DIR).toBe(original.PI_CODING_AGENT_DIR);
        for (const file of readdirSync(dir)) {
          const path = join(dir, file);
          expect(readFileSync(path, "utf8")).not.toContain(profile.apiKey);
          expect(statSync(path).mode & 0o077).toBe(0);
        }
        const argv = ["--mode", "rpc", "--no-themes", "--session", "/native/session with 'quote'.jsonl"];
        const child = Bun.spawn([runtime.env.PI_ACP_PI_COMMAND as string, ...argv], {
          env: runtime.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        const result = JSON.parse(output);
        expect(result.args.slice(-argv.length)).toEqual(argv);
        expect(result.args.slice(2, 6)).toEqual(["--provider", "tuantuan", "--model", model]);
        expect(result.registration.id).toBe("tuantuan");
        expect(result.registration.config.apiKey).toBe(profile.apiKey);
        expect(result.registration.config.baseUrl).toBe("https://fixture.invalid/v1");
        expect(result.registration.config.api).toBe("openai-completions");
        expect(result.registration.config.models.map((m: { id: string }) => m.id)).toEqual([model, profile.smallModel]);
        expect(result.home).toBe(original.HOME);
        expect(result.agentDir).toBe(original.PI_CODING_AGENT_DIR);
      } finally {
        runtime.cleanup();
        runtime.cleanup();
        rmSync(root, { recursive: true, force: true });
      }
      expect(existsSync(dir)).toBe(false);
    },
  );
});

test.skipIf(process.platform !== "darwin")(
  "unknown OpenCode versions negotiate the native config shape and invalidate cached results after an engine replacement",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-opencode-shape-"));
    const executable = join(root, "opencode");
    const modeFile = join(root, "mode");
    const callsFile = join(root, "calls.jsonl");
    const home = join(root, "native-home");
    mkdirSync(home);
    const nativeSettings = join(home, "native-settings.json");
    writeFileSync(nativeSettings, "do not modify native configuration");
    writeFileSync(modeFile, "v2");
    writeFileSync(
      executable,
      `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8");
const args = process.argv.slice(2);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "null");
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, home: process.env.HOME, leaked: !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.TUANTUAN_PROVIDER_API_KEY), config }) + "\\n");
if (args[0] === "service") {
  if (mode === "no-service") process.exit(1);
  mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true });
  writeFileSync(process.env.OPENCODE_CONFIG_DIR + "/service.json", '{"disabled":true}');
  process.exit(0);
}
if (!JSON.parse(readFileSync(process.env.OPENCODE_CONFIG_DIR + "/service.json", "utf8")).disabled) process.exit(2);
if (mode === "v2") console.log(JSON.stringify([{ type: "document", info: { providers: config.providers } }]));
else if (mode === "v1") console.log(JSON.stringify({ provider: config.provider }));
else console.log(JSON.stringify({ providers: { tuantuan_schema_probe: { name: "tuantuan_schema_probe", models: { tuantuan_schema_probe: { variants: "future-incompatible-shape" } } } } }));
`,
      { mode: 0o700 },
    );
    const calls = () =>
      readFileSync(callsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const env = {
      HOME: home,
      PATH: process.env.PATH ?? "",
      OPENAI_API_KEY: "do-not-pass",
      ANTHROPIC_AUTH_TOKEN: "do-not-pass",
    };
    const prepare = () =>
      prepareProviderRuntime(profile, "opencode", env, "opencode v99.0.0", { command: executable, args: ["acp"] });
    try {
      const initial = await Promise.all([prepare(), prepare()]);
      expect(
        initial.every((runtime) => JSON.parse(runtime.env.OPENCODE_CONFIG_CONTENT as string).providers.tuantuan),
      ).toBe(true);
      expect(calls()).toHaveLength(2);
      for (const runtime of initial) runtime.cleanup();
      writeFileSync(modeFile, "v1");
      appendFileSync(executable, "\n// changed engine implementation\n");
      const v1 = await prepare();
      expect(JSON.parse(v1.env.OPENCODE_CONFIG_CONTENT as string).provider.tuantuan).toBeDefined();
      expect(calls()).toHaveLength(5);
      v1.cleanup();
      writeFileSync(modeFile, "unsupported");
      appendFileSync(executable, "\n// unsupported future implementation\n");
      await expect(prepare()).rejects.toThrow("OpenCode 服务商配置格式未确认");
      expect(calls()).toHaveLength(8);
      writeFileSync(modeFile, "no-service");
      appendFileSync(executable, "\n// no safe service lifecycle\n");
      await expect(prepare()).rejects.toThrow("无法为 OpenCode 配置探测禁用后台服务");
      expect(calls()).toHaveLength(9);
      for (const call of calls()) {
        expect(call.args).toEqual(call.config ? ["debug", "config"] : ["service", "set", "disabled", "true"]);
        expect(call.leaked).toBe(false);
        expect(call.home).not.toBe(home);
        expect(existsSync(call.home)).toBe(false);
        expect(JSON.stringify(call.config)).not.toContain(profile.apiKey);
      }
      expect(readFileSync(nativeSettings, "utf8")).toBe("do not modify native configuration");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
