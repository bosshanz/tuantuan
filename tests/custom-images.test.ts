import { afterAll, describe, expect, test } from "bun:test";
import {
  CUSTOM_FORMATS,
  CUSTOM_HISTORY_MAX_CHARS,
  CUSTOM_HISTORY_MAX_IMAGE_BYTES,
  type CustomFormat,
  type CustomSecret,
  commitBoundedTurn,
  fitTurns,
  historyChars,
  historyForRequest,
  historyImageBytes,
  type Item,
  runTurn,
  turnChars,
  turnImageBytes,
} from "../server/custom";
import type { ToolDef } from "../server/tuantuan-mcp";
import { type ImageAttachment, MAX_ATTACHMENT_BYTES } from "../shared/attachments";

const pixel: ImageAttachment = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
};
const large: ImageAttachment = { mimeType: "image/png", data: Buffer.alloc(100_000).toString("base64") };
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

const tool: ToolDef = {
  name: "inspect",
  description: "inspect context",
  inputSchema: { type: "object", properties: {}, required: [] },
};

function event(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function reply(format: CustomFormat, callsTool: boolean): string {
  if (format === "openai-chat")
    return `${event({
      choices: [
        {
          delta: callsTool
            ? {
                content: "checking",
                tool_calls: [{ index: 0, id: "c1", function: { name: "inspect", arguments: "{}" } }],
              }
            : { content: "done" },
          finish_reason: callsTool ? "tool_calls" : "stop",
        },
      ],
    })}data: [DONE]\n\n`;
  if (format === "openai-responses")
    return (
      event({ type: "response.output_text.delta", delta: callsTool ? "checking" : "done" }) +
      (callsTool
        ? event({
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "c1", name: "inspect", arguments: "{}" },
          })
        : "") +
      event({ type: "response.completed" })
    );
  return (
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: callsTool ? "checking" : "done" },
    }) +
    (callsTool
      ? event({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "c1", name: "inspect", input: {} },
        })
      : "") +
    event({ type: "message_delta", delta: { stop_reason: callsTool ? "tool_use" : "end_turn" } })
  );
}

