import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AppConfig, decisionFromEnv } from "../server/config";
import { buildDecisionRequest } from "../server/decision";
import { classify, planRoute } from "../server/router";
import { testConfig } from "./helpers";

// Fake systemone endpoint; behaviour is chosen per request by the "mode" in the task text.
let lastBody: Record<string, unknown> | undefined;
let lastAuth: string | null = null;
const answer = (t: string, tc: number, score: number, dc: number, noul = 0.1) => ({
  model: "decision-model-preview",
  request_id: "req-1",
  answers: {
    task_type: { type: "choice", choice: t, confidence: tc, probabilities: { [t]: tc } },
    difficulty: {
      type: "score",
      score,
      confidence: dc,
      legend: { "0": "简单", "1": "中等", "2": "困难" },
      probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
    },
    needs_tools: { type: "noul", noul },
  },
  usage: { input_tokens: 120 },
  latency_ms: 42.5,
});
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/compatible-mode/v1/systemone") return new Response("not found", { status: 404 });
    lastAuth = req.headers.get("authorization");
    lastBody = (await req.json()) as Record<string, unknown>;
    const text = (lastBody.state as { text: string }).text;
    if (text.startsWith("ok")) return Response.json(answer("coding", 0.9, 1.8, 0.85));
    if (text.startsWith("lowdiff")) return Response.json(answer("coding", 0.9, 0.2, 0.3));
    if (text.startsWith("other")) return Response.json(answer("other", 0.95, 2, 0.9));
    if (text.startsWith("tools")) return Response.json(answer("chat", 0.8, 0, 0.9, 0.92));
    if (text.startsWith("http")) return Response.json({ code: "InvalidApiKey", message: "bad key" }, { status: 401 });
    if (text.startsWith("slow")) {
      await Bun.sleep(400);
      return Response.json(answer("chat", 0.9, 0, 0.9));
    }
    if (text.startsWith("malformed")) return Response.json({ answers: { task_type: { choice: "chat" } } });
    if (text.startsWith("notjson")) return new Response("<html>gateway</html>");
    return new Response("unexpected", { status: 500 });
  },
});
afterAll(() => server.stop(true));

const env = {
  DECISION_BASE_URL: `http://localhost:${server.port}`,
  DASHSCOPE_API_KEY: "sk-test",
  DECISION_TIMEOUT_MS: "150",
};
let config: AppConfig;
beforeAll(() => {
  process.env.DASHSCOPE_API_KEY = "sk-test";
  // classifierModel undefined → fallback is the rule classifier, which keeps expectations deterministic.
  config = { ...testConfig({}, {}), decision: decisionFromEnv(env) };
});
const sig = (text: string, toolCount = 0) => ({ text, contextTokens: 100, toolCount, hasImages: false });

describe("decision model env config", () => {
  test("disabled without DECISION_BASE_URL; endpoint, key and defaults resolved", () => {
    expect(decisionFromEnv({ DASHSCOPE_API_KEY: "x" })).toBeUndefined();
    const d = decisionFromEnv({
      DECISION_BASE_URL: "https://ws1.cn-beijing.maas.aliyuncs.com/",
      DASHSCOPE_API_KEY: "x",
    });
    expect(d).toEqual({
      endpoint: "https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone",
      apiKeyEnv: "DASHSCOPE_API_KEY",
      model: "decision-model-preview",
      minConfidence: 0.6,
      timeoutMs: 3000,
    });
    const full = "https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone";
    expect(decisionFromEnv({ DECISION_BASE_URL: full, DECISION_API_KEY: "y" })?.apiKeyEnv).toBe("DECISION_API_KEY");
    expect(decisionFromEnv({ DECISION_BASE_URL: full, DECISION_API_KEY: "y" })?.endpoint).toBe(full);
  });
  test("errors: bad URL, no key, bad confidence", () => {
    expect(() => decisionFromEnv({ DECISION_BASE_URL: "nope", DASHSCOPE_API_KEY: "x" })).toThrow("DECISION_BASE_URL");
    expect(() => decisionFromEnv({ DECISION_BASE_URL: "https://a.example" })).toThrow("DECISION_API_KEY");
    expect(() =>
      decisionFromEnv({ DECISION_BASE_URL: "https://a.example", DASHSCOPE_API_KEY: "x", DECISION_MIN_CONFIDENCE: "2" }),
    ).toThrow("DECISION_MIN_CONFIDENCE");
  });
  test("request has the documented shape", () => {
    const body = buildDecisionRequest(config.decision as NonNullable<AppConfig["decision"]>, sig("hi"));
    expect(body.model).toBe("decision-model-preview");
    expect(body.questions.task_type.type).toBe("choice");
    expect(Object.keys(body.questions.task_type.criteria)).toContain("other");
    expect(body.questions.difficulty.criteria).toHaveLength(3);
    expect(body.questions.needs_tools.type).toBe("noul");
  });
});

