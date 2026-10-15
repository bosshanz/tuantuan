/** Every cancellable command must start in its own process group. */
export const processGroupOptions = { detached: process.platform !== "win32" };

type ChildProcess = { pid: number; kill(signal?: number | NodeJS.Signals): unknown };

/** Stop descendants even when the original shell has already exited. */
export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  const send = (next: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, next);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      // The process may have exited before its group was created.
      try {
        proc.kill(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  send(signal);
  if (signal !== "SIGKILL") {
    // Install scripts and shells can trap TERM; they must not keep running after cancellation.
    const timer = setTimeout(() => send("SIGKILL"), 250);
    timer.unref();
  }
}
