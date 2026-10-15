import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Profile } from "../../server/profile";
import { AvatarPicker } from "./AvatarPicker";
import { api } from "./api";
import { BotAvatar } from "./BotAvatar";

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
  const [p, setP] = useState(props.profile);
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");
  const first = useRef(true);
  const seq = useRef(0);
  // Autosave: short debounce, the server validates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: save on profile edits only
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    applyAppearance(p);
    setState("saving");
    const n = ++seq.current;
    const t = setTimeout(() => {
      api<Profile>("PUT", "/api/profile", p)
        .then((saved) => {
          // Only the latest edit decides what the page says (an older save can land after a newer edit).
          if (n !== seq.current) return;
          props.onChange(saved);
          setState("saved");
        })
        .catch((e) => n === seq.current && setState((e as Error).message));
    }, 400);
    return () => clearTimeout(t);
  }, [p]);
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <>
      <header className="main-head">
        <div className="title">
          <h2>个人资料</h2>
        </div>
        <span className="muted profile-state" role="status">
          {state === "saving" ? "保存中…" : state === "saved" ? "已保存" : state === "idle" ? "" : `保存失败：${state}`}
        </span>
      </header>
      <div className="page">
        <div className="page-inner profile">
          <section className="card">
            <div className="card-head">
              <h3>显示名</h3>
              <p>显示在你自己的消息上。</p>
            </div>
            <div className="card-body">
              <input
                className="input profile-input"
                aria-label="显示名"
                maxLength={32}
                placeholder="我"
                value={p.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>关于我</h3>
              <p>你的角色、习惯和想要的回答风格。会附在每个 Agent 的说明里，可在 Agent 编辑页单独关掉。</p>
            </div>
            <div className="card-body">
              <textarea
                className="textarea"
                rows={5}
                maxLength={4000}
                aria-label="关于我"
                placeholder={ABOUT_HINT}
                value={p.about}
                onChange={(e) => set("about", e.target.value)}
              />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>外观</h3>
            </div>
            <div className="card-body profile-grid">
              <span className="label">主题</span>
              <div className="seg">
                {(
                  [
                    ["system", "跟随系统", Monitor],
                    ["light", "浅色", Sun],
                    ["dark", "深色", Moon],
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
              <span className="label">强调色</span>
              <div className="accent-row">
                <button
                  type="button"
                  aria-pressed={!p.accent}
                  aria-label="默认"
                  className="accent-dot default"
                  title="默认"
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
              <h3>时区</h3>
              <p>附在「关于我」里，Agent 说“今天”“明天”时按这个时区算。</p>
            </div>
            <div className="card-body">
              <select
                className="input profile-input"
                aria-label="时区"
                value={p.timezone}
                onChange={(e) => set("timezone", e.target.value)}
              >
                <option value="">跟随系统（{localTz}）</option>
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
