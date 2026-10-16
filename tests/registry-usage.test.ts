import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "../server/app";
import { resetLoginShellEnv } from "../server/harness";
import { parseAntigravityUsage, parseZcodeUsage, ZCODE_070_NOTE } from "../server/registry-usage";
import type { HarnessUsage } from "../server/usage";
import { agentInput, until } from "./helpers";

const markdown = `### Session Usage
- **Session total:** 1,200 tokens (prompt: 1,000, completion: 200)

### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini Flash, Gemini Pro)*
  - **Weekly Limit Remaining:** 91% remaining (resets Oct 02, 2026, 08:00 UTC)
  - **Five Hour Limit Remaining:** 100% remaining
- **Claude and GPT models**
  - **Weekly Limit Remaining:** 99% remaining
- **Gemini 4 Argon**
  - **Gemini 4 Argon Weekly Limit:** 82% remaining (resets Oct 23, 2026, 02:05 UTC)
`;

describe("Registry quota parsers", () => {
  test("Antigravity groups/remaining/reset and tier preserve account quota, never session tokens", () => {
    const result = parseAntigravityUsage(markdown, { antigravity: { tier: { name: "Google AI Pro", id: "pro" } } });
    expect(result.plan).toBe("Google AI Pro");
    expect(result.limits.map((x) => x.usedPercent)).toEqual([9, 0, 1, 18]);
    expect(result.limits[0]).toEqual({
      label: "Gemini Models · Weekly Limit Remaining",
      usedPercent: 9,
      resetsAt: "Oct 02, 2026, 08:00 UTC",
    });
    expect(result.limits.some((x) => /Session/.test(x.label))).toBe(false);
    expect(result.error).toBeNull();
  });
  test("absolute units, disabled, unavailable, invalid percentages and failures stay explicit", () => {
    const result = parseAntigravityUsage(
      `### Quota Limits\n- **A**\n  - **Count:** 1,200 units remaining (resets tomorrow)\n  - **Off:** Disabled: this tier\n  - **Bad:** 101% remaining\n  - **Unknown:** Available`,
    );
    expect(result.limits).toEqual([]);
    expect(result.notes.join(" ")).toContain("1,200 units remaining");
    expect(result.notes.join(" ")).toContain("Disabled");
    expect(
      parseAntigravityUsage("### Quota Limits\n- Not applicable for current authentication method.").limits,
    ).toEqual([]);
    expect(parseAntigravityUsage("### Quota Limits\n- Unable to retrieve quota status (offline)").error).toContain(
      "offline",
    );
    expect(parseAntigravityUsage("### Session Usage\n- **Session total:** 1200 tokens").error).toContain("未知");
  });
  test("ZCode reads only glm, validates percentages, preserves count/detail and identifies 0.70 limits", () => {
    const result = parseZcodeUsage(
      {
        glm: {
          kind: "success",
          level: "PRO",
          items: [
            {
              key: "five",
              label: "5小时",
              usedPercent: 12.5,
              leftPercent: 87.5,
              usedCount: 5,
              totalCount: 40,
              nextResetTime: Date.parse("2026-10-23T08:00:00Z"),
              detail: [
                { modelCode: "glm-5", usage: 17 },
                { modelCode: "glm-4.7", usage: 0 },
              ],
            },
            { key: "week", label: "每周", leftPercent: 90 },
            { key: "bad", usedPercent: 101 },
          ],
        },
        opencode: { items: [{ usedPercent: 0 }] },
      },
      "0.70.0",
    );
    expect(result.limits.map((x) => x.usedPercent)).toEqual([12.5, 10]);
    expect(result.plan).toBe("PRO");
    expect(result.notes).toContain(ZCODE_070_NOTE);
    expect(result.notes.join(" ")).toContain("已用 5 / 总量 40");
    expect(result.limits[0]?.resetsAt).toBe("2026-10-23T08:00:00.000Z");
    expect(result.notes.join(" ")).toContain("glm-5：17");
    expect(result.notes.join(" ")).toContain("glm-4.7：0");
    const unknownDetail = parseZcodeUsage(
      {
        glm: {
          kind: "success",
          items: [
            {
              key: "bad",
              detail: [{ modelCode: "unknown", usage: "17" }, { modelCode: "negative", usage: -1 }, { usage: 0 }],
            },
            { key: "old-wrong-fixture", detail: "个人套餐" },
          ],
        },
      },
      "0.70.0",
    );
    expect(unknownDetail.limits).toEqual([]);
    expect(unknownDetail.notes).toEqual([ZCODE_070_NOTE]);
    expect(unknownDetail.error).toContain("未知");
    for (const kind of ["auth_error", "rate_limited", "unavailable", "not_configured"]) {
      const missing = parseZcodeUsage({ glm: { kind } }, "0.70.0");
      expect(missing.limits).toEqual([]);
      expect(missing.error).toBeTruthy();
      expect(missing.notes).toContain(ZCODE_070_NOTE);
    }
    expect(parseZcodeUsage({}, "0.70.0").limits).toEqual([]);
  });
});

