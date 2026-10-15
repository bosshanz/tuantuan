import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Usage / quota from sources that are documented or directly observable:
 * - Claude Code: its own transcripts (~/.claude/projects/**.jsonl, the ccusage approach) for tokens;
 *   5h / weekly limits only from Claude Code's own `/usage` command output (subscription logins).
 * - Codex: its session logs (~/.codex/sessions/**​/rollout-*.jsonl) — `token_count` events carry
 *   token totals and `rate_limits` (primary / secondary windows); live via codex-acp `/status`.
 * Files are only read. No keychain / OAuth tokens are touched.
 */

export interface LimitWindow {
  label: string;
  /** Percent used, 0–100. */
  usedPercent: number;
  /** ISO time or the harness's own text. */
  resetsAt: string | null;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface HarnessUsage {
  harness: string;
  /** Tokens counted from local logs since local midnight. */
  today: TokenTotals | null;
  week: TokenTotals | null;
  limits: LimitWindow[];
  limitsAt: number | null;
  limitsSource: string | null;
  /** USD spent today, when the harness records prices (Grok's costUsdTicks). */
  costToday?: number | null;
  /** Why something is missing (honest "not available"). */
  notes: string[];
  plan: string | null;
}

const zero = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function home(): string {
  return process.env.TUANTUAN_USAGE_HOME || homedir();
}

function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Recent *.jsonl files under root (by mtime), bounded walk. */
function recentJsonl(root: string, since: number, depth = 5, out: string[] = []): string[] {
  if (depth < 0 || !existsSync(root)) return out;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(root, n);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) recentJsonl(p, since, depth - 1, out);
    else if (n.endsWith(".jsonl") && st.mtimeMs >= since) out.push(p);
  }
  return out;
}

function eachLine(file: string, fn: (v: Record<string, unknown>) => void) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      fn(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // partial line while being written
    }
  }
}

/** ccusage-style: assistant messages' `message.usage`, de-duplicated by message id + request id. */
export function claudeLocalUsage(now = new Date()): { today: TokenTotals; week: TokenTotals; files: number } | null {
  const root = join(home(), ".claude", "projects");
  if (!existsSync(root)) return null;
  const day = startOfToday(now);
  const week = now.getTime() - 7 * 86_400_000;
  const files = recentJsonl(root, week);
  const seen = new Set<string>();
  const t = zero();
  const w = zero();
  for (const f of files)
    eachLine(f, (v) => {
      const msg = v.message as { id?: string; usage?: Record<string, number> } | undefined;
      const u = msg?.usage;
      if (!u || v.type !== "assistant") return;
      const at = Date.parse(String(v.timestamp ?? ""));
      if (!Number.isFinite(at) || at < week) return;
      const id = `${msg?.id ?? ""}:${v.requestId ?? ""}`;
      if (id !== ":" && seen.has(id)) return;
      seen.add(id);
      const add = (x: TokenTotals) => {
        x.input += u.input_tokens ?? 0;
        x.output += u.output_tokens ?? 0;
        x.cacheRead += u.cache_read_input_tokens ?? 0;
        x.cacheWrite += u.cache_creation_input_tokens ?? 0;
        x.total = x.input + x.output + x.cacheRead + x.cacheWrite;
      };
      add(w);
      if (at >= day) add(t);
    });
  return { today: t, week: w, files: files.length };
}

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number | string;
  resets_in_seconds?: number;
}

function windowLabel(mins: number | undefined, fallback: string): string {
  if (!mins) return fallback;
  if (mins < 60) return `${mins} 分钟`;
  if (mins < 1440) return `${Math.round(mins / 60)} 小时`;
  if (mins < 10080) return `${Math.round(mins / 1440)} 天`;
  return "每周";
}

