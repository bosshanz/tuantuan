import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importSkills,
  listAgentSkills,
  listRoomSkills,
  loadSkillBody,
  materializeSkills,
  parseSkillMd,
  setSkillEnabled,
} from "../server/skills";

describe("skills", () => {
  test("parses SKILL.md frontmatter", () => {
    const p = parseSkillMd(`---\nname: demo\ndescription: A demo skill\n---\n\nDo the thing.\n`);
    expect(p).toEqual({ name: "demo", description: "A demo skill", body: "Do the thing." });
    expect(parseSkillMd("no frontmatter")).toBeNull();
  });

  test("import, enable/disable, materialize per harness, room discovery", () => {
    const data = mkdtempSync(join(tmpdir(), "sk-data-"));
    const src = mkdtempSync(join(tmpdir(), "sk-src-"));
    const skill = join(src, ".agents", "skills", "greet");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), `---\nname: greet\ndescription: Say hi\n---\n\nHello!\n`);
    const agentId = "a1";
    const list = importSkills(data, agentId, src);
    expect(list.map((s) => s.name)).toContain("greet");

    setSkillEnabled(data, agentId, "greet", false);
    expect(listAgentSkills(data, agentId).find((s) => s.name === "greet")?.enabled).toBe(false);
    setSkillEnabled(data, agentId, "greet", true);

    const cwd = mkdtempSync(join(tmpdir(), "sk-cwd-"));
    const roomSkill = join(cwd, ".claude", "skills", "roomy");
    mkdirSync(roomSkill, { recursive: true });
    writeFileSync(join(roomSkill, "SKILL.md"), `---\nname: roomy\ndescription: From room\n---\n\nRoom body\n`);
    expect(listRoomSkills(cwd).map((s) => s.name)).toContain("roomy");

    for (const h of ["claude-code", "codex", "opencode", "custom"]) {
      const m = materializeSkills(data, agentId, h, cwd);
      expect(m.skills.some((s) => s.name === "greet")).toBe(true);
      expect(m.env).toEqual({});
    }
    expect(existsSync(join(cwd, ".claude", "skills", "greet", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".agents", "skills", "greet", "SKILL.md"))).toBe(true);
    // an existing name is never overwritten
    mkdirSync(join(cwd, ".agents", "skills", "taken"), { recursive: true });
    // OpenCode / custom link into cwd .agents/skills without clobbering roomy
    expect(listRoomSkills(cwd).find((s) => s.name === "roomy")).toBeTruthy();
    expect(loadSkillBody(data, agentId, cwd, "greet")).toContain("Hello!");
  });
});
