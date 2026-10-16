import {
  Activity,
  Check,
  Download,
  ExternalLink,
  Gauge,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Balance, ProviderPreset, ProviderTest } from "../../server/providers";
import type { HarnessUsage, LimitWindow, TokenTotals } from "../../server/usage";
import { type Agent, api, type Meta } from "./api";
import { UsageDashboard } from "./UsageDashboard";

export interface ProviderItem {
  id: string;
  name: string;
  preset: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  model: string;
  smallModel: string;
  wireApi: "responses" | "chat";
  keyHint: string;
  mgmtKeyHint: string;
  color: string;
  balance: string | null;
  usedBy: string[];
  updatedAt: number;
}

interface TuantuanUsage {
  harness: string;
  providerId: string | null;
  turns: number;
  input: number;
  output: number;
  total: number;
}

/** Same rule as server providerSupports. */
export function providerFits(p: Pick<ProviderItem, "anthropicBaseUrl" | "openaiBaseUrl" | "wireApi">, harness: string) {
  if (harness === "claude-code") return !!p.anthropicBaseUrl;
  if (harness === "codex") return !!p.openaiBaseUrl && p.wireApi === "responses";
  if (harness === "custom") return !!(p.anthropicBaseUrl || p.openaiBaseUrl);
  return false;
}

