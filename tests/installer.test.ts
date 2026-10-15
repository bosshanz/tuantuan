import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../server/acp";
import {
  bundledAdapter,
  bundledClaudeBinary,
  detectHarness,
  getRegistry,
  harnessSpec,
  loginCommand,
  loginShellEnv,
  resetLoginShellEnv,
  setRegistry,
} from "../server/harness";
import { Installer, type InstallJob } from "../server/installer";
import { Registry } from "../server/registry";

const dir = mkdtempSync(join(tmpdir(), "tt-install-"));
const home = mkdtempSync(join(tmpdir(), "tt-home-"));
const fakeShell = join(dir, "fake-login-shell");
const saved = { SHELL: process.env.SHELL, DIR: process.env.TUANTUAN_MOCK_INSTALL_DIR };
const savedRegistry = getRegistry();

beforeAll(() => {
  // A login shell whose PATH has no harness adapters: what a fresh machine looks like.
  writeFileSync(fakeShell, `#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\0HOME=${home}\\0'\n`);
  chmodSync(fakeShell, 0o755);
  process.env.SHELL = fakeShell;
  process.env.TUANTUAN_MOCK_INSTALL_DIR = join(dir, "bin");
  setRegistry(new Registry(join(dir, "registry")));
  resetLoginShellEnv();
});
afterAll(() => {
  process.env.SHELL = saved.SHELL;
  if (saved.DIR === undefined) delete process.env.TUANTUAN_MOCK_INSTALL_DIR;
  else process.env.TUANTUAN_MOCK_INSTALL_DIR = saved.DIR;
  resetLoginShellEnv();
  setRegistry(savedRegistry);
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const spec = () => {
  const s = harnessSpec("mock-cli");
  if (!s?.installers?.[0]) throw new Error("mock-cli harness missing");
  return { s, inst: s.installers[0] };
};
const finished = async (inst: Installer, id: string) => {
  for (let i = 0; i < 200; i++) {
    const j = inst.get(id);
    if (j && j.state !== "running") return j;
    await Bun.sleep(50);
  }
  throw new Error("installer did not finish");
};

describe("bundled ACP adapters", () => {
  test("claude-agent-acp and codex-acp resolve from Tuantuan's node_modules and launch with bun", async () => {
    for (const id of ["claude-code", "codex"]) {
      const s = harnessSpec(id);
      if (!s) throw new Error(id);
      const b = bundledAdapter(s);
      expect(b?.script).toMatch(/node_modules\/@agentclientprotocol\/.+\/dist\/index\.js$/);
      const st = await detectHarness(s, null);
      expect(st).toMatchObject({ source: "bundled", command: process.execPath, version: b?.version });
      expect(st.args[0]).toBe(b?.script as string);
    }
    // The Agent SDK ships the Claude Code binary for this platform; no separate CLI needed.
    expect(bundledClaudeBinary()).toMatch(/claude-agent-sdk-[a-z0-9-]+\/claude$/);
    // loginShellEnv also adds common global install directories, which may contain a real Claude.
    // Check the no-CLI case with a controlled PATH instead of depending on the developer's machine.
    expect(loginCommand(harnessSpec("claude-code") as never, { PATH: "/usr/bin:/bin" })).toContain("claude-agent-sdk-");
  });

  test("the user's own install on PATH wins over the bundled one", async () => {
    const bin = join(home, "claude-agent-acp");
    writeFileSync(bin, "#!/bin/sh\necho 9.9.9\n");
    chmodSync(bin, 0o755);
    writeFileSync(fakeShell, `#!/bin/sh\nprintf 'PATH=${home}:/usr/bin:/bin\\0HOME=${home}\\0'\n`);
    resetLoginShellEnv();
    try {
      const st = await detectHarness(harnessSpec("claude-code") as never, null);
      expect(st).toMatchObject({ source: "path", command: bin, version: "9.9.9" });
      expect(st.bundledVersion).toBeTruthy();
    } finally {
      writeFileSync(fakeShell, `#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\0HOME=${home}\\0'\n`);
      rmSync(bin);
      resetLoginShellEnv();
    }
  });

  test("grok / opencode are not bundled: offered as user-level one-click installs", async () => {
    const env = await loginShellEnv();
    expect(env.PATH).toContain(`${home}/.bun/bin`);
    const grok = await detectHarness(harnessSpec("grok") as never, null);
    expect(grok.command).toBeNull();
    expect(grok.installers.map((i) => i.id)).toEqual(["registry", "script"]);
    const oc = await detectHarness(harnessSpec("opencode") as never, null);
    expect(oc.installers.map((i) => i.id)).toEqual(["registry", "script", "bun", "brew", "npm"]);
    expect(oc.installers.find((i) => i.id === "bun")).toMatchObject({
      available: true,
      command: "bun add -g opencode-ai",
    });
    for (const i of oc.installers) expect(i.command).not.toContain("sudo");
  });
});

describe("one-click installer (mock)", () => {
  test("streams progress, strips ANSI / \\r redraws, then the harness is detected on PATH", async () => {
    const { s, inst } = spec();
    expect((await detectHarness(s, null)).command).toBeNull();
    let done: InstallJob | null = null;
    const installer = new Installer((j) => {
      done = j;
    });
    const env = await loginShellEnv();
    installer.start("mock-cli", inst, env);
    expect(installer.start("mock-cli", inst, env).state).toBe("running"); // no second run while busy
    const j = await finished(installer, "mock-cli");
    expect(j.state).toBe("done");
    expect(done).not.toBeNull();
    expect(j.log[0]).toStartWith("$ bun ");
    expect(j.log).toContain("校验通过");
    expect(j.log).toContain("进度 100%");
    expect(j.log.some((l) => l.includes("\u001b"))).toBe(false);
    const st = await detectHarness(s, null);
    expect(st).toMatchObject({ source: "path", command: join(dir, "bin", "mock-cli") });
    // Incremental reads.
    const tail = installer.get("mock-cli", j.lines - 1);
    expect(tail?.log).toEqual(["安装完成"]);
    rmSync(join(dir, "bin"), { recursive: true, force: true });
  });

  test("failure keeps the log and reports the last line", async () => {
    const { inst } = spec();
    const installer = new Installer();
    const env = { ...(await loginShellEnv()), MOCK_INSTALL_FAIL: "1" };
    installer.start("mock-cli", inst, env);
    const j = await finished(installer, "mock-cli");
    expect(j).toMatchObject({ state: "error", error: "error: 网络不可用（mock）" });
    expect(existsSync(join(dir, "bin", "mock-cli"))).toBe(false);
  });

  test("cancel stops it", async () => {
    const { inst } = spec();
    const installer = new Installer();
    const env = { ...(await loginShellEnv()), MOCK_INSTALL_SLOW: "1" };
    installer.start("mock-cli", inst, env);
    await Bun.sleep(300);
    const t0 = Date.now();
    expect(installer.cancel("mock-cli")?.state).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(installer.get("mock-cli")?.log.at(-1)).toBe("已取消");
    await Bun.sleep(200);
    expect(existsSync(join(dir, "bin", "mock-cli"))).toBe(false);
  });

  for (const stop of ["cancel", "shutdown", "timeout"] as const) {
    test(`${stop} stops grandchildren, including shells that ignore TERM`, async () => {
      const started = join(dir, `${stop}-started`);
      const marker = join(dir, `${stop}-survived`);
      const grandchild = join(dir, `${stop}-grandchild.sh`);
      const child = join(dir, `${stop}-child.sh`);
      writeFileSync(
        grandchild,
        `trap '' TERM\nprintf ready > ${shellQuote(started)}\n/bin/sleep ${stop === "timeout" ? "0.35" : "0.1"}\nprintf survived > ${shellQuote(marker)}\n`,
      );
      writeFileSync(child, `sh ${shellQuote(grandchild)} &\nwait\n`);
      let finishes = 0;
      const installer = new Installer(() => finishes++, stop === "timeout" ? 250 : undefined);
      try {
        installer.start(
          `tree-${stop}`,
          { id: "script", label: "test", tool: "sh", command: `sh ${shellQuote(child)}; :` },
          { PATH: "/usr/bin:/bin" },
        );
        for (let i = 0; i < 100 && !existsSync(started); i++) await Bun.sleep(5);
        expect(existsSync(started)).toBe(true);
        if (stop === "cancel") installer.cancel(`tree-${stop}`);
        if (stop === "shutdown") installer.shutdown();
        const job = await finished(installer, `tree-${stop}`);
        expect(job.state).toBe(stop === "timeout" ? "error" : "cancelled");
        if (stop === "timeout") expect(job.error).toContain("安装超时");
        await Bun.sleep(450);
        expect(existsSync(marker)).toBe(false);
        expect(installer.get(`tree-${stop}`)?.state).toBe(job.state);
        expect(finishes).toBe(1);
      } finally {
        installer.shutdown();
      }
    });
  }
});
