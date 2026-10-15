import { z } from "zod";
import { AVATAR_SHAPES } from "./avatars";

/** 个人资料: who the user is. Stored server-side (settings table) so every window and agent sees it. */
export const ProfileSchema = z.object({
  name: z.string().trim().max(32).default(""),
  avatar: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("shape"),
        shape: z.enum(AVATAR_SHAPES),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
      // A small square image the UI already downscaled (≤ 96px PNG/JPEG/WebP data URL).
      z.object({
        kind: z.literal("image"),
        dataUrl: z
          .string()
          .max(200_000)
          .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
      }),
      z.object({ kind: z.literal("initial") }),
    ])
    .default({ kind: "initial" }),
  about: z.string().max(4000).default(""),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
  timezone: z.string().max(64).default(""),
  language: z.enum(["zh-CN", "en"]).default("zh-CN"),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const DEFAULT_PROFILE: Profile = ProfileSchema.parse({});

export function readProfile(raw: unknown): Profile {
  const r = ProfileSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_PROFILE;
}

/** The 「关于我」 block added to an agent's instructions (empty when there is nothing to say). */
export function profileInstructions(p: Profile): string {
  const lines: string[] = [];
  if (p.name.trim()) lines.push(`称呼：${p.name.trim()}`);
  if (p.timezone) lines.push(`时区：${p.timezone}`);
  lines.push(`偏好语言：${p.language === "en" ? "English" : "简体中文"}`);
  if (p.about.trim()) lines.push(p.about.trim());
  if (!p.name.trim() && !p.about.trim() && !p.timezone && p.language === "zh-CN") return "";
  return `关于用户（来自团团的个人资料，供你参考，不必复述）：\n${lines.join("\n")}`;
}
