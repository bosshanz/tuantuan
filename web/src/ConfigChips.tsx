import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gauge,
  LoaderCircle,
  MoreHorizontal,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Agent, SessionView } from "./api";
import { currentChoice, describeOptions, type Opt, type OptKind } from "./config";
import { BrandLogo, brandFor } from "./ModelPicker";
import { AgentAvatar } from "./ui";

// ---------------------------------------------------------------------------------------------
// Popover: portaled to <body>, anchored to its trigger, opens upward (flips down when there is no
// room), clamped inside the viewport so nothing gets clipped by scrolling columns.

export function Popover(props: {
  anchor: HTMLElement | null;
  onClose: () => void;
  label: string;
  width?: number;
  align?: "start" | "end";
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number; origin: string } | null>(null);
  const { anchor, onClose } = props;
  const place = useCallback(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.scrollHeight;
    const gap = 8;
    const above = r.top - gap - 8;
    const below = window.innerHeight - r.bottom - gap - 8;
    const up = above >= Math.min(h, 240) || above >= below;
    const maxHeight = Math.max(120, Math.min(420, up ? above : below));
    const shown = Math.min(h, maxHeight);
    let left = props.align === "end" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const top = up ? r.top - gap - shown : r.bottom + gap;
    const origin = `${up ? "bottom" : "top"} ${props.align === "end" ? "right" : "left"}`;
    setPos((p) =>
      p &&
      Math.abs(p.left - left) < 0.5 &&
      Math.abs(p.top - top) < 0.5 &&
      p.maxHeight === maxHeight &&
      p.origin === origin
        ? p
        : { left, top, maxHeight, origin },
    );
  }, [anchor, props.align]);
  useLayoutEffect(() => {
    place();
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Drilling into an option changes a child's state without rendering this popover again.
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [place]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, onClose, place]);
  return createPortal(
    <div
      ref={ref}
      className="pop-menu"
      role="dialog"
      aria-label={props.label}
      style={{
        width: props.width ?? 280,
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        maxHeight: pos?.maxHeight,
        transformOrigin: pos?.origin,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------

const KIND_ICON: Record<OptKind, typeof Gauge> = {
  model: SlidersHorizontal,
  mode: ShieldCheck,
  effort: Gauge,
  thinking: Brain,
  other: SlidersHorizontal,
};

export function OptIcon({ opt, harness, value }: { opt: Opt; harness: string; value?: string }) {
  if (opt.kind === "model") {
    const v = value ?? opt.current;
    const c = opt.choices.find((x) => x.value === v);
    return <BrandLogo brand={brandFor(v, harness, c ? `${c.name} ${c.description ?? ""}` : null)} />;
  }
  const I = KIND_ICON[opt.kind];
  return <I size={13} className="opt-icon" aria-hidden />;
}

/** The choices of one option: name, harness description, check, danger tint. */
export function ChoiceList(props: {
  opt: Opt;
  harness: string;
  onPick: (value: string) => void;
  busy?: boolean;
  /** Extra value to mark (agent default when editing defaults). */
  hint?: { value: string; text: string } | null;
  free?: { placeholder: string } | null;
}) {
  const { opt } = props;
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      opt.choices.findIndex((c) => c.value === opt.current),
    ),
  );
  const [text, setText] = useState("");
  useEffect(() => {
    requestAnimationFrame(() => list.current?.focus());
  }, []);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(opt.choices.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      const c = opt.choices[active];
      if (c) {
        e.preventDefault();
        props.onPick(c.value);
      }
    }
  };
  return (
    <>
      <div
        ref={list}
        role="listbox"
        tabIndex={-1}
        aria-label={opt.label || opt.name}
        aria-activedescendant={`${id}-${active}`}
        className="opt-list"
        onKeyDown={onKey}
      >
        {opt.choices.map((c, i) => (
          <button
            type="button"
            key={c.value}
            id={`${id}-${i}`}
            data-i={i}
            role="option"
            aria-selected={c.value === opt.current}
            data-active={i === active || undefined}
            data-danger={c.danger || undefined}
            className="opt-row"
            title={c.description ? `${c.name} — ${c.description}` : c.name}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(c.value)}
          >
            {opt.kind === "model" ? (
              <BrandLogo brand={brandFor(c.value, props.harness, `${c.name} ${c.description ?? ""}`)} />
            ) : c.danger ? (
              <AlertTriangle size={13} className="opt-icon" aria-hidden />
            ) : null}
            <span className="opt-text">
              <span className="opt-name">
                {c.label}
                {c.label !== c.name && opt.kind !== "model" && <span className="opt-orig">{c.name}</span>}
              </span>
              {c.description && c.description !== c.name && <span className="opt-desc">{c.description}</span>}
            </span>
            {c.recommended && <span className="opt-tag">推荐</span>}
            {props.hint?.value === c.value && <span className="opt-tag">{props.hint.text}</span>}
            <Check size={14} className="opt-check" aria-hidden />
          </button>
        ))}
      </div>
      {props.free && (
        <form
          className="opt-free"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) props.onPick(text.trim());
          }}
        >
          <input
            className="input"
            aria-label={`${opt.label} ID`}
            placeholder={props.free.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            spellCheck={false}
          />
        </form>
      )}
      {props.busy && (
        <div className="opt-busy">
          <LoaderCircle size={13} className="spin" />
        </div>
      )}
    </>
  );
}

