import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  test("other harnesses retain the original environment", () => {
    const env = { HOME: "/native/home", OTHER: "value" };
    const runtime = prepareProviderRuntime(profile, "codex", env);
    expect(runtime.env).toBe(env);
    runtime.cleanup();
    expect(providerRuntimeModel("company/model")).toBe("tuantuan/company/model");
  });

  for (const version of ["1.19.0", "opencode v2.0.29", undefined]) {
    test(`OpenCode ${version ?? "unknown"} preserves unrelated config while selecting the profile`, () => {
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
      const runtime = prepareProviderRuntime(profile, "opencode", env, version);
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
    test(`OpenCode selects ${npm} for the chosen wire protocol`, () => {
      const p = { ...profile, wireApi, openaiBaseUrl, smallModel: profile.model };
      const v1 = prepareProviderRuntime(p, "opencode", {}, "1.19.0");
      const c1 = JSON.parse(v1.env.OPENCODE_CONFIG_CONTENT as string);
      expect(c1.provider.tuantuan.npm).toBe(npm);
      expect(c1.provider.tuantuan.options.baseURL).toBe(
        openaiBaseUrl ? "https://fixture.invalid/v1" : "https://fixture.invalid/anthropic/v1",
      );
      expect(Object.keys(c1.provider.tuantuan.models)).toEqual([profile.model]);
      const v2 = prepareProviderRuntime(p, "opencode", {}, "2.0.29");
      const c2 = JSON.parse(v2.env.OPENCODE_CONFIG_CONTENT as string);
      expect(c2.providers.tuantuan.package).toBe(v2Package);
      expect(c2.providers.tuantuan.settings.baseURL).toBe(c1.provider.tuantuan.options.baseURL);
      expect(c2.providers.tuantuan.settings.apiKey).toBe("{env:TUANTUAN_PROVIDER_API_KEY}");
    });
  }

  test("invalid inherited config and missing required fields fail visibly", () => {
    expect(() => prepareProviderRuntime(profile, "opencode", { OPENCODE_CONFIG_CONTENT: "[]" })).toThrow();
    expect(() => prepareProviderRuntime(profile, "opencode", { OPENCODE_CONFIG_CONTENT: "{" })).toThrow();
    expect(() => prepareProviderRuntime({ ...profile, model: "" }, "pi", {})).toThrow("主模型");
    expect(() => prepareProviderRuntime({ ...profile, anthropicBaseUrl: "", openaiBaseUrl: "" }, "pi", {})).toThrow(
      "API 地址",
    );
    expect(() => prepareProviderRuntime(profile, "pi", { PATH: "/missing/pi" })).toThrow("找不到 Pi");
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
      const runtime = prepareProviderRuntime({ ...profile, model }, "pi", original);
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
