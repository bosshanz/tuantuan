import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { AcpProcess, withTimeout } from "../server/acp";
import { prepareProviderRuntime } from "../server/provider-runtime";
import type { ProviderSecret } from "../server/providers";

// Optional installed Pi + ACP integration. All model requests go to this local fixture.
const piAcp = process.env.TUANTUAN_TEST_PI_ACP;
const pi = Bun.which("pi");
const enabled = process.env.TUANTUAN_REAL_PROVIDER_RUNTIMES === "1" && piAcp && pi;
type Body = Record<string, unknown> & { messages?: Record<string, unknown>[] };

for (const protocol of ["chat", "responses", "anthropic"] as const) {
  test.skipIf(!enabled)(
    `real Pi ${protocol}: thinking choices, request fields and tool replay`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tt-pi-thinking-"));
      const home = join(root, "home");
      const cwd = join(root, "cwd");
      const piDir = join(home, ".pi", "agent");
      mkdirSync(piDir, { recursive: true });
      mkdirSync(cwd);
      const settings = JSON.stringify({ defaultThinkingLevel: "off" });
      writeFileSync(join(piDir, "settings.json"), settings);
      const fixture = join(cwd, "fixture.txt");
      writeFileSync(fixture, "local fixture only");
      const hits: Body[] = [];
      let toolRequested = false;
      const mock = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as Body;
          hits.push(body);
          if (protocol !== "chat")
            return Response.json(
              { type: "error", error: { type: "invalid_request_error", message: "local request captured" } },
              { status: 400 },
            );
          const common = {
            id: `fixture-${hits.length}`,
            object: "chat.completion.chunk",
            model: body.model,
            created: 0,
          };
          const tool = !toolRequested;
          toolRequested = true;
          const delta = tool
            ? {
                role: "assistant",
                reasoning_content: "fixture planning",
                tool_calls: [
                  {
                    index: 0,
                    id: "fixture_read",
                    type: "function",
                    function: { name: "read", arguments: JSON.stringify({ path: fixture }) },
                  },
                ],
              }
            : {
                role: "assistant",
                content: "fixture done",
                ...(body.reasoning_effort ? { reasoning_content: "fixture reasoning" } : {}),
              };
          return new Response(
            `${[
              { ...common, choices: [{ index: 0, delta, finish_reason: null }] },
              {
                ...common,
                choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const base = `http://127.0.0.1:${mock.port}`;
      const provider: ProviderSecret = {
        id: "deepseek-local",
        name: "Fixture",
        preset: "deepseek",
        model: "deepseek-v4-pro",
        smallModel: "deepseek-flash",
        apiKey: "fixture-key",
        mgmtKey: "",
        createdAt: 0,
        updatedAt: 0,
        openaiBaseUrl: protocol === "anthropic" ? "" : `${base}/v1`,
        anthropicBaseUrl: `${base}/anthropic`,
        wireApi: protocol === "responses" ? "responses" : "chat",
      };
      const env = {
        HOME: home,
        PATH: process.env.PATH || "",
        PI_OFFLINE: "1",
        PI_ACP_PI_COMMAND: pi as string,
        NO_PROXY: "127.0.0.1,localhost",
      };
      const launch = async () => {
        const runtime = await prepareProviderRuntime(provider, "pi", env);
        const acp = new AcpProcess(
          { command: process.execPath, args: [piAcp as string], cwd, env: runtime.env },
          {
            onUpdate: () => {},
            requestPermission: async (request) => {
              const allow = request.options.find((option) => option.kind === "allow_once");
              return { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } };
            },
          },
        );
        return { runtime, acp };
      };
      let running = await launch();
      const stop = async () => {
        running.acp.kill();
        await withTimeout(running.acp.exited, 5000, "Pi exit");
        running.runtime.cleanup();
      };
      try {
        await running.acp.initialize(15000);
        const session = await running.acp.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
        const option = session.configOptions?.find(
          (item) => item.category === "thought_level" || /thinking/.test(item.id),
        );
        if (option?.type !== "select") throw new Error("Pi did not expose a thinking selector");
        const values = option.options
          .flatMap((item) => ("options" in item ? item.options : [item]))
          .map((item) => item.value);
        expect(values).toEqual(["off", "low", "high", "max"]);
        for (const level of ["high", "off", "low", "max"]) {
          const set = await running.acp.agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: option.id,
            value: level,
          });
          expect(set.configOptions.find((item) => item.id === option.id)?.currentValue).toBe(level);
          const start = hits.length;
          await withTimeout(
            running.acp.agent.request(methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "Read the fixture if requested, then reply ok." }],
            }),
            20000,
            "Pi mock prompt",
          ).catch((error) => {
            if (protocol === "chat") throw error;
          });
          expect(hits.length, running.acp.stderr).toBeGreaterThan(start);
          const body = hits[start] as Body;
          expect(body.model).toBe(provider.model);
          if (protocol === "chat") {
            expect(body.thinking).toEqual({ type: level === "off" ? "disabled" : "enabled" });
            expect(body.reasoning_effort).toBe(level === "off" ? undefined : level);
          } else if (protocol === "responses") {
            expect(body.reasoning).toMatchObject({ effort: level === "off" ? "none" : level });
          } else {
            expect(body.thinking).toMatchObject({ type: level === "off" ? "disabled" : "adaptive" });
            expect(body.output_config).toEqual(level === "off" ? undefined : { effort: level });
          }
          if (level === "off") {
            // A launcher default must not override the user's saved choice on resume.
            await stop();
            running = await launch();
            await running.acp.initialize(15000);
            const loaded = await running.acp.agent.request(methods.agent.session.load, {
              sessionId: session.sessionId,
              cwd,
              mcpServers: [],
            });
            expect(loaded.configOptions?.find((item) => item.id === option.id)?.currentValue).toBe("off");
          }
        }
        if (protocol === "chat") {
          const assistants = hits.at(-1)?.messages?.filter((message) => message.role === "assistant") ?? [];
          expect(assistants.length).toBeGreaterThan(1);
          expect(assistants.every((message) => typeof message.reasoning_content === "string")).toBe(true);
          expect(assistants.some((message) => message.reasoning_content === "fixture planning")).toBe(true);
          expect(hits.some((body) => body.messages?.some((message) => message.role === "tool"))).toBe(true);
        }
        expect(readFileSync(join(piDir, "settings.json"), "utf8")).toBe(settings);
      } finally {
        await stop();
        mock.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );
}
