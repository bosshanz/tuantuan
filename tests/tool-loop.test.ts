import { afterAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { AppConfig } from "../server/config";
import { chat, readSseStream } from "../server/llm";
import { McpConnections } from "../server/mcp";
import { runToolLoop } from "../server/tool-loop";
import { buildToolRuntime, evaluateExpression, type ToolRuntime } from "../server/tools";
import { testConfig } from "./helpers";

const user = (content: string) => [
  { role: "system" as const, content: "你的名字是「T」。" },
  { role: "user" as const, content },
];

async function builtinRuntime(ids: string[]): Promise<ToolRuntime> {
  return (await buildToolRuntime({ toolIds: ids, skills: [], mcpServers: [], mcp: new McpConnections() })).runtime;
}

describe("calculator", () => {
  test("evaluates with precedence and rejects bad input", () => {
    expect(evaluateExpression("2 + 3 * (4 - 1) ^ 2")).toBe(29);
    expect(evaluateExpression("-2^2")).toBe(-4);
    expect(evaluateExpression("2^-1")).toBe(0.5);
    expect(evaluateExpression("-(3)*-2")).toBe(6);
    expect(() => evaluateExpression("1/0")).toThrow("除数为 0");
    expect(() => evaluateExpression("2 +")).toThrow();
    expect(() => evaluateExpression("process.exit()")).toThrow();
  });
});

describe("runToolLoop", () => {
  test("executes a tool call and feeds the result back", async () => {
    const r = await runToolLoop({
      config: testConfig(),
      candidates: ["mock/small"],
      messages: user('[[tool:calculator {"expression":"6*7"}]]'),
      tools: await builtinRuntime(["builtin:calculator"]),
      maxIterations: 4,
    });
    expect(r.outcome).toBe("completed");
    expect(r.toolCalls).toMatchObject([{ name: "calculator", status: "ok", result: "42" }]);
    expect(r.content).toContain("42");
  });

  test("tool errors are returned to the model truthfully", async () => {
    const r = await runToolLoop({
      config: testConfig(),
      candidates: ["mock/small"],
      messages: user('[[tool:calculator {"expression":"1/0"}]]'),
      tools: await builtinRuntime(["builtin:calculator"]),
      maxIterations: 4,
    });
    expect(r.toolCalls[0]).toMatchObject({ status: "error", error: "除数为 0" });
    expect(r.content).toContain('{"error":"除数为 0"}');
  });

  test("malformed tool arguments are reported as errors", async () => {
    const rt = await builtinRuntime(["builtin:calculator"]);
    await expect(rt.execute("calculator", "{oops", undefined)).rejects.toThrow("合法 JSON");
    await expect(rt.execute("web_fetch", "{}", undefined)).rejects.toThrow("未授权");
  });

  test("stops at max iterations when the model keeps calling tools", async () => {
    let calls = 0;
    // With maxIterations=1 the only model turn asks for a tool, so the loop must stop
    // without a final answer and say so.
    const r = await runToolLoop({
      config: testConfig(),
      candidates: ["mock/small"],
      messages: user('[[tool:current_time {"timezone":"UTC"}]]'),
      tools: {
        specs: (await builtinRuntime(["builtin:current_time"])).specs,
        async execute() {
          calls++;
          return "tick";
        },
      },
      maxIterations: 1,
    });
    expect(calls).toBe(1);
    expect(r.outcome).toBe("max_iterations");
  });

  test("load_skill injects the skill body on demand", async () => {
    const { runtime } = await buildToolRuntime({
      toolIds: [],
      skills: [{ name: "demo", description: "d", body: "SKILL BODY", dir: "" }],
      mcpServers: [],
      mcp: new McpConnections(),
    });
    const r = await runToolLoop({
      config: testConfig(),
      candidates: ["mock/small"],
      messages: user('[[tool:load_skill {"name":"demo"}]]'),
      tools: runtime,
      maxIterations: 3,
    });
    expect(r.toolCalls[0]).toMatchObject({ name: "load_skill", status: "ok", result: "SKILL BODY" });
  });
});

describe("OpenAI-compatible streaming client", () => {
  const sse = (events: unknown[]) =>
    new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string };
      if (req.headers.get("authorization") !== "Bearer k") return new Response("unauthorized", { status: 401 });
      if (body.model === "down") return new Response("upstream down", { status: 503 });
      return sse([
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "calc", arguments: '{"a"' } }] } }],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
        "[DONE]",
      ]);
    },
  });
  afterAll(() => server.stop(true));
  process.env.TEST_PROVIDER_KEY = "k";
  const cfg = (model: string): [AppConfig, AppConfig["models"][number]] => {
    const m = { id: `t/${model}`, provider: "t", model, tags: ["chat" as const], costTier: 1, contextWindow: 1000 };
    return [
      {
        ...testConfig(),
        providers: [
          { id: "t", type: "openai", baseUrl: `http://localhost:${server.port}/v1`, apiKeyEnv: "TEST_PROVIDER_KEY" },
        ],
        models: [m],
      },
      m,
    ];
  };

  test("accumulates content deltas and indexed tool-call fragments", async () => {
    const deltas: string[] = [];
    const [c, m] = cfg("ok");
    const r = await chat(c, m, { messages: [{ role: "user", content: "x" }], onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r).toEqual({
      content: "Hello",
      toolCalls: [{ id: "c1", type: "function", function: { name: "calc", arguments: '{"a":1}' } }],
    });
  });

  test("HTTP errors become ProviderError with status", async () => {
    const [c, m] = cfg("down");
    await expect(chat(c, m, { messages: [] })).rejects.toMatchObject({ name: "ProviderError", status: 503 });
  });

  test("missing api key env is a provider error, not a crash", async () => {
    const [c, m] = cfg("ok");
    const noKey = { ...c, providers: [{ ...(c.providers[0] as object), apiKeyEnv: "NOPE_UNSET_KEY" }] } as AppConfig;
    await expect(chat(noKey, m, { messages: [] })).rejects.toThrow("NOPE_UNSET_KEY");
  });

  test("error events inside the stream surface as errors", async () => {
    const body = new Response('data: {"error":{"message":"quota"}}\n\n').body as ReadableStream<Uint8Array>;
    await expect(readSseStream(body, "m")).rejects.toThrow("quota");
  });
});

