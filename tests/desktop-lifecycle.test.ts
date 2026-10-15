import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killTree, startServer } from "../desktop/src/server";
import { shellQuote } from "../server/acp";
import { Store } from "../server/store";
import { until } from "./helpers";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const frozen of [false, true]) {
  test.skipIf(process.platform === "win32")(
    `desktop stop reclaims separate harness groups and TERM-resistant descendants${frozen ? " while the server is frozen" : ""}`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tt-desktop-stop-"));
      const shell = join(root, "login-shell");
      const wrapper = join(root, "mock-wrapper");
      const harnessFile = join(root, "harness.pid");
      const childFile = join(root, "child.pid");
      writeFileSync(shell, `#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\0HOME=${root}\\0'\n`);
      chmodSync(shell, 0o755);
      const descendant = `trap '' TERM; printf '%s' "$$" > ${shellQuote(childFile)}; exec /bin/sleep 60`;
      writeFileSync(
        wrapper,
        `#!/bin/sh\nprintf '%s' "$$" > ${shellQuote(harnessFile)}\n/bin/sh -c ${shellQuote(descendant)} &\nexec ${shellQuote(process.execPath)} "$@"\n`,
      );
      chmodSync(wrapper, 0o755);
      const userData = join(root, "user");
      const cwd = join(root, "project");
      mkdirSync(cwd);
      mkdirSync(join(userData, "data"), { recursive: true });
      const store = new Store(join(userData, "data", "tuantuan.db"));
      store.setSetting("harnessPaths", { mock: wrapper });
      const agent = store.createAgent({
        name: "Synthetic",
        color: "#336699",
        avatar: "S",
        identity: "",
        harness: "mock",
        env: {},
        mcpServerIds: [],
        permissionPolicy: "ask",
      });
      const project = store.createProject("Synthetic", cwd);
      const room = store.createRoom("Synthetic", [agent.id], { projectId: project.id });
      store.db.close();
      // An unrelated process group must survive the desktop's tree cleanup.
      const unrelated = Bun.spawn(["/bin/sleep", "60"], { detached: true, stdout: "ignore", stderr: "ignore" });
      let server: Awaited<ReturnType<typeof startServer>> | undefined;
      let harness = 0;
      let child = 0;
      try {
        server = await startServer({
          layout: {
            bun: process.execPath,
            root: resolve("."),
            entry: resolve("server/main.ts"),
            staticDir: undefined,
          },
          userData,
          logDir: join(root, "logs"),
          env: {
            PATH: "/usr/bin:/bin",
            SHELL: shell,
            TUANTUAN_REGISTRY_OFFLINE: "1",
            TUANTUAN_MOCK_HARNESS: "1",
            TUANTUAN_SKILLS_HOME: root,
            TUANTUAN_WORKSPACES: join(root, "workspaces"),
            TUANTUAN_HARNESS_DIR: join(root, "managed"),
          },
        });
        const response = await fetch(`${server.url}/api/rooms/${room.id}/agents/${agent.id}/session`);
        expect(response.status).toBe(200);
        await until(() => existsSync(childFile));
        harness = Number(readFileSync(harnessFile, "utf8"));
        child = Number(readFileSync(childFile, "utf8"));
        expect(alive(harness)).toBe(true);
        expect(alive(child)).toBe(true);
        if (frozen) process.kill(server.child.pid as number, "SIGSTOP");
        await server.stop();
        await until(() => !alive(harness) && !alive(child), 1500);
        expect(alive(server.child.pid as number)).toBe(false);
        expect(alive(unrelated.pid)).toBe(true);
        await server.stop(); // Idempotent after the root process has exited.
      } finally {
        if (server?.child.pid) {
          try {
            process.kill(-server.child.pid, "SIGKILL");
          } catch {}
        }
        for (const pid of [harness, child, unrelated.pid]) {
          if (!pid) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        await unrelated.exited;
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
}

test.skipIf(process.platform === "win32")("tree cleanup does not signal the caller's own process group", async () => {
  const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  try {
    killTree(child, "SIGKILL");
    expect(alive(child.pid as number)).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((done) => child.once("exit", () => done()));
  }
});
