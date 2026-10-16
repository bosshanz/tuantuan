import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Profile } from "../../server/profile";
import { api } from "./api";
import { LANGUAGE_NAMES, LOCALES, type Locale, translateError, useI18n } from "./i18n";

export type { Profile };
export const EMPTY_PROFILE: Profile = {
  name: "",
  avatar: { kind: "initial" },
  about: "",
  theme: "system",
  accent: null,
  timezone: "",
  language: "zh-CN",
};

const ACCENTS = ["#e8462b", "#2f6fed", "#16a34a", "#9333ea", "#db2777", "#0d9488", "#18181b"];
const ABOUT_HINT =
  "例如：\n我是前端工程师，主要写 React / TypeScript。\n回答请用中文，先给结论，代码给完整可运行的版本。";

/** Apply appearance to the document: data-theme + accent variables (inline beats the stylesheet). */
export function applyAppearance(p: Pick<Profile, "theme" | "accent">) {
  const root = document.documentElement;
  if (p.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = p.theme;
  const vars = ["--accent", "--accent-hover", "--accent-soft", "--accent-text", "--brand"];
  if (!p.accent) for (const v of vars) root.style.removeProperty(v);
  else {
    root.style.setProperty("--accent", p.accent);
    root.style.setProperty("--brand", p.accent);
    root.style.setProperty("--accent-hover", `color-mix(in srgb, ${p.accent} 88%, #000)`);
    root.style.setProperty("--accent-soft", `color-mix(in srgb, ${p.accent} 12%, transparent)`);
    root.style.setProperty("--accent-text", `color-mix(in srgb, ${p.accent} 90%, var(--text))`);
  }
}

const zones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

export function ProfilePage(props: { profile: Profile; onChange: (p: Profile) => void }) {
  const { t } = useI18n();
  const [p, setP] = useState(props.profile);
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");
  const draft = useRef(props.profile);
  const pending = useRef<Profile | null>(null);
  const saving = useRef(false);
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  // Serialize writes and keep the latest draft, so rapid language/appearance changes cannot save out of order.
  async function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (saving.current) return;
    saving.current = true;
    while (pending.current) {
      const next = pending.current;
      pending.current = null;
      try {
        const saved = await api<Profile>("PUT", "/api/profile", next);
        onChange.current(saved);
        if (mounted.current && !pending.current) setState("saved");
      } catch (error) {
        if (mounted.current && !pending.current) setState((error as Error).message);
      }
    }
    saving.current = false;
  }

  // The cleanup flush reads refs only, including the current draft and callback.
  // biome-ignore lint/correctness/useExhaustiveDependencies: flush uses mutable refs, not render state
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void flush();
    };
  }, []);
  useEffect(() => {
    if (!saving.current && !pending.current) {
      draft.current = props.profile;
      setP(props.profile);
    }
  }, [props.profile]);
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    const next = { ...draft.current, [key]: value };
    draft.current = pending.current = next;
    setP(next);
    applyAppearance(next);
    setState("saving");
    if (timer.current) clearTimeout(timer.current);
    if (key === "language") void flush();
    else timer.current = setTimeout(() => void flush(), 400);
  };
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <>
      <header className="main-head">
        <div className="title">
          <h2>{t("个人资料")}</h2>
        </div>
        <span className="muted profile-state" role="status">
          {state === "saving"
            ? t("保存中…")
            : state === "saved"
              ? t("已保存")
              : state === "idle"
                ? ""
                : t("保存失败：{error}", { error: translateError(state) })}
        </span>
        {!["idle", "saving", "saved"].includes(state) && (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              pending.current = draft.current;
              setState("saving");
              void flush();
            }}
          >
            {t("重试")}
          </button>
        )}
      </header>
      <div className="page">
        <div className="page-inner profile">
          <section className="card">
            <div className="card-head">
              <h3>{t("界面语言")}</h3>
              <p>{t("选择后自动保存并切换界面，不改变聊天内容或 Agent 的回答语言。")}</p>
            </div>
            <div className="card-body">
              <select
                className="input profile-input"
                aria-label={t("界面语言")}
                value={p.language}
                onChange={(event) => set("language", event.target.value as Locale)}
              >
                {LOCALES.map((language) => (
                  <option key={language} value={language} lang={language}>
                    {LANGUAGE_NAMES[language]}
                  </option>
                ))}
              </select>
            </div>
          </section>
          <section className="card">
            <div className="card-head">
              <h3>{t("显示名")}</h3>
              <p>{t("显示在你自己的消息上。")}</p>
            </div>
            <div className="card-body">
              <input
                className="input profile-input"
                aria-label={t("显示名")}
                maxLength={32}
                placeholder={t("我")}
                value={p.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>{t("关于我")}</h3>
              <p>{t("你的角色、习惯和想要的回答风格。会附在每个 Agent 的说明里，可在 Agent 编辑页单独关掉。")}</p>
            </div>
            <div className="card-body">
              <textarea
                className="textarea"
                rows={5}
                maxLength={4000}
                aria-label={t("关于我")}
                placeholder={t(ABOUT_HINT)}
                value={p.about}
                onChange={(e) => set("about", e.target.value)}
              />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>{t("外观")}</h3>
            </div>
            <div className="card-body profile-grid">
              <span className="label">{t("主题")}</span>
              <div className="seg">
                {(
                  [
                    ["system", t("跟随系统"), Monitor],
                    ["light", t("浅色"), Sun],
                    ["dark", t("深色"), Moon],
                  ] as const
                ).map(([v, label, Icon]) => (
                  <button
                    key={v}
                    type="button"
                    className="btn sm"
                    aria-pressed={p.theme === v}
                    onClick={() => set("theme", v)}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>
              <span className="label">{t("强调色")}</span>
              <div className="accent-row">
                <button
                  type="button"
                  aria-pressed={!p.accent}
                  aria-label={t("默认")}
                  className="accent-dot default"
                  title={t("默认")}
                  onClick={() => set("accent", null)}
                />
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={p.accent === c}
                    aria-label={c}
                    className="accent-dot"
                    style={{ background: c }}
                    onClick={() => set("accent", c)}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>{t("时区")}</h3>
              <p>{t("附在「关于我」里，Agent 说“今天”“明天”时按这个时区算。")}</p>
            </div>
            <div className="card-body">
              <select
                className="input profile-input"
                aria-label={t("时区")}
                value={p.timezone}
                onChange={(e) => set("timezone", e.target.value)}
              >
                <option value="">{t("跟随系统（{timezone}）", { timezone: localTz })}</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