describe("MCP (streamable HTTP)", () => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  const mcpServer = new McpServer({ name: "test", version: "1.0.0" });
  mcpServer.registerTool("echo", { description: "回显文本", inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text: `echo:${text}` }],
  }));
  mcpServer.registerTool("boom", { description: "总是失败" }, async () => ({
    content: [{ type: "text", text: "kaput" }],
    isError: true,
  }));
  const ready = mcpServer.connect(transport);
  const http = Bun.serve({ port: 0, fetch: (req) => transport.handleRequest(req) });
  afterAll(() => http.stop(true));
  const url = `http://localhost:${http.port}/mcp`;

  test("lists tools and calls the selected one through the tool runtime", async () => {
    await ready;
    const mcp = new McpConnections();
    const tools = await mcp.listTools("s1", url);
    expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
    const { runtime, warnings } = await buildToolRuntime({
      toolIds: ["mcp:s1:echo", "mcp:s1:missing"],
      skills: [],
      mcpServers: [{ id: "s1", url }],
      mcp,
    });
    expect(warnings).toEqual([`MCP 服务 ${url} 不再提供工具 missing`]);
    expect(runtime.specs.map((s) => s.function.name)).toEqual(["mcp_s1_echo"]);
    expect(await runtime.execute("mcp_s1_echo", '{"text":"hi"}')).toBe("echo:hi");
    await expect(mcp.callTool("s1", url, "boom", {})).rejects.toThrow("kaput");
    await mcp.drop("s1");
  });

  test("unreachable server is a truthful error", async () => {
    await expect(new McpConnections().listTools("x", "http://127.0.0.1:1/mcp")).rejects.toThrow("列出工具失败");
  });
});
