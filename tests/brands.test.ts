import { expect, test } from "bun:test";
import { BRAND_SVG } from "../web/src/brandIcons";
import { type Brand, brandFor, brandOfModel } from "../web/src/brands";

const TABLE: [string, Brand][] = [
  ["claude-opus-4-1", "anthropic"],
  ["claude-sonnet-4-5-20250929", "anthropic"],
  ["anthropic/claude-3.7-sonnet", "anthropic"],
  ["opus", "anthropic"],
  ["haiku", "anthropic"],
  ["us.anthropic.claude-3-5-haiku-20241022-v1:0", "anthropic"],
  ["gpt-5.5", "openai"],
  ["gpt-5-codex", "openai"],
  ["gpt-4o-mini", "openai"],
  ["o3", "openai"],
  ["o4-mini", "openai"],
  ["codex-mini-latest", "openai"],
  ["openai/gpt-oss-120b", "openai"],
  ["gemini-2.5-pro", "google"],
  ["google/gemini-2.5-flash", "google"],
  ["gemma-3-27b-it", "google"],
  ["grok-code-fast-1", "xai"],
  ["x-ai/grok-4", "xai"],
  ["grok-4-0709", "xai"],
  ["glm-4.6", "zhipu"],
  ["GLM-5.3", "zhipu"],
  ["z-ai/glm-4.5-air", "zhipu"],
  ["zai-org/GLM-4.5", "zhipu"],
  ["kimi-k2-0905-preview", "moonshot"],
  ["moonshotai/kimi-k2", "moonshot"],
  ["moonshot-v1-8k", "moonshot"],
  ["qwen3-coder-plus", "qwen"],
  ["qwen/qwen3-235b-a22b", "qwen"],
  ["qwq-32b", "qwen"],
  ["deepseek-chat", "deepseek"],
  ["deepseek-reasoner", "deepseek"],
  ["deepseek/deepseek-r1-distill-llama-70b", "deepseek"],
  ["MiniMax-M2", "minimax"],
  ["minimax/minimax-m1", "minimax"],
  ["abab6.5s-chat", "minimax"],
  ["doubao-seed-1.6", "doubao"],
  ["doubao-1.5-pro-32k", "doubao"],
  ["bytedance-seed/seed-oss-36b-instruct", "doubao"],
  ["mistral-large-latest", "mistral"],
  ["mistralai/devstral-small", "mistral"],
  ["codestral-2508", "mistral"],
  ["mixtral-8x7b", "mistral"],
  ["meta-llama/llama-3.3-70b-instruct", "meta"],
  ["llama-4-maverick", "meta"],
  ["openrouter/auto", "generic"],
  ["mock-fast", "generic"],
  ["my-finetune-v2", "generic"],
  ["", "generic"],
];

test.each(TABLE)("%s → %s", (id, brand) => {
  expect(brandOfModel(id)).toBe(brand);
});

test("unknown ids never borrow the harness vendor; only the default alias does", () => {
  expect(brandFor("my-proxy-model", "claude-code")).toBe("generic");
  expect(brandFor("default", "claude-code")).toBe("anthropic");
  expect(brandFor("default", "codex")).toBe("openai");
  expect(brandFor("opus", "claude-code", "GLM-5.3")).toBe("zhipu"); // Claude Code routed to GLM
  expect(brandFor("mock-fast", "mock")).toBe("generic");
});

test("every vendor brand has an official mark; generic uses the neutral glyph", () => {
  for (const b of new Set(TABLE.map(([, b]) => b))) {
    if (b === "generic") expect(BRAND_SVG[b]).toBeUndefined();
    else expect(BRAND_SVG[b]).toContain("<path");
  }
});
