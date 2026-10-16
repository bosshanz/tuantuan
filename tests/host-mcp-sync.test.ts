import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { serve } from "../server/app";
import type { Agent, Room } from "../server/store";
import { agentInput, until } from "./helpers";

/**
 * Effective MCP config changes (user list, server deletion, plugin servers) must reach a live
 * ACP session: re-attach on the next turn, wait while a turn is active, and stay quiet when
 * nothing changed.
 */
const scratch = mkdtempSync(join(tmpdir(), "tt-host-mcp-sync-"));
const { app, server } = serve({ dbPath: join(scratch, "state.db") }, 0);

afterAll(async () => {
  app.orchestrator.shutdown();
  app.host.shutdown();
  app.installer.shutdown();
  app.registry.stop();
  await app.projectTerminals.shutdown();
  server.stop(true);
  await Bun.sleep(300);
  app.store.db.close();
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string) {
  const cwd = join(scratch, name);
  mkdirSync(cwd);
  const agent = app.store.createAgent(agentInput(name, { env: { MOCK_AGENT_SESSION_DIR: join(cwd, "sessions") } }));
  const project = app.store.createProject(name, cwd);
  const room = app.store.createRoom(name, [agent.id], { projectId: project.id });
  return { agent, room };
}

const rebind = (agent: Agent, mcpServerIds: string[]) =>
  app.store.updateAgent(agent.id, { ...agentInput(agent.name), env: agent.env, mcpServerIds });
const warm = (room: Room, agent: Agent) => app.host.session(room, agent, app.orchestrator.identityFor(room, agent));

const resumesOf = (spy: ReturnType<typeof spyOn>) => {
  const calls = spy.mock.calls as unknown[][];
  return calls
    .filter(([m]) => m === methods.agent.session.resume)
    .map(([, p]) => p as { mcpServers: { name: string; url?: string }[] });
};

test("binding a new server re-attaches the same session with the new list; equal config stays quiet", async () => {
  const { agent: initial, room } = fixture("Bind");
  const first = await warm(room, initial);
  const sessionId = first.slot.view.sessionId;
  const spy = spyOn(first.proc.acp.agent, "request");
  try {
    const srv = app.store.createMcpServer("weather", "https://mcp.example.com/weather");
    // Like the orchestrator, later callers pass the agent as freshly read from the store.
    const agent = rebind(initial, [srv.id]);

    const second = await warm(room, agent);
    expect(second.proc).toBe(first.proc);
    expect(second.slot.view.sessionId).toBe(sessionId);
    const resumes = resumesOf(spy);
    expect(resumes).toHaveLength(1);
    // The harness is asked to re-attach the same session with exactly the new list (the mock's
    // resume handler stores these params as the session's servers).
    expect(resumes[0]?.mcpServers).toMatchObject([
      { type: "http", name: "weather", url: "https://mcp.example.com/weather" },
    ]);

    // Nothing changed since: repeated use must not reconnect.
    await warm(room, agent);
    await warm(room, agent);
    expect(resumesOf(spy)).toHaveLength(1);

    // Unbinding (or deleting the bound server) takes effect on the next re-attach.
    const cleared = rebind(agent, []);
    await warm(room, cleared);
    const afterRemove = resumesOf(spy).at(-1)?.mcpServers;
    expect(afterRemove ?? []).toEqual([]);
    expect((await warm(room, cleared)).slot.view.sessionId).toBe(sessionId);
  } finally {
    spy.mockRestore();
  }
});

test("a change saved during an active turn waits for the next turn", async () => {
  const { agent: initial, room } = fixture("Active");
  const first = await warm(room, initial);
  const spy = spyOn(first.proc.acp.agent, "request");
  try {
    const direct = app.orchestrator.postHumanMessage(room.id, "用户", "/edit");
    const ask = await until(() => app.host.pendingAsks(room.id)[0]);
    const callback = first.slot.turn;
    const srv = app.store.createMcpServer("docs", "https://mcp.example.com/docs");
    const agent = rebind(initial, [srv.id]);

    // Mid-turn queries must not re-attach the live session or disturb its permission ask.
    const view = await app.host.sessionView(room, agent, app.orchestrator.identityFor(room, agent));
    expect(view).toBe(first.slot.view);
    expect(first.slot.turn).toBe(callback);
    expect(app.host.pendingAsks(room.id).map((p) => p.id)).toContain(ask.id);
    expect(resumesOf(spy)).toHaveLength(0);

    app.host.answer(ask.id, "reject");
    await app.orchestrator.idle(room.id);
    expect(app.store.getMessage(direct.id)?.status).toBe("done");

    const next = await warm(room, agent);
    expect(next.slot.view.sessionId).toBe(first.slot.view.sessionId);
    expect(resumesOf(spy)).toHaveLength(1);
    expect(resumesOf(spy)[0]?.mcpServers).toMatchObject([{ name: "docs" }]);
  } finally {
    app.host.answer(app.host.pendingAsks(room.id)[0]?.id ?? "", null);
    spy.mockRestore();
  }
});

test("linking a plugin MCP server re-attaches on the next use, without any agent change", async () => {
  const { agent, room } = fixture("Plugin");
  const first = await warm(room, agent);
  const sessionId = first.slot.view.sessionId;
  const spy = spyOn(first.proc.acp.agent, "request");
  try {
    // The agent row itself never changes here: only the linked plugin set does.
    const pluginRoot = join(scratch, "plugin");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p1", mcpServers: { db: { type: "stdio", command: "/bin/echo" } } }),
    );
    const linked = join(scratch, "agents", agent.id, "plugins-linked.json");
    mkdirSync(dirname(linked), { recursive: true });
    writeFileSync(linked, JSON.stringify([pluginRoot]));

    const second = await warm(room, agent);
    expect(second.slot.view.sessionId).toBe(sessionId);
    expect(resumesOf(spy)).toHaveLength(1);
    expect(resumesOf(spy)[0]?.mcpServers).toMatchObject([{ name: "p1-db", command: "/bin/echo" }]);

    // Unlinking the plugin drops its server again.
    writeFileSync(linked, JSON.stringify([]));
    await warm(room, agent);
    expect(resumesOf(spy).at(-1)?.mcpServers ?? []).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});
/** Spy helper: hold the first call of the named ACP request until `open()` lets it through. */
function holdRequest(target: { request: (m: string, p?: unknown) => Promise<unknown> }, method: string) {
  const original = target.request.bind(target) as (m: string, p?: unknown) => Promise<unknown>;
  let entered!: () => void;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let armed = true;
  return {
    entered: new Promise<void>((resolve) => (entered = resolve)),
    open: () => release(),
    spy: spyOn(target, "request").mockImplementation(async (m: string, p?: unknown) => {
      if (m === method && armed) {
        armed = false;
        entered();
        await gate;
      }
      return original(m, p);
    }),
  };
}

test("deleting a bound server during resume invalidates the stale initialization", async () => {
  const { agent: initial, room } = fixture("RaceResume");
  const first = await warm(room, initial);
  const srv = app.store.createMcpServer("removed", "https://example.com/mcp");
  const agent = rebind(initial, [srv.id]);
  const held = holdRequest(first.proc.acp.agent, methods.agent.session.resume);
  try {
    const pending = warm(room, agent); // re-attach with the new list
    await held.entered;
    app.store.deleteMcpServer(srv.id); // the server table changed; the Agent row did not
    held.open();
    await expect(pending).rejects.toThrow(/会话配置已更改/);

    // The next use re-initializes with the current (empty) effective list on the same session.
    const next = await warm(room, agent);
    expect(next.slot.mcpSignature).toBe("[]");
    expect(next.slot.view.sessionId).toBe(first.slot.view.sessionId);
  } finally {
    held.spy.mockRestore();
  }
});

test("deleting a bound server during session/new invalidates the stale initialization", async () => {
  const { agent: initial, room } = fixture("RaceNew");
  const srv = app.store.createMcpServer("removed", "https://example.com/mcp");
  const agent = rebind(initial, [srv.id]);
  const first = await warm(room, agent);
  const held = holdRequest(first.proc.acp.agent, methods.agent.session.new);
  try {
    // Forgetting the session routes the next open through session/new on the same process.
    const pending = app.host.switchSession(room, agent, app.orchestrator.identityFor(room, agent), null);
    await held.entered;
    app.store.deleteMcpServer(srv.id);
    held.open();
    await expect(pending).rejects.toThrow(/会话配置已更改/);
    const next = await warm(room, agent);
    expect(JSON.parse(next.slot.mcpSignature)).toEqual([]);
  } finally {
    held.spy.mockRestore();
  }
});

test("changing linked plugin files during resume invalidates the stale initialization", async () => {
  const { agent, room } = fixture("RacePlugin");
  const first = await warm(room, agent);
  const pluginRoot = join(scratch, "race-plugin");
  mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "rp", mcpServers: { db: { type: "stdio", command: "/bin/echo" } } }),
  );
  const linked = join(scratch, "agents", agent.id, "plugins-linked.json");
  mkdirSync(dirname(linked), { recursive: true });
  writeFileSync(linked, JSON.stringify([pluginRoot])); // bound before the re-attach begins
  const held = holdRequest(first.proc.acp.agent, methods.agent.session.resume);
  try {
    const pending = warm(room, agent); // re-attach with the plugin server
    await held.entered;
    writeFileSync(linked, JSON.stringify([])); // unlinked while initialization is in flight
    held.open();
    await expect(pending).rejects.toThrow(/会话配置已更改/);
    const next = await warm(room, agent);
    expect(JSON.parse(next.slot.mcpSignature)).toEqual([]);
    expect(next.slot.view.sessionId).toBe(first.slot.view.sessionId);
  } finally {
    held.spy.mockRestore();
  }
});