const scratch = mkdtempSync(join(tmpdir(), "tt-registry-usage-"));
const dbPath = join(scratch, "data/state.db");
const previousUsageHome = process.env.TUANTUAN_USAGE_HOME;
process.env.TUANTUAN_USAGE_HOME = join(scratch, "usage-home");
const previousShell = process.env.SHELL;
const shell = join(scratch, "shell");
writeFileSync(shell, `#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\0HOME=${scratch}\\0'\n`, { mode: 0o755 });
process.env.SHELL = shell;
resetLoginShellEnv();
const ids = ["antigravity-acp", "zcode-acp"] as const;
const configs = Object.fromEntries(
  ids.map((id) => [
    id,
    {
      authFile: join(scratch, `${id}.auth`),
      log: join(scratch, `${id}.log`),
      delay: 35,
      markdown,
      zcode: { glm: { kind: "success", level: "GLM PRO", items: [{ key: "day", label: "每周", usedPercent: 27 }] } },
    },
  ]),
) as Record<(typeof ids)[number], { authFile: string; log: string; delay: number; markdown: string; zcode: unknown }>;
for (const id of ids) {
  const path = join(dirname(dbPath), "harnesses/agents", id);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(scratch, `${id}.json`), JSON.stringify(configs[id]));
  writeFileSync(configs[id].log, "");
  writeFileSync(
    join(path, "manifest.json"),
    JSON.stringify({
      id,
      version: id === "zcode-acp" ? "0.70.0" : "1.4.0",
      kind: "binary",
      runtime: "bun",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures/mock-registry-usage-agent.ts")],
      env: { MOCK_QUOTA_CONFIG: join(scratch, `${id}.json`) },
      dir: path,
      installedAt: Date.now(),
    }),
  );
}
let current = serve({ dbPath }, 0);
const api = async (method: string, path: string, body?: object) => {
  const response = await fetch(`http://localhost:${current.server.port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify({ path, status: response.status, value }));
  return value;
};
const methods = (id: (typeof ids)[number]) =>
  readFileSync(configs[id].log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; method: string });
const saveConfig = (id: (typeof ids)[number], change: object) => {
  Object.assign(configs[id], change);
  writeFileSync(join(scratch, `${id}.json`), JSON.stringify(configs[id]));
};
const card = async (id: string) =>
  ((await api("GET", "/api/usage")).harnesses as HarnessUsage[]).find((usage) => usage.harness === `reg:${id}`);
async function stop() {
  const { app, server } = current;
  app.orchestrator.shutdown();
  app.host.shutdown();
  app.installer.shutdown();
  app.registry.stop();
  await app.projectTerminals.shutdown();
  server.stop(true);
  app.store.db.close();
}
afterAll(async () => {
  await stop();
  if (previousUsageHome === undefined) delete process.env.TUANTUAN_USAGE_HOME;
  else process.env.TUANTUAN_USAGE_HOME = previousUsageHome;
  if (previousShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = previousShell;
  resetLoginShellEnv();
  rmSync(scratch, { recursive: true, force: true });
});

test("installed cards are cache-only until an explicit operation; login probe reuses one process/session", async () => {
  const overview = (await api("GET", "/api/usage")).harnesses as HarnessUsage[];
  expect(overview.map((x) => x.harness)).toEqual([
    "claude-code",
    "codex",
    "grok",
    "reg:antigravity-acp",
    "reg:zcode-acp",
  ]);
  expect(await card("antigravity-acp")).toMatchObject({ live: true, limits: [], limitsAt: null });
  expect(methods("antigravity-acp")).toEqual([]);
  const missing = await api("POST", "/api/harnesses/reg%3Aantigravity-acp/test");
  expect(missing.loggedIn).toBe(false);
  expect(methods("antigravity-acp").map((x) => x.method)).toEqual(["initialize", "session/new"]);
  expect((await card("antigravity-acp"))?.notes.join(" ")).toContain("登录");
  await api("POST", "/api/usage/reg%3Aantigravity-acp/live");
  expect(methods("antigravity-acp").map((x) => x.method)).toEqual([
    "initialize",
    "session/new",
    "initialize",
    "session/new",
  ]);
  const offset = methods("antigravity-acp").length;
  const login = await api("POST", "/api/harnesses/reg%3Aantigravity-acp/authenticate", { methodId: "fixture-login" });
  expect(login.loggedIn).toBe(true);
  const sync = methods("antigravity-acp").slice(offset);
  expect(sync.map((x) => x.method)).toEqual(["initialize", "authenticate", "session/new", "prompt:/usage"]);
  expect(new Set(sync.map((x) => x.pid)).size).toBe(1);
  expect(await card("antigravity-acp")).toMatchObject({
    plan: "Google AI Pro",
    limits: [{ usedPercent: 9 }, { usedPercent: 0 }, { usedPercent: 1 }, { usedPercent: 18 }],
  });
});

test("only validated local long-operation requests extend the HTTP idle timeout", async () => {
  const timeouts: { request: Request; seconds: number }[] = [];
  const srv = {
    timeout: (request: Request, seconds: number) => timeouts.push({ request, seconds }),
  } as unknown as Parameters<typeof current.app.fetch>[1];
  const request = (path: string, options: RequestInit = {}) =>
    new Request(`http://localhost:${current.server.port}${path}`, { method: "POST", ...options });
  const usagePath = "/api/usage/reg%3Aantigravity-acp/live";
  const harnessPath = "/api/harnesses/reg%3Aantigravity-acp";
  const invalid: [Request, number][] = [
    [request(usagePath, { headers: { origin: "https://untrusted.invalid" } }), 403],
    [request(usagePath, { headers: { host: "untrusted.invalid" } }), 403],
    [request("/api/usage/unknown/live"), 404],
    [request(usagePath, { method: "GET" }), 404],
    [request(`${usagePath}/extra`), 404],
    [request("/api/harnesses/unknown/test"), 404],
    [request(`${harnessPath}/test/extra`), 404],
    [request(`${harnessPath}/authenticate`, { body: "{}" }), 400],
    [request(`${harnessPath}/authenticate`, { body: "not json" }), 400],
    [request("/api/harnesses/unknown/authenticate", { body: '{"methodId":"fixture-login"}' }), 404],
  ];
  for (const [req, status] of invalid) {
    expect((await current.app.fetch(req, srv))?.status).toBe(status);
    expect(timeouts).toHaveLength(0);
  }
  for (const req of [
    request(usagePath),
    request(`${harnessPath}/test`),
    request(`${harnessPath}/authenticate`, { body: '{"methodId":"fixture-login"}' }),
  ]) {
    expect((await current.app.fetch(req, srv))?.status).toBe(200);
    expect(timeouts.at(-1)).toEqual({ request: req, seconds: 0 });
  }
  expect(timeouts).toHaveLength(3);
});

