import { expect, test } from "bun:test";
import type { ModelApi } from "../server/model-capabilities";
import { resolveModelCapabilities } from "../server/model-catalog";
import { opencodeReasoningModel } from "../server/provider-opencode";
import type { ProviderSecret } from "../server/providers";

const provider: ProviderSecret = {
  id: "deepseek-fixture",
  name: "Fixture",
  preset: "deepseek",
  anthropicBaseUrl: "",
  openaiBaseUrl: "http://127.0.0.1:9/v1",
  wireApi: "chat",
  apiKey: "fixture-key",
  mgmtKey: "",
  model: "deepseek-v4-pro",
  smallModel: "deepseek-flash",
  createdAt: 0,
  updatedAt: 0,
};
const bound = (reference: string): ProviderSecret => ({
  ...provider,
  preset: "custom",
  model: "custom-alias",
  modelCatalog: { "custom-alias": reference },
});
function model(reference: string, v2: boolean, api: ModelApi = "openai-completions") {
  const fixture = bound(reference);
  return opencodeReasoningModel(fixture, fixture.model, api, v2);
}
function variants(definition: Record<string, unknown>, v2: boolean): Record<string, unknown> {
  return v2
    ? Object.fromEntries((definition.variants as { id: string }[]).map(({ id, ...settings }) => [id, settings]))
    : Object.fromEntries(
        Object.entries(definition.variants as Record<string, { disabled?: boolean }>).filter(
          ([, value]) => !value.disabled,
        ),
      );
}

test("unknown model/provider identity preserves native configuration; explicit aliases resolve capabilities", () => {
  for (const v2 of [false, true]) {
    expect(opencodeReasoningModel(provider, "deepseek-v4-pro-preview", "openai-completions", v2)).toEqual({});
    expect(opencodeReasoningModel({ ...provider, preset: "custom" }, provider.model, "openai-completions", v2)).toEqual(
      {},
    );
    expect(
      opencodeReasoningModel(
        { ...provider, preset: "custom", openaiBaseUrl: "https://api.deepseek.com/v1" },
        provider.smallModel,
        "openai-completions",
        v2,
      ),
    ).not.toEqual({});
    expect(model("deepseek/deepseek-v4-pro", v2)).not.toEqual({});
  }
});

test("DeepSeek Chat variants explicitly disable thinking and preserve reasoning replay", () => {
  const v1 = opencodeReasoningModel(provider, provider.model, "openai-completions", false);
  expect(v1.interleaved).toEqual({ field: "reasoning_content" });
  expect(v1.options).toEqual({ reasoningEffort: "high", thinking: { type: "enabled" } });
  expect(variants(v1, false)).toEqual({
    none: { reasoningEffort: "none", thinking: { type: "disabled" } },
    low: { reasoningEffort: "low", thinking: { type: "enabled" } },
    high: { reasoningEffort: "high", thinking: { type: "enabled" } },
    max: { reasoningEffort: "max", thinking: { type: "enabled" } },
  });
  const v2 = opencodeReasoningModel(provider, provider.model, "openai-completions", true);
  expect(v2.compatibility).toEqual({ reasoningField: "reasoning_content", requireReasoning: true });
  expect(variants(v2, true).none).toEqual({
    settings: { reasoningEffort: "none" },
    body: { thinking: { type: "disabled" } },
  });
});

test("Responses variants use native effort without Chat-only fields", () => {
  for (const v2 of [false, true]) {
    const definition = opencodeReasoningModel(provider, provider.model, "openai-responses", v2);
    expect(definition.interleaved).toBeUndefined();
    expect(definition.compatibility).toBeUndefined();
    expect(definition.body).toBeUndefined();
    const choices = variants(definition, v2);
    expect(Object.keys(choices)).toEqual(["none", "low", "high", "max"]);
    expect(choices.none).toEqual(v2 ? { settings: { reasoningEffort: "none" } } : { reasoningEffort: "none" });
  }
});

test("Anthropic adaptive thinking uses real effort and explicit disable", () => {
  for (const v2 of [false, true]) {
    const definition = opencodeReasoningModel(provider, provider.model, "anthropic-messages", v2);
    expect(v2 ? definition.body : definition.options).toEqual(
      v2
        ? { thinking: { type: "adaptive" }, output_config: { effort: "high" } }
        : { thinking: { type: "adaptive" }, effort: "high" },
    );
    expect(variants(definition, v2).none).toEqual(
      v2
        ? { body: { thinking: { type: "disabled" }, output_config: { effort: "high" } } }
        : { thinking: { type: "disabled" }, effort: "high" },
    );
    expect(JSON.stringify(definition)).not.toContain("reasoningEffort");
  }
});

