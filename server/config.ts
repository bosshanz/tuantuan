import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Runtime configuration. Providers and the routing table live in a JSON file
 * (default config/providers.json, gitignored); API keys are only referenced by
 * env var name so the file never holds secrets.
 */

export const TASK_TYPES = ["chat", "coding", "reasoning", "long_context", "tool_heavy", "vision"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

const ProviderSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("mock") }),
  z.object({
    id: z.string(),
    type: z.literal("openai"),
    /** Fallback URL; used when baseUrlEnv is absent or that env var is empty. */
    baseUrl: z.string().url().optional(),
    /** Env var name whose non-empty value overrides baseUrl, so URLs can live in .env. */
    baseUrlEnv: z.string().optional(),
    apiKeyEnv: z.string(),
  }),
]);

const ModelSchema = z.object({
  /** Stable id used in routing table, pinned agents and UI, e.g. "deepseek/deepseek-chat". */
  id: z.string(),
  provider: z.string(),
  /** Model name sent to the provider API. */
  model: z.string(),
  tags: z.array(z.enum(TASK_TYPES)).min(1),
  /** 1 = cheapest, 3 = strongest/most expensive. */
  costTier: z.number().int().min(1).max(3),
  contextWindow: z.number().int().positive(),
});

const ConfigSchema = z.object({
  providers: z.array(ProviderSchema).min(1),
  models: z.array(ModelSchema).min(1),
  router: z
    .object({
      /** Model id used to classify tasks. Omit to always use the deterministic rules. */
      classifierModel: z.string().optional(),
      /** Minimum cost tier preferred per difficulty. */
      minTier: z.record(z.enum(DIFFICULTIES), z.number().int().min(1).max(3)).optional(),
    })
    .default({}),
  limits: z
    .object({
      maxAgentHops: z.number().int().min(0).default(5),
      maxToolIterations: z.number().int().min(1).default(6),
      contextMessages: z.number().int().min(1).default(30),
      contextChars: z.number().int().min(1000).default(24000),
    })
    .default({ maxAgentHops: 5, maxToolIterations: 6, contextMessages: 30, contextChars: 24000 }),
});

/** After parseConfig, every openai provider has a resolved baseUrl. */
export type ProviderConfig =
  | { id: string; type: "mock" }
  | { id: string; type: "openai"; baseUrl: string; baseUrlEnv?: string; apiKeyEnv: string };
export type ModelConfig = z.infer<typeof ModelSchema>;
export type AppConfig = Omit<z.infer<typeof ConfigSchema>, "providers"> & {
  providers: ProviderConfig[];
  /** Bailian decision model (systemone) classifier; enabled only when DECISION_BASE_URL is set. */
  decision?: DecisionConfig;
};

export interface DecisionConfig {
  /** Full endpoint, ending in /compatible-mode/v1/systemone. */
  endpoint: string;
  /** Env var holding the key (never the key itself). */
  apiKeyEnv: string;
  model: string;
  minConfidence: number;
  timeoutMs: number;
}

type Env = Record<string, string | undefined>;

/** baseUrlEnv (if set and non-empty) > baseUrl > config error. */
export function resolveBaseUrl(p: { id: string; baseUrl?: string; baseUrlEnv?: string }, env: Env): string {
  const fromEnv = p.baseUrlEnv ? env[p.baseUrlEnv]?.trim() : undefined;
  if (fromEnv) {
    if (!URL.canParse(fromEnv) || !/^https?:$/.test(new URL(fromEnv).protocol))
      throw new Error(`环境变量 ${p.baseUrlEnv} 不是合法的 http(s) URL: ${fromEnv}`);
    return fromEnv;
  }
  if (p.baseUrl) return p.baseUrl;
  throw new Error(
    p.baseUrlEnv
      ? `provider ${p.id} 缺少 baseUrl：请在 .env 设置 ${p.baseUrlEnv}，或在配置文件中填写 baseUrl`
      : `provider ${p.id} 缺少 baseUrl（或 baseUrlEnv）`,
  );
}

