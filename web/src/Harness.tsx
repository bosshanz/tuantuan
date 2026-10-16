import type * as acp from "@agentclientprotocol/sdk";
import {
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  FileDiff,
  FileText,
  Globe,
  Loader2,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { Timeline, ToolState } from "../../shared/timeline";
import type { PermissionAsk, SessionView, TerminalSnapshot } from "./api";
import { PreviewImage } from "./ImagePreview";
import { intlLocale, useI18n } from "./i18n";
import { MessageMarkdown } from "./ui";

/** Renders one agent reply: thoughts, text, tool calls (diff / terminal / content) and the plan. */
export function TimelineView(props: {
  t: Timeline;
  streaming: boolean;
  terminals: Record<string, TerminalSnapshot>;
  mentionNames: string[];
}) {
  const { t: tr } = useI18n();
  const { t } = props;
  const lastText = t.parts.findLastIndex((p) => p.kind === "text");
  return (
    <div className="timeline">
      {t.plan && t.plan.length > 0 && <PlanList entries={t.plan} />}
      {t.parts.map((p, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only
        const key = i;
        if (p.kind === "thought")
          return (
            <details key={key} className="thought" open={props.streaming && i === t.parts.length - 1}>
              <summary>
                <ChevronRight size={13} className="chev" />
                <Brain size={13} />
                <span>{props.streaming && i === t.parts.length - 1 ? tr("思考中…") : tr("思考过程")}</span>
              </summary>
              <div className="thought-body">{p.text}</div>
            </details>
          );
        if (p.kind === "tool") {
          const tool = t.tools[p.toolCallId];
          return tool ? <ToolCard key={key} tool={tool} terminals={props.terminals} /> : null;
        }
        if (p.kind === "image")
          return <PreviewImage key={key} src={`data:${p.mimeType};base64,${p.data}`} alt={tr("图片")} />;
        return (
          <div
            key={key}
            className={props.streaming && i === lastText && i === t.parts.length - 1 ? "caret-wrap" : undefined}
          >
            <MessageMarkdown text={p.text} mentionNames={props.mentionNames} />
          </div>
        );
      })}
    </div>
  );
}

const KIND_ICON: Record<string, typeof Wrench> = {
  read: FileText,
  edit: FileDiff,
  delete: Trash2,
  search: Search,
  execute: SquareTerminal,
  fetch: Globe,
  think: Brain,
};

export function ToolCard(props: {
  tool: ToolState;
  terminals: Record<string, TerminalSnapshot>;
  /** Permission prompts show what is being approved. */
  defaultOpen?: boolean;
}) {
  const { tool } = props;
  const Icon = KIND_ICON[tool.kind] ?? Wrench;
  // Only content we can actually show; a terminal we have no snapshot for is dropped, never a black box.
  const body = tool.content.filter((c) => c.type !== "terminal" || props.terminals[c.terminalId]);
  const hasBody = body.length > 0 || (tool.content.length === 0 && tool.rawInput !== undefined);
  const live = tool.status === "pending" || tool.status === "in_progress";
  const args = tool.locations.map((l) => shortPath(l.path)).join(", ");
  const full = [tool.title, args].filter(Boolean).join("  ");
  const head = (
    <>
      {hasBody ? <ChevronRight size={14} className="chev" /> : <span className="chev-pad" />}
      <Icon size={13} />
      <span className="tool-name" title={full}>
        {tool.title}
      </span>
      {args && <span className="tool-args">{args}</span>}
      <ToolStatus status={tool.status} live={live} />
    </>
  );
  if (!hasBody)
    return (
      <div className="tool tool-flat" data-kind={tool.kind}>
        <div className="tool-row">{head}</div>
      </div>
    );
  return (
    <details className="tool" data-kind={tool.kind} open={props.defaultOpen || undefined}>
      <summary>{head}</summary>
      <div className="tool-body">
        {body.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: content order is stable per update
          <ToolContent key={i} c={c} terminals={props.terminals} />
        ))}
        {tool.content.length === 0 && tool.rawInput !== undefined && (
          <pre>{JSON.stringify(tool.rawInput, null, 2)}</pre>
        )}
      </div>
    </details>
  );
}

