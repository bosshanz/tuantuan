import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveModelCapabilities } from "./model-catalog";
import { prepareCodexProviderRuntime } from "./provider-codex";
import { opencodeConfigV2, opencodeReasoningModel } from "./provider-opencode";
import { piReasoningModel } from "./provider-reasoning";
import type { ProviderSecret } from "./providers";

const PROVIDER_ID = "tuantuan";
const KEY_ENV = "TUANTUAN_PROVIDER_API_KEY";
const CONFIG_ENV = "TUANTUAN_PI_PROVIDER";

interface Runtime {
  env: Record<string, string>;
  cleanup: () => void;
  /** Undefined permits a recommendation; an empty object preserves native choices. */
  reasoningPreferences?: Record<string, string>;
}

export function providerRuntimeModel(model: string): string {
  return `${PROVIDER_ID}/${model}`;
}

/** Configure only this ACP process; native user settings and credentials stay in place. */
export async function prepareProviderRuntime(
  provider: ProviderSecret,
  harness: string,
  env: Record<string, string>,
  version?: string | null,
  adapterLaunch?: { command: string; args: string[]; cwd?: string },
): Promise<Runtime> {
  const kind = harness;
  if (kind === "codex") return prepareCodexProviderRuntime(provider, env, adapterLaunch);
  if (kind !== "opencode" && kind !== "pi") return { env, cleanup: () => {} };
  if (!provider.model) throw new Error(`${kind} 服务商需要主模型`);
  const baseUrl = (provider.openaiBaseUrl || provider.anthropicBaseUrl).replace(/\/+$/, "");
  if (!baseUrl) throw new Error(`${kind} 服务商需要 API 地址`);
  const api = provider.openaiBaseUrl
    ? provider.wireApi === "responses"
      ? "openai-responses"
      : "openai-completions"
    : "anthropic-messages";
  const models = [...new Set([provider.model, provider.smallModel].filter(Boolean))];
  const next = { ...env, [KEY_ENV]: provider.apiKey };
  if (kind === "opencode") {
    const existing: unknown = env.OPENCODE_CONFIG_CONTENT ? Bun.JSON5.parse(env.OPENCODE_CONFIG_CONTENT) : {};
    if (!isRecord(existing)) throw new Error("OPENCODE_CONFIG_CONTENT 必须是 JSON 对象");
    const v2 = await opencodeConfigV2(version, env, adapterLaunch);
    // Unlike the Anthropic SDK used by Pi/Claude, OpenCode's provider runtimes
    // append /messages to a versioned API base rather than /v1/messages.
    const options = {
      baseURL: api === "anthropic-messages" && !baseUrl.endsWith("/v1") ? `${baseUrl}/v1` : baseUrl,
      apiKey: `{env:${KEY_ENV}}`,
    };
    const modelConfig = Object.fromEntries(
      models.map((id) => [id, { name: id, ...opencodeReasoningModel(provider, id, api, v2) }]),
    );
    const ref = providerRuntimeModel(provider.model);
    const smallRef = providerRuntimeModel(provider.smallModel || provider.model);
    const config = v2
      ? {
          ...existing,
          model: ref,
          ...(Array.isArray(existing.enabled_providers)
            ? { enabled_providers: [...new Set([...stringList(existing.enabled_providers), PROVIDER_ID])] }
            : {}),
          ...(Array.isArray(existing.disabled_providers)
            ? { disabled_providers: stringList(existing.disabled_providers).filter((id) => id !== PROVIDER_ID) }
            : {}),
          providers: {
            ...record(existing.providers),
            [PROVIDER_ID]: {
              name: provider.name,
              env: [KEY_ENV],
              package:
                api === "anthropic-messages"
                  ? "@opencode/ai/providers/anthropic-compatible"
                  : api === "openai-responses"
                    ? "@opencode/ai/providers/openai-compatible/responses"
                    : "@opencode/ai/providers/openai-compatible",
              settings: options,
              models: modelConfig,
            },
          },
          agents: {
            ...record(existing.agents),
            title: { ...record(record(existing.agents).title), model: smallRef },
          },
        }
      : {
          ...existing,
          model: ref,
          small_model: smallRef,
          enabled_providers: [...new Set([...stringList(existing.enabled_providers), PROVIDER_ID])],
          disabled_providers: stringList(existing.disabled_providers).filter((id) => id !== PROVIDER_ID),
          provider: {
            ...record(existing.provider),
            [PROVIDER_ID]: {
              name: provider.name,
              env: [KEY_ENV],
              npm:
                api === "anthropic-messages"
                  ? "@ai-sdk/anthropic"
                  : api === "openai-responses"
                    ? "@ai-sdk/openai"
                    : "@ai-sdk/openai-compatible",
              options,
              models: modelConfig,
            },
          },
        };
    return { env: { ...next, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, cleanup: () => {} };
  }

  // pi-acp 0.0.34 accepts an executable override, but no additional pi argv. A small
  // exec launcher adds the supported --extension / --provider / --model flags.
  const pi = Bun.which(env.PI_ACP_PI_COMMAND || (process.platform === "win32" ? "pi.cmd" : "pi"), {
    PATH: env.PATH,
  });
  if (!pi) throw new Error("找不到 Pi 引擎，请先安装 pi 并将它加入 PATH");
  const dir = mkdtempSync(join(tmpdir(), "tuantuan-provider-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const extension = join(dir, "provider.js");
    writeFileSync(
      extension,
      `export default async function (pi) {
  const { _thinkingBudgets = {}, ...config } = JSON.parse(process.env.${CONFIG_ENV});
  if (config.models.some((model) => model.reasoning)) {
    const native = await import("@earendil-works/pi-ai/compat");
    if (typeof native.getSupportedThinkingLevels !== "function")
      throw new Error("Pi 未提供公开思考能力接口，无法确认自定义模型支持的等级");
    config.models = config.models.map((model) => {
      if (!model.reasoning) return model;
      const declared = { ...model.thinkingLevelMap };
      const supported = native.getSupportedThinkingLevels({
        type: "chat", provider: ${JSON.stringify(PROVIDER_ID)}, api: config.api, baseUrl: config.baseUrl,
        ...model, thinkingLevelMap: declared,
      });
      if (!Array.isArray(supported) || !supported.every((level) => typeof level === "string" && level.length))
        throw new Error("Pi 返回了无效的思考能力列表");
      // Older Pi represents a toggle as high. Prefer a real native on control when present.
      if (Object.hasOwn(declared, "on") && !supported.includes("on") && supported.includes("high"))
        declared.high = "high";
      const thinkingLevelMap = Object.fromEntries([...new Set([...supported, ...Object.keys(declared)])]
        .map((level) => [level, Object.hasOwn(declared, level) ? declared[level] : null]));
      return { ...model, thinkingLevelMap };
    });
  }
  pi.registerProvider(${JSON.stringify(PROVIDER_ID)}, {
    ...config,
    apiKey: process.env.${KEY_ENV},
  });
  if (Object.keys(_thinkingBudgets).length) pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (ctx.model?.provider !== ${JSON.stringify(PROVIDER_ID)} || ctx.model.api !== "anthropic-messages" ||
        !payload || payload.thinking?.type !== "enabled") return;
    if (!Object.hasOwn(_thinkingBudgets, payload.model)) return;
    const bounded = _thinkingBudgets[payload.model];
    const budgets = Object.values(bounded.budgets);
    const selected = pi.getThinkingLevel();
    const wanted = bounded.budgets[selected] ?? (selected === "high" ? bounded.budgets.on : undefined);
    const maxTokens = Math.min(payload.max_tokens, bounded.maxTokens);
    const budget = Math.floor(Math.min(wanted, maxTokens - 1024));
    if (!Number.isFinite(budget) || budget < Math.ceil(Math.min(...budgets))) {
      // The public hook runner catches throws. Abort the request explicitly rather than
      // sending a below-minimum budget or raising the SDK's context-aware output ceiling.
      ctx.abort();
      ctx.ui.notify("Thinking budget does not fit the remaining output allowance.", "error");
      return;
    }
    return { ...payload, max_tokens: maxTokens, thinking: { ...payload.thinking, budget_tokens: budget } };
  });
}
`,
      { mode: 0o600 },
    );
    const wrapper = join(dir, process.platform === "win32" ? "pi.cmd" : "pi");
    const argv = [pi, "--extension", extension, "--provider", PROVIDER_ID, "--model", provider.model];
    writeFileSync(
      wrapper,
      process.platform === "win32"
        ? `@echo off\r\n@setlocal DisableDelayedExpansion\r\n${argv.map(batchQuote).join(" ")} %*\r\n`
        : `#!/bin/sh\nexec ${argv.map(shellQuote).join(" ")} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(wrapper, 0o700);
    return {
      env: {
        ...next,
        PI_ACP_PI_COMMAND: wrapper,
        [CONFIG_ENV]: JSON.stringify({
          name: provider.name,
          api,
          baseUrl,
          // Snapshot the resolved deployment's budgets; model names never imply this hook.
          _thinkingBudgets: Object.fromEntries(
            models.flatMap((id) => {
              const capabilities = resolveModelCapabilities(provider, id, api);
              return capabilities?.reasoning && capabilities.format === "anthropic-budget" && capabilities.budgets
                ? [[id, { budgets: capabilities.budgets, maxTokens: capabilities.maxTokens }]]
                : [];
            }),
          ),
          // Pi's native adapter translates the catalog's verified controls and wire
          // compatibility flags. Unknown models retain the conservative fallback.
          models: models.map((id) => ({
            id,
            name: id,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...piReasoningModel(provider, id, api),
          })),
        }),
      },
      cleanup,
      reasoningPreferences: piNativeReasoningPreferences(env, adapterLaunch?.cwd),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function piNativeReasoningPreferences(env: Record<string, string>, cwd?: string): Record<string, string> | undefined {
  const home = env.HOME || env.USERPROFILE || homedir();
  const agentDir = env.PI_CODING_AGENT_DIR
    ? resolve(cwd ?? process.cwd(), env.PI_CODING_AGENT_DIR.replace(/^~(?=[/\\]|$)/, home))
    : join(home, ".pi", "agent");
  for (const path of [join(agentDir, "settings.json"), ...(cwd ? [join(cwd, ".pi", "settings.json")] : [])]) {
    try {
      const settings: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
      // Native Pi owns precedence, validation and project trust. Suppress only our automatic
      // recommendation; never inject a value from a possibly untrusted project settings file.
      if (isRecord(settings) && Object.hasOwn(settings, "defaultThinkingLevel")) return {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return {};
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function batchQuote(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error("Pi 的 Windows 启动参数不能包含引号或换行");
  return `"${value.replace(/%/g, "%%")}"`;
}
