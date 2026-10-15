import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../server/app";
import "./helpers";

const root = mkdtempSync(join(tmpdir(), "tt-local-boundary-"));
const { app, server } = serve({ dbPath: join(root, "db.sqlite") }, 0);
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  app.host.shutdown();
  app.installer.shutdown();
  app.registry.stop();
  server.stop(true);
  app.store.db.close();
  rmSync(root, { recursive: true, force: true });
});

test("the default listener is loopback and cannot be reached on a non-loopback interface", async () => {
  expect(server.hostname).toBe("127.0.0.1");
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.family === "IPv4");
  for (const address of addresses) {
    let connected = false;
    try {
      await fetch(`http://${address?.address}:${server.port}/api/profile`, { signal: AbortSignal.timeout(1000) });
      connected = true;
    } catch {}
    expect(connected).toBe(false);
  }
});

test("local native API clients and the Vite origin remain accepted", async () => {
  expect((await fetch(`${base}/api/profile`)).status).toBe(200);
  for (const origin of [`http://localhost:${server.port}`, "http://localhost:5173", "http://127.0.0.1:5173"]) {
    expect((await fetch(`${base}/api/profile`, { headers: { origin } })).status).toBe(200);
  }
  // The native MCP bridge sends no Origin; an unknown token reaches its own 404 contract.
  expect((await fetch(`${base}/mcp/unknown`)).status).toBe(404);
});

test("foreign browser sources and rebinding Host headers are refused before API or MCP dispatch", async () => {
  for (const origin of ["https://foreign.example", "http://localhost.foreign.example:5173", "null"]) {
    const response = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { origin, "content-type": "text/plain" },
      body: JSON.stringify({ name: "foreign-marker" }),
    });
    expect(response.status).toBe(403);
    expect((await fetch(`${base}/mcp/unknown`, { headers: { origin } })).status).toBe(403);
  }
  expect((await (await fetch(`${base}/api/profile`)).json()).name).not.toBe("foreign-marker");
  expect((await fetch(`${base}/api/profile`, { headers: { host: "foreign.example" } })).status).toBe(403);
  expect((await fetch(`${base}/api/profile`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
});

async function websocket(origin?: string): Promise<{ accepted: boolean; received?: string }> {
  return new Promise((resolve, reject) => {
    // lib.dom's constructor omits Bun's native-client options when DOM types are enabled.
    const NativeWebSocket = WebSocket as unknown as new (url: string, options?: Bun.WebSocketOptions) => WebSocket;
    const ws = new NativeWebSocket(`ws://127.0.0.1:${server.port}/ws`, origin ? { headers: { origin } } : undefined);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket boundary timed out"));
    }, 1500);
    ws.onopen = () => server.publish("all", "local-boundary-marker");
    ws.onmessage = (event) => {
      clearTimeout(timer);
      ws.close();
      resolve({ accepted: true, received: String(event.data) });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      ws.close();
      resolve({ accepted: false });
    };
  });
}

test("WebSocket upgrades apply the same origin boundary before subscribing to all", async () => {
  expect(await websocket("https://foreign.example")).toEqual({ accepted: false });
  expect(await websocket("http://localhost:5173")).toEqual({ accepted: true, received: "local-boundary-marker" });
  expect(await websocket()).toEqual({ accepted: true, received: "local-boundary-marker" });
});