/** Codex `token_count` events: per-turn tokens + the latest rate_limits snapshot. */
export function codexLocalUsage(now = new Date()): {
  today: TokenTotals;
  week: TokenTotals;
  limits: LimitWindow[];
  limitsAt: number | null;
  plan: string | null;
} | null {
  const root = join(home(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  const day = startOfToday(now);
  const week = now.getTime() - 7 * 86_400_000;
  const t = zero();
  const w = zero();
  let latest: { at: number; rl: Record<string, unknown> } | null = null;
  for (const f of recentJsonl(root, week))
    eachLine(f, (v) => {
      const pl = v.payload as Record<string, unknown> | undefined;
      if (v.type !== "event_msg" || pl?.type !== "token_count") return;
      const at = Date.parse(String(v.timestamp ?? ""));
      if (!Number.isFinite(at) || at < week) return;
      const last = (pl.info as { last_token_usage?: Record<string, number> } | null)?.last_token_usage;
      if (last) {
        const add = (x: TokenTotals) => {
          x.input += (last.input_tokens ?? 0) - (last.cached_input_tokens ?? 0);
          x.cacheRead += last.cached_input_tokens ?? 0;
          x.output += last.output_tokens ?? 0;
          x.total += last.total_tokens ?? 0;
        };
        add(w);
        if (at >= day) add(t);
      }
      const rl = pl.rate_limits as Record<string, unknown> | null | undefined;
      if (rl && (!latest || at >= latest.at)) latest = { at, rl };
    });
  const limits: LimitWindow[] = [];
  let plan: string | null = null;
  const snap = latest as { at: number; rl: Record<string, unknown> } | null;
  if (snap) {
    plan = typeof snap.rl.plan_type === "string" ? snap.rl.plan_type : null;
    for (const [k, fallback] of [
      ["primary", "短周期"],
      ["secondary", "长周期"],
    ] as const) {
      const x = snap.rl[k] as CodexWindow | null | undefined;
      if (!x || typeof x.used_percent !== "number") continue;
      let resetsAt: string | null = null;
      if (typeof x.resets_at === "number") resetsAt = new Date(x.resets_at * 1000).toISOString();
      else if (typeof x.resets_at === "string") resetsAt = x.resets_at;
      else if (typeof x.resets_in_seconds === "number")
        resetsAt = new Date(snap.at + x.resets_in_seconds * 1000).toISOString();
      limits.push({ label: windowLabel(x.window_minutes, fallback), usedPercent: x.used_percent, resetsAt });
    }
  }
  return { today: t, week: w, limits, limitsAt: snap?.at ?? null, plan };
}

/** Parse claude-agent-acp's `/usage` Markdown: "**5-hour limit** — **42%** · Resets …". */
export function parseClaudeUsageMarkdown(md: string): { limits: LimitWindow[]; plan: string | null } {
  const limits: LimitWindow[] = [];
  const re = /\*\*([^*]+?)\*\*\s+—\s+\*\*(\d+(?:\.\d+)?)%\*\*(?:\s+·\s+Resets\s+([^\n]+))?/g;
  for (const m of md.matchAll(re)) {
    const raw = (m[1] ?? "").replace(/\\/g, "");
    const label = raw
      .replace(/^5-hour limit$/i, "5 小时")
      .replace(/^Weekly · all models$/i, "每周（全部模型）")
      .replace(/^Weekly · /i, "每周 · ");
    limits.push({ label, usedPercent: Number(m[2]), resetsAt: m[3]?.trim() ?? null });
  }
  const plan = /> Claude (.+?) subscription usage/.exec(md)?.[1] ?? null;
  return { limits, plan };
}

/** Parse codex-acp's `/status` Markdown: "**5h limit:** 58% left (resets 14:00)". */
export function parseCodexStatusMarkdown(md: string): { limits: LimitWindow[]; account: string | null } {
  const limits: LimitWindow[] = [];
  const re = /\*\*([^*:]*?(?:limit|Limit)):\*\*\s+(\d+(?:\.\d+)?)% left(?:\s+\(resets ([^)]+)\))?/g;
  for (const m of md.matchAll(re)) {
    const label = (m[1] ?? "")
      .replace(/^codex\s+/i, "")
      .replace(/(\d+)h limit/, "$1 小时")
      .replace(/(\d+)d limit/, "$1 天")
      .replace(/weekly limit/i, "每周")
      .replace(/(\d+)m limit/, "$1 分钟");
    limits.push({ label, usedPercent: 100 - Number(m[2]), resetsAt: m[3] ?? null });
  }
  const account = /\*\*Account:\*\*\s*([^\n]+)/.exec(md)?.[1]?.trim() ?? null;
  return { limits, account };
}

/**
 * Grok Build: per-turn token (and cost) totals via the documented `grok usage <session-id>` command
 * ("use this instead of reading session files"). Session ids come from the directory names under
 * ~/.grok/sessions/<cwd>/; only sessions touched in the last 7 days are queried.
 */
export async function grokLocalUsage(
  bin: string,
  now = new Date(),
): Promise<{ today: TokenTotals; week: TokenTotals; costToday: number | null; sessions: number } | null> {
  const root = join(home(), ".grok", "sessions");
  if (!existsSync(root)) return null;
  const day = startOfToday(now);
  const week = now.getTime() - 7 * 86_400_000;
  const ids: string[] = [];
  for (const cwd of readdirSafe(root)) {
    const dir = join(root, cwd);
    for (const id of readdirSafe(dir)) {
      if (!/^[0-9a-f-]{20,}$/i.test(id)) continue;
      try {
        const st = statSync(join(dir, id));
        if (st.isDirectory() && st.mtimeMs >= week) ids.push(id);
      } catch {
        // vanished
      }
    }
  }
  const t = zero();
  const w = zero();
  let cost: number | null = null;
  const env = { ...process.env, ...(process.env.TUANTUAN_USAGE_HOME ? { HOME: home() } : {}) };
  const one = async (id: string) => {
    try {
      const p = Bun.spawn([bin, "usage", id], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env });
      const timer = setTimeout(() => p.kill(), 10_000);
      const out = await new Response(p.stdout).text();
      clearTimeout(timer);
      if ((await p.exited) !== 0) return; // "No usage recorded" etc.
      const v = JSON.parse(out) as { turns?: Record<string, unknown>[] };
      for (const turn of v.turns ?? []) {
        const at = Date.parse(String(turn.endedAt ?? ""));
        if (!Number.isFinite(at) || at < week) continue;
        const n = (k: string) => (typeof turn[k] === "number" ? (turn[k] as number) : 0);
        const add = (x: TokenTotals) => {
          x.input += n("inputTokens") - n("cachedReadTokens");
          x.cacheRead += n("cachedReadTokens");
          x.cacheWrite += n("cacheCreationTokens");
          x.output += n("outputTokens");
          x.total += n("totalTokens");
        };
        add(w);
        if (at >= day) {
          add(t);
          if (typeof turn.costUsdTicks === "number") cost = (cost ?? 0) + turn.costUsdTicks / 1e10;
        }
      }
    } catch {
      // unreadable output: skip this session
    }
  };
  const queue = ids.slice(0, 200);
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await one(id);
    }),
  );
  return { today: t, week: w, costToday: cost, sessions: ids.length };
}

function readdirSafe(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}
