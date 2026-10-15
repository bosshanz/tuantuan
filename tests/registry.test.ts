import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeMin, splitPackage } from "../server/managed";
import { platformKey, Registry } from "../server/registry";
import { mockRegistry } from "./fixtures/mock-registry";
import { agentInput } from "./helpers";

describe("registry client", () => {
  test("parses the shipped snapshot offline; malformed entries are skipped, not fatal", async () => {
    const r = new Registry(mkdtempSync(join(tmpdir(), "reg-")), "http://127.0.0.1:9/none.json");
    expect(r.get().source).toBe("snapshot");
    expect(r.get().agents.length).toBeGreaterThan(30);
    expect(r.agent("pi-acp")?.distribution.npx?.package).toMatch(/^pi-acp@/);
    expect(r.agent("zcode-acp")).toMatchObject({ experimental: true });
    const s = await r.refresh();
    expect(s.source).toBe("snapshot");
    expect(s.error).toContain("更新 Registry 失败");
  });

  test("fetch → validated → cached on disk → used on next start; icons cached", async () => {
    const m = mockRegistry();
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    try {
      const r = new Registry(dir, m.url);
      const s = await r.refresh();
      expect(s.source).toBe("network");
      expect(s.invalid).toEqual(["broken"]);
      expect(s.agents.map((a) => a.id)).toContain("mock-bin");
      const again = new Registry(dir, "http://127.0.0.1:9/none.json");
      expect(again.get().source).toBe("cache");
      expect(again.agent("mock-npx")?.version).toBe("1.0.0");
      expect(await r.icon("mock-bin")).toContain("<svg");
      expect(await r.icon("mock-bin")).toContain("<svg");
      expect(m.state.hits.icon).toBe(1);
      expect(await r.icon("../etc")).toBeNull();
    } finally {
      m.stop();
    }
  });

  test("package specs and engines ranges", () => {
    expect(splitPackage("@minimax-ai/code@0.2.7")).toEqual({ name: "@minimax-ai/code", version: "0.2.7" });
    expect(splitPackage("pi-acp@0.0.34")).toEqual({ name: "pi-acp", version: "0.0.34" });
    expect(splitPackage("fast-agent-acp==0.10.1")).toEqual({ name: "fast-agent-acp", version: "0.10.1" });
    expect(nodeMin(">=22.19 <23 || >=24 <27")).toEqual([22, 19, 0]);
    expect(nodeMin("^20.19.0 || ^22.13.0 || >=24")).toEqual([20, 19, 0]);
    expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
    expect(platformKey("win32", "x64")).toBe("windows-x86_64");
  });
});

