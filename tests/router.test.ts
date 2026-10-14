import { describe, expect, test } from "bun:test";
import { classifyByRules } from "../server/classify";
import { type AppConfig, describeProviders, MOCK_CONFIG, parseConfig } from "../server/config";
import { ProviderError } from "../server/llm";
import {
  type Attempt,
  chatWithFallback,
  classify,
  parseClassification,
  planRoute,
  rankCandidates,
} from "../server/router";
import { testConfig } from "./helpers";

const sig = (text: string, extra: Partial<{ contextTokens: number; toolCount: number; hasImages: boolean }> = {}) => ({
  text,
  contextTokens: 100,
  toolCount: 0,
  hasImages: false,
  ...extra,
});

describe("rule classifier", () => {
  test("detects task types", () => {
    expect(classifyByRules(sig("你好呀")).taskType).toBe("chat");
    expect(classifyByRules(sig("这段 python 代码报错了")).taskType).toBe("coding");
    expect(classifyByRules(sig("帮我分析一下两个方案的权衡")).taskType).toBe("reasoning");
    expect(classifyByRules(sig("现在几点", { toolCount: 2 })).taskType).toBe("tool_heavy");
    expect(classifyByRules(sig("现在几点", { toolCount: 0 })).taskType).toBe("chat");
    expect(classifyByRules(sig("hi", { contextTokens: 50000 })).taskType).toBe("long_context");
    expect(classifyByRules(sig("看图", { hasImages: true })).taskType).toBe("vision");
  });

  test("grades difficulty", () => {
    expect(classifyByRules(sig("你好")).difficulty).toBe("easy");
    expect(classifyByRules(sig("修一下这个 bug")).difficulty).toBe("medium");
    expect(classifyByRules(sig("请做一个复杂的系统设计")).difficulty).toBe("hard");
  });
});

describe("classifier output parsing", () => {
  test("accepts valid JSON, even wrapped in prose", () => {
    expect(parseClassification('结果：{"task_type":"coding","difficulty":"hard"}')).toEqual({
      taskType: "coding",
      difficulty: "hard",
    });
  });
  test("rejects unknown labels", () => {
    expect(() => parseClassification('{"task_type":"poetry","difficulty":"easy"}')).toThrow("task_type");
    expect(() => parseClassification("not json")).toThrow("JSON");
  });
});

describe("classify()", () => {
  test("uses the LLM classifier when configured", async () => {
    const out = await classify(testConfig(), sig("写一个 typescript 函数"));
    expect(out).toMatchObject({ source: "llm", taskType: "coding", classifierModel: "mock/small" });
  });
  test("falls back to rules when the classifier model fails, recording why", async () => {
    const out = await classify(testConfig(), sig("写一个 typescript 函数 [[fail:small]]"));
    expect(out.source).toBe("rules");
    expect(out.taskType).toBe("coding");
    expect(out.classifierError).toContain("模拟失败");
  });
  test("uses rules when no classifier model is configured", async () => {
    const out = await classify(testConfig({}, {}), sig("你好"));
    expect(out).toEqual({ taskType: "chat", difficulty: "easy", source: "rules" });
  });
});

describe("rankCandidates", () => {
  test("cheapest tier meeting the difficulty comes first, weaker tiers last", () => {
    const ids = (d: "easy" | "medium" | "hard") =>
      rankCandidates(MOCK_CONFIG, { taskType: "coding", difficulty: d }, 100).models.map((m) => m.id);
    expect(ids("easy")).toEqual(["mock/small", "mock/medium", "mock/large"]);
    expect(ids("medium")).toEqual(["mock/medium", "mock/large", "mock/small"]);
    expect(ids("hard")).toEqual(["mock/large", "mock/medium", "mock/small"]);
  });
  test("filters by tag and context window", () => {
    const r = rankCandidates(MOCK_CONFIG, { taskType: "vision", difficulty: "easy" }, 100);
    expect(r.models.map((m) => m.id)).toEqual(["mock/large"]);
    const big = rankCandidates(MOCK_CONFIG, { taskType: "chat", difficulty: "easy" }, 30000);
    expect(big.models.map((m) => m.id)).toEqual(["mock/large"]);
    expect(rankCandidates(MOCK_CONFIG, { taskType: "chat", difficulty: "easy" }, 10_000_000).models).toEqual([]);
  });
  test("falls back to all fitting models when no model has the tag", () => {
    const cfg: AppConfig = { ...MOCK_CONFIG, models: MOCK_CONFIG.models.slice(0, 1) };
    const r = rankCandidates(cfg, { taskType: "vision", difficulty: "easy" }, 100);
    expect(r.models.map((m) => m.id)).toEqual(["mock/small"]);
    expect(r.reason).toContain("退回");
  });
});

describe("planRoute", () => {
  test("pinned agents skip classification and have no fallback", async () => {
    const plan = await planRoute(testConfig(), { modelMode: "pinned", pinnedModel: "mock/large" }, sig("hi"));
    expect(plan).toMatchObject({ mode: "pinned", candidates: ["mock/large"] });
    expect(plan.classification).toBeUndefined();
  });
  test("pinned to a model no longer configured yields no candidates", async () => {
    const plan = await planRoute(testConfig(), { modelMode: "pinned", pinnedModel: "gone/x" }, sig("hi"));
    expect(plan.candidates).toEqual([]);
  });
});

