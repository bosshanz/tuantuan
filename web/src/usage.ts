/** Cache hit rate from the three recorded token columns; null when no token volume exists. */
export function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | null {
  const denominator = input + cacheRead + cacheWrite;
  return denominator > 0 ? cacheRead / denominator : null;
}

/** One-decimal percentage; null stays null so the UI can say「无数据」instead of 0%. */
export function formatCacheHitRate(rate: number | null): string | null {
  return rate === null ? null : `${(rate * 100).toFixed(1)}%`;
}
