import type { ModelApi, ModelCapabilities, ThinkingLevel } from "./model-capabilities";
import { resolveModelCapabilities } from "./model-catalog";
import { killProcessTree, processGroupOptions } from "./process-tree";
import type { ProviderSecret } from "./providers";

// V1 merges its generated variants before our overrides. Disable all aliases
// first, then restore only controls verified by the provider/model catalog.
const VARIANT_IDS = ["none", "off", "on", "minimal", "low", "medium", "high", "xhigh", "max", "thinking"];
type Settings = Record<string, unknown>;
const configFormats = new Map<string, Promise<boolean>>();

/** Known compatible schemas stay cheap; a new major is identified by its own config reader. */
export async function opencodeConfigV2(
  version: string | null | undefined,
  env: Record<string, string>,
  launch?: { command: string; args: string[] },
): Promise<boolean> {
  const major = Number(version?.match(/(?:^|\s)v?(\d+)\./)?.[1]);
  if (major === 1 || major === 2) return major === 2;
  const command = launch?.command || Bun.which("opencode", { PATH: env.PATH });
  if (!command) throw new Error("无法定位 OpenCode，未能探测服务商配置格式");
  const args = launch?.args ?? ["acp"];
  const key = harnessRuntimeIdentity(
    { id: "opencode", command, args, version: version ?? null, source: "override", registryId: null },
    env,
  );
  const cached = configFormats.get(key);
  if (cached) return cached;
  const pending = probeConfigFormat(command, args, env);
  configFormats.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    configFormats.delete(key);
    throw error;
  }
}

