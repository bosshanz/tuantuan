import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { serve } from "../server/app";
import { resetLoginShellEnv } from "../server/harness";
import type { SessionView } from "../server/host";
import type { Agent, Message, Project, Room, UsageStats } from "../server/store";
import { agentInput, until } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "tt-provider-session-"));
const home = join(scratch, "home");
const cwd = join(scratch, "project");
const callsFile = join(scratch, "calls.jsonl");
const sessionsFile = join(scratch, "sessions.json");
const executable = join(scratch, "opencode");
const shell = join(scratch, "login-shell");
const previousShell = process.env.SHELL;
const nativeConfig = JSON.stringify({
  model: "native/local-default",
  provider: { native: { models: { "local-default": { name: "Local default" } } } },
});
let app: ReturnType<typeof serve>["app"];
let server: ReturnType<typeof serve>["server"];
let base = "";

interface Call {
  pid: number;
  method: string;
  sessionId?: string;
  model?: string;
  configuredModel: string;
  models: string[];
  keyLabel: string;
}

function calls(): Call[] {
  return existsSync(callsFile)
    ? readFileSync(callsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call)
    : [];
}

beforeAll(() => {
  mkdirSync(home);
  mkdirSync(cwd);
  writeFileSync(
    shell,
    `#!/bin/sh\nprintf '%s\\0' 'PATH=/usr/bin:/bin' 'HOME=${home}' 'OPENCODE_CONFIG_CONTENT=${nativeConfig}'\n`,
  );
  chmodSync(shell, 0o755);
  // This fake accepts foreign models so the test catches failures in the Host's boundary,
  // and persists history/model state so a replacement process really must load the old session.
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("1.19.0"); process.exit(0); }
const callsFile = ${JSON.stringify(callsFile)};
const sessionsFile = ${JSON.stringify(sessionsFile)};
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
const models = Object.keys(config.provider?.tuantuan?.models || {}).map(id => "tuantuan/" + id);
const keyLabel = process.env.TUANTUAN_PROVIDER_API_KEY === "sk-session-initial" ? "initial"
  : process.env.TUANTUAN_PROVIDER_API_KEY === "sk-session-rotated" ? "rotated" : "unexpected";
const sessions = existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) : {};
const save = () => writeFileSync(sessionsFile, JSON.stringify(sessions));
const log = (method, extra = {}) => appendFileSync(callsFile, JSON.stringify({
  pid: process.pid, method, configuredModel: config.model, models, keyLabel, ...extra,
}) + "\\n");
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const options = session => [{
  id: "model", name: "Model", category: "model", type: "select", currentValue: session.model,
  options: [...new Set([...models, session.model, "native/local-default", "foreign/unrelated"])].map(value => ({ value, name: value })),
}, {
  id: "effort", name: "Effort", type: "select", currentValue: "medium",
  options: [{ value: "medium", name: "Medium" }],
}];
function request(method, params) {
  if (method === "initialize") {
    log(method);
    return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
  }
  if (method === "session/new") {
    const sessionId = "provider-test-" + crypto.randomUUID();
    const session = sessions[sessionId] = { model: "native/local-default", turns: 0 };
    save(); log(method, { sessionId, model: session.model });
    return { sessionId, configOptions: options(session) };
  }
  const session = sessions[params.sessionId];
  if (!session) throw new Error("Unknown session");
  log(method, { sessionId: params.sessionId, model: method === "session/set_config_option" ? params.value : session.model });
  if (method === "session/load") return { configOptions: options(session) };
  if (method === "session/set_config_option") {
    if (params.configId === "model") session.model = params.value;
    save();
    return { configOptions: options(session) };
  }
  if (method === "session/prompt") {
    const update = update => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } });
    update({ sessionUpdate: "config_option_update", configOptions: options(session) });
    update({ sessionUpdate: "agent_message_chunk", content: {
      type: "text", text: "selected=" + session.model + ";key=" + keyLabel + ";history=" + session.turns,
    } });
    update({ sessionUpdate: "usage_update", used: 10, size: 128000 });
    session.turns++; save();
    return { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
  }
  throw new Error("Unsupported method " + method);
}
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (let newline = buffer.indexOf("\\n"); newline >= 0; newline = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id == null) continue;
    try { send({ jsonrpc: "2.0", id: message.id, result: request(message.method, message.params || {}) }); }
    catch (error) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: error.message } }); }
  }
}
`,
  );
  chmodSync(executable, 0o755);
  process.env.SHELL = shell;
  resetLoginShellEnv();
  ({ app, server } = serve({ dbPath: join(scratch, "data", "session.db") }, 0));
  app.store.setSetting("harnessPaths", { opencode: executable });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  const pids = new Set(calls().map((call) => call.pid));
  try {
    app?.host.shutdown();
    app?.installer.shutdown();
    app?.registry.stop();
    await app?.projectTerminals.shutdown();
    server?.stop(true);
    await until(() =>
      [...pids].every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
    );
  } finally {
    app?.store.db.close();
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    resetLoginShellEnv();
    rmSync(scratch, { recursive: true, force: true });
  }
});

async function api<T>(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

function modelOption(options: acp.SessionConfigOption[]) {
  const option = options.find((option) => option.id === "model");
  if (option?.type !== "select") throw new Error("Missing model selector");
  return option;
}

function modelValues(options: acp.SessionConfigOption[]) {
  return modelOption(options)
    .options.flatMap((option) => ("options" in option ? option.options : [option]))
    .map((option) => option.value)
    .sort();
}

test("an OpenCode profile owns model choices and replaces stale restored models after profile edits", async () => {
  const profileBody = {
    name: "Session provider",
    openaiBaseUrl: "https://provider.invalid/v1",
    wireApi: "chat",
    apiKey: "sk-session-initial",
    model: "main-v1",
    smallModel: "fast-v1",
  };
  const profile = await api<{ id: string }>("POST", "/api/providers", profileBody);
  expect(profile.status).toBe(201);
  const probe = await api<{ error: string | null; configOptions: acp.SessionConfigOption[] }>(
    "GET",
    `/api/harnesses/opencode/options?provider=${profile.data.id}`,
  );
  expect(probe.status).toBe(200);
  expect(probe.data.error).toBeNull();
  expect(modelValues(probe.data.configOptions)).toEqual(["tuantuan/fast-v1", "tuantuan/main-v1"]);

  const agent = await api<Agent>(
    "POST",
    "/api/agents",
    agentInput("ProfileSession", {
      harness: "opencode",
      providerId: profile.data.id,
      configDefaults: { model: "native/local-default" },
      env: { HOME: home, OPENCODE_CONFIG_CONTENT: nativeConfig },
    }),
  );
  expect(agent.status).toBe(201);
  const project = await api<Project>("POST", "/api/projects", { name: "Provider session", cwd });
  expect(project.status).toBe(201);
  const room = await api<Room>("POST", "/api/rooms", {
    name: "Provider session",
    agentIds: [agent.data.id],
    projectId: project.data.id,
  });
  expect(room.status).toBe(201);
  const controls = `/api/rooms/${room.data.id}/agents/${agent.data.id}`;
  const turn = async (content: string) => {
    const posted = await api<Message>("POST", `/api/rooms/${room.data.id}/messages`, { senderName: "Tester", content });
    expect(posted.status).toBe(201);
    await app.orchestrator.idle(room.data.id);
    return (await api<{ messages: Message[] }>("GET", `/api/rooms/${room.data.id}/messages`)).data.messages.at(-1);
  };

  expect((await turn("first turn"))?.content).toBe("selected=tuantuan/main-v1;key=initial;history=0");
  const first = await api<SessionView>("GET", `${controls}/session`);
  expect(first.status).toBe(200);
  expect(modelOption(first.data.configOptions).currentValue).toBe("tuantuan/main-v1");
  expect(modelValues(first.data.configOptions)).toEqual(["tuantuan/fast-v1", "tuantuan/main-v1"]);
  const firstPrompt = calls().find(
    (call) => call.method === "session/prompt" && call.sessionId === first.data.sessionId,
  );
  expect(firstPrompt).toMatchObject({ configuredModel: "tuantuan/main-v1", keyLabel: "initial" });

  const foreign = await api<{ error: string }>("POST", `${controls}/config`, {
    configId: "model",
    value: "foreign/unrelated",
  });
  expect(foreign.status).toBe(400);
  expect(foreign.data.error).toContain("当前服务商");
  expect(
    calls().some((call) => call.method === "session/set_config_option" && call.model === "foreign/unrelated"),
  ).toBe(false);
  const fast = await api<SessionView>("POST", `${controls}/config`, {
    configId: "model",
    value: "tuantuan/fast-v1",
  });
  expect(fast.status).toBe(200);
  expect(modelOption(fast.data.configOptions).currentValue).toBe("tuantuan/fast-v1");
  expect(modelValues(fast.data.configOptions)).toEqual(["tuantuan/fast-v1", "tuantuan/main-v1"]);
  expect((await turn("use fast model"))?.content).toBe("selected=tuantuan/fast-v1;key=initial;history=1");

  const edited = await api("PUT", `/api/providers/${profile.data.id}`, {
    ...profileBody,
    apiKey: "sk-session-rotated",
    model: "main-v2",
    smallModel: "",
  });
  expect(edited.status).toBe(200);
  expect((await turn("continue after profile edit"))?.content).toBe("selected=tuantuan/main-v2;key=rotated;history=2");
  const restored = await api<SessionView>("GET", `${controls}/session`);
  expect(restored.status).toBe(200);
  expect(restored.data.sessionId).toBe(first.data.sessionId);
  expect(modelOption(restored.data.configOptions).currentValue).toBe("tuantuan/main-v2");
  expect(modelValues(restored.data.configOptions)).toEqual(["tuantuan/main-v2"]);
  expect(restored.data.usage).toMatchObject({ used: 10, size: 128000 });
  const restoredCalls = calls().filter(
    (call) => call.sessionId === first.data.sessionId && call.keyLabel === "rotated",
  );
  const loadIndex = restoredCalls.findIndex((call) => call.method === "session/load");
  const modelIndex = restoredCalls.findIndex((call) => call.method === "session/set_config_option");
  const promptIndex = restoredCalls.findIndex((call) => call.method === "session/prompt");
  expect(loadIndex).toBeGreaterThanOrEqual(0);
  expect(modelIndex).toBeGreaterThan(loadIndex);
  expect(promptIndex).toBeGreaterThan(modelIndex);
  expect(restoredCalls[loadIndex]).toMatchObject({ model: "tuantuan/fast-v1", configuredModel: "tuantuan/main-v2" });
  expect(restoredCalls[modelIndex]?.model).toBe("tuantuan/main-v2");
  expect(restoredCalls[promptIndex]?.pid).not.toBe(firstPrompt?.pid);

  const editedProbe = await api<{ error: string | null; configOptions: acp.SessionConfigOption[] }>(
    "GET",
    `/api/harnesses/opencode/options?provider=${profile.data.id}`,
  );
  expect(editedProbe.status).toBe(200);
  expect(editedProbe.data.error).toBeNull();
  expect(modelValues(editedProbe.data.configOptions)).toEqual(["tuantuan/main-v2"]);
  const usage = await api<UsageStats>("GET", "/api/usage/stats");
  expect(usage.status).toBe(200);
  expect(usage.data.totals).toMatchObject({ turns: 3, total: 30 });
  expect(usage.data.byModel.map(({ key, total }) => ({ key, total }))).toEqual(
    expect.arrayContaining([
      { key: "tuantuan/main-v1", total: 10 },
      { key: "tuantuan/fast-v1", total: 10 },
      { key: "tuantuan/main-v2", total: 10 },
    ]),
  );
}, 20_000);
