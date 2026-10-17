import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "../server/app";
import { resetLoginShellEnv } from "../server/harness";
import { harnessRuntimeIdentity, invalidateHarnessRuntime, resolveCodexCommand } from "../server/harness-runtime";
import type { SessionView } from "../server/host";
import { agentInput, until } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "tt-harness-updates-"));
const executable = join(root, "fixture-acp");
const shell = join(root, "login-shell");
const log = join(root, "calls.jsonl");
const pause = join(root, "pause-probe");
const probeRelease = join(root, "probe-release");
const turnRelease = join(root, "turn-release");
const previousShell = process.env.SHELL;
let app: ReturnType<typeof serve>["app"];
let server: ReturnType<typeof serve>["server"];
let base = "";
function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o755 });
}
const status = (id: string, command: string, args: string[] = []) => ({
  id,
  command,
  args,
  version: "adapter-stable",
  source: "override" as const,
  registryId: null,
});
const env = { PATH: process.env.PATH ?? "", HOME: root };
const model = (view: { configOptions: SessionView["configOptions"] }) =>
  view.configOptions.find((option) => option.id === "model")?.currentValue;
const calls = (): { pid: number; method: string; label: string; configId?: string; value?: string }[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

function adapter(label: string) {
  write(
    executable,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const label = ${JSON.stringify(label)};
if (process.argv.includes("--version")) { console.log("adapter-stable"); process.exit(0); }
const paused = existsSync(${JSON.stringify(pause)});
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const sessions = new Map();
const options = session => [
  { id:"model", category:"model", name:"Model", type:"select", currentValue:label, options:[{value:label,name:label}] },
  { id:"effort", category:"thought_level", name:"Effort", type:"select", currentValue:session.level, options:["low","high",...(label.includes("future")?["ultra"]:[])].map(value=>({value,name:value})) },
];
async function request(method, params) {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,method,label,configId:params.configId,value:params.value}) + "\\n");
  if (method === "initialize") return {protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}},loadSession:true},authMethods:[]};
  if (method === "providers/set") return {};
  if (method === "session/new") {
    while (paused && !existsSync(${JSON.stringify(probeRelease)})) await Bun.sleep(10);
    const sessionId = crypto.randomUUID(); const session={level:"high"}; sessions.set(sessionId,session);
    return {sessionId,configOptions:options(session)};
  }
  if (method === "session/resume" || method === "session/load") { const session={level:"high"};sessions.set(params.sessionId,session);return {configOptions:options(session)}; }
  const session=sessions.get(params.sessionId);
  if (method === "session/set_config_option") {session.level=params.value;return {configOptions:options(session)};}
  if (method === "session/prompt") {
    while (!existsSync(${JSON.stringify(turnRelease)})) await Bun.sleep(10);
    return {stopReason:"end_turn"};
  }
  throw new Error("Unsupported " + method);
}
let buffer=""; const decoder=new TextDecoder();
for await(const chunk of Bun.stdin.stream()) {
  buffer+=decoder.decode(chunk,{stream:true});
  for(let newline=buffer.indexOf("\\n");newline>=0;newline=buffer.indexOf("\\n")) {
    const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
    const message=JSON.parse(line);if(message.id==null)continue;
    void request(message.method,message.params||{}).then(result=>send({jsonrpc:"2.0",id:message.id,result}),error=>send({jsonrpc:"2.0",id:message.id,error:{code:-32603,message:error.message}}));
  }
}
`,
  );
  chmodSync(executable, 0o755);
}

beforeAll(() => {
  write(shell, `#!/bin/sh\nprintf '%s\\0' 'PATH=/usr/bin:/bin' 'HOME=${root}'\n`);
  process.env.SHELL = shell;
  resetLoginShellEnv();
  adapter("initial");
  ({ app, server } = serve({ dbPath: join(root, "data", "test.db") }, 0));
  app.store.setSetting("harnessPaths", { opencode: executable });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
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
  app?.store.db.close();
  if (previousShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = previousShell;
  resetLoginShellEnv();
  rmSync(root, { recursive: true, force: true });
});

