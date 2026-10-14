import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, parseSkill, skillCatalogPrompt } from "../server/skills";

function makeSkillsDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  for (const [dir, content] of Object.entries(files)) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, "SKILL.md"), content);
  }
  return root;
}

describe("skills", () => {
  test("parses frontmatter and body", () => {
    const s = parseSkill('---\nname: demo\ndescription: "做演示: 带冒号"\n---\n# Body\n正文', "/x");
    expect(s).toEqual({ name: "demo", description: "做演示: 带冒号", body: "# Body\n正文", dir: "/x" });
  });

  test("loads valid skills and reports invalid ones instead of skipping silently", () => {
    const root = makeSkillsDir({
      good: "---\nname: good\ndescription: ok\n---\nbody",
      nofront: "just text",
      noname: "---\ndescription: d\n---\n",
      dup: "---\nname: good\ndescription: again\n---\n",
    });
    mkdirSync(join(root, "not-a-skill"));
    const r = loadSkills(root);
    expect(r.skills.map((s) => s.name)).toEqual(["good"]);
    expect(r.errors.map((e) => e.error).sort()).toEqual(
      ["frontmatter.name 缺失或非法（仅限字母数字_-）", "skill 名称重复: good", "缺少 YAML frontmatter"].sort(),
    );
  });

  test("missing dir is empty, not an error", () => {
    expect(loadSkills("/nonexistent/skills")).toEqual({ skills: [], errors: [] });
  });

  test("catalog exposes only names and descriptions (progressive disclosure)", () => {
    const p = skillCatalogPrompt([{ name: "a", description: "desc A", body: "SECRET BODY", dir: "" }]);
    expect(p).toContain("- a: desc A");
    expect(p).toContain("load_skill");
    expect(p).not.toContain("SECRET BODY");
  });

  test("repo sample skills load cleanly", () => {
    const r = loadSkills("skills");
    expect(r.errors).toEqual([]);
    expect(r.skills.length).toBeGreaterThanOrEqual(3);
  });
});
