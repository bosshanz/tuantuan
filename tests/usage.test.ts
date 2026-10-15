import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The adapter's own renderer, so the parser is checked against real `/usage` output.
import { formatUsageResponse } from "@agentclientprotocol/claude-agent-acp/dist/usage-markdown.js";
import { claudeLocalUsage, codexLocalUsage, parseClaudeUsageMarkdown, parseCodexStatusMarkdown } from "../server/usage";

const home = mkdtempSync(join(tmpdir(), "usage-home-"));
process.env.TUANTUAN_USAGE_HOME = home;
afterAll(() => delete process.env.TUANTUAN_USAGE_HOME);
const now = new Date();
const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n{"partial":`;

describe("local logs (read-only fixtures)", () => {
  test("no logs: null (honest not-available)", () => {
    expect(claudeLocalUsage(now)).toBeNull();
    expect(codexLocalUsage(now)).toBeNull();
  });

  test("Claude Code ~/.claude/projects JSONL, ccusage-style dedupe", () => {
    const d = join(home, ".claude", "projects", "-work-app");
    mkdirSync(d, { recursive: true });
    const msg = (id: string, req: string, at: string, u: Record<string, number>) => ({
      type: "assistant",
      timestamp: at,
      requestId: req,
      message: { id, usage: u },
    });
    const u1 = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 };
    writeFileSync(
      join(d, "s1.jsonl"),
      jsonl([
        { type: "user", timestamp: iso(1000), message: { content: "hi" } },
        msg("m1", "r1", iso(1000), u1),
        msg("m1", "r1", iso(1000), u1), // streamed twice: counted once
        msg("m2", "r2", iso(3 * 86_400_000), { input_tokens: 7, output_tokens: 3 }),
        msg("m3", "r3", iso(9 * 86_400_000), { input_tokens: 999, output_tokens: 999 }), // older than 7 days
      ]),
    );
    const r = claudeLocalUsage(now);
    expect(r?.today).toEqual({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 10, total: 1160 });
    expect(r?.week.total).toBe(1170);
  });

  test("Codex ~/.codex/sessions rollout token_count + rate_limits", () => {
    const d = join(home, ".codex", "sessions", "2026", "10", "15");
    mkdirSync(d, { recursive: true });
    const tc = (at: string, last: Record<string, number>, rl: unknown) => ({
      timestamp: at,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: last, last_token_usage: last }, rate_limits: rl },
    });
    const resets = Math.floor(now.getTime() / 1000) + 3600;
    writeFileSync(
      join(d, "rollout-a.jsonl"),
      jsonl([
        { timestamp: iso(5000), type: "response_item", payload: { type: "message" } },
        tc(
          iso(5000),
          { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300, total_tokens: 1500 },
          {
            primary: { used_percent: 10, window_minutes: 300, resets_at: resets - 60 },
          },
        ),
        tc(
          iso(2000),
          { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, total_tokens: 120 },
          {
            primary: { used_percent: 42.5, window_minutes: 300, resets_at: resets },
            secondary: { used_percent: 7, window_minutes: 10080, resets_in_seconds: 86400 },
            plan_type: "plus",
          },
        ),
        tc(iso(1000), { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 }, null),
      ]),
    );
    const r = codexLocalUsage(now);
    expect(r?.today).toEqual({ input: 1101, output: 321, cacheRead: 200, cacheWrite: 0, total: 1622 });
    expect(r?.plan).toBe("plus");
    expect(r?.limits).toEqual([
      { label: "5 小时", usedPercent: 42.5, resetsAt: new Date(resets * 1000).toISOString() },
      { label: "每周", usedPercent: 7, resetsAt: expect.any(String) },
    ]);
  });
});

describe("harness live replies", () => {
  test("claude-agent-acp /usage Markdown (rendered by the adapter itself)", () => {
    const md = formatUsageResponse({
      session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, model_usage: {} },
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-10-15T09:00:00Z" },
        seven_day: { utilization: 13, resets_at: "2026-10-20T00:00:00Z" },
      },
      behaviors: null,
    } as never);
    const r = parseClaudeUsageMarkdown(md);
    expect(r.limits.map((l) => [l.label, l.usedPercent])).toEqual([
      ["5 小时", 42],
      ["每周（全部模型）", 13],
    ]);
    expect(r.limits[0]?.resetsAt).toBeTruthy();
    expect(r.plan).toBeTruthy();
  });

  test("claude /usage with only an API key: no limits", () => {
    const md = formatUsageResponse({
      session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, model_usage: {} },
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      behaviors: null,
    } as never);
    expect(parseClaudeUsageMarkdown(md).limits).toEqual([]);
  });

  test("codex-acp /status Markdown", () => {
    const md = [
      "**Model:** gpt-6.1-sol",
      "**Account:** ChatGPT Plus (a@b.c)",
      "**codex 5h limit:** 58% left (resets 14:00)",
      "**codex Weekly limit:** 91% left (resets 10/20 09:00)",
    ].join("\n");
    const r = parseCodexStatusMarkdown(md);
    expect(r.limits).toEqual([
      { label: "5 小时", usedPercent: 42, resetsAt: "14:00" },
      { label: "每周", usedPercent: 9, resetsAt: "10/20 09:00" },
    ]);
    expect(r.account).toBe("ChatGPT Plus (a@b.c)");
    expect(parseCodexStatusMarkdown("**Limits:** data not available yet").limits).toEqual([]);
  });
});
