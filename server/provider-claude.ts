import type * as acp from "@agentclientprotocol/sdk";
import type { ModelCapabilities } from "./model-capabilities";
import { resolveModelCapabilities } from "./model-catalog";
import type { ProviderSecret } from "./providers";

const CAPABILITIES_ENV = "CLAUDE_CODE_MODEL_CAPABILITIES";

function nativeClaude(model: string): boolean {
  // Native Claude IDs, including gateway/Bedrock prefixes, already have CLI-owned metadata.
  return /claude/i.test(model);
}

function capabilityRule(model: string, capabilities: ModelCapabilities): string | null {
  // The CLI parses ';' rules, '=' patterns and trailing '*' wildcards. Never reinterpret a
  // provider's model ID as this grammar or silently rename the model sent to its endpoint.
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(model) || nativeClaude(model)) return null;
  const flags = [
    capabilities.effort ? "effort" : "-effort",
    capabilities.reasoning ? "thinking" : "-thinking",
    capabilities.format === "anthropic-adaptive" ? "adaptive_thinking" : "-adaptive_thinking",
    capabilities.levels.includes("xhigh") ? "xhigh_effort" : "-xhigh_effort",
    capabilities.levels.includes("max") ? "max_effort" : "-max_effort",
  ];
  return `${model}=${flags.join(",")}`;
}

/** Metadata for the pinned CLI's real model/effort implementation, scoped to this process. */
function providerRules(provider: ProviderSecret): string[] {
  return [...new Set([provider.model, provider.smallModel].filter(Boolean))].flatMap((model) => {
    const capabilities = resolveModelCapabilities(provider, model, "anthropic-messages");
    const rule = capabilities && capabilityRule(model, capabilities);
    return rule ? [rule] : [];
  });
}

export function claudeProviderEnv(provider: ProviderSecret, env: Record<string, string>): Record<string, string> {
  const generated = providerRules(provider).join(";");
  // Later matching CLI rules win. An explicit user capability declaration remains authoritative.
  const existing = env[CAPABILITIES_ENV];
  return {
    ...env,
    ...(provider.model && !nativeClaude(provider.model) ? { ANTHROPIC_CUSTOM_MODEL_OPTION: provider.model } : {}),
    ...(generated
      ? {
          [CAPABILITIES_ENV]:
            existing === generated || existing?.startsWith(`${generated};`)
              ? existing
              : [generated, ...(existing ? [existing] : [])].join(";"),
        }
      : {}),
  };
}

function explicitCapabilities(
  provider: ProviderSecret,
  model: string,
  env: Record<string, string>,
): Map<string, boolean> {
  const generated = providerRules(provider).join(";");
  let rules = env[CAPABILITIES_ENV] ?? "";
  if (generated && (rules === generated || rules.startsWith(`${generated};`))) rules = rules.slice(generated.length);
  const flags = new Map<string, boolean>();
  const target = model.replace(/\[1m\]/gi, "");
  for (const rule of rules.split(";")) {
    const index = rule.indexOf("=");
    const pattern = rule.slice(0, index).trim();
    if (index !== -1 && !(pattern.endsWith("*") ? target.startsWith(pattern.slice(0, -1)) : target === pattern))
      continue;
    for (const flag of (index === -1 ? rule : rule.slice(index + 1)).split(",")) {
      const name = flag.trim();
      if (name) flags.set(name.startsWith("-") ? name.slice(1) : name, !name.startsWith("-"));
    }
  }
  return flags;
}

/** Restrict native effort choices to verified levels; no control or current value is fabricated. */
export function claudeConfigOptions(
  provider: ProviderSecret,
  options: acp.SessionConfigOption[],
  env: Record<string, string> = {},
): acp.SessionConfigOption[] {
  const modelOption = options.find((option) => option.category === "model" || option.id === "model");
  const model = modelOption?.type === "select" ? modelOption.currentValue : provider.model;
  if (nativeClaude(model)) return options;
  const capabilities = resolveModelCapabilities(provider, model, "anthropic-messages");
  if (!capabilities) return options;
  const explicit = explicitCapabilities(provider, model, env);
  return options.flatMap((option) => {
    if (option.id !== "effort" || option.type !== "select") return [option];
    const levels = new Set<string>(["default", ...capabilities.levels]);
    const native = option.options.flatMap((item) => ("options" in item ? item.options : [item]));
    // Explicit user declarations own their native choices, including controls introduced
    // by a newer CLI. An explicit negative capability still suppresses that effort.
    if (explicit.get("effort") === true) for (const item of native) levels.add(item.value);
    for (const [flag, enabled] of explicit) {
      if (!flag.endsWith("_effort")) continue;
      const level = flag.slice(0, -"_effort".length);
      if (enabled) levels.add(level);
      else levels.delete(level);
    }
    if (explicit.get("effort") === false) return [];
    const choices = native.filter((item) => levels.has(item.value));
    if (!capabilities.effort && !explicit.get("effort") && !choices.some((item) => item.value !== "default")) return [];
    return [
      {
        ...option,
        options: choices,
      },
    ];
  });
}
