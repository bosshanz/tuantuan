import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { parseSkillMd, previewSkillUrl } from "./skills";

/**
 * 「Skills 与插件」: one library of what is on this machine (read-only discovery of ~/.claude,
 * ~/.agents, ~/.codex and project dirs) plus packages imported into Tuantuan's managed dir
 * (<data>/library/<slug>). Nothing is ever written to the user's or project's dirs here.
 */

export type LibKind = "skill" | "plugin" | "command" | "agent";
export type Support = "yes" | "partial" | "no";
export type PartKey = "skills" | "commands" | "agents" | "mcp" | "hooks";

/** Harnesses the support badges are computed for (curated + BYOK). */
export const SUPPORT_HARNESSES = ["claude-code", "codex", "opencode", "grok", "pi", "minimax", "custom"] as const;

export interface PluginParts {
  skills: { name: string; description: string; dir: string }[];
  commands: string[];
  agents: string[];
  hooks: string[];
  mcp: {
    name: string;
    type: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  }[];
}

export interface LibItem {
  /** Absolute path (skill dir, plugin root or .md file); stable id. */
  id: string;
  kind: LibKind;
  name: string;
  description: string;
  /** Where it came from: "~/.claude", "~/.claude/plugins", "项目 foo", "已导入" … */
  source: string;
  /** "SKILL.md", "Claude 插件", "Claude 命令", "Claude 子代理", "Codex 提示词". */
  format: string;
  managed: boolean;
  /** Managed package id when imported. */
  packageId: string | null;
  version?: string | null;
  counts?: Record<PartKey, number>;
  /** Per harness: can it consume this item, and which plugin parts it cannot. */
  support: Record<string, { level: Support; missing: PartKey[] }>;
  /** Only skills and plugins can be checked per Agent. */
  selectable: boolean;
}

export interface LibPackage {
  id: string;
  url: string;
  name: string;
  importedAt: number;
  updatedAt: number;
  items: number;
}

const home = () => process.env.TUANTUAN_SKILLS_HOME || homedir();
const tilde = (p: string) => (p.startsWith(home()) ? `~${p.slice(home().length)}` : p);

