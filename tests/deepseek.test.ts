import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "../server/app";
import { detectHarness, harnessSpec, resetLoginShellEnv, visibleHarnesses } from "../server/harness";
import type { ManagedManifest } from "../server/managed";
import type { Agent, Room } from "../server/store";
import { agentInput, until } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "tt-deepseek-"));
const executable = join(root, "bin", "dsh");
const shell = join(root, "login-shell");
const log = join(root, "calls.jsonl");
const nativeHome = join(root, "native-home");
const managed = join(root, "managed");
const previous = { shell: process.env.SHELL, managed: process.env.TUANTUAN_HARNESS_DIR };
let app: ReturnType<typeof serve>["app"];
let server: ReturnType<typeof serve>["server"];

type Call = { pid: number; method: string; args: string[]; key: string; home: string; params: Record<string, unknown> };
const calls = (): Call[] =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  expect(response.ok, JSON.stringify(result)).toBe(true);
  return result as T;
}

beforeAll(() => {
  mkdirSync(dirname(executable));
  mkdirSync(nativeHome);
  writeFileSync(log, "");
  // This fixture follows the real 0.2.1-rc.2 control surface, including successful keyless new.
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("0.2.1-rc.2"); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const options = () => [{id:"model",name:"Model",category:"model",type:"select",currentValue:"native",options:[{value:"native",name:process.env.DEEPSEEK_API_KEY ? "Configured catalog" : "Native fallback"}]}];
async function request(method, params) {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,method,args:process.argv.slice(2),key:process.env.DEEPSEEK_API_KEY||"",home:process.env.DSH_HOME||"",params})+"\\n");
  if (method === "initialize") return {protocolVersion:1,agentInfo:{name:"deepseek-harness-acp",version:"0.0.1"},agentCapabilities:{sessionCapabilities:{list:{},resume:{},close:{}},promptCapabilities:{image:false}},authMethods:[]};
  if (method === "session/new") {
    if (existsSync(${JSON.stringify(join(root, "auth-error"))})) throw new Error("Authentication required");
    return {sessionId:crypto.randomUUID(),configOptions:options()};
  }
  if (method === "session/prompt") return {stopReason:"end_turn"};
  if (method === "session/close") return {};
  throw new Error("Unsupported "+method);
}
let buffer=""; const decoder=new TextDecoder();
for await(const chunk of Bun.stdin.stream()) {
  buffer+=decoder.decode(chunk,{stream:true});
  for(let newline=buffer.indexOf("\\n");newline>=0;newline=buffer.indexOf("\\n")) {
    const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
    const message=JSON.parse(line);if(message.id==null)continue;
    void request(message.method,message.params||{}).then(result=>send({jsonrpc:"2.0",id:message.id,result}),error=>send({jsonrpc:"2.0",id:message.id,error:{code:-32000,message:error.message}}));
  }
}
`,
  );
  chmodSync(executable, 0o755);
  writeFileSync(
    shell,
    `#!/bin/sh\nprintf '%s\\0' 'PATH=${dirname(executable)}:/usr/bin:/bin' 'HOME=${root}' 'DSH_HOME=${nativeHome}' 'DEEPSEEK_API_KEY='\n`,
    { mode: 0o755 },
  );
  process.env.SHELL = shell;
  process.env.TUANTUAN_HARNESS_DIR = managed;
  resetLoginShellEnv();
  ({ app, server } = serve({ dbPath: join(root, "data", "test.db") }, 0));
  app.store.setSetting("harnessPaths", { opencode: executable });
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
  if (previous.shell === undefined) delete process.env.SHELL;
  else process.env.SHELL = previous.shell;
  if (previous.managed === undefined) delete process.env.TUANTUAN_HARNESS_DIR;
  else process.env.TUANTUAN_HARNESS_DIR = previous.managed;
  resetLoginShellEnv();
  rmSync(root, { recursive: true, force: true });
});

test("official prerelease is curated, pinned, Node-backed and distinct from ACP Registry entries", async () => {
  const spec = harnessSpec("deepseek");
  expect(spec).toMatchObject({
    bin: "dsh",
    args: ["--profile", "acp"],
    runtime: "node",
    identity: "first-prompt",
    curated: true,
    experimental: true,
  });
  expect(
    visibleHarnesses()
      .filter((h) => h.registry === "deepseek-harness")
      .map((h) => h.id),
  ).toEqual(["deepseek"]);
  const entry = app.registry.agent("deepseek-harness");
  expect(entry).toMatchObject({
    origin: "tuantuan",
    version: "0.2.1-rc.2",
    distribution: { npx: { package: "@deepseek-ai/dsh@0.2.1-rc.2", args: ["--profile", "acp"] } },
  });
  expect(entry?.distribution.binary).toBeUndefined();
  const registry = await api<{ agents: { id: string; origin: string; harnessId: string }[] }>("GET", "/api/registry");
  expect(registry.agents.find((a) => a.id === "deepseek-harness")).toMatchObject({
    origin: "tuantuan",
    harnessId: "deepseek",
  });
});