/** Used when no config file exists: everything runs on the deterministic mock provider. */
export const MOCK_CONFIG: AppConfig = {
  providers: [{ id: "mock", type: "mock" }],
  models: [
    {
      id: "mock/small",
      provider: "mock",
      model: "small",
      tags: ["chat", "coding", "reasoning", "tool_heavy"],
      costTier: 1,
      contextWindow: 8000,
    },
    {
      id: "mock/medium",
      provider: "mock",
      model: "medium",
      tags: ["chat", "coding", "reasoning", "tool_heavy", "long_context"],
      costTier: 2,
      contextWindow: 32000,
    },
    {
      id: "mock/large",
      provider: "mock",
      model: "large",
      tags: ["chat", "coding", "reasoning", "tool_heavy", "long_context", "vision"],
      costTier: 3,
      contextWindow: 128000,
    },
  ],
  router: { classifierModel: "mock/small" },
  limits: { maxAgentHops: 5, maxToolIterations: 6, contextMessages: 30, contextChars: 24000 },
};

export function parseConfig(raw: unknown, env: Env = process.env): AppConfig {
  const parsed = ConfigSchema.parse(raw);
  const config: AppConfig = {
    ...parsed,
    providers: parsed.providers.map((p) => (p.type === "openai" ? { ...p, baseUrl: resolveBaseUrl(p, env) } : p)),
  };
  const providerIds = new Set(config.providers.map((p) => p.id));
  const modelIds = new Set<string>();
  for (const m of config.models) {
    if (!providerIds.has(m.provider)) throw new Error(`模型 ${m.id} 引用了不存在的 provider ${m.provider}`);
    if (modelIds.has(m.id)) throw new Error(`模型 id 重复: ${m.id}`);
    modelIds.add(m.id);
  }
  const cls = config.router.classifierModel;
  if (cls && !modelIds.has(cls)) throw new Error(`router.classifierModel ${cls} 不在 models 中`);
  return config;
}

/**
 * Config sources, in order:
 * 1. AGENT_HUB_MODELS set → env selection wins: 1–5 real models from the built-in providers
 *    (or providers.json providers/models when the file exists, which override built-ins).
 * 2. providers.json exists → used as is.
 * 3. Neither → built-in mock.
 * DECISION_* env vars add the systemone classifier on top of any of these.
 */
export function loadConfig(
  path = process.env.AGENT_HUB_CONFIG ?? "config/providers.json",
  env: Env = process.env,
): { config: AppConfig; source: string } {
  const abs = resolve(path);
  const file = existsSync(abs) ? JSON.parse(readFileSync(abs, "utf8")) : undefined;
  let config: AppConfig;
  let source: string;
  if (env.AGENT_HUB_MODELS?.trim()) {
    config = configFromEnv(env, file);
    source = file ? `env:AGENT_HUB_MODELS（provider/目录参考 ${abs}）` : "env:AGENT_HUB_MODELS";
  } else if (file) {
    config = parseConfig(file, env);
    source = abs;
  } else {
    config = MOCK_CONFIG;
    source = "builtin-mock";
  }
  const decision = decisionFromEnv(env);
  return { config: decision ? { ...config, decision } : config, source };
}

export const MAX_ENV_MODELS = 5;

