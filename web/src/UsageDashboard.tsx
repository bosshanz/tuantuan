import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Agent, Meta } from "./api";
import { api } from "./api";
import { harnessBrand } from "./brands";
import { translateError, useI18n } from "./i18n";
import { BrandLogo, brandFor } from "./ModelPicker";
import { AgentAvatar } from "./ui";

/** Per-turn token usage as reported by the harnesses (never estimated). */
export interface UsageTally {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thought: number;
  total: number;
  cost: number | null;
  currency: string | null;
}
type Row = { key: string | null } & UsageTally;
export interface UsageStatsView {
  totals: UsageTally;
  byAgent: Row[];
  byModel: Row[];
  byHarness: Row[];
  daily: { day: string; input: number; output: number; cache: number; total: number }[];
  reporting: string[];
}

const RANGES = [
  { id: "today", label: "今天", days: 1 },
  { id: "7d", label: "7 天", days: 7 },
  { id: "30d", label: "30 天", days: 30 },
  { id: "all", label: "全部", days: 0 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];
const GROUPS = [
  { id: "agent", label: "Agent" },
  { id: "model", label: "模型" },
  { id: "harness", label: "Harness" },
] as const;
type GroupId = (typeof GROUPS)[number]["id"];

const DAY = 86_400_000;
const startOfToday = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
function sinceFor(r: RangeId): number {
  const def = RANGES.find((x) => x.id === r);
  return !def || def.days === 0 ? 0 : startOfToday() - (def.days - 1) * DAY;
}
const localDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}
const fmtCost = (c: number, cur: string | null) =>
  `${cur === "USD" || !cur ? "$" : `${cur} `}${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`;

