import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SERVER_ROUTES } from "../server/routes";
import viteConfig from "../vite.config";

describe("Vite dev proxy covers every server route", () => {
  const app = readFileSync("server/app.ts", "utf8");
  const handled = [
    ...[...app.matchAll(/url\.pathname === "(\/[a-z-]+)"\)/g)].map((m) => m[1]),
    ...[...app.matchAll(/url\.pathname\.startsWith\("(\/[a-z-]+)\//g)].map((m) => m[1]),
  ];
  test("server/routes.ts lists exactly the paths server/app.ts handles", () => {
    expect(handled.length).toBeGreaterThan(0);
    // Several handlers can share one proxy prefix (for example /ws and /ws/terminal/:id).
    expect([...new Set(handled)].sort()).toEqual([...SERVER_ROUTES.http, ...SERVER_ROUTES.ws].sort());
  });
  test("vite.config.ts proxies all of them, with ws for socket routes", () => {
    const proxy = (viteConfig as { server: { proxy: Record<string, string | { ws?: boolean }> } }).server.proxy;
    for (const p of SERVER_ROUTES.http) expect(proxy[p]).toBeDefined();
    for (const p of SERVER_ROUTES.ws) expect((proxy[p] as { ws?: boolean }).ws).toBe(true);
  });
});
