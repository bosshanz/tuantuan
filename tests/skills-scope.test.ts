import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  loadSkillBody,
  materializeSkills,
  selectedSkillIndex,
  setSkillEnabled,
  setSkillLinked,
} from "../server/skills";

const root = mkdtempSync(join(tmpdir(), "tt-skill-scope-"));
const home = join(root, "home");
const data = join(root, "data");
const previousHome = process.env.TUANTUAN_SKILLS_HOME;
process.env.TUANTUAN_SKILLS_HOME = home;
const env = { GEMINI_HOME: join(home, ".gemini") };
function skill(path: string, name: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: About ${name}\n---\nPRIVATE BODY ${name}`);
  return path;
}
function cwd(name: string) {
  const path = join(root, name);
  mkdirSync(path);
  return path;
}
afterAll(() => {
  if (previousHome === undefined) delete process.env.TUANTUAN_SKILLS_HOME;
  else process.env.TUANTUAN_SKILLS_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

test("same project selections stay per Agent, and unchecking revokes the index without adding files", () => {
  const project = cwd("shared");
  const source = skill(join(home, ".agents/skills/shared-choice"), "shared-choice");
  setSkillLinked(data, "a", source, true);
  const a = materializeSkills(data, "a", "reg:antigravity-acp", project, [], env);
  const b = materializeSkills(data, "b", "reg:antigravity-acp", project, [], env);
  expect(a.skills.map((s) => s.name)).toEqual(["shared-choice"]);
  expect([...b.skills, ...b.roomSkills]).toEqual([]);
  expect(existsSync(join(project, ".agents"))).toBe(false);
  expect(existsSync(join(project, ".claude"))).toBe(false);
  const index = selectedSkillIndex(a.skills);
  expect(index).toContain(join(source, "SKILL.md"));
  expect(index).not.toContain("PRIVATE BODY");
  setSkillLinked(data, "a", source, false);
  const revoked = materializeSkills(data, "a", "reg:antigravity-acp", project, [], env);
  expect(revoked.skills).toEqual([]);
  expect(selectedSkillIndex(revoked.skills)).toContain("[]");
  expect(selectedSkillIndex(revoked.skills)).toContain("未列出不表示 Harness 没有原生技能");
});

test("native project aliases survive realpath deduplication and preserve historical unknown links", () => {
  const project = cwd("legacy");
  const source = skill(join(home, ".agents/skills/old-link"), "old-link");
  mkdirSync(join(project, ".agents/skills"), { recursive: true });
  const link = join(project, ".agents/skills/old-link");
  symlinkSync(source, link);
  const item = discoverSkills(data, "b", "reg:antigravity-acp", project, env).find((s) => s.name === "old-link");
  expect(item).toMatchObject({ native: true, enabled: true, origin: "project", label: "项目 .agents" });
  expect(item?.sources.map((s) => ({ native: s.native, key: s.key }))).toEqual([
    { native: false, key: source },
    { native: true, key: link },
  ]);
  const effective = materializeSkills(data, "b", "reg:antigravity-acp", project, [], env);
  expect(effective.skills).toEqual([]);
  expect(effective.roomSkills.map((s) => s.name)).toEqual(["old-link"]);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(source);
});

test("Antigravity's confirmed global/project roots agree between settings and effective menu", () => {
  const project = cwd("native");
  const relocated = join(root, "gemini-home");
  for (const [path, name] of [
    [join(relocated, "config/skills/global-a"), "global-a"],
    [join(relocated, "antigravity-cli/skills/global-b"), "global-b"],
    [join(project, ".agents/skills/proj-a"), "proj-a"],
    [join(project, ".gemini/skills/proj-b"), "proj-b"],
    [join(project, ".claude/skills/other"), "other"],
  ] as const)
    skill(path, name);
  const relocatedEnv = { GEMINI_HOME: relocated };
  const settings = discoverSkills(data, "anti", "reg:antigravity-acp", project, relocatedEnv);
  expect(settings.find((s) => s.name === "other")).toMatchObject({ native: false, enabled: false });
  const nativeNames = settings
    .filter((s) => s.native)
    .map((s) => s.name)
    .sort();
  expect(nativeNames).toEqual(["global-a", "global-b", "proj-a", "proj-b"]);
  const effective = materializeSkills(data, "anti", "reg:antigravity-acp", project, [], relocatedEnv);
  expect([...effective.skills, ...effective.roomSkills].map((s) => s.name).sort()).toEqual(nativeNames);
});

test("BYOK load_skill rejects disabled imports, unchecked links, and unselected project files", () => {
  const project = cwd("byok");
  skill(join(data, "agents/byok/skills/imported"), "imported");
  skill(join(project, ".agents/skills/project-only"), "project-only");
  const linked = skill(join(root, "linked"), "linked");
  setSkillLinked(data, "byok", linked, true);
  expect(loadSkillBody(data, "byok", project, "imported")).toContain("PRIVATE BODY");
  expect(loadSkillBody(data, "byok", project, "linked")).toContain("PRIVATE BODY");
  setSkillEnabled(data, "byok", "imported", false);
  setSkillLinked(data, "byok", linked, false);
  for (const name of ["imported", "linked", "project-only"])
    expect(() => loadSkillBody(data, "byok", project, name)).toThrow("未启用");
  expect(materializeSkills(data, "byok", "custom", project, [], env).roomSkills).toEqual([]);
});

test("unchecking one realpath alias removes duplicate Agent grants", () => {
  const source = skill(join(root, "alias-source"), "alias-choice");
  const alias = join(root, "alias");
  symlinkSync(source, alias);
  setSkillLinked(data, "aliases", source, true);
  setSkillLinked(data, "aliases", alias, true);
  setSkillLinked(data, "aliases", source, false);
  expect(discoverSkills(data, "aliases", "custom", null, env).filter((s) => s.enabled)).toEqual([]);
  expect(() => loadSkillBody(data, "aliases", root, "alias-choice")).toThrow();
});
