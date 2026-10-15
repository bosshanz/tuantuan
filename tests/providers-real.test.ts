import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import { resetLoginShellEnv } from "../server/harness";
import type { Agent, Message, Project, Room } from "../server/store";
import { agentInput } from "./helpers";

/**
 * Real bundled adapters (claude-agent-acp, codex-acp) against local mock model APIs: a provider
 * profile must reach the model endpoint with its key, over the user's own inherited settings,
 * without any login and without writing ~/.claude/settings.json or ~/.codex/config.toml.
 */
const dir = mkdtempSync(join(tmpdir(), "prov-real-"));
const home = join(dir, "home");
const calls: { api: string; path: string; auth: string | null; model: unknown }[] = [];

const sse = (chunks: string) => new Response(chunks, { headers: { "content-type": "text/event-stream" } });
const ev = (t: string, d: Record<string, unknown>) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const b = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>;
    const auth = req.headers.get("authorization") ?? req.headers.get("x-api-key");
    if (u.pathname.startsWith("/local/v1/messages"))
      calls.push({ api: "local", path: u.pathname, auth, model: b.model });
    if (u.pathname.startsWith("/anthropic/v1/messages") || u.pathname.startsWith("/local/v1/messages")) {
      if (u.pathname.startsWith("/anthropic")) calls.push({ api: "anthropic", path: u.pathname, auth, model: b.model });
      if (!b.stream)
        return Response.json({
          id: "m",
          type: "message",
          role: "assistant",
          model: b.model,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      return sse(
        ev("message_start", {
          message: {
            id: "m1",
            type: "message",
            role: "assistant",
            model: b.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "来自 Claude 服务商" } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
          ev("message_stop", {}),
      );
    }
    if (u.pathname === "/openai/v1/responses") {
      calls.push({ api: "openai", path: u.pathname, auth, model: b.model });
      const item = {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "output_text", text: "来自 Codex 服务商" }],
      };
      return sse(
        ev("response.created", { response: { id: "r1" } }) +
          ev("response.output_item.added", { output_index: 0, item: { ...item, content: [] } }) +
          ev("response.output_text.delta", {
            item_id: "m1",
            output_index: 0,
            content_index: 0,
            delta: "来自 Codex 服务商",
          }) +
          ev("response.output_item.done", { output_index: 0, item }) +
          ev("response.completed", {
            response: {
              id: "r1",
              usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 5,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: 15,
              },
            },
          }),
      );
    }
    return Response.json({ object: "list", data: [], models: [] });
  },
});
const base = `http://127.0.0.1:${mock.port}`;

// The "user's login shell": their own key + base URL, which the profile must override.
const oldShell = process.env.SHELL;
const shell = join(dir, "login.sh");
writeFileSync(
  shell,
  `#!/bin/sh\nprintf "PATH=%s\\0HOME=${home}\\0ANTHROPIC_API_KEY=user-own-key\\0ANTHROPIC_BASE_URL=http://127.0.0.1:9\\0OPENAI_API_KEY=user-own-openai\\0" "$PATH"\n`,
);
chmodSync(shell, 0o755);

