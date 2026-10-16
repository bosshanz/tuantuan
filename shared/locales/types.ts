export const LOCALES = ["zh-CN", "zh-TW", "en", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageParams = Record<string, string | number>;
/** Simplified Chinese is the source text; every message includes all three translations. */
export type MessageCatalog = Record<string, Record<Exclude<Locale, "zh-CN">, string>>;
