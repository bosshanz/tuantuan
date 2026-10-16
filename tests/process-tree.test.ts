import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { killProcessTree } from "../server/process-tree";

const pid = 2_147_483_000;
const realKill = process.kill.bind(process);
const failure = (code: string) => Object.assign(new Error(`kill() failed: ${code}`), { code });
let groupSignal: ReturnType<typeof mock<(signal: Parameters<typeof process.kill>[1]) => true>>;
let killSpy: ReturnType<typeof spyOn<typeof process, "kill">>;
let warnSpy: ReturnType<typeof spyOn<typeof console, "warn">>;
let child: {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof mock<(signal?: number | NodeJS.Signals) => void>>;
};

describe.skipIf(process.platform === "win32")("process group cleanup errors", () => {
  beforeEach(() => {
    child = { pid, exitCode: null, signalCode: null, kill: mock(() => {}) };
    groupSignal = mock(() => true as const);
    // Never replace signalling of other tests' real subprocesses.
    killSpy = spyOn(process, "kill").mockImplementation((target, signal) =>
      target === -pid ? groupSignal(signal) : realKill(target, signal),
    );
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    // Cancel any outstanding escalation, including when an assertion fails.
    groupSignal.mockImplementation(() => true);
    killProcessTree(child, "SIGKILL");
    killSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("an exited group is a no-op and never signals the exited child", async () => {
    child.exitCode = 0;
    groupSignal.mockImplementation(() => {
      throw failure("ESRCH");
    });
    expect(() => killProcessTree(child)).not.toThrow();
    await Bun.sleep(350);
    expect(groupSignal).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("initial EPERM falls back to the live child and retains diagnostics", () => {
    groupSignal.mockImplementation(() => {
      throw failure("EPERM");
    });
    expect(() => killProcessTree(child, "SIGKILL")).not.toThrow();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("EPERM"));
  });

  test("a failed fallback stays inside cleanup rather than overriding the caller's result", async () => {
    groupSignal.mockImplementation(() => {
      throw failure("EPERM");
    });
    child.kill.mockImplementation(() => {
      throw failure("EPERM");
    });
    expect(() => killProcessTree(child)).not.toThrow();
    await Bun.sleep(350);
    expect(groupSignal).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("进程组"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("子进程"));
  });

  test("delayed EPERM after the child exits cannot escape the timer", async () => {
    groupSignal.mockImplementation((signal) => {
      if (signal === "SIGKILL") throw failure("EPERM");
      return true;
    });
    killProcessTree(child);
    child.exitCode = 0;
    await Bun.sleep(350);
    expect(groupSignal.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("SIGKILL，EPERM"));
  });

  test("an unexpected delayed OS error is also reported without escaping", async () => {
    groupSignal.mockImplementation((signal) => {
      if (signal === "SIGKILL") throw failure("EIO");
      return true;
    });
    killProcessTree(child);
    await Bun.sleep(350);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("EIO"));
  });

  test("explicit KILL clears the pending escalation instead of signalling twice", async () => {
    killProcessTree(child);
    killProcessTree(child, "SIGKILL");
    await Bun.sleep(350);
    expect(groupSignal.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
});
