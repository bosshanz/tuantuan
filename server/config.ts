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
export type AppConfig = Omit<z.infer<typeof ConfigSchema>, "providers"> & { providers: ProviderConfig[] };

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

export function loadConfig(path = process.env.AGENT_HUB_CONFIG ?? "config/providers.json"): {
  config: AppConfig;
  source: string;
} {
  const abs = resolve(path);
  if (!existsSync(abs)) return { config: MOCK_CONFIG, source: "builtin-mock" };
  return { config: parseConfig(JSON.parse(readFileSync(abs, "utf8"))), source: abs };
}

/** One line per provider for the startup log: where its URL came from and whether its key is set. */
export function describeProviders(config: AppConfig, env: Env = process.env): string[] {
  return config.providers.map((p) => {
    if (p.type === "mock") return `  ${p.id}: 内置 mock`;
    const urlSrc = p.baseUrlEnv && env[p.baseUrlEnv]?.trim() ? p.baseUrlEnv : "配置文件 baseUrl";
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
