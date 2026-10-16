import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelCapabilities } from "./model-capabilities";
import { resolveModelCapabilities } from "./model-catalog";
import genericInstructions from "./provider-codex-prompt-0.160.1.txt";
import type { ProviderSecret } from "./providers";

// Preserve the native descriptors (including their coding instructions). This
// matches rust-v0.160.1 models-manager/models.json and manager.rs prefix lookup.
const bundledModels = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-daybreak-blue-latest",
  "gpt-daybreak-red-latest",
  "gpt-5.5",
  "codex-auto-review",
];

/** Model metadata is loaded by the app server at startup, before any ACP session exists. */
export function prepareCodexProviderRuntime(
  provider: ProviderSecret,
  env: Record<string, string>,
  adapterLaunch?: { command: string; args: string[]; cwd?: string },
): {
  env: Record<string, string>;
  cleanup: () => void;
  /** Undefined allows app defaults. An object preserves native intent; {} keeps the ACP's actual value. */
  reasoningPreferences?: Record<string, string>;
} {
  const native = nativeConfiguration(env, adapterLaunch?.cwd);
  const unchanged = { env, cleanup: () => {}, reasoningPreferences: native.reasoningPreferences };
  if (provider.wireApi !== "responses" || !provider.openaiBaseUrl) return unchanged;
  const ids = [...new Set([provider.model, provider.smallModel].filter(Boolean))];
  if (ids.some(hasBundledModel) || native.catalog) return unchanged;
  const main = resolveModelCapabilities(provider, provider.model, "openai-responses");
  if (!main || !nativeEfforts(main).length) return unchanged;
  const models = ids
    .map((id) => {
      const capabilities = resolveModelCapabilities(provider, id, "openai-responses");
      return capabilities ? { ...capabilities, modelId: id } : null;
    })
    .filter((model): model is ModelCapabilities => !!model && nativeEfforts(model).length > 0);
  const command = codexCommand(env, adapterLaunch);
  if (!command) return unchanged;
  const dir = mkdtempSync(join(tmpdir(), "tuantuan-codex-provider-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const catalog = join(dir, "models.json");
    writeFileSync(
      catalog,
      JSON.stringify({
        models: models.map((model, priority) => ({
          slug: model.modelId,
          display_name: model.modelId,
          // Preserve the pinned CLI's unknown-model coding instructions verbatim.
          // Source (Apache-2.0, accompanying LICENSE/NOTICE):
          // https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/models-manager/prompt.md
          // Its fallback descriptor is in src/model_info.rs beside that prompt.
          // Native model_instructions_file/developer_instructions still override
          // or extend this through the ordinary session configuration.
          model_messages: { instructions_template: genericInstructions },
          default_reasoning_level: defaultEffort(model),
          supported_reasoning_levels: nativeEfforts(model).map((effort) => ({
            effort,
            description: effort,
          })),
          shell_type: "unified_exec",
          visibility: "list",
          supported_in_api: true,
          priority: 99 + priority,
          include_apps_usage_instructions: false,
          support_verbosity: false,
          supports_reasoning_summary_parameter: false,
          truncation_policy: { mode: "bytes", limit: 10000 },
          ...(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
            ? { context_window: model.contextWindow, max_context_window: model.contextWindow }
            : {}),
          effective_context_window_percent: 95,
          input_modalities: model.input,
          experimental_supported_tools: [],
        })),
      }),
      { mode: 0o600 },
    );
    const wrapper = join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
    // codex-acp 2.2.2 passes CODEX_CONFIG to thread/start, but model_catalog_json
    // is a process setting. Keep native CODEX_HOME/config.toml/auth.json in place.
    // Codex treats a -c value that is not valid TOML as a literal string. Passing
    // the absolute path as one argv item also avoids nested quotes in cmd.exe.
    const argv = [...command, "-c", `model_catalog_json=${catalog}`];
    writeFileSync(
      wrapper,
      process.platform === "win32"
        ? `@echo off\r\n@setlocal DisableDelayedExpansion\r\n${argv.map(batchQuote).join(" ")} %*\r\n`
        : `#!/bin/sh\nexec ${argv.map(shellQuote).join(" ")} "$@"\n`,
      { mode: 0o700 },
    );
    return { env: { ...env, CODEX_PATH: wrapper }, cleanup, reasoningPreferences: native.reasoningPreferences };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function codexCommand(
  env: Record<string, string>,
  adapterLaunch?: { command: string; args: string[]; cwd?: string },
): string[] | null {
  if (env.CODEX_PATH) {
    const executable = Bun.which(env.CODEX_PATH, { PATH: env.PATH });
    if (!executable) throw new Error(`找不到 CODEX_PATH 可执行文件：${env.CODEX_PATH}`);
    return [executable];
  }
  if (adapterLaunch) {
    try {
      const script = adapterLaunch.args[0];
      const hasInterpreter = script && /\.[cm]?js$/i.test(script);
      const entry = realpathSync(
        hasInterpreter ? script : (Bun.which(adapterLaunch.command, { PATH: env.PATH }) ?? adapterLaunch.command),
      );
      if (!/\.[cm]?js$/i.test(entry)) return null;
      // Managed installs already selected their Node/Bun interpreter. For an
      // executable npm bin (often a PATH symlink), use its own simple shebang.
      const interpreter = hasInterpreter
        ? adapterLaunch.command
        : readFileSync(entry, "utf8")
            .split("\n", 1)[0]
            ?.match(/^#!\s*(?:\/usr\/bin\/env\s+)?(\S+)\s*$/)?.[1];
      const runtime = interpreter ? Bun.which(interpreter, { PATH: env.PATH }) : null;
      if (!runtime) return null;
      return [runtime, createRequire(entry).resolve("@openai/codex/bin/codex.js")];
    } catch {
      // External binary adapters can keep private/embedded engine resolution.
      // Never replace that engine with an unrelated project or global Codex.
      return null;
    }
  }
  // Resolve from the adapter, just as its own startCodexConnection does. An
  // unrelated globally installed codex can use a different catalog schema.
  const require = createRequire(import.meta.url);
  const adapter = createRequire(require.resolve("@agentclientprotocol/codex-acp/package.json"));
  return [process.execPath, adapter.resolve("@openai/codex/bin/codex.js")];
}

function nativeEfforts(model: ModelCapabilities): string[] {
  if (!model.reasoning || !model.effort) return [];
  return [
    ...new Set(model.levels.filter((level) => level !== "on").map((level) => (level === "off" ? "none" : level))),
  ];
}

function defaultEffort(model: ModelCapabilities): string | undefined {
  const efforts = nativeEfforts(model);
  const preferred = model.defaultLevel === "off" ? "none" : model.defaultLevel;
  return preferred && efforts.includes(preferred) ? preferred : efforts[0];
}

function hasBundledModel(id: string): boolean {
  const suffix = /^[A-Za-z0-9_-]+\/([^/]+)$/.exec(id)?.[1];
  return bundledModels.some((model) => id.startsWith(model) || suffix?.startsWith(model));
}

function nativeConfiguration(
  env: Record<string, string>,
  cwd?: string,
): { catalog: boolean; reasoningPreferences: Record<string, string> | undefined } {
  let catalog = false;
  // A user-supplied launcher can select a different profile or add native flags.
  let uncertain = !!env.CODEX_PATH;
  let environment: Record<string, unknown> = {};
  if (env.CODEX_CONFIG) {
    try {
      const config = JSON.parse(env.CODEX_CONFIG);
      if (config === null || typeof config !== "object" || Array.isArray(config)) {
        catalog = true;
        uncertain = true;
      } else {
        environment = config;
        catalog = catalogConfigured(config);
      }
    } catch {
      catalog = true;
      uncertain = true;
    }
  }
  const paths = new Map<string, boolean>();
  const add = (path: string, user = false) => {
    let canonical = path;
    try {
      canonical = realpathSync(path);
    } catch {
      /* A missing optional config is normal. */
    }
    if (!paths.has(canonical)) paths.set(canonical, user);
  };
  const userHome = env.HOME || env.USERPROFILE;
  const home = env.CODEX_HOME || (userHome ? join(userHome, ".codex") : "");
  if (home) add(join(home, "config.toml"), true);
  if (cwd) {
    let current: string;
    try {
      current = realpathSync(cwd);
      add(join(current, "config.toml"));
    } catch {
      current = "";
      catalog = true;
      uncertain = true;
    }
    while (current) {
      add(join(current, ".codex", "config.toml"));
      const parent = dirname(current);
      if (current === parent) break;
      current = parent;
    }
  }
  let userEffort: string | undefined;
  for (const [path, user] of paths) {
    try {
      const config = Bun.TOML.parse(readFileSync(path, "utf8"));
      catalog ||= catalogConfigured(config);
      // 0.160.1 layers user < selected profile < trusted project < runtime.
      // Trust and profile-v2 selection belong to Codex. Do not guess them or
      // replay an untrusted project's effort as a higher-priority runtime value.
      // Source: codex-rs/config/src/loader/mod.rs at rust-v0.160.1.
      uncertain ||= profileConfigured(config);
      if ("model_reasoning_effort" in config) {
        const effort = config.model_reasoning_effort;
        if (user && typeof effort === "string" && effort.length) userEffort = effort;
        else uncertain = true;
      }
    } catch (error) {
      // Leave invalid/unreadable native configuration to Codex rather than
      // masking its error with a generated catalog.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        catalog = true;
        uncertain = true;
      }
    }
  }
  uncertain ||= profileConfigured(environment);
  let reasoningPreferences: Record<string, string> | undefined = uncertain
    ? {}
    : userEffort
      ? { reasoning_effort: userEffort }
      : catalog
        ? {}
        : undefined;
  if (Object.hasOwn(environment, "model_reasoning_effort")) {
    const effort = environment.model_reasoning_effort;
    reasoningPreferences = typeof effort === "string" && effort.length ? { reasoning_effort: effort } : {};
  }
  return { catalog, reasoningPreferences };
}

function profileConfigured(config: object): boolean {
  return Object.hasOwn(config, "profile") || Object.hasOwn(config, "profiles");
}

function catalogConfigured(config: object): boolean {
  if (Object.hasOwn(config, "model_catalog_json")) return true;
  const profiles = "profiles" in config ? config.profiles : undefined;
  // A named native profile can be selected later by the adapter. Keep its
  // startup catalog authoritative even before that profile is selected.
  return (
    !!profiles &&
    typeof profiles === "object" &&
    Object.values(profiles).some(
      (profile) => profile && typeof profile === "object" && Object.hasOwn(profile, "model_catalog_json"),
    )
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function batchQuote(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error("Codex 的 Windows 启动参数不能包含引号或换行");
  return `"${value.replace(/%/g, "%%")}"`;
}
