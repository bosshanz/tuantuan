/** Harnesses that can use a saved Tuantuan provider profile. */
export function supportsProviderProfiles(harness: string): boolean {
  return ["claude-code", "opencode", "pi", "codex", "custom"].includes(harness);
}

/** Shared by the server and UI so an offered provider can also be used at runtime. */
export function providerSupports(
  provider: {
    anthropicBaseUrl: string;
    openaiBaseUrl: string;
    wireApi: "responses" | "chat";
    model?: string;
  },
  harness: string,
): boolean {
  const anthropic = !!provider.anthropicBaseUrl.trim();
  const openai = !!provider.openaiBaseUrl.trim();
  if (harness === "claude-code") return anthropic;
  if (harness === "codex") return openai && provider.wireApi === "responses";
  if (harness === "opencode" || harness === "pi") return (anthropic || openai) && !!provider.model?.trim();
  if (harness === "custom") return anthropic || openai;
  return false;
}
