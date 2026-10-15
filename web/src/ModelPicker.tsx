/** Brand marks, drawn on a 16-unit grid in currentColor so they sit on any surface. */
export type Brand =
  | "anthropic"
  | "openai"
  | "xai"
  | "zhipu"
  | "deepseek"
  | "moonshot"
  | "qwen"
  | "opencode"
  | "generic";

/**
 * Logo by the model itself, not by the harness: Claude Code routed to GLM shows Zhipu.
 * `name` is the display name (Claude's "opus" alias can be named "glm-5.3"), checked first.
 */
export function brandFor(model: string, harness: string, name?: string | null): Brand {
  const m = `${name ?? ""} ${model}`.toLowerCase();
  if (/glm|zhipu|bigmodel|chatglm/.test(m)) return "zhipu";
  if (m.includes("deepseek")) return "deepseek";
  if (/kimi|moonshot/.test(m)) return "moonshot";
  if (/qwen|qwq|dashscope/.test(m)) return "qwen";
  if (/^(claude|anthropic|sonnet|opus|haiku)/.test(m) || m.includes("claude")) return "anthropic";
  if (/^(gpt|o[1-9]|codex|openai|chatgpt)/.test(m) || m.includes("gpt")) return "openai";
  if (/^(grok|xai)/.test(m) || m.includes("grok")) return "xai";
  if (harness === "claude-code") return "anthropic";
  if (harness === "codex") return "openai";
  if (harness === "grok") return "xai";
  if (harness === "opencode") return "opencode";
  if (harness === "mock") return "generic";
  return "generic";
}

const BRAND_LABEL: Record<Brand, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  zhipu: "智谱",
  deepseek: "DeepSeek",
  moonshot: "Kimi",
  qwen: "通义千问",
  opencode: "OpenCode",
  generic: "自定义",
};

function glyph(brand: Brand) {
  switch (brand) {
    case "anthropic":
      return (
        <path
          fill="currentColor"
          d="M9.6 2.5h2.3L16 13.5h-2.3zM4.1 2.5h2.4l4.1 11h-2.3l-.9-2.4H3.2l-.8 2.4H0zm-.2 6.7h2.9L5.3 5.3z"
        />
      );
    case "openai":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
          <path d="M8 1.8a3 3 0 0 1 3 3v3.5L8 10 5 8.3V4.8a3 3 0 0 1 3-3Z" />
          <path d="M8 1.8a3 3 0 0 1 3 3v3.5L8 10 5 8.3V4.8a3 3 0 0 1 3-3Z" transform="rotate(120 8 8)" />
          <path d="M8 1.8a3 3 0 0 1 3 3v3.5L8 10 5 8.3V4.8a3 3 0 0 1 3-3Z" transform="rotate(240 8 8)" />
        </g>
      );
    case "xai":
      return (
        <path fill="currentColor" d="M2 2.5h2.6l3.1 4.4 3.2-4.4H14L9.2 9.1l4.9 4.4h-2.6L7.7 10 5 13.5H2l4.4-5.9z" />
      );
    case "zhipu":
      return <path fill="currentColor" d="M3 2.5h10v2L6.2 11.5H13v2H3v-2l6.8-7H3z" />;
    case "deepseek":
      return (
        <path
          fill="currentColor"
          d="M1.5 7.5c1.5-3 5-4.6 8.3-3.6 2 .6 3.4 2.1 4.7 1.4-.2 1.9-1.4 3-2.6 3.3.1 2.6-2.2 4.9-5.2 4.9-3 0-5.2-2.1-5.2-4.6zm8.6 0a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z"
        />
      );
    case "moonshot":
      return <path fill="currentColor" d="M10.5 1.8A6.3 6.3 0 1 0 14.2 11 5.2 5.2 0 0 1 10.5 1.8z" />;
    case "qwen":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          d="M8 1.8 13.4 5v6L8 14.2 2.6 11V5zM8 5.2l2.6 1.5v2.6L8 10.8 5.4 9.3V6.7z"
        />
      );
    case "opencode":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"
        />
      );
    default:
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          d="M5 3.5h6M5 12.5h6M8 3.5v9M3.5 6.5h9M3.5 9.5h9"
        />
      );
  }
}

export function BrandLogo({ brand, size = 14 }: { brand: Brand; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="img"
      aria-label={BRAND_LABEL[brand]}
      className={`brand-logo brand-${brand}`}
    >
      <title>{BRAND_LABEL[brand]}</title>
      {glyph(brand)}
    </svg>
  );
}
