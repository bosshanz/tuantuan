import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Agent Skills layout (Claude / Codex / OpenCode / .agents):
 *   <root>/skills/<name>/SKILL.md   — YAML frontmatter name + description, body = instructions
 *   <root>/commands/*.md            — legacy slash commands (imported as skills)
 *   <root>/.claude-plugin/plugin.json + root-level skills/
 * Cross-agent: `.agents/skills/<name>/SKILL.md`
 *
 * Tuantuan keeps each agent's copies under <data>/agents/<id>/ and links the enabled ones into
 * the room folder's native discovery dir for the harness, never over an existing name and never
 * into the user's global dirs. Skills already in the room's .claude/.agents/.opencode are listed.
 */
export interface SkillMeta {
  name: string;
  description: string;
  /** Absolute path to the skill directory (contains SKILL.md). */
  dir: string;
  source: "agent" | "room" | "import";
  enabled: boolean;
}

export function parseSkillMd(text: string): { name: string; description: string; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1] ?? "";
  const body = (m[2] ?? "").trim();
  const name = /^name:\s*(.+)$/m
    .exec(fm)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  const description = /^description:\s*(.+)$/m
    .exec(fm)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!name) return null;
  return { name, description: description || "", body };
}

const CUSTOM = "custom";

export function agentSkillsRoot(dataDir: string, agentId: string): string {
  return join(dataDir, "agents", agentId, "skills");
}

export function agentRuntimeRoot(dataDir: string, agentId: string, harness: string): string {
  return join(dataDir, "runtime", agentId, harness);
}

function readEnabled(root: string): Record<string, boolean> {
  try {
    return JSON.parse(readFileSync(join(dirname(root), "skills-enabled.json"), "utf8"));
  } catch {
    return {};
  }
}

function writeEnabled(root: string, map: Record<string, boolean>) {
  mkdirSync(dirname(root), { recursive: true });
  writeFileSync(join(dirname(root), "skills-enabled.json"), JSON.stringify(map, null, 2));
}

/** Scan a skills tree: skills/<name>/SKILL.md and legacy commands/<cmd>.md. */
export function scanSkillsDir(
  root: string,
  source: SkillMeta["source"],
  enabledMap: Record<string, boolean> = {},
): SkillMeta[] {
  const out: SkillMeta[] = [];
  if (!existsSync(root)) return out;
  const skillsDir = existsSync(join(root, "skills")) ? join(root, "skills") : root;
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const name of readdirSync(skillsDir)) {
      const dir = join(skillsDir, name);
      const md = join(dir, "SKILL.md");
      if (!statSync(dir).isDirectory() || !existsSync(md)) continue;
      const parsed = parseSkillMd(readFileSync(md, "utf8"));
      if (!parsed) continue;
      out.push({
        name: parsed.name,
        description: parsed.description,
        dir,
        source,
        enabled: enabledMap[parsed.name] !== false,
      });
    }
  }
  const commands = join(root, "commands");
  if (existsSync(commands) && statSync(commands).isDirectory()) {
    for (const f of readdirSync(commands).filter((x) => x.endsWith(".md"))) {
      const text = readFileSync(join(commands, f), "utf8");
      const name = f.replace(/\.md$/, "");
      const parsed = parseSkillMd(text);
      out.push({
        name: parsed?.name || name,
        description: parsed?.description || `legacy command ${name}`,
        dir: join(commands, f), // file path; materialize treats .md specially
        source,
        enabled: enabledMap[parsed?.name || name] !== false,
      });
    }
  }
  return out;
}

export function listAgentSkills(dataDir: string, agentId: string): SkillMeta[] {
  const root = agentSkillsRoot(dataDir, agentId);
  return scanSkillsDir(dirname(root), "agent", readEnabled(root));
}

/** Skills already sitting in the room working directory. */
export function listRoomSkills(cwd: string): SkillMeta[] {
  const out: SkillMeta[] = [];
  for (const rel of [".agents", ".claude", ".opencode"]) {
    const base = join(cwd, rel);
    if (!existsSync(base)) continue;
    out.push(...scanSkillsDir(base, "room"));
  }
  // .opencode uses skills/ or skill/
  return dedupe(out);
}

