import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSecret } from "../server/providers";
import { providerBalance } from "../server/providers";
import { grokLocalUsage, parseGrokBilling } from "../server/usage";

describe("Grok ACP billing", () => {
  test("reads the current weekly allowance and subscription returned by Grok 1.0.52", () => {
    expect(
      parseGrokBilling({
        config: {
          creditUsagePercent: 10,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-10-22T01:23:11.236248+00:00" },
          prepaidBalance: { val: 0 },
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
        },
        subscription_tier: "SuperGrok",
      }),
    ).toEqual({
      limits: [{ label: "每周额度", usedPercent: 10, resetsAt: "2026-10-22T01:23:11.236248+00:00" }],
      plan: "SuperGrok",
      creditBalanceUsd: 0,
    });
  });

  test("legacy monthly credits, on-demand cap and purchased credits keep their units", () => {
    expect(
      parseGrokBilling({
        config: {
          monthlyLimit: { val: 10000 },
          used: { val: 2500 },
          onDemandCap: { val: 2000 },
          onDemandUsed: { val: 500 },
          prepaidBalance: { val: 1250 },
          billingPeriodEnd: "2026-11-01T00:00:00Z",
        },
      }),
    ).toEqual({
      limits: [
        { label: "每月额度", usedPercent: 25, resetsAt: "2026-11-01T00:00:00Z" },
        { label: "按需消费上限", usedPercent: 25, resetsAt: null },
      ],
      plan: null,
      creditBalanceUsd: 12.5,
    });
  });

  test("current usage takes precedence; disabled on-demand and absent or malformed data remain unknown", () => {
    expect(
      parseGrokBilling({ config: { creditUsagePercent: 0, monthlyLimit: { val: 100 }, used: { val: 99 } } }).limits[0]
        ?.usedPercent,
    ).toBe(0);
    expect(
      parseGrokBilling({
        config: { onDemandCap: { val: 100 }, onDemandUsed: {}, prepaidBalance: {} },
        on_demand_enabled: false,
      }),
    ).toEqual({ limits: [], plan: null, creditBalanceUsd: 0 });
    for (const config of [
      null,
      {},
      { monthlyLimit: {}, used: {} },
      { creditUsagePercent: "10", prepaidBalance: { val: "0" } },
      { creditUsagePercent: Number.NaN, prepaidBalance: { val: -1 } },
    ])
      expect(parseGrokBilling({ config })).toEqual({ limits: [], plan: null, creditBalanceUsd: null });
    expect(parseGrokBilling(null)).toEqual({ limits: [], plan: null, creditBalanceUsd: null });
  });
});

const xai = (x: Partial<ProviderSecret> = {}): ProviderSecret => ({
  id: "x",
  name: "xAI",
  preset: "xai",
  anthropicBaseUrl: "",
  openaiBaseUrl: "https://api.x.ai/v1",
  apiKey: "xai-inference",
  mgmtKey: "",
  model: "",
  smallModel: "",
  wireApi: "responses",
  createdAt: 1,
  updatedAt: 1,
  ...x,
});

