/** Every cancellable command must start in its own process group. */
export const processGroupOptions = { detached: process.platform !== "win32" };

type ChildProcess = Pick<ReturnType<typeof Bun.spawn>, "pid" | "kill" | "exitCode" | "signalCode">;
const pendingKills = new WeakMap<ChildProcess, ReturnType<typeof setTimeout>>();

/** Best-effort cleanup, including descendants left behind after the original shell exits. */
export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pending = pendingKills.get(proc);
  if (pending) {
    clearTimeout(pending);
    pendingKills.delete(proc);
  }
  const report = (target: string, next: NodeJS.Signals, error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    console.warn(`无法终止${target} ${proc.pid}（${next}，${code}）`);
  };
  if (process.platform === "win32") {
    try {
      const result = Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (!result.success && proc.exitCode === null && proc.signalCode === null)
        report("进程树", signal, new Error(`taskkill exit ${result.exitCode}`));
    } catch (error) {
      report("进程树", signal, error);
    }
    return;
  }
  const send = (next: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, next);
      return true;
    } catch (e) {
      // macOS can return EPERM for a group containing only unreaped zombies. A genuine
      // permission failure must also stay local to cleanup, especially in the timer below.
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") report("进程组", next, e);
      // Keep signalling the group above even after its leader exits: descendants may remain.
      // Only the fallback targets the child itself, whose handle tells us whether it has exited.
      if (proc.exitCode !== null || proc.signalCode !== null) return false;
      try {
        proc.kill(next);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") report("子进程", next, error);
        return false;
      }
    }
  };
  if (send(signal) && signal !== "SIGKILL") {
    // Install scripts and shells can trap TERM; they must not keep running after cancellation.
    const timer = setTimeout(() => {
      pendingKills.delete(proc);
      send("SIGKILL");
    }, 250);
    pendingKills.set(proc, timer);
    timer.unref();
  }
}
