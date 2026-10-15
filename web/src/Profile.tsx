import { ImageUp, Monitor, Moon, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AVATAR_COLORS } from "../../server/avatars";
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

/** The user's own avatar: uploaded image, bot shape, or the first letter of the name. */
export function UserAvatar({ profile, size = 28 }: { profile: Profile; size?: number }) {
  const a = profile.avatar;
  if (a.kind === "image")
    return (
      <img
        className="user-avatar"
        src={a.dataUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
    );
  if (a.kind === "shape")
    return (
      <span className="avatar bot" style={{ ["--size" as string]: `${size}px` }} aria-hidden>
        <BotAvatar shape={a.shape} color={a.color} size={size} />
      </span>
    );
  return (
    <span className="avatar human" style={{ ["--size" as string]: `${size}px` }} aria-hidden>
      {(profile.name.trim() || "我").slice(0, 1)}
    </span>
  );
}

async function downscale(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const n = 96;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext("2d")?.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, n, n);
    return c.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
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
  const file = useRef<HTMLInputElement>(null);
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
  const shape = p.avatar.kind === "shape" ? p.avatar : { shape: "orb" as const, color: AVATAR_COLORS[0] as string };
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
              <h3>我</h3>
              <p>头像和名字显示在你自己的消息和成员列表里。</p>
            </div>
            <div className="card-body profile-me">
              <UserAvatar profile={p} size={56} />
              <div className="profile-avatar-actions">
                <AvatarPicker
                  shape={shape.shape}
                  color={shape.color}
                  onChange={(s, c) => set("avatar", { kind: "shape", shape: s, color: c })}
                  onReset={() => set("avatar", { kind: "initial" })}
                />
                <button type="button" className="btn sm" onClick={() => file.current?.click()}>
                  <ImageUp size={14} />
                  上传图片
                </button>
                {p.avatar.kind !== "initial" && (
                  <button type="button" className="btn ghost sm" onClick={() => set("avatar", { kind: "initial" })}>
                    <X size={14} />
                    用首字
                  </button>
                )}
                <input
                  ref={file}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  aria-label="上传头像"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) set("avatar", { kind: "image", dataUrl: await downscale(f) });
                  }}
                />
              </div>
              <label className="field profile-name">
                <span className="label">显示名</span>
                <input
                  className="input"
                  aria-label="显示名"
                  maxLength={32}
                  placeholder="我"
                  value={p.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>关于我</h3>
              <p>你的角色、偏好的语言和回答风格。会附在每个 Agent 的说明里，可在 Agent 编辑页单独关掉。</p>
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
              <h3>时区与语言</h3>
              <p>告诉 Agent 你的时区和偏好语言（会附在「关于我」里）。界面暂时只有中文。</p>
            </div>
            <div className="card-body profile-grid">
              <span className="label">时区</span>
              <select
                className="input"
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
              <span className="label">语言</span>
              <select
                className="input"
                aria-label="语言"
                value={p.language}
                onChange={(e) => set("language", e.target.value as Profile["language"])}
              >
                <option value="zh-CN">简体中文</option>
                <option value="en">English</option>
              </select>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
