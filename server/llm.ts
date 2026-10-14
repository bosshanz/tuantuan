import { type AppConfig, type ModelConfig, resolveApiKey } from "./config";
import { mockChat } from "./mock";

/** OpenAI chat-completions message shape; the single wire format for every provider. */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Ask for a JSON object response (used by the router classifier). */
  json?: boolean;
  signal?: AbortSignal;
  /** Called for every streamed content fragment. */
  onDelta?: (text: string) => void;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

/**
 * A provider failure that happened before any content was streamed, so the
 * caller may safely retry the same request on another model.
 */
export class ProviderError extends Error {
  constructor(
    readonly modelId: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export async function chat(config: AppConfig, model: ModelConfig, req: ChatRequest): Promise<ChatResult> {
  const provider = config.providers.find((p) => p.id === model.provider);
  if (!provider) throw new ProviderError(model.id, `provider ${model.provider} 未配置`);
  if (provider.type === "mock") return mockChat(model, req);
  let apiKey: string;
  try {
    apiKey = resolveApiKey(provider);
  } catch (e) {
    throw new ProviderError(model.id, (e as Error).message);
  }
  return openaiChat(provider.baseUrl, apiKey, model, req);
}

async function openaiChat(baseUrl: string, apiKey: string, model: ModelConfig, req: ChatRequest): Promise<ChatResult> {
  const body: Record<string, unknown> = { model: model.model, messages: req.messages, stream: true };
  if (req.tools?.length) body.tools = req.tools;
  if (req.json) body.response_format = { type: "json_object" };
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (e) {
    if (req.signal?.aborted) throw e;
    throw new ProviderError(model.id, `请求失败: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(model.id, `HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  return readSseStream(res.body, model.id, req.onDelta);
}

/** Parses an OpenAI-style SSE stream, accumulating content and indexed tool-call fragments. */
export async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  modelId: string,
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const calls = new Map<number, ToolCall>();
  let sawDone = false;
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        sawDone = true;
        continue;
      }
      let event: {
        error?: { message?: string };
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
      };
      try {
        event = JSON.parse(data);
      } catch {
        throw new Error(`${modelId} 返回了无法解析的流事件: ${data.slice(0, 200)}`);
      }
      if (event.error) throw new Error(`${modelId} 流中返回错误: ${event.error.message ?? "unknown"}`);
      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
  }
  if (!sawDone && content === "" && calls.size === 0) throw new ProviderError(modelId, "流在返回任何内容前结束");
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }));
  return { content, toolCalls };
}