test.skipIf(process.platform === "win32")(
  "slow native quota refresh survives the default HTTP deadline and delayed cleanup EPERM",
  async () => {
    const id = "antigravity-acp";
    const before = methods(id).length;
    saveConfig(id, { usageDelay: 12_500 });
    const realKill = process.kill.bind(process);
    let targetPid: number | undefined;
    let delayedFailure = false;
    const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (targetPid !== undefined && pid === -targetPid && signal === "SIGKILL") {
        delayedFailure = true;
        throw Object.assign(new Error("fixture delayed group signal failure"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
    const started = Date.now();
    const refresh = api("POST", "/api/usage/reg%3Aantigravity-acp/live");
    try {
      const prompted = await until(() =>
        methods(id)
          .slice(before)
          .find((call) => call.method === "prompt:/usage"),
      );
      targetPid = prompted.pid;
      const result = await refresh;
      expect(Date.now() - started).toBeGreaterThan(10_000);
      const usage = (result.harnesses as HarnessUsage[]).find((entry) => entry.harness === `reg:${id}`);
      expect(usage?.plan).toBe("Google AI Pro");
      expect(usage?.limits.map((limit) => limit.usedPercent)).toEqual([9, 0, 1, 18]);
      expect(usage?.notes.join(" ")).not.toContain("查询失败");
      await until(() => delayedFailure);
      await until(() => {
        try {
          realKill(prompted.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          return true;
        }
      });
      expect(await api("GET", "/api/health")).toMatchObject({ ok: true });
      expect(await card(id)).toMatchObject({ plan: "Google AI Pro", limits: usage?.limits });
      const calls = methods(id).slice(before);
      expect(calls.map((call) => call.method)).toEqual(["initialize", "session/new", "prompt:/usage"]);
      expect(new Set(calls.map((call) => call.pid)).size).toBe(1);
    } finally {
      killSpy.mockRestore();
      saveConfig(id, { usageDelay: 0 });
      if (targetPid !== undefined) {
        try {
          realKill(targetPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.warn("Quota fixture cleanup failed", error);
        }
      }
      await Promise.allSettled([refresh]);
    }
  },
  20_000,
);

test("probe initialization failure replaces an existing quota snapshot with public unknown state", async () => {
  const previous = await card("antigravity-acp");
  expect(previous?.limits.length).toBeGreaterThan(0);
  expect(previous?.plan).toBe("Google AI Pro");
  saveConfig("antigravity-acp", { initializeError: true });
  const before = methods("antigravity-acp").length;
  const failure = await api("POST", "/api/harnesses/reg%3Aantigravity-acp/test");
  expect(failure.ok).toBe(false);
  const current = await card("antigravity-acp");
  expect(current?.limits).toEqual([]);
  expect(current?.plan).toBeNull();
  expect(current?.limitsAt).toBeGreaterThanOrEqual(previous?.limitsAt ?? 0);
  expect(current?.notes.join(" ")).toContain("查询失败");
  expect(current?.notes.join(" ")).not.toContain("fixture initialize failure");
  expect(
    methods("antigravity-acp")
      .slice(before)
      .map((x) => x.method),
  ).toEqual(["initialize"]);
  const saved = current?.limitsAt;
  saveConfig("antigravity-acp", { initializeError: false });
  expect((await api("POST", "/api/harnesses/reg%3Aantigravity-acp/test")).loggedIn).toBe(true);
  expect((await card("antigravity-acp"))?.limits.length).toBeGreaterThan(0);
  expect((await card("antigravity-acp"))?.limitsAt).toBeGreaterThanOrEqual(saved ?? 0);
});

test("manual refresh single-flights; failed/unsupported queries clear old values and never call models", async () => {
  const before = methods("antigravity-acp").length;
  await Promise.all(Array.from({ length: 3 }, () => api("POST", "/api/usage/reg%3Aantigravity-acp/live")));
  expect(
    methods("antigravity-acp")
      .slice(before)
      .map((x) => x.method),
  ).toEqual(["initialize", "session/new", "prompt:/usage"]);
  saveConfig("antigravity-acp", { unsupported: true });
  await api("POST", "/api/usage/reg%3Aantigravity-acp/live");
  expect((await card("antigravity-acp"))?.limits).toEqual([]);
  expect((await card("antigravity-acp"))?.notes.join(" ")).toContain("未声明 /usage");
  expect(methods("antigravity-acp").some((x) => x.method === "MODEL_CALL")).toBe(false);
  saveConfig("antigravity-acp", { unsupported: false, quotaError: true });
  await api("POST", "/api/usage/reg%3Aantigravity-acp/live");
  expect((await card("antigravity-acp"))?.limits).toEqual([]);
  expect((await card("antigravity-acp"))?.notes.join(" ")).toContain("查询失败");
}, 15_000);

test("ZCode live uses only account extension, warns about team scope, and caches across restart", async () => {
  await api("POST", "/api/usage/reg%3Azcode-acp/live");
  expect(methods("zcode-acp").map((x) => x.method)).toEqual(["initialize", "account/usage_stats"]);
  expect(await card("zcode-acp")).toMatchObject({ plan: "GLM PRO", limits: [{ usedPercent: 27 }] });
  expect((await card("zcode-acp"))?.notes).toContain(ZCODE_070_NOTE);
  const at = (await card("zcode-acp"))?.limitsAt;
  await stop();
  current = serve({ dbPath }, 0);
  expect((await card("zcode-acp"))?.limitsAt).toBe(at);
  expect(methods("zcode-acp")).toHaveLength(2);
  saveConfig("zcode-acp", { zcode: { glm: { kind: "unavailable" } } });
  await api("POST", "/api/usage/reg%3Azcode-acp/live");
  expect((await card("zcode-acp"))?.limits).toEqual([]);
  expect((await card("zcode-acp"))?.notes.join(" ")).toContain("未知");
  expect((await card("zcode-acp"))?.notes).toContain(ZCODE_070_NOTE);
  expect(existsSync(configs["zcode-acp"].authFile)).toBe(false);
});

test("ZCode login test synchronizes on the same process without any prompt", async () => {
  saveConfig("zcode-acp", {
    zcode: { glm: { kind: "success", level: "GLM PRO", items: [{ key: "week", usedPercent: 30 }] } },
  });
  const before = methods("zcode-acp").length;
  const login = await api("POST", "/api/harnesses/reg%3Azcode-acp/authenticate", { methodId: "fixture-login" });
  expect(login.loggedIn).toBe(true);
  const calls = methods("zcode-acp").slice(before);
  expect(calls.map((x) => x.method)).toEqual(["initialize", "authenticate", "session/new", "account/usage_stats"]);
  expect(new Set(calls.map((x) => x.pid)).size).toBe(1);
  expect((await card("zcode-acp"))?.limits[0]?.usedPercent).toBe(30);
});

test("successful login queues a fresh quota read after an older unauthenticated query", async () => {
  const id = "zcode-acp";
  rmSync(configs[id].authFile, { force: true });
  const gate = join(scratch, "release-old-account-query");
  saveConfig(id, { authSensitive: true, accountGate: gate, delay: 500 });
  const before = methods(id).length;
  const oldQuery = api("POST", "/api/usage/reg%3Azcode-acp/live");
  let login: ReturnType<typeof api> | undefined;
  try {
    await until(() =>
      methods(id)
        .slice(before)
        .some((call) => call.method === "captured:auth_error"),
    );
    login = api("POST", "/api/harnesses/reg%3Azcode-acp/authenticate", { methodId: "fixture-login" });
    // The first read captured the old auth state and cannot finish until login/session-new succeeds.
    await until(() =>
      methods(id)
        .slice(before)
        .some((call) => call.method === "session/new:success"),
    );
    writeFileSync(gate, "release");
    const [, result] = await Promise.all([oldQuery, login]);
    expect(result.loggedIn).toBe(true);
    const calls = methods(id).slice(before);
    expect(calls.filter((call) => call.method === "account/usage_stats")).toHaveLength(2);
    const authPid = calls.find((call) => call.method === "authenticate")?.pid;
    expect(calls.filter((call) => call.method === "account/usage_stats").at(-1)?.pid).toBe(authPid);
    expect(calls.findIndex((call) => call.method === "completed:auth_error")).toBeLessThan(
      calls.findIndex((call) => call.method === "captured:success"),
    );
    expect(await card(id)).toMatchObject({ plan: "GLM PRO", limits: [{ usedPercent: 30 }] });
    expect((await card(id))?.notes.join(" ")).not.toContain("认证已失效");
  } finally {
    writeFileSync(gate, "release");
    await Promise.allSettled([oldQuery, ...(login ? [login] : [])]);
    saveConfig(id, { authSensitive: false, delay: 35 });
  }
});

test("only supported installed/configured registry harnesses get cards", async () => {
  for (const id of ids) rmSync(join(dirname(dbPath), "harnesses/agents", id, "manifest.json"));
  expect(((await api("GET", "/api/usage")).harnesses as HarnessUsage[]).map((x) => x.harness)).toEqual([
    "claude-code",
    "codex",
    "grok",
  ]);
  current.app.store.createAgent(agentInput("ConfiguredZCode", { harness: "reg:zcode-acp" }));
  current.app.store.createAgent(agentInput("OtherRegistry", { harness: "reg:ollama-acp" }));
  expect(((await api("GET", "/api/usage")).harnesses as HarnessUsage[]).map((x) => x.harness)).toEqual([
    "claude-code",
    "codex",
    "grok",
    "reg:zcode-acp",
  ]);
});
