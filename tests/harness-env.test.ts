import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import { harnessProcessEnv, mergeCodexConfig } from "../server/harness-env";
import { materializeSkills } from "../server/skills";
import type { Agent, Message, Room } from "../server/store";
import { agentInput } from "./helpers";

describe("harness env inherits user config", () => {
  test("mergeCodexConfig keeps model_provider and appends developer_instructions", () => {
    const merged = JSON.parse(
      mergeCodexConfig(
        JSON.stringify({
          model_provider: "cc-switch",
          model_providers: { "cc-switch": { base_url: "http://127.0.0.1:9/v1" } },
          developer_instructions: "prior",
        }),
        "identity-doc",
      ),
    );
    expect(merged.model_provider).toBe("cc-switch");
    expect(merged.model_providers["cc-switch"].base_url).toContain("127.0.0.1");
    expect(merged.developer_instructions).toBe("prior\n\nidentity-doc");
  });

  test("skill layer cannot isolate CLAUDE_CONFIG_DIR / CODEX_HOME; ANTHROPIC_* survive", () => {
    const env = harnessProcessEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_BASE_URL: "http://cc-switch.local/v1",
        ANTHROPIC_AUTH_TOKEN: "tok",
        OPENAI_API_KEY: "sk",
        CODEX_CONFIG: JSON.stringify({ model_provider: "mine" }),
        CODEX_HOME: "/home/user/.codex",
      },
      { CLAUDE_CONFIG_DIR: "/tmp/isolated", CODEX_HOME: "/tmp/bad", EXTRA: "1" },
      {},
      { identity: "codex-env" },
      "id",
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("http://cc-switch.local/v1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok");
    expect(env.OPENAI_API_KEY).toBe("sk");
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CODEX_HOME).toBe("/home/user/.codex"); // login shell's, not skill's
    expect(JSON.parse(env.CODEX_CONFIG!).model_provider).toBe("mine");
    expect(JSON.parse(env.CODEX_CONFIG!).developer_instructions).toBe("id");
    expect(env.EXTRA).toBe("1");
  });

  test("materializeSkills never returns isolation env; links into project dirs only", () => {
    const data = mkdtempSync(join(tmpdir(), "he-"));
    const cwd = mkdtempSync(join(tmpdir(), "he-cwd-"));
    const skill = join(data, "agents", "a1", "skills", "x");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: x\ndescription: d\n---\n\nbody\n");
    for (const h of ["claude-code", "codex", "opencode", "grok", "mock", "custom"]) {
      const m = materializeSkills(data, "a1", h, cwd);
      expect(m.env).toEqual({});
      expect(m.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      expect(m.env).not.toHaveProperty("CODEX_HOME");
    }
  });
});