describe("chatWithFallback", () => {
  const req = (text: string) => ({ messages: [{ role: "user" as const, content: text }] });
  test("moves to the next candidate on provider error and records attempts", async () => {
    const attempts: Attempt[] = [];
    const { result, index } = await chatWithFallback(
      testConfig(),
      ["mock/small", "mock/medium"],
      req("hi [[fail:small]]"),
      attempts,
    );
    expect(index).toBe(1);
    expect(result.content).toContain("mock/medium");
    expect(attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(attempts[0]?.error).toContain("模拟失败");
  });
  test("fails truthfully when every candidate fails", async () => {
    const attempts: Attempt[] = [];
    await expect(chatWithFallback(testConfig(), ["mock/small"], req("[[fail:small]]"), attempts)).rejects.toThrow(
      "所有候选模型均失败",
    );
    expect(attempts).toHaveLength(1);
  });
  test("does not fall back on non-provider errors such as abort", async () => {
    const ctl = new AbortController();
    ctl.abort(new DOMException("x", "AbortError"));
    const attempts: Attempt[] = [];
    await expect(
      chatWithFallback(testConfig(), ["mock/small", "mock/medium"], { ...req("hi"), signal: ctl.signal }, attempts),
    ).rejects.toThrow();
    expect(attempts).toHaveLength(0);
    expect(new ProviderError("m", "x")).toBeInstanceOf(Error);
  });
});

describe("config validation", () => {
  test("rejects models pointing to unknown providers", () => {
    expect(() =>
      parseConfig({
        providers: [{ id: "mock", type: "mock" }],
        models: [{ id: "a", provider: "nope", model: "a", tags: ["chat"], costTier: 1, contextWindow: 1000 }],
      }),
    ).toThrow("不存在的 provider");
  });
  test("applies default limits", () => {
    const c = parseConfig({
      providers: [{ id: "mock", type: "mock" }],
      models: [{ id: "a", provider: "mock", model: "a", tags: ["chat"], costTier: 1, contextWindow: 1000 }],
    });
    expect(c.limits.maxAgentHops).toBe(5);
  });
});

describe("provider baseUrl resolution", () => {
  const cfg = (p: Record<string, unknown>) => ({
    providers: [{ id: "p", type: "openai", apiKeyEnv: "K", ...p }],
    models: [{ id: "p/m", provider: "p", model: "m", tags: ["chat"], costTier: 1, contextWindow: 1000 }],
  });
  const url = (c: AppConfig) => (c.providers[0] as { baseUrl: string }).baseUrl;

  test("env var wins over baseUrl when non-empty", () => {
    const c = parseConfig(cfg({ baseUrl: "https://default.example/v1", baseUrlEnv: "P_URL" }), {
      P_URL: "https://override.example/v1",
    });
    expect(url(c)).toBe("https://override.example/v1");
  });
  test("empty or unset env var falls back to baseUrl", () => {
    const raw = cfg({ baseUrl: "https://default.example/v1", baseUrlEnv: "P_URL" });
    expect(url(parseConfig(raw, { P_URL: "  " }))).toBe("https://default.example/v1");
    expect(url(parseConfig(raw, {}))).toBe("https://default.example/v1");
  });
  test("baseUrlEnv alone is enough when set", () => {
    expect(url(parseConfig(cfg({ baseUrlEnv: "P_URL" }), { P_URL: "http://localhost:3000/v1" }))).toBe(
      "http://localhost:3000/v1",
    );
  });
  test("invalid env URL fails naming the variable", () => {
    expect(() =>
      parseConfig(cfg({ baseUrl: "https://d.example", baseUrlEnv: "P_URL" }), { P_URL: "not a url" }),
    ).toThrow("环境变量 P_URL 不是合法的 http(s) URL");
    expect(() => parseConfig(cfg({ baseUrlEnv: "P_URL" }), { P_URL: "ftp://x.example" })).toThrow("P_URL");
  });
  test("neither source fails naming the provider", () => {
    expect(() => parseConfig(cfg({ baseUrlEnv: "P_URL" }), {})).toThrow(
      "provider p 缺少 baseUrl：请在 .env 设置 P_URL",
    );
    expect(() => parseConfig(cfg({}), {})).toThrow("provider p 缺少 baseUrl");
  });
  test("example config: newapi requires NEWAPI_BASE_URL, others fall back to official defaults", async () => {
    const example = await Bun.file("config/providers.example.json").json();
    expect(() => parseConfig(example, {})).toThrow("NEWAPI_BASE_URL");
    const c = parseConfig(example, { NEWAPI_BASE_URL: "https://relay.example/v1" });
    const byId = Object.fromEntries(c.providers.map((p) => [p.id, p]));
    expect((byId.newapi as { baseUrl: string }).baseUrl).toBe("https://relay.example/v1");
    expect((byId.deepseek as { baseUrl: string }).baseUrl).toBe("https://api.deepseek.com/v1");
    expect(describeProviders(c, { DEEPSEEK_API_KEY: "x" }).join("\n")).toContain("缺少 ARK_API_KEY");
  });
});
