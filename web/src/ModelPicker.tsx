/** Brand marks, drawn on a 16-unit grid in currentColor so they sit on any surface. */
export type Brand = "anthropic" | "openai" | "xai" | "opencode" | "generic";

export function brandFor(model: string, harness: string): Brand {
  const m = model.toLowerCase();
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