function dedupe(skills: SkillMeta[]): SkillMeta[] {
  const seen = new Set<string>();
  return skills.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

export function setSkillEnabled(dataDir: string, agentId: string, name: string, enabled: boolean) {
  const root = agentSkillsRoot(dataDir, agentId);
  const map = readEnabled(root);
  map[name] = enabled;
  writeEnabled(root, map);
}

/** Copy skills (and optional plugin) from an existing .claude / .agents / repo root into the agent. */
export function importSkills(dataDir: string, agentId: string, from: string): SkillMeta[] {
  // A git URL is shallow-cloned to a temp dir first (plugins / skill repos).
  if (/^(https?:\/\/|git@)/.test(from.trim())) {
    const tmp = mkdtempSync(join(tmpdir(), "tuantuan-skill-git-"));
    const p = Bun.spawnSync(["git", "clone", "--depth", "1", from.trim(), tmp], { stdout: "ignore", stderr: "pipe" });
    try {
      if (p.exitCode !== 0) throw new Error(`git clone 失败：${p.stderr.toString().slice(-200)}`);
      return importSkills(dataDir, agentId, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const src = resolve(from.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(src)) throw new Error(`找不到：${src}`);
  const destRoot = join(dataDir, "agents", agentId);
  mkdirSync(agentSkillsRoot(dataDir, agentId), { recursive: true });
  const candidates = [
    join(src, "skills"),
    join(src, ".agents", "skills"),
    join(src, ".claude", "skills"),
    join(src, ".opencode", "skills"),
    join(src, ".opencode", "skill"),
    src.endsWith("skills") ? src : "",
  ].filter(Boolean);
  let imported = 0;
  for (const c of candidates) {
    if (!c || !existsSync(c) || !statSync(c).isDirectory()) continue;
    for (const name of readdirSync(c)) {
      const d = join(c, name);
      if (!existsSync(join(d, "SKILL.md"))) continue;
      const dest = join(agentSkillsRoot(dataDir, agentId), name);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(d, dest, { recursive: true });
      imported++;
    }
  }
  // legacy commands
  for (const c of [join(src, "commands"), join(src, ".claude", "commands")]) {
    if (!existsSync(c)) continue;
    const dest = join(destRoot, "commands");
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(c).filter((x) => x.endsWith(".md"))) {
      cpSync(join(c, f), join(dest, f));
      imported++;
    }
  }
  if (!imported) throw new Error("未找到 SKILL.md（期望 skills/<name>/SKILL.md）");
  return listAgentSkills(dataDir, agentId);
}

export interface MaterializeResult {
  /** Env vars to merge into the harness process. */
  env: Record<string, string>;
  /** Extra skill names discovered in the room cwd (for the $ picker). */
  roomSkills: SkillMeta[];
  /** Enabled agent skills after materialize. */
  skills: SkillMeta[];
}

/** Link the agent's enabled skills into the harness's native project dir in the room folder. */
export function materializeSkills(dataDir: string, agentId: string, harness: string, cwd: string): MaterializeResult {
  const skills = listAgentSkills(dataDir, agentId).filter((s) => s.enabled);
  const roomSkills = listRoomSkills(cwd);
  const env: Record<string, string> = {};

  const linkInto = (targetParent: string) => {
    if (!skills.some((s) => statSync(s.dir).isDirectory())) return;
    mkdirSync(targetParent, { recursive: true });
    for (const s of skills) {
      if (!statSync(s.dir).isDirectory()) continue; // skip legacy file-only
      const dest = join(targetParent, s.name);
      if (existsSync(dest)) continue;
      try {
        symlinkSync(s.dir, dest);
      } catch {
        cpSync(s.dir, dest, { recursive: true });
      }
    }
  };

  // Layer on top of the user's global config — never set CLAUDE_CONFIG_DIR / CODEX_HOME /
  // XDG_CONFIG_HOME (those hide ~/.claude/settings.json, ~/.codex/config.toml + auth.json,
  // CC Switch ANTHROPIC_* env, Codex model_provider). Project-level discovery only:
  //   Claude Code: <cwd>/.claude/skills
  //   Codex / OpenCode / Grok: <cwd>/.agents/skills  (Codex also reads ~/.agents/skills natively)
  // env stays empty so the harness process inherits the login shell unchanged.
  if (harness === "claude-code") linkInto(join(cwd, ".claude", "skills"));
  else if (harness !== CUSTOM) linkInto(join(cwd, ".agents", "skills"));
  return { env: {}, roomSkills, skills };
}

/** Body of a skill for BYOK load_skill. */
export function loadSkillBody(dataDir: string, agentId: string, cwd: string, name: string): string {
  const all = [...listAgentSkills(dataDir, agentId), ...listRoomSkills(cwd)];
  const s = all.find((x) => x.name === name);
  if (!s) throw new Error(`未知 skill：${name}`);
  const md = existsSync(join(s.dir, "SKILL.md")) ? join(s.dir, "SKILL.md") : s.dir;
  const parsed = parseSkillMd(readFileSync(md, "utf8"));
  return parsed?.body || readFileSync(md, "utf8");
}