function ToolContent({ c, terminals }: { c: acp.ToolCallContent; terminals: Record<string, TerminalSnapshot> }) {
  const { t: tr } = useI18n();
  if (c.type === "diff") return <DiffView path={c.path} oldText={c.oldText ?? null} newText={c.newText} />;
  if (c.type === "terminal") return <TerminalView t={terminals[c.terminalId]} />;
  const b = c.content;
  if (b.type === "text") return <pre>{b.text}</pre>;
  if (b.type === "image") return <PreviewImage src={`data:${b.mimeType};base64,${b.data}`} alt={tr("工具图片")} />;
  if (b.type === "resource_link") return <code>{b.uri}</code>;
  return <pre>{JSON.stringify(b, null, 2)}</pre>;
}

function ToolStatus({ status, live }: { status: string; live: boolean }) {
  const { t: tr } = useI18n();
  if (live)
    return (
      <span className="tool-status running">
        <Loader2 size={12} className="spin" />
        {status === "pending" ? tr("等待") : tr("执行中")}
      </span>
    );
  if (status === "completed")
    return (
      <span className="tool-status ok">
        <Check size={12} />
        {tr("完成")}
      </span>
    );
  return (
    <span className="tool-status error">
      <X size={12} />
      {tr("失败")}
    </span>
  );
}

function shortPath(p: string) {
  const parts = p.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

type DiffLine = { op: " " | "+" | "-"; text: string };

/** Line diff (LCS). Big inputs fall back to showing old and new blocks to stay cheap. */
export function diffLines(a: string, b: string): DiffLine[] | null {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 400_000) return null;
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (L[i] as Uint32Array)[j] =
        x[i] === y[j]
          ? ((L[i + 1] as Uint32Array)[j + 1] as number) + 1
          : Math.max((L[i + 1] as Uint32Array)[j] as number, (L[i] as Uint32Array)[j + 1] as number);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", text: x[i] as string });
      i++;
      j++;
    } else if (((L[i + 1] as Uint32Array)[j] as number) >= ((L[i] as Uint32Array)[j + 1] as number))
      out.push({ op: "-", text: x[i++] as string });
    else out.push({ op: "+", text: y[j++] as string });
  }
  while (i < n) out.push({ op: "-", text: x[i++] as string });
  while (j < m) out.push({ op: "+", text: y[j++] as string });
  return out;
}

export function DiffView(props: { path: string; oldText: string | null; newText: string }) {
  const { t: tr } = useI18n();
  const lines = diffLines(props.oldText ?? "", props.newText);
  return (
    <div className="diff">
      <div className="diff-head">
        <FileDiff size={12} />
        <span>{props.path}</span>
        {props.oldText === null && <span className="badge ok">{tr("新文件")}</span>}
      </div>
      <pre className="diff-body">
        {lines
          ? lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static rendering of a diff
              <span key={i} className="diff-line" data-op={l.op}>
                <i>{l.op}</i>
                {l.text}
                {"\n"}
              </span>
            ))
          : props.newText}
      </pre>
    </div>
  );
}

export function TerminalView({ t }: { t?: TerminalSnapshot }) {
  const { t: tr } = useI18n();
  const ref = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow output
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [t?.output]);
  if (!t) return <pre className="term">{tr("（终端输出不可用）")}</pre>;
  return (
    <div className="term-wrap">
      <div className="term-head">
        <SquareTerminal size={12} />
        <code>{t.command}</code>
        {t.exitStatus ? (
          <span className={t.exitStatus.exitCode === 0 ? "badge ok" : "badge danger"}>
            {t.exitStatus.signal
              ? tr("信号 {signal}", { signal: t.exitStatus.signal })
              : tr("退出 {code}", { code: t.exitStatus.exitCode ?? "" })}
          </span>
        ) : (
          <Loader2 size={12} className="spin" />
        )}
      </div>
      <pre ref={ref} className="term">
        {t.truncated && "…\n"}
        {t.output || " "}
      </pre>
    </div>
  );
}

