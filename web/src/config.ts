import type * as acp from "@agentclientprotocol/sdk";
import { translate } from "./i18n";

/** One ACP session setting (config option or legacy mode), normalized for chips / pickers. */
export type OptKind = "model" | "mode" | "effort" | "thinking" | "other";

export interface OptChoice {
  value: string;
  /** Harness-provided name. */
  name: string;
  /** Short localized label (falls back to the harness name). */
  label: string;
  description: string | null;
  danger: boolean;
  recommended: boolean;
}

export interface Opt {
  /** configId, or "__mode" for the legacy session/set_mode API. */
  id: string;
  kind: OptKind;
  /** Short localized label. */
  label: string;
  /** Harness name of the option (tooltip). */
  name: string;
  description: string | null;
  type: "select" | "boolean";
  current: string;
  choices: OptChoice[];
}

export function optKind(o: { id: string; category?: string | null; name?: string }): OptKind {
  const id = o.id.toLowerCase();
  const cat = (o.category ?? "").toLowerCase();
  if (cat === "model" || id === "model") return "model";
  if (cat === "mode" || id === "mode" || id.includes("permission") || id.includes("approval")) return "mode";
  if (cat === "thought_level" || /effort|reasoning/.test(id)) return "effort";
  if (/think/.test(id)) return "thinking";
  return "other";
}

const KIND_LABEL: Record<OptKind, string> = {
  model: "模型",
  mode: "权限",
  effort: "推理",
  thinking: "思考",
  other: "",
};
const ID_LABEL: Record<string, string> = {
  fast: "快速模式",
  fast_mode: "快速模式",
  "fast-mode": "快速模式",
  collaboration_mode: "协作模式",
  verbosity: "详细度",
  sandbox: "沙箱",
};

const VALUES: Record<string, Record<string, string>> = {
  mode: {
    default: "询问",
    manual: "询问",
    ask: "询问",
    acceptedits: "自动改文件",
    plan: "计划",
    auto: "自动",
    bypasspermissions: "全部允许",
    "read-only": "只读",
    readonly: "只读",
    "full-access": "完全访问",
    "agent-full-access": "完全访问",
    "danger-full-access": "完全访问",
    yolo: "全部允许",
  },
  effort: {
    default: "默认",
    none: "无",
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
  },
  bool: { on: "开", off: "关", true: "开", false: "关", enabled: "开", disabled: "关" },
  collaboration_mode: { default: "默认", plan: "计划" },
};

const DANGER = new Set([
  "bypasspermissions",
  "danger-full-access",
  "full-access",
  "agent-full-access",
  "yolo",
  "dangerously-skip-permissions",
]);

export function choiceLabel(kind: OptKind, value: string, name: string): string {
  const v = value.toLowerCase();
  if (kind === "model") {
    const label = name.replace(/\s*\((recommended|推荐)\)\s*/i, "");
    return /^default$/i.test(label) ? translate("默认") : label || value;
  }
  // Some adapters use a native effort ID for an on/off control. Keep its explicit
  // meaning instead of translating that transport ID into a fabricated intensity.
  const switchLabel = (kind === "effort" || kind === "thinking") && VALUES.bool?.[name.toLowerCase()];
  if (switchLabel) return translate(switchLabel);
  const table = kind === "mode" ? VALUES.mode : kind === "effort" ? VALUES.effort : undefined;
  const label = table?.[v] ?? VALUES.bool?.[v];
  return label ? translate(label) : name;
}

function flatChoices(o: acp.SessionConfigOption): { value: string; name: string; description?: string | null }[] {
  if (o.type !== "select") return [];
  const out: { value: string; name: string; description?: string | null }[] = [];
  for (const x of o.options as unknown[]) {
    const g = x as { options?: { value: string; name: string; description?: string | null }[]; value?: string };
    if (g.options) out.push(...g.options);
    else if (g.value !== undefined) out.push(x as { value: string; name: string; description?: string | null });
  }
  return out;
}

function choice(kind: OptKind, c: { value: string; name: string; description?: string | null }, id = ""): OptChoice {
  const collaborationLabel = VALUES.collaboration_mode?.[c.value];
  return {
    value: c.value,
    name: c.name,
    label:
      id === "collaboration_mode"
        ? collaborationLabel
          ? translate(collaborationLabel)
          : c.name
        : choiceLabel(kind, c.value, c.name),
    description: c.description ?? null,
    danger: DANGER.has(c.value.toLowerCase()),
    recommended: /recommended|推荐/i.test(c.name),
  };
}

/** All settings from a session's config options (+ legacy modes when there is no mode option). */
export function describeOptions(configOptions: acp.SessionConfigOption[], modes?: acp.SessionModeState | null): Opt[] {
  const out: Opt[] = [];
  for (const o of configOptions) {
    const kind = optKind(o);
    const knownLabel = KIND_LABEL[kind] || ID_LABEL[o.id.toLowerCase()];
    const label = knownLabel ? translate(knownLabel) : o.name;
    if (o.type === "select") {
      const choices = flatChoices(o).map((c) => choice(kind, c, o.id));
      // two-valued on/off selects read like switches
      out.push({
        id: o.id,
        kind,
        label,
        name: o.name,
        description: o.description ?? null,
        type: "select",
        current: String(o.currentValue),
        choices,
      });
    } else if (o.type === "boolean") {
      out.push({
        id: o.id,
        kind,
        label,
        name: o.name,
        description: o.description ?? null,
        type: "boolean",
        current: String(o.currentValue),
        choices: [choice(kind, { value: "true", name: "On" }), choice(kind, { value: "false", name: "Off" })],
      });
    }
  }
  if (modes && !out.some((o) => o.kind === "mode"))
    out.unshift({
      id: "__mode",
      kind: "mode",
      label: translate("权限"),
      name: "Mode",
      description: null,
      type: "select",
      current: modes.currentModeId,
      choices: modes.availableModes.map((m) =>
        choice("mode", { value: m.id, name: m.name, description: m.description }),
      ),
    });
  // model first, then mode, effort, thinking, the rest
  const rank: Record<OptKind, number> = { model: 0, mode: 1, effort: 2, thinking: 3, other: 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

export function currentChoice(o: Opt): OptChoice | undefined {
  return o.choices.find((c) => c.value === o.current);
}

/** "Opus · 推理 高" style summary of an agent's saved defaults (raw values, localized where known). */
export function defaultsSummary(d: Record<string, string> | undefined): string[] {
  if (!d) return [];
  const out: string[] = [];
  for (const [id, v] of Object.entries(d)) {
    const kind = optKind({ id });
    if (kind === "model") out.unshift(choiceLabel("model", v, v));
    else if (kind === "effort") out.push(translate("推理 {level}", { level: choiceLabel("effort", v, v) }));
  }
  return out;
}

/** Sidebar subtitle: short harness name · friendly model; drops internal ids like builtin:… */
export function agentSubtitle(harness: string, d: Record<string, string> | undefined): string {
  const h = harness.replace(/\s*[（(].*?[）)]\s*/g, "").trim();
  const model = Object.entries(d ?? {})
    .filter(([id]) => optKind({ id }) === "model")
    .reverse()
    .map(
      ([, value]) =>
        choiceLabel("model", value, value)
          .replace(/^builtin:/i, "")
          .split(/[/:]/)
          .pop() ?? "",
    )
    .find((value) => value && value.length <= 24);
  return model ? `${h} · ${model}` : h;
}
