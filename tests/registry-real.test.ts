import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import "./helpers";

/**
 * Real installs from the official ACP registry + ACP handshake (network; opt-in):
 *   TUANTUAN_REAL_REGISTRY=1 bun test tests/registry-real.test.ts
 * Each agent is installed into a throwaway managed dir exactly like the 安装 button does.
 */
const real = process.env.TUANTUAN_REAL_REGISTRY === "1";
process.env.TUANTUAN_HARNESS_DIR = mkdtempSync(join(tmpdir(), "tuantuan-managed-"));
const { app, server } = serve({ dbPath: ":memory:" }, 0);
const base = `http://localhost:${server.port}`;
const api = async <T>(m: string, p: string, b?: unknown) =>
  (await (
    await fetch(base + p, {
      method: m,
      headers: { "content-type": "application/json" },
      body: b === undefined ? undefined : JSON.stringify(b),
    })
  ).json()) as T;
afterAll(() => {
  app.host.shutdown();
  app.installer.shutdown();
  server.stop(true);
});

type Job = { state: string; error: string | null; log: string[] };
type Probe = {
  ok: boolean;
  error?: string;
  agentInfo?: { name: string; version: string };
  authMethods?: { name: string; type: string }[];
  loggedIn?: boolean | null;
  sessionError?: string | null;
};

for (const [regId, harnessId] of [
  ["pi-acp", "pi"],
  ["glm-acp-agent", "reg:glm-acp-agent"],
  ["minimax-code", "minimax"],
  ["zcode-acp", "reg:zcode-acp"],
  ["opencode", "opencode"],
  ["fast-agent", "reg:fast-agent"],
] as const) {
  test.skipIf(!real)(
    `${regId}: install from the registry, then ACP handshake`,
    async () => {
      await api("POST", `/api/registry/install/${regId}`);
      let job: Job | null = null;
      for (let i = 0; i < 600; i++) {
        job = await api<Job>("GET", `/api/harnesses/${encodeURIComponent(harnessId)}/install`);
        if (job && job.state !== "running") break;
        await Bun.sleep(500);
      }
      if (job?.state !== "done") console.log(JSON.stringify(job)?.slice(-1500));
      expect(job?.state).toBe("done");
      const hs = await api<{ id: string; source: string; version: string; command: string }[]>("GET", "/api/harnesses");
      const h = hs.find((x) => x.id === harnessId);
      console.log(regId, h?.source, h?.version, h?.command);
      // (a user's own install on PATH still wins, as before; the managed copy is there either way)
      expect(["managed", "path"]).toContain(h?.source ?? "");
      const reg = await api<{ agents: { id: string; installedVersion: string | null }[] }>("GET", "/api/registry");
      expect(reg.agents.find((a) => a.id === regId)?.installedVersion).toBeTruthy();
      const r = await api<Probe>("POST", `/api/harnesses/${encodeURIComponent(harnessId)}/test`);
      console.log(
        `RESULT ${regId} | ${h?.version} | ${h?.command.split("/").slice(-3).join("/")} | ok=${r.ok} | ${r.agentInfo?.name} ${r.agentInfo?.version} | auth=${r.authMethods?.map((m) => `${m.name}(${m.type})`).join(", ")} | loggedIn=${r.loggedIn} | ${(r.sessionError ?? r.error ?? "").slice(0, 120)}`,
      );
      expect(r.ok).toBe(true);
    },
    { timeout: 600_000 },
  );
}
