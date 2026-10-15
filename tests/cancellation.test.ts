import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import { resetLoginShellEnv } from "../server/harness";
import { agentInput, until } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "tt-cancel-regression-"));
const saved = { shell: process.env.SHELL, skills: process.env.TUANTUAN_SKILLS_HOME };
const { app, server } = serve({ dbPath: join(scratch, "data", "test.db") }, 0);

beforeAll(() => {
  const shell = join(scratch, "login-shell");
  writeFileSync(shell, `#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\0HOME=${scratch}\\0'\n`);
  chmodSync(shell, 0o755);
  process.env.SHELL = shell;
  process.env.TUANTUAN_SKILLS_HOME = scratch;
  resetLoginShellEnv();
});

afterAll(async () => {
  app.host.shutdown();
  app.registry.stop();
  server.stop(true);
  app.store.db.close();
  // Allow the process-group shutdown fallback to reap TERM-ignoring descendants.
  await Bun.sleep(300);
  for (const [key, value] of [
    ["SHELL", saved.shell],
    ["TUANTUAN_SKILLS_HOME", saved.skills],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetLoginShellEnv();
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string, env: Record<string, string> = {}) {
  const cwd = join(scratch, name);
  mkdirSync(cwd);
  const file = join(cwd, "mock-edit.txt");
  writeFileSync(file, "hello\n");
  const agent = app.store.createAgent(agentInput(name, { env, permissionPolicy: "allow" }));
  const project = app.store.createProject(name, cwd);
  const room = app.store.createRoom(name, [agent.id], { projectId: project.id });
  const identity = app.orchestrator.identityFor(room, agent);
  return { file, agent, room, project, identity };
}

test("cancelling during session initialization never sends the pending file edit", async () => {
  const { file, agent, room, identity } = fixture("Initializing", { MOCK_AGENT_SESSION_DELAY_MS: "800" });
  // The UI warm-up and a user message can both request this session.
  const warming = app.host.session(room, agent, identity);
  app.orchestrator.postHumanMessage(room.id, "Tester", "/edit");
  const start = Date.now();
  expect(app.orchestrator.cancel(room.id)).toBe(true);
  await app.orchestrator.idle(room.id);
  expect(Date.now() - start).toBeLessThan(500);
  expect(app.store.recentMessages(room.id, 1)[0]?.status).toBe("cancelled");
  const initialized = await warming;
  expect(readFileSync(file, "utf8")).toBe("hello\n");
  expect(app.host.pendingAsks(room.id)).toEqual([]);

  // After the cancelled initialization, the next turn uses the same session and works normally.
  app.orchestrator.postHumanMessage(room.id, "Tester", "/edit");
  await app.orchestrator.idle(room.id);
  expect(app.store.getAcpSession(room.id, agent.id)).toMatchObject({ sessionId: initialized.slot.view.sessionId });
  expect(app.store.recentMessages(room.id, 1)[0]?.status).toBe("done");
  expect(readFileSync(file, "utf8")).toBe("hello\ntuantuan\n");
});

test("an already-cancelled turn does not initialize a session", async () => {
  const { agent, room, identity } = fixture("Precancelled");
  const controller = new AbortController();
  controller.abort(new DOMException("stop before start", "AbortError"));
  const result = await app.host
    .prompt(room, agent, identity, [{ type: "text", text: "/edit" }], () => {}, controller.signal)
    .catch((error: Error) => error);
  expect(result).toBe(controller.signal.reason);
  expect(app.host.view(room.id, agent.id)).toBeNull();
  expect(app.store.getAcpSession(room.id, agent.id)).toBeNull();
});

test("changing a project directory invalidates its unfinished session initialization", async () => {
  const { file, agent, room, project, identity } = fixture("MovedProject", { MOCK_AGENT_SESSION_DELAY_MS: "700" });
  const opening = app.host.session(room, agent, identity).catch((error: Error) => error);
  await Bun.sleep(150);
  const cwd = join(scratch, "MovedProjectNew");
  mkdirSync(cwd);
  const newFile = join(cwd, "mock-edit.txt");
  writeFileSync(newFile, "new project\n");
  const response = await fetch(`http://127.0.0.1:${server.port}/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  expect(response.status).toBe(200);
  app.orchestrator.postHumanMessage(room.id, "Tester", "/edit");
  await app.orchestrator.idle(room.id);
  expect(await opening).toMatchObject({ message: "会话配置已更改，请重试", status: 409 });
  expect(readFileSync(file, "utf8")).toBe("hello\n");
  expect(readFileSync(newFile, "utf8")).toBe("hello\ntuantuan\n");
  expect(app.store.recentMessages(room.id, 1)[0]?.status).toBe("done");
  const currentRoom = app.store.getRoom(room.id);
  if (!currentRoom) throw new Error("room missing");
  const current = await app.host.session(currentRoom, agent, identity);
  expect(current.proc.acp.launch.cwd).toBe(cwd);
  expect(app.store.getAcpSession(room.id, agent.id)).toMatchObject({ sessionId: current.slot.view.sessionId });
});

test("starting a fresh session supersedes an unfinished warm-up", async () => {
  const { agent, room, identity } = fixture("SwitchedSession", { MOCK_AGENT_SESSION_DELAY_MS: "700" });
  const opening = app.host.session(room, agent, identity).catch((error: Error) => error);
  await Bun.sleep(150);
  const fresh = await app.host.switchSession(room, agent, identity, null);
  expect(await opening).toMatchObject({ message: "会话配置已更改，请重试", status: 409 });
  expect(app.host.view(room.id, agent.id)?.sessionId).toBe(fresh.sessionId);
  expect(app.store.getAcpSession(room.id, agent.id)).toMatchObject({ sessionId: fresh.sessionId });
});

test("an old initialization finishing last cannot overwrite a newly configured session", async () => {
  const { agent, room, project, identity } = fixture("ReconfiguredSession", { MOCK_AGENT_SESSION_DELAY_MS: "1000" });
  const opening = app.host.session(room, agent, identity).catch((error: Error) => error);
  await Bun.sleep(150);
  const cwd = join(scratch, "ReconfiguredSessionNew");
  mkdirSync(cwd);
  app.store.updateProject(project.id, { cwd });
  const updated = app.store.updateAgent(
    agent.id,
    agentInput(agent.name, { env: { MOCK_AGENT_SESSION_DELAY_MS: "0" }, permissionPolicy: "allow" }),
  );
  const currentRoom = app.store.getRoom(room.id);
  if (!currentRoom) throw new Error("room missing");
  const current = await app.host.session(currentRoom, updated, identity);
  const sessionId = current.slot.view.sessionId;
  expect(app.store.getAcpSession(room.id, agent.id)).toMatchObject({ sessionId });
  expect(await opening).toBeInstanceOf(Error);
  expect(app.host.view(room.id, agent.id)?.sessionId).toBe(sessionId);
  expect(app.store.getAcpSession(room.id, agent.id)).toMatchObject({ sessionId });
});

test("a failed older load cannot detach the current turn using the same ACP session id", async () => {
  const gate = join(scratch, "stale-load-failure");
  const { file, agent, room, identity } = fixture("LoadOwnership", { MOCK_AGENT_FIRST_LOAD_FAILURE_GATE: gate });
  const initial = await app.host.session(room, agent, identity);
  const sessionId = initial.slot.view.sessionId;
  if (!sessionId) throw new Error("session missing");
  const stale = app.host.switchSession(room, agent, identity, sessionId).catch((error: Error) => error);
  await until(() => existsSync(`${gate}.waiting`));
  const current = await app.host.switchSession(room, agent, identity, sessionId);
  expect(current.sessionId).toBe(sessionId);
  let updates = 0;
  const result = await app.host.prompt(
    room,
    agent,
    identity,
    [{ type: "text", text: "/edit" }],
    (update) => {
      updates++;
      if (update.sessionUpdate === "agent_thought_chunk") writeFileSync(gate, "fail the older load");
    },
    new AbortController().signal,
  );
  expect(await stale).toMatchObject({ message: "会话配置已更改，请重试", status: 409 });
  expect(initial.proc.sessions.get(sessionId)?.view).toBe(current);
  expect(app.host.view(room.id, agent.id)).toBe(current);
  expect(readFileSync(file, "utf8")).toBe("hello\ntuantuan\n");
  expect(updates).toBeGreaterThan(1);
  expect(result.stopReason).toBe("end_turn");
});

test("permission requests arriving after cancel cannot use automatic approval", async () => {
  const { file, agent, room, identity } = fixture("LatePermission", { MOCK_AGENT_IGNORE_CANCEL: "1" });
  await app.host.session(room, agent, identity);
  const controller = new AbortController();
  const result = await app.host.prompt(
    room,
    agent,
    identity,
    [{ type: "text", text: "/edit" }],
    (update) => {
      if (update.sessionUpdate === "agent_thought_chunk") controller.abort();
    },
    controller.signal,
  );
  expect(result.stopReason).toBe("end_turn");
  expect(readFileSync(file, "utf8")).toBe("hello\n");
  expect(app.host.pendingAsks(room.id)).toEqual([]);
});

test("a harness ignoring cancel is terminated before the next turn can reuse it", async () => {
  const { agent, room, identity } = fixture("Unresponsive");
  await app.host.setConfig(room, agent, identity, "model", "mock-stuck");
  const old = await app.host.session(room, agent, identity);
  app.orchestrator.postHumanMessage(room.id, "Tester", "hi");
  await until(() => old.slot.turn !== null);
  expect(app.orchestrator.cancel(room.id)).toBe(true);
  await app.orchestrator.idle(room.id);
  await old.proc.acp.exited;
  expect(old.proc.acp.proc.signalCode).toBe("SIGKILL");
  expect(() => process.kill(old.proc.acp.proc.pid, 0)).toThrow();
  expect(app.host.view(room.id, agent.id)).toBeNull();
  expect(app.store.recentMessages(room.id, 1)[0]?.status).toBe("cancelled");
  await app.host.setConfig(room, agent, identity, "model", "mock-fast");
  app.orchestrator.postHumanMessage(room.id, "Tester", "after cancel");
  await app.orchestrator.idle(room.id);
  const next = await app.host.session(room, agent, identity);
  expect(next.proc.acp.proc.pid).not.toBe(old.proc.acp.proc.pid);
  expect(app.store.recentMessages(room.id, 1)[0]?.content).toContain("after cancel");
  expect(app.store.recentMessages(room.id, 1)[0]?.status).toBe("done");
}, 12_000);
