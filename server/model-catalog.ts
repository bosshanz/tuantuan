import snapshot from "./data/models-dev.json";
import type { ModelApi, ModelCapabilities, ThinkingFormat, ThinkingLevel } from "./model-capabilities";
import { type CatalogData, CatalogSnapshot, downloadModelCatalog } from "./model-catalog-schema";
import type { ProviderSecret } from "./providers";

const catalog: CatalogData = CatalogSnapshot.parse(snapshot);
export const modelCatalogSource = catalog.source;
const captures = new WeakMap<ProviderSecret, CatalogData>();

export function captureModelCatalog(provider: ProviderSecret, data: CatalogData = catalog): ProviderSecret {
  if (!captures.has(provider)) captures.set(provider, data);
  return provider;
}

/** One store owns its catalog. Existing provider/process snapshots never change on sync. */
export class ModelCatalog {
  private data = catalog;
  private error: string | null = null;
  private pending: Promise<ReturnType<ModelCatalog["status"]>> | null = null;
  constructor(
    cached: unknown,
    private persist: (data: CatalogData) => void,
  ) {
    if (cached != null) {
      const parsed = CatalogSnapshot.safeParse(cached);
      if (parsed.success && Object.keys(parsed.data.providers).length) this.data = parsed.data;
      else this.error = "模型目录缓存损坏，正在使用内置目录";
    }
  }
  capture(provider: ProviderSecret) {
    return captureModelCatalog(provider, this.data);
  }
  has(reference: string) {
    return catalogModel(reference, this.data) !== null;
  }
  search(query: string) {
    return searchCatalogModels(query, 50, this.data);
  }
  status() {
    return {
      ...this.data.source,
      origin: this.data === catalog ? ("bundled" as const) : ("synced" as const),
      providers: Object.keys(this.data.providers).length,
      models: Object.values(this.data.providers).reduce(
        (sum, provider) => sum + Object.keys(provider.models).length,
        0,
      ),
      error: this.error,
    };
  }
  sync(fetcher: typeof fetch = fetch) {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const next = await downloadModelCatalog(fetcher);
      this.persist(next); // A failed write must leave both memory and the existing cache intact.
      this.data = next;
      this.error = null;
      return this.status();
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
}

const PRESET_PROVIDERS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  xai: "xai",
  deepseek: "deepseek",
  kimi: "moonshotai-cn",
  glm: "zhipuai",
  qwen: "alibaba-cn",
  minimax: "minimax-cn",
  siliconflow: "siliconflow-cn",
  openrouter: "openrouter",
};
// Some native SDK providers omit their API URL in models.dev. Keep these transport
// identities separate from model facts, and match origins/path boundaries exactly.
const ENDPOINTS: Record<string, string[]> = {
  anthropic: ["https://api.anthropic.com"],
  openai: ["https://api.openai.com"],
  xai: ["https://api.x.ai"],
  deepseek: ["https://api.deepseek.com"],
  "moonshotai-cn": ["https://api.moonshot.cn"],
  moonshotai: ["https://api.moonshot.ai"],
  zhipuai: ["https://open.bigmodel.cn/api/anthropic"],
  zai: ["https://api.z.ai/api/anthropic"],
  "alibaba-cn": ["https://dashscope.aliyuncs.com/apps/anthropic"],
  alibaba: ["https://dashscope-intl.aliyuncs.com/apps/anthropic"],
  "minimax-cn": ["https://api.minimax.cn/v1", "https://api.minimax.cn/anthropic"],
  minimax: ["https://api.minimax.io/v1", "https://api.minimax.io/anthropic"],
  "siliconflow-cn": ["https://api.siliconflow.cn"],
  openrouter: ["https://openrouter.ai/api"],
};
const endpointCache = new WeakMap<CatalogData, { id: string; url: URL }[]>();
function catalogEndpoints(data: CatalogData) {
  const cached = endpointCache.get(data);
  if (cached) return cached;
  const endpoints = Object.entries(data.providers)
    .flatMap(([id, provider]) =>
      [...(provider.api ? [provider.api] : []), ...(ENDPOINTS[id] ?? [])].flatMap((address) => {
        try {
          return [{ id, url: new URL(address) }];
        } catch {
          return [];
        }
      }),
    )
    .sort((a, b) => b.url.pathname.length - a.url.pathname.length);
  endpointCache.set(data, endpoints);
  return endpoints;
}

export function modelApi(provider: ProviderSecret): ModelApi {
  return provider.openaiBaseUrl
    ? provider.wireApi === "responses"
      ? "openai-responses"
      : "openai-completions"
    : "anthropic-messages";
}

export function catalogModel(reference: string, data: CatalogData = catalog) {
  const slash = reference.indexOf("/");
  if (slash < 1) return null;
  const providerId = reference.slice(0, slash);
  const modelId = reference.slice(slash + 1);
  const model = data.providers[providerId]?.models[modelId];
  return model ? { providerId, modelId, model } : null;
}