const { app, server } = serve({ dbPath: ":memory:" }, 0);
const api = async <T>(m: string, p: string, b?: unknown) => {
  const r = await fetch(`http://localhost:${server.port}${p}`, {
    method: m,
    headers: { "content-type": "application/json" },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  return { status: r.status, data: (await r.json()) as T };
};

beforeAll(() => {
  process.env.SHELL = shell;
  resetLoginShellEnv();
});
afterAll(() => {
  app.host.shutdown();
  server.stop(true);
  mock.stop(true);
  process.env.SHELL = oldShell;
  resetLoginShellEnv();
});

async function turn(harness: string, providerId: string, tag = "") {
  const a = await api<Agent>(
    "POST",
    "/api/agents",
    agentInput(`A-${harness}${tag}`, { harness, providerId, permissionPolicy: "allow" }),
  );
  expect(a.status).toBe(201);
  const pj = await api<Project>("POST", "/api/projects", {
    name: `${harness}${tag}`,
    cwd: mkdtempSync(join(dir, "cwd-")),
  });
  const room = await api<Room>("POST", "/api/rooms", {
    name: `${harness}${tag}`,
    agentIds: [a.data.id],
    projectId: pj.data.id,
  });
  await api<Message>("POST", `/api/rooms/${room.data.id}/messages`, { senderName: "Andy", content: "hi" });
  await app.orchestrator.idle(room.data.id);
  return last(room.data.id);
}
const last = async (roomId: string) =>
  (await api<{ messages: Message[] }>("GET", `/api/rooms/${roomId}/messages`)).data.messages.at(-1);

test(
  "Claude Code and Codex reach the profile's endpoint with its key",
  async () => {
    const p = await api<{ id: string }>("POST", "/api/providers", {
      name: "Mock",
      anthropicBaseUrl: `${base}/anthropic`,
      openaiBaseUrl: `${base}/openai/v1`,
      wireApi: "responses",
      apiKey: "sk-profile-key",
      model: "mock-model",
    });
    expect(p.status).toBe(201);

    const c = await turn("claude-code", p.data.id);
    expect(JSON.stringify(c?.content)).toContain("来自 Claude 服务商");
    const ca = calls.filter((x) => x.api === "anthropic" && x.model === "mock-model");
    expect(ca.length).toBeGreaterThan(0);
    expect(ca.every((x) => x.auth?.includes("sk-profile-key"))).toBe(true);

    const x = await turn("codex", p.data.id);
    expect(JSON.stringify(x?.content)).toContain("来自 Codex 服务商");
    expect(calls.filter((y) => y.api === "openai")).toContainEqual(
      expect.objectContaining({ auth: "Bearer sk-profile-key", model: "mock-model" }),
    );

    // editing the profile applies to agents using it on their next turn
    const rooms = (await api<Room[]>("GET", "/api/rooms")).data;
    const cxRoom = rooms.find((r) => r.name === "codex");
    await api("PUT", `/api/providers/${p.data.id}`, {
      name: "Mock",
      anthropicBaseUrl: `${base}/anthropic`,
      openaiBaseUrl: `${base}/openai/v1`,
      wireApi: "responses",
      apiKey: "sk-rotated",
      model: "mock-model-2",
    });
    await api("POST", `/api/rooms/${cxRoom?.id}/messages`, { senderName: "Andy", content: "again" });
    await app.orchestrator.idle(cxRoom?.id as string);
    expect(JSON.stringify((await last(cxRoom?.id as string))?.content)).toContain("来自 Codex 服务商");
    expect(calls.at(-1)).toMatchObject({ api: "openai", auth: "Bearer sk-rotated", model: "mock-model-2" });

    // user config files untouched (never written by us)
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(home, ".codex", "auth.json"))).toBe(false);

    const u = await api<{ tuantuan: { harness: string; providerId: string; total: number }[] }>("GET", "/api/usage");
    expect(u.data.tuantuan).toContainEqual(
      expect.objectContaining({ harness: "codex", providerId: p.data.id, turns: 2, total: 30 }),
    );
    expect(u.data.tuantuan).toContainEqual(expect.objectContaining({ harness: "claude-code", providerId: p.data.id }));
  },
  { timeout: 150_000 },
);

test(
  "Claude Code: the profile wins over the user's settings.json env, and model choices follow the profile",
  async () => {
    // A user whose ~/.claude/settings.json points Claude Code at their own endpoint and model.
    // Claude Code applies that env over the process env, so a plain env injection loses.
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const mine = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: `${base}/local`,
        ANTHROPIC_AUTH_TOKEN: "user-settings-token",
        ANTHROPIC_API_KEY: "user-settings-key",
        ANTHROPIC_MODEL: "glm-local",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-local",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-local",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-local",
      },
    });
    writeFileSync(settings, mine);
    const p = await api<{ id: string }>("POST", "/api/providers", {
      name: "GLM",
      anthropicBaseUrl: `${base}/anthropic`,
      apiKey: "sk-glm-key",
      model: "glm-prov",
      smallModel: "glm-prov-air",
    });

    // the 默认设置 model list is probed with the profile applied, not the local config
    const local = await api<{ configOptions: { id: string; options?: { name: string }[] }[] }>(
      "GET",
      "/api/harnesses/claude-code/options",
    );
    const prov = await api<{ configOptions: { id: string; options?: { name: string }[] }[] }>(
      "GET",
      `/api/harnesses/claude-code/options?provider=${p.data.id}`,
    );
    const names = (r: typeof prov) =>
      JSON.stringify(r.data.configOptions.find((o) => o.id === "model")?.options?.map((o) => o.name));
    expect(names(local)).toContain("glm-local");
    expect(names(prov)).toContain("glm-prov");
    expect(names(prov)).toContain("glm-prov-air");
    expect(names(prov)).not.toContain("glm-local");

    calls.length = 0;
    const c = await turn("claude-code", p.data.id, "-glm");
    expect(JSON.stringify(c?.content)).toContain("来自 Claude 服务商");
    expect(calls.filter((x) => x.api === "local")).toEqual([]);
    const ca = calls.filter((x) => x.api === "anthropic");
    expect(ca.length).toBeGreaterThan(0);
    expect(ca.some((x) => x.model === "glm-prov")).toBe(true);
    expect(ca.every((x) => x.auth?.includes("sk-glm-key"))).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe(mine); // never written
  },
  { timeout: 150_000 },
);
