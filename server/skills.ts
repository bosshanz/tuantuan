import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
 * Tuantuan keeps each agent's copies under <data>/agents/<id>/. Selections produce a read-on-demand
 * index, never links in the shared project. Existing native project/global files remain untouched.
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
  return skills.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
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
  /** Never isolates the harness's own settings or credentials. */
  env: Record<string, string>;
  /** Native global/project skills, including existing user or historical links. */
  roomSkills: SkillMeta[];
  /** Current Agent's selected non-native skills; no shared project files are written. */
  skills: SkillMeta[];
}

/** Resolve the same effective sources as Settings, without mutating the shared project. */
export function materializeSkills(
  dataDir: string,
  agentId: string,
  harness: string,
  cwd: string,
  pluginSkills: { name: string; description: string; dir: string }[] = [],
  harnessEnv: Record<string, string | undefined> = {},
): MaterializeResult {
  const discovered = discoverSkills(dataDir, agentId, harness, cwd, harnessEnv);
  const native = discovered.filter((s) => s.native);
  const nativePaths = new Set(native.map((s) => realKey(s.dir)));
  const selected = [
    ...listAgentSkills(dataDir, agentId).filter((s) => s.enabled),
    ...listLinkedSkills(dataDir, agentId),
    ...pluginSkills.map((p) => ({ ...p, source: "import" as const, enabled: true })),
  ];
  const seen = new Set<string>();
  const skills = selected.filter((s) => {
    const key = realKey(s.dir);
    if (nativePaths.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    env: {},
    skills,
    roomSkills: native.map((s) => ({
      name: s.name,
      description: s.description,
      dir: s.dir,
      source: "room",
      enabled: true,
    })),
  };
}

/** Metadata only. Each turn replaces the previous Tuantuan selection without denying native skills. */
export function selectedSkillIndex(skills: SkillMeta[]): string {
  const entries = skills.map((s) => ({
    name: s.name,
    description: s.description.slice(0, 600),
    file: resolve(existsSync(join(s.dir, "SKILL.md")) ? join(s.dir, "SKILL.md") : s.dir),
  }));
  return `<tuantuan-skills>\n当前团团为这个 Agent 额外选择的 Skills（此清单替代之前的团团选择；未列出不表示 Harness 没有原生技能）：\n${JSON.stringify(entries)}\n需要使用时，按正常文件读取与权限流程读取对应 file，再按需读取同目录附属文件。这里只提供索引，未读取正文前不要声称已加载。\n</tuantuan-skills>`;
}

/** BYOK exposes only the current selection; discovering a directory does not grant load_skill. */
export function loadSkillBody(
  dataDir: string,
  agentId: string,
  _cwd: string,
  name: string,
  extra: { name: string; dir: string }[] = [],
): string {
  const all = [
    ...listAgentSkills(dataDir, agentId).filter((s) => s.enabled),
    ...listLinkedSkills(dataDir, agentId),
    ...extra,
  ];
  const s = all.find((x) => x.name === name);
  if (!s) throw new Error(`未知或未启用的 skill：${name}`);
  const md = existsSync(join(s.dir, "SKILL.md")) ? join(s.dir, "SKILL.md") : s.dir;
  const parsed = parseSkillMd(readFileSync(md, "utf8"));
  return parsed?.body || readFileSync(md, "utf8");
}

// ---------------------------------------------------------------------------------------------
// Discovery: skills the user already has (user-level dirs, Claude plugins, the project), which an
// agent can be given access to without copying. Enabling adds it to that Agent's read-on-demand
// index and read-only grants; no links are written into the shared project.

export type SkillOrigin =
  | "imported"
  | "library"
  | "user-agents"
  | "user-claude"
  | "user-codex"
  | "user-gemini"
  | "plugin"
  | "project";

export interface DiscoveredSkill {
  /** Stable id: the skill directory's absolute path. */
  key: string;
  name: string;
  description: string;
  dir: string;
  origin: SkillOrigin;
  /** Short badge text, e.g. "~/.claude" or the plugin name. */
  label: string;
  enabled: boolean;
  /** The agent's harness already reads this location on its own (so it is on regardless). */
  native: boolean;
  /** Every lexical source of the same real directory; native sources are never lost to deduplication. */
  sources: { key: string; origin: SkillOrigin; label: string; native: boolean }[];
}

function readLinked(dataDir: string, agentId: string): string[] {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, "agents", agentId, "skills-linked.json"), "utf8"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeLinked(dataDir: string, agentId: string, dirs: string[]) {
  const dir = join(dataDir, "agents", agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skills-linked.json"), JSON.stringify([...new Set(dirs)], null, 2));
}

/** Home for user-level discovery; overridable for tests. */
function userHome(): string {
  return process.env.TUANTUAN_SKILLS_HOME || homedir();
}

function skillDirs(root: string): { dir: string; name: string; description: string }[] {
  if (!existsSync(root)) return [];
  const out: { dir: string; name: string; description: string }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const n of names) {
    const dir = join(root, n);
    const md = join(dir, "SKILL.md");
    try {
      if (!statSync(dir).isDirectory() || !existsSync(md)) continue;
      const parsed = parseSkillMd(readFileSync(md, "utf8"));
      if (parsed) out.push({ dir, name: parsed.name, description: parsed.description });
    } catch {
      // unreadable entry
    }
  }
  return out;
}

/** Claude Code plugins: ~/.claude/plugins/** /<plugin>/skills/<name>/SKILL.md (marketplaces, cache). */
function pluginSkills(home: string): { dir: string; name: string; description: string; plugin: string }[] {
  const base = join(home, ".claude", "plugins");
  const out: { dir: string; name: string; description: string; plugin: string }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    if (entries.includes("skills")) {
      const pluginJson = join(d, ".claude-plugin", "plugin.json");
      let plugin = d.split("/").pop() ?? "plugin";
      try {
        plugin = JSON.parse(readFileSync(pluginJson, "utf8")).name || plugin;
      } catch {
        // folder name
      }
      for (const s of skillDirs(join(d, "skills"))) out.push({ ...s, plugin });
    }
    for (const e of entries) {
      if (e === "skills" || e === "node_modules" || e === ".git") continue;
      const p = join(d, e);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        // skip
      }
    }
  };
  walk(base, 0);
  return out;
}

