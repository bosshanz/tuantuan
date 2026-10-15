import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpProcess, shellQuote } from "../server/acp";
import { until } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "tt-acp-processes-"));
const script = join(root, "tree.ts");
writeFileSync(
  script,
  `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, ready, marker] = process.argv.slice(2);
if (mode === "child") {
  process.on("SIGTERM", () => {});
  writeFileSync(ready, String(process.pid));
  setTimeout(() => writeFileSync(marker, "escaped cancellation"), 900);
} else {
  spawn(process.execPath, [import.meta.path, "child", ready, marker], { stdio: "ignore" });
}
setInterval(() => {}, 1000);
`,
);
const processes: AcpProcess[] = [];
const children: number[] = [];
function launch(args: string[]) {
  const p = new AcpProcess(
    { command: process.execPath, args, cwd: root, env: {} },
    { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
  );
  processes.push(p);
  return p;
}
async function childReady(path: string) {
  await until(() => existsSync(path));
  const pid = Number(readFileSync(path, "utf8"));
  children.push(pid);
  return pid;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
afterAll(async () => {
  for (const p of processes) p.kill();
  for (const pid of children) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await Promise.all(processes.map((p) => p.exited));
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("ACP kill also stops descendants that ignore TERM", async () => {
  const ready = join(root, "agent-ready");
  const marker = join(root, "agent-marker");
  const p = launch([script, "parent", ready, marker]);
  const child = await childReady(ready);
  p.kill();
  await p.exited;
  await Bun.sleep(1100);
  expect(existsSync(marker)).toBe(false);
  expect(alive(child)).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "ACP kill is idempotent and still allows explicit KILL escalation",
  async () => {
    const ready = join(root, "idempotent-ready");
    const marker = join(root, "idempotent-marker");
    const p = launch([script, "child", ready, marker]);
    await childReady(ready);
    p.kill();
    expect(() => p.kill()).not.toThrow();
    await Bun.sleep(50);
    expect(alive(p.proc.pid)).toBe(true);
    p.kill("SIGKILL");
    await p.exited;
    expect(p.proc.signalCode).toBe("SIGKILL");
    expect(() => p.kill("SIGKILL")).not.toThrow();
  },
);

test.skipIf(process.platform === "win32")(
  "terminal release and ACP shutdown reclaim terminal descendants",
  async () => {
    type Terminals = {
      createTerminal(p: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
      releaseTerminal(id: string): acp.ReleaseTerminalResponse;
    };
    for (const action of ["release", "shutdown"]) {
      const p = launch(["-e", "setInterval(() => {}, 1000)"]);
      const terminals = p as unknown as Terminals;
      const ready = join(root, `${action}-ready`);
      const marker = join(root, `${action}-marker`);
      const terminal = await terminals.createTerminal({
        sessionId: "test",
        command: [process.execPath, script, "parent", ready, marker].map(shellQuote).join(" "),
      });
      const child = await childReady(ready);
      if (action === "release") terminals.releaseTerminal(terminal.terminalId);
      else p.kill();
      await Bun.sleep(1100);
      expect(existsSync(marker)).toBe(false);
      expect(alive(child)).toBe(false);
    }
  },
);
