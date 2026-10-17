/** Shared, provider-specific model facts. No credentials or executable catalog fields. */
export type ModelApi = "openai-completions" | "openai-responses" | "anthropic-messages";

/** Catalog/ACP identifiers are extensible; adapters still verify native support. */
export type ThinkingLevel = string;

export type ThinkingFormat =
  | "openai"
  | "openrouter"
  | "deepseek"
  | "zai"
  | "qwen"
  | "anthropic-adaptive"
  | "anthropic-budget"
  | "anthropic-toggle";

export interface ModelCapabilities {
  providerId: string;
  modelId: string;
  api: ModelApi;
  reasoning: boolean;
  /** Only verified controls. Empty for fixed thinking or unadapted controls. */
  levels: ThinkingLevel[];
  defaultLevel?: ThinkingLevel;
  format: ThinkingFormat;
  /** True when this deployment accepts effort, not merely a thinking switch. */
  effort: boolean;
  /** Budget presets are bounded by the catalog and leave room for the answer. */
  budgets?: Partial<Record<ThinkingLevel, number>>;
  interleaved?: "reasoning_content" | "reasoning_details";
  requireReasoning?: boolean;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
}
