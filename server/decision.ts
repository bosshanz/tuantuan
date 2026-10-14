import type { Classification, TaskSignals } from "./classify";
import { type DecisionConfig, DIFFICULTIES, type Difficulty, TASK_TYPES, type TaskType } from "./config";

/**
 * Client for the Bailian decision model (POST {base}/compatible-mode/v1/systemone).
 * One forward pass answers typed questions; no text, no streaming, no tools.
 * Response shape per the official docs: answers[id] = {type, choice|noul|score, probabilities, confidence?, legend?}.
 */

const TASK_CRITERIA: Record<TaskType | "other", string> = {
  chat: "日常对话、问答、写作或简单解释",
  coding: "编写、修改、调试、审查代码或讨论技术实现",
  reasoning: "需要多步推理、分析、比较、规划或数学推导",
  long_context: "需要阅读或处理很长的文档、对话历史或大量材料",
  tool_heavy: "需要调用工具：搜索、抓取网页、计算、查时间等",
  vision: "需要理解图片",
  other: "以上都不符合",
};
const DIFFICULTY_LEVELS = [
  "简单：一两句话就能答好，便宜模型足够",
  "中等：需要一定专业知识或几步推理",
  "困难：复杂、多步骤、要求严谨，需要最强模型",
];

export interface DecisionAnswer {
  taskType: { choice: string; confidence: number };
  difficulty: { score: number; confidence: number; level: Difficulty };
  /** P(yes) that the task needs tools. */
  needsTools: number;
  requestId?: string;
  latencyMs?: number;
}

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "http" | "malformed" | "network",
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

export function buildDecisionRequest(cfg: DecisionConfig, s: TaskSignals) {
  return {
    model: cfg.model,
    state: {
      text: s.text.slice(0, 8000),
      context_tokens: s.contextTokens,
      available_tools: s.toolCount,
      has_images: s.hasImages,
    },
    questions: {
      task_type: { type: "choice", instructions: "这个任务属于哪一类？", criteria: TASK_CRITERIA },
      difficulty: { type: "score", instructions: "这个任务有多难？", criteria: DIFFICULTY_LEVELS },
      needs_tools: { type: "noul", instructions: "完成这个任务是否需要调用外部工具（搜索、抓取网页、计算等）？" },
    },
  };
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseDecisionResponse(body: unknown): DecisionAnswer {
  const bad = (why: string) => new DecisionError(`决策模型返回格式不符：${why}`, "malformed");
  const answers = (body as { answers?: Record<string, Record<string, unknown>> } | null)?.answers;
  if (!answers || typeof answers !== "object") throw bad("缺少 answers");
  const t = answers.task_type;
  const d = answers.difficulty;
  const n = answers.needs_tools;
  if (!t || typeof t.choice !== "string" || !num(t.confidence)) throw bad("task_type 缺少 choice/confidence");
  if (!d || !num(d.score) || !num(d.confidence)) throw bad("difficulty 缺少 score/confidence");
  if (!n || !num(n.noul)) throw bad("needs_tools 缺少 noul");
  // score is the probability-weighted level index (may fall between levels, e.g. 1.43); round to nearest level.
  const idx = Math.min(DIFFICULTIES.length - 1, Math.max(0, Math.round(d.score)));
  const b = body as { request_id?: unknown; latency_ms?: unknown };
  return {
    taskType: { choice: t.choice, confidence: t.confidence },
    difficulty: { score: d.score, confidence: d.confidence, level: DIFFICULTIES[idx] as Difficulty },
    needsTools: n.noul,
    requestId: typeof b.request_id === "string" ? b.request_id : undefined,
    latencyMs: num(b.latency_ms) ? b.latency_ms : undefined,
  };
}

export async function callDecisionModel(
  cfg: DecisionConfig,
  s: TaskSignals,
  signal?: AbortSignal,
  env: Record<string, string | undefined> = process.env,
): Promise<DecisionAnswer> {
  return parseDecisionResponse(await postSystemOne(cfg, buildDecisionRequest(cfg, s), signal, env));
}

/** POSTs one systemone request with the configured timeout; returns the parsed JSON body. */
export async function postSystemOne(
  cfg: DecisionConfig,
  request: unknown,
  signal?: AbortSignal,
  env: Record<string, string | undefined> = process.env,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(cfg.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env[cfg.apiKeyEnv] ?? ""}` },
      body: JSON.stringify(request),
      signal: combined,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (timeout.aborted) throw new DecisionError(`决策模型超时（>${cfg.timeoutMs}ms）`, "timeout");
    throw new DecisionError(`决策模型请求失败：${(e as Error).message}`, "network");
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (signal?.aborted) throw e;
    if (timeout.aborted) throw new DecisionError(`决策模型超时（>${cfg.timeoutMs}ms）`, "timeout");
    throw new DecisionError(`决策模型响应读取失败：${(e as Error).message}`, "network");
  }
  if (!res.ok) throw new DecisionError(`决策模型 HTTP ${res.status}：${text.slice(0, 200)}`, "http");
  try {
    return JSON.parse(text);
  } catch {
    throw new DecisionError(`决策模型返回的不是 JSON：${text.slice(0, 120)}`, "malformed");
  }
}

/** Maps a choice to a router task type; "other" or unknown names yield undefined (treated as no answer). */
export function decisionTaskType(choice: string): TaskType | undefined {
  return TASK_TYPES.includes(choice as TaskType) ? (choice as TaskType) : undefined;
}

export type { Classification };
