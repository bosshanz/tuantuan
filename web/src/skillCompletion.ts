export interface SkillChoice {
  name: string;
  description: string;
}

export interface SkillToken {
  query: string;
  start: number;
  end: number;
}

/** A skill token can appear at the start or after whitespace, including in the middle of a draft. */
export function skillTokenAt(value: string, caret: number): SkillToken | null {
  const before = value.slice(0, caret);
  const match = /(?:^|\s)\$([^\s$]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  if (/^\d[\d,.]*$/.test(query) || inCode(before)) return null;
  return {
    query,
    start: caret - query.length - 1,
    end: caret + (/^[^\s$]*/.exec(value.slice(caret))?.[0].length ?? 0),
  };
}

function inCode(before: string): boolean {
  let fence = "";
  let inlineTicks = 0;
  const lines = before.split("\n");
  for (const line of lines) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const run = marker?.[1] ?? "";
    if (fence) {
      if (run[0] === fence[0] && run.length >= fence.length && !marker?.[2]?.trim()) fence = "";
      continue;
    }
    if (run && inlineTicks === 0) {
      fence = run;
      continue;
    }
    for (const ticks of line.matchAll(/\\`|`+/g)) {
      if (ticks[0] === "\\`") continue;
      if (inlineTicks === 0) inlineTicks = ticks[0].length;
      else if (inlineTicks === ticks[0].length) inlineTicks = 0;
    }
  }
  return !!fence || inlineTicks > 0 || /^(?: {4}|\t)/.test(lines.at(-1) ?? "");
}

/** All matches remain reachable; prefer exact / prefix names before name fragments and descriptions. */
export function matchingSkills(skills: SkillChoice[], query: string): SkillChoice[] {
  const q = query.toLowerCase();
  const unique = [...new Map(skills.map((skill) => [skill.name, skill])).values()];
  if (!q) return unique;
  const rank = (s: SkillChoice) => {
    const name = s.name.toLowerCase();
    return name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3;
  };
  return unique
    .filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b));
}

export function insertSkill(value: string, token: SkillToken, name: string): { value: string; caret: number } {
  const before = value.slice(0, token.start);
  const suffix = value.slice(token.end);
  const skill = `$${name}`;
  return {
    value: `${before}${skill}${/^\s/.test(suffix) ? "" : " "}${suffix}`,
    caret: before.length + skill.length + 1,
  };
}
