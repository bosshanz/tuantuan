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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Balance, ProviderPreset, ProviderTest } from "../../server/providers";
import type { HarnessUsage, LimitWindow, TokenTotals } from "../../server/usage";
import { providerSupports } from "../../shared/providerSupport";
import { type Agent, api, type Meta } from "./api";
import { getLocale, intlLocale, type Locale, translate, translateError, useI18n } from "./i18n";
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
  modelCatalog?: Record<string, string>;
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

export function fmtReset(s: string | null, locale: Locale = getLocale()): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const now = new Date();
  const hm = d.toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === now.toDateString()
    ? hm
    : `${d.toLocaleDateString(intlLocale(locale), { month: "short", day: "numeric" })} ${hm}`;
}

export const HARNESS_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  grok: "Grok",
  "reg:antigravity-acp": "Antigravity",
  "reg:zcode-acp": "ZCode",
  opencode: "OpenCode",
  pi: "Pi",
  custom: "自定义 API",
};

const PROVIDER_HARNESSES = ["claude-code", "opencode", "pi", "codex", "custom"];

export function ProvidersPage(props: { meta: Meta; agents: Agent[]; onAgentsChange: () => Promise<void> }) {
  const { t } = useI18n();
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
    const extra = p.usedBy.length ? t("\n{name} 会改回「本机配置」。", { name: p.usedBy.join(", ") }) : "";
    if (!confirm(t("删除「{name}」？{extra}", { name: p.name, extra }))) return;
    await api("DELETE", `/api/providers/${p.id}`).catch((e) => setError((e as Error).message));
    await Promise.all([load(), props.onAgentsChange()]);
  };

  return (
    <>
      <header className="main-head">
        <div className="title">
          <h2>{t("服务商与用量")}</h2>
          <div className="sub">{t("保存 API 服务商，一键给 Agent 切换；查看各 Harness 的额度")}</div>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => void load()}>
          <RefreshCw size={14} />
          {t("刷新")}
        </button>
      </header>
      <div className="page">
        <div className="page-inner">
          {error && <div className="form-error">{translateError(error)}</div>}

          <UsageDashboard meta={props.meta} agents={props.agents} />

          <section className="card">
            <div className="card-head">
              <h3>{t("额度")}</h3>
              <p>{t("只读本机记录和 Harness 自己的查询结果，不读钥匙串。")}</p>
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

          <ModelCatalogControls />

          <section className="card prov-provider-card">
            <div className="card-head card-head-row">
              <div>
                <h3>{t("服务商")}</h3>
                <p>{t("Key 只存在团团，只注入给用它的 Agent 进程，不改 ~/.claude、~/.codex。")}</p>
              </div>
              <span className="row" style={{ gap: 6 }}>
                <button type="button" className="btn sm" onClick={() => setImporting(true)}>
                  <Download size={13} />
                  {t("从 CC Switch 导入")}
                </button>
                <button type="button" className="btn sm primary" onClick={() => setEditing("new")}>
                  <Plus size={13} />
                  {t("添加")}
                </button>
              </span>
            </div>
            <div className="card-body prov-list">
              {!items && <Loader2 size={16} className="spin" />}
              {items?.length === 0 && (
                <div className="muted prov-empty">
                  {t("还没有服务商。不选时，Agent 用「本机配置」（你自己的登录或环境变量）。")}
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

interface ModelCatalogStatus {
  origin: "bundled" | "synced";
  fetchedAt: string;
  providers: number;
  models: number;
  error: string | null;
}

function ModelCatalogControls() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<ModelCatalogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [synced, setSynced] = useState<boolean | null>(null);
  const revision = useRef(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const initialRevision = revision.current;
    api<ModelCatalogStatus>("GET", "/api/providers/models")
      .then((value) => current && initialRevision === revision.current && setStatus(value))
      .catch((error) => current && initialRevision === revision.current && setError((error as Error).message));
    return () => {
      current = false;
    };
  }, []);
  const sync = async () => {
    ++revision.current;
    setBusy(true);
    setSynced(false);
    setError(null);
    try {
      setStatus(await api<ModelCatalogStatus>("POST", "/api/providers/models/sync"));
      setSynced(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card prov-catalog" aria-label={t("模型能力")}>
      <div className="card-head card-head-row">
        <div>
          <h3>{t("模型能力")}</h3>
          <p>{t("仅手动同步时连接 models.dev；失败时保留本地目录。")}</p>
        </div>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void sync()}>
          <RefreshCw size={13} className={busy ? "spin" : ""} />
          {busy ? t("同步中…") : t("同步模型能力")}
        </button>
      </div>
      <div className="card-body prov-catalog-status" aria-live="polite">
        {status ? (
          <>
            <span>
              {t(status.origin === "bundled" ? "内置目录 · {time}" : "同步于 {time}", {
                time: new Date(status.fetchedAt).toLocaleString(intlLocale(locale)),
              })}
            </span>
            <span className="muted">
              {t("{providers} 个服务商 · {models} 个模型", {
                providers: status.providers.toLocaleString(intlLocale(locale)),
                models: status.models.toLocaleString(intlLocale(locale)),
              })}
            </span>
            {status.error && <span className="error-text">{translateError(status.error)}</span>}
          </>
        ) : (
          !error && <Loader2 size={14} className="spin" />
        )}
        {synced && (
          <span className="ok-text" role="status">
            {t("模型能力已同步")}
          </span>
        )}
        {error && (
          <div className="error-text" role="alert">
            {synced === false && <>{t("同步未完成，继续使用本地目录。")} </>}
            {translateError(error)}
          </div>
        )}
        <span className="help">{t("更新后的能力用于之后启动的 Agent，现有会话不变。")}</span>
      </div>
    </section>
  );
}

function usageWindowLabel(label: string): string {
  const duration = /^(\d+(?:\.\d+)?) (分钟|小时|天)$/.exec(label);
  if (duration) return translate(`{count} ${duration[2]}`, { count: duration[1] ?? "" });
  if (label.startsWith("每周 · ")) return translate("每周 · {model}", { model: label.slice(5) });
  return translate(label);
}

function LimitBar({ l }: { l: LimitWindow }) {
  const { t, locale } = useI18n();
  const left = Math.max(0, Math.min(100, 100 - l.usedPercent));
  const tone = left <= 10 ? "bad" : left <= 30 ? "warn" : "ok";
  const reset = fmtReset(l.resetsAt, locale);
  return (
    <div className="limit" data-tone={tone}>
      <div className="limit-top">
        <span>{usageWindowLabel(l.label)}</span>
        <span className="limit-pct">{t("剩 {count}%", { count: Math.round(left) })}</span>
      </div>
      <div className="limit-track">
        <div className="limit-fill" style={{ width: `${left}%` }} />
      </div>
      {reset && <div className="limit-reset muted">{t("{time} 重置", { time: reset })}</div>}
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
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = u.live ?? (u.harness === "claude-code" || u.harness === "codex" || u.harness === "grok");
  const name = t(u.name ?? HARNESS_NAMES[u.harness] ?? u.harness);
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
            aria-label={t("刷新 {name} 额度", { name })}
            title={t("查询额度")}
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={busy ? "spin" : ""} />
          </button>
        )}
      </div>
      {na ? (
        <div className="usage-na muted">{t("暂不支持查询")}</div>
      ) : (
        <>
          {u.limits.length > 0 ? (
            <div className="limits">
              {u.limits.map((l) => (
                <LimitBar key={`${usageWindowLabel(l.label)}:${l.resetsAt ?? ""}`} l={l} />
              ))}
            </div>
          ) : typeof u.creditBalanceUsd !== "number" ? (
            <div className="usage-na muted">{t("额度未知")}</div>
          ) : null}
          <div className="toks">
            {typeof u.creditBalanceUsd === "number" && (
              <div className="tok">
                <span className="muted">{t("预付余额")}</span>
                <b>${u.creditBalanceUsd.toFixed(2)}</b>
              </div>
            )}
            {(!u.harness.startsWith("reg:") || u.today || u.week) && (
              <>
                <Tokens label={t("今天")} t={u.today} />
                <Tokens label={t("7 天")} t={u.week} />
              </>
            )}
            {typeof u.costToday === "number" && (
              <div className="tok">
                <span className="muted">{t("今天花费")}</span>
                <b>${u.costToday.toFixed(2)}</b>
              </div>
            )}
          </div>
        </>
      )}
      {(err || u.notes.length > 0) && (
        <div className="usage-notes muted">
          {err && <div className="error-text">{translateError(err)}</div>}
          {u.notes.map((n) => (
            <div key={n}>{translateError(n)}</div>
          ))}
        </div>
      )}
      {u.limitsSource && <div className="usage-src muted">{t("来源：{source}", { source: t(u.limitsSource) })}</div>}
      {u.limitsAt && (
        <div className="usage-src muted">
          {t("查询于 {time}", { time: new Date(u.limitsAt).toLocaleString(intlLocale(locale)) })}
        </div>
      )}
    </div>
  );
}

