import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirs } from "../server/dirpicker";
import {
  discoverSkills,
  importSkillUrl,
  listAgentSkills,
  materializeSkills,
  parseGitHubUrl,
  previewSkillUrl,
  setSkillLinked,
} from "../server/skills";

const md = (name: string, d = `About ${name}`) => `---\nname: ${name}\ndescription: ${d}\n---\n\nBody of ${name}\n`;
function skill(root: string, name: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), md(name));
}
function pk<T>(m: Record<string, T>, k: string): T {
  const v = m[k];
  if (v === undefined) throw new Error(`missing ${k}`);
  return v;
}
const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

let home = "";
const prevHome = process.env.TUANTUAN_SKILLS_HOME;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sk-home-"));
  skill(join(home, ".agents", "skills"), "agents-one");
  skill(join(home, ".claude", "skills"), "claude-one");
  skill(join(home, ".codex", "skills"), "codex-one");
  const plug = join(home, ".claude", "plugins", "marketplaces", "m", "plugins", "tidy");
  mkdirSync(join(plug, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plug, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tidy-plugin" }));
  skill(join(plug, "skills"), "plug-one");
  process.env.TUANTUAN_SKILLS_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.TUANTUAN_SKILLS_HOME;
  else process.env.TUANTUAN_SKILLS_HOME = prevHome;
});

describe("skill discovery", () => {
  test("finds user, plugin and project skills; native vs linked; materialize without clobbering", () => {
    const data = mkdtempSync(join(tmpdir(), "sk-data-"));
    const proj = mkdtempSync(join(tmpdir(), "sk-proj-"));
    skill(join(proj, ".agents", "skills"), "proj-agents");
    skill(join(proj, ".claude", "skills"), "proj-claude");

    const all = discoverSkills(data, "a1", "claude-code", proj);
    const by = Object.fromEntries(all.map((s) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(
      ["agents-one", "claude-one", "codex-one", "plug-one", "proj-agents", "proj-claude"].sort(),
    );
    expect(pk(by, "plug-one").label).toBe("tidy-plugin");
    expect(pk(by, "proj-claude").label).toBe("项目 .claude");
    // Claude Code reads ~/.claude, plugins and project .claude itself.
    expect(pk(by, "claude-one").native && pk(by, "plug-one").native && pk(by, "proj-claude").native).toBe(true);
    expect(pk(by, "codex-one").native || pk(by, "codex-one").enabled).toBe(false);

    setSkillLinked(data, "a1", pk(by, "codex-one").key, true);
    setSkillLinked(data, "a1", pk(by, "proj-agents").key, true);
    expect(discoverSkills(data, "a1", "claude-code", proj).find((s) => s.name === "codex-one")?.enabled).toBe(true);

    // existing user file with the same name must not be replaced
    mkdirSync(join(proj, ".claude", "skills", "proj-agents-taken"), { recursive: true });
    const m = materializeSkills(data, "a1", "claude-code", proj);
    expect(m.skills.map((s) => s.name)).toContain("codex-one");
    expect(lstatSync(join(proj, ".claude", "skills", "codex-one")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(proj, ".claude", "skills", "proj-claude")).isSymbolicLink()).toBe(false);

    setSkillLinked(data, "a1", pk(by, "codex-one").key, false);
    expect(discoverSkills(data, "a1", "claude-code", proj).find((s) => s.name === "codex-one")?.enabled).toBe(false);

    // Codex reads ~/.codex, ~/.agents and project .agents natively.
    const cx = Object.fromEntries(discoverSkills(data, "a2", "codex", proj).map((s) => [s.name, s]));
    expect(pk(cx, "codex-one").native && pk(cx, "agents-one").native && pk(cx, "proj-agents").native).toBe(true);
    expect(pk(cx, "claude-one").native).toBe(false);
    expect(() => setSkillLinked(data, "a1", proj, true)).toThrow();
  });

  test("dir browser lists folders and marks git repos", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-"));
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "plain"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "file.txt"), "x");
    const l = listDirs(root);
    expect(l.dirs.map((d) => [d.name, d.git])).toEqual([
      ["plain", false],
      ["repo", true],
    ]);
    expect(l.crumbs.at(-1)?.path).toBe(root);
    expect(listDirs(root, true).dirs.map((d) => d.name)).toContain(".hidden");
    expect(() => listDirs(join(root, "file.txt"))).toThrow();
  });
});

