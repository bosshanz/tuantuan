import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ServerLayout } from "./paths";

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.unref();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => done(port));
    });
  });
}

export interface RunningServer {
  url: string;
  port: number;
  child: ChildProcess;
  stop(): Promise<void>;
}

/** Start `bun server/main.ts` on a free localhost port and wait until /api/health answers. */
export async function startServer(opts: {
  layout: ServerLayout;
  env: Record<string, string>;
  userData: string;
  logDir: string;
}): Promise<RunningServer> {
  const port = await freePort();
  mkdirSync(opts.logDir, { recursive: true });
  const log = createWriteStream(join(opts.logDir, "server.log"), { flags: "a" });
  const child = spawn(opts.layout.bun, [opts.layout.entry], {
    cwd: opts.layout.root,
    // The server owns this group; cancellable harnesses / terminals own additional groups.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...opts.env,
      PORT: String(port),
      TUANTUAN_HOST: "127.0.0.1",
      DB_PATH: join(opts.userData, "data", "tuantuan.db"),
      TUANTUAN_WORKSPACES: opts.env.TUANTUAN_WORKSPACES || "~/Tuantuan",
      ...(opts.layout.staticDir ? { TUANTUAN_STATIC_DIR: opts.layout.staticDir } : {}),
      TUANTUAN_PARENT_PID: String(process.pid),
      TUANTUAN_DESKTOP: "1",
    },
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const url = `http://127.0.0.1:${port}`;
  let exited: string | null = null;
  child.on("exit", (code, sig) => {
    exited = `服务进程退出（${code ?? sig}）`;
  });
  child.on("error", (e) => {
    exited = `无法启动服务：${e.message}`;
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) throw new Error(exited);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      killTree(child, "SIGKILL");
      throw new Error("服务 30 秒内没有启动");
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  let stopping: Promise<void> | null = null;
  const tree: TrackedTree = { groups: new Map() };
  return {
    url,
    port,
    child,
    stop: () => {
      stopping ??= new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          killTree(child, "SIGKILL", tree);
          log.end();
          return done();
        }
        const force = setTimeout(() => killTree(child, "SIGKILL", tree), 4000);
        child.once("exit", () => {
          clearTimeout(force);
          // Retain ownership after reparenting when the server exits before its descendants.
          killTree(child, "SIGKILL", tree);
          log.end();
          done();
        });
        killTree(child, "SIGTERM", tree);
      });
      return stopping;
    },
  };
}

type ProcessRow = { pid: number; parent: number; group: number; started: string };
type TrackedTree = { rootStarted?: string; groups: Map<number, Map<number, string>> };

function processTable(): ProcessRow[] {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (ps.error || ps.status !== 0) throw ps.error ?? new Error(ps.stderr || "ps failed");
  return ps.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match
      ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4] as string }]
      : [];
  });
}

export function killTree(child: ChildProcess, sig: NodeJS.Signals, tree: TrackedTree = { groups: new Map() }) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  const running = child.exitCode === null && child.signalCode === null;
  let groups: number[];
  try {
    const rows = processTable();
    const callerGroup = rows.find((row) => row.pid === process.pid)?.group;
    if (callerGroup === undefined) throw new Error("ps did not identify the desktop process group");
    const root = rows.find((row) => row.pid === child.pid);
    if (running && root && (!tree.rootStarted || tree.rootStarted === root.started)) {
      tree.rootStarted = root.started;
      const descendants = new Set([child.pid]);
      for (;;) {
        const before = descendants.size;
        for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
        if (before === descendants.size) break;
      }
      for (const row of rows) {
        if (descendants.has(row.pid) && row.group !== callerGroup && !tree.groups.has(row.group))
          tree.groups.set(row.group, new Map());
      }
    }
    groups = [];
    for (const [group, members] of tree.groups) {
      if (group === callerGroup) continue;
      const current = rows.filter((row) => row.group === group);
      // A group id can be reused. Signal it only while at least one recorded process identity
      // remains (or this snapshot first discovered it beneath the still-running server).
      if (members.size && !current.some((row) => members.get(row.pid) === row.started)) continue;
      if (!current.length) continue;
      tree.groups.set(group, new Map(current.map((row) => [row.pid, row.started])));
      groups.push(group);
    }
  } catch (error) {
    console.warn("无法读取服务进程树，回收服务原进程组", error);
    // Keep the original group fallback when ps is unavailable. Detached descendants cannot be
    // safely rediscovered after reparenting, so never guess ownership of a reused group id.
    groups = running ? [child.pid] : [];
  }
  // Descendant groups first: the root can exit immediately after receiving its signal.
  groups.sort((a, b) => Number(a === child.pid) - Number(b === child.pid));
  for (const group of groups) {
    try {
      process.kill(-group, sig);
    } catch {
      if (group === child.pid && running) {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    }
  }
}
