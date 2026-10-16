import type * as acp from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { type AcpProcess, withTimeout } from "./acp";
import type { LimitWindow } from "./usage";

export const REGISTRY_USAGE_IDS = ["reg:antigravity-acp", "reg:zcode-acp"] as const;
export type RegistryUsageId = (typeof REGISTRY_USAGE_IDS)[number];
export const isRegistryUsageId = (id: string): id is RegistryUsageId =>
  (REGISTRY_USAGE_IDS as readonly string[]).includes(id);

export interface RegistryQuota {
  limits: LimitWindow[];
  plan: string | null;
  notes: string[];
  error: string | null;
}
export interface RegistryQuotaSnapshot extends RegistryQuota {
  at: number;
}
export const registryUsageSource = (id: RegistryUsageId) =>
  id === "reg:antigravity-acp" ? "Antigravity ACP /usage" : "ZCode ACP account/usage_stats";
export const ZCODE_070_NOTE = "社区桥接 0.70.0 尚不支持团队套餐；查询结果仅来自其个人渠道，不代表团队余额。";
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const percent = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export function antigravityPlan(meta: unknown): string | null {
  const tier = object(object(object(meta)?.antigravity)?.tier);
  return text(tier?.name) ?? text(tier?.id);
}

/** Only Quota Limits contributes percentages. Session token totals are not account quota. */
export function parseAntigravityUsage(markdown: string, meta?: unknown): RegistryQuota {
  const result: RegistryQuota = { limits: [], plan: antigravityPlan(meta), notes: [], error: null };
  const section = markdown.split(/^###\s+Quota Limits\s*$/m)[1]?.split(/^###\s+/m)[0];
  if (section === undefined) return { ...result, error: "Antigravity 未返回 Quota Limits，额度未知" };
  let group = "Models";
  for (const line of section.split("\n")) {
    const heading = /^-\s+\*\*([^*]+)\*\*\s*$/.exec(line);
    if (heading) {
      group = heading[1]?.trim() || "Models";
      continue;
    }
    const bucket = /^\s+-\s+\*\*([^*]+?):\*\*\s*(.+)$/.exec(line);
    if (bucket) {
      const label = `${group} · ${bucket[1]?.trim()}`;
      const value = bucket[2]?.trim() ?? "";
      const remaining = /^(\d+(?:\.\d+)?)% remaining(?:\s+\(resets (.+)\))?$/i.exec(value);
      const left = remaining ? percent(Number(remaining[1])) : null;
      if (left !== null)
        result.limits.push({
          label,
          usedPercent: Math.round((100 - left) * 1e6) / 1e6,
          resetsAt: remaining?.[2]?.trim() ?? null,
        });
      else result.notes.push(`${label}：${value}`);
      continue;
    }
    const note = /^-\s+(.+)$/.exec(line)?.[1]?.trim();
    if (note) {
      result.notes.push(note);
      if (/^Unable to retrieve quota status/i.test(note)) result.error = `Antigravity 额度查询失败：${note}`;
    }
  }
  if (!result.limits.length && !result.notes.length && !result.error) result.error = "Antigravity 未返回可用额度数据";
  return result;
}

function resetTime(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // ZCode 0.70 QuotaItem.nextResetTime is epoch milliseconds, not seconds.
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** ZCode 0.70's extension only reports its personal GLM channel. Other providers are not cards. */
export function parseZcodeUsage(value: unknown, version: string | null): RegistryQuota {
  const notes = version === "0.70.0" ? [ZCODE_070_NOTE] : [];
  const initialNotes = notes.length;
  const glm = object(object(value)?.glm);
  const kind = text(glm?.kind);
  const result: RegistryQuota = { limits: [], plan: text(glm?.level), notes, error: null };
  const failures: Record<string, string> = {
    auth_error: "ZCode 个人渠道未登录或认证已失效，请通过其原生登录方式重试",
    rate_limited: "ZCode 额度查询被限流，请稍后重试",
    unavailable: "ZCode 个人渠道额度当前不可用，余额未知",
    not_configured: "ZCode 个人渠道未配置，余额未知",
  };
  if (kind !== "success")
    return { ...result, plan: null, error: failures[kind ?? ""] ?? "ZCode 未返回受支持的个人渠道额度数据" };
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  for (const raw of Array.isArray(glm?.items) ? glm.items : []) {
    const item = object(raw);
    if (!item) continue;
    const label = text(item.label) ?? text(item.key) ?? "个人渠道额度";
    const used = count(item.usedCount);
    const total = count(item.totalCount);
    const left = percent(item.leftPercent);
    const usedPercent =
      percent(item.usedPercent) ??
      (left !== null ? 100 - left : null) ??
      (used !== null && total !== null && total > 0 && used <= total ? (used / total) * 100 : null);
    if (usedPercent !== null) result.limits.push({ label, usedPercent, resetsAt: resetTime(item.nextResetTime) });
    if (used !== null || total !== null)
      result.notes.push(`${label}：已用 ${used ?? "未知"} / 总量 ${total ?? "未知"}`);
    for (const rawDetail of Array.isArray(item.detail) ? item.detail : []) {
      const detail = object(rawDetail);
      const model = text(detail?.modelCode);
      const usage = count(detail?.usage);
      if (model !== null && usage !== null) result.notes.push(`${label} · ${model}：${usage}`);
    }
  }
  if (!result.limits.length && result.notes.length === initialNotes)
    result.error = "ZCode 未返回有效百分比或绝对用量，额度未知";
  return result;
}

/** Collect notifications even when a harness publishes commands after session/new has resolved. */
export class RegistryUsageCollector {
  private commands = new Map<string, Set<string>>();
  private chunks = new Map<string, string>();
  private listeners = new Map<string, Set<() => void>>();
  onUpdate = (notification: acp.SessionNotification) => {
    const { sessionId, update } = notification;
    if (update.sessionUpdate === "available_commands_update") {
      this.commands.set(sessionId, new Set(update.availableCommands.map((c) => c.name)));
      for (const listener of this.listeners.get(sessionId) ?? []) listener();
    }
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
      this.chunks.set(sessionId, (this.chunks.get(sessionId) ?? "") + update.content.text);
  };
  async waitForUsage(sessionId: string, timeout = 3000): Promise<boolean> {
    if (this.commands.get(sessionId)?.has("usage")) return true;
    return new Promise((resolve) => {
      const complete = () => {
        if (this.commands.get(sessionId)?.has("usage")) finish(true);
      };
      const finish = (available: boolean) => {
        clearTimeout(timer);
        this.listeners.get(sessionId)?.delete(complete);
        resolve(available);
      };
      const timer = setTimeout(() => finish(false), timeout);
      if (!this.listeners.has(sessionId)) this.listeners.set(sessionId, new Set());
      this.listeners.get(sessionId)?.add(complete);
    });
  }
  clearText(sessionId: string) {
    this.chunks.delete(sessionId);
  }
  text(sessionId: string) {
    return this.chunks.get(sessionId) ?? "";
  }
}

/** Caller owns initialize/process lifetime; a successful probe can pass its existing session. */
export async function queryRegistryQuota(
  id: RegistryUsageId,
  process: AcpProcess,
  collector: RegistryUsageCollector,
  options: { created?: acp.NewSessionResponse; version: string | null },
): Promise<RegistryQuota> {
  if (id === "reg:zcode-acp") {
    const response = await withTimeout(process.agent.request("account/usage_stats", {}), 30_000, "读取 ZCode 额度超时");
    return parseZcodeUsage(response, options.version);
  }
  const created =
    options.created ??
    (await withTimeout(
      process.agent.request(methods.agent.session.new, {
        cwd: process.launch.cwd,
        mcpServers: [],
      }),
      60_000,
      "session/new 超时",
    ));
  if (!(await collector.waitForUsage(created.sessionId)))
    return {
      limits: [],
      plan: antigravityPlan(created._meta),
      notes: [],
      error: "当前 Antigravity 会话未声明 /usage，未发送任何查询提示；额度未知",
    };
  collector.clearText(created.sessionId);
  await withTimeout(
    process.agent.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "/usage" }],
    }),
    30_000,
    "读取 Antigravity 额度超时",
  );
  return parseAntigravityUsage(collector.text(created.sessionId), created._meta);
}
