import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CustomFormat, maskKey } from "./custom";

/**
 * 服务商 (provider profiles): a reusable base URL + key + models, applied to an agent's harness
 * process only — Claude Code via ANTHROPIC_* env, Codex via ACP `providers/set` (+ model in CODEX_CONFIG),
 * BYOK directly. Never written to ~/.claude or ~/.codex. Presets follow CC Switch's list.
 */

export type BalanceKind = "deepseek" | "openrouter" | "kimi" | "siliconflow" | "xai";

export interface ProviderPreset {
  id: string;
  name: string;
  color: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  model: string;
  smallModel: string;
  wireApi: "responses" | "chat";
  balance: BalanceKind | null;
  keyUrl: string;
}

const p = (x: Partial<ProviderPreset> & Pick<ProviderPreset, "id" | "name" | "color">): ProviderPreset => ({
  anthropicBaseUrl: "",
  openaiBaseUrl: "",
  model: "",
  smallModel: "",
  wireApi: "chat",
  balance: null,
  keyUrl: "",
  ...x,
});

export const PRESETS: ProviderPreset[] = [
  p({
    id: "anthropic",
    name: "Anthropic API",
    color: "#d97757",
    anthropicBaseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
  }),
  p({
    id: "openai",
    name: "OpenAI API",
    color: "#10a37f",
    openaiBaseUrl: "https://api.openai.com/v1",
    wireApi: "responses",
    keyUrl: "https://platform.openai.com/api-keys",
  }),
  p({
    id: "xai",
    name: "xAI Grok",
    color: "#0a0a0a",
    openaiBaseUrl: "https://api.x.ai/v1",
    model: "grok-4.6",
    wireApi: "responses",
    balance: "xai",
    keyUrl: "https://console.x.ai",
  }),
  p({
    id: "deepseek",
    name: "DeepSeek",
    color: "#4d6bfe",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    openaiBaseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-pro",
    smallModel: "deepseek-flash",
    balance: "deepseek",
    keyUrl: "https://platform.deepseek.com/api_keys",
  }),
  p({
    id: "kimi",
    name: "Kimi",
    color: "#111111",
    anthropicBaseUrl: "https://api.moonshot.cn/anthropic",
    openaiBaseUrl: "https://api.moonshot.cn/v1",
    balance: "kimi",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
  }),
  p({
    id: "glm",
    name: "智谱 GLM",
    color: "#3859ff",
    anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    openaiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3",
    smallModel: "glm-5.3",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  }),
  p({
    id: "qwen",
    name: "通义千问",
    color: "#615ced",
    anthropicBaseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    smallModel: "qwen3.8-flash",
    keyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  }),
  p({
    id: "minimax",
    name: "MiniMax",
    color: "#e2167e",
    anthropicBaseUrl: "https://api.minimax.cn/anthropic",
    openaiBaseUrl: "https://api.minimax.cn/v1",
    model: "MiniMax-M3",
    smallModel: "MiniMax-M3",
  }),
  p({
    id: "siliconflow",
    name: "硅基流动",
    color: "#7c3aed",
    anthropicBaseUrl: "https://api.siliconflow.cn",
    openaiBaseUrl: "https://api.siliconflow.cn/v1",
    balance: "siliconflow",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  }),
  p({
    id: "openrouter",
    name: "OpenRouter",
    color: "#6467f2",
    anthropicBaseUrl: "https://openrouter.ai/api",
    openaiBaseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-5",
    smallModel: "anthropic/claude-haiku-4.5",
    wireApi: "responses",
    balance: "openrouter",
    keyUrl: "https://openrouter.ai/keys",
  }),
  p({ id: "custom", name: "自定义", color: "#6b7280" }),
];

export interface ProviderSecret {
  id: string;
  name: string;
  preset: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  apiKey: string;
  /** xAI only: Management API key (console.x.ai → Settings → Management Keys), for the prepaid balance. */
  mgmtKey: string;
  model: string;
  smallModel: string;
  wireApi: "responses" | "chat";
  createdAt: number;
  updatedAt: number;
}

export type Provider = Omit<ProviderSecret, "apiKey" | "mgmtKey"> & {
  keyHint: string;
  mgmtKeyHint: string;
  color: string;
  balance: BalanceKind | null;
};

export function publicProvider(s: ProviderSecret): Provider {
  const { apiKey, mgmtKey, ...rest } = s;
  const preset = PRESETS.find((x) => x.id === s.preset);
  return {
    ...rest,
    keyHint: maskKey(apiKey),
    mgmtKeyHint: mgmtKey ? maskKey(mgmtKey) : "",
    color: preset?.color ?? "#6b7280",
    balance: preset?.balance ?? null,
  };
}