function fixture(format: CustomFormat, firstCallsTool = false) {
  const calls: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push((await req.json()) as Record<string, unknown>);
      return new Response(reply(format, firstCallsTool && calls.length === 1), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  servers.push(server);
  const cfg: CustomSecret = { format, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "vision", apiKey: "test" };
  return {
    calls,
    run: (opts: Partial<Omit<Parameters<typeof runTurn>[0], "cfg">> = {}) =>
      runTurn({
        cfg,
        system: "system",
        history: [],
        userText: "compare images",
        tools: [],
        callTool: async () => "tool result",
        onUpdate: () => {},
        signal: AbortSignal.timeout(10_000),
        ...opts,
      }),
  };
}

function messages(format: CustomFormat, body: Record<string, unknown> | undefined) {
  if (!body) throw new Error("No upstream request was captured");
  return body[format === "openai-responses" ? "input" : "messages"] as {
    role?: string;
    content?: unknown;
    type?: string;
    tool_call_id?: string;
    call_id?: string;
  }[];
}

function imageParts(format: CustomFormat, images: ImageAttachment[]): unknown[] {
  return images.map((image) =>
    format === "anthropic"
      ? { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }
      : format === "openai-responses"
        ? { type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` }
        : { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
  );
}

function completed(text: string, userImages?: ImageAttachment[]): Item[] {
  return [
    { kind: "user", text, ...(userImages && { userImages }) },
    { kind: "assistant", text: "answer", calls: [] },
  ];
}

describe("BYOK image inputs", () => {
  for (const format of CUSTOM_FORMATS) {
    test(`${format}: serializes all images, keeps legacy text history and replays images next turn`, async () => {
      const f = fixture(format);
      const history = [completed("legacy")];
      const userImages = [pixel, large]; // Base64 larger than the entire text budget must still fit.
      const result = await f.run({ history, userImages });
      expect(result.newItems[0]).toEqual({ kind: "user", text: "compare images", userImages });
      const expected = [
        { type: format === "openai-responses" ? "input_text" : "text", text: "compare images" },
        ...imageParts(format, userImages),
      ];
      const users = messages(format, f.calls[0]).filter((m) => m.role === "user");
      expect(users).toEqual([
        { role: "user", content: "legacy" },
        { role: "user", content: expected },
      ]);

      await f.run({ history: [...history, result.newItems], userText: "follow up" });
      const replayed = messages(format, f.calls[1]).filter((m) => m.role === "user");
      expect(replayed).toEqual([
        { role: "user", content: "legacy" },
        { role: "user", content: expected },
        { role: "user", content: "follow up" },
      ]);
      expect(history).toEqual([completed("legacy")]);
    });

    test(`${format}: sends image-only turns without empty text blocks`, async () => {
      const f = fixture(format);
      await f.run({ userText: "", userImages: [pixel] });
      expect(messages(format, f.calls[0]).find((m) => m.role === "user")?.content).toEqual(imageParts(format, [pixel]));
    });

    test(`${format}: keeps images and paired calls/results across a tool round`, async () => {
      const f = fixture(format, true);
      const result = await f.run({ userImages: [pixel], tools: [tool] });
      expect(f.calls).toHaveLength(2);
      for (const body of f.calls)
        expect(messages(format, body).find((m) => m.role === "user")?.content).toEqual([
          { type: format === "openai-responses" ? "input_text" : "text", text: "compare images" },
          ...imageParts(format, [pixel]),
        ]);
      const followup = messages(format, f.calls[1]);
      if (format === "openai-chat")
        expect(followup.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1", content: "tool result" });
      else if (format === "openai-responses")
        expect(followup.at(-1)).toMatchObject({ type: "function_call_output", call_id: "c1", output: "tool result" });
      else
        expect(followup.at(-1)).toEqual({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", content: "tool result" }],
        });
      expect(result.newItems.map((it) => it.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    });
  }

  test("counts image bytes separately and retains all text, metadata and JSON wrapping", () => {
    const smallItems = completed("ask", [pixel]);
    const largeItems = completed("ask", [large]);
    expect(turnChars(largeItems)).toBe(turnChars(smallItems));
    expect(turnChars(largeItems)).toBeGreaterThan(turnChars(completed("ask")));
    expect(turnImageBytes(largeItems)).toBe(100_000);
    expect(turnImageBytes(completed("legacy"))).toBe(0);
    expect(turnChars(completed("legacy"))).toBe(JSON.stringify(completed("legacy")).length);
    expect(historyChars([smallItems, largeItems])).toBe(turnChars(smallItems) + turnChars(largeItems) + 2);
    expect(historyImageBytes([smallItems, largeItems])).toBe(turnImageBytes(smallItems) + 100_000);
  });

  test("evicts complete image turns at the 20 MiB boundary and never mutates the source", () => {
    const maxImage = { mimeType: "image/png", data: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64") };
    const turns = Array.from({ length: 5 }, (_, i) => completed(`old ${i}`, [maxImage]));
    expect(historyImageBytes(turns.slice(0, 4))).toBe(CUSTOM_HISTORY_MAX_IMAGE_BYTES);
    expect(historyForRequest(turns.slice(0, 4), 0)).toEqual(turns.slice(0, 4));
    expect(historyForRequest(turns.slice(0, 4), 0, 1)).toEqual(turns.slice(1, 4));
    expect(fitTurns(turns)).toEqual(turns.slice(1));
    expect(commitBoundedTurn(turns.slice(0, 4), completed("new", [pixel]))).toEqual([
      ...turns.slice(1, 4),
      completed("new", [pixel]),
    ]);
    expect(turns).toHaveLength(5);
    expect(turns[0]?.[0]).toMatchObject({ text: "old 0", userImages: [maxImage] });
    // A current turn exceeding its own budget must be refused rather than silently discarded.
    expect(() => commitBoundedTurn([], turns.flat())).toThrow(/图片上下文预算/);
  });

  test("drops an old image turn and its tool pair together before an oversized request is sent", async () => {
    const maxImage = { mimeType: "image/png", data: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64") };
    const oldWithTools: Item[] = [
      { kind: "user", text: "evict", userImages: [maxImage] },
      { kind: "assistant", text: "", calls: [{ id: "old-call", name: "inspect", args: "{}" }] },
      { kind: "tool", id: "old-call", name: "inspect", output: "old result" },
      { kind: "assistant", text: "old answer", calls: [] },
    ];
    const history = [oldWithTools, ...Array.from({ length: 3 }, (_, i) => completed(`kept ${i}`, [maxImage]))];
    const f = fixture("openai-chat");
    await f.run({ history, userImages: [pixel] });
    const sent = messages("openai-chat", f.calls[0]);
    expect(sent.some((m) => m.role === "tool")).toBe(false);
    expect(sent.filter((m) => m.role === "user")).toHaveLength(4);
    expect(JSON.stringify(sent)).not.toContain("evict");
    expect(history[0]).toEqual(oldWithTools);
  });

  test("a growing tool chain evicts the whole old image turn while preserving current images", async () => {
    const f = fixture("openai-chat", true);
    const history = [completed("x".repeat(35_000), [large])];
    await f.run({ history, userImages: [pixel], tools: [tool], callTool: async () => "y".repeat(40_000) });
    expect(messages("openai-chat", f.calls[0]).filter((m) => m.role === "user")).toHaveLength(2);
    const users = messages("openai-chat", f.calls[1]).filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toEqual([
      { type: "text", text: "compare images" },
      ...imageParts("openai-chat", [pixel]),
    ]);
  });

  test("rejects invalid or oversized images at the custom boundary before sending", async () => {
    const f = fixture("openai-chat");
    const maxImage = { mimeType: "image/png", data: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64") };
    const cases: [ImageAttachment[], RegExp][] = [
      [[{ ...pixel, mimeType: "image/svg+xml" }], /不支持的图片/],
      [[{ ...pixel, data: "A===" }], /Base64/],
      [[{ ...pixel, data: "AB==" }], /Base64/],
      [[{ ...pixel, data: "" }], /图片内容为空/],
      [[{ ...pixel, data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64") }], /5 MiB/],
      [Array.from({ length: 9 }, () => pixel), /8 个附件/],
      [Array.from({ length: 5 }, () => maxImage), /20 MiB/],
    ];
    for (const [userImages, error] of cases) await expect(f.run({ userImages })).rejects.toThrow(error);
    expect(f.calls).toHaveLength(0);
  });

  test("images do not exempt current text or tool output from the existing 64 KiB cap", async () => {
    const direct = fixture("openai-chat");
    await expect(direct.run({ userText: "x".repeat(CUSTOM_HISTORY_MAX_CHARS), userImages: [pixel] })).rejects.toThrow(
      /上下文预算/,
    );
    expect(direct.calls).toHaveLength(0);
    const toolRound = fixture("openai-chat", true);
    await expect(
      toolRound.run({ userImages: [pixel], tools: [tool], callTool: async () => "x".repeat(CUSTOM_HISTORY_MAX_CHARS) }),
    ).rejects.toThrow(/上下文预算/);
    expect(toolRound.calls).toHaveLength(1);
  });
});
