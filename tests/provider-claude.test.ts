import { expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { captureModelCatalog } from "../server/model-catalog";
import { catalogSnapshot } from "../server/model-catalog-schema";
import { claudeConfigOptions, claudeProviderEnv } from "../server/provider-claude";
import type { ProviderSecret } from "../server/providers";

const provider: ProviderSecret = {
  id: "claude-fixture",
  name: "Fixture",
  preset: "deepseek",
  apiKey: "fixture-key",
  mgmtKey: "",
  anthropicBaseUrl: "https://api.deepseek.com/anthropic",
  openaiBaseUrl: "https://unrelated.invalid/v1",
  model: "deepseek-v4-pro",
  smallModel: "deepseek-flash",
  wireApi: "responses",
  createdAt: 0,
  updatedAt: 0,
};

function options(model = provider.model): acp.SessionConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [{ value: model, name: model }],
    },
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: ["default", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, name: value })),
    },
  ];
}

function levels(config: acp.SessionConfigOption[]) {
  const option = config.find((item) => item.id === "effort");
  return option?.type === "select"
    ? option.options.flatMap((item) => ("options" in item ? item.options : [item])).map((item) => item.value)
    : [];
}

test("Claude uses Anthropic capabilities and exact raw model IDs without replacing unrelated env", () => {
  const env = claudeProviderEnv(provider, { KEEP: "original" });
  expect(env.KEEP).toBe("original");
  expect(env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe(provider.model);
  expect(env.CLAUDE_CODE_MODEL_CAPABILITIES).toBe(
    "deepseek-v4-pro=effort,thinking,adaptive_thinking,-xhigh_effort,max_effort;deepseek-flash=effort,thinking,adaptive_thinking,-xhigh_effort,max_effort",
  );
  expect(claudeProviderEnv(provider, env)).toEqual(env);
});

test("native Claude capability detection is retained even when catalog levels differ", () => {
  const model = "gateway/claude-native";
  const native = { ...provider, model, smallModel: "", modelCatalog: { [model]: "deepseek/deepseek-v4-pro" } };
  expect(claudeProviderEnv(native, {})).toEqual({});
  const original = options(model);
  expect(claudeConfigOptions(native, original)).toBe(original);
});

for (const model of ["model;*=effort", "model=effort", "model*", "model\nfoo", "model,effort"]) {
  test(`model grammar characters cannot inject capability declarations: ${JSON.stringify(model)}`, () => {
    const bound = { ...provider, model, smallModel: "", modelCatalog: { [model]: "deepseek/deepseek-v4-pro" } };
    const env = claudeProviderEnv(bound, {});
    expect(env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe(model);
    expect(env.CLAUDE_CODE_MODEL_CAPABILITIES).toBeUndefined();
  });
}

test("unknown custom models retain native options without invented metadata", () => {
  const custom = {
    ...provider,
    preset: "custom",
    model: "unlisted",
    smallModel: "",
    anthropicBaseUrl: "https://custom.invalid",
  };
  expect(claudeProviderEnv(custom, {}).CLAUDE_CODE_MODEL_CAPABILITIES).toBeUndefined();
  const original = options(custom.model);
  expect(claudeConfigOptions(custom, original)).toBe(original);
});

test("native effort choices are filtered without fabricating off, changing current, or creating a control", () => {
  const original = options();
  const config = claudeConfigOptions(provider, original, claudeProviderEnv(provider, {}));
  expect(levels(config)).toEqual(["default", "low", "high", "max"]);
  expect(config.find((option) => option.id === "effort")?.currentValue).toBe("medium");
  expect(claudeConfigOptions(provider, original.slice(0, 1))).toEqual(original.slice(0, 1));
});

test("explicit capability declarations remain last and control the native offered choices", () => {
  const declaration = "deepseek-*=effort,xhigh_effort,-max_effort";
  const env = claudeProviderEnv(provider, { CLAUDE_CODE_MODEL_CAPABILITIES: declaration });
  expect(env.CLAUDE_CODE_MODEL_CAPABILITIES?.endsWith(`;${declaration}`)).toBe(true);
  expect(levels(claudeConfigOptions(provider, options(), env))).toEqual(["default", "low", "medium", "high", "xhigh"]);
  const disabled = claudeProviderEnv(provider, { CLAUDE_CODE_MODEL_CAPABILITIES: "deepseek-v4-pro=-effort" });
  expect(levels(claudeConfigOptions(provider, options(), disabled))).toEqual([]);
});

test("a known non-reasoning model never inherits effort from a native alias", () => {
  const model = "custom-nonreasoner";
  const nonreasoner = { ...provider, model, smallModel: "", modelCatalog: { [model]: "openai/gpt-4.1" } };
  expect(claudeProviderEnv(nonreasoner, {}).CLAUDE_CODE_MODEL_CAPABILITIES).toContain(
    "=-effort,-thinking,-adaptive_thinking",
  );
  expect(levels(claudeConfigOptions(nonreasoner, options(model)))).toEqual([]);
});

test("future native off and effort IDs follow the catalog intersection without changing the real current value", () => {
  const future = captureModelCatalog(
    {
      ...provider,
      model: "future-model",
      smallModel: "",
      preset: "custom",
      modelCatalog: { "future-model": "fixture/future-model" },
    },
    catalogSnapshot(
      JSON.stringify({
        fixture: {
          name: "Fixture",
          models: {
            "future-model": {
              name: "Future model",
              reasoning: true,
              reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "ultra"] }],
              limit: { context: 128000, output: 8192 },
              modalities: { input: ["text"] },
            },
          },
        },
      }),
      "2026-10-17T00:00:00Z",
    ),
  );
  const original = options(future.model);
  const effort = original.find((item) => item.id === "effort");
  if (effort?.type !== "select") throw new Error("Missing fixture effort");
  effort.currentValue = "native-unlisted";
  effort.options = ["default", "off", "low", "ultra", "native-unlisted"].map((value) => ({ value, name: value }));
  const result = claudeConfigOptions(future, original, claudeProviderEnv(future, {}));
  expect(levels(result)).toEqual(["default", "off", "low", "ultra"]);
  expect(result.find((item) => item.id === "effort")?.currentValue).toBe("native-unlisted");
  const explicit = claudeProviderEnv(future, { CLAUDE_CODE_MODEL_CAPABILITIES: "future-model=effort,-ultra_effort" });
  expect(levels(claudeConfigOptions(future, original, explicit))).toEqual(["default", "off", "low", "native-unlisted"]);
  effort.options = [{ value: "native-unlisted", name: "Native" }];
  const empty = claudeConfigOptions(future, original);
  expect(empty.find((item) => item.id === "effort")?.currentValue).toBe("native-unlisted");
  expect(levels(empty)).toEqual([]);
});
