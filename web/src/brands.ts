/** Model vendor from a model id / display name. Unknown ids get the neutral mark, never a guess. */
export type Brand =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "zhipu"
  | "deepseek"
  | "moonshot"
  | "qwen"
  | "minimax"
  | "doubao"
  | "mistral"
  | "meta"
  | "opencode"
  | "generic";

export const BRAND_LABEL: Record<Brand, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  zhipu: "智谱",
  deepseek: "DeepSeek",
  moonshot: "Kimi",
  qwen: "通义千问",
  minimax: "MiniMax",
  doubao: "豆包",
  mistral: "Mistral",
  meta: "Meta",
  opencode: "OpenCode",
  generic: "其他模型",
};

// Order matters: the most specific families first (a DeepSeek distill of Llama is DeepSeek).
const RULES: [Brand, RegExp][] = [
  ["deepseek", /deepseek/],
  ["zhipu", /(^|[^a-z])(glm|chatglm|codegeex|cogview|cogvideo)|zhipu|bigmodel|z-ai|zai-org/],
  ["moonshot", /kimi|moonshot/],
  ["qwen", /qwen|qwq|qvq|tongyi|dashscope/],
  ["minimax", /minimax|abab\d/],
  ["doubao", /doubao|seed-oss|seed-?1\.|bytedance|skylark/],
  ["mistral", /mistral|mixtral|codestral|devstral|magistral|ministral|pixtral/],
  ["google", /gemini|gemma|learnlm|^(models\/)?(palm|bison)/],
  ["anthropic", /claude|anthropic|(^|[^a-z])(opus|sonnet|haiku)([^a-z]|$)/],
  ["xai", /grok|(^|[^a-z])x-?ai([^a-z]|$)/],
  ["meta", /llama|meta-llama/],
  ["openai", /(^|[^a-z])(gpt|chatgpt|codex|davinci|dall-e|whisper|o[1-9](-mini|-pro|-preview)?)([^a-z]|$)|openai/],
];

/** Vendor prefixes of provider-qualified ids (openrouter "anthropic/claude-…", "meta-llama/…"). */
const PREFIX: Record<string, Brand> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "x-ai": "xai",
  xai: "xai",
  "z-ai": "zhipu",
  zhipuai: "zhipu",
  "zai-org": "zhipu",
  moonshotai: "moonshot",
  qwen: "qwen",
  alibaba: "qwen",
  deepseek: "deepseek",
  "deepseek-ai": "deepseek",
  minimax: "minimax",
  bytedance: "doubao",
  "bytedance-seed": "doubao",
  mistralai: "mistral",
  "meta-llama": "meta",
  meta: "meta",
};

export function brandOfModel(id: string): Brand {
  const m = id.trim().toLowerCase();
  if (!m) return "generic";
  const parts = m.split("/").filter(Boolean);
  const last = parts.at(-1) ?? m;
  for (const [b, re] of RULES) if (re.test(last)) return b;
  for (const p of parts.slice(0, -1)) if (PREFIX[p]) return PREFIX[p];
  return "generic";
}

/** A harness's own default vendor (for harness rows and its "default" model alias). */
export function harnessBrand(harness: string): Brand {
  if (harness === "claude-code") return "anthropic";
  if (harness === "codex") return "openai";
  if (harness === "grok") return "xai";
  if (harness === "opencode") return "opencode";
  if (harness === "minimax") return "minimax";
  if (harness === "deepseek") return "deepseek";
  return "generic";
}

/**
 * Logo by the model itself, not by the harness: Claude Code routed to GLM shows Zhipu.
 * `name` (display name, e.g. Claude's "opus" alias named "glm-5.3") is checked first. Only the
 * harness's own default alias ("default", empty) falls back to the harness vendor.
 */
export function brandFor(model: string, harness: string, name?: string | null): Brand {
  const byName = name ? brandOfModel(name) : "generic";
  if (byName !== "generic") return byName;
  const byId = brandOfModel(model);
  if (byId !== "generic") return byId;
  if (/^(default|auto)?$/i.test(model.trim())) return harnessBrand(harness);
  return "generic";
}
