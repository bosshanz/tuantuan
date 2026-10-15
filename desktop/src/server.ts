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
    // Own process group (POSIX) so the whole tree — server + every harness — goes down together.
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
  return {
    url,
    port,
    child,
    stop: () => {
      stopping ??= new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        const force = setTimeout(() => killTree(child, "SIGKILL"), 4000);
        child.once("exit", () => {
          clearTimeout(force);
          // Stragglers in the group (a harness that ignored SIGTERM) go too.
          killTree(child, "SIGKILL");
          log.end();
          done();
        });
        killTree(child, "SIGTERM");
      });
      return stopping;
    },
  };
}

export function killTree(child: ChildProcess, sig: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}