test("runtime identity detects same-path replacement, package changes and successful-install generations", () => {
  const entry = join(root, "identity", "adapter.js");
  write(entry, "// adapter one\n");
  write(join(dirname(entry), "package.json"), '{"name":"fixture","version":"1"}');
  const selected = status("identity-fixture", process.execPath, [entry]);
  const first = harnessRuntimeIdentity(selected, env);
  write(entry, "// adapter two\n");
  const replacement = harnessRuntimeIdentity(selected, env);
  expect(replacement).not.toBe(first);
  write(join(dirname(entry), "package.json"), '{"name":"fixture","version":"2"}');
  const packageChange = harnessRuntimeIdentity(selected, env);
  expect(packageChange).not.toBe(replacement);
  invalidateHarnessRuntime(selected.id);
  expect(harnessRuntimeIdentity(selected, env)).not.toBe(packageChange);
  expect(harnessRuntimeIdentity(selected, { ...env, API_KEY: "never-part-of-identity" })).not.toContain(
    "never-part-of-identity",
  );
});

test("Pi identity follows the effective Agent engine override rather than an unrelated PATH engine", () => {
  const engine = join(root, "pi-selected");
  const other = join(root, "bin", "pi");
  write(engine, "// selected engine 1\n");
  write(other, "// unrelated engine\n");
  const selected = status("pi", executable);
  const effective = { ...env, PATH: `${dirname(other)}:${env.PATH}`, PI_ACP_PI_COMMAND: engine };
  const first = harnessRuntimeIdentity(selected, effective);
  write(other, "// unrelated update\n");
  expect(harnessRuntimeIdentity(selected, effective)).toBe(first);
  write(engine, "// selected engine 2\n");
  expect(harnessRuntimeIdentity(selected, effective)).not.toBe(first);
});