/** Known native directories only; cached/marketplace plugin presence does not prove it is enabled. */
function nativeFor(harness: string, origin: SkillOrigin, projectKind?: string): boolean {
  if (harness === "claude-code") return origin === "user-claude" || projectKind === ".claude";
  if (harness === "codex") return origin === "user-codex" || origin === "user-agents" || projectKind === ".agents";
  if (harness === "opencode")
    return projectKind === ".agents" || projectKind === ".claude" || projectKind === ".opencode";
  if (harness === "grok") return projectKind === ".agents";
  if (harness === "reg:antigravity-acp")
    return origin === "user-gemini" || projectKind === ".agents" || projectKind === ".gemini";
  return false;
}

function realKey(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Everything this agent could use: its imported skills plus what is already on the machine / in the project. */
export function discoverSkills(
  dataDir: string,
  agentId: string | null,
  harness: string,
  projectDir: string | null,
  harnessEnv: Record<string, string | undefined> = {},
): DiscoveredSkill[] {
  const home = userHome();
  const linked = new Set(agentId ? readLinked(dataDir, agentId) : []);
  const byReal = new Map<string, DiscoveredSkill>();
  const push = (
    s: { dir: string; name: string; description: string },
    origin: SkillOrigin,
    label: string,
    projectKind?: string,
    importedEnabled = false,
  ) => {
    const key = resolve(s.dir);
    const real = realKey(key);
    const native = nativeFor(harness, origin, projectKind);
    const enabled = native || linked.has(key) || importedEnabled;
    const source = { key, origin, label, native };
    const previous = byReal.get(real);
    if (previous) {
      previous.sources.push(source);
      // Prefer a real native source for the visible badge; keep all paths in the source details.
      if ((native && !previous.native) || (!previous.enabled && enabled))
        Object.assign(previous, { key, dir: key, origin, label });
      previous.native ||= native;
      previous.enabled ||= enabled;
      return;
    }
    byReal.set(real, {
      key,
      name: s.name,
      description: s.description,
      dir: key,
      origin,
      label,
      native,
      enabled,
      sources: [source],
    });
  };
  for (const s of agentId ? listAgentSkills(dataDir, agentId) : []) push(s, "imported", "已导入", undefined, s.enabled);
  for (const dir of librarySkillDirs(dataDir)) {
    const parsed = parseSkillMd(readFileSync(join(dir, "SKILL.md"), "utf8"));
    if (parsed) push({ dir, ...parsed }, "library", "已导入");
  }
  for (const s of skillDirs(join(home, ".agents", "skills"))) push(s, "user-agents", "~/.agents");
  for (const s of skillDirs(join(home, ".claude", "skills"))) push(s, "user-claude", "~/.claude");
  for (const s of skillDirs(join(home, ".codex", "skills"))) push(s, "user-codex", "~/.codex");
  const configuredGeminiHome = "GEMINI_HOME" in harnessEnv ? harnessEnv.GEMINI_HOME : process.env.GEMINI_HOME;
  const geminiHome = resolve(configuredGeminiHome?.trim() || join(home, ".gemini"));
  for (const rel of ["config", "antigravity-cli"])
    for (const s of skillDirs(join(geminiHome, rel, "skills"))) push(s, "user-gemini", `Gemini ${rel}`);
  for (const s of pluginSkills(home)) push(s, "plugin", s.plugin);
  if (projectDir) {
    for (const rel of [".agents", ".claude", ".opencode", ".gemini"])
      for (const s of skillDirs(join(projectDir, rel, "skills"))) push(s, "project", `项目 ${rel}`, rel);
  }
  return [...byReal.values()];
}

function librarySkillDirs(dataDir: string): string[] {
  const lib = join(dataDir, "library");
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    if (depth > 0 && existsSync(join(d, "SKILL.md"))) out.push(d);
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === ".git" || n === "node_modules") continue;
      try {
        if (statSync(join(d, n)).isDirectory()) walk(join(d, n), depth + 1);
      } catch {
        // skip
      }
    }
  };
  if (existsSync(lib)) for (const pkg of readdirSync(lib)) walk(join(lib, pkg), 1);
  // Skills that belong to an imported plugin come with the plugin (checked as a whole).
  return out.filter((d) => {
    for (let p = dirname(d); p.startsWith(lib) && p !== lib; p = dirname(p)) {
      const sk = join(p, "skills");
      if (existsSync(join(p, ".claude-plugin", "plugin.json")) && d.startsWith(`${sk}/`)) return false;
    }
    return true;
  });
}