/** Harnesses a profile can drive. */
export function providerSupports(
  s: Pick<ProviderSecret, "anthropicBaseUrl" | "openaiBaseUrl" | "wireApi">,
  harness: string,
) {
  if (harness === "claude-code") return !!s.anthropicBaseUrl;
  // codex-acp's provider slot speaks the Responses API only
  if (harness === "codex") return !!s.openaiBaseUrl && s.wireApi === "responses";
  if (harness === "custom") return !!(s.anthropicBaseUrl || s.openaiBaseUrl);
  return false;
}

const ANTHROPIC_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
];

/**
 * Env changes for one harness process. Returns the vars to set and the ones to drop (inherited
 * provider vars that would otherwise win). Only affects that child process.
 */
export function providerEnv(
  s: ProviderSecret,
  harness: string,
  baseEnv: Record<string, string>,
): { set: Record<string, string>; unset: string[] } {
  if (harness === "claude-code") {
    const set: Record<string, string> = {
      ANTHROPIC_BASE_URL: s.anthropicBaseUrl.replace(/\/+$/, ""),
      ANTHROPIC_AUTH_TOKEN: s.apiKey,
    };
    if (s.model) {
      set.ANTHROPIC_MODEL = s.model;
      set.ANTHROPIC_DEFAULT_SONNET_MODEL = s.model;
      set.ANTHROPIC_DEFAULT_OPUS_MODEL = s.model;
    }
    if (s.smallModel || s.model) set.ANTHROPIC_DEFAULT_HAIKU_MODEL = s.smallModel || s.model;
    return { set, unset: ANTHROPIC_VARS.filter((k) => !(k in set)) };
  }
  if (harness === "codex") {
    // Routing goes through ACP `providers/set` (see codexProviderSet); only the model rides on
    // CODEX_CONFIG, merged so developer_instructions survive.
    let prev: Record<string, unknown> = {};
    try {
      prev = baseEnv.CODEX_CONFIG ? (JSON.parse(baseEnv.CODEX_CONFIG) as Record<string, unknown>) : {};
    } catch {
      prev = {};
    }
    if (!s.model) return { set: {}, unset: ["MODEL_PROVIDER"] };
    return { set: { CODEX_CONFIG: JSON.stringify({ ...prev, model: s.model }) }, unset: ["MODEL_PROVIDER"] };
  }
  return { set: {}, unset: [] };
}

/**
 * Claude Code applies `env` from ~/.claude/settings.json *after* the process env, so a user's own
 * ANTHROPIC_BASE_URL / ANTHROPIC_MODEL there (e.g. written by CC Switch) would beat ours. The
 * adapter's `_meta.claudeCode.options.settings` is the programmatic tier, above user / project /
 * local settings, and lives only in this session: nothing is written to disk.
 */
export function claudeSettingsOverride(s: ProviderSecret): { apiKeyHelper: string; env: Record<string, string> } {
  const { set } = providerEnv(s, "claude-code", {});
  return { apiKeyHelper: "", env: { ...set, ANTHROPIC_API_KEY: "" } };
}

/**
 * ACP `providers/set` payload for codex-acp. Codex's own custom-provider config still demands an
 * OpenAI login; the ACP gateway slot does not, and keeps the key in this process's memory only.
 * codex-acp supports the Responses API only.
 */
export function codexProviderSet(s: ProviderSecret) {
  return {
    providerId: "openai",
    apiType: "openai",
    baseUrl: s.openaiBaseUrl.replace(/\/+$/, ""),
    headers: { Authorization: `Bearer ${s.apiKey}` },
  };
}

/** BYOK settings from a profile (anthropic endpoint preferred when present). */
export function providerAsCustom(s: ProviderSecret): {
  format: CustomFormat;
  baseUrl: string;
  model: string;
  apiKey: string;
} {
  if (s.openaiBaseUrl)
    return { format: "openai-chat", baseUrl: s.openaiBaseUrl.replace(/\/+$/, ""), model: s.model, apiKey: s.apiKey };
  return {
    format: "anthropic",
    baseUrl: `${s.anthropicBaseUrl.replace(/\/+$/, "")}/v1`,
    model: s.model,
    apiKey: s.apiKey,
  };
}

// ---------------------------------------------------------------------------------------------
// Connectivity / latency

export interface ProviderTest {
  ok: boolean;
  ms: number | null;
  status: number | null;
  endpoint: string;
  error: string | null;
}

async function timed(url: string, headers: Record<string, string>): Promise<ProviderTest> {
  const t = performance.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const ms = Math.round(performance.now() - t);
    const ok = r.ok;
    let error: string | null = null;
    if (!ok) error = r.status === 401 || r.status === 403 ? "Key 无效或没有权限" : `HTTP ${r.status}`;
    return { ok, ms, status: r.status, endpoint: url, error };
  } catch (e) {
    return { ok: false, ms: null, status: null, endpoint: url, error: (e as Error).message };
  }
}

