import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexProviderSet,
  PRESETS,
  type ProviderSecret,
  presetFor,
  providerAsCustom,
  providerBalance,
  providerEnv,
  providerSupports,
  publicProvider,
  readCcSwitch,
  testProvider,
} from "../server/providers";

const prov = (x: Partial<ProviderSecret> = {}): ProviderSecret => ({
  id: "p1",
  name: "DeepSeek",
  preset: "deepseek",
  anthropicBaseUrl: "https://api.deepseek.com/anthropic/",
  openaiBaseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-secret-1234567890",
  mgmtKey: "",
  model: "deepseek-v4-pro",
  smallModel: "deepseek-flash",
  wireApi: "chat",
  createdAt: 1,
  updatedAt: 1,
  ...x,
});

/** Mock of the four documented balance endpoints + /models, recording auth headers. */
const seen: { path: string; auth: string | null }[] = [];
const mock = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    seen.push({ path: u.pathname, auth: req.headers.get("authorization") });
    if (req.headers.get("authorization") !== "Bearer sk-secret-1234567890")
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (u.pathname === "/user/balance")
      return Response.json({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "42.50" }] });
    if (u.pathname === "/api/v1/credits") return Response.json({ data: { total_credits: 20, total_usage: 7.25 } });
    if (u.pathname === "/v1/users/me/balance") return Response.json({ data: { available_balance: 88.8 } });
    if (u.pathname === "/v1/user/info") return Response.json({ data: { totalBalance: "3.14" } });
    if (u.pathname.endsWith("/models")) return Response.json({ data: [{ id: "m" }] });
    return new Response("nope", { status: 404 });
  },
});
const base = `http://127.0.0.1:${mock.port}`;
afterAll(() => mock.stop(true));

describe("provider env injection (per process only)", () => {
  test("claude-code: ANTHROPIC_* set, conflicting inherited vars dropped", () => {
    const e = providerEnv(prov(), "claude-code", { ANTHROPIC_API_KEY: "user-key", ANTHROPIC_SMALL_FAST_MODEL: "x" });
    expect(e.set).toEqual({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-secret-1234567890",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
    });
    expect(e.unset).toContain("ANTHROPIC_API_KEY");
    expect(e.unset).toContain("ANTHROPIC_SMALL_FAST_MODEL");
    expect(e.unset).not.toContain("ANTHROPIC_BASE_URL");
  });

  test("codex: model merged into CODEX_CONFIG, developer_instructions kept, key never in env", () => {
    const p = prov({ openaiBaseUrl: "https://x/v1/", wireApi: "responses" });
    const e = providerEnv(p, "codex", { CODEX_CONFIG: JSON.stringify({ developer_instructions: "你是产品经理" }) });
    expect(JSON.parse(e.set.CODEX_CONFIG as string)).toEqual({
      developer_instructions: "你是产品经理",
      model: "deepseek-v4-pro",
    });
    expect(JSON.stringify(e.set)).not.toContain("sk-secret");
    expect(codexProviderSet(p)).toEqual({
      providerId: "openai",
      apiType: "openai",
      baseUrl: "https://x/v1",
      headers: { Authorization: "Bearer sk-secret-1234567890" },
    });
  });

  test("supports: codex needs the Responses API", () => {
    expect(providerSupports(prov(), "claude-code")).toBe(true);
    expect(providerSupports(prov(), "codex")).toBe(false);
    expect(providerSupports(prov({ wireApi: "responses" }), "codex")).toBe(true);
    expect(providerSupports(prov({ anthropicBaseUrl: "" }), "claude-code")).toBe(false);
    expect(providerSupports(prov(), "grok")).toBe(false);
    expect(providerSupports(prov(), "custom")).toBe(true);
  });

  test("BYOK mapping and masking", () => {
    expect(providerAsCustom(prov())).toMatchObject({ format: "openai-chat", baseUrl: "https://api.deepseek.com/v1" });
    expect(providerAsCustom(prov({ openaiBaseUrl: "" }))).toMatchObject({
      format: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic/v1",
    });
    const pub = publicProvider(prov());
    expect(JSON.stringify(pub)).not.toContain("sk-secret-1234567890");
    expect(pub.keyHint).toContain("7890");
    expect(pub.balance).toBe("deepseek");
  });

  test("every preset is usable by at least one harness", () => {
    for (const p of PRESETS.filter((x) => x.id !== "custom"))
      expect(["claude-code", "codex"].some((h) => providerSupports(p, h))).toBe(true);
    expect(presetFor("https://api.deepseek.com/anthropic")).toBe("deepseek");
    expect(presetFor("https://example.com")).toBe("custom");
  });
});

