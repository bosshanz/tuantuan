import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import type { Agent, Message, Project, Room } from "../server/store";
import { agentInput, WORKSPACES } from "./helpers";

const { app, server } = serve({ dbPath: ":memory:" }, 0);
const base = `http://localhost:${server.port}`;
afterAll(() => {
  app.host.shutdown();
  server.stop(true);
});
async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json()) as T };
}
type P = { id: string; keyHint: string; usedBy: string[]; updatedAt: number; apiKey?: string };

test("providers API: create masked, edit keeps key, assign, delete falls back to 本机配置", async () => {
  const bad = await api<{ error: string }>("POST", "/api/providers", { name: "x" });
  expect(bad.status).toBe(400);
  const c = await api<P>("POST", "/api/providers", {
    name: "DS",
    preset: "deepseek",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    openaiBaseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-top-secret-9876",
  });
  expect(c.status).toBe(201);
  expect(JSON.stringify(c.data)).not.toContain("sk-top-secret");
  expect(c.data.keyHint).toContain("9876");

  // a provider can only be used by harnesses it supports
  const mockAgent = await api<{ error: string }>("POST", "/api/agents", agentInput("M", { providerId: c.data.id }));
  expect(mockAgent.status).toBe(400);
  const cc = await api<Agent>(
    "POST",
    "/api/agents",
    agentInput("CC", { harness: "claude-code", providerId: c.data.id }),
  );
  expect(cc.status).toBe(201);
  expect(cc.data.providerId).toBe(c.data.id);
  const byok = await api<Agent>("POST", "/api/agents", agentInput("BY", { harness: "custom", providerId: c.data.id }));
  expect(byok.status).toBe(201);

  await Bun.sleep(5);
  const e = await api<P>("PUT", `/api/providers/${c.data.id}`, {
    name: "DS2",
    preset: "deepseek",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    openaiBaseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
  });
  expect(e.data.keyHint).toBe(c.data.keyHint);
  expect(e.data.updatedAt).toBeGreaterThan(c.data.updatedAt);
  expect(e.data.usedBy.sort()).toEqual(["BY", "CC"]);
  expect(app.store.getProvider(c.data.id)?.apiKey).toBe("sk-top-secret-9876");

  const list = await api<{ items: P[]; presets: unknown[] }>("GET", "/api/providers");
  expect(list.data.items).toHaveLength(1);
  expect(list.data.presets.length).toBeGreaterThan(5);
  expect(JSON.stringify(list.data)).not.toContain("sk-top-secret");

  expect((await api("DELETE", `/api/providers/${c.data.id}`)).status).toBe(200);
  const after = (await api<Agent[]>("GET", "/api/agents")).data.find((x) => x.id === cc.data.id);
  expect(after?.providerId).toBeNull();
});

test("usage API: per-turn ACP usage is logged; OpenCode has no quota placeholder, Grok offers billing refresh", async () => {
  const a = await api<Agent>("POST", "/api/agents", agentInput("U"));
  const pj = await api<Project>("POST", "/api/projects", { name: "u", cwd: WORKSPACES });
  const room = await api<Room>("POST", "/api/rooms", { name: "u", agentIds: [a.data.id], projectId: pj.data.id });
  await api<Message>("POST", `/api/rooms/${room.data.id}/messages`, { senderName: "Andy", content: "hi" });
  await app.orchestrator.idle(room.data.id);
  const u = await api<{
    harnesses: { harness: string; notes: string[]; limits: unknown[] }[];
    tuantuan: { harness: string; turns: number; total: number }[];
  }>("GET", "/api/usage");
  expect(u.data.tuantuan).toContainEqual(expect.objectContaining({ harness: "mock", turns: 1, total: 1494 }));
  expect(u.data.harnesses.find((x) => x.harness === "grok")?.notes).toContain("额度：点刷新向 Grok 查询");
  expect(u.data.harnesses.map((x) => x.harness)).toEqual(["claude-code", "codex", "grok"]);
});

test("Grok live quota uses only initialize and the read-only billing extension; failures stay unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-billing-test-"));
  const bin = join(dir, "grok");
  const calls = join(dir, "calls");
  const fail = join(dir, "fail");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('grok 1.0.52'); process.exit(0); }
