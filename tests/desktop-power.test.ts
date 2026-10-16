import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskPowerManager } from "../desktop/src/power";
import { serve } from "../server/app";
import { agentInput, until } from "./helpers";

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  open() {
    this.onopen?.();
  }
  activity(roomId: string, busy: boolean) {
    this.onmessage?.({ data: JSON.stringify({ type: "activity", roomId, busy }) });
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

const roots: string[] = [];
const managers: TaskPowerManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(
  o: { enabled?: boolean; fetchRooms?: () => Promise<{ id: string; busy: boolean }[]>; refreshMs?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "tuantuan-power-"));
  roots.push(root);
  const settingsPath = join(root, "user", "settings.json");
  if (o.enabled) {
    mkdirSync(join(root, "user"));
    writeFileSync(settingsPath, JSON.stringify({ keepAwakeDuringTasks: true, unrelated: "keep" }));
  }
  const sockets: FakeSocket[] = [];
  const starts: string[] = [];
  const stops: number[] = [];
  const options = {
    settingsPath,
    serverUrl: "http://127.0.0.1:8787",
    retryMs: 5,
    refreshMs: o.refreshMs,
    fetchRooms: o.fetchRooms ?? (async () => []),
    openSocket: (url: string) => {
      expect(url).toBe("ws://127.0.0.1:8787/ws");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    blocker: {
      start: (type: "prevent-app-suspension") => starts.push(type) - 1,
      stop: (id: number) => stops.push(id),
    },
  };
  const manager = new TaskPowerManager(options);
  managers.push(manager);
  return { manager, settingsPath, sockets, starts, stops, options };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
function socketAt(fixture: { sockets: FakeSocket[] }, index = 0): FakeSocket {
  const socket = fixture.sockets[index];
  if (!socket) throw new Error(`missing socket ${index}`);
  return socket;
}

describe("desktop Agent task power", () => {
  test("defaults off, persists the preference in userData, and preserves unrelated settings", () => {
    const f = setup();
    expect(f.manager.status()).toEqual({ enabled: false, preventingSleep: false, activeRooms: 0 });
    expect(f.sockets).toHaveLength(0);
    f.manager.setEnabled(true);
    expect(JSON.parse(readFileSync(f.settingsPath, "utf8"))).toEqual({ keepAwakeDuringTasks: true });
    f.manager.dispose();
    writeFileSync(f.settingsPath, JSON.stringify({ keepAwakeDuringTasks: true, unrelated: "keep" }));
    const restarted = new TaskPowerManager(f.options);
    managers.push(restarted);
    expect(restarted.status().enabled).toBe(true);
    restarted.setEnabled(false);
    expect(JSON.parse(readFileSync(f.settingsPath, "utf8"))).toEqual({
      keepAwakeDuringTasks: false,
      unrelated: "keep",
    });
  });

  test("one application-suspension blocker covers concurrent rooms until the last task finishes", async () => {
    const f = setup({ enabled: true });
    const socket = socketAt(f);
    socket.open();
    await flush();
    socket.activity("background-room", true);
    socket.activity("another-room", true);
    socket.activity("background-room", true); // Duplicate events do not acquire extra assertions.
    expect(f.manager.status()).toEqual({ enabled: true, preventingSleep: true, activeRooms: 2 });
    expect(f.starts).toEqual(["prevent-app-suspension"]);
    socket.activity("background-room", false);
    expect(f.stops).toEqual([]);
    socket.activity("another-room", false);
    expect(f.stops).toEqual([0]);
    expect(f.manager.status().preventingSleep).toBe(false);
  });

  test("an initial active snapshot is released by the idle event", async () => {
    const f = setup({ enabled: true, fetchRooms: async () => [{ id: "room", busy: true }] });
    const socket = socketAt(f);
    socket.open();
    await flush();
    expect(f.manager.status().preventingSleep).toBe(true);
    socket.activity("room", false);
    expect(f.stops).toEqual([0]);
  });

  test("disable and quit release immediately, ignore stale events, and do not alter the saved preference on quit", async () => {
    const f = setup({ enabled: true });
    const socket = socketAt(f);
    socket.open();
    await flush();
    socket.activity("r", true);
    f.manager.setEnabled(false);
    socket.activity("r", true);
    expect(f.manager.status()).toEqual({ enabled: false, preventingSleep: false, activeRooms: 0 });
    expect(f.stops).toEqual([0]);
    f.manager.setEnabled(true);
    const newSocket = socketAt(f, 1);
    newSocket.open();
    await flush();
    newSocket.activity("r", true);
    f.manager.dispose();
    f.manager.dispose();
    newSocket.activity("r", true);
    expect(f.stops).toEqual([0, 1]);
    expect(JSON.parse(readFileSync(f.settingsPath, "utf8"))).toMatchObject({ keepAwakeDuringTasks: true });
  });

  test("initial and reconnect snapshots recover tasks from all rooms; disconnect releases stale state", async () => {
    let rooms = [{ id: "existing-background-task", busy: true }];
    const f = setup({ enabled: true, fetchRooms: async () => rooms });
    socketAt(f).open();
    await flush();
    expect(f.manager.status().preventingSleep).toBe(true);
    socketAt(f).close();
    expect(f.manager.status().preventingSleep).toBe(false);
    rooms = [{ id: "new-task-while-disconnected", busy: true }];
    await until(() => f.sockets.length === 2);
    socketAt(f, 1).open();
    await flush();
    expect(f.manager.status()).toEqual({ enabled: true, preventingSleep: true, activeRooms: 1 });
    expect(f.starts).toHaveLength(2);
  });

  test("newer activity wins over a delayed snapshot; late responses after disable are ignored", async () => {
    let resolveSnapshot!: (rooms: { id: string; busy: boolean }[]) => void;
    const f = setup({
      enabled: true,
      fetchRooms: () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    });
    socketAt(f).open();
    socketAt(f).activity("finished", false);
    socketAt(f).activity("started", true);
    resolveSnapshot([{ id: "finished", busy: true }]);
    await flush();
    expect(f.manager.status().activeRooms).toBe(1);
    socketAt(f).activity("started", false);
    expect(f.manager.status().preventingSleep).toBe(false);
    socketAt(f).close();
    await until(() => f.sockets.length === 2);
    socketAt(f, 1).open();
    f.manager.setEnabled(false);
    resolveSnapshot([{ id: "stale", busy: true }]);
    await flush();
    expect(f.manager.status()).toEqual({ enabled: false, preventingSleep: false, activeRooms: 0 });
  });

  test("periodic snapshots reconcile missing end events", async () => {
    let rooms = [{ id: "r", busy: true }];
    const f = setup({ enabled: true, refreshMs: 10, fetchRooms: async () => rooms });
    socketAt(f).open();
    await flush();
    expect(f.manager.status().preventingSleep).toBe(true);
    rooms = [];
    await until(() => !f.manager.status().preventingSleep);
    expect(f.stops).toEqual([0]);
  });

  test("a failed state refresh releases stale assertions and reconnects before restoring them", async () => {
    let unavailable = false;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const f = setup({
      enabled: true,
      refreshMs: 10,
      fetchRooms: async () => {
        if (unavailable) throw new Error("server unavailable");
        return [{ id: "r", busy: true }];
      },
    });
    try {
      socketAt(f).open();
      await flush();
      expect(f.manager.status().preventingSleep).toBe(true);
      unavailable = true;
      await until(() => f.sockets.length === 2);
      expect(f.manager.status().preventingSleep).toBe(false);
      expect(f.stops).toEqual([0]);
      unavailable = false;
      socketAt(f, 1).open();
      await flush();
      expect(f.manager.status().preventingSleep).toBe(true);
      expect(f.starts).toHaveLength(2);
    } finally {
      errors.mockRestore();
    }
  });

  test("real global task events cover concurrent rooms and agents, successful replies, failures, and cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "tuantuan-power-server-"));
    roots.push(root);
    const { app, server } = serve({ dbPath: join(root, "data", "test.db") }, 0);
    const agent = app.store.createAgent(agentInput("PowerAlpha"));
    const peer = app.store.createAgent(agentInput("PowerBeta"));
    const failed = app.store.createAgent(
      agentInput("PowerError", { env: { MOCK_AGENT_SESSION_ERROR: "power test failure" } }),
    );
    const project = app.store.createProject("Power", root);
    const group = app.store.createRoom("Concurrent agents", [agent.id, peer.id], { projectId: project.id });
    const other = app.store.createRoom("Background room", [agent.id], { projectId: project.id });
    const errorRoom = app.store.createRoom("Failed task", [failed.id], { projectId: project.id });
    const starts: string[] = [];
    const stops: number[] = [];
    const settingsPath = join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ keepAwakeDuringTasks: true }));
    app.orchestrator.postHumanMessage(group.id, "Tester", "/slow @所有人");
    const manager = new TaskPowerManager({
      settingsPath,
      serverUrl: `http://127.0.0.1:${server.port}`,
      blocker: {
        start: (type) => starts.push(type) - 1,
        stop: (id) => stops.push(id),
      },
    });
    managers.push(manager);
    try {
      await until(() => manager.status().activeRooms === 1);
      expect(app.orchestrator.state(group.id).tasks.filter((task) => task.status === "running")).toHaveLength(2);
      app.orchestrator.postHumanMessage(other.id, "Tester", "/slow");
      await until(() => manager.status().activeRooms === 2);
      app.orchestrator.cancelAgent(group.id, agent.id);
      await until(
        () =>
          !app.orchestrator
            .state(group.id)
            .tasks.some((task) => task.agentId === agent.id && task.status === "cancelling"),
      );
      expect(manager.status().preventingSleep).toBe(true);
      expect(stops).toEqual([]);
      app.orchestrator.cancelAgent(group.id, peer.id);
      await app.orchestrator.idle(group.id);
      await until(() => manager.status().activeRooms === 1);
      expect(stops).toEqual([]);
      app.orchestrator.cancelAll(other.id);
      await app.orchestrator.idle(other.id);
      await until(() => !manager.status().preventingSleep);
      expect(starts).toEqual(["prevent-app-suspension"]);
      expect(stops).toEqual([0]);

      app.orchestrator.postHumanMessage(other.id, "Tester", "hello");
      await until(() => manager.status().preventingSleep);
      await app.orchestrator.idle(other.id);
      await until(() => !manager.status().preventingSleep);
      expect(app.store.recentMessages(other.id, 10).at(-1)?.status).toBe("done");
      app.orchestrator.postHumanMessage(errorRoom.id, "Tester", "hello");
      await until(() => manager.status().preventingSleep);
      await app.orchestrator.idle(errorRoom.id);
      await until(() => !manager.status().preventingSleep);
      expect(app.store.recentMessages(errorRoom.id, 10).some((message) => message.status === "error")).toBe(true);
      expect(starts).toHaveLength(3);
      expect(stops).toEqual([0, 1, 2]);
    } finally {
      manager.dispose();
      app.orchestrator.shutdown();
      app.host.shutdown();
      app.installer.shutdown();
      app.registry.stop();
      await app.projectTerminals.shutdown();
      server.stop(true);
      await Bun.sleep(100);
      app.store.db.close();
    }
  }, 10_000);
});
