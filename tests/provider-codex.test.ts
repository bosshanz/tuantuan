import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
const runtimes: ReturnType<typeof prepareCodexProviderRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const prepare = (
  p: ProviderSecret,
  env: Record<string, string>,
  launch?: Parameters<typeof prepareCodexProviderRuntime>[2],
) => {
  const runtime = prepareCodexProviderRuntime(p, env, launch);
  runtimes.push(runtime);
  return runtime;
};

describe("Codex provider model catalog", () => {
  test("unknown models, unrelated endpoints and non-Responses profiles keep native behavior", () => {
    const env = { CODEX_PATH: "/not-used", CODEX_HOME: "/native", CODEX_CONFIG: '{"developer_instructions":"Native"}' };
    for (const p of [
      { ...provider, model: "unknown-model" },
      { ...provider, wireApi: "chat" as const },
      { ...provider, openaiBaseUrl: "" },
      { ...provider, preset: "custom", openaiBaseUrl: "https://api.deepseek.com.example/v1" },
    ])
      expect(prepare(p, env).env).toBe(env);
  });

  test("uses the bundled CLI resolved from the pinned adapter and excludes unknown fast models", () => {
    const runtime = prepare({ ...provider, smallModel: "unknown-fast" }, { PATH: "/not-a-global-codex" });
    const wrapper = runtime.env.CODEX_PATH as string;
    const require = createRequire(import.meta.url);
    const adapter = createRequire(require.resolve("@agentclientprotocol/codex-acp/package.json"));
    expect(readFileSync(wrapper, "utf8")).toContain(adapter.resolve("@openai/codex/bin/codex.js"));
    const catalog = JSON.parse(readFileSync(join(dirname(wrapper), "models.json"), "utf8"));
    expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual(["deepseek-v4-pro"]);
    expect(catalog.models[0]).toMatchObject({
      default_reasoning_level: "high",
      input_modalities: ["text"],
      supports_reasoning_summary_parameter: false,
      include_apps_usage_instructions: false,
      truncation_policy: { mode: "bytes", limit: 10000 },
      context_window: 1000000,
      max_context_window: 1000000,
      effective_context_window_percent: 95,
    });
    const instructions = catalog.models[0].model_messages.instructions_template;
    expect(createHash("sha256").update(instructions).digest("hex")).toBe(
      "ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807",
    );
    expect(catalog.models[0].supported_reasoning_levels.map((entry: { effort: string }) => entry.effort)).toEqual([
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
      writeFileSync(
        native,
        `#!${process.execPath}\nconsole.log(JSON.stringify({args: process.argv.slice(2), home: process.env.HOME, codexHome: process.env.CODEX_HOME, config: process.env.CODEX_CONFIG}));\n`,
        { mode: 0o700 },
      );
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
      const runtime = prepare(provider, original, { command: "/not-the-engine", args: [] });
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

  test("an unavailable explicit CODEX_PATH fails instead of switching to another CLI", () => {
    expect(() => prepare(provider, { CODEX_PATH: "/no/such/codex", PATH: "/not-used" })).toThrow(
      "找不到 CODEX_PATH 可执行文件",
    );
  });

  test.skipIf(process.platform === "win32")(
    "managed installs use their own adapter dependency and selected Node interpreter",
    async () => {
      const fixture = adapterFixture();
      const runtime = prepare(provider, fixture.env, { command: fixture.node, args: [fixture.adapter] });
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
      const runtime = prepare(provider, fixture.env, { command: "codex-acp", args: [] });
      const result = await runFixture(runtime.env);
      expect(result.interpreter).toBe(fixture.node);
      expect(result.engine).toBe(fixture.engine);
      expect(result.args[1]).toStartWith("model_catalog_json=");
      expect(result.args.slice(2)).toEqual(["app-server", "--listen", "stdio://"]);
    },
  );

  test("unresolvable external adapters keep native engine resolution", () => {
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
      const runtime = prepare(provider, env, launch);
      expect(runtime.env).toBe(env);
      expect(runtime.reasoningPreferences).toBeUndefined();
    }
  });

  test("OpenRouter non-native Responses models receive only catalog-proven controls and modalities", () => {
    const runtime = prepare(
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
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      slug: "anthropic/claude-sonnet-4.6",
      default_reasoning_level: "high",
      context_window: 1000000,
      input_modalities: ["text", "image"],
    });
    expect(catalog.models[0].supported_reasoning_levels.map((entry: { effort: string }) => entry.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  test("reasoning without verified effort choices and non-reasoning models keep native controls", () => {
    const env = { CODEX_PATH: "/must-not-be-resolved" };
    for (const model of ["deepseek/deepseek-r1", "minimax/minimax-m2.5", "openai/gpt-4.1-mini"])
      expect(prepare({ ...provider, preset: "openrouter", model, smallModel: "" }, env).env).toBe(env);
  });

  test("an explicitly bound gateway alias keeps its original request model ID", () => {
    const runtime = prepare(
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
    expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual(["my-coding-model"]);
    expect(catalog.models[0].supported_reasoning_levels).toContainEqual({ effort: "medium", description: "medium" });
  });

  test("native built-in prompts remain authoritative, including namespaced, dated and mixed profiles", () => {
    const env = { CODEX_PATH: "/must-not-be-resolved" };
    for (const model of ["gpt-6.1-sol", "gpt-6.1-sol-2026-10-17", "openai/gpt-5.5"]) {
      expect(prepare({ ...provider, model }, env).env).toBe(env);
      expect(prepare({ ...provider, smallModel: model }, env).env).toBe(env);
    }
  });

  test("explicit native catalogs and invalid native configurations are not overwritten", () => {
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
      expect(prepare(provider, env).env).toBe(env);
      expect(readFileSync(configPath, "utf8")).toBe(content);
    }
    rmSync(configPath);
    for (const key of ["HOME", "USERPROFILE"]) {
      const inferred = { [key]: home, CODEX_PATH: "/must-not-be-resolved" };
      writeFileSync(configPath, 'model_catalog_json = "native-models.json"\n');
      expect(prepare(provider, inferred).env).toBe(inferred);
    }
    for (const config of [
      '{"model_catalog_json":"native-models.json"}',
      '{"profiles":{"work":{"model_catalog_json":"profile-models.json"}}}',
      "invalid JSON",
    ]) {
      const explicit = { CODEX_CONFIG: config, CODEX_PATH: "/must-not-be-resolved" };
      expect(prepare(provider, explicit).env).toBe(explicit);
    }
  });

  test("workspace and ancestor native catalogs keep their startup configuration", () => {
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
      expect(prepare(provider, env, { command: "/unused", args: [], cwd }).env).toBe(env);
      expect(readFileSync(config, "utf8")).toBe(content);
      rmSync(join(base, ".codex"), { recursive: true });
    }
  });

  test.skipIf(process.platform === "win32")("workspace symlinks honor the physical ancestor's native catalog", () => {
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
    expect(prepare(provider, env, { command: "/unused", args: [], cwd: linked }).env).toBe(env);
  });

  test("plain user effort preferences survive every native model and catalog early return", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-reasoning-user-"));
    roots.push(root);
    const configPath = join(root, "config.toml");
    const env = { CODEX_HOME: root };
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "vendor-specific"]) {
      writeFileSync(configPath, `model_reasoning_effort = "${effort}"\n`);
      const native = prepare({ ...provider, model: "gpt-6.1-sol" }, env);
      expect(native.env).toBe(env);
      expect(native.reasoningPreferences).toEqual({ reasoning_effort: effort });
    }
    writeFileSync(configPath, 'model_reasoning_effort = "low"\nmodel_catalog_json = "native-models.json"\n');
    expect(prepare(provider, env).reasoningPreferences).toEqual({ reasoning_effort: "low" });
    writeFileSync(configPath, 'model_reasoning_effort = "none"\n');
    for (const p of [
      { ...provider, model: "missing-model" },
      { ...provider, wireApi: "chat" as const },
      { ...provider, openaiBaseUrl: "" },
    ])
      expect(prepare(p, env).reasoningPreferences).toEqual({ reasoning_effort: "none" });
    expect(readFileSync(configPath, "utf8")).toBe('model_reasoning_effort = "none"\n');
  });

  test("generated catalogs report explicit effort without changing config, and absence permits app defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-reasoning-generated-"));
    roots.push(root);
    const configPath = join(root, "config.toml");
    const content = 'model_reasoning_effort = "low"\n';
    writeFileSync(configPath, content);
    const native = prepare(provider, { CODEX_HOME: root });
    expect(native.env.CODEX_PATH).toBeString();
    expect(native.reasoningPreferences).toEqual({ reasoning_effort: "low" });
    expect(readFileSync(configPath, "utf8")).toBe(content);
    expect(prepare(provider, {}).reasoningPreferences).toBeUndefined();
  });

  test("workspace effort, profiles and custom native launchers suppress auto defaults without guessing", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-reasoning-project-"));
    roots.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project", "child");
    mkdirSync(home);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, "config.toml"), 'model_reasoning_effort = "low"\n');
    const env = { CODEX_HOME: home };
    const launch = { command: "/unused", args: [], cwd };
    const builtin = { ...provider, model: "gpt-6.1-sol" };
    expect(prepare(builtin, env, launch).reasoningPreferences).toEqual({ reasoning_effort: "low" });
    for (const path of [join(cwd, "config.toml"), join(dirname(cwd), ".codex", "config.toml")]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'model_reasoning_effort = "high"\n');
      expect(prepare(builtin, env, launch).reasoningPreferences).toEqual({});
      expect(
        prepare(builtin, { ...env, CODEX_CONFIG: '{"model_reasoning_effort":"none"}' }, launch).reasoningPreferences,
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
      expect(prepare(builtin, env, launch).reasoningPreferences).toEqual({});
    }
    writeFileSync(join(home, "config.toml"), 'model_reasoning_effort = "low"\n');
    expect(
      prepare(builtin, { ...env, CODEX_PATH: "/user-launcher-with-private-profile" }, launch).reasoningPreferences,
    ).toEqual({});
    expect(prepare(builtin, { ...env, CODEX_CONFIG: '{"profile":"work"}' }, launch).reasoningPreferences).toEqual({});
  });

  test("CODEX_CONFIG effort wins over ambiguous files and invalid explicit values never enable auto defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-reasoning-env-"));
    roots.push(root);
    writeFileSync(join(root, "config.toml"), 'profile = "work"\n[profiles.work]\nmodel_reasoning_effort = "low"\n');
    const builtin = { ...provider, model: "gpt-6.1-sol" };
    for (const effort of ["none", "medium", "max"])
      expect(
        prepare(builtin, { CODEX_HOME: root, CODEX_CONFIG: JSON.stringify({ model_reasoning_effort: effort }) })
          .reasoningPreferences,
      ).toEqual({ reasoning_effort: effort });
    for (const config of ['{"model_reasoning_effort":null}', '{"model_reasoning_effort":""}', "invalid JSON"])
      expect(prepare(builtin, { CODEX_CONFIG: config }).reasoningPreferences).toEqual({});
  });

  test("a direct workspace config catalog remains authoritative and keeps native effort", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-codex-direct-config-"));
    roots.push(root);
    const content = 'model_catalog_json = "native-models.json"\nmodel_reasoning_effort = "none"\n';
    writeFileSync(join(root, "config.toml"), content);
    const env = { CODEX_PATH: "/must-not-be-resolved" };
    const runtime = prepare(provider, env, { command: "/unused", args: [], cwd: root });
    expect(runtime.env).toBe(env);
    expect(runtime.reasoningPreferences).toEqual({});
    expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(content);
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
  writeFileSync(
    engine,
    "console.log(JSON.stringify({engine: process.argv[1], interpreter: process.env.FIXTURE_INTERPRETER, args: process.argv.slice(2)}));\n",
  );
  writeFileSync(
    node,
    `#!${process.execPath}\nconst proc = Bun.spawn([process.execPath, ...process.argv.slice(2)], {env: {...process.env, FIXTURE_INTERPRETER: process.argv[1]}, stdin: "ignore", stdout: "inherit", stderr: "inherit"}); process.exit(await proc.exited);\n`,
    { mode: 0o700 },
  );
  return { adapter, engine, node, env: { PATH: dirname(node), HOME: root } };
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
