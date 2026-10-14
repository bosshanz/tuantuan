import type { AppConfig } from "./config";
import type { ChatMessage } from "./llm";
import { type Attempt, chatWithFallback } from "./router";
import type { ToolRuntime } from "./tools";

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  status: "running" | "ok" | "error";
  result?: string;
  error?: string;
  /** Model iteration (0-based) that requested this call. */
  iteration: number;
}

export interface ToolLoopResult {
  content: string;
  toolCalls: ToolCallRecord[];
  attempts: Attempt[];
  /** Model that produced the final answer (or the last one used). */
  modelId?: string;
  /** "max_iterations": the model still wanted tools after the limit; content may be partial. */
  outcome: "completed" | "max_iterations";
}

const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * Standard function-calling loop: ask the model, run requested tools, feed results
 * back, repeat until the model answers without tools or the iteration limit is hit.
 * Tool failures are returned to the model as `{"error": ...}` instead of being hidden.
 */
export async function runToolLoop(opts: {
  config: AppConfig;
  candidates: string[];
  messages: ChatMessage[];
  tools: ToolRuntime;
  maxIterations: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onToolCalls?: (calls: ToolCallRecord[]) => void;
  /** Caller-owned so attempts survive when the loop throws. */
  attempts?: Attempt[];
}): Promise<ToolLoopResult> {
  const messages = [...opts.messages];
  const records: ToolCallRecord[] = [];
  const attempts: Attempt[] = opts.attempts ?? [];
  let modelIndex = 0;
  let content = "";
  for (let iteration = 0; iteration < opts.maxIterations; iteration++) {
    const { result, index } = await chatWithFallback(
      opts.config,
      opts.candidates,
      {
        messages,
        tools: opts.tools.specs.length > 0 ? opts.tools.specs : undefined,
        signal: opts.signal,
        onDelta: opts.onDelta,
      },
      attempts,
      modelIndex,
    );
    modelIndex = index;
    content += result.content;
    if (result.toolCalls.length === 0)
      return { content, toolCalls: records, attempts, modelId: opts.candidates[index], outcome: "completed" };

    messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const record: ToolCallRecord = {
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        status: "running",
        iteration,
      };
      records.push(record);
      opts.onToolCalls?.(records);
      let toolContent: string;
      try {
        const out = await opts.tools.execute(call.function.name, call.function.arguments, opts.signal);
        record.status = "ok";
        record.result = out.slice(0, MAX_TOOL_RESULT_CHARS);
        toolContent = record.result;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        record.status = "error";
        record.error = (e as Error).message;
        toolContent = JSON.stringify({ error: record.error });
      }
      opts.onToolCalls?.(records);
      messages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
    }
    if (content && !content.endsWith("\n")) {
      content += "\n";
      opts.onDelta?.("\n");
    }
  }
  return { content, toolCalls: records, attempts, modelId: opts.candidates[modelIndex], outcome: "max_iterations" };
}