function TuantuanCard({ rows, providers }: { rows: TuantuanUsage[]; providers: ProviderItem[] }) {
  const { t } = useI18n();
  const total = rows.reduce((s, r) => s + r.total, 0);
  const turns = rows.reduce((s, r) => s + r.turns, 0);
  return (
    <div className="usage-card" data-testid="usage-tuantuan">
      <div className="usage-head">
        <span className="usage-name">
          <Activity size={14} />
          {t("团团今天")}
        </span>
        <span className="badge">{t("{count} 轮", { count: turns })}</span>
      </div>
      <div className="toks">
        <Tokens label={t("合计")} t={{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }} />
      </div>
      <div className="usage-rows">
        {rows.length === 0 && <div className="muted">{t("今天还没有对话")}</div>}
        {rows.map((r) => (
          <div key={`${r.harness}|${r.providerId}`} className="usage-row">
            <span>
              {t(HARNESS_NAMES[r.harness] ?? r.harness)}
              <span className="muted"> · {providers.find((p) => p.id === r.providerId)?.name ?? t("本机配置")}</span>
            </span>
            <b>{fmtTokens(r.total)}</b>
          </div>
        ))}
      </div>
      <div className="usage-src muted">{t("来源：每轮 ACP 返回的 usage")}</div>
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
  const { t } = useI18n();
  const { p } = props;
  const [test, setTest] = useState<ProviderTest | "busy" | null>(null);
  const [bal, setBal] = useState<Balance | "busy" | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const fits = props.agents.filter((a) => providerSupports(p, a.harness));
  const kinds = PROVIDER_HARNESSES.filter((h) => providerSupports(p, h));
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
    setSwitchBusy(true);
    setSwitchError(null);
    const providerId = a.providerId === p.id ? null : p.id;
    // Model ids belong to the previous provider, just as in AgentEditor.
    const { model: _drop, ...configDefaults } = a.configDefaults;
    try {
      await api("PUT", `/api/agents/${a.id}`, { ...a, providerId, configDefaults });
      await props.onSwitched();
    } catch (e) {
      setSwitchError((e as Error).message);
    } finally {
      setSwitchBusy(false);
    }
  };
  return (
    <div className="prov-row" data-testid={`provider-${p.name}`}>
      <ProviderIcon name={p.name} color={p.color} />
      <div className="prov-main">
        <div className="prov-name">
          {p.name}
          {kinds.map((k) => (
            <span key={k} className="badge">
              {t(HARNESS_NAMES[k] ?? k)}
            </span>
          ))}
        </div>
        <div className="prov-sub muted">
          <KeyRound size={11} /> {p.keyHint || t("无 Key")}
          {p.model && <> · {p.model}</>}
          {p.usedBy.length > 0 && <> · {t("{name} 在用", { name: p.usedBy.join(", ") })}</>}
        </div>
        {(test || bal) && (
          <div className="prov-results">
            {test === "busy" && <Loader2 size={12} className="spin" />}
            {test && test !== "busy" && (
              <span className={test.ok ? "ok-text" : "error-text"} role="status">
                {test.ok
                  ? t("连通 · {count} ms", { count: test.ms ?? 0 })
                  : t("失败：{error}", { error: translateError(test.error ?? "") })}
              </span>
            )}
            {bal === "busy" && <Loader2 size={12} className="spin" />}
            {bal && bal !== "busy" && (
              <span className={bal.available ? "" : "muted"} role="status">
                {bal.available
                  ? t("余额 {amount}", {
                      amount: bal.amounts.map((x) => `${x.amount.toFixed(2)} ${x.currency}`).join(" / "),
                    })
                  : translateError(bal.note ?? "")}
              </span>
            )}
          </div>
        )}
        {switching && (
          <div className="prov-switch">
            {fits.length === 0 && <span className="muted">{t("没有能用它的 Agent")}</span>}
            {fits.map((a) => (
              <button
                key={a.id}
                type="button"
                className="chip-toggle"
                aria-pressed={a.providerId === p.id}
                disabled={switchBusy}
                onClick={() => void toggle(a)}
              >
                {a.providerId === p.id && <Check size={12} />}
                {a.name}
              </button>
            ))}
          </div>
        )}
        {switchError && (
          <div className="error-text" role="alert">
            {translateError(switchError)}
          </div>
        )}
      </div>
      <div className="prov-actions">
        <button type="button" className="btn sm" onClick={() => void runTest()}>
          {t("测速")}
        </button>
        {p.balance && (
          <button type="button" className="btn sm" onClick={() => void runBal()}>
            <Wallet size={13} />
            {t("余额")}
          </button>
        )}
        <button type="button" className="btn sm" aria-expanded={switching} onClick={() => setSwitching((s) => !s)}>
          {t("切换 Agent")}
        </button>
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t("编辑 {name}", { name: p.name })}
          onClick={props.onEdit}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="btn ghost icon sm danger"
          aria-label={t("删除 {name}", { name: p.name })}
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
  modelCatalog?: Record<string, string>;
}