describe("systemone classifier", () => {
  test("success: uses decision model answer, sends bearer key", async () => {
    const c = await classify(config, sig("ok 写个函数"));
    expect(lastAuth).toBe("Bearer sk-test");
    expect(c).toMatchObject({ source: "systemone", taskType: "coding", difficulty: "hard" });
    expect(c.decision).toMatchObject({
      requestId: "req-1",
      latencyMs: 42.5,
      taskType: { used: true },
      difficulty: { used: true },
    });
    expect(c.fallbackReason).toBeUndefined();
  });
  test("low confidence on one field falls back for that field only", async () => {
    const c = await classify(config, sig("lowdiff 比较一下两个方案的权衡 复杂"));
    expect(c.source).toBe("systemone");
    expect(c.taskType).toBe("coding");
    expect(c.difficulty).toBe("hard"); // from rules (复杂), not the decision model's "easy"
    expect(c.decision?.difficulty?.used).toBe(false);
    expect(c.fallbackReason).toContain("难度置信度 0.30 < 0.6");
  });
  test('"other" task type falls back to the next classifier', async () => {
    const c = await classify(config, sig("other 你好"));
    expect(c.taskType).toBe("chat");
    expect(c.difficulty).toBe("hard");
    expect(c.fallbackReason).toContain("任务类型为 other");
  });
  test("needs_tools bumps chat to tool_heavy when tools exist", async () => {
    const c = await classify(config, sig("tools 今天天气", 2));
    expect(c.taskType).toBe("tool_heavy");
    expect(c.note).toContain("needs_tools=0.92");
    expect((await classify(config, sig("tools 今天天气", 0))).taskType).toBe("chat");
  });
  test("HTTP error falls back to rules with the reason recorded", async () => {
    const c = await classify(config, sig("http 写个函数"));
    expect(c.source).toBe("rules");
    expect(c.decision?.error).toContain("HTTP 401");
    expect(c.fallbackReason).toContain("改用规则分类");
  });
  test("timeout falls back", async () => {
    const t = Date.now();
    const c = await classify(config, sig("slow 你好"));
    expect(Date.now() - t).toBeLessThan(380);
    expect(c.source).toBe("rules");
    expect(c.decision?.error).toContain("超时");
  });
  test("malformed or non-JSON response falls back", async () => {
    expect((await classify(config, sig("malformed x"))).decision?.error).toContain("返回格式不符");
    expect((await classify(config, sig("notjson x"))).decision?.error).toContain("不是 JSON");
  });
  test("falls back to the LLM classifier when one is configured", async () => {
    const withLlm = { ...config, router: { classifierModel: "mock/small" } };
    const c = await classify(withLlm, sig("http hi"));
    expect(c.source).toBe("llm");
    expect(c.fallbackReason).toContain("LLM 分类器（mock/small）");
  });
  test("decision is recorded in the routing plan", async () => {
    const plan = await planRoute(config, { modelMode: "auto", pinnedModel: null }, sig("ok code"));
    expect(plan.classification?.decision?.taskType?.choice).toBe("coding");
  });
});