describe("test + balance against mock endpoints", () => {
  test("latency test hits /models with the key", async () => {
    const r = await testProvider(prov({ openaiBaseUrl: `${base}/v1` }));
    expect(r.ok).toBe(true);
    expect(typeof r.ms).toBe("number");
    const bad = await testProvider(prov({ openaiBaseUrl: `${base}/v1`, apiKey: "wrong" }));
    expect(bad).toMatchObject({ ok: false, status: 401, error: "Key 无效或没有权限" });
  });

  test.each([
    ["deepseek", [{ currency: "CNY", amount: 42.5 }], "/user/balance"],
    ["openrouter", [{ currency: "USD", amount: 12.75 }], "/api/v1/credits"],
    ["kimi", [{ currency: "CNY", amount: 88.8 }], "/v1/users/me/balance"],
    ["siliconflow", [{ currency: "CNY", amount: 3.14 }], "/v1/user/info"],
  ])("%s balance", async (preset, amounts, path) => {
    const b = await providerBalance(prov({ preset, openaiBaseUrl: `${base}/api/v1`, anthropicBaseUrl: "" }));
    expect(b.available).toBe(true);
    expect(b.amounts).toEqual(amounts);
    expect(b.source).toBe(`${base}${path}`);
    expect(seen.some((s) => s.path === path && s.auth === "Bearer sk-secret-1234567890")).toBe(true);
  });

  test("honest unavailable states", async () => {
    expect((await providerBalance(prov({ preset: "glm" }))).note).toBe("这个服务商没有公开的余额接口");
    const b = await providerBalance(prov({ openaiBaseUrl: `${base}/v1`, apiKey: "wrong" }));
    expect(b).toMatchObject({ available: false, note: "Key 无效" });
  });
});

describe("CC Switch import (read-only)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-"));
  afterAll(() => delete process.env.TUANTUAN_CCSWITCH_DIR);

  test("not present", () => {
    process.env.TUANTUAN_CCSWITCH_DIR = join(dir, "missing");
    expect(readCcSwitch()).toEqual({ found: false, source: null, entries: [] });
  });

  test("sqlite db (v3+) is opened read-only and left unchanged", () => {
    const d = join(dir, "db");
    mkdirSync(d);
    const file = join(d, "cc-switch.db");
    const db = new Database(file);
    db.run(
      "CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER, meta TEXT)",
    );
    const ins = db.prepare("INSERT INTO providers VALUES (?, ?, ?, ?, ?, '{}')");
    ins.run(
      "a",
      "claude",
      "Kimi",
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
          ANTHROPIC_AUTH_TOKEN: "sk-kimi",
          ANTHROPIC_MODEL: "kimi-k3",
        },
      }),
      1,
    );
    ins.run(
      "b",
      "codex",
      "OR",
      JSON.stringify({
        auth: { OPENAI_API_KEY: "sk-or" },
        config:
          'model_provider = "or"\nmodel = "gpt-x"\n[model_providers.or]\nbase_url = "https://openrouter.ai/api/v1"\nwire_api = "responses"\n',
      }),
      0,
    );
    ins.run("c", "gemini", "G", "{}", 0);
    ins.run("d", "claude", "官方登录", JSON.stringify({ env: {} }), 0);
    db.close();
    const before = readFileSync(file);
    process.env.TUANTUAN_CCSWITCH_DIR = d;
    const r = readCcSwitch();
    expect(r.found).toBe(true);
    expect(r.entries).toEqual([
      expect.objectContaining({
        key: "claude:a",
        name: "Kimi",
        anthropicBaseUrl: "https://api.moonshot.cn/anthropic",
        apiKey: "sk-kimi",
        model: "kimi-k3",
        current: true,
      }),
      expect.objectContaining({
        key: "codex:b",
        openaiBaseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or",
        model: "gpt-x",
        wireApi: "responses",
      }),
    ]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("legacy config.json", () => {
    const d = join(dir, "json");
    mkdirSync(d);
    writeFileSync(
      join(d, "config.json"),
      JSON.stringify({
        claude: {
          current: "x",
          providers: {
            x: {
              name: "智谱",
              settingsConfig: {
                env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic", ANTHROPIC_AUTH_TOKEN: "k" },
              },
            },
          },
        },
      }),
    );
    process.env.TUANTUAN_CCSWITCH_DIR = d;
    const r = readCcSwitch();
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ key: "claude:x", name: "智谱", current: true });
    expect(presetFor(r.entries[0]?.anthropicBaseUrl ?? "")).toBe("glm");
  });
});
