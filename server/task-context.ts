import type { TaskContext } from "../shared/timeline";

export const HANDOFF_MAX_CHARS = 16000;
const CONTEXT_MAX_CHARS = 4000;
const FIELD_MAX_CHARS = 2000;
const ARRAY_MAX_ITEMS = 20;

/** Shared by both tools; the MCP schema is descriptive, so calls also validate at runtime. */
export const taskContextSchema = {
  type: "object",
  properties: {
    goal: { type: "string", maxLength: FIELD_MAX_CHARS, description: "当前任务目标" },
    decisions: {
      type: "array",
      items: { type: "string", maxLength: FIELD_MAX_CHARS },
      maxItems: ARRAY_MAX_ITEMS,
      description: "已经确认的关键决定；没有时传 []",
    },
    pending: {
      type: "array",
      items: { type: "string", maxLength: FIELD_MAX_CHARS },
      maxItems: ARRAY_MAX_ITEMS,
      description: "尚未完成或待核实的事项；没有时传 []",
    },
  },
  required: ["goal", "decisions", "pending"],
  additionalProperties: false,
};

export function parseTaskContext(value: unknown): TaskContext {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("context 必须包含 goal、decisions、pending 三个字段");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["goal", "decisions", "pending"].includes(key)))
    throw new Error("context 只接受 goal、decisions、pending 三个字段");
  if (typeof record.goal !== "string" || record.goal.length > FIELD_MAX_CHARS)
    throw new Error(`goal 必须是最多 ${FIELD_MAX_CHARS} 字符的字符串`);
  const array = (name: "decisions" | "pending"): string[] => {
    const items = record[name];
    if (
      !Array.isArray(items) ||
      items.length > ARRAY_MAX_ITEMS ||
      items.some((item) => typeof item !== "string" || item.length > FIELD_MAX_CHARS)
    )
      throw new Error(`${name} 必须是最多 ${ARRAY_MAX_ITEMS} 条字符串的数组，每条最多 ${FIELD_MAX_CHARS} 字符`);
    return [...items];
  };
  const context = { goal: record.goal, decisions: array("decisions"), pending: array("pending") };
  if (JSON.stringify(context).length > CONTEXT_MAX_CHARS)
    throw new Error(`context 的完整 JSON 最多 ${CONTEXT_MAX_CHARS} 字符，请精简后重试；不会自动截断`);
  return context;
}

/** A bounded excerpt, not a semantic summary. The full text remains readable by message id. */
export function contextPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "…（中间已省略）…";
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : "");
}