function safeDirs(d: string): string[] {
  try {
    return readdirSync(d).filter((n) => {
      try {
        return statSync(join(d, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
function safeFiles(d: string, ext = ".md"): string[] {
  try {
    return readdirSync(d).filter((n) => n.endsWith(ext) && statSync(join(d, n)).isFile());
  } catch {
    return [];
  }
}
function readJson(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function skillsIn(dir: string): { name: string; description: string; dir: string }[] {
  const out: { name: string; description: string; dir: string }[] = [];
  for (const n of safeDirs(dir)) {
    const md = join(dir, n, "SKILL.md");
    if (!existsSync(md)) continue;
    const p = parseSkillMd(readFileSync(md, "utf8"));
    if (p) out.push({ name: p.name, description: p.description, dir: join(dir, n) });
  }
  return out;
}

/** Front-matter description of a command / subagent .md (or its first line). */
function mdInfo(file: string): { name: string; description: string } {
  const text = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  })();
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const pick = (k: string) =>
    new RegExp(`^${k}:\\s*(.+)$`, "m")
      .exec(fm)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
  const body = text.replace(/^---[\s\S]*?---\s*/, "");
  return {
    name: pick("name") || basename(file, ".md"),
    description:
      pick("description") ||
      body
        .split("\n")
        .find((l) => l.trim())
        ?.trim()
        .slice(0, 120) ||
      "",
  };
}

const asList = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Claude plugin format: .claude-plugin/plugin.json + default dirs (skills/ commands/ agents/ hooks/ .mcp.json). */
export function parsePlugin(
  root: string,
): { name: string; description: string; version: string | null; parts: PluginParts } | null {
  const manifest = readJson(join(root, ".claude-plugin", "plugin.json")) as Record<string, unknown> | null;
  if (!manifest) return null;
  const rel = (p: string) => resolve(root, p.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root));
  const parts: PluginParts = { skills: [], commands: [], agents: [], hooks: [], mcp: [] };
  for (const d of [join(root, "skills"), ...asList(manifest.skills).map(rel)]) parts.skills.push(...skillsIn(d));
  const mdsFrom = (dirs: string[]) => {
    const out: string[] = [];
    for (const d of dirs) {
      if (d.endsWith(".md") && existsSync(d)) out.push(basename(d, ".md"));
      else out.push(...safeFiles(d).map((f) => f.replace(/\.md$/, "")));
    }
    return [...new Set(out)];
  };
  parts.commands = mdsFrom([join(root, "commands"), ...asList(manifest.commands).map(rel)]);
  parts.agents = mdsFrom([join(root, "agents"), ...asList(manifest.agents).map(rel)]);
  const hooks =
    typeof manifest.hooks === "object" && manifest.hooks && !Array.isArray(manifest.hooks)
      ? manifest.hooks
      : readJson(typeof manifest.hooks === "string" ? rel(manifest.hooks) : join(root, "hooks", "hooks.json"));
  const hookMap = (hooks as { hooks?: Record<string, unknown> } | null)?.hooks ?? hooks;
  if (hookMap && typeof hookMap === "object") parts.hooks = Object.keys(hookMap as object);
  const mcpRaw =
    typeof manifest.mcpServers === "object" && manifest.mcpServers
      ? manifest.mcpServers
      : readJson(typeof manifest.mcpServers === "string" ? rel(manifest.mcpServers) : join(root, ".mcp.json"));
  const servers = ((mcpRaw as { mcpServers?: unknown } | null)?.mcpServers ?? mcpRaw) as Record<
    string,
    Record<string, unknown>
  > | null;
  if (servers && typeof servers === "object")
    for (const [name, s] of Object.entries(servers)) {
      if (!s || typeof s !== "object") continue;
      const sub = (v: unknown) => (typeof v === "string" ? v.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root) : "");
      const type = s.type === "http" || s.type === "sse" ? s.type : s.url ? "http" : "stdio";
      parts.mcp.push({
        name,
        type,
        command: sub(s.command) || undefined,
        args: Array.isArray(s.args) ? s.args.map(sub) : undefined,
        env:
          s.env && typeof s.env === "object"
            ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, sub(v)]))
            : undefined,
        url: sub(s.url) || undefined,
      });
    }
  return {
    name: typeof manifest.name === "string" && manifest.name ? manifest.name : basename(root),
    description: typeof manifest.description === "string" ? manifest.description : "",
    version: typeof manifest.version === "string" ? manifest.version : null,
    parts,
  };
}

/**
 * What a harness can actually consume. Claude Code loads a whole plugin (`plugins` option of the
 * Claude Agent SDK). Everyone else: skills through the shared skills dir, stdio MCP servers through
 * ACP session/new; commands, subagents and hooks are Claude-only.
 */
export function partSupported(harness: string, part: PartKey, plugin?: PluginParts): boolean {
  if (harness === "claude-code") return true;
  if (part === "skills") return true;
  if (part === "mcp") return harness !== "custom" && (plugin?.mcp ?? []).every((m) => m.type === "stdio");
  return false;
}

function supportFor(kind: LibKind, format: string, parts?: PluginParts) {
  const out: LibItem["support"] = {};
  for (const h of SUPPORT_HARNESSES) {
    if (kind === "skill") out[h] = { level: "yes", missing: [] };
    else if (kind === "command" && format === "Codex 提示词")
      out[h] = { level: h === "codex" ? "yes" : "no", missing: [] };
    else if (kind === "command" || kind === "agent")
      out[h] = { level: h === "claude-code" ? "yes" : "no", missing: [] };
    else if (parts) {
      const present = (["skills", "commands", "agents", "mcp", "hooks"] as PartKey[]).filter(
        (k) => parts[k].length > 0,
      );
      const missing = present.filter((k) => !partSupported(h, k, parts));
      out[h] = { level: missing.length === 0 ? "yes" : missing.length === present.length ? "no" : "partial", missing };
    }
  }
  return out;
}

export function libraryRoot(dataDir: string): string {
  return join(dataDir, "library");
}

function pluginItem(root: string, source: string, managed: boolean, packageId: string | null): LibItem | null {
  const p = parsePlugin(root);
  if (!p) return null;
  return {
    id: resolve(root),
    kind: "plugin",
    name: p.name,
    description: p.description,
    source,
    format: "Claude 插件",
    managed,
    packageId,
    version: p.version,
    counts: {
      skills: p.parts.skills.length,
      commands: p.parts.commands.length,
      agents: p.parts.agents.length,
      mcp: p.parts.mcp.length,
      hooks: p.parts.hooks.length,
    },
    support: supportFor("plugin", "", p.parts),
    selectable: true,
  };
}

/** Plugin roots under a tree (dirs holding .claude-plugin/plugin.json), e.g. ~/.claude/plugins. */
function findPlugins(base: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || !existsSync(base)) return out;
  if (existsSync(join(base, ".claude-plugin", "plugin.json"))) {
    out.push(base);
    return out;
  }
  for (const d of safeDirs(base)) if (d !== "node_modules" && d !== ".git") findPlugins(join(base, d), depth + 1, out);
  return out;
}

function findSkillDirs(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || !existsSync(root)) return out;
  if (existsSync(join(root, "SKILL.md"))) out.push(root);
  for (const d of safeDirs(root))
    if (d !== ".git" && d !== "node_modules") findSkillDirs(join(root, d), depth + 1, out);
  return out;
}

