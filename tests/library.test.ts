import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withClaudePlugins } from "../server/host";
import {
  deletePackage,
  importPackage,
  listLibrary,
  parsePlugin,
  pluginOverlay,
  pluginsForAgent,
  setPluginLinked,
  updatePackage,
} from "../server/library";

const skill = (dir: string, name: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} desc\n---\nbody`);
};
function plugin(root: string, name: string, mcpType: "stdio" | "http" = "stdio") {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.2.0", description: `${name} plugin` }),
  );
  skill(join(root, "skills"), `${name}-skill`);
  mkdirSync(join(root, "commands"), { recursive: true });
  writeFileSync(join(root, "commands", "ship.md"), "---\ndescription: ship it\n---\n");
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\n---\n");
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [], Stop: [] } }));
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers:
        mcpType === "stdio"
          ? {
              db: {
                command: "${CLAUDE_PLUGIN_ROOT}/bin/db",
                args: ["--root", "${CLAUDE_PLUGIN_ROOT}"],
                env: { A: "1" },
              },
            }
          : { web: { type: "http", url: "https://x.example/mcp" } },
    }),
  );
}
const snapshot = (d: string): string[] => {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const n of readdirSync(p)) {
      const f = join(p, n);
      out.push(`${f}:${statSync(f).mtimeMs}`);
      if (statSync(f).isDirectory()) walk(f);
    }
  };
  walk(d);
  return out.sort();
};

let home = "";
let data = "";
let proj = "";
const prev = process.env.TUANTUAN_SKILLS_HOME;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "lib-home-"));
  data = mkdtempSync(join(tmpdir(), "lib-data-"));
  proj = mkdtempSync(join(tmpdir(), "lib-proj-"));
  skill(join(home, ".claude", "skills"), "c-skill");
  mkdirSync(join(home, ".claude", "commands"), { recursive: true });
  writeFileSync(join(home, ".claude", "commands", "fix.md"), "Fix the bug\n");
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  writeFileSync(join(home, ".claude", "agents", "tester.md"), "---\nname: tester\ndescription: tests\n---\n");
  plugin(join(home, ".claude", "plugins", "marketplaces", "acme", "plugins", "toolkit"), "toolkit");
  plugin(join(home, ".claude", "plugins", "cache", "acme", "webby", "1.0.0"), "webby", "http");
  skill(join(home, ".agents", "skills"), "a-skill");
  skill(join(home, ".codex", "skills"), "x-skill");
  mkdirSync(join(home, ".codex", "prompts"), { recursive: true });
  writeFileSync(join(home, ".codex", "prompts", "review.md"), "Review\n");
  skill(join(proj, ".claude", "skills"), "p-skill");
  process.env.TUANTUAN_SKILLS_HOME = home;
});
afterAll(() => {
  if (prev === undefined) delete process.env.TUANTUAN_SKILLS_HOME;
  else process.env.TUANTUAN_SKILLS_HOME = prev;
});

describe("library", () => {
  test("plugin.json parsing counts skills, commands, agents, hooks and MCP (with ${CLAUDE_PLUGIN_ROOT})", () => {
    const root = join(home, ".claude", "plugins", "marketplaces", "acme", "plugins", "toolkit");
    const p = parsePlugin(root);
    expect(p?.name).toBe("toolkit");
    expect(p?.version).toBe("1.2.0");
    expect(p?.parts.skills.map((s) => s.name)).toEqual(["toolkit-skill"]);
    expect(p?.parts.commands).toEqual(["ship"]);
    expect(p?.parts.agents).toEqual(["reviewer"]);
    expect(p?.parts.hooks.sort()).toEqual(["PreToolUse", "Stop"]);
    expect(p?.parts.mcp[0]).toMatchObject({
      name: "db",
      type: "stdio",
      command: `${root}/bin/db`,
      args: ["--root", root],
    });
  });

  test("discovers every source read-only, with format, source and per-harness support", () => {
    const before = snapshot(home);
    const { items } = listLibrary(data, [{ name: "demo", cwd: proj }]);
    const by = (n: string) => items.find((i) => i.name === n);
    expect(by("c-skill")).toMatchObject({ kind: "skill", source: "~/.claude", format: "SKILL.md" });
    expect(by("fix")).toMatchObject({ kind: "command", format: "Claude 命令" });
    expect(by("tester")).toMatchObject({ kind: "agent", format: "Claude 子代理" });
    expect(by("review")).toMatchObject({ kind: "command", format: "Codex 提示词" });
    expect(by("a-skill")?.source).toBe("~/.agents");
    expect(by("x-skill")?.source).toBe("~/.codex");
    expect(by("p-skill")?.source).toBe("项目 demo");
    const tk = by("toolkit");
    expect(tk).toMatchObject({
      kind: "plugin",
      format: "Claude 插件",
      counts: { skills: 1, commands: 1, agents: 1, mcp: 1, hooks: 2 },
    });
    // Claude loads the whole plugin; others get skills + stdio MCP only.
    expect(tk?.support["claude-code"]).toEqual({ level: "yes", missing: [] });
    expect(tk?.support.codex).toEqual({ level: "partial", missing: ["commands", "agents", "hooks"] });
    expect(tk?.support.custom?.missing).toEqual(["commands", "agents", "mcp", "hooks"]);
    // http MCP cannot go over ACP stdio
    expect(by("webby")?.support.grok?.missing).toContain("mcp");
    expect(by("fix")?.support.codex?.level).toBe("no");
    expect(by("review")?.support.codex?.level).toBe("yes");
    expect(snapshot(home)).toEqual(before);
  });

  test("checked plugins: Claude gets the plugin via _meta, others its skills + stdio MCP", () => {
    const root = join(home, ".claude", "plugins", "marketplaces", "acme", "plugins", "toolkit");
    setPluginLinked(data, "ag1", root, true);
    expect(pluginsForAgent(data, "ag1", "codex", []).find((p) => p.name === "toolkit")?.enabled).toBe(true);
    const cc = pluginOverlay(data, "ag1", "claude-code");
    expect(cc.claudePlugins).toEqual([{ type: "local", path: root }]);
    const merged = withClaudePlugins(
      { claudeCode: { options: { settings: { a: 1 } } }, systemPrompt: { append: "x" } },
      cc.claudePlugins,
    );
    expect(merged).toEqual({
      systemPrompt: { append: "x" },
      claudeCode: { options: { settings: { a: 1 }, plugins: [{ type: "local", path: root }] } },
    });
    const cx = pluginOverlay(data, "ag1", "codex");
    expect(cx.skills.map((s) => s.name)).toEqual(["toolkit-skill"]);
    expect(cx.mcp).toEqual([
      { name: "toolkit-db", command: `${root}/bin/db`, args: ["--root", root], env: [{ name: "A", value: "1" }] },
    ]);
    expect(pluginOverlay(data, "ag1", "custom").mcp).toEqual([]);
    setPluginLinked(data, "ag1", root, false);
    expect(pluginOverlay(data, "ag1", "claude-code").claudePlugins).toEqual([]);
    expect(() => setPluginLinked(data, "ag1", proj, true)).toThrow();
  });

  test("import from a git repo into the managed dir, update and delete", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lib-repo-"));
    plugin(repo, "shipit");
    skill(join(repo, "extra"), "loose-skill");
    const git = (...a: string[]) =>
      Bun.spawnSync(["git", "-C", repo, ...a], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "1");
    const pkg = await importPackage(data, `file://${repo}`);
    expect(pkg.name).toBe("shipit");
    let lib = listLibrary(data, []);
    expect(lib.items.find((i) => i.name === "shipit")).toMatchObject({
      managed: true,
      packageId: pkg.id,
      source: "已导入",
    });
    expect(lib.items.find((i) => i.name === "loose-skill")?.managed).toBe(true);
    skill(join(repo, "extra"), "newer-skill");
    git("add", ".");
    git("commit", "-qm", "2");
    await updatePackage(data, pkg.id);
    lib = listLibrary(data, []);
    expect(lib.items.some((i) => i.name === "newer-skill")).toBe(true);
    expect(lib.packages).toHaveLength(1);
    deletePackage(data, pkg.id);
    expect(listLibrary(data, []).items.some((i) => i.managed)).toBe(false);
    await expect(importPackage(data, `file://${mkdtempSync(join(tmpdir(), "empty-"))}`)).rejects.toThrow();
  });
});