export function PlanList({ entries }: { entries: acp.PlanEntry[] }) {
  const { t: tr } = useI18n();
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <div className="plan">
      <div className="plan-head">
        {tr("计划")}{" "}
        <span className="muted">
          {done}/{entries.length}
        </span>
      </div>
      <ul aria-label={tr("计划")}>
        {entries.map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: plan entries are replaced wholesale
          <li key={i} className="plan-item" data-status={e.status}>
            {e.status === "completed" ? (
              <Check size={13} />
            ) : e.status === "in_progress" ? (
              <CircleDot size={13} />
            ) : (
              <Circle size={13} />
            )}
            <span>{e.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The agent asks before acting; options come from the harness (allow once / always / reject…). */
export function PermissionDialog(props: {
  ask: PermissionAsk;
  agentName: string;
  terminals: Record<string, TerminalSnapshot>;
  pending: boolean;
  error: string | null;
  onAnswer: (optionId: string | null) => void;
}) {
  const { t: tr } = useI18n();
  const { ask } = props;
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const tool: ToolState = {
    toolCallId: ask.toolCall.toolCallId,
    title: ask.toolCall.title ?? tr("工具调用"),
    kind: ask.toolCall.kind ?? "other",
    status: "pending",
    content: ask.toolCall.content ?? [],
    locations: ask.toolCall.locations ?? [],
    rawInput: ask.toolCall.rawInput,
  };
  const order = ["allow_once", "allow_always", "reject_once", "reject_always"];
  const options = [...ask.options].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <div className="overlay perm-overlay">
      <div
        className="palette perm"
        role="alertdialog"
        aria-modal="true"
        aria-label={tr("{name} 请求授权", { name: props.agentName })}
        aria-busy={props.pending}
        onKeyDown={(e) =>
          e.key === "Escape" &&
          !props.pending &&
          props.onAnswer(options.find((o) => o.kind === "reject_once")?.optionId ?? null)
        }
      >
        <div className="perm-head">
          <ShieldQuestion size={18} />
          <div>{tr("{name} 想要：{action}", { name: props.agentName, action: tool.title })}</div>
        </div>
        <div className="perm-body">
          {tool.content.length > 0 || tool.rawInput !== undefined ? (
            <ToolCard tool={tool} terminals={props.terminals} defaultOpen />
          ) : null}
        </div>
        {props.error && (
          <div className="form-error" role="alert">
            {props.error}
          </div>
        )}
        <div className="perm-actions">
          {options.map((o, i) => (
            <button
              key={o.optionId}
              ref={i === 0 ? first : undefined}
              type="button"
              disabled={props.pending}
              className={o.kind.startsWith("allow") ? (o.kind === "allow_once" ? "btn primary" : "btn") : "btn danger"}
              onClick={() => props.onAnswer(o.optionId)}
            >
              {o.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Context window usage (and cost) of one agent's session, as a compact meter. */
export function CtxUsage({ view }: { view: SessionView }) {
  const { t: tr, locale } = useI18n();
  const pct = view.usage && view.usage.size > 0 ? Math.min(100, (view.usage.used / view.usage.size) * 100) : null;
  if (pct === null || !view.usage) return null;
  return (
    <span
      className="ctx-usage"
      title={tr("上下文 {used} / {size} token{cost}", {
        used: view.usage.used.toLocaleString(intlLocale(locale)),
        size: view.usage.size.toLocaleString(intlLocale(locale)),
        cost: view.usage.cost
          ? ` · ${view.usage.cost.currency === "USD" ? "$" : ""}${view.usage.cost.amount.toLocaleString(intlLocale(locale), { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`
          : "",
      })}
    >
      <span className="ctx-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      {Math.round(pct)}%
    </span>
  );
}

function flatOptions(o: acp.SessionConfigOption): { value: string; name: string }[] {
  if (o.type !== "select") return [];
  const out: { value: string; name: string }[] = [];
  for (const x of o.options as unknown[]) {
    const g = x as { options?: { value: string; name: string }[]; value?: string; name: string };
    if (g.options) out.push(...g.options);
    else if (g.value !== undefined) out.push({ value: g.value, name: g.name });
  }
  return out;
}