export function UsageDashboard({ meta, agents }: { meta: Meta; agents: Agent[] }) {
  const { t } = useI18n();
  const [range, setRange] = useState<RangeId>("7d");
  const [group, setGroup] = useState<GroupId>("agent");
  const [stats, setStats] = useState<UsageStatsView | null>(null);
  const [trend, setTrend] = useState<UsageStatsView["daily"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tz = -new Date().getTimezoneOffset();
    const since = sinceFor(range);
    // The trend always shows at least a week so 「今天」 still has context.
    const trendSince = range === "today" ? sinceFor("7d") : since;
    Promise.all([
      api<UsageStatsView>("GET", `/api/usage/stats?since=${since}&tz=${tz}`),
      trendSince === since ? null : api<UsageStatsView>("GET", `/api/usage/stats?since=${trendSince}&tz=${tz}`),
    ])
      .then(([s, t]) => {
        if (!live) return;
        setStats(s);
        setTrend((t ?? s).daily);
        setError(null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [range]);

  const harnessName = (id: string | null) =>
    t(meta.harnesses.find((h) => h.id === id)?.name ?? (id?.startsWith("reg:") ? id.slice(4) : (id ?? "未知")));
  const reporting = new Set(stats?.reporting ?? []);

  const rows = (() => {
    if (!stats) return [];
    type Item = { id: string; icon: React.ReactNode; name: string; sub?: string; t: UsageTally | null };
    const out: Item[] = [];
    if (group === "agent") {
      for (const r of stats.byAgent) {
        const a = agents.find((x) => x.id === r.key);
        out.push({
          id: r.key ?? "none",
          icon: <AgentAvatar agent={a} name={a?.name ?? "?"} size={26} />,
          name: a?.name ?? t("已删除的 Agent"),
          sub: a ? harnessName(a.harness) : undefined,
          t: r,
        });
      }
      for (const a of agents)
        if (!stats.byAgent.some((r) => r.key === a.id) && !reporting.has(a.harness))
          out.push({
            id: a.id,
            icon: <AgentAvatar agent={a} name={a.name} size={26} />,
            name: a.name,
            sub: harnessName(a.harness),
            t: null,
          });
    } else if (group === "model") {
      for (const r of stats.byModel)
        out.push({
          id: r.key ?? "none",
          icon: (
            <span className="ud-logo">
              <BrandLogo brand={brandFor(r.key ?? "", "")} size={15} />
            </span>
          ),
          name: r.key ?? t("未标明模型"),
          t: r,
        });
    } else {
      for (const r of stats.byHarness)
        out.push({
          id: r.key ?? "none",
          icon: (
            <span className="ud-logo">
              <BrandLogo brand={harnessBrand(r.key ?? "")} size={15} />
            </span>
          ),
          name: harnessName(r.key),
          t: r,
        });
      const used = [...new Set(agents.map((a) => a.harness))];
      for (const h of used)
        if (!stats.byHarness.some((r) => r.key === h) && !reporting.has(h))
          out.push({
            id: h,
            icon: (
              <span className="ud-logo">
                <BrandLogo brand={harnessBrand(h)} size={15} />
              </span>
            ),
            name: harnessName(h),
            t: null,
          });
    }
    return out;
  })();
  const max = Math.max(1, ...rows.map((r) => r.t?.total ?? 0));
  const totals = stats?.totals;
  const cache = totals ? totals.cacheRead + totals.cacheWrite : 0;

  return (
    <section className="card ud" aria-label={t("Token 统计")}>
      <div className="card-head card-head-row">
        <div>
          <h3>{t("Token 统计")}</h3>
          <p>{t("按每轮回复里 Harness 报告的数字统计，不估算。")}</p>
        </div>
        <fieldset className="segmented" aria-label={t("时间范围")}>
          {RANGES.map((r) => (
            <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
              {t(r.label)}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="card-body">
        {error && <div className="form-error">{translateError(error)}</div>}
        {!stats && !error && <Loader2 size={16} className="spin" />}
        {totals && (
          <>
            <div className="ud-cards">
              <Stat
                label={t("总计")}
                value={fmtTokens(totals.total)}
                sub={t("{count} 轮", { count: totals.turns })}
                strong
              />
              <Stat label={t("输入")} value={fmtTokens(totals.input)} />
              <Stat
                label={t("输出")}
                value={fmtTokens(totals.output)}
                sub={totals.thought ? t("含思考 {count}", { count: fmtTokens(totals.thought) }) : undefined}
              />
              <Stat
                label={t("缓存")}
                value={fmtTokens(cache)}
                sub={
                  cache
                    ? t("读 {read} · 写 {write}", {
                        read: fmtTokens(totals.cacheRead),
                        write: fmtTokens(totals.cacheWrite),
                      })
                    : undefined
                }
              />
              <Stat
                label={t("费用")}
                value={totals.cost !== null ? fmtCost(totals.cost, totals.currency) : t("无数据")}
                muted={totals.cost === null}
              />
            </div>
            <Trend days={trend ?? []} since={range === "today" ? sinceFor("7d") : sinceFor(range)} />
            <div className="ud-group-head">
              <div className="segmented" role="tablist" aria-label={t("分组")}>
                {GROUPS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    role="tab"
                    aria-selected={group === g.id}
                    onClick={() => setGroup(g.id)}
                  >
                    {t(g.label)}
                  </button>
                ))}
              </div>
              <span className="ud-legend">
                <i data-k="input" />
                {t("输入")}
                <i data-k="output" />
                {t("输出")}
                <i data-k="cache" />
                {t("缓存")}
              </span>
            </div>
            <ol className="ud-table" key={`${group}-${range}`}>
              {rows.length === 0 && <li className="ud-empty">{t("这段时间没有记录")}</li>}
              {rows.map((r, i) => (
                <li key={r.id} className="ud-row" style={{ ["--i" as string]: i }} data-testid={`usage-row-${r.name}`}>
                  <span className="ud-rank">{r.t ? i + 1 : ""}</span>
                  {r.icon}
                  <span className="ud-name">
                    <b>{r.name}</b>
                    {r.sub && <small>{r.sub}</small>}
                  </span>
                  {r.t ? (
                    <>
                      <span
                        className="ud-bar"
                        title={t("输入 {input} · 输出 {output} · 缓存 {cache}", {
                          input: r.t.input,
                          output: r.t.output,
                          cache: r.t.cacheRead + r.t.cacheWrite,
                        })}
                      >
                        <span style={{ width: `${(r.t.total / max) * 100}%` }}>
                          <i data-k="input" style={{ flex: r.t.input }} />
                          <i data-k="output" style={{ flex: r.t.output }} />
                          <i data-k="cache" style={{ flex: r.t.cacheRead + r.t.cacheWrite }} />
                        </span>
                      </span>
                      <span className="ud-num">{fmtTokens(r.t.total)}</span>
                      <span className="ud-cost">{r.t.cost !== null ? fmtCost(r.t.cost, r.t.currency) : ""}</span>
                    </>
                  ) : (
                    <>
                      <span className="ud-bar ud-nodata">{t("无数据")}</span>
                      <span className="ud-num muted">—</span>
                      <span className="ud-cost" />
                    </>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

function Stat(p: { label: string; value: string; sub?: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="ud-stat" data-strong={p.strong || undefined}>
      <span className="ud-stat-label">{p.label}</span>
      <span className={`ud-stat-value ${p.muted ? "muted" : ""}`}>{p.value}</span>
      <span className="ud-stat-sub">{p.sub ?? "\u00a0"}</span>
    </div>
  );
}

/** Daily stacked bars (input / output / cache); empty days are drawn as gaps, not guesses. */
function Trend({ days, since }: { days: UsageStatsView["daily"]; since: number }) {
  const { t } = useI18n();
  const today = startOfToday();
  const first = since || (days[0] ? new Date(`${days[0].day}T00:00:00`).getTime() : today);
  const n = Math.min(90, Math.max(1, Math.round((today - first) / DAY) + 1));
  const by = new Map(days.map((d) => [d.day, d]));
  const series = Array.from({ length: n }, (_, i) => {
    const t = today - (n - 1 - i) * DAY;
    const d = by.get(localDay(t));
    return { t, d };
  });
  const max = Math.max(1, ...series.map((s) => s.d?.total ?? 0));
  const W = 100 / n;
  return (
    <div className="ud-trend" role="img" aria-label={t("每日 Token 趋势")}>
      <div className="ud-trend-plot">
        {series.map(({ t, d }) => {
          const h = d ? (d.total / max) * 100 : 0;
          const date = new Date(t);
          return (
            <div
              key={t}
              className="ud-col"
              style={{ width: `${W}%` }}
              title={
                d
                  ? `${date.getMonth() + 1}/${date.getDate()} · ${fmtTokens(d.total)}`
                  : `${date.getMonth() + 1}/${date.getDate()} · 0`
              }
            >
              <div className="ud-stack" style={{ height: `${h}%` }}>
                {d && (
                  <>
                    <i data-k="cache" style={{ flex: d.cache }} />
                    <i data-k="output" style={{ flex: d.output }} />
                    <i data-k="input" style={{ flex: d.input }} />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="ud-trend-axis">
        <span>{fmtDay(series[0]?.t ?? today)}</span>
        <span>{t("峰值 {count}", { count: fmtTokens(max === 1 ? 0 : max) })}</span>
        <span>{t("今天")}</span>
      </div>
    </div>
  );
}
const fmtDay = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
