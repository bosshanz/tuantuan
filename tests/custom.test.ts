import { afterAll, describe, expect, test } from "bun:test";
import { CUSTOM_FORMATS, type CustomSecret, maskKey, runTurn, testConnection } from "../server/custom";
import type { ToolDef } from "../server/tuantuan-mcp";

/** Tiny SSE mock that speaks each of the three formats. */
function mockServer(format: CustomSecret["format"]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json()) as Record<string, unknown>;
      calls.push({ url: url.pathname, body, headers: req.headers });
      if (url.pathname.includes("fail")) return Response.json({ error: { message: "bad key" } }, { status: 401 });

      // Second round: after a tool result, just say done.
      const isFollowup =
        format === "openai-chat"
          ? (body.messages as unknown[])?.some((m: unknown) => (m as { role?: string }).role === "tool")
          : format === "openai-responses"
            ? (body.input as { type?: string }[])?.some((i) => i.type === "function_call_output")
            : (body.messages as { content?: unknown }[])?.some(
                (m) => Array.isArray(m.content) && m.content.some((c: { type?: string }) => c.type === "tool_result"),
              );

      // Always stream: text for ping/test; tool call when tools present and user asks handoff.
      const text = JSON.stringify(body);
      const out =
        /handoff|交接/.test(text) && !isFollowup
          ? streamTool(format)
          : isFollowup
            ? streamDone(format, "已交接")
            : streamText(format, "pong");
      return new Response(out, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    calls,
    stop: () => server.stop(true),
  };
}

function sse(lines: string[]) {
  return lines.map((l) => `data: ${l}\n\n`).join("");
}

function streamText(format: CustomSecret["format"], text: string) {
  if (format === "openai-chat")
    return sse([
      JSON.stringify({ choices: [{ delta: { content: text } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "[DONE]",
    ]);
  if (format === "openai-responses")
    return (
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`
    );
  return (
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`
  );
}

function streamTool(format: CustomSecret["format"]) {
  if (format === "openai-chat")
    return sse([
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "handoff", arguments: "" } }] } }],
      }),
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"agent":"Alice","task":"写文档"}' } }] } },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ]);
  if (format === "openai-responses")
    return (
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c1", name: "handoff", arguments: '{"agent":"Alice","task":"写文档"}' },
      })}\n\n` + `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`
    );
  return (
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "c1", name: "handoff", input: {} },
    })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"agent":"Alice","task":"写文档"}' },
    })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}\n\n`
  );
}

function streamDone(format: CustomSecret["format"], text: string) {
  return streamText(format, text);
}

const tools: ToolDef[] = [
  {
    name: "handoff",
    description: "hand off",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, task: { type: "string" } },
      required: ["agent", "task"],
    },
  },
];

describe("BYOK custom harness", () => {
  const servers = CUSTOM_FORMATS.map((f) => ({ f, ...mockServer(f) }));
  afterAll(() => {
    for (const s of servers) s.stop();
  });

  test("masks API keys", () => {
    expect(maskKey("sk-abcdefghij")).toBe("sk-••••ghij");
    expect(maskKey("short")).toBe("••••");
  });

  for (const s of servers) {
    test(`${s.f}: streams text`, async () => {
      const cfg: CustomSecret = { format: s.f, baseUrl: s.url, model: "m", apiKey: "sk-testkeyXXXX" };
      const chunks: string[] = [];
      const history: Parameters<typeof runTurn>[0]["history"] = [];
      const r = await runTurn({
        cfg,
        system: "you are brief",
        history,
        userText: "ping",
        tools: [],
        callTool: async () => "",
        onUpdate: (u) => {
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") chunks.push(u.content.text);
        },
        signal: AbortSignal.timeout(5000),
      });
      expect(r.stopReason).toBe("end_turn");
      expect(chunks.join("")).toBe("pong");
      expect(history).toHaveLength(2);
    });

    test(`${s.f}: tool call handoff then finishes`, async () => {
      const cfg: CustomSecret = { format: s.f, baseUrl: s.url, model: "m", apiKey: "sk-test" };
      const toolsCalled: string[] = [];
      const history: Parameters<typeof runTurn>[0]["history"] = [];
      const r = await runTurn({
        cfg,
        system: "",
        history,
        userText: "请 handoff 给 Alice",
        tools,
        callTool: async (name, args) => {
          toolsCalled.push(`${name}:${JSON.stringify(args)}`);
          return "ok";
        },
        onUpdate: () => {},
        signal: AbortSignal.timeout(5000),
      });
      expect(toolsCalled).toEqual(['handoff:{"agent":"Alice","task":"写文档"}']);
      expect(r.stopReason).toBe("end_turn");
    });

    test(`${s.f}: testConnection`, async () => {
      const cfg: CustomSecret = { format: s.f, baseUrl: s.url, model: "m", apiKey: "sk-test" };
      expect(await testConnection(cfg, AbortSignal.timeout(5000))).toContain("pong");
    });
  }

  test("401 is a clear error", async () => {
    const s = servers[0]!;
    await expect(
      testConnection({ format: s.f, baseUrl: `${s.url}/fail`, model: "m", apiKey: "bad" }, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/API Key|401|权限/);
  });
});
