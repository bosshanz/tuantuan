import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import { PROJECT_TERMINAL_LIMITS, ProjectTerminals, terminalSize } from "../server/project-terminal";
import type { ProjectTerminalEvent, ProjectTerminalMeta } from "../shared/project-terminal";
import "./helpers";

const root = mkdtempSync(join(tmpdir(), "tt-project-terminal-"));
const manager = new ProjectTerminals();
const env = { ...process.env, SHELL: "/bin/bash", BASH_SILENCE_DEPRECATION_WARNING: "1", PS1: "TT> " } as Record<
  string,
  string
>;
const { app, server } = serve({ dbPath: join(root, "db.sqlite") }, 0);
const base = `http://127.0.0.1:${server.port}`;

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await Bun.sleep(20);
  }
}

function input(id: string, data: string) {
  manager.message(id, JSON.stringify({ type: "input", data }));
}
function output(id: string): string {
  let text = "";
  manager.subscribe(id, (event) => {
    if (event.type === "snapshot") text = event.output;
  })();
  return text;
}
function alive(pid: number): boolean {
  const p = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 && !p.stdout.toString().trim().startsWith("Z");
}

afterAll(async () => {
  await manager.shutdown();
  await app.projectTerminals.shutdown();
  app.host.shutdown();
  app.installer.shutdown();
  app.registry.stop();
  server.stop(true);
  app.store.db.close();
  rmSync(root, { recursive: true, force: true });
});

test("real PTY shell supports cwd, ANSI, resize, Ctrl+C and reconnect without losing the process", async () => {
  const meta = manager.open({ id: "tty", cwd: root }, env, 90, 27);
  expect(manager.open({ id: "tty", cwd: root }, env).id).toBe(meta.id);
  input(meta.id, "test -t 0 && test -t 1 && printf '\\033[31mTTY_OK\\033[0m\\n'; pwd; stty size\n");
  await waitFor(() => output(meta.id).includes("27 90"), "initial PTY command");
  expect(output(meta.id)).toContain(root);
  expect(output(meta.id)).toContain("\x1b[31mTTY_OK\x1b[0m");
  manager.message(meta.id, JSON.stringify({ type: "resize", cols: 105, rows: 33 }));
  input(meta.id, "stty size\n");
  await waitFor(() => output(meta.id).includes("33 105"), "resized PTY command");
  input(meta.id, "sleep 30\n");
  await Bun.sleep(80);
  input(meta.id, "\x03");
  input(meta.id, "printf '\\nCTRL_C_%s\\n' OK\n");
  await waitFor(() => output(meta.id).includes("CTRL_C_OK"), "foreground interruption");
  input(meta.id, "sleep .1; printf '\\nDISCONNECTED_%s\\n' OUTPUT\n");
  await waitFor(() => output(meta.id).includes("DISCONNECTED_OUTPUT"), "output while unsubscribed");
  expect(manager.get(meta.id)?.status).toBe("running");
  input(meta.id, "exit 7\n");
  await waitFor(() => manager.get(meta.id)?.status === "exited", "shell exit");
  expect(manager.get(meta.id)?.exitCode).toBe(7);
  expect(manager.open({ id: "tty", cwd: root }, env).id).toBe(meta.id);
  await manager.remove("tty", meta.id);
  const replacement = manager.open({ id: "tty", cwd: root }, env);
  expect(replacement.id).not.toBe(meta.id);
  await expect(manager.remove("tty", meta.id)).rejects.toThrow("终端已更换");
  expect(manager.get(replacement.id)?.status).toBe("running");
  await manager.remove("tty", replacement.id);
});

test("ending a terminal kills its foreground, background and nested jobs while keeping another project alive", async () => {
  const one = manager.open({ id: "kill-one", cwd: root }, env);
  const two = manager.open({ id: "kill-two", cwd: root }, env);
  input(
    one.id,
    `echo $$ > '${root}/shell.pid'; sleep 100 & echo $! > '${root}/background.pid'; bash -c 'sleep 101 & echo $! > "${root}/nested.pid"; wait' & echo $! > '${root}/parent.pid'; sleep 102 & echo $! > '${root}/foreground.pid'; fg\n`,
  );
  await waitFor(() => {
    try {
      return Number(readFileSync(join(root, "nested.pid"), "utf8")) > 0;
    } catch {
      return false;
    }
  }, "nested jobs started");
  const pids = ["shell", "background", "nested", "parent", "foreground"].map((name) =>
    Number(readFileSync(join(root, `${name}.pid`), "utf8")),
  );
  expect(pids.every(alive)).toBe(true);
  await manager.remove("kill-one", one.id);
  await waitFor(() => pids.every((pid) => !alive(pid)), "all terminal jobs stopped");
  input(two.id, "printf '\\nISOLATED_%s\\n' OK\n");
  await waitFor(() => output(two.id).includes("ISOLATED_OK"), "other project survived");
  await manager.remove("kill-two", two.id);
});

