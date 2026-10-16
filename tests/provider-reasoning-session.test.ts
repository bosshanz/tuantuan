import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { serve } from "../server/app";
import { resetLoginShellEnv } from "../server/harness";
import type { SessionView } from "../server/host";
import { agentInput, until } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "tt-provider-reasoning-session-"));
const home = join(scratch, "home");
const executable = join(scratch, "fake-acp");
const shell = join(scratch, "login-shell");
const callsFile = join(scratch, "calls.jsonl");
const sessionsFile = join(scratch, "sessions.json");
const probeSettings = join(scratch, "probe.json");
const previousShell = process.env.SHELL;
const harnesses = ["pi", "opencode", "codex", "claude-code"] as const;
type Harness = (typeof harnesses)[number];
const reasoningId = (harness: Harness) =>
  ({ pi: "thinking_level", opencode: "thought_level", codex: "reasoning_effort", "claude-code": "effort" })[harness];
let app: ReturnType<typeof serve>["app"];
let server: ReturnType<typeof serve>["server"];
let base = "";

interface Call {
  pid: number;
  method: string;
  sessionId?: string;
  configId?: string;
  value?: string;
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
  writeFileSync(
    shell,
    `#!/bin/sh\nprintf '%s\\0' 'PATH=/usr/bin:/bin' 'HOME=${home}' 'PI_ACP_PI_COMMAND=${executable}'\n`,
  );
  chmodSync(shell, 0o755);
  // Real Host/API transport with a deterministic ACP peer, not a provider or paid model call.
  // Persist levels so restore and model switching can prove explicit intent beats native defaults.
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("1.19.0"); process.exit(0); }
const callsFile = ${JSON.stringify(callsFile)};
const sessionsFile = ${JSON.stringify(sessionsFile)};
const probeSettings = ${JSON.stringify(probeSettings)};
const sessions = existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) : {};
const codex = JSON.parse(process.env.CODEX_CONFIG || "{}");
const opencode = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
const pi = JSON.parse(process.env.TUANTUAN_PI_PROVIDER || "{}");
const defaultModel = codex.model || opencode.model || (pi.models?.[0] ? "tuantuan/" + pi.models[0].id : process.env.ANTHROPIC_MODEL || "native/default");
const defaultId = codex.model ? "reasoning_effort" : opencode.model ? "thought_level" : pi.models ? "thinking_level" : "effort";
const save = () => writeFileSync(sessionsFile, JSON.stringify(sessions));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const options = (session) => {
  const levels = session.modelLevels?.[session.model] ?? (session.configId === "effort" ? ["default", "low", "medium", "high", "max"] : ["off", "none", "low", "medium", "high"]);
  return [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model,
    options: [...new Set([session.model, ...(session.extraModels || [])])].map(value => ({ value, name: value })) },
  ...(levels.length ? [{ id: session.configId, name: "Reasoning", category: "thought_level", type: "select", currentValue: session.level,
    options: levels.map(value => ({ value, name: value })) }] : []),
]; };
function request(method, params) {
  appendFileSync(callsFile, JSON.stringify({ pid: process.pid, method, ...params }) + "\\n");
  if (method === "initialize") return {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, authMethods: [],
  };
  if (method === "providers/set") return {};
  if (method === "session/new") {
    const file = join(params.cwd, "reasoning-fixture.json");
    const flags = JSON.parse(readFileSync(existsSync(file) ? file : probeSettings, "utf8"));
    const sessionId = "reasoning-" + crypto.randomUUID();
    const session = sessions[sessionId] = {
      model: defaultModel, configId: flags.configId || defaultId, level: "medium", ...flags,
    };
    save(); return { sessionId, configOptions: options(session) };
  }
  const session = sessions[params.sessionId];
  if (!session) throw new Error("Unknown session");
  if (method === "session/resume" || method === "session/load") {
    if (session.resumeLevel) { session.level = session.resumeLevel; save(); }
    return { configOptions: options(session) };
  }
  if (method === "session/set_config_option") {
    if (params.configId === session.configId) {
      if (params.value === "high" && session.rejectHigh) throw new Error("Fixture rejects high");
      if (!session.ignoreSet) session.level = params.value;
    } else if (params.configId === "model") {
      if (session.rejectModel) throw new Error("Fixture rejects model");
      session.model = params.value;
      if (session.resetLevelOnModel) session.level = "medium";
    }
    save(); return { configOptions: options(session) };
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
  writeFileSync(probeSettings, "{}");
  process.env.SHELL = shell;
  resetLoginShellEnv();
  ({ app, server } = serve({ dbPath: join(scratch, "data", "reasoning.db") }, 0));
  app.store.setSetting("harnessPaths", Object.fromEntries(harnesses.map((harness) => [harness, executable])));
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  try {
    app?.host.shutdown();
    app?.installer.shutdown();
    app?.registry.stop();
    await app?.projectTerminals.shutdown();
    server?.stop(true);
    await until(() =>
      calls().every(({ pid }) => {
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

function provider() {
  return app.store.saveProvider({
    name: "DeepSeek reasoning fixture",
    preset: "deepseek",
    anthropicBaseUrl: "https://fixture.invalid/anthropic",
    openaiBaseUrl: "https://fixture.invalid/v1",
    apiKey: "sk-fixture-unused",
    model: "deepseek-v4-pro",
    smallModel: "deepseek-flash",
    wireApi: "responses",
  });
}

function fixture(
  harness: Harness,
  defaults: Record<string, string> = {},
  flags: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  const cwd = join(scratch, crypto.randomUUID());
  mkdirSync(cwd);
  writeFileSync(join(cwd, "reasoning-fixture.json"), JSON.stringify({ configId: reasoningId(harness), ...flags }));
  const project = app.store.createProject("Reasoning fixture", cwd);
  const agent = app.store.createAgent(
    agentInput(`Reasoning${crypto.randomUUID().slice(0, 8)}`, {
      harness,
      providerId: provider().id,
      configDefaults: defaults,
      env: { HOME: home, PI_ACP_PI_COMMAND: executable, ...env },
    }),
  );
  const room = app.store.createRoom("Reasoning fixture", [agent.id], { projectId: project.id });
  return { room, agent };
}

function level(view: Pick<SessionView, "configOptions">, id: string) {
  return view.configOptions.find((option) => option.id === id)?.currentValue;
}

for (const harness of harnesses) {
  const id = reasoningId(harness);
  test(`${harness}: a known provider thinking model applies high through ACP on a fresh session`, async () => {
    const { room, agent } = fixture(harness);
    const { slot } = await app.host.session(room, agent, "");
    expect(level(slot.view, id)).toBe("high");
    expect(calls()).toContainEqual(
      expect.objectContaining({
        method: "session/set_config_option",
        sessionId: slot.view.sessionId,
        configId: id,
        value: "high",
      }),
    );
    expect(app.store.getRoomConfig(room.id, agent.id)).toEqual({});
  });

  for (const explicit of harness === "claude-code" ? ["low"] : ["off", "none", "low"]) {
    test(`${harness}: an explicit Agent ${explicit} overrides the provider high default`, async () => {
      const { room, agent } = fixture(harness, { [id]: explicit });
      const { slot } = await app.host.session(room, agent, "");
      expect(level(slot.view, id)).toBe(explicit);
      const changes = calls().filter((call) => call.sessionId === slot.view.sessionId && call.configId === id);
      expect(changes.map((call) => call.value)).toEqual([explicit]);
    });
  }

  test(`${harness}: a conversation override wins over Agent and provider defaults`, async () => {
    const { room, agent } = fixture(harness, { [id]: "high" });
    app.store.setRoomConfig(room.id, agent.id, id, "low");
    expect(level((await app.host.session(room, agent, "")).slot.view, id)).toBe("low");
  });

  test(`${harness}: resume and load retain native state when saved choices are inapplicable`, async () => {
    const { room, agent } = fixture(harness, { [id]: "not-an-offered-value" });
    const first = await app.host.session(room, agent, "");
    await app.host.setConfig(room, agent, "", id, "low");
    app.store.setRoomConfig(room.id, agent.id, id, null);
    app.host.dropHarness(harness);
    await first.proc.acp.exited;
    const before = calls().length;
    const restored = await app.host.session(room, agent, "");
    expect(restored.slot.view.sessionId).toBe(first.slot.view.sessionId);
    expect(level(restored.slot.view, id)).toBe("low");
    const loaded = await app.host.switchSession(room, agent, "", first.slot.view.sessionId);
    expect(level(loaded, id)).toBe("low");
    const attaching = calls().slice(before);
    expect(attaching.some((call) => call.method === "session/resume")).toBe(true);
    expect(attaching.some((call) => call.method === "session/load")).toBe(true);
    expect(attaching.filter((call) => call.method === "session/set_config_option" && call.configId === id)).toEqual([]);
  });

  for (const explicit of harness === "claude-code" ? ["low"] : ["off", "none", "low"]) {
    test(`${harness}: explicit Agent ${explicit} survives native defaults on resume and load`, async () => {
      const { room, agent } = fixture(harness, { [id]: explicit }, { resumeLevel: "high" });
      const first = await app.host.session(room, agent, "");
      app.host.dropHarness(harness);
      await first.proc.acp.exited;
      expect(level((await app.host.session(room, agent, "")).slot.view, id)).toBe(explicit);
      expect(level(await app.host.switchSession(room, agent, "", first.slot.view.sessionId), id)).toBe(explicit);
      expect(app.store.getRoomConfig(room.id, agent.id)).toEqual({});
    });

    test(`${harness}: a saved ${explicit} survives an incompatible model and returns when switching back`, async () => {
      const main = ["pi", "opencode"].includes(harness) ? "tuantuan/deepseek-v4-pro" : "deepseek-v4-pro";
      const small = ["pi", "opencode"].includes(harness) ? "tuantuan/deepseek-flash" : "deepseek-flash";
      const { room, agent } = fixture(
        harness,
        { [id]: "high" },
        { extraModels: [small], modelLevels: { [small]: [] }, resetLevelOnModel: true },
      );
      const first = await app.host.session(room, agent, "");
      await app.host.setConfig(room, agent, "", id, explicit);
      const before = calls().length;
      const other = await app.host.setConfig(room, agent, "", "model", small);
      expect(level(other, "model")).toBe(small);
      expect(level(other, id)).toBeUndefined();
      expect(app.store.getRoomConfig(room.id, agent.id)[id]).toBe(explicit);
      const restored = await app.host.setConfig(room, agent, "", "model", main);
      expect(level(restored, id)).toBe(explicit);
      expect(
        calls()
          .slice(before)
          .filter((call) => call.sessionId === first.slot.view.sessionId && call.configId === id)
          .map((call) => call.value),
      ).toEqual([explicit]);
    });
  }

  test(`${harness}: a room choice wins over Agent defaults after restore and model changes`, async () => {
    const main = ["pi", "opencode"].includes(harness) ? "tuantuan/deepseek-v4-pro" : "deepseek-v4-pro";
    const small = ["pi", "opencode"].includes(harness) ? "tuantuan/deepseek-flash" : "deepseek-flash";
    const { room, agent } = fixture(
      harness,
      { [id]: "high" },
      { extraModels: [small], resetLevelOnModel: true, resumeLevel: "high" },
    );
    app.store.setRoomConfig(room.id, agent.id, id, "low");
    const first = await app.host.session(room, agent, "");
    app.host.dropHarness(harness);
    await first.proc.acp.exited;
    expect(level((await app.host.session(room, agent, "")).slot.view, id)).toBe("low");
    expect(level(await app.host.setConfig(room, agent, "", "model", small), id)).toBe("low");
    expect(level(await app.host.setConfig(room, agent, "", "model", main), id)).toBe("low");
  });

  test(`${harness}: an unsupported explicit preference never falls back to an automatic provider level`, async () => {
    const { room, agent } = fixture(harness, { [id]: "unsupported" });
    app.store.setRoomConfig(room.id, agent.id, id, "also-unsupported");
    const { slot } = await app.host.session(room, agent, "");
    expect(level(slot.view, id)).toBe("medium");
    expect(calls().filter((call) => call.sessionId === slot.view.sessionId && call.configId === id)).toEqual([]);
    expect(app.store.getRoomConfig(room.id, agent.id)[id]).toBe("also-unsupported");
  });

  test(`${harness}: a model with different offered levels preserves the explicit choice for switching back`, async () => {
    const main = ["pi", "opencode"].includes(harness) ? "tuantuan/deepseek-v4-pro" : "deepseek-v4-pro";
    const small = ["pi", "opencode"].includes(harness) ? "tuantuan/deepseek-flash" : "deepseek-flash";
    const { room, agent } = fixture(
      harness,
      { [id]: "low" },
      { extraModels: [small], modelLevels: { [small]: ["medium"] }, resetLevelOnModel: true },
    );
    await app.host.session(room, agent, "");
    expect(level(await app.host.setConfig(room, agent, "", "model", small), id)).toBe("medium");
    expect(agent.configDefaults?.[id]).toBe("low");
    expect(app.store.getRoomConfig(room.id, agent.id)[id]).toBeUndefined();
    expect(level(await app.host.setConfig(room, agent, "", "model", main), id)).toBe("low");
  });

  test(`${harness}: a successful ACP response that ignores explicit low keeps the real value visible`, async () => {
    const { room, agent } = fixture(harness, { [id]: "low" }, { ignoreSet: true });
    expect(level((await app.host.session(room, agent, "")).slot.view, id)).toBe("medium");
    expect(level(await app.host.setConfig(room, agent, "", id, "low"), id)).toBe("medium");
    expect(app.store.getRoomConfig(room.id, agent.id)[id]).toBe("low");
  });

  for (const failure of ["rejectHigh", "ignoreSet"]) {
    test(`${harness}: ${failure} leaves the real Harness level visible`, async () => {
      const { room, agent } = fixture(harness, {}, { [failure]: true });
      expect(level((await app.host.session(room, agent, "")).slot.view, id)).toBe("medium");
    });
  }

  test(`${harness}: probing applies high through ACP before caching the real returned options`, async () => {
    writeFileSync(probeSettings, "{}");
    const prov = provider();
    const endpoint = `${base}/api/harnesses/${harness}/options?provider=${prov.id}`;
    const before = calls().length;
    const response = await fetch(endpoint);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { configOptions: acp.SessionConfigOption[]; error: string | null };
    expect(result.error).toBeNull();
    expect(level(result, id)).toBe("high");
    expect(
      calls()
        .slice(before)
        .some((call) => call.method === "session/set_config_option" && call.configId === id && call.value === "high"),
    ).toBe(true);
    const cachedAt = calls().length;
    expect(level((await (await fetch(endpoint)).json()) as SessionView, id)).toBe("high");
    expect(calls().length).toBe(cachedAt);
  });

  for (const failure of ["rejectHigh", "ignoreSet"]) {
    test(`${harness}: probe ${failure} preserves native options and successful login`, async () => {
      writeFileSync(probeSettings, JSON.stringify({ [failure]: true }));
      try {
        const response = await fetch(`${base}/api/harnesses/${harness}/options?provider=${provider().id}`);
        expect(response.status).toBe(200);
        const result = (await response.json()) as { configOptions: acp.SessionConfigOption[]; error: string | null };
        expect(result.error).toBeNull();
        expect(level(result, id)).toBe("medium");
      } finally {
        writeFileSync(probeSettings, "{}");
      }
    });
  }
}

for (const explicit of ["off", "none"]) {
  test(`claude-code: a saved ${explicit} is retained without inventing native support or applying high`, async () => {
    const id = reasoningId("claude-code");
    const { room, agent } = fixture("claude-code", { [id]: explicit }, { resumeLevel: "medium" });
    const first = await app.host.session(room, agent, "");
    expect(level(first.slot.view, id)).toBe("medium");
    app.store.setRoomConfig(room.id, agent.id, id, explicit);
    app.host.dropHarness("claude-code");
    await first.proc.acp.exited;
    expect(level((await app.host.session(room, agent, "")).slot.view, id)).toBe("medium");
    expect(app.store.getRoomConfig(room.id, agent.id)[id]).toBe(explicit);
    expect(calls().some((call) => call.sessionId === first.slot.view.sessionId && call.configId === id)).toBe(false);
  });
}

for (const [harness, env, explicit] of [
  ["codex", { CODEX_CONFIG: JSON.stringify({ model_reasoning_effort: "none" }) }, "none"],
  ["claude-code", { CLAUDE_CODE_EFFORT_LEVEL: "low" }, "low"],
  ["claude-code", { MAX_THINKING_TOKENS: "0" }, "medium"],
] as const) {
  test(`${harness}: explicit native ${Object.keys(env)[0]} outranks the automatic provider default`, async () => {
    const id = reasoningId(harness);
    const { room, agent } = fixture(harness, {}, {}, env);
    const { slot } = await app.host.session(room, agent, "identity fixture");
    expect(level(slot.view, id)).toBe(explicit);
    expect(
      calls().some((call) => call.sessionId === slot.view.sessionId && call.configId === id && call.value === "high"),
    ).toBe(false);
  });

  test(`${harness}: Agent and room preferences outrank explicit native ${Object.keys(env)[0]}`, async () => {
    const id = reasoningId(harness);
    const { room, agent } = fixture(harness, { [id]: "medium" }, {}, env);
    app.store.setRoomConfig(room.id, agent.id, id, "high");
    expect(level((await app.host.session(room, agent, "identity fixture")).slot.view, id)).toBe("high");
  });
}

test("Codex user-file effort survives automatic recommendations while room choices still win", async () => {
  const configDir = mkdtempSync(join(scratch, "codex-native-"));
  writeFileSync(join(configDir, "config.toml"), 'model_reasoning_effort = "low"\n');
  const env = { CODEX_HOME: configDir };
  const first = fixture("codex", {}, {}, env);
  const { slot } = await app.host.session(first.room, first.agent, "");
  expect(level(slot.view, "reasoning_effort")).toBe("low");
  expect(
    calls()
      .filter((call) => call.sessionId === slot.view.sessionId && call.configId === "reasoning_effort")
      .map((call) => call.value),
  ).toEqual(["low"]);

  const second = fixture("codex", { reasoning_effort: "medium" }, {}, env);
  app.store.setRoomConfig(second.room.id, second.agent.id, "reasoning_effort", "high");
  expect(level((await app.host.session(second.room, second.agent, "")).slot.view, "reasoning_effort")).toBe("high");
});

test("complex Codex profiles retain the real native selection instead of applying a recommendation", async () => {
  const configDir = mkdtempSync(join(scratch, "codex-profile-"));
  writeFileSync(join(configDir, "config.toml"), 'profile = "work"\n[profiles.work]\nmodel_reasoning_effort = "low"\n');
  const { room, agent } = fixture("codex", {}, { level: "low" }, { CODEX_HOME: configDir });
  const { slot } = await app.host.session(room, agent, "");
  expect(level(slot.view, "reasoning_effort")).toBe("low");
  expect(
    calls().filter((call) => call.sessionId === slot.view.sessionId && call.configId === "reasoning_effort"),
  ).toEqual([]);
});

test("Pi native settings retain the actual level while explicit Agent choices still win", async () => {
  const settingsDir = mkdtempSync(join(scratch, "pi-settings-"));
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
  const env = { PI_CODING_AGENT_DIR: settingsDir };
  const first = fixture("pi", {}, { level: "low" }, env);
  const { slot } = await app.host.session(first.room, first.agent, "");
  expect(level(slot.view, "thinking_level")).toBe("low");
  expect(
    calls().filter((call) => call.sessionId === slot.view.sessionId && call.configId === "thinking_level"),
  ).toEqual([]);
  const second = fixture("pi", { thinking_level: "high" }, { level: "low" }, env);
  expect(level((await app.host.session(second.room, second.agent, "")).slot.view, "thinking_level")).toBe("high");
});

for (const harness of ["codex", "claude-code"] as const) {
  for (const source of ["Agent", "conversation"]) {
    test(`${harness}: selecting an unknown model in ${source} preferences never inherits DeepSeek reasoning`, async () => {
      const unknown = "unknown/custom-model";
      const { room, agent } = fixture(
        harness,
        { model: source === "Agent" ? unknown : "deepseek-v4-pro" },
        { extraModels: [unknown] },
      );
      if (source === "conversation") app.store.setRoomConfig(room.id, agent.id, "model", unknown);
      const { slot } = await app.host.session(room, agent, "");
      expect(level(slot.view, "model")).toBe(unknown);
      expect(level(slot.view, reasoningId(harness))).toBe("medium");
      const changes = calls().filter(
        (call) => call.sessionId === slot.view.sessionId && call.method === "session/set_config_option",
      );
      expect(changes.map(({ configId, value }) => ({ configId, value }))).toEqual([
        { configId: "model", value: unknown },
      ]);
    });
  }
}

test("codex: a rejected model preference derives reasoning from the model that really remains active", async () => {
  const { room, agent } = fixture(
    "codex",
    { model: "unknown/rejected-model" },
    { extraModels: ["unknown/rejected-model"], rejectModel: true },
  );
  const { slot } = await app.host.session(room, agent, "");
  expect(level(slot.view, "model")).toBe("deepseek-v4-pro");
  expect(level(slot.view, reasoningId("codex"))).toBe("high");
});

test("codex: room none wins over Agent high when resume and load report catalog high", async () => {
  const id = reasoningId("codex");
  const { room, agent } = fixture("codex", { [id]: "high" }, { resumeLevel: "high" });
  const first = await app.host.session(room, agent, "");
  await app.host.setConfig(room, agent, "", id, "none");
  app.host.dropHarness("codex");
  await first.proc.acp.exited;
  const before = calls().length;
  const restored = await app.host.session(room, agent, "");
  expect(restored.slot.view.sessionId).toBe(first.slot.view.sessionId);
  expect(level(restored.slot.view, id)).toBe("none");
  expect(level(await app.host.switchSession(room, agent, "", first.slot.view.sessionId), id)).toBe("none");
  expect(
    calls()
      .slice(before)
      .filter((call) => call.method === "session/set_config_option" && call.configId === id)
      .map((call) => call.value),
  ).toEqual(["none", "none"]);
});

test("codex: explicit Agent none survives resume and load without a saved conversation choice", async () => {
  const id = reasoningId("codex");
  const { room, agent } = fixture("codex", { [id]: "none" }, { resumeLevel: "high" });
  const first = await app.host.session(room, agent, "");
  expect(level(first.slot.view, id)).toBe("none");
  expect(app.store.getRoomConfig(room.id, agent.id)).toEqual({});
  app.host.dropHarness("codex");
  await first.proc.acp.exited;
  const before = calls().length;
  const restored = await app.host.session(room, agent, "");
  expect(level(restored.slot.view, id)).toBe("none");
  expect(level(await app.host.switchSession(room, agent, "", first.slot.view.sessionId), id)).toBe("none");
  expect(
    calls()
      .slice(before)
      .filter((call) => call.method === "session/set_config_option" && call.configId === id)
      .map((call) => call.value),
  ).toEqual(["none", "none"]);
});

for (const savedAgentValue of [undefined, "not-an-offered-value"]) {
  test(`codex: ${savedAgentValue ? "invalid" : "missing"} explicit preferences preserve native reasoning`, async () => {
    const id = reasoningId("codex");
    const { room, agent } = fixture("codex", savedAgentValue ? { [id]: savedAgentValue } : {}, { resumeLevel: "low" });
    const first = await app.host.session(room, agent, "");
    app.host.dropHarness("codex");
    await first.proc.acp.exited;
    const before = calls().length;
    expect(level((await app.host.session(room, agent, "")).slot.view, id)).toBe("low");
    app.store.setRoomConfig(room.id, agent.id, id, "not-an-offered-value");
    expect(level(await app.host.switchSession(room, agent, "", first.slot.view.sessionId), id)).toBe("low");
    expect(
      calls()
        .slice(before)
        .filter((call) => call.method === "session/set_config_option" && call.configId === id),
    ).toEqual([]);
  });
}