function readPkg(dir: string): Omit<LibPackage, "items"> | null {
  const m = readJson(join(dir, ".tuantuan-package.json")) as Omit<LibPackage, "items"> | null;
  return m && typeof m.url === "string" ? m : null;
}

/** The whole library: discovered (read-only) + managed packages. */
export function listLibrary(
  dataDir: string,
  projects: { name: string; cwd: string }[],
): { items: LibItem[]; packages: LibPackage[] } {
  const items: LibItem[] = [];
  const seen = new Set<string>();
  const add = (it: LibItem | null) => {
    if (!it) return;
    const k = `${it.kind}:${real(it.id)}`;
    if (seen.has(k)) return;
    seen.add(k);
    items.push(it);
  };
  const skill = (
    s: { name: string; description: string; dir: string },
    source: string,
    managed = false,
    packageId: string | null = null,
  ): LibItem => ({
    id: resolve(s.dir),
    kind: "skill",
    name: s.name,
    description: s.description,
    source,
    format: "SKILL.md",
    managed,
    packageId,
    support: supportFor("skill", "SKILL.md"),
    selectable: true,
  });
  const mdItems = (dir: string, kind: "command" | "agent", source: string, format: string) => {
    for (const f of safeFiles(dir)) {
      const info = mdInfo(join(dir, f));
      add({
        id: join(dir, f),
        kind,
        name: info.name,
        description: info.description,
        source,
        format,
        managed: false,
        packageId: null,
        support: supportFor(kind, format),
        selectable: false,
      });
    }
  };

  // Managed packages first so their copies win over identical discovered ones.
  const packages: LibPackage[] = [];
  const lib = libraryRoot(dataDir);
  for (const id of safeDirs(lib)) {
    const dir = join(lib, id);
    const meta = readPkg(dir);
    if (!meta) continue;
    const before = items.length;
    const plugins = findPlugins(dir);
    for (const p of plugins) add(pluginItem(p, "已导入", true, id));
    const inPlugin = new Set(plugins.flatMap((p) => parsePlugin(p)?.parts.skills.map((s) => resolve(s.dir)) ?? []));
    for (const d of findSkillDirs(dir)) {
      if (inPlugin.has(resolve(d))) continue;
      const parsed = parseSkillMd(readFileSync(join(d, "SKILL.md"), "utf8"));
      if (parsed) add(skill({ ...parsed, dir: d }, "已导入", true, id));
    }
    packages.push({ ...meta, id, items: items.length - before });
  }

  const h = home();
  for (const s of skillsIn(join(h, ".claude", "skills"))) add(skill(s, "~/.claude"));
  mdItems(join(h, ".claude", "commands"), "command", "~/.claude", "Claude 命令");
  mdItems(join(h, ".claude", "agents"), "agent", "~/.claude", "Claude 子代理");
  for (const p of findPlugins(join(h, ".claude", "plugins"))) add(pluginItem(p, "~/.claude/plugins", false, null));
  for (const s of skillsIn(join(h, ".agents", "skills"))) add(skill(s, "~/.agents"));
  for (const s of skillsIn(join(h, ".codex", "skills"))) add(skill(s, "~/.codex"));
  mdItems(join(h, ".codex", "prompts"), "command", "~/.codex", "Codex 提示词");
  for (const p of projects) {
    const src = `项目 ${p.name}`;
    for (const rel of [".claude", ".agents"]) for (const s of skillsIn(join(p.cwd, rel, "skills"))) add(skill(s, src));
    mdItems(join(p.cwd, ".claude", "commands"), "command", src, "Claude 命令");
    mdItems(join(p.cwd, ".claude", "agents"), "agent", src, "Claude 子代理");
  }
  return { items, packages };
}

