import type { ModelApi, ModelCapabilities, ThinkingLevel } from "./model-capabilities";
import { resolveModelCapabilities } from "./model-catalog";
import type { ProviderSecret } from "./providers";

// V1 merges its generated variants before our overrides. Disable all aliases
// first, then restore only controls verified by the provider/model catalog.
const VARIANT_IDS = ["none", "off", "on", "minimal", "low", "medium", "high", "xhigh", "max", "thinking"];
type Settings = Record<string, unknown>;
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
