import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareCodexProviderRuntime } from "../server/provider-codex";
import type { ProviderSecret } from "../server/providers";

const provider: ProviderSecret = {
  id: "fixture",
  name: "Fixture provider",
  preset: "deepseek",
  openaiBaseUrl: "https://api.deepseek.com/v1",
  anthropicBaseUrl: "https://api.deepseek.com/anthropic",
  model: "deepseek-v4-pro",
  smallModel: "deepseek-flash",
  wireApi: "responses",
  apiKey: "sk-fixture-not-a-real-key",
  mgmtKey: "",
  createdAt: 0,
  updatedAt: 0,
};

const roots: string[] = [];
const runtimes: Awaited<ReturnType<typeof prepareCodexProviderRuntime>>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const prepare = async (
  p: ProviderSecret,
  env: Record<string, string>,
  launch?: Parameters<typeof prepareCodexProviderRuntime>[2],
) => {
  const runtime = await prepareCodexProviderRuntime(p, env, launch);
  runtimes.push(runtime);
  return runtime;
};

describe("Codex provider model catalog", async () => {
  test("unknown models, unrelated endpoints and non-Responses profiles keep native behavior", async () => {
    const env = { CODEX_PATH: "/not-used", CODEX_HOME: "/native", CODEX_CONFIG: '{"developer_instructions":"Native"}' };
    for (const p of [
      { ...provider, model: "unknown-model", smallModel: "" },
      { ...provider, wireApi: "chat" as const },
      { ...provider, openaiBaseUrl: "" },
      { ...provider, preset: "custom", openaiBaseUrl: "https://api.deepseek.com.example/v1" },
    ])
      expect((await prepare(p, env)).env).toBe(env);
  });

  test("uses the actual bundled CLI resolved from its adapter and excludes unknown fast models", async () => {
    const runtime = await prepare({ ...provider, smallModel: "unknown-fast" }, { PATH: "/not-a-global-codex" });
    const wrapper = runtime.env.CODEX_PATH as string;
    const require = createRequire(import.meta.url);
    const adapter = createRequire(require.resolve("@agentclientprotocol/codex-acp/package.json"));
    expect(readFileSync(wrapper, "utf8")).toContain(adapter.resolve("@openai/codex/bin/codex.js"));
    const catalog = JSON.parse(readFileSync(join(dirname(wrapper), "models.json"), "utf8"));
    const custom = catalog.models.find((model: { slug: string }) => model.slug === "deepseek-v4-pro");
    expect(catalog.models.length).toBeGreaterThan(1);
    expect(catalog.models.some((model: { slug: string }) => model.slug === "unknown-fast")).toBe(false);
    expect(custom).toMatchObject({
      default_reasoning_level: "high",
      input_modalities: ["text"],
      supports_reasoning_summary_parameter: false,
      include_apps_usage_instructions: false,
      truncation_policy: { mode: "bytes", limit: 10000 },
      context_window: 1000000,
      max_context_window: 1000000,
      effective_context_window_percent: 95,
    });
    expect(custom.model_messages.instructions_template).toStartWith("You are a coding agent");
    expect(custom.base_instructions).toBe(custom.model_messages.instructions_template);
    expect(custom.supported_reasoning_levels.map((entry: { effort: string }) => entry.effort)).toEqual([
      "none",
      "low",
      "high",
      "max",
    ]);
  });

  test.skipIf(process.platform === "win32")(
    "delegates to explicit CODEX_PATH, preserves argv and native settings, and leaves no secrets in files",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tt-codex-wrapper-"));
      roots.push(root);
      const native = join(root, "codex engine's executable");
      writeEngine(native);
      const nativeConfig =
        '{"developer_instructions":"Keep native identity","model":"deepseek-v4-pro","model_reasoning_effort":"low"}';
      const original = {
        PATH: process.env.PATH || "",
        CODEX_PATH: native,
        HOME: join(root, "native-home"),
        CODEX_HOME: join(root, "native-codex-home"),
        CODEX_CONFIG: nativeConfig,
        TUANTUAN_PROVIDER_API_KEY: provider.apiKey,
      };
      const runtime = await prepare(provider, original, { command: "/not-the-engine", args: [] });
      expect(original.CODEX_PATH).toBe(native);
      expect(runtime.env).toMatchObject({
        HOME: original.HOME,
        CODEX_HOME: original.CODEX_HOME,
        CODEX_CONFIG: nativeConfig,
      });
      const proc = Bun.spawn([runtime.env.CODEX_PATH as string, "app-server", "--listen", "stdio://"], {
        env: runtime.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const result = JSON.parse(await new Response(proc.stdout).text());
      expect(await proc.exited).toBe(0);
      expect(result).toMatchObject({ home: original.HOME, codexHome: original.CODEX_HOME, config: nativeConfig });
      expect(result.args.slice(0, 1)).toEqual(["-c"]);
      expect(result.args.slice(2)).toEqual(["app-server", "--listen", "stdio://"]);
      const catalogPath = result.args[1].slice("model_catalog_json=".length);
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
      expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual([
        "future-native-model",
        "deepseek-v4-pro",
        "deepseek-flash",
      ]);
      const temp = dirname(catalogPath);
      for (const name of readdirSync(temp)) {
        const path = join(temp, name);
        expect(readFileSync(path, "utf8")).not.toContain(provider.apiKey);
        expect(readFileSync(path, "utf8")).not.toContain("Keep native identity");
        expect(statSync(path).mode & 0o077).toBe(0);
      }
      runtime.cleanup();
      runtime.cleanup();
      expect(existsSync(temp)).toBe(false);
    },
  );

  test("an unavailable explicit CODEX_PATH fails instead of switching to another CLI", async () => {
    await expect(prepare(provider, { CODEX_PATH: "/no/such/codex", PATH: "/not-used" })).rejects.toThrow(
      "找不到 CODEX_PATH 可执行文件",
    );
  });

  test.skipIf(process.platform === "win32")(
    "managed installs use their own adapter dependency and selected Node interpreter",
    async () => {
      const fixture = adapterFixture();
      const runtime = await prepare(provider, fixture.env, { command: fixture.node, args: [fixture.adapter] });
      const result = await runFixture(runtime.env);
      expect(result.interpreter).toBe(fixture.node);
      expect(result.engine).toBe(fixture.engine);
      expect(result.args[0]).toBe("-c");
      expect(result.args[1]).toStartWith("model_catalog_json=");
      expect(result.args.slice(2)).toEqual(["app-server", "--listen", "stdio://"]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "PATH symlinks resolve the actual adapter and preserve its shebang runtime",
    async () => {
      const fixture = adapterFixture();
      symlinkSync(fixture.adapter, join(dirname(fixture.node), "codex-acp"));
      const runtime = await prepare(provider, fixture.env, { command: "codex-acp", args: [] });
      const result = await runFixture(runtime.env);
      expect(result.interpreter).toBe(fixture.node);
      expect(result.engine).toBe(fixture.engine);
      expect(result.args[1]).toStartWith("model_catalog_json=");
      expect(result.args.slice(2)).toEqual(["app-server", "--listen", "stdio://"]);
    },
  );

  test("unresolvable external adapters keep native engine resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-external-"));
    roots.push(root);
    const binary = join(root, "custom-adapter");
    const script = join(root, "custom-adapter.js");
    writeFileSync(binary, "binary fixture");
    writeFileSync(script, "#!/usr/bin/env node\n// No externally resolvable engine dependency.\n");
    const env = { PATH: process.env.PATH || "", HOME: root };
    for (const launch of [
      { command: binary, args: [] },
      { command: process.execPath, args: [script] },
      { command: "/missing/adapter", args: [] },
    ]) {
      const runtime = await prepare(provider, env, launch);
      expect(runtime.env).toBe(env);
      expect(runtime.reasoningPreferences).toBeUndefined();
    }
  });

  test("OpenRouter non-native Responses models receive only catalog-proven controls and modalities", async () => {
    const runtime = await prepare(
      {
        ...provider,
        preset: "openrouter",
        openaiBaseUrl: "https://openrouter.ai/api/v1",
        model: "anthropic/claude-sonnet-4.6",
        smallModel: "",
      },
      {},
    );
    const catalog = JSON.parse(readFileSync(join(dirname(runtime.env.CODEX_PATH as string), "models.json"), "utf8"));
    const custom = catalog.models.find((model: { slug: string }) => model.slug === "anthropic/claude-sonnet-4.6");
    expect(custom).toMatchObject({
      slug: "anthropic/claude-sonnet-4.6",
      default_reasoning_level: "high",
      context_window: 1000000,
      input_modalities: ["text", "image"],
    });
    expect(custom.supported_reasoning_levels.map((entry: { effort: string }) => entry.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  test("reasoning without verified effort choices and non-reasoning models keep native controls", async () => {
    const env = { CODEX_PATH: "/must-not-be-resolved" };
    for (const model of ["deepseek/deepseek-r1", "minimax/minimax-m2.5", "openai/gpt-4.1-mini"])
      expect((await prepare({ ...provider, preset: "openrouter", model, smallModel: "" }, env)).env).toBe(env);
  });

  test("an explicitly bound gateway alias keeps its original request model ID", async () => {
    const runtime = await prepare(
      {
        ...provider,
        preset: "custom",
        openaiBaseUrl: "https://gateway.example/v1",
        model: "my-coding-model",
        smallModel: "unknown-fast",
        modelCatalog: { "my-coding-model": "openrouter/anthropic/claude-sonnet-4.6" },
      },
      {},
    );
    const catalog = JSON.parse(readFileSync(join(dirname(runtime.env.CODEX_PATH as string), "models.json"), "utf8"));
    const custom = catalog.models.find((model: { slug: string }) => model.slug === "my-coding-model");
    expect(catalog.models.some((model: { slug: string }) => model.slug === "unknown-fast")).toBe(false);
    expect(custom.supported_reasoning_levels).toContainEqual({ effort: "medium", description: "medium" });
  });

  test("native built-in prompts remain authoritative, including namespaced and dated models", async () => {
    const env = { CODEX_PATH: "/must-not-be-resolved" };
    for (const model of ["gpt-6.1-sol", "gpt-6.1-sol-2026-10-17", "openai/gpt-5.5"]) {
      expect((await prepare({ ...provider, model, smallModel: "" }, env)).env).toBe(env);
    }
  });

  test("explicit native catalogs and invalid native configurations are not overwritten", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-native-config-"));
    roots.push(root);
    const home = join(root, "home");
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const configPath = join(codexHome, "config.toml");
    const env = { CODEX_HOME: codexHome, CODEX_PATH: "/must-not-be-resolved" };
    for (const content of [
      'model_catalog_json = "native-models.json"\n',
      '[profiles.work]\nmodel_catalog_json = "profile-models.json"\n',
      "invalid TOML [",
    ]) {
      writeFileSync(configPath, content);
      expect((await prepare(provider, env)).env).toBe(env);
      expect(readFileSync(configPath, "utf8")).toBe(content);
    }
    rmSync(configPath);
    for (const key of ["HOME", "USERPROFILE"]) {
      const inferred = { [key]: home, CODEX_PATH: "/must-not-be-resolved" };
      writeFileSync(configPath, 'model_catalog_json = "native-models.json"\n');
      expect((await prepare(provider, inferred)).env).toBe(inferred);
    }
    for (const config of [
      '{"model_catalog_json":"native-models.json"}',
      '{"profiles":{"work":{"model_catalog_json":"profile-models.json"}}}',
      "invalid JSON",
    ]) {
      const explicit = { CODEX_CONFIG: config, CODEX_PATH: "/must-not-be-resolved" };
      expect((await prepare(provider, explicit)).env).toBe(explicit);
    }
  });

  test("workspace and ancestor native catalogs keep their startup configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-project-config-"));
    roots.push(root);
    const project = join(root, "project");
    const cwd = join(project, "child");
    mkdirSync(cwd, { recursive: true });
    const content = 'model_catalog_json = "project-models.json"\n';
    const env = { CODEX_PATH: "/must-not-be-resolved" };
    for (const base of [project, cwd]) {
      mkdirSync(join(base, ".codex"));
      const config = join(base, ".codex", "config.toml");
      writeFileSync(config, content);
      expect((await prepare(provider, env, { command: "/unused", args: [], cwd })).env).toBe(env);
      expect(readFileSync(config, "utf8")).toBe(content);
      rmSync(join(base, ".codex"), { recursive: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "workspace symlinks honor the physical ancestor's native catalog",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tt-codex-project-link-"));
      roots.push(root);
      const physical = join(root, "physical");
      const child = join(physical, "child");
      const linked = join(root, "linked-child");
      mkdirSync(join(physical, ".codex"), { recursive: true });
      mkdirSync(child);
      writeFileSync(join(physical, ".codex", "config.toml"), 'model_catalog_json = "native-models.json"\n');
      symlinkSync(child, linked);
      const env = { CODEX_PATH: "/must-not-be-resolved" };
      expect((await prepare(provider, env, { command: "/unused", args: [], cwd: linked })).env).toBe(env);
    },
  );

  test("plain user effort preferences survive every native model and catalog early return", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-reasoning-user-"));
    roots.push(root);
    const configPath = join(root, "config.toml");
    const env = { CODEX_HOME: root };
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "vendor-specific"]) {
      writeFileSync(configPath, `model_reasoning_effort = "${effort}"\n`);
      const native = await prepare({ ...provider, model: "gpt-6.1-sol", smallModel: "" }, env);
      expect(native.env).toBe(env);
      expect(native.reasoningPreferences).toEqual({ reasoning_effort: effort });
    }
    writeFileSync(configPath, 'model_reasoning_effort = "low"\nmodel_catalog_json = "native-models.json"\n');
    expect((await prepare(provider, env)).reasoningPreferences).toEqual({ reasoning_effort: "low" });
    writeFileSync(configPath, 'model_reasoning_effort = "none"\n');
    for (const p of [
      { ...provider, model: "missing-model", smallModel: "" },
      { ...provider, wireApi: "chat" as const },
      { ...provider, openaiBaseUrl: "" },
    ])
      expect((await prepare(p, env)).reasoningPreferences).toEqual({ reasoning_effort: "none" });
    expect(readFileSync(configPath, "utf8")).toBe('model_reasoning_effort = "none"\n');
  });

  test("generated catalogs report explicit effort without changing config, and absence permits app defaults", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-reasoning-generated-"));
    roots.push(root);
    const configPath = join(root, "config.toml");
    const content = 'model_reasoning_effort = "low"\n';
    writeFileSync(configPath, content);
    const native = await prepare(provider, { CODEX_HOME: root });
    expect(native.env.CODEX_PATH).toBeString();
    expect(native.reasoningPreferences).toEqual({ reasoning_effort: "low" });
    expect(readFileSync(configPath, "utf8")).toBe(content);
    expect((await prepare(provider, {})).reasoningPreferences).toBeUndefined();
  });

  test("workspace effort, profiles and custom native launchers suppress auto defaults without guessing", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-reasoning-project-"));
    roots.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project", "child");
    mkdirSync(home);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, "config.toml"), 'model_reasoning_effort = "low"\n');
    const env = { CODEX_HOME: home };
    const launch = { command: "/unused", args: [], cwd };
    const builtin = { ...provider, model: "gpt-6.1-sol", smallModel: "" };
    expect((await prepare(builtin, env, launch)).reasoningPreferences).toEqual({ reasoning_effort: "low" });
    for (const path of [join(cwd, "config.toml"), join(dirname(cwd), ".codex", "config.toml")]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'model_reasoning_effort = "high"\n');
      expect((await prepare(builtin, env, launch)).reasoningPreferences).toEqual({});
      expect(
        (await prepare(builtin, { ...env, CODEX_CONFIG: '{"model_reasoning_effort":"none"}' }, launch))
          .reasoningPreferences,
      ).toEqual({ reasoning_effort: "none" });
      rmSync(path);
    }
    for (const content of [
      'model_reasoning_effort = "low"\nprofile = "work"\n',
      'model_reasoning_effort = "low"\n[profiles.work]\nmodel_reasoning_effort = "none"\n',
      'model_catalog_json = "native-models.json"\n',
      "invalid TOML [",
    ]) {
      writeFileSync(join(home, "config.toml"), content);
      expect((await prepare(builtin, env, launch)).reasoningPreferences).toEqual({});
    }
    writeFileSync(join(home, "config.toml"), 'model_reasoning_effort = "low"\n');
    expect(
      (await prepare(builtin, { ...env, CODEX_PATH: "/user-launcher-with-private-profile" }, launch))
        .reasoningPreferences,
    ).toEqual({});
    expect(
      (await prepare(builtin, { ...env, CODEX_CONFIG: '{"profile":"work"}' }, launch)).reasoningPreferences,
    ).toEqual({});
  });

  test("CODEX_CONFIG effort wins over ambiguous files and invalid explicit values never enable auto defaults", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-reasoning-env-"));
    roots.push(root);
    writeFileSync(join(root, "config.toml"), 'profile = "work"\n[profiles.work]\nmodel_reasoning_effort = "low"\n');
    const builtin = { ...provider, model: "gpt-6.1-sol", smallModel: "" };
    for (const effort of ["none", "medium", "max"])
      expect(
        (await prepare(builtin, { CODEX_HOME: root, CODEX_CONFIG: JSON.stringify({ model_reasoning_effort: effort }) }))
          .reasoningPreferences,
      ).toEqual({ reasoning_effort: effort });
    for (const config of ['{"model_reasoning_effort":null}', '{"model_reasoning_effort":""}', "invalid JSON"])
      expect((await prepare(builtin, { CODEX_CONFIG: config })).reasoningPreferences).toEqual({});
  });

  test("a direct workspace config catalog remains authoritative and keeps native effort", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-direct-config-"));
    roots.push(root);
    const content = 'model_catalog_json = "native-models.json"\nmodel_reasoning_effort = "none"\n';
    writeFileSync(join(root, "config.toml"), content);
    const env = { CODEX_PATH: "/must-not-be-resolved" };
    const runtime = await prepare(provider, env, { command: "/unused", args: [], cwd: root });
    expect(runtime.env).toBe(env);
    expect(runtime.reasoningPreferences).toEqual({});
    expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(content);
  });

  test("preserves every native descriptor and root field while using the actual generic fallback", async () => {
    const fixture = adapterFixture();
    const launch = { command: fixture.node, args: [fixture.adapter] };
    const runtime = await prepare(
      { ...provider, smallModel: "namespace/future-native-model-dated" },
      fixture.env,
      launch,
    );
    const catalog = JSON.parse(readFileSync(join(dirname(runtime.env.CODEX_PATH as string), "models.json"), "utf8"));
    expect(catalog.future_catalog_metadata).toEqual({ preserve: true });
    expect(catalog.models[0]).toEqual(nativeDescriptor);
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[1].model_messages.instructions_template).toBe(
      "Actual engine generic instructions, not any native model template.",
    );
    expect(catalog.models[1].base_instructions).toBe(catalog.models[1].model_messages.instructions_template);
    const alias = {
      ...provider,
      smallModel: "",
      model: "namespace/future-native-model-dated",
      modelCatalog: {
        "namespace/future-native-model-dated": "deepseek/deepseek-v4-pro",
      },
    };
    expect((await prepare(alias, fixture.env, launch)).env).toBe(fixture.env);
  });

  test("CLI schema filters catalog efforts, including none absent from native model presets", async () => {
    const fixture = adapterFixture();
    writeEngine(fixture.engine, { efforts: ["none", "low", "high"] });
    const runtime = await prepare(provider, fixture.env, { command: fixture.node, args: [fixture.adapter] });
    const catalog = JSON.parse(readFileSync(join(dirname(runtime.env.CODEX_PATH as string), "models.json"), "utf8"));
    const custom = catalog.models.find((model: { slug: string }) => model.slug === provider.model);
    expect(custom.supported_reasoning_levels.map((entry: { effort: string }) => entry.effort)).toEqual([
      "none",
      "low",
      "high",
    ]);
    expect(custom.default_reasoning_level).toBe("high");
    // Native descriptor data is never filtered or reconstructed by this bridge.
    expect(catalog.models[0]).toEqual(nativeDescriptor);
  });

  test("native or unknown main models allow a proven fast model to extend the native catalog", async () => {
    const fixture = adapterFixture();
    const launch = { command: fixture.node, args: [fixture.adapter] };
    for (const main of ["namespace/future-native-model-dated", "unlisted-main-model"]) {
      const runtime = await prepare({ ...provider, model: main }, fixture.env, launch);
      const catalog = JSON.parse(readFileSync(join(dirname(runtime.env.CODEX_PATH as string), "models.json"), "utf8"));
      expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual([
        "future-native-model",
        "deepseek-flash",
      ]);
      expect(catalog.models[0]).toEqual(nativeDescriptor);
      expect(catalog.models[1].base_instructions).toBe(
        "Actual engine generic instructions, not any native model template.",
      );
    }
  });

  test("current public nonempty-string effort schemas accept model-advertised levels", async () => {
    const fixture = adapterFixture();
    writeEngine(fixture.engine, { efforts: null });
    const runtime = await prepare(provider, fixture.env, { command: fixture.node, args: [fixture.adapter] });
    const catalog = JSON.parse(readFileSync(join(dirname(runtime.env.CODEX_PATH as string), "models.json"), "utf8"));
    expect(catalog.models[0]).toEqual(nativeDescriptor);
    expect(catalog.models.at(-1).supported_reasoning_levels.map((entry: { effort: string }) => entry.effort)).toEqual([
      "none",
      "low",
      "high",
      "max",
    ]);
  });

  test("isolated probes inherit neither user config nor keys and never submit a model turn", async () => {
    const fixture = adapterFixture();
    const config = '{"developer_instructions":"Private native instructions","model_reasoning_effort":"low"}';
    const env = { ...fixture.env, CODEX_CONFIG: config, TUANTUAN_PROVIDER_API_KEY: provider.apiKey };
    const runtime = await prepare(provider, env, { command: fixture.node, args: [fixture.adapter] });
    expect(runtime.env.CODEX_CONFIG).toBe(config);
    expect(runtime.reasoningPreferences).toEqual({ reasoning_effort: "low" });
    const calls = readFileSync(`${fixture.engine}.calls`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.home).not.toBe(env.HOME);
      expect(call.home).toBe(call.codexHome);
      expect(existsSync(call.home)).toBe(false);
      expect(call.config).toBeUndefined();
      expect(call.key).toBeUndefined();
    }
    // The executable fixture rejects every app-server method other than the
    // initialize/start/archive/read metadata sequence.
    expect(calls.filter((call) => call.args.includes("--bundled"))).toHaveLength(1);
  });

  test("deduplicates concurrent probes, caches an unchanged engine, and refreshes replaced code", async () => {
    const fixture = adapterFixture();
    const launch = { command: fixture.node, args: [fixture.adapter] };
    const first = await Promise.all([prepare(provider, fixture.env, launch), prepare(provider, fixture.env, launch)]);
    expect(first[0].env.CODEX_PATH).not.toBe(first[1].env.CODEX_PATH);
    const calls = () =>
      readFileSync(`${fixture.engine}.calls`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    expect(calls()).toHaveLength(3);
    await prepare(provider, fixture.env, launch);
    expect(calls()).toHaveLength(3);
    writeEngine(fixture.engine, { generic: "Updated engine generic instructions." });
    const updated = await prepare(provider, fixture.env, launch);
    expect(calls()).toHaveLength(6);
    const catalog = JSON.parse(readFileSync(join(dirname(updated.env.CODEX_PATH as string), "models.json"), "utf8"));
    expect(catalog.models.at(-1).base_instructions).toBe("Updated engine generic instructions.");
  });

  test("unsupported probe formats and unsafe rollout paths warn and preserve native configuration", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fixture = adapterFixture();
      const launch = { command: fixture.node, args: [fixture.adapter] };
      for (const broken of ["catalog", "schema", "instructions", "outside", "model"] as const) {
        writeEngine(fixture.engine, { broken });
        const runtime = await prepare(provider, fixture.env, launch);
        expect(runtime.env).toBe(fixture.env);
        expect(runtime.reasoningPreferences).toBeUndefined();
      }
      expect(warn).toHaveBeenCalledTimes(5);
      expect(warn.mock.calls.flat().join(" ")).toContain("keeping native configuration");
      expect(warn.mock.calls.flat().join(" ")).not.toContain(provider.apiKey);
      // A failed probe is never a persistent cache entry.
      writeEngine(fixture.engine);
      expect((await prepare(provider, fixture.env, launch)).env.CODEX_PATH).toBeString();
    } finally {
      warn.mockRestore();
    }
  });
});

function adapterFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tt-codex-managed-")));
  roots.push(root);
  const adapter = join(
    root,
    "managed install",
    "node_modules",
    "@agentclientprotocol",
    "codex-acp",
    "dist",
    "index.js",
  );
  const engine = join(dirname(dirname(adapter)), "node_modules", "@openai", "codex", "bin", "codex.js");
  const node = join(root, "bin", "node");
  mkdirSync(dirname(adapter), { recursive: true });
  mkdirSync(dirname(engine), { recursive: true });
  mkdirSync(dirname(node));
  writeFileSync(adapter, "#!/usr/bin/env node\n// Adapter entry fixture.\n", { mode: 0o700 });
  writeFileSync(join(dirname(dirname(engine)), "package.json"), '{"name":"@openai/codex","version":"0.160.1"}');
  writeEngine(engine);
  writeFileSync(
    node,
    `#!${process.execPath}\nconst proc = Bun.spawn([process.execPath, ...process.argv.slice(2)], {env: {...process.env, FIXTURE_INTERPRETER: process.argv[1]}, stdin: "inherit", stdout: "inherit", stderr: "inherit"}); process.exit(await proc.exited);\n`,
    { mode: 0o700 },
  );
  return { adapter, engine, node, env: { PATH: dirname(node), HOME: root } };
}