test("scrollback and input are bounded and invalid sizes/cwd are rejected", async () => {
  for (const [cols, rows] of [
    [0, 24],
    [80, 0],
    [501, 24],
    [80, 201],
    [2.5, 24],
  ])
    expect(() => terminalSize(cols, rows)).toThrow();
  expect(() => manager.open({ id: "bad", cwd: join(root, "missing") }, env)).toThrow("项目文件夹");
  const meta = manager.open({ id: "bounded", cwd: root }, env);
  expect(() =>
    manager.message(meta.id, JSON.stringify({ type: "input", data: "x".repeat(PROJECT_TERMINAL_LIMITS.message) })),
  ).toThrow("消息过大");
  expect(() => manager.message(meta.id, "null")).toThrow("消息无效");
  input(meta.id, "head -c 400000 /dev/zero | tr '\\0' 'x'; printf '\\nBUFFER_%s\\n' END\n");
  await waitFor(() => output(meta.id).includes("BUFFER_END"), "large output finished");
  expect(output(meta.id).length).toBeLessThanOrEqual(PROJECT_TERMINAL_LIMITS.scrollback);
  await manager.remove("bounded", meta.id);
});

test("large paste is delivered completely even when Bun accepts partial PTY writes", async () => {
  const meta = manager.open({ id: "paste", cwd: root }, env);
  input(
    meta.id,
    "stty -icanon -echo; printf '\\nPASTE_%s\\n' READY; head -c 60000 | wc -c; stty sane; printf '\\nPASTE_%s\\n' DONE\n",
  );
  await waitFor(() => output(meta.id).includes("PASTE_READY"), "raw reader ready");
  input(meta.id, "b".repeat(60000));
  await waitFor(() => output(meta.id).includes("PASTE_DONE"), "paste completely consumed");
  expect(output(meta.id)).toMatch(/\s60000\r?\n/);
  await manager.remove("paste", meta.id);
});

test("connection limits release on unsubscribe and shutdown kills each live terminal", async () => {
  const owned = new ProjectTerminals();
  try {
    const first = owned.open({ id: "shutdown-one", cwd: root }, env);
    const second = owned.open({ id: "shutdown-two", cwd: root }, env);
    const unsubscribes = Array.from({ length: PROJECT_TERMINAL_LIMITS.connections }, () =>
      owned.subscribe(first.id, () => {}),
    );
    expect(() => owned.subscribe(first.id, () => {})).toThrow("连接过多");
    for (const unsubscribe of unsubscribes) unsubscribe();
    expect(() => owned.subscribe(first.id, () => {})()).not.toThrow();
    for (const meta of [first, second])
      owned.message(
        meta.id,
        JSON.stringify({ type: "input", data: `sleep 100 & echo $! > '${root}/${meta.projectId}.pid'\n` }),
      );
    const pid = (projectId: string) => Number(readFileSync(join(root, `${projectId}.pid`), "utf8"));
    await waitFor(() => {
      try {
        return pid(first.projectId) > 0 && pid(second.projectId) > 0;
      } catch {
        return false;
      }
    }, "shutdown jobs started");
    const pids = [pid(first.projectId), pid(second.projectId)];
    expect(pids.every(alive)).toBe(true);
    await owned.shutdown();
    expect(pids.every((child) => !alive(child))).toBe(true);
    expect(owned.get(first.id)).toBeNull();
    expect(owned.get(second.id)).toBeNull();
    expect(() => owned.open({ id: "late", cwd: root }, env)).toThrow("服务正在关闭");
  } finally {
    await owned.shutdown();
  }
});

