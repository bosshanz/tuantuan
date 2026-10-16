import { Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useI18n } from "./i18n";

export interface PickItem {
  id: string;
  title: string;
  description?: string;
  leading?: ReactNode;
  /** Render title in the UI font instead of monospace (for names, not identifiers). */
  plain?: boolean;
  invalid?: boolean;
  trailing?: ReactNode;
}

/** Searchable checkable list; used for tools, skills and room members. */
export function PickList(props: {
  groups: { label?: ReactNode; items: PickItem[]; footer?: ReactNode }[];
  selected: string[];
  onToggle: (id: string) => void;
  mode?: "multi" | "single";
  searchPlaceholder: string;
  emptyText: string;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const match = (i: PickItem) =>
    !s || i.title.toLowerCase().includes(s) || (i.description ?? "").toLowerCase().includes(s);
  const total = props.groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="pick-list">
      {total > 5 && (
        <div className="pick-search">
          <Search size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t(props.searchPlaceholder)}
            aria-label={t(props.searchPlaceholder)}
          />
        </div>
      )}
      {total === 0 && <div className="pick-empty">{t(props.emptyText)}</div>}
      {props.groups.map((g, gi) => {
        const items = g.items.filter(match);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: groups are static per render
          <div key={gi}>
            {g.label && <div className="pick-group">{g.label}</div>}
            {items.map((i) => (
              <label key={i.id} className="pick">
                <input
                  type={props.mode === "single" ? "radio" : "checkbox"}
                  name={props.mode === "single" ? "pick-single" : undefined}
                  checked={props.selected.includes(i.id)}
                  onChange={() => props.onToggle(i.id)}
                />
                {i.leading}
                <span className="pick-body">
                  <div className="pick-name" style={i.plain ? { fontFamily: "var(--font)", fontSize: 14 } : undefined}>
                    {i.title}
                  </div>
                  {i.description && <div className={`pick-desc ${i.invalid ? "error-text" : ""}`}>{i.description}</div>}
                </span>
                {i.trailing}
              </label>
            ))}
            {s && items.length === 0 && g.items.length > 0 && (
              <div className="pick-empty">{t("没有匹配「{query}」的项", { query: q })}</div>
            )}
            {g.footer}
          </div>
        );
      })}
    </div>
  );
}
