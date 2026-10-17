import { expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { captureModelCatalog } from "../server/model-catalog";
import { catalogSnapshot } from "../server/model-catalog-schema";
import { type ProviderSecret, providerConfigOptions } from "../server/providers";

function provider(levels: string[]): ProviderSecret {
  return captureModelCatalog(
    {
      id: "future-options",
      name: "Future options",
      preset: "custom",
      model: "fixture-model",
      smallModel: "",
      openaiBaseUrl: "https://fixture.invalid/v1",
      anthropicBaseUrl: "",
      wireApi: "responses",
      modelCatalog: { "fixture-model": "fixture/fixture-model" },
      apiKey: "fixture",
      mgmtKey: "",
      createdAt: 0,
      updatedAt: 0,
    },
    catalogSnapshot(
      JSON.stringify({
        fixture: {
          name: "Fixture",
          models: {
            "fixture-model": {
              name: "Fixture",
              reasoning: true,
              reasoning_options: [{ type: "effort", values: levels }],
              limit: { context: 10000, output: 2000 },
              modalities: { input: ["text"] },
            },
          },
        },
      }),
      "2026-10-17T00:00:00Z",
    ),
  );
}

function options(levels: string[], model = "fixture-model"): acp.SessionConfigOption[] {
  return [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: `tuantuan/${model}`,
      options: [{ value: `tuantuan/${model}`, name: model }],
    },
    {
      id: "effort",
      category: "thought_level",
      name: "Effort",
      type: "select",
      currentValue: "native-future",
      options: levels.map((value) => ({ value, name: value })),
    },
  ];
}

function effort(result: acp.SessionConfigOption[]) {
  const item = result.find((option) => option.id === "effort");
  if (item?.type !== "select") throw new Error("Expected real effort option");
  return {
    current: item.currentValue,
    choices: item.options.flatMap((option) => ("options" in option ? option.options : [option])).map((o) => o.value),
  };
}

test("OpenCode upgrades expose new catalog-backed choices without leaking unverified automatic variants", () => {
  const native = options(["default", "none", "high", "ultra", "native-future"]);
  const old = providerConfigOptions(provider(["none", "high"]), "opencode", native);
  expect(effort(old)).toEqual({ current: "native-future", choices: ["default", "none", "high"] });
  const updated = providerConfigOptions(provider(["none", "high", "ultra"]), "opencode", native);
  expect(effort(updated)).toEqual({ current: "native-future", choices: ["default", "none", "high", "ultra"] });
  expect(effort(native).choices).toContain("native-future");
});

test("a catalog-only future level is not fabricated when the installed ACP cannot offer it", () => {
  const native = options(["default", "high"]);
  expect(effort(providerConfigOptions(provider(["high", "ultra"]), "opencode", native)).choices).toEqual([
    "default",
    "high",
  ]);
});

test("unknown models keep their native choices and an empty intersection keeps the actual current value", () => {
  const native = options(["native-future"]);
  expect(effort(providerConfigOptions(provider(["high"]), "opencode", native))).toEqual({
    current: "native-future",
    choices: [],
  });
  const unknown = options(["native-future"], "unknown");
  expect(effort(providerConfigOptions(provider(["high"]), "opencode", unknown))).toEqual(effort(unknown));
});

test("native off and none identifiers both preserve an actual supported switch", () => {
  for (const nativeOff of ["off", "none"]) {
    expect(
      effort(providerConfigOptions(provider(["none", "high"]), "opencode", options([nativeOff, "high"]))).choices,
    ).toEqual([nativeOff, "high"]);
  }
});