describe("install from the registry (API)", () => {
  const m = mockRegistry();
  let app: Awaited<ReturnType<typeof import("../server/app").serve>>["app"];
  let server: Awaited<ReturnType<typeof import("../server/app").serve>>["server"];
  const managed = mkdtempSync(join(tmpdir(), "managed-"));
  const api = async <T>(method: string, p: string, b?: unknown) => {
    const r = await fetch(`http://localhost:${server.port}${p}`, {
      method,
      headers: { "content-type": "application/json" },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: r.status, data: (await r.json().catch(() => null)) as T };
  };
  const waitJob = async (hid: string) => {
    for (let i = 0; i < 400; i++) {
      const j = (
        await api<{ state: string; error: string | null; log: string[] }>("GET", `/api/harnesses/${hid}/install`)
      ).data;
      if (j && j.state !== "running") return j;
      await Bun.sleep(100);
    }
    throw new Error("install timeout");
  };
  beforeAll(async () => {
    process.env.TUANTUAN_REGISTRY_URL = m.url;
    process.env.TUANTUAN_HARNESS_DIR = managed;
    process.env.npm_config_registry = m.npm;
    process.env.BUN_CONFIG_REGISTRY = m.npm;
    const { serve } = await import("../server/app");
    ({ app, server } = serve({ dbPath: ":memory:" }, 0));
    await api("POST", "/api/registry/refresh");
  });
  afterAll(() => {
    app.host.shutdown();
    app.installer.shutdown();
    server.stop(true);
    m.stop();
    delete process.env.TUANTUAN_REGISTRY_URL;
    delete process.env.TUANTUAN_HARNESS_DIR;
    delete process.env.npm_config_registry;
    delete process.env.BUN_CONFIG_REGISTRY;
  });

  test("lists registry agents with platform / install info", async () => {
    const r = await api<{ source: string; agents: { id: string; installable: boolean; harnessId: string }[] }>(
      "GET",
      "/api/registry",
    );
    expect(r.data.source).toBe("network");
    expect(r.data.agents.find((a) => a.id === "mock-bin")).toMatchObject({
      installable: true,
      harnessId: "reg:mock-bin",
    });
    const icon = await fetch(`http://localhost:${server.port}/api/registry/icon/mock-bin`);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("binary: download, sha256, extract, handshake, chat, update, uninstall", async () => {
    expect((await api("POST", "/api/registry/install/mock-bin")).status).toBe(202);
    const j = await waitJob("reg:mock-bin");
    expect(j.state).toBe("done");
    expect(j.log.join("\n")).toContain("校验和一致");
    const hs = (await api<{ id: string; source: string; version: string }[]>("GET", "/api/harnesses")).data;
    expect(hs.find((h) => h.id === "reg:mock-bin")).toMatchObject({ source: "managed", version: "1.0.0" });
    const meta = (await api<{ harnesses: { id: string }[] }>("GET", "/api/meta")).data;
    expect(meta.harnesses.map((h) => h.id)).toContain("reg:mock-bin");
    const probe = (await api<{ ok: boolean; agentInfo: { name: string } }>("POST", "/api/harnesses/reg:mock-bin/test"))
      .data;
    expect(probe.ok).toBe(true);

    // an agent on it answers
    const a = (await api<{ id: string }>("POST", "/api/agents", agentInput("RegBot", { harness: "reg:mock-bin" })))
      .data;
    const room = (await api<{ id: string }>("POST", "/api/rooms", { name: "reg", agentIds: [a.id] })).data;
    await api("POST", `/api/rooms/${room.id}/messages`, { senderName: "Andy", content: "hi" });
    await app.orchestrator.idle(room.id);
    const msgs = (
      await api<{ messages: { senderKind: string; status: string; content: string }[] }>(
        "GET",
        `/api/rooms/${room.id}/messages`,
      )
    ).data.messages;
    expect(msgs.at(-1)).toMatchObject({ senderKind: "agent", status: "done" });

    // new registry version → update offered → installs, old version removed
    m.state.version = "1.1.0";
    await api("POST", "/api/registry/refresh");
    const before = (await api<{ id: string; updateAvailable: boolean }[]>("GET", "/api/harnesses")).data;
    expect(before.find((h) => h.id === "reg:mock-bin")?.updateAvailable).toBe(true);
    await api("POST", "/api/registry/install/mock-bin");
    expect((await waitJob("reg:mock-bin")).state).toBe("done");
    expect(readdirSync(join(managed, "agents", "mock-bin")).sort()).toEqual(["1.1.0", "manifest.json"]);

    expect((await api("DELETE", "/api/harnesses/reg:mock-bin/managed")).status).toBe(200);
    expect(existsSync(join(managed, "agents", "mock-bin"))).toBe(false);
    m.state.version = "1.0.0";
    await api("POST", "/api/registry/refresh");
  }, 60_000);

  test("binary with a wrong checksum is refused and leaves nothing behind", async () => {
    m.state.badSha = true;
    await api("POST", "/api/registry/refresh");
    await api("POST", "/api/registry/install/mock-bin");
    const j = await waitJob("reg:mock-bin");
    expect(j.state).toBe("error");
    expect(j.error).toContain("校验和不匹配");
    expect(existsSync(join(managed, "agents", "mock-bin", "manifest.json"))).toBe(false);
    m.state.badSha = false;
    await api("POST", "/api/registry/refresh");
  });

  test("npx: npm package into the managed dir (no global), run with Bun, registry env applied", async () => {
    await api("POST", "/api/registry/install/mock-npx");
    const j = await waitJob("reg:mock-npx");
    if (j.state !== "done") console.log(j.log.join("\n"));
    expect(j.state).toBe("done");
    const h = (
      await api<{ id: string; command: string; args: string[]; env: Record<string, string> }[]>("GET", "/api/harnesses")
    ).data.find((x) => x.id === "reg:mock-npx");
    expect(h?.command).toBe(process.execPath);
    expect(h?.args[0]).toStartWith(join(managed, "agents", "mock-npx", "1.0.0", "node_modules", "mock-npx-acp"));
    expect(h?.env).toEqual({ MOCK_FROM_REGISTRY: "1" });
    const probe = (await api<{ ok: boolean }>("POST", "/api/harnesses/reg:mock-npx/test")).data;
    expect(probe.ok).toBe(true);
  }, 60_000);

  test("unknown / unsupported entries are refused", async () => {
    expect((await api("POST", "/api/registry/install/nope")).status).toBe(404);
  });
});