/** Options for one member's session (BYOK model is free text). */
export function memberOpts(view: SessionView | undefined): (Opt & { free?: boolean })[] | null {
  if (!view) return null;
  if (view.customModel) {
    const v = view.customModel.value;
    const vals = [...new Set([v, view.customModel.default].filter(Boolean))];
    return [
      {
        id: "model",
        kind: "model",
        label: "模型",
        name: "Model",
        description: null,
        type: "select",
        current: v,
        choices: vals.map((x) => ({
          value: x,
          name: x,
          label: x,
          description: x === view.customModel?.default ? "Agent 默认" : null,
          danger: false,
          recommended: false,
        })),
        free: true,
      },
    ];
  }
  return describeOptions(view.configOptions, view.modes);
}

function chipText(o: Opt) {
  const c = currentChoice(o);
  return c?.label ?? o.current;
}

/** One chip: icon + short label + value, opening the option's choice list. */
function OptionChip(props: {
  agent: Agent;
  opt: Opt & { free?: boolean };
  onPick: (agentId: string, opt: Opt, value: string) => Promise<void>;
}) {
  const { opt, agent } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const cur = currentChoice(opt);
  const pick = async (v: string) => {
    setBusy(true);
    try {
      await props.onPick(agent.id, opt, v);
    } finally {
      setBusy(false);
      setOpen(false);
      btn.current?.focus();
    }
  };
  const isModel = opt.kind === "model";
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={isModel ? "chip-opt model-trigger" : "chip-opt"}
        data-kind={opt.kind}
        data-open={open || undefined}
        data-danger={cur?.danger || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={opt.label || opt.name}
        title={`${opt.name}${cur ? ` · ${cur.name}` : ""}${opt.description ? `\n${opt.description}` : ""}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <OptIcon opt={opt} harness={agent.harness} />
        {!isModel && <span className="chip-label">{opt.label}</span>}
        <span className={isModel ? "model-name" : "chip-value"}>{chipText(opt)}</span>
        <ChevronDown size={12} className="model-chev" />
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)} label={opt.label || opt.name} align="start">
          <div className="pop-head">
            <span>{opt.label || opt.name}</span>
            {opt.label !== opt.name && <span className="pop-sub">{opt.name}</span>}
          </div>
          <ChoiceList
            opt={opt}
            harness={agent.harness}
            busy={busy}
            onPick={(v) => void pick(v)}
            free={opt.free ? { placeholder: "其他模型 ID" } : null}
          />
        </Popover>
      )}
    </>
  );
}

/** A grouped panel: per-agent rows (label · value ›) that drill into the choice list. */
function OptionsPanel(props: {
  groups: { agent: Agent; opts: (Opt & { free?: boolean })[] | null }[];
  showAgents: boolean;
  onPick: (agentId: string, opt: Opt, value: string) => Promise<void>;
}) {
  const [drill, setDrill] = useState<{ agent: Agent; opt: Opt & { free?: boolean } } | null>(null);
  const [busy, setBusy] = useState(false);
  if (drill) {
    const live = props.groups.find((g) => g.agent.id === drill.agent.id)?.opts?.find((o) => o.id === drill.opt.id);
    const opt = live ?? drill.opt;
    return (
      <>
        <button type="button" className="pop-back" onClick={() => setDrill(null)}>
          <ChevronLeft size={14} />
          {props.showAgents && <AgentAvatar agent={drill.agent} size={16} />}
          <span>{props.showAgents ? `${drill.agent.name} · ${opt.label}` : opt.label}</span>
        </button>
        <ChoiceList
          opt={opt}
          harness={drill.agent.harness}
          busy={busy}
          free={opt.free ? { placeholder: "其他模型 ID" } : null}
          onPick={(v) => {
            setBusy(true);
            void props.onPick(drill.agent.id, opt, v).finally(() => {
              setBusy(false);
              setDrill(null);
            });
          }}
        />
      </>
    );
  }
  return (
    <div className="opt-panel">
      {props.groups.map((g) => (
        <div key={g.agent.id} className="opt-group">
          {props.showAgents && (
            <div className="opt-group-head">
              <AgentAvatar agent={g.agent} size={16} />
              <span>{g.agent.name}</span>
            </div>
          )}
          {g.opts === null ? (
            <div className="opt-empty">
              <LoaderCircle size={13} className="spin" />
              正在连接…
            </div>
          ) : g.opts.length === 0 ? (
            <div className="opt-empty">没有可调的设置</div>
          ) : (
            g.opts.map((o) => {
              const c = currentChoice(o);
              return (
                <button
                  key={o.id}
                  type="button"
                  className="opt-row opt-entry"
                  data-danger={c?.danger || undefined}
                  title={o.description ?? o.name}
                  onClick={() => setDrill({ agent: g.agent, opt: o })}
                >
                  <OptIcon opt={o} harness={g.agent.harness} />
                  <span className="opt-entry-label">{o.label}</span>
                  <span className="opt-entry-value">{chipText(o)}</span>
                  <ChevronRight size={14} className="muted" />
                </button>
              );
            })
          )}
        </div>
      ))}
    </div>
  );
}

function PanelChip(props: {
  label: string;
  icon: React.ReactNode;
  text?: string;
  groups: { agent: Agent; opts: (Opt & { free?: boolean })[] | null }[];
  showAgents: boolean;
  onPick: (agentId: string, opt: Opt, value: string) => Promise<void>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`chip-opt ${props.className ?? ""}`}
        data-open={open || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={props.label}
        title={props.label}
        onClick={() => setOpen((v) => !v)}
      >
        {props.icon}
        {props.text && <span className="chip-value">{props.text}</span>}
        {props.text && <ChevronDown size={12} className="model-chev" />}
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)} label={props.label} align="end" width={320}>
          <div className="pop-head">{props.label}</div>
          <OptionsPanel groups={props.groups} showAgents={props.showAgents} onPick={props.onPick} />
        </Popover>
      )}
    </>
  );
}

/**
 * Composer settings: model, permissions and reasoning stay visible when space allows; other
 * options live in the settings panel. Multi-agent conversations show one summary chip with per-agent
 * groups (each agent starts from its own defaults).
 */
export function SessionChips(props: {
  members: Agent[];
  sessions: Record<string, SessionView | undefined>;
  onPick: (agentId: string, opt: Opt, value: string) => Promise<void>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    const ro = new ResizeObserver(() => setWidth(host.clientWidth));
    ro.observe(host);
    setWidth(host.clientWidth);
    return () => ro.disconnect();
  }, []);
  const members = props.members.filter((a) => a.harness);
  const groups = useMemo(
    () => members.map((agent) => ({ agent, opts: memberOpts(props.sessions[agent.id]) })),
    [members, props.sessions],
  );
  if (members.length === 0) return null;

  if (members.length > 1) {
    return (
      <div className="chips" ref={root}>
        <PanelChip
          label="成员设置"
          className="chip-summary"
          icon={
            <span className="stack-avatars" aria-hidden>
              {members.slice(0, 3).map((a) => (
                <AgentAvatar key={a.id} agent={a} size={16} />
              ))}
            </span>
          }
          text="各自设置"
          groups={groups}
          showAgents
          onPick={props.onPick}
        />
      </div>
    );
  }

  const g = groups[0];
  if (!g) return null;
  if (g.opts === null)
    return (
      <div className="chips" ref={root}>
        <span className="chip-opt" aria-busy="true">
          <LoaderCircle size={13} className="spin" />
          <span className="chip-value muted">连接中</span>
        </span>
      </div>
    );
  const max = width >= 520 ? 3 : width >= 360 ? 2 : 1;
  const shown = g.opts.filter((o) => o.kind === "model" || o.kind === "mode" || o.kind === "effort").slice(0, max);
  const rest = g.opts.filter((o) => !shown.includes(o));
  return (
    <div className="chips" ref={root}>
      {shown.map((o) => (
        <OptionChip key={o.id} agent={g.agent} opt={o} onPick={props.onPick} />
      ))}
      {rest.length > 0 && (
        <PanelChip
          label="更多设置"
          className="chip-more"
          icon={<MoreHorizontal size={14} />}
          groups={[{ agent: g.agent, opts: rest }]}
          showAgents={false}
          onPick={props.onPick}
        />
      )}
    </div>
  );
}