/** Built-in OpenAI-compatible providers so the common case needs only .env. */
export const BUILTIN_PROVIDERS = [
  { id: "newapi", type: "openai", baseUrlEnv: "NEWAPI_BASE_URL", apiKeyEnv: "NEWAPI_API_KEY" },
  {
    id: "deepseek",
    type: "openai",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  {
    id: "qwen",
    type: "openai",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  {
    id: "doubao",
    type: "openai",
    baseUrlEnv: "ARK_BASE_URL",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "ARK_API_KEY",
  },
] as const;

type CatalogEntry = Pick<ModelConfig, "tags" | "costTier" | "contextWindow">;
/**
 * Routing metadata for well-known models, keyed by the model name sent to the API
 * (so "newapi/deepseek-chat" works too). Values are routing hints, not vendor guarantees;
 * override with AGENT_HUB_MODEL_<n>_TAGS / _TIER / _CONTEXT.
 */
export const MODEL_CATALOG: Record<string, CatalogEntry> = {
  "deepseek-chat": { tags: ["chat", "coding", "tool_heavy"], costTier: 2, contextWindow: 128000 },
  "deepseek-reasoner": { tags: ["reasoning", "coding"], costTier: 3, contextWindow: 128000 },
  "qwen-turbo": { tags: ["chat", "tool_heavy"], costTier: 1, contextWindow: 128000 },
  "qwen-plus": { tags: ["chat", "coding", "reasoning", "tool_heavy"], costTier: 2, contextWindow: 128000 },
  "qwen-max": { tags: ["chat", "coding", "reasoning", "tool_heavy"], costTier: 3, contextWindow: 32000 },
  "qwen-long": { tags: ["long_context", "chat"], costTier: 2, contextWindow: 1000000 },
  "qwen-vl-plus": { tags: ["vision", "chat"], costTier: 2, contextWindow: 128000 },
  "doubao-seed-1-6-250615": {
    tags: ["chat", "coding", "reasoning", "vision", "tool_heavy"],
    costTier: 3,
    contextWindow: 256000,
  },
  "doubao-seed-1-6-flash-250615": { tags: ["chat", "tool_heavy", "vision"], costTier: 1, contextWindow: 256000 },
};

/** Builds the active config from AGENT_HUB_MODELS. Throws Chinese errors naming the offending entry/var. */
export function configFromEnv(env: Env, file?: unknown): AppConfig {
  const base = file ? ConfigSchema.parse(file) : undefined;
  const ids = (env.AGENT_HUB_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`AGENT_HUB_MODELS 中模型重复: ${id}`);
    seen.add(id);
  }
  const providerDefs = new Map<string, z.infer<typeof ProviderSchema>>(
    BUILTIN_PROVIDERS.map((p) => [p.id, { ...p } as z.infer<typeof ProviderSchema>]),
  );
  providerDefs.set("mock", { id: "mock", type: "mock" });
  for (const p of base?.providers ?? []) providerDefs.set(p.id, p);

  const models: ModelConfig[] = [];
  ids.forEach((id, i) => {
    const n = i + 1;
    const slash = id.indexOf("/");
    if (slash <= 0 || slash === id.length - 1)
      throw new Error(`AGENT_HUB_MODELS 第 ${n} 项 "${id}" 格式应为 provider/模型名，例如 deepseek/deepseek-chat`);
    const providerId = id.slice(0, slash);
    const name = id.slice(slash + 1);
    if (!providerDefs.has(providerId))
      throw new Error(
        `AGENT_HUB_MODELS 第 ${n} 项 "${id}" 的 provider ${providerId} 未知，可选：${[...providerDefs.keys()].join(", ")}`,
      );
    if (providerId === "mock") {
      const m = MOCK_CONFIG.models.find((x) => x.id === id);
      if (!m) throw new Error(`AGENT_HUB_MODELS 第 ${n} 项 "${id}" 不是内置 mock 模型`);
      models.push(m);
      return;
    }
    const fromFile =
      base?.models.find((m) => m.id === id) ?? base?.models.find((m) => m.provider === providerId && m.model === name);
    const known: Partial<CatalogEntry> = fromFile ?? MODEL_CATALOG[name] ?? {};
    const pre = `AGENT_HUB_MODEL_${n}`;
    const tagsRaw = env[`${pre}_TAGS`]?.trim();
    const tierRaw = env[`${pre}_TIER`]?.trim();
    const ctxRaw = env[`${pre}_CONTEXT`]?.trim();
    const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()) : known.tags;
    const costTier = tierRaw ? Number(tierRaw) : known.costTier;
    const contextWindow = ctxRaw ? Number(ctxRaw) : known.contextWindow;
    if (!tags || costTier === undefined || contextWindow === undefined)
      throw new Error(
        `模型 ${id} 不在内置目录中：请设置 ${pre}_TAGS、${pre}_TIER、${pre}_CONTEXT（已知模型：${Object.keys(MODEL_CATALOG).join(", ")}）`,
      );
    const bad = tags.find((t) => !TASK_TYPES.includes(t as TaskType));
    if (bad) throw new Error(`${pre}_TAGS 含未知标签 ${bad}，可选：${TASK_TYPES.join(", ")}`);
    if (!Number.isInteger(costTier) || costTier < 1 || costTier > 3) throw new Error(`${pre}_TIER 应为 1–3 的整数`);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) throw new Error(`${pre}_CONTEXT 应为正整数`);
    models.push({
      id,
      provider: providerId,
      model: fromFile?.model ?? name,
      tags: tags as TaskType[],
      costTier,
      contextWindow,
    });
  });

  const real = models.filter((m) => m.provider !== "mock");
  if (real.length < 1 || real.length > MAX_ENV_MODELS)
    throw new Error(`AGENT_HUB_MODELS 需要 1–${MAX_ENV_MODELS} 个真实模型（mock 不计），当前 ${real.length} 个`);

  const usedProviders = [...new Set(models.map((m) => m.provider))].map(
    (id) => providerDefs.get(id) as z.infer<typeof ProviderSchema>,
  );
  const providers = usedProviders.map((p) => (p.type === "openai" ? { ...p, baseUrl: resolveBaseUrl(p, env) } : p));
  for (const p of providers)
    if (p.type === "openai" && !env[p.apiKeyEnv]?.trim())
      throw new Error(
        `provider ${p.id} 缺少 Key：请在 .env 设置 ${p.apiKeyEnv}（模型 ${models
          .filter((m) => m.provider === p.id)
          .map((m) => m.id)
          .join(", ")} 需要）`,
      );

  const cls = env.AGENT_HUB_CLASSIFIER_MODEL?.trim() || base?.router.classifierModel;
  if (env.AGENT_HUB_CLASSIFIER_MODEL?.trim() && !seen.has(cls as string))
    throw new Error(`AGENT_HUB_CLASSIFIER_MODEL ${cls} 必须是 AGENT_HUB_MODELS 中的模型`);
  const limits = base?.limits ?? MOCK_CONFIG.limits;
  return {
    providers,
    models,
    // A file classifier that is not in the active set is dropped rather than failing startup.
    router: { ...base?.router, classifierModel: cls && seen.has(cls) ? cls : undefined },
    limits,
  };
}

