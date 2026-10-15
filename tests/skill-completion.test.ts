import { describe, expect, test } from "bun:test";
import { insertSkill, matchingSkills, skillTokenAt } from "../web/src/skillCompletion";

describe("composer skill completion", () => {
  const skills = Array.from({ length: 30 }, (_, index) => ({
    name: `tool-${String(index + 1).padStart(2, "0")}`,
    description: index === 26 ? "处理中文文档" : `Skill ${index + 1}`,
  }));

  test("an empty dollar query exposes every skill, including those after the twelfth entry", () => {
    const results = matchingSkills(skills, "");
    expect(results).toHaveLength(30);
    expect(results[29]?.name).toBe("tool-30");
    expect(matchingSkills(skills, "27").map((s) => s.name)).toEqual(["tool-27"]);
  });

  test("finds name fragments, plugin namespaces and descriptions without case sensitivity", () => {
    const all = [...skills, { name: "plugin:deep-search", description: "Research" }];
    expect(matchingSkills(all, "DEEP").map((s) => s.name)).toEqual(["plugin:deep-search"]);
    expect(matchingSkills(all, "中文").map((s) => s.name)).toEqual(["tool-27"]);
    expect(matchingSkills(all, "missing")).toEqual([]);
  });

  test("prefers exact and prefix names while keeping every matching result", () => {
    const all = [
      { name: "other", description: "Search docs" },
      { name: "plugin:search", description: "Namespaced" },
      { name: "search-docs", description: "Docs" },
      { name: "search", description: "Exact" },
    ];
    expect(matchingSkills(all, "search").map((s) => s.name)).toEqual([
      "search",
      "search-docs",
      "plugin:search",
      "other",
    ]);
  });

  test("deduplicates the same session skill name with its latest metadata", () => {
    expect(
      matchingSkills(
        [
          { name: "shared", description: "From project" },
          { name: "shared", description: "From harness" },
        ],
        "",
      ),
    ).toEqual([{ name: "shared", description: "From harness" }]);
  });

  test("completes a skill in prose while preserving the rest of the draft and cursor", () => {
    const draft = "请用 $doc 处理这份材料";
    const token = skillTokenAt(draft, "请用 $doc".length);
    expect(token).not.toBeNull();
    const next = insertSkill(draft, token as NonNullable<typeof token>, "documents");
    expect(next.value).toBe("请用 $documents 处理这份材料");
    expect(next.caret).toBe("请用 $documents ".length);
    expect(skillTokenAt("cost$doc", 8)).toBeNull();
    expect(skillTokenAt("$doc ", 5)).toBeNull();
  });

  test("replaces the whole token when the caret is inside its name", () => {
    const draft = "$doc-old 后文";
    const token = skillTokenAt(draft, 4);
    expect(insertSkill(draft, token as NonNullable<typeof token>, "documents")).toEqual({
      value: "$documents 后文",
      caret: "$documents ".length,
    });
    expect(insertSkill("$doc", skillTokenAt("$doc", 4) as NonNullable<typeof token>, "documents")).toEqual({
      value: "$documents ",
      caret: "$documents ".length,
    });
  });

  test("currency, escaped dollar signs and Markdown code do not trigger replacement", () => {
    for (const draft of [
      "价格 $100.00",
      "价格 $1,000",
      "\\$doc",
      "`echo $doc",
      "``echo $doc",
      "```sh\necho $doc",
      "~~~sh\necho $doc",
      "    echo $doc",
    ])
      expect(skillTokenAt(draft, draft.length)).toBeNull();
    const draft = "`echo $old`\n```sh\necho $old\n```\n请用 $doc";
    expect(skillTokenAt(draft, draft.length)?.query).toBe("doc");
  });
});
