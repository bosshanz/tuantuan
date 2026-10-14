import { afterAll, describe, expect, test } from "bun:test";
import { type AppConfig, decisionFromEnv } from "../server/config";
import { buildPickerRequest, type Member, pickByRules, pickResponder } from "../server/picker";
import { testConfig } from "./helpers";

const members: Member[] = [
  { id: "fe", name: "前端Fay", systemPrompt: "负责前端页面、CSS 和交互" },
  { id: "db", name: "后端Dan", systemPrompt: "负责数据库、SQL 和后端接口" },
  { id: "pm", name: "产品Pam", systemPrompt: "[[reply:好的]] 负责需求和排期" },
];

let reply: () => Response = () => new Response("unset", { status: 500 });
const fake = Bun.serve({ port: 0, fetch: () => reply() });
afterAll(() => fake.stop(true));
const responder = (choice: string, confidence: number) => () =>
  Response.json({ model: "decision-model-preview", answers: { responder: { type: "choice", choice, confidence } } });

const withDecision = (llm: boolean): AppConfig => ({
  ...testConfig({}, llm ? { classifierModel: "mock/small" } : {}),
  decision: decisionFromEnv({
    DECISION_BASE_URL: `http://localhost:${fake.port}`,
    DASHSCOPE_API_KEY: "k",
    DECISION_TIMEOUT_MS: "200",
  }),
});

describe("responder picker", () => {
  test("rules: keyword overlap wins, ties/zero fall to member order; mock directives are ignored", () => {
    expect(pickByRules("SQL 查询太慢", members)).toMatchObject({ agentId: "db", by: "rules" });
    expect(pickByRules("CSS 样式错位", members).agentId).toBe("fe");
    expect(pickByRules("在吗", members)).toMatchObject({
      agentId: "fe",
      reason: "没有匹配的关键词，默认交给第一个成员",
    });
    expect(pickByRules("reply", members).agentId).toBe("fe");
  });
  test("systemone request lists members (name → profile) plus other", () => {
    const r = buildPickerRequest("decision-model-preview", "hi", members);
    expect(r.questions.responder.type).toBe("choice");
    expect(Object.keys(r.questions.responder.criteria)).toEqual(["前端Fay", "后端Dan", "产品Pam", "other"]);
    expect(r.questions.responder.criteria.产品Pam).toBe("负责需求和排期");
  });
  test("systemone confident choice is used", async () => {
    reply = responder("产品Pam", 0.9);
    expect(await pickResponder(withDecision(true), "下周排期", members)).toMatchObject({
      agentId: "pm",
      by: "systemone",
      confidence: 0.9,
    });
  });
  test("low confidence → LLM picker (mock), reason recorded", async () => {
    reply = responder("产品Pam", 0.3);
    const s = await pickResponder(withDecision(true), "SQL 慢", members);
    expect(s).toMatchObject({ agentId: "db", by: "llm" });
    expect(s.fallbackReason).toContain("置信度 0.30 < 0.6（倾向 产品Pam）");
  });
  test('"other", HTTP error and timeout fall through to rules when no LLM classifier', async () => {
    reply = responder("other", 0.95);
    expect((await pickResponder(withDecision(false), "SQL 慢", members)).fallbackReason).toContain(
      "决策模型选择了 other",
    );
    reply = () => new Response("bad key", { status: 401 });
    const e = await pickResponder(withDecision(false), "SQL 慢", members);
    expect(e).toMatchObject({ agentId: "db", by: "rules" });
    expect(e.fallbackReason).toContain("HTTP 401");
    reply = () => new Response(new ReadableStream({ start() {} })); // never finishes
    expect((await pickResponder(withDecision(false), "CSS", members)).fallbackReason).toContain("超时");
  });
  test("single member needs no picker", async () => {
    expect(await pickResponder(testConfig(), "x", [members[1] as Member])).toMatchObject({ by: "only", agentId: "db" });
  });
});
