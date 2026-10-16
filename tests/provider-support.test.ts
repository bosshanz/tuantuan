import { describe, expect, test } from "bun:test";
import { providerSupports, supportsProviderProfiles } from "../shared/providerSupport";

const harnesses = ["claude-code", "opencode", "pi", "codex", "custom", "grok", "reg:opencode"];

describe("saved provider compatibility", () => {
  test("only supported built-in harnesses offer provider profiles", () => {
    expect(harnesses.filter(supportsProviderProfiles)).toEqual(["claude-code", "opencode", "pi", "codex", "custom"]);
    expect(supportsProviderProfiles("")).toBe(false);
  });

  test.each([
    { name: "empty", anthropic: "", openai: "", model: "m", wireApi: "responses", expected: [] },
    { name: "whitespace addresses", anthropic: "  ", openai: "\n", model: "m", wireApi: "responses", expected: [] },
    {
      name: "Anthropic without model",
      anthropic: "https://api.example.com/anthropic",
      openai: "",
      wireApi: "chat",
      expected: ["claude-code", "custom"],
    },
    {
      name: "Anthropic with model",
      anthropic: "https://api.example.com/anthropic",
      openai: "",
      model: "model-id",
      wireApi: "responses",
      expected: ["claude-code", "opencode", "pi", "custom"],
    },
    {
      name: "OpenAI Chat without model",
      anthropic: "",
      openai: "https://api.example.com/v1",
      wireApi: "chat",
      expected: ["custom"],
    },
    {
      name: "OpenAI Chat with model",
      anthropic: "",
      openai: "https://api.example.com/v1",
      model: "model-id",
      wireApi: "chat",
      expected: ["opencode", "pi", "custom"],
    },
    {
      name: "OpenAI Responses without model",
      anthropic: "",
      openai: "https://api.example.com/v1",
      wireApi: "responses",
      expected: ["codex", "custom"],
    },
    {
      name: "both addresses with blank model",
      anthropic: "https://api.example.com/anthropic",
      openai: "https://api.example.com/v1",
      model: " \n ",
      wireApi: "responses",
      expected: ["claude-code", "codex", "custom"],
    },
    {
      name: "both addresses with model and Responses",
      anthropic: "https://api.example.com/anthropic",
      openai: "https://api.example.com/v1",
      model: " model-id ",
      wireApi: "responses",
      expected: ["claude-code", "opencode", "pi", "codex", "custom"],
    },
  ] as const)("$name", ({ anthropic, openai, model, wireApi, expected }) => {
    const provider = { anthropicBaseUrl: anthropic, openaiBaseUrl: openai, model, wireApi };
    expect(harnesses.filter((harness) => providerSupports(provider, harness))).toEqual([...expected]);
  });
});