describe("skill import from URL", () => {
  let server: ReturnType<typeof Bun.serve>;
  let tarPath = "";
  const prevLoad = process.env.TUANTUAN_GITHUB_CODELOAD;
  beforeAll(() => {
    const src = mkdtempSync(join(tmpdir(), "gh-src-"));
    const repo = join(src, "skills-main");
    skill(join(repo, "skills"), "alpha");
    skill(join(repo, "skills"), "beta");
    skill(join(repo, "other"), "gamma");
    sh(["tar", "-czf", join(src, "r.tgz"), "skills-main"], src);
    tarPath = join(src, "r.tgz");
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/raw/SKILL.md") return new Response(md("rawsy", "From raw"));
        if (u.pathname === "/acme/skills/tar.gz/HEAD" || u.pathname === "/acme/skills/tar.gz/main")
          return new Response(Bun.file(tarPath));
        return new Response("nope", { status: 404 });
      },
    });
    process.env.TUANTUAN_GITHUB_CODELOAD = `http://localhost:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
    if (prevLoad === undefined) delete process.env.TUANTUAN_GITHUB_CODELOAD;
    else process.env.TUANTUAN_GITHUB_CODELOAD = prevLoad;
  });

  test("parses GitHub URLs", () => {
    expect(parseGitHubUrl("https://github.com/o/r")?.sub).toBe("");
    expect(parseGitHubUrl("https://github.com/o/r/tree/main/skills/x")?.tarball).toEndWith("/o/r/tar.gz/main");
    expect(parseGitHubUrl("https://github.com/o/r/blob/main/skills/x/SKILL.md")?.sub).toBe("skills/x");
    expect(parseGitHubUrl("https://gitlab.com/o/r")).toBeNull();
  });

  test("raw SKILL.md", async () => {
    const data = mkdtempSync(join(tmpdir(), "sk-url-"));
    const url = `http://localhost:${server.port}/raw/SKILL.md`;
    const p = await previewSkillUrl(data, url);
    expect(p.skills.map((s) => s.name)).toEqual(["rawsy"]);
    expect(await importSkillUrl(data, "a", url, [p.skills[0]?.path ?? ""])).toBe(1);
    expect(listAgentSkills(data, "a").find((s) => s.name === "rawsy")?.enabled).toBe(true);
  });

  test("GitHub repo and tree URL via tarball, choose a subset", async () => {
    const data = mkdtempSync(join(tmpdir(), "sk-url-"));
    const all = await previewSkillUrl(data, "https://github.com/acme/skills");
    expect(all.skills.map((s) => s.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    const tree = await previewSkillUrl(data, "https://github.com/acme/skills/tree/main/skills");
    expect(tree.skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    const beta = tree.skills.find((s) => s.name === "beta");
    expect(await importSkillUrl(data, "a", "https://github.com/acme/skills/tree/main/skills", [beta?.path ?? ""])).toBe(
      1,
    );
    expect(listAgentSkills(data, "a").map((s) => s.name)).toEqual(["beta"]);
    await expect(importSkillUrl(data, "a", "https://github.com/acme/skills", ["../../etc"])).rejects.toThrow();
    await expect(previewSkillUrl(data, "https://github.com/acme/missing")).rejects.toThrow();
  });

  test("git URL (file://) clone", async () => {
    const repo = mkdtempSync(join(tmpdir(), "git-src-"));
    skill(join(repo, ".agents", "skills"), "gitty");
    sh(["git", "init", "-q"], repo);
    sh(["git", "add", "."], repo);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], repo);
    const data = mkdtempSync(join(tmpdir(), "sk-url-"));
    const p = await previewSkillUrl(data, `file://${repo}`);
    expect(p.skills.map((s) => s.name)).toEqual(["gitty"]);
    await importSkillUrl(data, "a", `file://${repo}`, [p.skills[0]?.path ?? ""]);
    expect(existsSync(join(data, "agents", "a", "skills", "gitty", "SKILL.md"))).toBe(true);
    expect(existsSync(join(data, "agents", "a", "skills", "gitty", ".git"))).toBe(false);
  });
});
