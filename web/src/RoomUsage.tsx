import { useEffect, useState } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import { fmtTokens } from "./UsageDashboard";

interface RoomUsageView {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thought: number;
  total: number;
  cost: number | null;
  currency: string | null;
  reporting: boolean;
}

const fmtCost = (c: number, cur: string | null) =>
  `${cur === "USD" || !cur ? "$" : `${cur} `}${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`;

/** Session-level totals from usage_log for multi-agent rooms. Unreported stays「未上报」, never 0. */
export function RoomUsage(props: { roomId: string; revision: string }) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<RoomUsageView | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes after completed turns
  useEffect(() => {
    let live = true;
    api<RoomUsageView>("GET", `/api/rooms/${encodeURIComponent(props.roomId)}/usage`)
      .then((body) => {
        if (live) setUsage(body);
      })
      .catch(() => {
        if (live) setUsage(null);
      });
    return () => {
      live = false;
    };
  }, [props.roomId, props.revision]);

  if (!usage) return null;
  if (!usage.reporting) {
    return (
      <span className="room-usage" data-empty title={t("本会话用量未上报")}>
        {t("未上报")}
      </span>
    );
  }
  const title =
    usage.cost !== null
      ? t("本会话花费 {cost}", { cost: fmtCost(usage.cost, usage.currency) })
      : t("本会话 {tokens} · {turns} 轮", { tokens: fmtTokens(usage.total), turns: usage.turns });
  return (
    <span className="room-usage" title={title}>
      {t("本会话 {tokens} · {turns} 轮", { tokens: fmtTokens(usage.total), turns: usage.turns })}
      {usage.cost !== null ? ` · ${fmtCost(usage.cost, usage.currency)}` : ""}
    </span>
  );
}