const slugOf = (url: string) =>
  (
    url
      .replace(/\.git$/, "")
      .replace(/[?#].*$/, "")
      .split(/[/:]/)
      .filter(Boolean)
      .slice(-2)
      .join("-")
      .replace(/[^\w.-]+/g, "-")
      .toLowerCase() || "package"
  ).slice(0, 60);

/** Import a git repo / GitHub URL / SKILL.md URL into the managed dir (whole tree, minus .git). */
export async function importPackage(dataDir: string, url: string, existingId?: string): Promise<LibPackage> {
  const { scope: root } = await previewSkillUrlOrPlugin(dataDir, url);
  const lib = libraryRoot(dataDir);
  mkdirSync(lib, { recursive: true });
  let id = existingId ?? slugOf(url);
  if (!existingId) for (let i = 2; existsSync(join(lib, id)); i++) id = `${slugOf(url)}-${i}`;
  const dest = join(lib, id);
  const prev = readPkg(dest);
  const tmp = `${dest}.new`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(root, tmp, { recursive: true, filter: (s) => !s.split("/").includes(".git") });
  rmSync(dest, { recursive: true, force: true });
  cpSync(tmp, dest, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  const now = Date.now();
  const plugin = findPlugins(dest)[0];
  const name = (plugin && parsePlugin(plugin)?.name) || slugOf(url);
  const meta = { id, url: url.trim(), name, importedAt: prev?.importedAt ?? now, updatedAt: now };
  writeFileSync(join(dest, ".tuantuan-package.json"), JSON.stringify(meta, null, 2));
  const pkg = listLibrary(dataDir, []).packages.find((p) => p.id === id);
  if (!pkg?.items) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error("没找到 Skill 或插件（SKILL.md / .claude-plugin/plugin.json）");
  }
  return pkg;
}

/** Fetch like the skill preview, but a plugin repo without SKILL.md is fine too. */
async function previewSkillUrlOrPlugin(dataDir: string, url: string): Promise<{ scope: string }> {
  try {
    return await previewSkillUrl(dataDir, url);
  } catch (e) {
    // previewSkillUrl deletes the tree when no SKILL.md is found: fetch again and accept plugins.
    if (!/没找到 SKILL\.md/.test((e as Error).message)) throw e;
    const r = await previewSkillUrl(dataDir, url, { allowEmpty: true });
    if (!findPlugins(r.scope).length) throw new Error("没找到 Skill 或插件（SKILL.md / .claude-plugin/plugin.json）");
    return r;
  }
}

export async function updatePackage(dataDir: string, id: string): Promise<LibPackage> {
  const meta = readPkg(join(libraryRoot(dataDir), id));
  if (!meta) throw new Error("没有这个导入");
  return importPackage(dataDir, meta.url, id);
}

export function deletePackage(dataDir: string, id: string) {
  const dir = join(libraryRoot(dataDir), id);
  if (!readPkg(dir)) throw new Error("没有这个导入");
  rmSync(dir, { recursive: true, force: true });
}

// ---- per-agent plugin choice ---------------------------------------------------------------

const pluginsFile = (dataDir: string, agentId: string) => join(dataDir, "agents", agentId, "plugins-linked.json");

export function readLinkedPlugins(dataDir: string, agentId: string): string[] {
  const v = readJson(pluginsFile(dataDir, agentId));
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function setPluginLinked(dataDir: string, agentId: string, root: string, on: boolean) {
  const key = resolve(root);
  if (on && !parsePlugin(key)) throw new Error("这里没有 .claude-plugin/plugin.json");
  const cur = readLinkedPlugins(dataDir, agentId).filter((p) => p !== key);
  mkdirSync(join(dataDir, "agents", agentId), { recursive: true });
  writeFileSync(pluginsFile(dataDir, agentId), JSON.stringify(on ? [...cur, key] : cur, null, 2));
}

/** Plugins an agent may pick, with this harness's support for each. */
export function pluginsForAgent(
  dataDir: string,
  agentId: string | null,
  harness: string,
  projects: { name: string; cwd: string }[],
) {
  const linked = new Set(agentId ? readLinkedPlugins(dataDir, agentId) : []);
  return listLibrary(dataDir, projects)
    .items.filter((i) => i.kind === "plugin")
    .map((i) => ({
      key: i.id,
      name: i.name,
      description: i.description,
      label: i.source,
      counts: i.counts,
      support: i.support[harness] ?? supportFor("plugin", "", parsePlugin(i.id)?.parts).codex,
      enabled: linked.has(i.id),
    }));
}

/**
 * What a session loads for the checked plugins:
 *   Claude Code → `_meta.claudeCode.options.plugins` (whole plugin, session-only);
 *   others → the plugin's skills (linked like any skill) + its stdio MCP servers over ACP.
 */
export function pluginOverlay(dataDir: string, agentId: string, harness: string) {
  const roots = readLinkedPlugins(dataDir, agentId).filter((r) => existsSync(join(r, ".claude-plugin", "plugin.json")));
  if (harness === "claude-code")
    return {
      claudePlugins: roots.map((path) => ({ type: "local" as const, path })),
      skills: [],
      mcp: [] as acp.McpServer[],
    };
  const skills: { name: string; description: string; dir: string }[] = [];
  const mcp: acp.McpServer[] = [];
  for (const r of roots) {
    const p = parsePlugin(r);
    if (!p) continue;
    skills.push(...p.parts.skills);
    if (harness !== "custom")
      for (const m of p.parts.mcp)
        if (m.type === "stdio" && m.command)
          mcp.push({
            name: `${p.name}-${m.name}`,
            command: m.command,
            args: m.args ?? [],
            env: Object.entries(m.env ?? {}).map(([name, value]) => ({ name, value })),
          });
  }
  return { claudePlugins: [] as { type: "local"; path: string }[], skills, mcp };
}