async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}
async function connection(id: string, origin?: string): Promise<{ ws: WebSocket; events: ProjectTerminalEvent[] }> {
  const NativeWebSocket = WebSocket as unknown as new (url: string, options?: Bun.WebSocketOptions) => WebSocket;
  const ws = new NativeWebSocket(
    `ws://127.0.0.1:${server.port}/ws/terminal/${id}`,
    origin ? { headers: { origin } } : undefined,
  );
  const events: ProjectTerminalEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("terminal websocket timed out"));
    }, 2000);
    ws.onmessage = (message) => {
      events.push(JSON.parse(String(message.data)));
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("terminal websocket rejected"));
    };
  });
  return { ws, events };
}

test("API/WS restore explicit terminals, enforce local boundary, and clean up cwd changes and project deletion", async () => {
  const project = await (await request("/api/projects", "POST", { name: "terminal API", cwd: root })).json();
  const path = `/api/projects/${project.id}/terminal`;
  expect(await (await request(path)).json()).toBeNull();
  expect(
    (await fetch(`${base}${path}`, { method: "POST", headers: { origin: "https://foreign.example" } })).status,
  ).toBe(403);
  const meta: ProjectTerminalMeta = await (await request(path, "POST", { cols: 84, rows: 28 })).json();
  expect(meta.projectId).toBe(project.id);
  await expect(connection(meta.id, "https://foreign.example")).rejects.toThrow("rejected");
  const first = await connection(meta.id, "http://localhost:5173");
  expect(first.events[0]?.type).toBe("snapshot");
  first.ws.send(JSON.stringify({ type: "input", data: "sleep .15; printf '\\nRESTORED_%s\\n' OK\n" }));
  first.ws.close();
  await waitFor(() => {
    let restored = false;
    app.projectTerminals.subscribe(meta.id, (event) => {
      if (event.type === "snapshot") restored = event.output.includes("RESTORED_OK");
    })();
    return restored;
  }, "output produced after socket disconnect");
  const second = await connection(meta.id);
  expect(second.events[0]).toMatchObject({ type: "snapshot", terminal: { id: meta.id, status: "running" } });
  expect((second.events[0] as { output: string }).output).toContain("RESTORED_OK");
  second.ws.close();
  expect((await request(`${path}?terminalId=wrong`, "DELETE")).status).toBe(409);
  const other = mkdtempSync(join(root, "changed-"));
  expect((await request(`/api/projects/${project.id}`, "PATCH", { cwd: other })).status).toBe(200);
  expect(await (await request(path)).json()).toBeNull();
  const moved: ProjectTerminalMeta = await (await request(path, "POST")).json();
  expect(moved.cwd).toBe(other);
  expect((await request(`/api/projects/${project.id}`, "DELETE")).status).toBe(200);
  expect(app.projectTerminals.get(moved.id)).toBeNull();
});

test("opening during terminal close or a project cwd change/deletion returns a retryable conflict", async () => {
  const meta = manager.open({ id: "closing", cwd: root }, env);
  const closing = manager.remove("closing", meta.id);
  expect(() => manager.open({ id: "closing", cwd: root }, env)).toThrow("正在关闭");
  await closing;

  const project = await (await request("/api/projects", "POST", { name: "concurrent cwd", cwd: root })).json();
  const projectPath = `/api/projects/${project.id}`;
  const terminalPath = `${projectPath}/terminal`;
  const original: ProjectTerminalMeta = await (await request(terminalPath, "POST")).json();
  const changed = mkdtempSync(join(root, "concurrent-"));
  const patch = request(projectPath, "PATCH", { cwd: changed });
  await Bun.sleep(15);
  const duringPatch = await request(terminalPath, "POST");
  expect(duringPatch.status).toBe(409);
  expect((await duringPatch.json()).error).toContain("稍后重试");
  expect((await patch).status).toBe(200);
  expect(await (await request(terminalPath)).json()).toBeNull();
  const updated: ProjectTerminalMeta = await (await request(terminalPath, "POST")).json();
  expect(updated.id).not.toBe(original.id);
  expect(updated.cwd).toBe(changed);

  const deletion = request(projectPath, "DELETE");
  await Bun.sleep(15);
  const duringDeletion = await request(terminalPath, "POST");
  expect(duringDeletion.status).toBe(409);
  expect((await duringDeletion.json()).error).toContain("稍后重试");
  expect((await deletion).status).toBe(200);
  expect((await request(terminalPath, "POST")).status).toBe(404);
  expect(app.projectTerminals.get(updated.id)).toBeNull();
});