/** Returns the systemone classifier config, or undefined when DECISION_BASE_URL is unset. */
export function decisionFromEnv(env: Env): DecisionConfig | undefined {
  const raw = env.DECISION_BASE_URL?.trim();
  if (!raw) return undefined;
  if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol))
    throw new Error(`环境变量 DECISION_BASE_URL 不是合法的 http(s) URL: ${raw}`);
  const trimmed = raw.replace(/\/+$/, "");
  const endpoint = trimmed.endsWith("/systemone") ? trimmed : `${trimmed}/compatible-mode/v1/systemone`;
  const apiKeyEnv = env.DECISION_API_KEY?.trim() ? "DECISION_API_KEY" : "DASHSCOPE_API_KEY";
  if (!env[apiKeyEnv]?.trim())
    throw new Error("已设置 DECISION_BASE_URL，但 DECISION_API_KEY 和 DASHSCOPE_API_KEY 都为空");
  const minConfidence = Number(env.DECISION_MIN_CONFIDENCE?.trim() || 0.6);
  if (!(minConfidence >= 0 && minConfidence <= 1)) throw new Error("DECISION_MIN_CONFIDENCE 应在 0–1 之间");
  const timeoutMs = Number(env.DECISION_TIMEOUT_MS?.trim() || 3000);
  if (!(timeoutMs > 0)) throw new Error("DECISION_TIMEOUT_MS 应为正数");
  return {
    endpoint,
    apiKeyEnv,
    model: env.DECISION_MODEL?.trim() || "decision-model-preview",
    minConfidence,
    timeoutMs,
  };
}

/** One line per provider for the startup log: where its URL came from and whether its key is set. */
export function describeProviders(config: AppConfig, env: Env = process.env): string[] {
  return config.providers.map((p) => {
    if (p.type === "mock") return `  ${p.id}: 内置 mock`;
    const urlSrc = p.baseUrlEnv && env[p.baseUrlEnv]?.trim() ? p.baseUrlEnv : "默认 baseUrl";
    const key = env[p.apiKeyEnv] ? "Key 已设置" : `缺少 ${p.apiKeyEnv}（调用会失败）`;
    return `  ${p.id}: ${p.baseUrl}（来自 ${urlSrc}）· ${key}`;
  });
}

export function resolveApiKey(provider: ProviderConfig): string {
  if (provider.type !== "openai") return "";
  const key = process.env[provider.apiKeyEnv];
  if (!key) throw new Error(`provider ${provider.id} 缺少环境变量 ${provider.apiKeyEnv}`);
  return key;
}