export function searchCatalogModels(query: string, limit = 50, data: CatalogData = catalog) {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const results: { value: string; name: string }[] = [];
  for (const [providerId, provider] of Object.entries(data.providers)) {
    for (const [id, model] of Object.entries(provider.models)) {
      const value = `${providerId}/${id}`;
      if (!`${value} ${model.name}`.toLowerCase().includes(text)) continue;
      results.push({ value, name: `${provider.name} · ${model.name}` });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

function identity(provider: ProviderSecret, model: string, api: ModelApi) {
  const data = captures.get(provider) ?? catalog;
  const explicit = provider.modelCatalog?.[model];
  if (explicit) return catalogModel(explicit, data);
  const address = api === "anthropic-messages" ? provider.anthropicBaseUrl : provider.openaiBaseUrl;
  let matched: string | undefined;
  try {
    const url = new URL(address);
    matched = catalogEndpoints(data).find(({ url: known }) => {
      const path = known.pathname.replace(/\/+$/, "");
      return url.origin === known.origin && (url.pathname === path || url.pathname.startsWith(`${path}/`));
    })?.id;
  } catch {
    /* Invalid addresses are rejected by the provider form; no identity can be inferred here. */
  }
  const providerId = matched ?? PRESET_PROVIDERS[provider.preset];
  const entry = providerId && data.providers[providerId]?.models[model];
  return entry && providerId ? { providerId, modelId: model, model: entry } : null;
}

/** Resolve the serving provider, not just a similar model name. Offline and deterministic. */
export function resolveModelCapabilities(
  provider: ProviderSecret,
  model = provider.model,
  api: ModelApi = modelApi(provider),
): ModelCapabilities | null {
  const entry = identity(provider, model, api);
  if (!entry) return null;
  const { providerId, modelId, model: data } = entry;
  const controls = data.reasoning_options ?? [];
  const efforts = controls
    .flatMap((option) => (option.type === "effort" ? option.values : []))
    .filter((level): level is string => level !== null && level !== "default");
  const toggle = controls.some((option) => option.type === "toggle");
  const budget = controls.find((option) => option.type === "budget_tokens");
  const maxTokens = data.limit.output || 8192;
  const contextWindow = data.limit.context || 128000;
  let format: ThinkingFormat = "openai";
  let levels: ThinkingLevel[] = [...new Set(efforts.map((effort) => (effort === "none" ? ("off" as const) : effort)))];
  let budgets: ModelCapabilities["budgets"];
  if (api === "anthropic-messages") {
    format = efforts.length ? "anthropic-adaptive" : "anthropic-budget";
    if (!efforts.length) {
      const min = Math.max(1024, budget?.min ?? 1024);
      const max = Math.min(budget?.max ?? maxTokens - 1024, maxTokens - 1024);
      if (max >= min) {
        const presets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, on: 16384 };
        budgets = Object.fromEntries(
          Object.entries(presets).map(([level, value]) => [level, Math.min(max, Math.max(min, value))]),
        );
        // Budget-only APIs expose actual token presets. A toggle-only model gets a
        // single enabled state, not several labels that all send the same request.
        levels = budget ? ["off", "minimal", "low", "medium", "high"] : ["on"];
      }
    }
  } else if (api === "openai-completions") {
    if (providerId === "deepseek" || providerId.startsWith("moonshotai")) format = "deepseek";
    else if (providerId === "zhipuai" || providerId.startsWith("zai")) format = "zai";
    else if (providerId.startsWith("alibaba")) format = "qwen";
    else if (providerId === "openrouter") format = "openrouter";
    if (!efforts.length && ["deepseek", "zai", "qwen"].includes(format)) levels = ["on"];
    // A catalog that says fixed reasoning must not become a fabricated effort menu.
    if (!controls.length && data.reasoning) levels = ["on"];
  }
  if (toggle && api !== "openai-responses" && (format !== "openai" || efforts.length)) levels.unshift("off");
  // DeepSeek's Responses API represents the documented switch as effort=none.
  if (api === "openai-responses" && providerId === "deepseek" && toggle && efforts.length) levels.unshift("off");
  levels = data.reasoning ? [...new Set(levels)] : [];
  const defaultLevel = (["high", "medium", "low", "on", "minimal", "xhigh", "max"] as const).find((level) =>
    levels.includes(level),
  );
  return {
    providerId,
    modelId,
    api,
    reasoning: data.reasoning,
    levels,
    defaultLevel,
    format,
    effort: efforts.some((level) => level !== "none"),
    ...(budgets ? { budgets } : {}),
    ...(typeof data.interleaved === "object" ? { interleaved: data.interleaved.field } : {}),
    ...(providerId === "deepseek" && api === "openai-completions" ? { requireReasoning: true } : {}),
    contextWindow,
    maxTokens,
    input: data.modalities.input.filter((input): input is "text" | "image" => input === "text" || input === "image"),
  };
}
