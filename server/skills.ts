import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  /** Markdown body after the frontmatter; injected only when the agent loads the skill. */
  body: string;
  dir: string;
}

export interface SkillLoadResult {
  skills: Skill[];
  /** Directories that look like skills but could not be loaded, with the reason. */
  errors: { dir: string; error: string }[];
}

/** Loads every `<dir>/<skill>/SKILL.md`. Invalid skills are reported, not silently skipped. */
export function loadSkills(root: string): SkillLoadResult {
  const result: SkillLoadResult = { skills: [], errors: [] };
  if (!existsSync(root)) return result;
  const seen = new Set<string>();
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    const file = join(dir, "SKILL.md");
    if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
    try {
      const skill = parseSkill(readFileSync(file, "utf8"), dir);
      if (seen.has(skill.name)) throw new Error(`skill 名称重复: ${skill.name}`);
      seen.add(skill.name);
      result.skills.push(skill);
    } catch (e) {
      result.errors.push({ dir, error: (e as Error).message });
    }
  }
  return result;
}

export function parseSkill(text: string, dir: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("缺少 YAML frontmatter");
  const meta = Bun.YAML.parse(m[1] ?? "") as Record<string, unknown> | null;
  const name = meta?.name;
  const description = meta?.description;
  if (typeof name !== "string" || !/^[\w-]{1,64}$/.test(name))
    throw new Error("frontmatter.name 缺失或非法（仅限字母数字_-）");
  if (typeof description !== "string" || description.trim() === "") throw new Error("frontmatter.description 缺失");
  return { name, description: description.trim(), body: (m[2] ?? "").trim(), dir };
}

/** The always-visible part of progressive disclosure: names and descriptions only. */
export function skillCatalogPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `你可以使用以下 Skills。当任务与某个 Skill 的描述相关时，先调用 load_skill 工具加载它的完整说明再执行：\n${lines.join("\n")}`;
}
