// Shared by the server (tests) and the web UI (conversation error → 需要 API Key).

/** Text that says the harness is missing an API key (stderr / error message from a prompt). */
export function missingKeyVar(text: string): string | null {
  if (
    !/(no|missing|not set|未设置|缺少).{0,40}(api[ _-]?key|token)|api[ _-]?key.{0,30}(not found|missing|required|not set)/i.test(
      text,
    )
  )
    return null;
  return text.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|KEY|TOKEN))\b/)?.[1] ?? "";
}