describe("live: mock harness sees ANTHROPIC_BASE_URL from process env", () => {
  const hits: string[] = [];
  let mockLlm: ReturnType<typeof Bun.serve>;
  let app: ReturnType<typeof serve>["app"];
  let server: ReturnType<typeof serve>["server"];
  let base = "";
  let prev: string | undefined;
  let mockPort = 0;

  beforeAll(async () => {
    const { resetLoginShellEnv } = await import("../server/harness");
    mockLlm = Bun.serve({
      port: 0,
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return Response.json({ error: "not a real LLM" }, { status: 501 });
      },
    });
    mockPort = mockLlm.port ?? 0;
    prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
    process.env.TUANTUAN_MOCK_HARNESS = "1";
    resetLoginShellEnv();
    ({ app, server } = serve({ dbPath: ":memory:" }, 0));
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prev;
    mockLlm.stop(true);
    app.host.shutdown();
    server.stop(true);
    void import("../server/harness").then((m) => m.resetLoginShellEnv());
  });

  test("mock ACP agent inherits ANTHROPIC_BASE_URL (CC Switch style)", async () => {
    const a = (await fetch(base + "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agentInput("EnvBot")),
    }).then((r) => r.json())) as Agent;
    const room = (await fetch(base + "/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e", kind: "dm", agentIds: [a.id] }),
    }).then((r) => r.json())) as Room;
    await fetch(base + `/api/rooms/${room.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/env ANTHROPIC_BASE_URL", senderName: "Andy" }),
    });
    await app.orchestrator.idle(room.id);
    const ms = (await fetch(base + `/api/rooms/${room.id}/messages`).then((r) => r.json())) as {
      messages: Message[];
    };
    const reply = ms.messages.at(-1)?.content ?? "";
    expect(reply).toContain(`ANTHROPIC_BASE_URL=http://127.0.0.1:${mockPort}/v1`);
  });

  test("claude-agent-acp + codex-acp hit local mocks via user-style env / CODEX_HOME", async () => {
    const { detectHarness, harnessSpec, loginShellEnv } = await import("../server/harness");
    const { AcpProcess, withTimeout } = await import("../server/acp");
    const { harnessProcessEnv } = await import("../server/harness-env");
    const { methods } = await import("@agentclientprotocol/sdk");
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const claudeHits: string[] = [];
    const codexHits: string[] = [];
    const claudeMock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        claudeHits.push(`${req.method} ${new URL(req.url).pathname}`);
        // Minimal Anthropic-ish error so the client stops cleanly.
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "mock" } },
          { status: 400 },
        );
      },
    });
    const codexMock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        codexHits.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ error: { message: "mock" } }, { status: 400 });
      },
    });

    const report: Record<string, unknown> = {};
    try {
      const claude = await detectHarness(harnessSpec("claude-code")!, null);
      const codex = await detectHarness(harnessSpec("codex")!, null);
      report.claudeInstalled = !!claude.path;
      report.codexInstalled = !!codex.path;

      if (claude.path) {
        const cwd = mkdtempSync(join(tmpdir(), "tt-claude-"));
        const login = await loginShellEnv();
        const env = harnessProcessEnv(
          {
            ...login,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudeMock.port}`,
            ANTHROPIC_API_KEY: "sk-mock",
            ANTHROPIC_AUTH_TOKEN: "sk-mock",
          },
          {},
          {},
          { identity: "claude-meta" },
          "",
        );
        expect(env.ANTHROPIC_BASE_URL).toContain(String(claudeMock.port));
        expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
        const p = new AcpProcess(
          { command: claude.path, args: harnessSpec("claude-code")!.args, env, cwd },
          { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
        );
        try {
          await p.initialize(20_000);
          const s = await withTimeout(
            p.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
            30_000,
            "claude session/new",
          );
          await withTimeout(
            p.agent.request(methods.agent.session.prompt, {
              sessionId: s.sessionId,
              prompt: [{ type: "text", text: "ping" }],
            }),
            45_000,
            "claude prompt",
          ).catch((e: Error) => e.message);
        } finally {
          p.kill();
        }
        report.claudeHits = claudeHits;
      }

      if (codex.path) {
        const cwd = mkdtempSync(join(tmpdir(), "tt-codex-"));
        const home = mkdtempSync(join(tmpdir(), "tt-codex-home-"));
        writeFileSync(
          join(home, "config.toml"),
          `model_provider = "ttmock"\nmodel = "mock"\n\n[model_providers.ttmock]\nname = "ttmock"\nbase_url = "http://127.0.0.1:${codexMock.port}/v1"\nwire_api = "responses"\n`,
        );
        writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-mock" }));
        const login = await loginShellEnv();
        const env = harnessProcessEnv(
          { ...login, CODEX_HOME: home },
          { CODEX_HOME: "/tmp/should-not-win" },
          {},
          { identity: "codex-env" },
          "tuantuan-identity",
        );
        expect(env.CODEX_HOME).toBe(home);
        expect(JSON.parse(env.CODEX_CONFIG!).model_provider).toBeUndefined(); // from file, not CODEX_CONFIG
        expect(JSON.parse(env.CODEX_CONFIG!).developer_instructions).toBe("tuantuan-identity");
        const p = new AcpProcess(
          { command: codex.path, args: harnessSpec("codex")!.args, env, cwd },
          { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
        );
        try {
          await p.initialize(20_000);
          const s = await withTimeout(
            p.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
            30_000,
            "codex session/new",
          );
          await withTimeout(
            p.agent.request(methods.agent.session.prompt, {
              sessionId: s.sessionId,
              prompt: [{ type: "text", text: "ping" }],
            }),
            45_000,
            "codex prompt",
          ).catch((e: Error) => e.message);
        } finally {
          p.kill();
        }
        report.codexHits = codexHits;
        report.codexHomeUsed = home;
      }
    } finally {
      claudeMock.stop(true);
      codexMock.stop(true);
    }
    console.log(JSON.stringify(report));
    // At least one adapter should have talked to its mock if installed.
    if (report.claudeInstalled) expect((report.claudeHits as string[]).length).toBeGreaterThan(0);
    if (report.codexInstalled) expect((report.codexHits as string[]).length).toBeGreaterThan(0);
  });
});
