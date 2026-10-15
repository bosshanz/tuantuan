import type * as acp from "@agentclientprotocol/sdk";
import type { ToolDef } from "./tuantuan-mcp";

/**
 * BYOK「自定义」harness: chat-only, in-process. Talks to an OpenAI Chat Completions, OpenAI Responses
 * or Anthropic Messages endpoint over SSE and reports what it streams as ACP session updates, so the
 * rest of Tuantuan treats it like any ACP harness. Tuantuan tools (handoff / list_members) are offered
 * as native function tools and run through the same handlers as the MCP server. No fs / terminal.
 */
export const CUSTOM_HARNESS = "custom";
export const CUSTOM_FORMATS = ["openai-chat", "openai-responses", "anthropic"] as const;
export type CustomFormat = (typeof CUSTOM_FORMATS)[number];

export interface CustomSecret {
  format: CustomFormat;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const DEFAULT_BASE_URL: Record<CustomFormat, string> = {
  "openai-chat": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

/** What the browser may see of a key. */
export function maskKey(key: string): string {
  if (!key) return "";
  return key.length <= 8 ? "••••" : `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

/** Neutral conversation items, converted per API format. */
export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; calls: Call[] }
  | { kind: "tool"; id: string; name: string; output: string };
export interface Call {
  id: string;
  name: string;
  args: string;
}

interface Turn {
  text: string;
  calls: Call[];
  stop: string;
}

const MAX_TOOL_ROUNDS = 5;

/**
 * One reply turn: stream, run any tool calls, feed results back, repeat (bounded). Appends the
 * new items to `history` so the next turn continues the conversation.
 */
export async function runTurn(opts: {
  cfg: CustomSecret;
  system: string;
  history: Item[];
  userText: string;
  tools: ToolDef[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  onUpdate: (u: acp.SessionUpdate) => void;
  signal: AbortSignal;
}): Promise<{ stopReason: acp.StopReason }> {
  const items: Item[] = [...opts.history, { kind: "user", text: opts.userText }];
  for (let round = 0; ; round++) {
    const turn = await stream(opts.cfg, opts.system, items, round < MAX_TOOL_ROUNDS ? opts.tools : [], opts);
    items.push({ kind: "assistant", text: turn.text, calls: turn.calls });
    if (turn.calls.length === 0) {
      opts.history.splice(0, opts.history.length, ...items);
      return { stopReason: /length|max_tokens|max_output/.test(turn.stop) ? "max_tokens" : "end_turn" };
    }
    for (const c of turn.calls) {
      opts.onUpdate({
        sessionUpdate: "tool_call",
        toolCallId: c.id,
        title: `tuantuan · ${c.name}`,
        kind: "other",
        status: "in_progress",
        rawInput: safeJson(c.args),
      });
      let output: string;
      let ok = true;
      try {
        output = await opts.callTool(c.name, safeJson(c.args));
      } catch (e) {
        output = (e as Error).message;
        ok = false;
      }
      opts.onUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: c.id,
        status: ok ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: output } }],
      });
      items.push({ kind: "tool", id: c.id, name: c.name, output });
    }
  }
}

/** A tiny non-streaming-in-UI check: one short request, returns the reply text. */
export async function testConnection(cfg: CustomSecret, signal: AbortSignal): Promise<string> {
  const t = await stream(cfg, "", [{ kind: "user", text: "ping，只回复 pong" }], [], { onUpdate: () => {}, signal });
  return t.text.trim().slice(0, 200);
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const base = (cfg: CustomSecret) => (cfg.baseUrl.trim() || DEFAULT_BASE_URL[cfg.format]).replace(/\/+$/, "");

async function stream(
  cfg: CustomSecret,
  system: string,
  items: Item[],
  tools: ToolDef[],
  io: { onUpdate: (u: acp.SessionUpdate) => void; signal: AbortSignal },
): Promise<Turn> {
  if (!cfg.model.trim()) throw new Error("没有填写模型");
  if (!cfg.apiKey) throw new Error("没有填写 API Key");
  const { url, headers, body } = request(cfg, system, items, tools);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      body: JSON.stringify(body),
      signal: io.signal,
    });
  } catch (e) {
    if (io.signal.aborted) throw e;
    throw new Error(`连不上 ${url}：${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(httpError(res.status, await res.text().catch(() => "")).replaceAll(cfg.apiKey, "••••"));
  if (!res.body) throw new Error("响应没有内容");
  const out: Turn = { text: "", calls: [], stop: "" };
  const say = (t: string) => {
    if (!t) return;
    out.text += t;
    io.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
  };
  const parse = PARSERS[cfg.format](out, say);
  for await (const ev of sse(res.body)) {
    if (ev.data === "[DONE]") break;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const err = (data.error ?? (data.type === "error" ? data : null)) as { message?: string } | null;
    if (err && typeof err === "object")
      throw new Error(`接口报错：${err.message ?? JSON.stringify(err).slice(0, 300)}`);
    parse(ev.event, data);
  }
  out.calls = out.calls.filter((c) => c.name);
  return out;
}

function httpError(status: number, text: string): string {
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    msg = j.error?.message ?? j.message ?? msg;
  } catch {}
  if (status === 401 || status === 403) return `API Key 无效或无权限（HTTP ${status}）：${msg}`;
  if (status === 404) return `地址或模型不存在（HTTP 404）：${msg}`;
  if (status === 429) return `请求过多或额度不足（HTTP 429）：${msg}`;
  return `接口返回 HTTP ${status}：${msg}`;
}

/** Server-sent events: yields {event, data} per blank-line-separated block. */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const dec = new TextDecoder();
  let buf = "";
  const reader = body.getReader();
  const flush = function* (block: string) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) yield { event, data: data.join("\n") };
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (;;) {
      const cut = buf.search(/\r?\n\r?\n/);
      if (cut < 0) break;
      const block = buf.slice(0, cut);
      buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "");
      yield* flush(block);
    }
  }
  if (buf.trim()) yield* flush(buf);
}