/** Turn a discovered (non-imported) skill on or off for this agent. */
export function setSkillLinked(dataDir: string, agentId: string, dir: string, enabled: boolean) {
  const key = resolve(dir);
  const md = join(key, "SKILL.md");
  if (enabled && !existsSync(md)) throw new Error("这里没有 SKILL.md");
  const cur = readLinked(dataDir, agentId).filter((d) => realKey(d) !== realKey(key));
  writeLinked(dataDir, agentId, enabled ? [...cur, key] : cur);
}

/** Linked skills that still exist (for materialize / $ picker / load_skill). */
export function listLinkedSkills(dataDir: string, agentId: string): SkillMeta[] {
  const out: SkillMeta[] = [];
  for (const dir of readLinked(dataDir, agentId)) {
    const md = join(dir, "SKILL.md");
    if (!existsSync(md)) continue;
    const parsed = parseSkillMd(readFileSync(md, "utf8"));
    if (parsed) out.push({ name: parsed.name, description: parsed.description, dir, source: "import", enabled: true });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Import from a URL: a GitHub repo / tree URL (tarball via codeload), a raw SKILL.md URL, or any git
// URL (shallow clone). Fetched into a cache dir; the user picks which SKILL.md dirs to copy in.

export interface RemoteSkill {
  /** Path inside the fetched tree. */
  path: string;
  name: string;
  description: string;
}

const MAX_DOWNLOAD = 50 * 1024 * 1024;

function cacheDirFor(dataDir: string, url: string): string {
  const h = new Bun.CryptoHasher("sha256").update(url).digest("hex").slice(0, 16);
  return join(dataDir, "cache", "skill-url", h);
}

async function download(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { signal, redirect: "follow", headers: { "user-agent": "tuantuan" } });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_DOWNLOAD) throw new Error("文件太大（>50 MB）");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD) throw new Error("文件太大（>50 MB）");
  return buf;
}