/** GET …/models with the key: proves reachability + auth and measures latency. */
export async function testProvider(s: ProviderSecret): Promise<ProviderTest> {
  if (s.openaiBaseUrl)
    return timed(`${s.openaiBaseUrl.replace(/\/+$/, "")}/models`, { authorization: `Bearer ${s.apiKey}` });
  if (s.anthropicBaseUrl)
    return timed(`${s.anthropicBaseUrl.replace(/\/+$/, "")}/v1/models`, {
      "x-api-key": s.apiKey,
      authorization: `Bearer ${s.apiKey}`,
      "anthropic-version": "2023-06-01",
    });
  return { ok: false, ms: null, status: null, endpoint: "", error: "没有填写地址" };
}

// ---------------------------------------------------------------------------------------------
// Balance (public, documented endpoints only — same set CC Switch queries)

export interface Balance {
  available: boolean;
  /** e.g. [{ currency: "CNY", amount: 12.3 }] */
  amounts: { currency: string; amount: number; label?: string }[];
  note: string | null;
  source: string | null;
  at: number;
}

const origin = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

export async function providerBalance(s: ProviderSecret): Promise<Balance> {
  const kind = PRESETS.find((x) => x.id === s.preset)?.balance ?? null;
  const at = Date.now();
  const none = (note: string): Balance => ({ available: false, amounts: [], note, source: null, at });
  if (!kind) return none("这个服务商没有公开的余额接口");
  if (!s.apiKey) return none("没有 Key");
  const base = origin(s.openaiBaseUrl || s.anthropicBaseUrl);
  if (kind === "xai") return xaiBalance(s, base, at);
  const url =
    kind === "deepseek"
      ? `${base}/user/balance`
      : kind === "openrouter"
        ? `${base}/api/v1/credits`
        : kind === "kimi"
          ? `${base}/v1/users/me/balance`
          : `${base}/v1/user/info`;
  let body: Record<string, unknown>;
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${s.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ...none(r.status === 401 ? "Key 无效" : `HTTP ${r.status}`), source: url };
    body = (await r.json()) as Record<string, unknown>;
  } catch (e) {
    return { ...none((e as Error).message), source: url };
  }
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : Number.NaN);
  const amounts: Balance["amounts"] = [];
  if (kind === "deepseek") {
    for (const b of (body.balance_infos as Record<string, unknown>[]) ?? [])
      amounts.push({ currency: String(b.currency), amount: num(b.total_balance) });
  } else if (kind === "openrouter") {
    const d = (body.data as Record<string, unknown>) ?? body;
    amounts.push({ currency: "USD", amount: num(d.total_credits) - num(d.total_usage) });
  } else if (kind === "kimi") {
    const d = (body.data as Record<string, unknown>) ?? {};
    amounts.push({ currency: "CNY", amount: num(d.available_balance) });
  } else {
    const d = (body.data as Record<string, unknown>) ?? {};
    amounts.push({ currency: "CNY", amount: num(d.totalBalance ?? d.balance) });
  }
  const valid = amounts.filter((a) => Number.isFinite(a.amount));
  if (!valid.length) return { ...none("返回格式无法识别"), source: url };
  return { available: true, amounts: valid, note: null, source: url, at };
}

/**
 * xAI (documented): GET /v1/api-key with the inference key gives the team id and whether the key /
 * team is blocked; the prepaid balance needs a separate Management key:
 * GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance → total.val in USD
 * cents, where purchases are negative (so available credit = -total).
 */
