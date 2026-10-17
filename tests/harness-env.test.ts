import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { AcpProcess, withTimeout } from "../server/acp";
import { serve } from "../server/app";
import { bundledAdapter, harnessSpec, resetLoginShellEnv } from "../server/harness";
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
    expect(JSON.parse(env.CODEX_CONFIG as string).model_provider).toBe("mine");
    expect(JSON.parse(env.CODEX_CONFIG as string).developer_instructions).toBe("id");
    expect(env.EXTRA).toBe("1");
  });

  test("Codex identity merges into Agent config without replacing its explicit reasoning choice", () => {
    const env = harnessProcessEnv(
      { CODEX_CONFIG: JSON.stringify({ model_reasoning_effort: "high", developer_instructions: "login" }) },
      {},
      { CODEX_CONFIG: JSON.stringify({ model_reasoning_effort: "none", developer_instructions: "agent" }) },
      { identity: "codex-env" },
      "identity",
    );
    expect(JSON.parse(env.CODEX_CONFIG as string)).toEqual({
      model_reasoning_effort: "none",
      developer_instructions: "agent\n\nidentity",
    });
  });

  test("OpenCode's question tool is enabled by default but an explicit value wins", () => {
    const defaults = harnessProcessEnv({}, {}, {}, { id: "opencode", identity: "first-prompt" }, "");
    expect(defaults.OPENCODE_ENABLE_QUESTION_TOOL).toBe("1");
    const explicit = harnessProcessEnv(
      { OPENCODE_ENABLE_QUESTION_TOOL: "0" },
      {},
      {},
      { id: "opencode", identity: "first-prompt" },
      "",
    );
    expect(explicit.OPENCODE_ENABLE_QUESTION_TOOL).toBe("0");
    const other = harnessProcessEnv({}, {}, {}, { id: "claude-code", identity: "first-prompt" }, "");
    expect(other.OPENCODE_ENABLE_QUESTION_TOOL).toBeUndefined();
  });

  test("materializeSkills never returns isolation env or writes shared project links", () => {
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
      expect(existsSync(join(cwd, ".agents"))).toBe(false);
      expect(existsSync(join(cwd, ".claude"))).toBe(false);
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
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tt-harness-env-"));
  const previousShell = process.env.SHELL;

  beforeAll(() => {
    const shell = join(fixtureRoot, "login-shell");
    writeFileSync(
      shell,
      `#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\0HOME=${fixtureRoot}\\0NO_PROXY=127.0.0.1,localhost\\0no_proxy=127.0.0.1,localhost\\0'\n`,
    );
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
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
    ({ app, server } = serve({ dbPath: join(fixtureRoot, "data", "env.db") }, 0));
    base = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prev;
    mockLlm.stop(true);
    app.host.shutdown();
    app.registry.stop();
    server.stop(true);
    app.store.db.close();
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    resetLoginShellEnv();
    await Bun.sleep(300);
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("mock ACP agent inherits ANTHROPIC_BASE_URL (CC Switch style)", async () => {
    const a = (await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agentInput("EnvBot")),
    }).then((r) => r.json())) as Agent;
    const room = (await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e", kind: "dm", agentIds: [a.id] }),
    }).then((r) => r.json())) as Room;
    await fetch(`${base}/api/rooms/${room.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/env ANTHROPIC_BASE_URL", senderName: "Andy" }),
    });
    await app.orchestrator.idle(room.id);
    const ms = (await fetch(`${base}/api/rooms/${room.id}/messages`).then((r) => r.json())) as {
      messages: Message[];
    };
    const reply = ms.messages.at(-1)?.content ?? "";
    expect(reply).toContain(`ANTHROPIC_BASE_URL=http://127.0.0.1:${mockPort}/v1`);
  });

  for (const id of ["claude-code", "codex"] as const) {
    test(`bundled ${id} inherits a synthetic user's provider config and reaches only the local mock`, async () => {
      const hits: string[] = [];
      const mock = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          hits.push(`${req.method} ${new URL(req.url).pathname}`);
          // Stop the model request without invoking any tools or making a paid call.
          return Response.json(
            { type: "error", error: { type: "invalid_request_error", message: "mock" } },
            { status: 400 },
          );
        },
      });
      let adapterProcess: AcpProcess | undefined;
      try {
        const spec = harnessSpec(id);
        if (!spec) throw new Error(`Missing harness ${id}`);
        const adapter = bundledAdapter(spec);
        expect(adapter).not.toBeNull();
        if (!adapter) throw new Error(`Missing bundled ${id} adapter`);
        const home = join(fixtureRoot, `${id}-home`);
        const cwd = join(fixtureRoot, `${id}-cwd`);
        mkdirSync(home);
        mkdirSync(cwd);
        // This is the test user's login environment, not the developer machine's config or credentials.
        const login = {
          HOME: home,
          PATH: "/usr/bin:/bin",
          TMPDIR: tmpdir(),
          LANG: "en_US.UTF-8",
          // Native SDKs may use the machine's system proxy even without HTTP_PROXY in this env.
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        };
        const baseUrl = `http://127.0.0.1:${mock.port}`;
        if (id === "codex") {
          writeFileSync(
            join(home, "config.toml"),
            `model_provider = "ttmock"\nmodel = "mock"\n\n[model_providers.ttmock]\nname = "ttmock"\nbase_url = "${baseUrl}/v1"\nwire_api = "responses"\n`,
          );
          writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-mock" }));
        }
        const env =
          id === "claude-code"
            ? harnessProcessEnv(
                { ...login, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "sk-mock" },
                {},
                {},
                { identity: "claude-meta" },
                "",
              )
            : harnessProcessEnv(
                { ...login, CODEX_HOME: home },
                { CODEX_HOME: "/tmp/should-not-win" },
                {},
                { identity: "codex-env" },
                "tuantuan-identity",
              );
        expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
        if (id === "codex") {
          expect(env.CODEX_HOME).toBe(home);
          expect(JSON.parse(env.CODEX_CONFIG as string).model_provider).toBeUndefined(); // inherited from config.toml
          expect(JSON.parse(env.CODEX_CONFIG as string).developer_instructions).toBe("tuantuan-identity");
        } else expect(env.ANTHROPIC_BASE_URL).toBe(baseUrl);
        adapterProcess = new AcpProcess(
          { command: process.execPath, args: [adapter.script], env, cwd },
          { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
        );
        await adapterProcess.initialize(10_000);
        const session = await withTimeout(
          adapterProcess.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
          10_000,
          `${id} session/new`,
        );
        // The synthetic endpoint deliberately rejects the model request; reaching it is the assertion.
        await withTimeout(
          adapterProcess.agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "ping" }],
          }),
          15_000,
          `${id} prompt`,
        ).catch(() => {});
        expect(
          hits.some((path) => path.startsWith(id === "claude-code" ? "POST /v1/messages" : "POST /v1/responses")),
        ).toBe(true);
      } finally {
        adapterProcess?.kill();
        mock.stop(true);
      }
    }, 45_000);
  }
});