/** https://github.com/o/r[/tree/<ref>/<path>] → tarball URL + sub path. */
export function parseGitHubUrl(url: string): { tarball: string; sub: string } | null {
  const m =
    /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*?))?)?\/?(?:[?#].*)?$/.exec(
      url.trim(),
    );
  if (!m) return null;
  const [, owner, repo, ref, sub] = m;
  const base = process.env.TUANTUAN_GITHUB_CODELOAD || "https://codeload.github.com";
  let path = (sub ?? "").replace(/(^|\/)SKILL\.md$/, "");
  path = path.replace(/\/$/, "");
  return { tarball: `${base}/${owner}/${repo}/tar.gz/${ref ?? "HEAD"}`, sub: path };
}

function findSkillMds(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 7) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  if (entries.includes("SKILL.md")) out.push(root);
  for (const e of entries) {
    if (e === ".git" || e === "node_modules") continue;
    const p = join(root, e);
    try {
      if (statSync(p).isDirectory()) findSkillMds(p, depth + 1, out);
    } catch {
      // skip
    }
  }
  return out;
}

/** Fetch `url` into the cache and list the skills found there. */
export async function previewSkillUrl(
  dataDir: string,
  url: string,
  opts: { allowEmpty?: boolean } = {},
): Promise<{ root: string; scope: string; skills: RemoteSkill[] }> {
  const u = url.trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(u)) throw new Error("请输入 GitHub / git / SKILL.md 链接");
  const root = cacheDirFor(dataDir, u);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const signal = AbortSignal.timeout(60_000);
  const gh = parseGitHubUrl(u);
  let scope = root;
  try {
    if (/\.md(\?.*)?$/i.test(u) && !gh?.sub?.length) {
      const text = new TextDecoder().decode(await download(u, signal));
      const parsed = parseSkillMd(text);
      if (!parsed) throw new Error("不是有效的 SKILL.md（缺少 name）");
      const dir = join(root, parsed.name.replace(/[^\w.-]+/g, "-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), text);
    } else if (gh && !/\.git$/.test(u)) {
      const tgz = join(root, "..", `${root.split("/").pop()}.tgz`);
      writeFileSync(tgz, await download(gh.tarball, signal));
      const t = Bun.spawnSync(["tar", "-xzf", tgz, "-C", root, "--strip-components=1"], { stderr: "pipe" });
      rmSync(tgz, { force: true });
      if (t.exitCode !== 0) throw new Error(`解压失败：${t.stderr.toString().slice(-200)}`);
      if (gh.sub) scope = join(root, gh.sub);
    } else {
      const g = Bun.spawnSync(["git", "clone", "--depth", "1", u, root], {
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      if (g.exitCode !== 0) throw new Error(`git clone 失败：${g.stderr.toString().trim().slice(-200)}`);
    }
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  const skills: RemoteSkill[] = [];
  for (const dir of findSkillMds(scope)) {
    const parsed = parseSkillMd(readFileSync(join(dir, "SKILL.md"), "utf8"));
    if (parsed)
      skills.push({ path: dir.slice(root.length + 1) || ".", name: parsed.name, description: parsed.description });
  }
  if (!skills.length && !opts.allowEmpty) throw new Error("没找到 SKILL.md");
  return { root, scope, skills };
}

/** Copy the chosen skills (by path from preview) into the agent's store. Re-fetches if the cache is gone. */
export async function importSkillUrl(dataDir: string, agentId: string, url: string, paths: string[]): Promise<number> {
  let root = cacheDirFor(dataDir, url.trim());
  if (!existsSync(root)) root = (await previewSkillUrl(dataDir, url)).root;
  const dest = agentSkillsRoot(dataDir, agentId);
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const p of paths) {
    const src = resolve(root, p);
    if (!src.startsWith(root)) continue; // no escaping the cache
    const md = join(src, "SKILL.md");
    if (!existsSync(md)) continue;
    const parsed = parseSkillMd(readFileSync(md, "utf8"));
    if (!parsed) continue;
    const target = join(dest, parsed.name.replace(/[^\w.-]+/g, "-"));
    rmSync(target, { recursive: true, force: true });
    cpSync(src, target, { recursive: true, filter: (s) => !s.includes("/.git") });
    setSkillEnabled(dataDir, agentId, parsed.name, true);
    n++;
  }
  if (!n) throw new Error("没有选中可导入的 Skill");
  return n;
}