async function xaiBalance(s: ProviderSecret, base: string, at: number): Promise<Balance> {
  const none = (note: string, source: string | null = null): Balance => ({
    available: false,
    amounts: [],
    note,
    source,
    at,
  });
  const keyUrl = `${base}/v1/api-key`;
  let info: Record<string, unknown>;
  try {
    const r = await fetch(keyUrl, {
      headers: { authorization: `Bearer ${s.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return none(r.status === 401 || r.status === 400 ? "Key 无效" : `HTTP ${r.status}`, keyUrl);
    info = (await r.json()) as Record<string, unknown>;
  } catch (e) {
    return none((e as Error).message, keyUrl);
  }
  if (info.api_key_blocked || info.api_key_disabled) return none("这个 Key 已被停用", keyUrl);
  if (info.team_blocked) return none("团队已被停用（可能欠费）", keyUrl);
  const team = typeof info.team_id === "string" ? info.team_id : "";
  if (!s.mgmtKey) return none("Key 正常。查余额需要填写 Management Key", keyUrl);
  if (!team) return none("没拿到 team_id", keyUrl);
  const mgmt = base === "https://api.x.ai" ? "https://management-api.x.ai" : base;
  const url = `${mgmt}/v1/billing/teams/${encodeURIComponent(team)}/prepaid/balance`;
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${s.mgmtKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok)
      return none(r.status === 401 || r.status === 403 ? "Management Key 无效或没有权限" : `HTTP ${r.status}`, url);
    const body = (await r.json()) as { total?: { val?: string | number } };
    const cents = Number(body.total?.val);
    if (!Number.isFinite(cents)) return none("返回格式无法识别", url);
    return {
      available: true,
      amounts: [{ currency: "USD", amount: -cents / 100, label: "预付余额" }],
      note: null,
      source: url,
      at,
    };
  } catch (e) {
    return none((e as Error).message, url);
  }
}

// ---------------------------------------------------------------------------------------------
// CC Switch import (read-only): ~/.cc-switch/cc-switch.db (v3+) or config.json (older).

export interface CcSwitchEntry {
  key: string;
  app: "claude" | "codex";
  name: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  apiKey: string;
  model: string;
  smallModel: string;
  wireApi: "responses" | "chat";
  current: boolean;
}

export function ccSwitchDir(): string {
  return process.env.TUANTUAN_CCSWITCH_DIR || join(homedir(), ".cc-switch");
}

function tomlStr(toml: string, key: string): string {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml);
  return m?.[1] ?? "";
}

function fromSettings(app: string, name: string, key: string, cfg: unknown, current: boolean): CcSwitchEntry | null {
  const c = (cfg ?? {}) as Record<string, unknown>;
  if (app === "claude") {
    const env = (c.env ?? {}) as Record<string, string>;
    const base = env.ANTHROPIC_BASE_URL ?? "";
    const k = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
    if (!base && !k) return null;
    return {
      key,
      app: "claude",
      name,
      anthropicBaseUrl: base || "https://api.anthropic.com",
      openaiBaseUrl: "",
      apiKey: k,
      model: env.ANTHROPIC_MODEL ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "",
      smallModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? env.ANTHROPIC_SMALL_FAST_MODEL ?? "",
      wireApi: "chat",
      current,
    };
  }
  if (app === "codex") {
    const auth = (c.auth ?? {}) as Record<string, string>;
    const toml = typeof c.config === "string" ? c.config : "";
    const base = tomlStr(toml, "base_url");
    const k = auth.OPENAI_API_KEY ?? "";
    if (!base && !k) return null;
    return {
      key,
      app: "codex",
      name,
      anthropicBaseUrl: "",
      openaiBaseUrl: base || "https://api.openai.com/v1",
      apiKey: k,
      model: tomlStr(toml, "model"),
      smallModel: "",
      wireApi: tomlStr(toml, "wire_api") === "chat" ? "chat" : "responses",
      current,
    };
  }
  return null;
}

/** Profiles found in CC Switch's own storage. Opens the files read-only; never modifies them. */
export function readCcSwitch(): { found: boolean; source: string | null; entries: CcSwitchEntry[] } {
  const dir = ccSwitchDir();
  const db = join(dir, "cc-switch.db");
  const out: CcSwitchEntry[] = [];
  if (existsSync(db)) {
    const conn = new Database(db, { readonly: true });
    try {
      const rows = conn
        .query(
          "SELECT id, app_type, name, settings_config, is_current FROM providers WHERE app_type IN ('claude','codex')",
        )
        .all() as { id: string; app_type: string; name: string; settings_config: string; is_current: number }[];
      for (const r of rows) {
        let cfg: unknown = {};
        try {
          cfg = JSON.parse(r.settings_config);
        } catch {
          continue;
        }
        const e = fromSettings(r.app_type, r.name, `${r.app_type}:${r.id}`, cfg, !!r.is_current);
        if (e) out.push(e);
      }
    } finally {
      conn.close();
    }
    return { found: true, source: db, entries: out };
  }
  const json = join(dir, "config.json");
  if (existsSync(json)) {
    try {
      const v = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
      for (const app of ["claude", "codex"]) {
        const sect = (v[app] ?? {}) as { providers?: Record<string, Record<string, unknown>>; current?: string };
        for (const [id, pr] of Object.entries(sect.providers ?? {})) {
          const e = fromSettings(app, String(pr.name ?? id), `${app}:${id}`, pr.settingsConfig, sect.current === id);
          if (e) out.push(e);
        }
      }
    } catch {
      // unreadable: report as found but empty
    }
    return { found: true, source: json, entries: out };
  }
  return { found: false, source: null, entries: [] };
}

/** Best preset match for an imported base URL (for colour / balance). */
export function presetFor(url: string): string {
  const o = origin(url);
  const hit = PRESETS.find(
    (x) => x.id !== "custom" && [x.anthropicBaseUrl, x.openaiBaseUrl].some((u) => u && origin(u) === o),
  );
  return hit?.id ?? "custom";
}