const nativeDescriptor = {
  slug: "future-native-model",
  display_name: "Native model",
  model_messages: { instructions_template: "Native model-specific instructions. Never copy to other models." },
  base_instructions: "Native model-specific instructions. Never copy to other models.",
  supported_reasoning_levels: [{ effort: "future-native-effort", description: "Future native option" }],
  default_reasoning_level: "future-native-effort",
  context_window: 987654,
  future_native_metadata: { tools: ["native-custom-tool"], keep: true },
};

type EngineOptions = {
  generic?: string;
  efforts?: string[] | null;
  broken?: "catalog" | "schema" | "instructions" | "outside" | "model";
};

function writeEngine(path: string, options: EngineOptions = {}) {
  const script = `#!${process.execPath}
import {mkdirSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2);
const opts=${JSON.stringify(options)};
const catalog={models:[${JSON.stringify(nativeDescriptor)}],future_catalog_metadata:{preserve:true}};
const log=${JSON.stringify(`${path}.calls`)};
appendFileSync(log,JSON.stringify({args,home:process.env.HOME,codexHome:process.env.CODEX_HOME,config:process.env.CODEX_CONFIG,key:process.env.TUANTUAN_PROVIDER_API_KEY})+'\\n');
if(args.includes('--bundled')) {
 console.log(opts.broken==='catalog'?'{}':JSON.stringify(catalog));
} else if(args.includes('generate-json-schema')) {
 const out=args[args.indexOf('--out')+1];mkdirSync(join(out,'v2'),{recursive:true});
 writeFileSync(join(out,'v2','ModelListResponse.json'),JSON.stringify({definitions:{ReasoningEffort:opts.efforts===null?{type:'string',minLength:1}:{enum:opts.broken==='schema'?[]:opts.efforts??['none','minimal','low','medium','high','xhigh','max']}}}));
} else if(args.some(arg=>arg==='model_provider="tuantuan_metadata_probe"')) {
 let threadId='fixture-thread';let file=join(process.env.CODEX_HOME,'archived_sessions','probe.jsonl');
 const rl=createInterface({input:process.stdin});
 for await(const line of rl){const req=JSON.parse(line);if(req.id===undefined)continue;let result={};
 if(req.method==='thread/start')result={model:opts.broken==='model'?'future-native-model':req.params.model,modelProvider:req.params.modelProvider,thread:{id:threadId,model:req.params.model}};
 else if(req.method==='thread/archive'){
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:threadId,base_instructions:{text:opts.broken==='instructions'?'':opts.generic??'Actual engine generic instructions, not any native model template.'}}})+'\\n');
 } else if(req.method==='thread/read')result={thread:{path:opts.broken==='outside'?${JSON.stringify(path)}:file}};
 else if(req.method!=='initialize')throw new Error('Unexpected probe method '+req.method);
 console.log(JSON.stringify({id:req.id,result}));}
} else console.log(JSON.stringify({engine:process.argv[1],interpreter:process.env.FIXTURE_INTERPRETER,args,home:process.env.HOME,codexHome:process.env.CODEX_HOME,config:process.env.CODEX_CONFIG}));
`;
  writeFileSync(path, script, { mode: 0o700 });
}

async function runFixture(env: Record<string, string>) {
  const proc = Bun.spawn([env.CODEX_PATH as string, "app-server", "--listen", "stdio://"], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return JSON.parse(output) as { engine: string; interpreter: string; args: string[] };
}
