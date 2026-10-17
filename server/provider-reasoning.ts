import type * as acp from "@agentclientprotocol/sdk";
import type { ModelApi } from "./model-capabilities";
import { resolveModelCapabilities } from "./model-catalog";
import type { ProviderSecret } from "./providers";

// Keep model-specific wire behavior narrow. An arbitrary OpenAI-compatible endpoint
// or a similar model name is not evidence that DeepSeek's thinking fields are accepted.
export function isDeepSeekThinkingModel(provider: ProviderSecret, model = provider.model): boolean {
  if (model !== "deepseek-v4-pro" && model !== "deepseek-flash") return false;
  if (provider.preset === "deepseek") return true;
  try {
    return new URL(provider.openaiBaseUrl || provider.anthropicBaseUrl).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

export function piReasoningModel(provider: ProviderSecret, model: string, api: string): Record<string, unknown> {
  const capabilities = resolveModelCapabilities(provider, model, api as ModelApi);
  if (!capabilities) return { reasoning: false };
  const { levels, format } = capabilities;
  const metadata = {
    reasoning: capabilities.reasoning,
    input: capabilities.input,
    contextWindow: capabilities.contextWindow,
    maxTokens: capabilities.maxTokens,
  };
  if (!capabilities.reasoning || !levels.length) return { ...metadata, reasoning: false };
  // The extension intersects this declaration with the actual engine's public
  // getSupportedThinkingLevels result. No app-owned list caps future Pi levels.
  const thinkingLevelMap = Object.fromEntries(levels.map((level) => [level, level === "off" ? "none" : level]));
  return {
    ...metadata,
    thinkingLevelMap,
    ...(api === "openai-completions"
      ? {
          compat: {
            thinkingFormat: format,
            supportsReasoningEffort: capabilities.effort,
            ...(capabilities.requireReasoning ? { requiresReasoningContentOnAssistantMessages: true } : {}),
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens",
          },
        }
      : api === "anthropic-messages"
        ? {
            compat: {
              ...(format === "anthropic-adaptive" ? { forceAdaptiveThinking: true } : {}),
              ...(capabilities.providerId !== "anthropic" ? { allowEmptySignature: true } : {}),
            },
          }
        : {}),
  };
}

/** Defaults for a newly created session, applied through the Harness's real config API. */
export function providerReasoningDefaults(
  provider: ProviderSecret | null,
  harness: string,
  options: acp.SessionConfigOption[],
): Record<string, string> {
  if (!provider || !["claude-code", "pi", "opencode", "codex"].includes(harness)) return {};
  const modelOption = options.find((option) => option.category === "model" || option.id === "model");
  const model = modelOption?.type === "select" ? modelOption.currentValue : provider.model;
  const rawModel = ["pi", "opencode"].includes(harness) ? model.replace(/^tuantuan\//, "") : model;
  const capabilities = resolveModelCapabilities(
    provider,
    rawModel,
    harness === "claude-code" ? "anthropic-messages" : undefined,
  );
  const recommended = capabilities?.defaultLevel;
  if (!recommended) return {};
  const option = options.find(
    (item) =>
      item.type === "select" && (item.category === "thought_level" || /thinking|reasoning|effort/.test(item.id)),
  );
  if (option?.type !== "select") return {};
  const choices = option.options.flatMap((item) => ("options" in item ? item.options : [item]));
  const value =
    recommended === "on" && harness === "pi" && !choices.some((choice) => choice.value === "on") ? "high" : recommended;
  return choices.some((choice) => choice.value === value) ? { [option.id]: value } : {};
}
