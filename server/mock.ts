import { classifyByRules, type TaskSignals } from "./classify";
import type { ModelConfig } from "./config";
import { type ChatRequest, type ChatResult, ProviderError, type ToolCall } from "./llm";

/**
 * Deterministic fake LLM so the whole product runs and is testable without API keys.
 * It is driven by directives written in plain text:
 *   [[fail:<model>]]          in the latest user message: that mock model errors before streaming (tests fallback)
 *   [[tool:<name> <json>]]    in the latest user message: call that tool with the JSON arguments
 *   [[reply:<text>]]          in the agent system prompt: reply with exactly <text> (e.g. to @ other agents)
 * Otherwise it replies with a short acknowledgement naming the agent and model.
 */
export async function mockChat(model: ModelConfig, req: ChatRequest): Promise<ChatResult> {
  const lastUserIdx = findLastIndex(req.messages, (m) => m.role === "user");
  const lastUser = lastUserIdx >= 0 ? (req.messages[lastUserIdx]?.content as string) : "";

  for (const m of lastUser.matchAll(/\[\[fail:([\w.-]+)\]\]/g)) {
    if (m[1] === model.model) throw new ProviderError(model.id, `mock 模型 ${model.model} 按指令模拟失败`, 503);
  }

  if (req.json) {
    const signals = JSON.parse(lastUser) as TaskSignals;
    const c = classifyByRules(signals);
    return {
      content: JSON.stringify({ task_type: c.taskType, difficulty: c.difficulty, reason: "mock 分类器" }),
      toolCalls: [],
    };
  }

  const afterUser = req.messages.slice(lastUserIdx + 1);
  const toolResults = afterUser.filter((m) => m.role === "tool");
  const available = new Set((req.tools ?? []).map((t) => t.function.name));

  if (toolResults.length === 0) {
    const calls: ToolCall[] = [];
    const missing: string[] = [];
    for (const [i, m] of [...lastUser.matchAll(/\[\[tool:([\w-]+)\s*(\{.*?\})?\]\]/g)].entries()) {
      const name = m[1] ?? "";
      if (!available.has(name)) missing.push(name);
      else calls.push({ id: `mock_call_${i}`, type: "function", function: { name, arguments: m[2] ?? "{}" } });
    }
    if (calls.length > 0) return { content: "", toolCalls: calls };
    if (missing.length > 0) return stream(`我没有可用的工具：${missing.join("、")}。`, req);
  }

  if (toolResults.length > 0) {
    const summary = toolResults.map((m) => (m.role === "tool" ? m.content.slice(0, 200) : "")).join("；");
    return stream(`工具返回：${summary}`, req);
  }

  const system = req.messages.find((m) => m.role === "system")?.content ?? "";
  const scripted = /\[\[reply:([\s\S]*?)\]\]/.exec(system);
  if (scripted?.[1]) return stream(scripted[1], req);

  const name = /你的名字是「(.+?)」/.exec(system)?.[1] ?? "助手";
  const snippet = lastUser.replace(/^\[[^\]]*\]:\s*/, "").slice(0, 60);
  return stream(`我是 ${name}（mock/${model.model}），收到：「${snippet}」`, req);
}

async function stream(text: string, req: ChatRequest): Promise<ChatResult> {
  const delay = Number(process.env.MOCK_CHUNK_DELAY_MS ?? 15);
  const chunks = text.match(/[\s\S]{1,4}/g) ?? [];
  for (const chunk of chunks) {
    if (req.signal?.aborted) throw req.signal.reason ?? new DOMException("aborted", "AbortError");
    if (delay > 0) await Bun.sleep(delay);
    req.onDelta?.(chunk);
  }
  return { content: text, toolCalls: [] };
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i] as T)) return i;
  return -1;
}
