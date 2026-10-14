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
    // On a robot body, react with an expression and an action before speaking.
    if (available.has("robot_express") && available.has("robot_action")) {
      const cue = mockRobotCue(lastUser);
      calls.push(
        {
          id: "mock_robot_0",
          type: "function",
          function: { name: "robot_express", arguments: JSON.stringify({ expression: cue.expression }) },
        },
        {
          id: "mock_robot_1",
          type: "function",
          function: { name: "robot_action", arguments: JSON.stringify({ action: cue.action }) },
        },
      );
    }
    for (const [i, m] of [...lastUser.matchAll(/\[\[tool:([\w-]+)\s*(\{.*?\})?\]\]/g)].entries()) {
      const name = m[1] ?? "";
      if (!available.has(name)) missing.push(name);
      else calls.push({ id: `mock_call_${i}`, type: "function", function: { name, arguments: m[2] ?? "{}" } });
    }
    if (missing.length === 0 && calls.length > 0) return { content: "", toolCalls: calls };
    if (missing.length > 0) return stream(`我没有可用的工具：${missing.join("、")}。`, req);
  }

  // Robot body tools are side effects, not information: answer normally after them.
  const robotOnly = afterUser.every(
    (m) => m.role !== "assistant" || (m.tool_calls ?? []).every((c) => c.function.name.startsWith("robot_")),
  );
  if (toolResults.length > 0 && !robotOnly) {
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

/** Deterministic expression/action for a robot utterance (keyword based). */
export function mockRobotCue(text: string): { expression: string; action: string } {
  if (/跳舞|dance/i.test(text)) return { expression: "happy", action: "dance" };
  if (/你好|嗨|hello|hi\b/i.test(text)) return { expression: "happy", action: "wave" };
  if (/难过|伤心|失败|糟/.test(text)) return { expression: "sad", action: "shake_head" };
  if (/真的|居然|吗[?？]?$|[?？]$/.test(text)) return { expression: "surprised", action: "tilt" };
  if (/看看|周围|哪/.test(text)) return { expression: "neutral", action: "look_around" };
  return { expression: "happy", action: "nod" };
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