function ProviderDialog(props: {
  presets: ProviderPreset[];
  value: ProviderItem | null;
  onClose: (saved: boolean) => void;
}) {
  const { t } = useI18n();
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
  const sourceFor = (model: string) =>
    d.modelCatalog && Object.hasOwn(d.modelCatalog, model) ? (d.modelCatalog[model] ?? "") : "";
  const preset = useMemo(() => props.presets.find((p) => p.id === d.preset), [props.presets, d.preset]);
  const supportedHarnesses = PROVIDER_HARNESSES.filter((h) => providerSupports(d, h));
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
        aria-label={v ? t("编辑服务商") : t("添加服务商")}
        onKeyDown={(e) => e.key === "Escape" && props.onClose(false)}
      >
        <div className="dlg-head">
          <h3>{v ? t("编辑服务商") : t("添加服务商")}</h3>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t("关闭")}
            onClick={() => props.onClose(false)}
          >
            <X size={16} />
          </button>
        </div>
        <div className="prov-form">
          <fieldset className="preset-grid" aria-label={t("预设")}>
            {props.presets.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={d.preset === p.id}
                className="preset"
                onClick={() => pick(p)}
              >
                <ProviderIcon name={t(p.name)} color={p.color} size={20} />
                {t(p.name)}
              </button>
            ))}
          </fieldset>
          <label className="field">
            <span className="label">{t("名称")}</span>
            <input className="input" value={d.name} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label className="field">
            <span className="label">
              API Key
              {preset?.keyUrl && (
                <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="key-link">
                  {t("获取")}
                  <ExternalLink size={11} />
                </a>
              )}
            </span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder={v?.keyHint ? t("{hint}（留空不变）", { hint: v.keyHint }) : "sk-…"}
              value={d.apiKey}
              onChange={(e) => set("apiKey", e.target.value)}
            />
          </label>
          {preset?.balance === "xai" && (
            <label className="field">
              <span className="label">{t("Management Key（选填，用于查余额）")}</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder={
                  v?.mgmtKeyHint
                    ? t("{hint}（留空不变）", { hint: v.mgmtKeyHint })
                    : "console.x.ai → Settings → Management Keys"
                }
                value={d.mgmtKey}
                onChange={(e) => set("mgmtKey", e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span className="label">{t("Anthropic 兼容地址")}</span>
            <input
              className="input"
              aria-describedby="provider-anthropic-help"
              placeholder="https://…/anthropic"
              value={d.anthropicBaseUrl}
              onChange={(e) => set("anthropicBaseUrl", e.target.value)}
            />
            <span className="help" id="provider-anthropic-help">
              {t("用于 Claude Code / OpenCode / Pi。")}
            </span>
          </label>
          <label className="field">
            <span className="label">{t("OpenAI 兼容地址")}</span>
            <input
              className="input"
              aria-describedby="provider-openai-help"
              placeholder="https://…/v1"
              value={d.openaiBaseUrl}
              onChange={(e) => set("openaiBaseUrl", e.target.value)}
            />
            <span className="help" id="provider-openai-help">
              {t("用于 OpenCode / Pi / Codex；Codex 需要 Responses。")}
            </span>
          </label>
          <div className="field">
            <span className="label">{t("接口格式")}</span>
            <fieldset className="segmented" aria-label={t("接口格式")}>
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
            <span className="help">
              {t("仅作用于 OpenAI 兼容地址；须与服务商实际支持的格式一致，选择不会转换接口。")}
            </span>
            <span className="help">{t("两个地址都填写时，OpenCode / Pi 优先使用 OpenAI 兼容地址。")}</span>
          </div>
          <div className="field-pair">
            <label className="field">
              <span className="label">{t("主模型")}</span>
              <input
                className="input"
                aria-describedby="provider-model-help"
                placeholder={t("服务商的模型 ID")}
                value={d.model}
                onChange={(e) => set("model", e.target.value)}
              />
            </label>
            <label className="field">
              <span className="label">{t("快速模型")}</span>
              <input
                className="input"
                placeholder={t("同主模型")}
                value={d.smallModel}
                onChange={(e) => set("smallModel", e.target.value)}
              />
            </label>
          </div>
          <span className="help" id="provider-model-help">
            {t("OpenCode / Pi 需要填写主模型；Claude Code / Codex 留空时跟随 Harness。")}
          </span>
          <details className="prov-model-sources">
            <summary>{t("模型能力来源")}</summary>
            <div className="prov-model-source-fields">
              <p className="help">{t("填写 models.dev 的完整 provider/model 引用；留空按预设和接口地址自动识别。")}</p>
              <p className="help">{t("仅关联思考档位、上下文等能力，不会修改请求中的模型 ID 或接口地址。")}</p>
              <ModelSourceInput
                label={t("主模型能力来源")}
                model={d.model.trim()}
                value={sourceFor(d.model.trim())}
                disabled={!d.model.trim()}
                onChange={(reference) =>
                  setD((old) => ({
                    ...old,
                    modelCatalog: {
                      ...old.modelCatalog,
                      [old.model.trim()]: reference,
                    },
                  }))
                }
              />
              <ModelSourceInput
                label={t("快速模型能力来源")}
                model={d.smallModel.trim() || d.model.trim()}
                value={sourceFor(d.smallModel.trim() || d.model.trim())}
                disabled={!d.smallModel.trim() || d.smallModel.trim() === d.model.trim()}
                onChange={(reference) =>
                  setD((old) => ({
                    ...old,
                    modelCatalog: {
                      ...old.modelCatalog,
                      [old.smallModel.trim()]: reference,
                    },
                  }))
                }
              />
              {(!d.smallModel.trim() || d.smallModel.trim() === d.model.trim()) && (
                <span className="help">{t("快速模型与主模型相同时，沿用主模型的能力来源。")}</span>
              )}
            </div>
          </details>
          <div className="prov-compat" role="status" aria-live="polite" aria-atomic="true">
            <span className="label">{t("当前可用于")}</span>
            <div className="prov-compat-kinds">
              {supportedHarnesses.length ? (
                supportedHarnesses.map((h) => (
                  <span className="badge" key={h}>
                    {t(HARNESS_NAMES[h] ?? h)}
                  </span>
                ))
              ) : (
                <span className="muted">{t("填写兼容地址后显示")}</span>
              )}
            </div>
          </div>
          {err && <div className="form-error">{translateError(err)}</div>}
        </div>
        <div className="dlg-foot">
          <button type="button" className="btn ghost" onClick={() => props.onClose(false)}>
            {t("取消")}
          </button>
          <button type="button" className="btn primary" disabled={busy || !d.name.trim()} onClick={() => void save()}>
            {busy && <Loader2 size={13} className="spin" />}
            {t("保存")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelSourceInput(props: {
  label: string;
  model: string;
  value: string;
  disabled: boolean;
  onChange: (reference: string) => void;
}) {
  const { t } = useI18n();
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [items, setItems] = useState<{ value: string; name: string }[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const query = props.value.trim() || props.model;
  useEffect(() => {
    let current = true;
    setItems([]);
    setUnavailable(false);
    if (!focused || props.disabled || !query) return;
    const timer = setTimeout(() => {
      api<{ items: { value: string; name: string }[] }>(
        "GET",
        `/api/providers/models?query=${encodeURIComponent(query)}`,
      )
        .then((value) => current && setItems(value.items))
        .catch(() => current && setUnavailable(true));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [focused, props.disabled, query]);
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      <input
        className="input"
        aria-label={props.label}
        list={listId}
        placeholder={t("自动识别（留空）")}
        disabled={props.disabled}
        value={props.value}
        maxLength={400}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <datalist id={listId}>
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.name}
          </option>
        ))}
      </datalist>
      {props.model && <span className="help">{t("对应模型 ID：{model}", { model: props.model })}</span>}
      {unavailable && <span className="help">{t("暂时无法加载建议，可手动填写完整引用。")}</span>}
    </label>
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
  const { t } = useI18n();
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
        aria-label={t("从 CC Switch 导入")}
        onKeyDown={(e) => e.key === "Escape" && props.onClose(0)}
      >
        <div className="dlg-head">
          <h3>{t("从 CC Switch 导入")}</h3>
          <button type="button" className="btn ghost icon sm" aria-label={t("关闭")} onClick={() => props.onClose(0)}>
            <X size={16} />
          </button>
        </div>
        <div className="prov-form">
          {!r && !err && <Loader2 size={16} className="spin" />}
          {r && !r.found && <div className="muted">{t("没找到 CC Switch 配置（~/.cc-switch）。")}</div>}
          {r?.found && (
            <>
              <div className="muted">{t("只读取 {path}，不会修改它。", { path: r.source ?? "" })}</div>
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
                    {e.current && <span className="badge">{t("当前")}</span>}
                    <span className="muted cc-key">{e.keyHint}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          {err && <div className="form-error">{translateError(err)}</div>}
        </div>
        <div className="dlg-foot">
          <button type="button" className="btn ghost" onClick={() => props.onClose(0)}>
            {t("取消")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!r?.found || sel.size === 0}
            onClick={() => void go()}
          >
            {t("导入 {count} 个", { count: sel.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