async function probeConfigFormat(command: string, args: string[], env: Record<string, string>): Promise<boolean> {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    throw new Error("无法安全隔离 OpenCode 配置探测的网络；未知版本的服务商配置格式尚未确认");
  const root = mkdtempSync(join(tmpdir(), "tuantuan-opencode-schema-"));
  const marker = "tuantuan_schema_probe";
  const acpIndex = args.indexOf("acp");
  const prefix = acpIndex < 0 ? args : args.slice(0, acpIndex);
  const errors: string[] = [];
  const isolatedEnv = {
    HOME: root,
    USERPROFILE: root,
    PATH: env.PATH ?? process.env.PATH ?? "",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  const run = async (argv: string[], config?: Record<string, unknown>) => {
    const child = Bun.spawn(
      [
        "/usr/bin/sandbox-exec",
        "-p",
        '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*")) (allow network-inbound (local ip "localhost:*"))',
        command,
        ...prefix,
        ...argv,
      ],
      {
        cwd: root,
        env: { ...isolatedEnv, ...(config ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } : {}) },
        stdout: "pipe",
        stderr: "pipe",
        ...processGroupOptions,
      },
    );
    try {
      return await withTimeout(
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
        8000,
        "OpenCode 配置格式探测超时",
      );
    } finally {
      killProcessTree(child, "SIGKILL");
      await child.exited;
    }
  };
  try {
    // Let the installed CLI choose its channel-specific service file. Its standalone
    // server has an ownership pipe; a metadata probe must never leave a managed service.
    const [, serviceError, serviceCode] = await run(["service", "set", "disabled", "true"]);
    if (serviceCode !== 0)
      throw new Error(`无法为 OpenCode 配置探测禁用后台服务：${serviceError.trim().slice(-240) || serviceCode}`);
    for (const v2 of [true, false]) {
      const model = { name: marker, variants: v2 ? [{ id: marker }] : { [marker]: { reasoningEffort: "low" } } };
      const candidate = {
        autoupdate: false,
        [v2 ? "providers" : "provider"]: { [marker]: { name: marker, models: { [marker]: model } } },
      };
      try {
        const [stdout, stderr, code] = await run(["debug", "config"], candidate);
        const detected = code === 0 ? configShape(JSON.parse(stdout), marker) : null;
        if (detected !== null) return detected;
        errors.push(`${v2 ? "V2" : "V1"}: ${stderr.trim().slice(-240) || "未返回可识别的配置形状"}`);
      } catch (error) {
        errors.push(`${v2 ? "V2" : "V1"}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`OpenCode 服务商配置格式未确认：${errors.join("；")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function configShape(value: unknown, marker: string): boolean | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const detected = configShape(item, marker);
      if (detected !== null) return detected;
    }
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const [field, v2] of [
      ["providers", true],
      ["provider", false],
    ] as const) {
      const providers = object[field] as
        | Record<string, { name?: string; models?: Record<string, { variants?: unknown }> }>
        | undefined;
      const provider = providers?.[marker];
      const variants = provider?.models?.[marker]?.variants;
      if (
        provider?.name === marker &&
        (v2
          ? Array.isArray(variants) && variants.some((item) => item?.id === marker)
          : !!variants && !Array.isArray(variants) && Object.hasOwn(variants, marker))
      )
        return v2;
    }
    for (const item of Object.values(object)) {
      const detected = configShape(item, marker);
      if (detected !== null) return detected;
    }
  }
  return null;
}
interface Controls {
  settings?: Settings;
  body?: Settings;
}

function controls(capability: ModelCapabilities, level: ThinkingLevel, v2: boolean): Controls | null {
  const off = level === "off";
  const effort = off ? "none" : level;
  const fallbackEffort =
    capability.defaultLevel && !["off", "on"].includes(capability.defaultLevel)
      ? capability.defaultLevel
      : capability.levels.find((value) => value !== "off" && value !== "on");
  if (capability.api === "anthropic-messages") {
    const adaptive = capability.format === "anthropic-adaptive";
    const compatible = capability.format === "deepseek" || capability.format === "anthropic-toggle";
    const budget = capability.budgets?.[level];
    if (!adaptive && !compatible && capability.format !== "anthropic-budget") return null;
    // Anthropic's V1 SDK requires a budget for enabled (non-adaptive) thinking.
    // A compatibility budget is catalog-supplied even when the upstream ignores it.
    if (!off && !adaptive && (!budget || budget < 1024 || budget >= capability.maxTokens)) return null;
    const thinking = off
      ? { type: "disabled" }
      : adaptive
        ? { type: "adaptive" }
        : { type: "enabled", ...(!v2 || !compatible ? { [v2 ? "budget_tokens" : "budgetTokens"]: budget } : {}) };
    const actualEffort = off ? fallbackEffort : level;
    if (v2) {
      return {
        body: {
          thinking,
          ...(capability.effort && actualEffort ? { output_config: { effort: actualEffort } } : {}),
        },
      };
    }
    return { settings: { thinking, ...(capability.effort && actualEffort ? { effort: actualEffort } : {}) } };
  }
  if (capability.api === "openai-responses") {
    return capability.effort ? { settings: { reasoningEffort: effort } } : null;
  }
  switch (capability.format) {
    case "openai":
      return capability.effort ? { settings: { reasoningEffort: effort } } : null;
    case "openrouter":
      return {
        body: {
          reasoning: off
            ? { enabled: false }
            : capability.effort
              ? { effort: level }
              : capability.budgets?.[level]
                ? { max_tokens: capability.budgets[level] }
                : { enabled: true },
        },
      };
    case "deepseek":
      return {
        ...(capability.effort ? { settings: { reasoningEffort: effort } } : {}),
        body: { thinking: { type: off ? "disabled" : "enabled" } },
      };
    case "qwen":
    case "zai":
      return {
        ...(capability.effort && (off ? fallbackEffort : level)
          ? { settings: { reasoningEffort: off ? fallbackEffort : level } }
          : {}),
        body:
          capability.format === "qwen"
            ? { enable_thinking: !off }
            : { thinking: { type: off ? "disabled" : "enabled", clear_thinking: false } },
      };
    case "anthropic-toggle":
      // Moonshot's Chat-compatible API uses the same explicit toggle as DeepSeek.
      return { body: { thinking: { type: off ? "disabled" : "enabled" } } };
    default:
      return null;
  }
}

/** Model overrides for the two OpenCode configuration formats we support. */
export function opencodeReasoningModel(
  provider: ProviderSecret,
  model: string,
  api: ModelApi,
  v2: boolean,
): Record<string, unknown> {
  const capability = resolveModelCapabilities(provider, model, api);
  if (!capability) return {};
  const variants = capability.reasoning
    ? capability.levels.flatMap((level) => {
        const value = controls(capability, level, v2);
        // Preserve OpenCode's native "none" ID so existing session choices survive.
        return value ? [{ id: level === "off" ? "none" : level, ...value }] : [];
      })
    : [];
  const defaultId = capability.defaultLevel === "off" ? "none" : capability.defaultLevel;
  const initial = variants.find(({ id }) => id === defaultId) ?? variants[0];
  const replay = api === "openai-completions" && capability.interleaved;
  if (v2) {
    return {
      ...(initial?.settings ? { settings: initial.settings } : {}),
      ...(initial?.body ? { body: initial.body } : {}),
      ...(replay
        ? { compatibility: { reasoningField: replay, requireReasoning: capability.requireReasoning ?? false } }
        : {}),
      variants,
    };
  }
  return {
    reasoning: capability.reasoning,
    ...(replay ? { interleaved: { field: replay } } : {}),
    ...(initial ? { options: { ...initial.settings, ...initial.body } } : {}),
    variants: {
      ...Object.fromEntries(VARIANT_IDS.map((id) => [id, { disabled: true }])),
      ...Object.fromEntries(variants.map(({ id, settings, body }) => [id, { ...settings, ...body }])),
    },
  };
}

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "./acp";
import { harnessRuntimeIdentity } from "./harness-runtime";