test("Codex resolves and fingerprints the selected adapter's engine dependency and explicit override", () => {
  const entry = join(root, "codex-adapter", "index.js");
  const engine = join(dirname(entry), "node_modules", "@openai", "codex", "bin", "codex.js");
  write(entry, `#!${process.execPath}\n`);
  write(engine, "// codex engine one\n");
  write(join(dirname(dirname(engine)), "package.json"), '{"name":"@openai/codex","version":"fixture"}');
  const selected = status("codex", process.execPath, [entry]);
  expect(resolveCodexCommand(env, selected)).toEqual([process.execPath, realpathSync(engine)]);
  const first = harnessRuntimeIdentity(selected, env);
  write(engine, "// codex engine two\n");
  expect(harnessRuntimeIdentity(selected, env)).not.toBe(first);
  const nativeName = `@openai/codex-${process.platform}-${process.arch}`;
  const nativePackage = join(dirname(entry), "node_modules", nativeName);
  const native = join(
    nativePackage,
    "vendor",
    "fixture-target",
    "codex",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  write(
    join(dirname(dirname(engine)), "package.json"),
    JSON.stringify({ name: "@openai/codex", optionalDependencies: { [nativeName]: "fixture" } }),
  );
  write(join(nativePackage, "package.json"), '{"version":"fixture"}');
  write(native, "// native one\n");
  const nativeBefore = harnessRuntimeIdentity(selected, env);
  write(native, "// native two\n");
  expect(harnessRuntimeIdentity(selected, env)).not.toBe(nativeBefore);
  const explicit = join(root, "explicit-codex");
  write(explicit, "// override 1\n");
  const override = harnessRuntimeIdentity(selected, { ...env, CODEX_PATH: explicit });
  write(explicit, "// override 2\n");
  expect(harnessRuntimeIdentity(selected, { ...env, CODEX_PATH: explicit })).not.toBe(override);
});

test("Claude identity tracks its adapter SDK platform engine and explicit override, never global claude", () => {
  const entry = join(root, "claude-adapter", "index.js");
  const modules = join(dirname(entry), "node_modules", "@anthropic-ai");
  const sdk = join(modules, "claude-agent-sdk");
  const platform = join(modules, `claude-agent-sdk-${process.platform}-${process.arch}`);
  const binary = join(platform, process.platform === "win32" ? "claude.exe" : "claude");
  write(entry, "// adapter\n");
  write(join(sdk, "package.json"), '{"name":"@anthropic-ai/claude-agent-sdk","main":"sdk.mjs","version":"fixture"}');
  write(join(sdk, "sdk.mjs"), "// sdk\n");
  write(join(platform, "package.json"), '{"version":"fixture"}');
  write(binary, "// platform engine one\n");
  const global = join(root, "bin", "claude");
  write(global, "// unrelated global cli\n");
  const selected = status("claude-code", process.execPath, [entry]);
  const effective = { ...env, PATH: `${dirname(global)}:${env.PATH}` };
  const first = harnessRuntimeIdentity(selected, effective);
  write(global, "// unrelated global update\n");
  expect(harnessRuntimeIdentity(selected, effective)).toBe(first);
  write(binary, "// platform engine two\n");
  expect(harnessRuntimeIdentity(selected, effective)).not.toBe(first);
  const explicit = join(root, "explicit-claude");
  write(explicit, "// explicit engine one\n");
  const override = harnessRuntimeIdentity(selected, { ...effective, CLAUDE_CODE_EXECUTABLE: explicit });
  write(explicit, "// explicit engine two\n");
  expect(harnessRuntimeIdentity(selected, { ...effective, CLAUDE_CODE_EXECUTABLE: explicit })).not.toBe(override);
});

async function options(harness = "opencode") {
  const response = await fetch(`${base}/api/harnesses/${harness}/options`);
  expect(response.status).toBe(200);
  return (await response.json()) as SessionView;
}

test("Host follows the Agent's actual Pi engine override when only that engine changes", async () => {
  adapter("pi-adapter-stable");
  const engine = join(root, "agent-pi-engine");
  const unrelated = join(root, "unrelated-pi-engine");
  write(engine, "// selected one\n");
  write(unrelated, "// other one\n");
  app.store.setSetting("harnessPaths", { opencode: executable, pi: executable });
  const agent = app.store.createAgent(
    agentInput("PiEngineUpdate", { harness: "pi", env: { PI_ACP_PI_COMMAND: engine } }),
  );
  const project = app.store.createProject("pi engine", root);
  const room = app.store.createRoom("pi engine", [agent.id], { projectId: project.id });
  const before = await app.host.session(room, agent, "");
  write(unrelated, "// other two\n");
  expect((await app.host.session(room, agent, "")).proc).toBe(before.proc);
  write(engine, "// selected two\n");
  expect((await app.host.session(room, agent, "")).proc).not.toBe(before.proc);
});

test("same-path CLI replacement invalidates cached ACP options without an explicit refresh", async () => {
  adapter("cache-one");
  expect(model(await options())).toBe("cache-one");
  const before = calls().filter(({ method }) => method === "initialize").length;
  expect(model(await options())).toBe("cache-one");
  expect(calls().filter(({ method }) => method === "initialize")).toHaveLength(before);
  adapter("cache-two");
  expect(model(await options())).toBe("cache-two");
});

test("a changed effective Harness engine environment invalidates options without exposing secrets", async () => {
  adapter("env-cache");
  const first = join(root, "env-pi-one");
  const second = join(root, "env-pi-two");
  write(first, "// one\n");
  write(second, "// two\n");
  const previous = app.store.getSetting("harnessEnv", {});
  try {
    app.store.setSetting("harnessEnv", { pi: { PI_ACP_PI_COMMAND: first, PI_API_KEY: "cache-must-not-leak-fixture" } });
    const result = await options("pi");
    expect(JSON.stringify(result)).not.toContain("cache-must-not-leak-fixture");
    const before = calls().filter(({ method }) => method === "initialize").length;
    await options("pi");
    expect(calls().filter(({ method }) => method === "initialize")).toHaveLength(before);
    app.store.setSetting("harnessEnv", {
      pi: { PI_ACP_PI_COMMAND: second, PI_API_KEY: "cache-must-not-leak-fixture" },
    });
    await options("pi");
    expect(calls().filter(({ method }) => method === "initialize")).toHaveLength(before + 1);
    expect(
      harnessRuntimeIdentity(status("pi", executable), {
        ...env,
        PI_ACP_PI_COMMAND: second,
        PI_API_KEY: "cache-must-not-leak-fixture",
      }),
    ).not.toContain("cache-must-not-leak-fixture");
    expect(readFileSync(log, "utf8")).not.toContain("cache-must-not-leak-fixture");
  } finally {
    app.store.setSetting("harnessEnv", previous);
  }
});

test("a saved unsupported effort follows a same-path upgrade when the new ACP exposes it", async () => {
  adapter("upgrade-before");
  const agent = app.store.createAgent(agentInput("FutureEffort", { harness: "opencode" }));
  const project = app.store.createProject("future effort", root);
  const room = app.store.createRoom("future effort", [agent.id], { projectId: project.id });
  app.store.setRoomConfig(room.id, agent.id, "effort", "ultra");
  const before = await app.host.session(room, agent, "");
  expect(before.slot.view.configOptions.find((option) => option.id === "effort")?.currentValue).toBe("high");
  expect(
    calls().filter(
      (call) =>
        call.pid === before.proc.acp.proc.pid && call.method === "session/set_config_option" && call.value === "ultra",
    ),
  ).toEqual([]);
  expect(app.store.getRoomConfig(room.id, agent.id).effort).toBe("ultra");
  adapter("upgrade-future");
  const after = await app.host.session(room, agent, "");
  expect(after.proc).not.toBe(before.proc);
  expect(after.slot.view.configOptions.find((option) => option.id === "effort")?.currentValue).toBe("ultra");
  expect(calls()).toContainEqual(
    expect.objectContaining({ pid: after.proc.acp.proc.pid, method: "session/set_config_option", value: "ultra" }),
  );
  expect(app.store.getRoomConfig(room.id, agent.id).effort).toBe("ultra");
});

test("an older in-flight probe cannot replace the new runtime's cached capabilities", async () => {
  rmSync(probeRelease, { force: true });
  write(pause, "pause");
  adapter("probe-old");
  const old = options();
  await until(() => calls().some((call) => call.method === "session/new" && call.label === "probe-old"));
  rmSync(pause);
  adapter("probe-new");
  try {
    expect(model(await options())).toBe("probe-new");
  } finally {
    write(probeRelease, "release");
  }
  expect(model(await old)).toBe("probe-new");
  expect(model(await options())).toBe("probe-new");
});

test("successful install preserves active rooms and refreshes only idle/next-turn processes with saved intent", async () => {
  adapter("active-build");
  rmSync(turnRelease, { force: true });
  const agent = app.store.createAgent(agentInput("UpdateAgent", { harness: "opencode" }));
  const project = app.store.createProject("updates", root);
  const activeRoom = app.store.createRoom("active", [agent.id], { projectId: project.id });
  const idleRoom = app.store.createRoom("idle", [agent.id], { projectId: project.id });
  await app.host.setConfig(activeRoom, agent, "", "effort", "low");
  const active = await app.host.session(activeRoom, agent, "");
  const idle = await app.host.session(idleRoom, agent, "");
  const turn = app.host.prompt(
    activeRoom,
    agent,
    "",
    [{ type: "text", text: "Wait for fixture release" }],
    () => {},
    new AbortController().signal,
  );
  await until(() => calls().some((call) => call.pid === active.proc.acp.proc.pid && call.method === "session/prompt"));
  app.installer.startTask("opencode", "fixture", "Successful fixture install", async () => {});
  await until(() => app.installer.get("opencode")?.state === "done");
  expect(active.proc.acp.proc.exitCode).toBeNull();
  expect((await app.host.session(activeRoom, agent, "")).proc).toBe(active.proc);
  const nextIdle = await app.host.session(idleRoom, agent, "");
  expect(nextIdle.proc).not.toBe(idle.proc);
  expect(active.proc.acp.proc.exitCode).toBeNull();
  write(turnRelease, "release");
  await turn;
  const nextActive = await app.host.session(activeRoom, agent, "");
  expect(nextActive.proc).not.toBe(active.proc);
  expect(nextActive.slot.view.configOptions.find((option) => option.id === "effort")?.currentValue).toBe("low");
});
