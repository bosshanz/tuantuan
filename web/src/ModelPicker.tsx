import type * as acp from "@agentclientprotocol/sdk";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Agent, SessionView } from "./api";
import { AgentAvatar } from "./ui";

/** Brand marks, drawn on a 16-unit grid in currentColor so they sit on any surface. */
type Brand = "anthropic" | "openai" | "xai" | "opencode" | "generic";

export function brandFor(model: string, harness: string): Brand {
  const m = model.toLowerCase();
  if (/^(claude|anthropic|sonnet|opus|haiku)/.test(m) || m.includes("claude")) return "anthropic";
  if (/^(gpt|o[1-9]|codex|openai|chatgpt)/.test(m) || m.includes("gpt")) return "openai";
  if (/^(grok|xai)/.test(m) || m.includes("grok")) return "xai";
  if (harness === "claude-code") return "anthropic";
  if (harness === "codex") return "openai";
  if (harness === "grok") return "xai";
  if (harness === "opencode") return "opencode";
  if (harness === "mock") return "generic";
  return "generic";
}

const BRAND_LABEL: Record<Brand, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  opencode: "OpenCode",
  generic: "自定义",
};

function glyph(brand: Brand) {
  switch (brand) {
    case "anthropic":
      return (
        <path
          fill="currentColor"
          d="M9.6 2.5h2.3L16 13.5h-2.3zM4.1 2.5h2.4l4.1 11h-2.3l-.9-2.4H3.2l-.8 2.4H0zm-.2 6.7h2.9L5.3 5.3z"
        />
      );
    case "openai":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
          <path d="M8 1.8a3 3 0 0 1 3 3v3.5L8 10 5 8.3V4.8a3 3 0 0 1 3-3Z" />
          <path d="M8 1.8a3 3 0 0 1 3 3v3.5L8 10 5 8.3V4.8a3 3 0 0 1 3-3Z" transform="rotate(120 8 8)" />
          <path d="M8 1.8a3 3 0 0 1 3 3v3.5L8 10 5 8.3V4.8a3 3 0 0 1 3-3Z" transform="rotate(240 8 8)" />
        </g>
      );
    case "xai":
      return (
        <path fill="currentColor" d="M2 2.5h2.6l3.1 4.4 3.2-4.4H14L9.2 9.1l4.9 4.4h-2.6L7.7 10 5 13.5H2l4.4-5.9z" />
      );
    case "opencode":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"
        />
      );
    default:
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          d="M5 3.5h6M5 12.5h6M8 3.5v9M3.5 6.5h9M3.5 9.5h9"
        />
      );
  }
}

export function BrandLogo({ brand, size = 14 }: { brand: Brand; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="img"
      aria-label={BRAND_LABEL[brand]}
      className={`brand-logo brand-${brand}`}
    >
      <title>{BRAND_LABEL[brand]}</title>
      {glyph(brand)}
    </svg>
  );
}

interface Choice {
  value: string;
  name: string;
  description?: string | null;
}

/** One conversation member's model control, or null when its harness exposes none. */
export interface ModelEntry {
  agent: Agent;
  /** Session not opened yet (or opening). */
  loading: boolean;
  configId: string | null;
  current: string;
  currentName: string;
  choices: Choice[];
  /** BYOK: free-text model, with the agent's saved default. */
  free: { default: string } | null;
}

function flat(o: acp.SessionConfigOption): Choice[] {
  if (o.type !== "select") return [];
  const out: Choice[] = [];
  for (const x of o.options as unknown[]) {
    const g = x as { options?: Choice[]; value?: string; name: string; description?: string | null };
    if (g.options) out.push(...g.options);
    else if (g.value !== undefined) out.push({ value: g.value, name: g.name, description: g.description });
  }
  return out;
}

export function modelEntry(agent: Agent, view: SessionView | undefined): ModelEntry | null {
  if (!agent.harness) return null;
  if (!view) return { agent, loading: true, configId: null, current: "", currentName: "", choices: [], free: null };
  if (view.customModel) {
    const v = view.customModel.value;
    return {
      agent,
      loading: false,
      configId: "model",
      current: v,
      currentName: v || "未设置",
      choices: [...new Set([v, view.customModel.default].filter(Boolean))].map((x) => ({ value: x, name: x })),
      free: { default: view.customModel.default },
    };
  }
  const o = view.configOptions.find((x) => x.type === "select" && (x.category === "model" || x.id === "model"));
  if (!o || o.type !== "select") return null;
  const choices = flat(o);
  const cur = String(o.currentValue);
  return {
    agent,
    loading: false,
    configId: o.id,
    current: cur,
    currentName: choices.find((c) => c.value === cur)?.name ?? cur,
    choices,
    free: null,
  };
}