test("Moonshot toggle exposes on/off without fabricated effort levels", () => {
  for (const v2 of [false, true]) {
    for (const api of ["openai-completions", "anthropic-messages"] as const) {
      const definition = model("moonshotai-cn/kimi-k2.6", v2, api);
      const choices = variants(definition, v2);
      expect(Object.keys(choices)).toEqual(["none", "on"]);
      expect(JSON.stringify(choices)).not.toContain("reasoningEffort");
      expect(JSON.stringify(choices)).not.toContain('"effort"');
      expect(v2 ? definition.body : definition.options).toMatchObject({ thinking: { type: "enabled" } });
      if (api === "anthropic-messages") {
        expect(v2 ? definition.body : definition.options).toMatchObject({
          thinking: { [v2 ? "budget_tokens" : "budgetTokens"]: 16384 },
        });
      }
    }
  }
});

test("Qwen uses its explicit toggle and only catalog effort levels", () => {
  for (const v2 of [false, true]) {
    const definition = model("alibaba-cn/qwen3.8-max", v2);
    const choices = variants(definition, v2);
    expect(Object.keys(choices)).toEqual(["none", "low", "medium", "xhigh"]);
    expect(v2 ? definition.body : definition.options).toMatchObject({ enable_thinking: true });
    expect(v2 ? (choices.none as { body: unknown }).body : choices.none).toMatchObject({ enable_thinking: false });
    expect(v2 ? (choices.xhigh as { settings: unknown }).settings : choices.xhigh).toMatchObject({
      reasoningEffort: "xhigh",
    });
    expect(v2 ? definition.settings : definition.options).toMatchObject({ reasoningEffort: "medium" });
  }
});

test("GLM mandatory thinking has no off variant or generic medium alias", () => {
  for (const v2 of [false, true]) {
    const definition = model("zhipuai/glm-5.3", v2);
    const choices = variants(definition, v2);
    expect(Object.keys(choices)).toEqual(["low", "high", "max"]);
    expect(v2 ? definition.body : definition.options).toMatchObject({
      thinking: { type: "enabled", clear_thinking: false },
    });
    expect(v2 ? definition.settings : definition.options).toMatchObject({ reasoningEffort: "high" });
  }
});

test("OpenAI and OpenRouter use their respective native request vocabularies", () => {
  for (const v2 of [false, true]) {
    const openai = model("openai/gpt-5.4", v2);
    expect(Object.keys(variants(openai, v2))).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(v2 ? openai.settings : openai.options).toEqual({ reasoningEffort: "high" });
    const router = model("openrouter/anthropic/claude-sonnet-4.6", v2);
    expect(v2 ? router.body : router.options).toEqual({ reasoning: { effort: "high" } });
    expect(variants(router, v2).none).toEqual(
      v2 ? { body: { reasoning: { enabled: false } } } : { reasoning: { enabled: false } },
    );
  }
});

test("manual Anthropic budgets come from the catalog and stay below output limits", () => {
  const fixture = bound("anthropic/claude-sonnet-4-5");
  const capability = resolveModelCapabilities(fixture, fixture.model, "anthropic-messages");
  expect(capability?.format).toBe("anthropic-budget");
  for (const v2 of [false, true]) {
    const definition = opencodeReasoningModel(fixture, fixture.model, "anthropic-messages", v2);
    const choices = variants(definition, v2);
    expect(Object.keys(choices)).toEqual(["none", "minimal", "low", "medium", "high"]);
    for (const level of ["minimal", "low", "medium", "high"] as const) {
      const options = v2 ? (choices[level] as { body: Record<string, unknown> }).body : choices[level];
      const budget = capability?.budgets?.[level];
      expect(options).toEqual({ thinking: { type: "enabled", [v2 ? "budget_tokens" : "budgetTokens"]: budget } });
      expect(budget).toBeGreaterThanOrEqual(1024);
      expect(budget as number).toBeLessThan(capability?.maxTokens as number);
    }
    expect(JSON.stringify(choices)).not.toContain('"effort"');
  }
});

test("known models without configurable reasoning suppress OpenCode generic choices", () => {
  for (const v2 of [false, true]) {
    const definition = model("openai/gpt-4.1", v2);
    expect(Object.keys(variants(definition, v2))).toEqual([]);
    expect(definition.options).toBeUndefined();
    expect(definition.settings).toBeUndefined();
    if (!v2) expect(definition.reasoning).toBe(false);
  }
});
