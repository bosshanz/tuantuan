import type * as acp from "@agentclientprotocol/sdk";
import {
  attachmentBytes,
  attachmentError,
  type ImageAttachment,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../shared/attachments";
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
  | { kind: "user"; text: string; userImages?: ImageAttachment[] }
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
 * Bounded BYOK context. History is kept as whole completed turns (one `runTurn` each, tool calls
 * and results paired inside) and capped by turn count, serialized text and decoded image bytes.
 * Base64 image payloads do not consume the text budget; their metadata and JSON wrappers do.
 * These are resource budgets, not a claim about any model's token window. The system prompt
 * and the current user task are never trimmed; only complete old turns are dropped.
 */
export const CUSTOM_HISTORY_MAX_TURNS = 20;
export const CUSTOM_HISTORY_MAX_CHARS = 64 * 1024;
export const CUSTOM_HISTORY_MAX_IMAGE_BYTES = MAX_TOTAL_ATTACHMENT_BYTES;

function withoutImageData(items: Item[]): Item[] {
  return items.map((it) =>
    it.kind === "user" && it.userImages?.length
      ? { ...it, userImages: it.userImages.map((image) => ({ ...image, data: "" })) }
      : it,
  );
}

export function turnChars(items: Item[]): number {
  return JSON.stringify(withoutImageData(items)).length;
}

export function historyChars(turns: Item[][]): number {
  return turns.reduce((n, t) => n + turnChars(t) + 1, 0);
}

/** Validate each user message at this boundary too; persisted images may bypass POST validation. */
export function turnImageBytes(items: Item[]): number {
  let bytes = 0;
  for (const it of items) {
    if (it.kind !== "user" || !it.userImages?.length) continue;
    const error = attachmentError(it.userImages, []);
    if (error) throw new Error(error);
    for (const image of it.userImages) {
      const size = attachmentBytes(image.data);
      if (!size) throw new Error("图片内容为空");
      bytes += size;
    }
  }
  return bytes;
}

export function historyImageBytes(turns: Item[][]): number {
  return turns.reduce((n, t) => n + turnImageBytes(t), 0);
}

/** Old turns kept for this turn, dropping whole oldest ones so old + incoming fits (a first pass;
 * every request is re-measured precisely inside runTurn before it is sent). */
export function historyForRequest(turns: Item[][], incomingChars: number, incomingImageBytes = 0): Item[][] {
  const kept = turns.slice();
  let chars = historyChars(kept);
  let imageBytes = historyImageBytes(kept);
  while (
    kept.length > 0 &&
    (kept.length >= CUSTOM_HISTORY_MAX_TURNS ||
      chars + incomingChars > CUSTOM_HISTORY_MAX_CHARS ||
      imageBytes + incomingImageBytes > CUSTOM_HISTORY_MAX_IMAGE_BYTES)
  ) {
    const oldest = kept.shift();
    if (!oldest) break;
    chars -= turnChars(oldest) + 1;
    imageBytes -= turnImageBytes(oldest);
  }
  return kept;
}

/** Drop whole oldest turns until within budget. Recovery may end up with nothing to keep; a
 * committed turn is always within budget itself, so committing always keeps the newest. */
export function fitTurns(turns: Item[][]): Item[][] {
  const out = turns.slice();
  let chars = historyChars(out);
  let imageBytes = historyImageBytes(out);
  while (
    out.length > 0 &&
    (out.length > CUSTOM_HISTORY_MAX_TURNS ||
      chars > CUSTOM_HISTORY_MAX_CHARS ||
      imageBytes > CUSTOM_HISTORY_MAX_IMAGE_BYTES)
  ) {
    const oldest = out.shift();
    if (!oldest) break;
    chars -= turnChars(oldest) + 1;
    imageBytes -= turnImageBytes(oldest);
  }
  return out;
}

/** Append one complete turn, then drop whole oldest turns until back within budget. */
export function commitBoundedTurn(turns: Item[][], newItems: Item[]): Item[][] {
  if (historyChars([newItems]) > CUSTOM_HISTORY_MAX_CHARS)
    throw new Error(`本轮对话超过自定义 API 的上下文预算 ${CUSTOM_HISTORY_MAX_CHARS} 字符，未写入会话上下文`);
  if (turnImageBytes(newItems) > CUSTOM_HISTORY_MAX_IMAGE_BYTES)
    throw new Error("本轮图片超过自定义 API 的图片上下文预算 20 MiB，未写入会话上下文");
  return fitTurns([...turns, newItems]);
}

/**
 * One reply turn: stream, run any tool calls, feed results back, repeat (bounded). `history` is
 * read-only whole old turns; the items this turn appended are returned for the caller to persist
 * (or drop when the turn failed, was cancelled, or exceeds the context budget).
 *
 * Before every upstream request the serialized body, excluding base64 image data, is measured
 * against CUSTOM_HISTORY_MAX_CHARS; decoded image bytes have their own 20 MiB budget. Whole
 * oldest old turns are dropped to fit both, and a current turn that alone exceeds either budget
 * is rejected before anything is sent. Nothing is truncated mid-item, so images, tool calls and
 * results stay together.
 */
export async function runTurn(opts: {
  cfg: CustomSecret;
  system: string;
  history: Item[][];
  userText: string;
  userImages?: ImageAttachment[];
  tools: ToolDef[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  onUpdate: (u: acp.SessionUpdate) => void;
  signal: AbortSignal;
}): Promise<{ stopReason: acp.StopReason; newItems: Item[] }> {
  const userItem: Item = {
    kind: "user",
    text: opts.userText,
    ...(opts.userImages?.length && { userImages: opts.userImages.map(({ mimeType, data }) => ({ mimeType, data })) }),
  };
  const incomingImageBytes = turnImageBytes([userItem]);
  const oldTurns = opts.history.map((t) => ({ length: t.length, imageBytes: turnImageBytes(t) }));
  let imageBytes = oldTurns.reduce((n, turn) => n + turn.imageBytes, incomingImageBytes);
  let oldCount = opts.history.reduce((n, t) => n + t.length, 0);
  const items: Item[] = [...opts.history.flat(), userItem];
  const dropOldestTurn = (): boolean => {
    const oldest = oldTurns.shift();
    if (!oldest) return false;
    items.splice(0, oldest.length);
    oldCount -= oldest.length;
    imageBytes -= oldest.imageBytes;
    return true;
  };
  for (let round = 0; ; round++) {
    const roundTools = round < MAX_TOOL_ROUNDS ? opts.tools : [];
    for (;;) {
      const size = JSON.stringify(request(opts.cfg, opts.system, withoutImageData(items), roundTools).body).length;
      if (
        size <= CUSTOM_HISTORY_MAX_CHARS &&
        imageBytes <= CUSTOM_HISTORY_MAX_IMAGE_BYTES &&
        oldTurns.length < CUSTOM_HISTORY_MAX_TURNS
      )
        break;
      if (dropOldestTurn()) continue;
      if (imageBytes > CUSTOM_HISTORY_MAX_IMAGE_BYTES)
        throw new Error("本轮图片超过自定义 API 的图片上下文预算 20 MiB；请减少图片或开启新会话");
      throw new Error(
        `本轮请求序列化后 ${size} 字符，超过自定义 API 的上下文预算 ${CUSTOM_HISTORY_MAX_CHARS} 字符；请缩短输入或开启新会话`,
      );
    }
    const turn = await stream(opts.cfg, opts.system, items, roundTools, opts);
    // The final text often sits in the same buffered chunk as [DONE]: an abort raised by the
    // last update callback must still cancel the turn instead of committing it.
    opts.signal.throwIfAborted();
    items.push({ kind: "assistant", text: turn.text, calls: turn.calls });
    if (turn.calls.length === 0) {
      return {
        stopReason: /length|max_tokens|max_output/.test(turn.stop) ? "max_tokens" : "end_turn",
        newItems: items.slice(oldCount),
      };
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
    opts.signal.throwIfAborted();
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
      if (it.kind === "user")
        messages.push({
          role: "user",
          content: it.userImages?.length
            ? [
                ...(it.text ? [{ type: "text", text: it.text }] : []),
                ...it.userImages.map((image) => ({
                  type: "image",
                  source: { type: "base64", media_type: image.mimeType, data: image.data },
                })),
              ]
            : it.text,
        });
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
      if (it.kind === "user")
        input.push({
          role: "user",
          content: it.userImages?.length
            ? [
                ...(it.text ? [{ type: "input_text", text: it.text }] : []),
                ...it.userImages.map((image) => ({
                  type: "input_image",
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                })),
              ]
            : it.text,
        });
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
    if (it.kind === "user")
      messages.push({
        role: "user",
        content: it.userImages?.length
          ? [
              ...(it.text ? [{ type: "text", text: it.text }] : []),
              ...it.userImages.map((image) => ({
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${image.data}` },
              })),
            ]
          : it.text,
      });
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