/**
 * Compact model picker for the composer. One trigger; the menu lists each member's models
 * (one section per agent in multi-agent conversations). Hidden when no member exposes a model.
 */
export function ModelPicker(props: {
  entries: ModelEntry[];
  primaryId: string | null;
  onPick: (agentId: string, configId: string, value: string) => Promise<void>;
}) {
  const { entries } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();

  const primary = entries.find((e) => e.agent.id === props.primaryId) ?? entries[0];
  const rows = useMemo(() => entries.flatMap((e) => (e.loading ? [] : e.choices.map((c) => ({ e, c })))), [entries]);

  useEffect(() => {
    if (!open) return;
    const i = rows.findIndex((r) => r.e.agent.id === primary?.agent.id && r.c.value === primary?.current);
    setActive(Math.max(0, i));
    const onDoc = (ev: MouseEvent) => {
      if (!root.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    requestAnimationFrame(() => list.current?.focus());
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, rows, primary?.agent.id, primary?.current]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (entries.length === 0) return null;
  const allLoading = entries.every((e) => e.loading);

  const pick = async (e: ModelEntry, value: string) => {
    if (!e.configId || !value.trim()) return;
    setBusy(e.agent.id);
    try {
      await props.onPick(e.agent.id, e.configId, value.trim());
    } finally {
      setBusy(null);
    }
    setOpen(false);
    btn.current?.focus();
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      setOpen(false);
      btn.current?.focus();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (ev.key === "Home") {
      ev.preventDefault();
      setActive(0);
    } else if (ev.key === "End") {
      ev.preventDefault();
      setActive(rows.length - 1);
    } else if (ev.key === "Enter" || ev.key === " ") {
      const r = rows[active];
      if (r) {
        ev.preventDefault();
        void pick(r.e, r.c.value);
      }
    }
  };

  const brand = primary ? brandFor(primary.current, primary.agent.harness) : "generic";
  let i = -1;
  return (
    <div className="model-picker" ref={root}>
      <button
        ref={btn}
        type="button"
        className="model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label="模型"
        data-open={open || undefined}
        disabled={allLoading}
        title={primary && !primary.loading ? `${primary.agent.name} · ${primary.currentName}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(ev) => {
          if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            setOpen(true);
          }
        }}
      >
        {allLoading ? (
          <>
            <LoaderCircle size={13} className="spin" />
            <span className="model-name muted">模型</span>
          </>
        ) : (
          <>
            <BrandLogo brand={brand} />
            <span className="model-name">{primary?.loading ? "…" : primary?.currentName}</span>
            {entries.length > 1 && <span className="model-more">+{entries.length - 1}</span>}
          </>
        )}
        <ChevronDown size={13} className="model-chev" />
      </button>
      {open && (
        <div
          ref={list}
          id={id}
          role="listbox"
          tabIndex={-1}
          aria-label="选择模型"
          aria-activedescendant={`${id}-o${active}`}
          className="model-menu"
          onKeyDown={onKey}
        >
          {entries.map((e) => (
            <div key={e.agent.id} className="model-group">
              {entries.length > 1 && (
                <div className="model-group-head">
                  <AgentAvatar agent={e.agent} size={16} />
                  <span>{e.agent.name}</span>
                  {busy === e.agent.id && <LoaderCircle size={12} className="spin" />}
                </div>
              )}
              {e.loading ? (
                <div className="model-empty">
                  <LoaderCircle size={13} className="spin" />
                  正在连接…
                </div>
              ) : (
                e.choices.map((c) => {
                  i += 1;
                  const n = i;
                  const selected = c.value === e.current;
                  return (
                    <button
                      type="button"
                      key={c.value}
                      id={`${id}-o${n}`}
                      data-i={n}
                      role="option"
                      aria-selected={selected}
                      data-active={n === active || undefined}
                      className="model-option"
                      title={c.description ? `${c.name} — ${c.description}` : c.name}
                      onMouseEnter={() => setActive(n)}
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => void pick(e, c.value)}
                    >
                      <BrandLogo brand={brandFor(c.value, e.agent.harness)} />
                      <span className="model-option-name">{c.name}</span>
                      {c.value === e.free?.default && <span className="model-tag">默认</span>}
                      <Check size={14} className="model-check" aria-hidden />
                    </button>
                  );
                })
              )}
              {e.free && (
                <form
                  className="model-free"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    void pick(e, custom[e.agent.id] ?? "");
                  }}
                >
                  <input
                    className="input"
                    aria-label={`${e.agent.name} 模型 ID`}
                    placeholder="其他模型 ID"
                    value={custom[e.agent.id] ?? ""}
                    onChange={(ev) => setCustom((m) => ({ ...m, [e.agent.id]: ev.target.value }))}
                    onKeyDown={(ev) => ev.stopPropagation()}
                    spellCheck={false}
                  />
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