export function ProviderIcon({ name, color, size = 28 }: { name: string; color: string; size?: number }) {
  return (
    <span className="prov-icon" style={{ background: color, width: size, height: size, fontSize: size * 0.46 }}>
      {[...name.trim()][0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export const fmtTokens = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : `${n}`;

export function fmtReset(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export const HARNESS_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  grok: "Grok",
  "reg:antigravity-acp": "Antigravity",
  "reg:zcode-acp": "ZCode",
  opencode: "OpenCode",
  custom: "自定义 API",
};

export function ProvidersPage(props: { meta: Meta; agents: Agent[]; onAgentsChange: () => Promise<void> }) {
  const [items, setItems] = useState<ProviderItem[] | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [usage, setUsage] = useState<{ harnesses: HarnessUsage[]; tuantuan: TuantuanUsage[] } | null>(null);
  const [editing, setEditing] = useState<ProviderItem | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, u] = await Promise.all([
        api<{ items: ProviderItem[]; presets: ProviderPreset[] }>("GET", "/api/providers"),
        api<{ harnesses: HarnessUsage[]; tuantuan: TuantuanUsage[] }>("GET", "/api/usage"),
      ]);
      setItems(p.items);
      setPresets(p.presets);
      setUsage(u);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const remove = async (p: ProviderItem) => {
    const extra = p.usedBy.length ? `\n${p.usedBy.join("、")} 会改回「本机配置」。` : "";
    if (!confirm(`删除「${p.name}」？${extra}`)) return;
    await api("DELETE", `/api/providers/${p.id}`).catch((e) => setError((e as Error).message));
    await Promise.all([load(), props.onAgentsChange()]);
  };

  return (
    <>
      <header className="main-head">
        <div className="title">
          <h2>服务商与用量</h2>
          <div className="sub">保存 API 服务商，一键给 Agent 切换；查看各 Harness 的额度</div>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => void load()}>
          <RefreshCw size={14} />
          刷新
        </button>
      </header>
      <div className="page">
        <div className="page-inner">
          {error && <div className="form-error">{error}</div>}

          <UsageDashboard meta={props.meta} agents={props.agents} />

          <section className="card">
            <div className="card-head">
              <h3>额度</h3>
              <p>只读本机记录和 Harness 自己的查询结果，不读钥匙串。</p>
            </div>
            <div className="card-body usage-grid">
              {!usage && <Loader2 size={16} className="spin" />}
              {usage?.harnesses.map((h) => (
                <UsageCard
                  key={h.harness}
                  u={h}
                  onUpdate={(hs) => setUsage((x) => (x ? { ...x, harnesses: hs } : x))}
                />
              ))}
              {usage && <TuantuanCard rows={usage.tuantuan} providers={items ?? []} />}
            </div>
          </section>

          <section className="card">
            <div className="card-head card-head-row">
              <div>
                <h3>服务商</h3>
                <p>Key 只存在团团，只注入给用它的 Agent 进程，不改 ~/.claude、~/.codex。</p>
              </div>
              <span className="row" style={{ gap: 6 }}>
                <button type="button" className="btn sm" onClick={() => setImporting(true)}>
                  <Download size={13} />从 CC Switch 导入
                </button>
                <button type="button" className="btn sm primary" onClick={() => setEditing("new")}>
                  <Plus size={13} />
                  添加
                </button>
              </span>
            </div>
            <div className="card-body prov-list">
              {!items && <Loader2 size={16} className="spin" />}
              {items?.length === 0 && (
                <div className="muted prov-empty">
                  还没有服务商。不选时，Agent 用「本机配置」（你自己的登录或环境变量）。
                </div>
              )}
              {items?.map((p) => (
                <ProviderRow
                  key={p.id}
                  p={p}
                  agents={props.agents}
                  onEdit={() => setEditing(p)}
                  onDelete={() => void remove(p)}
                  onSwitched={async () => {
                    await Promise.all([load(), props.onAgentsChange()]);
                  }}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
      {editing && (
        <ProviderDialog
          presets={presets}
          value={editing === "new" ? null : editing}
          onClose={async (saved) => {
            setEditing(null);
            if (saved) await Promise.all([load(), props.onAgentsChange()]);
          }}
        />
      )}
      {importing && (
        <CcSwitchDialog
          onClose={async (n) => {
            setImporting(false);
            if (n) await load();
          }}
        />
      )}
    </>
  );
}

function LimitBar({ l }: { l: LimitWindow }) {
  const left = Math.max(0, Math.min(100, 100 - l.usedPercent));
  const tone = left <= 10 ? "bad" : left <= 30 ? "warn" : "ok";
  const reset = fmtReset(l.resetsAt);
  return (
    <div className="limit" data-tone={tone}>
      <div className="limit-top">
        <span>{l.label}</span>
        <span className="limit-pct">剩 {Math.round(left)}%</span>
      </div>
      <div className="limit-track">
        <div className="limit-fill" style={{ width: `${left}%` }} />
      </div>
      {reset && <div className="limit-reset muted">{reset} 重置</div>}
    </div>
  );
}

function Tokens({ label, t }: { label: string; t: TokenTotals | null }) {
  return (
    <div className="tok">
      <span className="muted">{label}</span>
      <b>{t ? fmtTokens(t.total) : "—"}</b>
    </div>
  );
}

function UsageCard({ u, onUpdate }: { u: HarnessUsage; onUpdate: (h: HarnessUsage[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = u.live ?? (u.harness === "claude-code" || u.harness === "codex" || u.harness === "grok");
  const name = u.name ?? HARNESS_NAMES[u.harness] ?? u.harness;
  const na = !live;
  const refresh = async () => {
    setBusy(true);
    setErr(null);
    try {
      onUpdate(
        (await api<{ harnesses: HarnessUsage[] }>("POST", `/api/usage/${encodeURIComponent(u.harness)}/live`))
          .harnesses,
      );
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="usage-card" data-na={na ? "" : undefined} data-testid={`usage-${u.harness}`}>
      <div className="usage-head">
        <span className="usage-name">
          <Gauge size={14} />
          {name}
        </span>
        {u.plan && <span className="badge">{u.plan}</span>}
        {live && (
          <button
            type="button"
            className="btn ghost icon sm usage-refresh"
            aria-label={`刷新 ${name} 额度`}
            title="查询额度"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={busy ? "spin" : ""} />
          </button>
        )}
      </div>
      {na ? (
        <div className="usage-na muted">暂不支持查询</div>
      ) : (
        <>
          {u.limits.length > 0 ? (
            <div className="limits">
              {u.limits.map((l) => (
                <LimitBar key={`${l.label}:${l.resetsAt ?? ""}`} l={l} />
              ))}
            </div>
          ) : typeof u.creditBalanceUsd !== "number" ? (
            <div className="usage-na muted">额度未知</div>
          ) : null}
          <div className="toks">
            {typeof u.creditBalanceUsd === "number" && (
              <div className="tok">
                <span className="muted">预付余额</span>
                <b>${u.creditBalanceUsd.toFixed(2)}</b>
              </div>
            )}
            {(!u.harness.startsWith("reg:") || u.today || u.week) && (
              <>
                <Tokens label="今天" t={u.today} />
                <Tokens label="7 天" t={u.week} />
              </>
            )}
            {typeof u.costToday === "number" && (
              <div className="tok">
                <span className="muted">今天花费</span>
                <b>${u.costToday.toFixed(2)}</b>
              </div>
            )}
          </div>
        </>
      )}
      {(err || u.notes.length > 0) && (
        <div className="usage-notes muted">
          {err && <div className="error-text">{err}</div>}
          {u.notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}
      {u.limitsSource && <div className="usage-src muted">来源：{u.limitsSource}</div>}
      {u.limitsAt && <div className="usage-src muted">查询于 {new Date(u.limitsAt).toLocaleString("zh-CN")}</div>}
    </div>
  );
}

function TuantuanCard({ rows, providers }: { rows: TuantuanUsage[]; providers: ProviderItem[] }) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const turns = rows.reduce((s, r) => s + r.turns, 0);
  return (
    <div className="usage-card" data-testid="usage-tuantuan">
      <div className="usage-head">
        <span className="usage-name">
          <Activity size={14} />
          团团今天
        </span>
        <span className="badge">{turns} 轮</span>
      </div>
      <div className="toks">
        <Tokens label="合计" t={{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }} />
      </div>
      <div className="usage-rows">
        {rows.length === 0 && <div className="muted">今天还没有对话</div>}
        {rows.map((r) => (
          <div key={`${r.harness}|${r.providerId}`} className="usage-row">
            <span>
              {HARNESS_NAMES[r.harness] ?? r.harness}
              <span className="muted"> · {providers.find((p) => p.id === r.providerId)?.name ?? "本机配置"}</span>
            </span>
            <b>{fmtTokens(r.total)}</b>
          </div>
        ))}
      </div>
      <div className="usage-src muted">来源：每轮 ACP 返回的 usage</div>
    </div>
  );
}

function ProviderRow(props: {
  p: ProviderItem;
  agents: Agent[];
  onEdit: () => void;
  onDelete: () => void;
  onSwitched: () => Promise<void>;
}) {
  const { p } = props;
  const [test, setTest] = useState<ProviderTest | "busy" | null>(null);
  const [bal, setBal] = useState<Balance | "busy" | null>(null);
  const [switching, setSwitching] = useState(false);
  const fits = props.agents.filter((a) => providerFits(p, a.harness));
  const kinds = [p.anthropicBaseUrl && "Claude Code", providerFits(p, "codex") && "Codex", "自定义 API"].filter(
    Boolean,
  ) as string[];
  const runTest = async () => {
    setTest("busy");
    setTest(
      await api<ProviderTest>("POST", `/api/providers/${p.id}/test`).catch((e) => ({
        ok: false,
        ms: null,
        status: null,
        endpoint: "",
        error: (e as Error).message,
      })),
    );
  };
  const runBal = async () => {
    setBal("busy");
    setBal(
      await api<Balance>("GET", `/api/providers/${p.id}/balance`).catch((e) => ({
        available: false,
        amounts: [],
        note: (e as Error).message,
        source: null,
        at: Date.now(),
      })),
    );
  };
  const toggle = async (a: Agent) => {
    const providerId = a.providerId === p.id ? null : p.id;
    await api("PUT", `/api/agents/${a.id}`, { ...a, providerId });
    await props.onSwitched();
  };
  return (
    <div className="prov-row" data-testid={`provider-${p.name}`}>
      <ProviderIcon name={p.name} color={p.color} />
      <div className="prov-main">
        <div className="prov-name">
          {p.name}
          {kinds.map((k) => (
            <span key={k} className="badge">
              {k}
            </span>
          ))}
        </div>
        <div className="prov-sub muted">
          <KeyRound size={11} /> {p.keyHint || "无 Key"}
          {p.model && <> · {p.model}</>}
          {p.usedBy.length > 0 && <> · {p.usedBy.join("、")} 在用</>}
        </div>
        {(test || bal) && (
          <div className="prov-results">
            {test === "busy" && <Loader2 size={12} className="spin" />}
            {test && test !== "busy" && (
              <span className={test.ok ? "ok-text" : "error-text"} role="status">
                {test.ok ? `连通 · ${test.ms} ms` : `失败：${test.error}`}
              </span>
            )}
            {bal === "busy" && <Loader2 size={12} className="spin" />}
            {bal && bal !== "busy" && (
              <span className={bal.available ? "" : "muted"} role="status">
                {bal.available
                  ? `余额 ${bal.amounts.map((x) => `${x.amount.toFixed(2)} ${x.currency}`).join(" / ")}`
                  : bal.note}
              </span>
            )}
          </div>
        )}
        {switching && (
          <div className="prov-switch">
            {fits.length === 0 && <span className="muted">没有能用它的 Agent</span>}
            {fits.map((a) => (
              <button
                key={a.id}
                type="button"
                className="chip-toggle"
                aria-pressed={a.providerId === p.id}
                onClick={() => void toggle(a)}
              >
                {a.providerId === p.id && <Check size={12} />}
                {a.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="prov-actions">
        <button type="button" className="btn sm" onClick={() => void runTest()}>
          测速
        </button>
        {p.balance && (
          <button type="button" className="btn sm" onClick={() => void runBal()}>
            <Wallet size={13} />
            余额
          </button>
        )}
        <button type="button" className="btn sm" aria-expanded={switching} onClick={() => setSwitching((s) => !s)}>
          切换 Agent
        </button>
        <button type="button" className="btn ghost icon sm" aria-label={`编辑 ${p.name}`} onClick={props.onEdit}>
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="btn ghost icon sm danger"
          aria-label={`删除 ${p.name}`}
          onClick={props.onDelete}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

interface Draft {
  name: string;
  preset: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  apiKey: string;
  mgmtKey: string;
  model: string;
  smallModel: string;
  wireApi: "responses" | "chat";
}

function ProviderDialog(props: {
  presets: ProviderPreset[];
  value: ProviderItem | null;
  onClose: (saved: boolean) => void;
}) {
  const v = props.value;
  const [d, setD] = useState<Draft>(
    v
      ? { ...v, apiKey: "", mgmtKey: "" }
      : {
          name: "",
          preset: "custom",
          anthropicBaseUrl: "",
          openaiBaseUrl: "",
          apiKey: "",
          mgmtKey: "",
          model: "",
          smallModel: "",
          wireApi: "chat",
        },
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, x: Draft[K]) => setD((o) => ({ ...o, [k]: x }));
  const preset = useMemo(() => props.presets.find((p) => p.id === d.preset), [props.presets, d.preset]);
  const pick = (p: ProviderPreset) =>
    setD((o) => ({
      ...o,
      preset: p.id,
      name: !o.name || props.presets.some((x) => x.name === o.name) ? (p.id === "custom" ? "" : p.name) : o.name,
      anthropicBaseUrl: p.anthropicBaseUrl,
      openaiBaseUrl: p.openaiBaseUrl,
      model: p.model,
      smallModel: p.smallModel,
      wireApi: p.wireApi,
    }));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (v) await api("PUT", `/api/providers/${v.id}`, d);
      else await api("POST", "/api/providers", d);
      props.onClose(true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; Escape handled on the dialog
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose(false)}
    >
      <div
        className="modal prov-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={v ? "编辑服务商" : "添加服务商"}
        onKeyDown={(e) => e.key === "Escape" && props.onClose(false)}
      >
        <div className="dlg-head">
          <h3>{v ? "编辑服务商" : "添加服务商"}</h3>
          <button type="button" className="btn ghost icon sm" aria-label="关闭" onClick={() => props.onClose(false)}>
            <X size={16} />
          </button>
        </div>
        <div className="prov-form">
          <fieldset className="preset-grid" aria-label="预设">
            {props.presets.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={d.preset === p.id}
                className="preset"
                onClick={() => pick(p)}
              >
                <ProviderIcon name={p.name} color={p.color} size={20} />
                {p.name}
              </button>
            ))}
          </fieldset>
          <label className="field">
            <span className="label">名称</span>
            <input className="input" value={d.name} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label className="field">
            <span className="label">
              API Key
              {preset?.keyUrl && (
                <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="key-link">
                  获取 <ExternalLink size={11} />
                </a>
              )}
            </span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder={v?.keyHint ? `${v.keyHint}（留空不变）` : "sk-…"}
              value={d.apiKey}
              onChange={(e) => set("apiKey", e.target.value)}
            />
          </label>
          {preset?.balance === "xai" && (
            <label className="field">
              <span className="label">Management Key（选填，用于查余额）</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder={
                  v?.mgmtKeyHint ? `${v.mgmtKeyHint}（留空不变）` : "console.x.ai → Settings → Management Keys"
                }
                value={d.mgmtKey}
                onChange={(e) => set("mgmtKey", e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span className="label">Claude Code 地址</span>
            <input
              className="input"
              placeholder="https://…/anthropic（留空则不用于 Claude Code）"
              value={d.anthropicBaseUrl}
              onChange={(e) => set("anthropicBaseUrl", e.target.value)}
            />
          </label>
          <label className="field">
            <span className="label">OpenAI 兼容地址</span>
            <input
              className="input"
              placeholder="https://…/v1"
              value={d.openaiBaseUrl}
              onChange={(e) => set("openaiBaseUrl", e.target.value)}
            />
          </label>
          <div className="field">
            <span className="label">接口格式</span>
            <fieldset className="segmented" aria-label="接口格式">
              <button type="button" aria-pressed={d.wireApi === "chat"} onClick={() => set("wireApi", "chat")}>
                Chat Completions
              </button>
              <button
                type="button"
                aria-pressed={d.wireApi === "responses"}
                onClick={() => set("wireApi", "responses")}
              >
                Responses
              </button>
            </fieldset>
            <span className="help">Codex 只支持 Responses</span>
          </div>
          <div className="field-pair">
            <label className="field">
              <span className="label">主模型</span>
              <input
                className="input"
                placeholder="默认"
                value={d.model}
                onChange={(e) => set("model", e.target.value)}
              />
            </label>
            <label className="field">
              <span className="label">快速模型</span>
              <input
                className="input"
                placeholder="同主模型"
                value={d.smallModel}
                onChange={(e) => set("smallModel", e.target.value)}
              />
            </label>
          </div>
          {err && <div className="form-error">{err}</div>}
        </div>
        <div className="dlg-foot">
          <button type="button" className="btn ghost" onClick={() => props.onClose(false)}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={busy || !d.name.trim()} onClick={() => void save()}>
            {busy && <Loader2 size={13} className="spin" />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

interface CcEntry {
  key: string;
  app: "claude" | "codex";
  name: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  keyHint: string;
  current: boolean;
}

function CcSwitchDialog(props: { onClose: (imported: number) => void }) {
  const [r, setR] = useState<{ found: boolean; source: string | null; entries: CcEntry[] } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ found: boolean; source: string | null; entries: CcEntry[] }>("GET", "/api/providers/ccswitch")
      .then((x) => {
        setR(x);
        setSel(new Set(x.entries.map((e) => e.key)));
      })
      .catch((e) => setErr((e as Error).message));
  }, []);
  const go = async () => {
    try {
      const x = await api<{ imported: number }>("POST", "/api/providers/ccswitch", { keys: [...sel] });
      props.onClose(x.imported);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes
    <div className="overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && props.onClose(0)}>
      <div
        className="modal prov-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="从 CC Switch 导入"
        onKeyDown={(e) => e.key === "Escape" && props.onClose(0)}
      >
        <div className="dlg-head">
          <h3>从 CC Switch 导入</h3>
          <button type="button" className="btn ghost icon sm" aria-label="关闭" onClick={() => props.onClose(0)}>
            <X size={16} />
          </button>
        </div>
        <div className="prov-form">
          {!r && !err && <Loader2 size={16} className="spin" />}
          {r && !r.found && <div className="muted">没找到 CC Switch 配置（~/.cc-switch）。</div>}
          {r?.found && (
            <>
              <div className="muted">只读取 {r.source}，不会修改它。</div>
              <div className="cc-list">
                {r.entries.map((e) => (
                  <label key={e.key} className="cc-item">
                    <input
                      type="checkbox"
                      checked={sel.has(e.key)}
                      onChange={() =>
                        setSel((s) => {
                          const n = new Set(s);
                          if (n.has(e.key)) n.delete(e.key);
                          else n.add(e.key);
                          return n;
                        })
                      }
                    />
                    <span className="cc-name">{e.name}</span>
                    <span className="badge">{e.app === "claude" ? "Claude Code" : "Codex"}</span>
                    {e.current && <span className="badge">当前</span>}
                    <span className="muted cc-key">{e.keyHint}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          {err && <div className="form-error">{err}</div>}
        </div>
        <div className="dlg-foot">
          <button type="button" className="btn ghost" onClick={() => props.onClose(0)}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!r?.found || sel.size === 0}
            onClick={() => void go()}
          >
            导入 {sel.size || ""} 个
          </button>
        </div>
      </div>
    </div>
  );
}