// ---- per-format request bodies ----

function request(cfg: CustomSecret, system: string, items: Item[], tools: ToolDef[]) {
  const b = base(cfg);
  if (cfg.format === "anthropic") {
    const messages: unknown[] = [];
    for (const it of items) {
      if (it.kind === "user") messages.push({ role: "user", content: it.text });
      else if (it.kind === "assistant")
        messages.push({
          role: "assistant",
          content: [
            ...(it.text ? [{ type: "text", text: it.text }] : []),
            ...it.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: safeJson(c.args) })),
          ],
        });
      else {
        // Consecutive tool results share one user turn.
        const last = messages.at(-1) as { role: string; content: unknown } | undefined;
        const part = { type: "tool_result", tool_use_id: it.id, content: it.output };
        if (last?.role === "user" && Array.isArray(last.content)) last.content.push(part);
        else messages.push({ role: "user", content: [part] });
      }
    }
    return {
      url: `${b}/messages`,
      headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: {
        model: cfg.model,
        max_tokens: 4096,
        stream: true,
        ...(system && { system }),
        messages,
        ...(tools.length && {
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        }),
      },
    };
  }
  const auth = { authorization: `Bearer ${cfg.apiKey}` };
  if (cfg.format === "openai-responses") {
    const input: unknown[] = [];
    for (const it of items) {
      if (it.kind === "user") input.push({ role: "user", content: it.text });
      else if (it.kind === "assistant") {
        if (it.text) input.push({ role: "assistant", content: it.text });
        for (const c of it.calls)
          input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.args || "{}" });
      } else input.push({ type: "function_call_output", call_id: it.id, output: it.output });
    }
    return {
      url: `${b}/responses`,
      headers: auth,
      body: {
        model: cfg.model,
        stream: true,
        store: false,
        ...(system && { instructions: system }),
        input,
        ...(tools.length && {
          tools: tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        }),
      },
    };
  }
  const messages: unknown[] = system ? [{ role: "system", content: system }] : [];
  for (const it of items) {
    if (it.kind === "user") messages.push({ role: "user", content: it.text });
    else if (it.kind === "assistant")
      messages.push({
        role: "assistant",
        content: it.text || null,
        ...(it.calls.length && {
          tool_calls: it.calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args || "{}" },
          })),
        }),
      });
    else messages.push({ role: "tool", tool_call_id: it.id, content: it.output });
  }
  return {
    url: `${b}/chat/completions`,
    headers: auth,
    body: {
      model: cfg.model,
      stream: true,
      messages,
      ...(tools.length && {
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    },
  };
}

// ---- per-format stream parsers ----

type Parser = (event: string, data: Record<string, unknown>) => void;
// biome-ignore lint/suspicious/noExplicitAny: provider payloads are loosely typed
type Any = any;

const PARSERS: Record<CustomFormat, (out: Turn, say: (t: string) => void) => Parser> = {
  "openai-chat": (out, say) => (_e, d: Any) => {
    const ch = d.choices?.[0];
    if (!ch) return;
    if (typeof ch.delta?.content === "string") say(ch.delta.content);
    for (const tc of ch.delta?.tool_calls ?? []) {
      const i = tc.index ?? out.calls.length;
      out.calls[i] ??= { id: tc.id ?? `call_${i}`, name: "", args: "" };
      const c = out.calls[i] as Call;
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (ch.finish_reason) out.stop = ch.finish_reason;
  },
  "openai-responses": (out, say) => (e, d: Any) => {
    const type = d.type ?? e;
    if (type === "response.output_text.delta") say(d.delta ?? "");
    else if (type === "response.output_item.done" && d.item?.type === "function_call")
      out.calls.push({ id: d.item.call_id ?? d.item.id, name: d.item.name, args: d.item.arguments ?? "" });
    else if (type === "response.failed")
      throw new Error(`接口报错：${d.response?.error?.message ?? "response.failed"}`);
    else if (type === "response.incomplete") out.stop = d.response?.incomplete_details?.reason ?? "max_output_tokens";
    else if (type === "response.completed") out.stop ||= "completed";
  },
  anthropic: (out, say) => {
    const byIndex = new Map<number, Call>();
    return (e, d: Any) => {
      const type = d.type ?? e;
      if (type === "content_block_start" && d.content_block?.type === "tool_use") {
        const c = { id: d.content_block.id, name: d.content_block.name, args: "" };
        byIndex.set(d.index, c);
        out.calls.push(c);
      } else if (type === "content_block_delta") {
        if (d.delta?.type === "text_delta") say(d.delta.text ?? "");
        else if (d.delta?.type === "input_json_delta") {
          const c = byIndex.get(d.index);
          if (c) c.args += d.delta.partial_json ?? "";
        }
      } else if (type === "message_delta" && d.delta?.stop_reason) out.stop = d.delta.stop_reason;
    };
  },
};
