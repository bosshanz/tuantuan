import { chatMessages } from "./locales/chat";
import { coreMessages } from "./locales/core";
import { desktopMessages } from "./locales/desktop";
import { errorMessages } from "./locales/errors";
import { harnessMessages } from "./locales/harness";
import { LOCALES, type Locale, type MessageCatalog, type MessageParams } from "./locales/types";

export type { Locale, MessageCatalog, MessageParams };
export { LOCALES };
export const messages: MessageCatalog = {
  ...coreMessages,
  ...harnessMessages,
  ...chatMessages,
  ...desktopMessages,
  ...errorMessages,
};
export const LANGUAGE_NAMES: Record<Locale, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  ja: "日本語",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.includes(value as Locale);
}

export function intlLocale(locale: Locale): string {
  return { "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en-US", ja: "ja-JP" }[locale];
}

/** Translates application copy only. User content must not be passed through this function. */
export function translate(locale: Locale, source: string, params?: MessageParams): string {
  const template = locale === "zh-CN" ? source : (messages[source]?.[locale] ?? source);
  return template.replace(/\{([a-zA-Z][\w]*)\}/g, (token, key: string) =>
    params && Object.hasOwn(params, key) ? String(params[key]) : token,
  );
}

const errorPatterns = Object.keys(errorMessages)
  .filter((source) => /\{\w+\}/.test(source))
  .sort((a, b) => b.length - a.length)
  .map((source) => {
    const names: string[] = [];
    const parts = source.split(/(\{\w+\})/g).map((part) => {
      if (/^\{\w+\}$/.test(part)) {
        names.push(part.slice(1, -1));
        return "([\\s\\S]*?)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    return { source, names, pattern: new RegExp(`^${parts.join("")}$`) };
  });

/** Match only registered application error templates, never arbitrary substrings in user content. */
export function translateError(locale: Locale, source: string, depth = 0): string {
  if (locale === "zh-CN" || source.length > 20_000) return source;
  if (messages[source]) return translate(locale, source);
  for (const item of errorPatterns) {
    const match = item.pattern.exec(source);
    if (!match) continue;
    const params: MessageParams = {};
    for (const [index, name] of item.names.entries()) {
      const value = match[index + 1] ?? "";
      params[name] = name === "detail" && depth < 2 ? translateError(locale, value, depth + 1) : value;
    }
    return translate(locale, item.source, params);
  }
  // Multiple validation issues use this separator; unknown diagnostics remain intact.
  if (depth < 2 && source.includes("；")) {
    return source
      .split("；")
      .map((part) => translateError(locale, part, depth + 1))
      .join(locale === "en" ? "; " : "；");
  }
  return source;
}
