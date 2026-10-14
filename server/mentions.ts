export interface Mentionable {
  id: string;
  name: string;
}

/**
 * Finds `@Name` mentions of known agents, longest name first so "@Code Reviewer"
 * wins over "@Code". Mentions inside fenced code blocks, inline code, quoted lines
 * ("> ...") and echoed transcript lines ("[Andy]: ...") are ignored: quoting a message
 * that @s someone is not a request to that agent.
 * Returns ids in first-mention order without duplicates.
 */
export function parseMentions(text: string, candidates: Mentionable[]): string[] {
  const clean = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    .replace(/^[ \t]*\[[^\]\n]{1,64}\][:：].*$/gm, " ");
  const sorted = [...candidates].sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];
  for (let i = clean.indexOf("@"); i >= 0; i = clean.indexOf("@", i + 1)) {
    const prev = clean[i - 1];
    if (prev && /[\w.]/.test(prev)) continue; // e.g. emails: a@b.com
    const rest = clean.slice(i + 1);
    const hit = sorted.find((c) => {
      if (!rest.toLowerCase().startsWith(c.name.toLowerCase())) return false;
      const next = rest[c.name.length];
      // CJK text has no spaces, so "@小明你好" must still match 小明; latin names need a boundary.
      if (next === undefined || /[\u4e00-\u9fff]$/.test(c.name)) return true;
      return !/[\w\u4e00-\u9fff-]/.test(next);
    });
    if (hit && !found.includes(hit.id)) found.push(hit.id);
  }
  return found;
}
