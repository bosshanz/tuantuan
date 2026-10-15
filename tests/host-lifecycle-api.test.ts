import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpProcess } from "../server/acp";
import { serve } from "../server/app";
import type { Room } from "../server/store";
import { agentInput, until } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "tt-host-lifecycle-"));
const { app, server } = serve({ dbPath: join(scratch, "data", "test.db") }, 0);
const base = `http://127.0.0.1:${server.port}`;

afterAll(async () => {
  app.host.shutdown();
  app.installer.shutdown();
  app.registry.stop();
  await app.projectTerminals.shutdown();
  server.stop(true);
  await Bun.sleep(300);
  app.store.db.close();
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string, env: Record<string, string> = {}) {
  const cwd = join(scratch, name);
  mkdirSync(cwd);
  const agent = app.store.createAgent(agentInput(`${name}Agent`, { env }));
  const peer = app.store.createAgent(agentInput(`${name}Peer`));
  const project = app.store.createProject(name, cwd);
  const room = app.store.createRoom(name, [agent.id, peer.id], { projectId: project.id });
  return { agent, peer, project, room };
}

function request(path: string, method: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

function warm(room: Room, agentId: string) {
  const agent = app.store.getAgent(agentId);
  if (!agent) throw new Error("agent missing");
  return app.host.session(room, agent, app.orchestrator.identityFor(room, agent));
}

function initializingProcess(roomId: string): AcpProcess | undefined {
  // Capture the actual child while session/new is pending, before a SessionSlot exists.
  const host = app.host as unknown as { procs: Map<string, { roomId: string; acp: AcpProcess }> };
  return [...host.procs.values()].find((entry) => entry.roomId === roomId)?.acp;
}

async function stopped(process: AcpProcess) {
  await process.exited;
  expect(() => globalThis.process.kill(process.proc.pid, 0)).toThrow();
}

test("deleting prewarmed rooms reclaims their children while another room keeps its live turn", async () => {
  const { agent, peer, project, room } = fixture("Prewarmed");
  const deleted = [
    room,
    ...Array.from({ length: 2 }, (_, index) =>
      app.store.createRoom(`discard ${index}`, [agent.id, peer.id], { projectId: project.id }),
    ),
  ];
  const sessions = await Promise.all(deleted.map((entry) => warm(entry, agent.id)));
  const kept = app.store.createRoom("kept room", [agent.id, peer.id], { projectId: project.id });
  const live = await warm(kept, agent.id);
  const reply = app.host.prompt(
    kept,
    agent,
    app.orchestrator.identityFor(kept, agent),
    [{ type: "text", text: "/edit" }],
    () => {},
    new AbortController().signal,
  );
  const ask = await until(() => app.host.pendingAsks(kept.id)[0]);
  for (const entry of deleted) {
    expect((await request(`/api/rooms/${entry.id}`, "DELETE")).status).toBe(200);
    expect(app.host.view(entry.id, agent.id)).toBeNull();
  }
  await Promise.all(sessions.map((session) => stopped(session.proc.acp)));
  expect(live.proc.acp.proc.exitCode).toBeNull();
  app.host.answer(ask.id, null);
  expect(await reply).toMatchObject({ stopReason: "end_turn" });
  expect(app.host.view(kept.id, agent.id)).not.toBeNull();
});

test("deleting a room during initialization or a running task cannot recreate its slot", async () => {
  const initializing = fixture("InitializingDelete", { MOCK_AGENT_SESSION_DELAY_MS: "800" });
  const pending = warm(initializing.room, initializing.agent.id).catch((error: Error) => error);
  const initialProc = await until(() => initializingProcess(initializing.room.id));
  expect((await request(`/api/rooms/${initializing.room.id}`, "DELETE")).status).toBe(200);
  expect(await pending).toBeInstanceOf(Error);
  await stopped(initialProc);
  expect(app.host.view(initializing.room.id, initializing.agent.id)).toBeNull();

  const running = fixture("RunningDelete", { MOCK_AGENT_IGNORE_CANCEL: "1" });
  const session = await warm(running.room, running.agent.id);
  app.orchestrator.postHumanMessage(running.room.id, "Tester", "/slow");
  await until(() => session.slot.turn !== null);
  app.orchestrator.postHumanMessage(running.room.id, "Tester", "/edit");
  expect((await request(`/api/rooms/${running.room.id}`, "DELETE")).status).toBe(200);
  await app.orchestrator.idle(running.room.id);
  await stopped(session.proc.acp);
  expect(app.host.view(running.room.id, running.agent.id)).toBeNull();
  expect(app.host.pendingAsks(running.room.id)).toEqual([]);
  expect(existsSync(join(running.project.cwd, "mock-edit.txt"))).toBe(false);
});

test("releasing during initialization is repeatable and an old initializer cannot detach its replacement", async () => {
  const { agent, room } = fixture("ReopenInitialization", { MOCK_AGENT_SESSION_DELAY_MS: "300" });
  const pending = warm(room, agent.id).catch((error: Error) => error);
  const previous = await until(() => initializingProcess(room.id));
  app.host.releaseRoom(room.id);
  expect(() => previous.kill()).not.toThrow();
  const replacement = await warm(room, agent.id);
  expect(await pending).toMatchObject({ status: 409 });
  await stopped(previous);
  // Let the original process-tree escalation fire after reaping the old child.
  await Bun.sleep(300);
  expect(() => previous.kill()).not.toThrow();
  expect(app.host.view(room.id, agent.id)).toBe(replacement.slot.view);
  expect(replacement.proc.acp.proc.exitCode).toBeNull();
});

test("removing a member only releases that member; deleting an Agent also clears older nonmember slots", async () => {
  const { agent, peer, project, room } = fixture("MemberDelete");
  const other = app.store.createRoom("older membership", [agent.id, peer.id], { projectId: project.id });
  const a = await warm(room, agent.id);
  const b = await warm(room, peer.id);
  const old = await warm(other, agent.id);
  expect((await request(`/api/rooms/${room.id}/agents`, "PUT", { agentIds: [peer.id] })).status).toBe(200);
  await stopped(a.proc.acp);
  expect(app.host.view(room.id, agent.id)).toBeNull();
  expect(b.proc.acp.proc.exitCode).toBeNull();
  expect(old.proc.acp.proc.exitCode).toBeNull();
  // Seed a stale slot created by older membership handling; Agent deletion must find it too.
  app.store.setRoomAgents(other.id, [peer.id]);
  expect((await request(`/api/agents/${agent.id}`, "DELETE")).status).toBe(200);
  await stopped(old.proc.acp);
  expect(app.host.view(other.id, agent.id)).toBeNull();
  expect(b.proc.acp.proc.exitCode).toBeNull();
});

test("project cwd changes, room moves and project deletion release only the affected processes", async () => {
  const { agent, peer, project, room } = fixture("ProjectLifecycle");
  const other = app.store.createRoom("same project", [agent.id, peer.id], { projectId: project.id });
  const a = await warm(room, agent.id);
  const b = await warm(other, agent.id);
  const changed = join(scratch, "changed-cwd");
  mkdirSync(changed);
  expect((await request(`/api/projects/${project.id}`, "PATCH", { cwd: changed })).status).toBe(200);
  await Promise.all([stopped(a.proc.acp), stopped(b.proc.acp)]);
  const movedRoom = app.store.getRoom(room.id);
  if (!movedRoom) throw new Error("room missing");
  const fresh = await warm(movedRoom, agent.id);
  expect(fresh.proc.acp.launch.cwd).toBe(changed);
  const destination = join(scratch, "destination-project");
  mkdirSync(destination);
  const nextProject = app.store.createProject("destination", destination);
  expect((await request(`/api/rooms/${room.id}`, "PATCH", { projectId: nextProject.id })).status).toBe(200);
  await stopped(fresh.proc.acp);
  const updated = app.store.getRoom(room.id);
  const retained = app.store.getRoom(other.id);
  if (!updated || !retained) throw new Error("room missing");
  const next = await warm(updated, agent.id);
  const previous = await warm(retained, agent.id);
  expect((await request(`/api/projects/${project.id}`, "DELETE")).status).toBe(200);
  await stopped(previous.proc.acp);
  expect(app.host.view(other.id, agent.id)).toBeNull();
  expect(next.proc.acp.proc.exitCode).toBeNull();
  expect((await request(`/api/projects/${nextProject.id}`, "DELETE")).status).toBe(200);
  await stopped(next.proc.acp);
});
