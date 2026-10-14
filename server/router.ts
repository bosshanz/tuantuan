import { type Classification, classifyByRules, type TaskSignals } from "./classify";
import { type AppConfig, DIFFICULTIES, type Difficulty, type ModelConfig, TASK_TYPES, type TaskType } from "./config";
import { type ChatRequest, type ChatResult, chat, ProviderError } from "./llm";

export interface ClassifierOutcome extends Classification {
  source: "llm" | "rules";
  classifierModel?: string;
  /** Why the LLM classifier was not used / failed; undefined when it succeeded or none configured. */
  classifierError?: string;
}

export interface RoutingPlan {
  mode: "auto" | "pinned";
  signals: Omit<TaskSignals, "text"> & { textPreview: string };
  classification?: ClassifierOutcome;
  /** Ordered model ids to try. */
  candidates: string[];
  reason: string;
}

export interface Attempt {
  modelId: string;
  ok: boolean;
  error?: string;
}

const DEFAULT_MIN_TIER: Record<Difficulty, number> = { easy: 1, medium: 2, hard: 3 };

const CLASSIFIER_PROMPT = `你是任务路由分类器。根据用户给出的 JSON（text 为任务文本，contextTokens 为上下文估算 token 数，toolCount 为可用工具数，hasImages 表示是否带图片），
只输出一个 JSON 对象：{"task_type": one of ${TASK_TYPES.join("|")}, "difficulty": one of ${DIFFICULTIES.join("|")}, "reason": 简短中文理由}。`;

export async function classify(
  config: AppConfig,
  signals: TaskSignals,
  signal?: AbortSignal,
): Promise<ClassifierOutcome> {
  const modelId = config.router.classifierModel;
  if (!modelId) return { ...classifyByRules(signals), source: "rules" };
  const model = config.models.find((m) => m.id === modelId);
  if (!model) return { ...classifyByRules(signals), source: "rules", classifierError: `分类模型 ${modelId} 未配置` };
  try {
    const res = await chat(config, model, {
      json: true,
      signal,
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        { role: "user", content: JSON.stringify({ ...signals, text: signals.text.slice(0, 4000) }) },
      ],
    });
    return { ...parseClassification(res.content), source: "llm", classifierModel: modelId };
  } catch (e) {
    if (signal?.aborted) throw e;
    return {
      ...classifyByRules(signals),
      source: "rules",
      classifierModel: modelId,
      classifierError: (e as Error).message,
    };
  }
}

export function parseClassification(raw: string): Classification {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) throw new Error(`分类器输出不是 JSON: ${raw.slice(0, 120)}`);
  const obj = JSON.parse(match[0]) as { task_type?: unknown; difficulty?: unknown };
  if (!TASK_TYPES.includes(obj.task_type as TaskType))
    throw new Error(`分类器 task_type 非法: ${String(obj.task_type)}`);
  if (!DIFFICULTIES.includes(obj.difficulty as Difficulty))
    throw new Error(`分类器 difficulty 非法: ${String(obj.difficulty)}`);
  return { taskType: obj.task_type as TaskType, difficulty: obj.difficulty as Difficulty };
}

/**
 * Orders models for a classified task: models tagged for the task type and with
 * enough context window; among them the cheapest tier that meets the difficulty's
 * minimum tier comes first, then stronger tiers, then weaker tiers as last resort.
 */
export function rankCandidates(
  config: AppConfig,
  c: Classification,
  contextTokens: number,
): { models: ModelConfig[]; reason: string } {
  const fits = config.models.filter((m) => m.contextWindow >= contextTokens * 1.2);
  const tagged = fits.filter((m) => m.tags.includes(c.taskType));
  const pool = tagged.length > 0 ? tagged : fits;
  if (pool.length === 0)
    return { models: [], reason: `没有上下文窗口 ≥ ${Math.ceil(contextTokens * 1.2)} token 的模型` };
  const minTier = config.router.minTier?.[c.difficulty] ?? DEFAULT_MIN_TIER[c.difficulty];
  const key = (m: ModelConfig) => (m.costTier >= minTier ? m.costTier : 10 - m.costTier);
  const models = pool
    .map((m, i) => ({ m, i }))
    .sort((a, b) => key(a.m) - key(b.m) || a.i - b.i)
    .map((x) => x.m);
  const tagNote = tagged.length > 0 ? `具备 ${c.taskType} 标签` : `无模型具备 ${c.taskType} 标签，退回全部可用模型`;
  return { models, reason: `${c.taskType}/${c.difficulty}：${tagNote}，优先成本档 ≥ ${minTier} 中最便宜的` };
}

export async function planRoute(
  config: AppConfig,
  agent: { modelMode: "auto" | "pinned"; pinnedModel: string | null },
  signals: TaskSignals,
  signal?: AbortSignal,
): Promise<RoutingPlan> {
  const recorded = {
    contextTokens: signals.contextTokens,
    toolCount: signals.toolCount,
    hasImages: signals.hasImages,
    textPreview: signals.text.slice(0, 200),
  };
  if (agent.modelMode === "pinned") {
    const pinned = agent.pinnedModel ?? "";
    const exists = config.models.some((m) => m.id === pinned);
    return {
      mode: "pinned",
      signals: recorded,
      candidates: exists ? [pinned] : [],
      reason: exists ? `Agent 固定使用 ${pinned}，不做回退` : `固定模型 ${pinned} 不在当前配置中`,
    };
  }
  const classification = await classify(config, signals, signal);
  const ranked = rankCandidates(config, classification, signals.contextTokens);
  return {
    mode: "auto",
    signals: recorded,
    classification,
    candidates: ranked.models.map((m) => m.id),
    reason: ranked.reason,
  };
}

/**
 * Tries candidates in order. Only ProviderError (failure before any output) moves to
 * the next model; other errors and aborts propagate so partial output is never replayed.
 * `startAt` lets a multi-step tool loop stay on the model that already worked.
 */
export async function chatWithFallback(
  config: AppConfig,
  candidates: string[],
  req: ChatRequest,
  attempts: Attempt[],
  startAt = 0,
): Promise<{ result: ChatResult; index: number }> {
  if (candidates.length === 0) throw new Error("没有可用的候选模型");
  for (let i = startAt; i < candidates.length; i++) {
    const id = candidates[i] as string;
    const model = config.models.find((m) => m.id === id);
    if (!model) {
      attempts.push({ modelId: id, ok: false, error: "模型不在配置中" });
      continue;
    }
    try {
      const result = await chat(config, model, req);
      attempts.push({ modelId: id, ok: true });
      return { result, index: i };
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      attempts.push({ modelId: id, ok: false, error: e.message });
    }
  }
  throw new Error(
    `所有候选模型均失败：${attempts
      .filter((a) => !a.ok)
      .map((a) => `${a.modelId}(${a.error})`)
      .join("; ")}`,
  );
}
