import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { harnessRuntimeIdentity, resolveCodexCommand } from "./harness-runtime";
import type { ModelCapabilities } from "./model-capabilities";
import { resolveModelCapabilities } from "./model-catalog";
import { killProcessTree, processGroupOptions } from "./process-tree";
import type { ProviderSecret } from "./providers";

type AdapterLaunch = { command: string; args: string[]; cwd?: string };
type NativeModel = Record<string, unknown> & { slug: string };
type NativeMetadata = {
  catalog: Record<string, unknown> & { models: NativeModel[] };
  // Null means the current CLI's public schema accepts arbitrary nonempty strings.
  efforts: string[] | null;
  instructions: string;
};
const metadata = new Map<string, Promise<NativeMetadata>>();
const probeTimeout = 10000;
const maxCatalogBytes = 16 * 1024 * 1024;

/** Model metadata is loaded by the app server at startup, before any ACP session exists. */
export async function prepareCodexProviderRuntime(
  provider: ProviderSecret,
  env: Record<string, string>,
  adapterLaunch?: AdapterLaunch,
): Promise<{
  env: Record<string, string>;
  cleanup: () => void;
  /** Undefined allows app defaults. An object preserves native intent; {} keeps the ACP's actual value. */
  reasoningPreferences?: Record<string, string>;
}> {
  const native = nativeConfiguration(env, adapterLaunch?.cwd);
  const unchanged = { env, cleanup: () => {}, reasoningPreferences: native.reasoningPreferences };
  if (provider.wireApi !== "responses" || !provider.openaiBaseUrl) return unchanged;
  const ids = [...new Set([provider.model, provider.smallModel].filter(Boolean))];
  if (native.catalog) return unchanged;
  const models = ids
    .map((id) => {
      const capabilities = resolveModelCapabilities(provider, id, "openai-responses");
      return capabilities ? { ...capabilities, modelId: id } : null;
    })
    .filter((model): model is ModelCapabilities => !!model && nativeEfforts(model).length > 0);
  if (!models.length) return unchanged;
  const command = resolveCodexCommand(env, adapterLaunch);
  if (!command) return unchanged;
  let engine: NativeMetadata;
  try {
    engine = await nativeMetadata(command, env, adapterLaunch);
  } catch (error) {
    // Never print a custom launcher's output: it can contain private config.
    console.warn(`[codex] Model metadata probe failed (${probeFailure(error)}); keeping native configuration.`);
    return unchanged;
  }
  const candidates = models.filter((model) => !hasNativeModel(model.modelId, engine.catalog.models));
  if (!candidates.length) return unchanged;
  const additions = candidates.filter((model) => nativeEfforts(model, engine.efforts).length);
  if (!additions.length) {
    console.warn("[codex] Model reasoning levels are unsupported by this CLI; keeping native configuration.");
    return unchanged;
  }
  const dir = mkdtempSync(join(tmpdir(), "tuantuan-codex-provider-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const catalog = join(dir, "models.json");
    writeFileSync(
      catalog,
      JSON.stringify({
        ...engine.catalog,
        models: [
          ...engine.catalog.models,
          ...additions.map((model, priority) => ({
            slug: model.modelId,
            display_name: model.modelId,
            // Captured from this engine's unknown-model session, never from a GPT
            // descriptor. Native instruction overrides still have their usual priority.
            model_messages: { instructions_template: engine.instructions },
            base_instructions: engine.instructions,
            default_reasoning_level: defaultEffort(model, engine.efforts),
            supported_reasoning_levels: nativeEfforts(model, engine.efforts).map((effort) => ({
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
        ],
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

function nativeEfforts(model: ModelCapabilities, accepted?: string[] | null): string[] {
  if (!model.reasoning || !model.effort) return [];
  return [
    ...new Set(
      model.levels
        .filter((level) => level !== "on")
        .map((level) => (level === "off" ? "none" : level))
        .filter((effort) => !accepted || accepted.includes(effort)),
    ),
  ];
}

function defaultEffort(model: ModelCapabilities, accepted: string[] | null): string | undefined {
  const efforts = nativeEfforts(model, accepted);
  const preferred = model.defaultLevel === "off" ? "none" : model.defaultLevel;
  return preferred && efforts.includes(preferred) ? preferred : efforts[0];
}

function hasNativeModel(id: string, models: NativeModel[]): boolean {
  const suffix = /^[A-Za-z0-9_-]+\/([^/]+)$/.exec(id)?.[1];
  return models.some((model) => id.startsWith(model.slug) || suffix?.startsWith(model.slug));
}

async function nativeMetadata(command: string[], env: Record<string, string>, launch?: AdapterLaunch) {
  const selected = launch ?? { command: command[0] as string, args: command.slice(1) };
  const identity = harnessRuntimeIdentity(
    { id: "codex", ...selected, source: null, version: null, registryId: null },
    env,
  );
  const cached = metadata.get(identity);
  if (cached) return cached;
  const pending = probeMetadata(command, env);
  metadata.set(identity, pending);
  // An opaque CODEX_PATH wrapper can select an engine we cannot fingerprint.
  // Share concurrent probes, but recheck it on the next preparation.
  void pending.then(
    () => {
      if (env.CODEX_PATH && metadata.get(identity) === pending) metadata.delete(identity);
    },
    () => {
      if (metadata.get(identity) === pending) metadata.delete(identity);
    },
  );
  while (metadata.size > 16) metadata.delete(metadata.keys().next().value as string);
  return pending;
}

class MetadataProbeError extends Error {}

function probeFailure(error: unknown) {
  return error instanceof MetadataProbeError ? error.message : "unavailable";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readProbeFile(path: string) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > maxCatalogBytes) throw new MetadataProbeError("invalid probe file");
  return readFileSync(path, "utf8");
}

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      size += next.value.byteLength;
      if (size > limit) throw new MetadataProbeError("output limit exceeded");
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function probeCommand(command: string[], args: string[], env: Record<string, string>, cwd: string) {
  const proc = Bun.spawn([...command, ...args], {
    env,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...processGroupOptions,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc, "SIGKILL");
  }, probeTimeout);
  try {
    const [output, , code] = await Promise.all([
      readLimited(proc.stdout, maxCatalogBytes),
      readLimited(proc.stderr, 256 * 1024),
      proc.exited,
    ]);
    if (timedOut) throw new MetadataProbeError("timeout");
    if (code !== 0) throw new MetadataProbeError("unsupported CLI command");
    return output;
  } finally {
    clearTimeout(timer);
    killProcessTree(proc, "SIGKILL");
    await proc.exited;
  }
}

async function probeMetadata(command: string[], sourceEnv: Record<string, string>): Promise<NativeMetadata> {
  const root = mkdtempSync(join(tmpdir(), "tuantuan-codex-metadata-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  // No inherited keys, user configs, auth store, workspace instructions, proxies
  // or hooks. The thread uses our bundled catalog and a dummy local provider;
  // it never submits a turn or requests a model response.
  const env: Record<string, string> = {
    PATH: sourceEnv.PATH || "",
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: home,
    XDG_CONFIG_HOME: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    RUST_LOG: "off",
  };
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  try {
    const schemaDir = join(root, "schema");
    const outputs = await Promise.allSettled([
      probeCommand(command, ["debug", "models", "--bundled"], env, home),
      probeCommand(command, ["app-server", "generate-json-schema", "--experimental", "--out", schemaDir], env, home),
    ]);
    const failed = outputs.find((output) => output.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const raw = (outputs[0] as PromiseFulfilledResult<string>).value;
    const catalog = record(JSON.parse(raw));
    if (
      !catalog ||
      !Array.isArray(catalog.models) ||
      !catalog.models.length ||
      catalog.models.some((model) => typeof record(model)?.slug !== "string" || !record(model)?.slug)
    )
      throw new MetadataProbeError("invalid bundled catalog");
    const schema = JSON.parse(readProbeFile(join(schemaDir, "v2", "ModelListResponse.json")));
    const effortSchema = record(schema.definitions?.ReasoningEffort);
    const choices: unknown = effortSchema?.enum;
    let efforts: string[] | null;
    if (Array.isArray(choices) && choices.length && choices.every((choice) => typeof choice === "string")) {
      efforts = choices;
    } else if (
      effortSchema?.type === "string" &&
      effortSchema.minLength === 1 &&
      Object.keys(effortSchema).every((key) => ["type", "minLength", "description", "title"].includes(key))
    ) {
      // Current Codex has ReasoningEffort::Custom(String); its public schema
      // explicitly accepts model-defined values as long as they are not empty.
      efforts = null;
    } else throw new MetadataProbeError("reasoning schema unavailable");
    const catalogPath = join(root, "bundled-models.json");
    writeFileSync(catalogPath, raw, { mode: 0o600 });
    const instructions = await probeFallbackInstructions(command, env, home, catalogPath, catalog.models);
    return { catalog: catalog as NativeMetadata["catalog"], efforts, instructions };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function probeFallbackInstructions(
  command: string[],
  env: Record<string, string>,
  home: string,
  catalogPath: string,
  models: NativeModel[],
) {
  const model = `tuantuan-generic-probe-${randomUUID()}`;
  if (hasNativeModel(model, models)) throw new MetadataProbeError("generic probe model is not unique");
  const proc = Bun.spawn(
    [
      ...command,
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      `model_catalog_json=${catalogPath}`,
      "-c",
      'model_provider="tuantuan_metadata_probe"',
      "-c",
      'model_providers.tuantuan_metadata_probe={name="Tuantuan metadata probe",base_url="http://127.0.0.1:9/v1",wire_api="responses",requires_openai_auth=false}',
      "app-server",
    ],
    { env, cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe", ...processGroupOptions },
  );
  const timer = setTimeout(() => killProcessTree(proc, "SIGKILL"), probeTimeout);
  const stderr = readLimited(proc.stderr, 256 * 1024);
  // Drain stderr without reporting a launcher's potentially private output.
  void stderr.catch(() => killProcessTree(proc, "SIGKILL"));
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let nextId = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    while (true) {
      const split = buffer.indexOf("\n");
      if (split < 0) {
        const next = await reader.read();
        if (next.done) throw new MetadataProbeError("app-server probe ended");
        bytes += next.value.byteLength;
        if (bytes > maxCatalogBytes) throw new MetadataProbeError("output limit exceeded");
        buffer += decoder.decode(next.value, { stream: true });
        continue;
      }
      const message = record(JSON.parse(buffer.slice(0, split)));
      buffer = buffer.slice(split + 1);
      if (message?.id !== id) continue;
      const result = record(message.result);
      if (!result || message.error) throw new MetadataProbeError("app-server probe rejected");
      return result;
    }
  };
  try {
    await request("initialize", {
      clientInfo: { name: "tuantuan-metadata-probe", version: "0" },
      capabilities: { experimentalApi: true },
    });
    proc.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const created = await request("thread/start", {
      model,
      modelProvider: "tuantuan_metadata_probe",
      allowProviderModelFallback: false,
      cwd: home,
      ephemeral: false,
      approvalPolicy: "never",
    });
    if (created.model !== model || created.modelProvider !== "tuantuan_metadata_probe")
      throw new MetadataProbeError("generic probe model was replaced");
    const threadId = record(created.thread)?.id;
    if (typeof threadId !== "string") throw new MetadataProbeError("thread metadata unavailable");
    // Newer CLIs defer the rollout until its first turn. Archiving materializes
    // this disposable empty thread without ever calling turn/start.
    await request("thread/archive", { threadId });
    const read = await request("thread/read", { threadId, includeTurns: true });
    const path = record(read.thread)?.path;
    if (typeof path !== "string") throw new MetadataProbeError("rollout path unavailable");
    const canonical = realpathSync(path);
    const inside = relative(realpathSync(home), canonical);
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new MetadataProbeError("rollout path outside probe home");
    const line = record(JSON.parse(readProbeFile(canonical).split("\n", 1)[0] as string));
    const payload = record(line?.payload);
    const instructions = record(payload?.base_instructions)?.text;
    if (
      line?.type !== "session_meta" ||
      payload?.id !== threadId ||
      typeof instructions !== "string" ||
      !instructions.trim()
    )
      throw new MetadataProbeError("generic instructions unavailable");
    return instructions;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    killProcessTree(proc, "SIGKILL");
    await proc.exited;
    await stderr.catch(() => {});
  }
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