if (process.argv[2] === 'usage') { console.log('{"turns":[]}'); process.exit(0); }
for await (const line of createInterface({input:process.stdin})) {
  const r = JSON.parse(line);
  appendFileSync(${JSON.stringify(calls)}, r.method + '\\n');
  if (r.id === undefined) continue;
  let result;
  if (r.method === 'initialize') result = { protocolVersion:1,agentCapabilities:{},authMethods:[] };
  else if (r.method === '_x.ai/billing' && !existsSync(${JSON.stringify(fail)}))
    result = { config:{creditUsagePercent:42,currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEKLY',end:'2026-10-22T01:00:00Z'},prepaidBalance:{val:1250}},subscription_tier:'SuperGrok' };
  else { console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Method not found'}})); continue; }
  console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
}
`,
    { mode: 0o755 },
  );
  const previous = app.store.getSetting<Record<string, string>>("harnessPaths", {});
  app.store.setSetting("harnessPaths", { ...previous, grok: bin });
  try {
    type Row = {
      harness: string;
      limits: unknown[];
      plan: string | null;
      creditBalanceUsd: number | null;
      notes: string[];
    };
    const first = await api<{ harnesses: Row[] }>("POST", "/api/usage/grok/live");
    expect(first.status).toBe(200);
    expect(first.data.harnesses.find((x) => x.harness === "grok")).toMatchObject({
      limits: [{ label: "每周额度", usedPercent: 42, resetsAt: "2026-10-22T01:00:00Z" }],
      plan: "SuperGrok",
      creditBalanceUsd: 12.5,
    });
    writeFileSync(fail, "1");
    const second = await api<{ harnesses: Row[] }>("POST", "/api/usage/grok/live");
    expect(second.data.harnesses.find((x) => x.harness === "grok")).toMatchObject({
      limits: [],
      plan: null,
      creditBalanceUsd: null,
      notes: expect.arrayContaining(["当前 Grok 版本不支持额度查询，请更新 Grok"]),
    });
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      "initialize",
      "_x.ai/billing",
      "initialize",
      "_x.ai/billing",
    ]);
  } finally {
    app.store.setSetting("harnessPaths", previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage stats: per-turn tokens with model, cache split and cost delta; grouped and daily", async () => {
  const a = await api<Agent>("POST", "/api/agents", agentInput("S"));
  const room = await api<Room>("POST", "/api/rooms", { name: "s", agentIds: [a.data.id] });
  for (const t of ["hi", "hi"]) {
    await api<Message>("POST", `/api/rooms/${room.data.id}/messages`, { senderName: "Andy", content: t });
    await app.orchestrator.idle(room.data.id);
  }
  type T = {
    key: string | null;
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    thought: number;
    total: number;
    cost: number | null;
  };
  const s = await api<{
    totals: T;
    byAgent: T[];
    byModel: T[];
    byHarness: T[];
    daily: { day: string; total: number }[];
    reporting: string[];
  }>("GET", "/api/usage/stats?since=0&tz=480");
  const mine = s.data.byAgent.find((x) => x.key === a.data.id);
  // mock-fast: input 800 + 4/char, output 150 + 2/char of the reply, cache 400 read / 100 write, 50 thought
  expect(mine).toMatchObject({
    turns: 2,
    input: 1616,
    output: 372,
    cacheRead: 800,
    cacheWrite: 200,
    thought: 100,
    total: 2988,
  });
  // cost: the session-cumulative usage_update cost, differenced per turn
  expect(mine?.cost).toBeCloseTo(0.0024, 6);
  expect(s.data.byModel.find((x) => x.key === "mock-fast")?.turns).toBeGreaterThanOrEqual(2);
  expect(s.data.byHarness.map((x) => x.key)).toContain("mock");
  expect(s.data.reporting).toEqual(["mock"]);
  expect(s.data.daily.at(-1)?.total).toBe(s.data.totals.total);
  const none = await api<{ totals: T }>("GET", `/api/usage/stats?since=${Date.now() + 60_000}`);
  expect(none.data.totals.turns).toBe(0);
});