describe("xAI balance (documented /v1/api-key + Management API prepaid balance)", () => {
  const seen: string[] = [];
  let teamBlocked = false;
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const auth = req.headers.get("authorization");
      seen.push(`${u.pathname} ${auth}`);
      if (u.pathname === "/v1/api-key") {
        if (auth !== "Bearer xai-inference") return Response.json({ code: "invalid-argument" }, { status: 400 });
        return Response.json({
          team_id: "team-1",
          api_key_blocked: false,
          api_key_disabled: false,
          team_blocked: teamBlocked,
        });
      }
      if (u.pathname === "/v1/billing/teams/team-1/prepaid/balance") {
        if (auth !== "Bearer xai-mgmt") return Response.json({}, { status: 401 });
        // Documented sign: purchases are negative, so -1250 cents = $12.50 available.
        return Response.json({
          changes: [
            { changeOrigin: "PURCHASE", amount: { val: "-2000" } },
            { changeOrigin: "SPEND", amount: { val: "750" } },
          ],
          total: { val: "-1250" },
        });
      }
      return new Response("", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${srv.port}/v1`;
  afterAll(() => srv.stop(true));

  test("with a Management key: prepaid balance in USD", async () => {
    const b = await providerBalance(xai({ openaiBaseUrl: base, mgmtKey: "xai-mgmt" }));
    expect(b).toMatchObject({ available: true, amounts: [{ currency: "USD", amount: 12.5, label: "预付余额" }] });
    expect(seen).toContain("/v1/api-key Bearer xai-inference");
    expect(seen).toContain("/v1/billing/teams/team-1/prepaid/balance Bearer xai-mgmt");
  });

  test("honest states: no Management key, bad keys, blocked team", async () => {
    expect((await providerBalance(xai({ openaiBaseUrl: base }))).note).toBe("Key 正常。查余额需要填写 Management Key");
    expect((await providerBalance(xai({ openaiBaseUrl: base, apiKey: "bad" }))).note).toBe("Key 无效");
    expect((await providerBalance(xai({ openaiBaseUrl: base, mgmtKey: "bad" }))).note).toBe(
      "Management Key 无效或没有权限",
    );
    teamBlocked = true;
    expect((await providerBalance(xai({ openaiBaseUrl: base, mgmtKey: "xai-mgmt" }))).note).toBe(
      "团队已被停用（可能欠费）",
    );
  });
});

describe("Grok local usage via `grok usage <session-id>`", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-home-"));
  const prev = process.env.TUANTUAN_USAGE_HOME;
  afterAll(() => {
    if (prev === undefined) delete process.env.TUANTUAN_USAGE_HOME;
    else process.env.TUANTUAN_USAGE_HOME = prev;
  });

  test("no ~/.grok/sessions: null", async () => {
    process.env.TUANTUAN_USAGE_HOME = home;
    expect(await grokLocalUsage("/bin/false")).toBeNull();
  });

  test("sums turns from the CLI's JSON (real output captured from grok 1.0.52)", async () => {
    process.env.TUANTUAN_USAGE_HOME = home;
    const real = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "grok-usage.json"), "utf8"));
    const now = new Date();
    const sessions = join(home, ".grok", "sessions", "%2Fwork");
    const a = "01a13d37-9bd8-7672-97ce-4c27e230203f";
    const b = "01a13d37-0000-7000-8000-000000000002";
    const old = "01a13d37-0000-7000-8000-000000000003";
    for (const id of [a, b, old]) mkdirSync(join(sessions, id), { recursive: true });
    const tenDaysAgo = (now.getTime() - 10 * 86_400_000) / 1000;
    utimesSync(join(sessions, old), tenDaysAgo, tenDaysAgo);
    const out = join(home, "out");
    mkdirSync(out);
    const turn = (endedAt: string, total: number) => ({
      ...real.turns[0],
      endedAt,
      totalTokens: total,
      costUsdTicks: 5e8,
    });
    writeFileSync(
      join(out, a),
      JSON.stringify({ ...real, turns: real.turns.map((t: object) => ({ ...t, endedAt: now.toISOString() })) }),
    );
    writeFileSync(
      join(out, b),
      JSON.stringify({
        ...real,
        sessionId: b,
        turns: [turn(now.toISOString(), 100), turn(new Date(now.getTime() - 3 * 86_400_000).toISOString(), 1000)],
      }),
    );
    const bin = join(home, "grok");
    // Fake CLI: prints the recorded JSON; unknown session → exit 1 like the real one.
    writeFileSync(
      bin,
      `#!/bin/sh\n[ "$1" = usage ] || exit 2\n[ -f "${out}/$2" ] || { echo "Error: No usage recorded" >&2; exit 1; }\ncat "${out}/$2"\n`,
    );
    chmodSync(bin, 0o755);
    const r = await grokLocalUsage(bin, now);
    expect(r?.sessions).toBe(2);
    expect(r?.today.total).toBe(1290 + 100);
    expect(r?.today.cacheRead).toBe(2000);
    expect(r?.today.output).toBe(112);
    expect(r?.week.total).toBe(1290 + 100 + 1000);
    expect(r?.costToday).toBeCloseTo(0.05);
  });

  const realGrok = join(homedir(), ".grok", "bin", "grok");
  test.skipIf(!existsSync(realGrok))(
    "real grok CLI against a mock model endpoint",
    async () => {
      const h = mkdtempSync(join(tmpdir(), "grok-real-"));
      const cwd = join(h, "cwd");
      mkdirSync(join(h, ".grok"), { recursive: true });
      mkdirSync(cwd);
      const srv = Bun.serve({
        port: 0,
        async fetch(req) {
          const u = new URL(req.url);
          const body = (await req.json().catch(() => ({}))) as { model?: string; stream?: boolean };
          if (!u.pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
          const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: body.model };
          if (!body.stream)
            return Response.json({
              ...base,
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
          const d = (x: object) => `data: ${JSON.stringify({ ...base, ...x })}\n\n`;
          return new Response(
            d({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }) +
              d({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
              d({
                choices: [],
                usage: {
                  prompt_tokens: 700,
                  completion_tokens: 30,
                  total_tokens: 730,
                  prompt_tokens_details: { cached_tokens: 500 },
                },
              }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      writeFileSync(
        join(h, ".grok", "config.toml"),
        `[models]\ndefault = "mock"\n[model.mock]\nmodel = "mock-model"\nbase_url = "http://127.0.0.1:${srv.port}/v1"\napi_key = "sk-mock"\ncontext_window = 128000\n`,
      );
      try {
        const p = Bun.spawn([realGrok, "-p", "hi", "--output-format", "json"], {
          cwd,
          env: { ...process.env, HOME: h },
          stdout: "pipe",
          stderr: "ignore",
        });
        expect(await p.exited).toBe(0);
        process.env.TUANTUAN_USAGE_HOME = h;
        const r = await grokLocalUsage(realGrok);
        expect(r?.sessions).toBe(1);
        expect(r?.today.total).toBeGreaterThanOrEqual(730);
        expect(r?.today.cacheRead).toBeGreaterThanOrEqual(500);
      } finally {
        srv.stop(true);
      }
    },
    { timeout: 60_000 },
  );
});