test("local dsh wins; an absent local CLI falls back to the managed Node command and profile args", async () => {
  const spec = harnessSpec("deepseek");
  if (!spec) throw new Error("Missing DeepSeek Harness");
  const dir = join(managed, "agents", "deepseek-harness", "0.2.1-rc.2");
  const node = join(root, "managed-node");
  writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const manifest: ManagedManifest = {
    id: "deepseek-harness",
    version: "0.2.1-rc.2",
    kind: "npx",
    runtime: "node",
    command: node,
    args: [join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "--profile", "acp"],
    env: {},
    dir,
    installedAt: Date.now(),
  };
  mkdirSync(dirname(dir), { recursive: true });
  writeFileSync(join(dirname(dir), "manifest.json"), JSON.stringify(manifest));
  expect(await detectHarness(spec, null)).toMatchObject({
    source: "path",
    command: executable,
    version: "0.2.1-rc.2",
    args: spec.args,
  });
  expect(await detectHarness({ ...spec, bin: "no-local-dsh-fixture" }, null)).toMatchObject({
    source: "managed",
    command: node,
    args: manifest.args,
    version: manifest.version,
  });
  expect(await detectHarness(spec, executable)).toMatchObject({
    source: "override",
    command: executable,
    args: spec.args,
  });
  const local = await detectHarness(spec, null);
  expect(local.installers[0]?.command).toContain("团团补充目录");
  expect(local.installers[0]?.command).not.toContain("ACP Registry");
});

type Probe = {
  ok: boolean;
  loggedIn: boolean | null;
  needsKey: boolean;
  secretEnv: Record<string, string>;
  authMethods: { type: string; vars: string[]; missing: string[] | null }[];
  capabilities: { sessionCapabilities: Record<string, unknown> };
  configOptions: { options: { name: string }[] }[];
};

test("keyless and configured probes remain unknown, preserve native home, and expose actual capabilities", async () => {
  const noKey = await api<Probe>("POST", "/api/harnesses/deepseek/test");
  expect(noKey).toMatchObject({ ok: true, loggedIn: null, needsKey: false });
  expect(noKey.authMethods).toContainEqual(
    expect.objectContaining({ type: "env", vars: ["DEEPSEEK_API_KEY"], missing: null }),
  );
  expect(noKey.capabilities.sessionCapabilities).toEqual({ list: {}, resume: {}, close: {} });
  expect(noKey.configOptions[0]?.options[0]?.name).toBe("Native fallback");
  await api("PUT", "/api/harnesses/deepseek/env", { values: { DEEPSEEK_API_KEY: "sk-fake-123456789" } });
  const configured = await api<Probe>("POST", "/api/harnesses/deepseek/test");
  expect(configured).toMatchObject({
    ok: true,
    loggedIn: null,
    needsKey: false,
    secretEnv: { DEEPSEEK_API_KEY: "sk-••••6789" },
  });
  expect(configured.configOptions[0]?.options[0]?.name).toBe("Configured catalog");
  expect(
    calls()
      .filter((c) => c.method === "session/new" && c.args[0] === "--profile")
      .every((c) => c.home === nativeHome),
  ).toBe(true);
  const opencode = await api<Probe>("POST", "/api/harnesses/opencode/test");
  expect(opencode.loggedIn).toBe(true);
  expect(calls().findLast((c) => c.method === "session/new")?.key).toBe("");
});

test("explicit authentication failures remain failures, rather than being replaced by unknown", async () => {
  writeFileSync(join(root, "auth-error"), "");
  try {
    expect(await api<Probe>("POST", "/api/harnesses/deepseek/test")).toMatchObject({ ok: true, loggedIn: false });
  } finally {
    rmSync(join(root, "auth-error"));
  }
});

test("agent overrides win over saved DeepSeek keys and identity stays in the first prompt", async () => {
  const agent = await api<Agent>(
    "POST",
    "/api/agents",
    agentInput("DeepSeekFixture", {
      harness: "deepseek",
      identity: "DeepSeek test identity",
      env: { DEEPSEEK_API_KEY: "agent-key" },
    }),
  );
  const room = await api<Room>("POST", "/api/rooms", { name: "deepseek", agentIds: [agent.id] });
  await api("POST", `/api/rooms/${room.id}/messages`, { senderName: "Andy", content: "hello" });
  await app.orchestrator.idle(room.id);
  const prompt = calls().findLast((c) => c.method === "session/prompt");
  expect(prompt).toMatchObject({ args: ["--profile", "acp"], key: "agent-key", home: nativeHome });
  expect(JSON.stringify(prompt?.params.prompt)).toContain("<tuantuan-identity>");
  expect(JSON.stringify(prompt?.params.prompt)).toContain("DeepSeek test identity");
});
