import { expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { isDeepSeekThinkingModel, piReasoningModel, providerReasoningDefaults } from "../server/provider-reasoning";
import type { ProviderSecret } from "../server/providers";

const provider: ProviderSecret = {
  id: "deepseek-fixture",
  name: "Fixture",
  preset: "deepseek",
  apiKey: "fixture-key",
  mgmtKey: "",
  openaiBaseUrl: "https://gateway.invalid/v1",
  anthropicBaseUrl: "",
  wireApi: "chat",
  model: "deepseek-v4-pro",
  smallModel: "deepseek-flash",
  createdAt: 0,
  updatedAt: 0,
};

test("reasoning metadata requires a known DeepSeek model and a selected preset or official endpoint", () => {
  expect(isDeepSeekThinkingModel(provider)).toBe(true);
  expect(isDeepSeekThinkingModel(provider, "deepseek-flash")).toBe(true);
  expect(isDeepSeekThinkingModel(provider, "custom-deepseek-model")).toBe(false);
  expect(isDeepSeekThinkingModel({ ...provider, preset: "custom" })).toBe(false);
  expect(isDeepSeekThinkingModel({ ...provider, preset: "custom", openaiBaseUrl: "https://api.deepseek.com/v1" })).toBe(
    true,
  );
  expect(
    isDeepSeekThinkingModel({
      ...provider,
      preset: "custom",
      openaiBaseUrl: "",
      anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    }),
  ).toBe(true);
  expect(
    isDeepSeekThinkingModel({
      ...provider,
      preset: "custom",
      openaiBaseUrl: "https://api.deepseek.com.evil.invalid/v1",
    }),
  ).toBe(false);
  expect(isDeepSeekThinkingModel({ ...provider, preset: "custom", openaiBaseUrl: "invalid" })).toBe(false);
});

function options(model: string, id: string, levels = ["off", "low", "high"]): acp.SessionConfigOption[] {
  return [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: model,
      options: [{ value: model, name: model }],
    },
    {
      id,
      category: "thought_level",
      name: "Thinking",
      type: "select",
      currentValue: levels[0] ?? "off",
      options: levels.map((value) => ({ value, name: value })),
    },
  ];
}

test("defaults use only the selected model and an advertised high choice, never invent an option", () => {
  for (const [harness, model, id] of [
    ["pi", "tuantuan/deepseek-v4-pro", "thinking_level"],
    ["opencode", "tuantuan/deepseek-flash", "thought_level"],
    ["codex", "deepseek-v4-pro", "reasoning_effort"],
  ] as const) {
    expect(providerReasoningDefaults(provider, harness, options(model, id))).toEqual({ [id]: "high" });
    expect(providerReasoningDefaults(provider, harness, options(model, id, ["off"]))).toEqual({});
    expect(providerReasoningDefaults(provider, harness, options("unknown", id))).toEqual({});
  }
  expect(providerReasoningDefaults(provider, "pi", [])).toEqual({});
  expect(providerReasoningDefaults(null, "pi", options("tuantuan/deepseek-v4-pro", "thinking"))).toEqual({});
  expect(providerReasoningDefaults(provider, "claude-code", options("deepseek-v4-pro", "effort"))).toEqual({
    effort: "high",
  });
});

test("Pi registers real DeepSeek choices and protocol-specific reasoning replay", () => {
  expect(piReasoningModel(provider, "unrecognized", "openai-completions")).toEqual({ reasoning: false });
  expect(piReasoningModel(provider, provider.model, "openai-completions")).toMatchObject({
    reasoning: true,
    thinkingLevelMap: { off: "none", low: "low", high: "high", max: "max" },
    compat: {
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsReasoningEffort: true,
    },
  });
  expect(piReasoningModel(provider, provider.smallModel, "anthropic-messages")).toMatchObject({
    reasoning: true,
    compat: { forceAdaptiveThinking: true, allowEmptySignature: true },
  });
  expect(piReasoningModel(provider, provider.model, "openai-responses")).not.toHaveProperty("compat");
});

test("Pi toggle recommendations use a real on control when the updated engine offers it", () => {
  const toggle = { ...provider, preset: "kimi", model: "kimi-k2.6", openaiBaseUrl: "https://api.moonshot.cn/v1" };
  expect(
    providerReasoningDefaults(toggle, "pi", options("tuantuan/kimi-k2.6", "thought_level", ["off", "on"])),
  ).toEqual({ thought_level: "on" });
  expect(
    providerReasoningDefaults(toggle, "pi", options("tuantuan/kimi-k2.6", "thought_level", ["off", "high"])),
  ).toEqual({ thought_level: "high" });
});
