import { useCallback, useSyncExternalStore } from "react";
import {
  isLocale,
  type Locale,
  type MessageParams,
  translateError as translateErrorMessage,
  translate as translateMessage,
} from "../../shared/i18n";

export { intlLocale, LANGUAGE_NAMES, LOCALES, type Locale } from "../../shared/i18n";

const CACHE_KEY = "tuantuan:language";
const subscribers = new Set<() => void>();
let locale: Locale = "zh-CN";
try {
  const cached = typeof localStorage === "undefined" ? null : localStorage.getItem(CACHE_KEY);
  if (isLocale(cached)) locale = cached;
} catch {
  // The server profile remains authoritative when browser storage is unavailable.
}

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale) {
  if (!isLocale(next)) return;
  const changed = locale !== next;
  locale = next;
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
    document.title = translateMessage(next, "团团 Tuantuan");
  }
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(CACHE_KEY, next);
  } catch {
    // This is only a startup cache; a successful profile save does not depend on it.
  }
  if (changed) for (const notify of subscribers) notify();
}

export function translate(source: string, params?: MessageParams): string {
  return translateMessage(locale, source, params);
}

export function translateError(source: string): string {
  return translateErrorMessage(locale, source);
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function useI18n() {
  const current = useSyncExternalStore(subscribe, getLocale, () => "zh-CN" as Locale);
  const t = useCallback(
    (source: string, params?: MessageParams) => translateMessage(current, source, params),
    [current],
  );
  return { t, locale: current };
}
