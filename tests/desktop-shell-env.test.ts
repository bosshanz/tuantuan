import { describe, expect, test } from "bun:test";
import { fallbackPathDirs, loginShellEnv, withFallbackPath } from "../desktop/src/shell-env";

describe("desktop login shell env", () => {
  test("GUI launch PATH gains the usual harness install dirs, without duplicates", () => {
    const env = withFallbackPath({ HOME: "/Users/a", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    const dirs = env.PATH?.split(":") ?? [];
    for (const d of ["/opt/homebrew/bin", "/usr/local/bin", "/Users/a/.local/bin", "/Users/a/.bun/bin"])
      expect(dirs).toContain(d);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs[0]).toBe("/usr/bin");
  });

  test("a broken login shell still yields the fallback PATH", async () => {
    const saved = process.env.SHELL;
    process.env.SHELL = "/nonexistent/shell";
    try {
      const env = await loginShellEnv(1000);
      for (const d of fallbackPathDirs(env.HOME ?? "")) expect(env.PATH?.split(":")).toContain(d);
    } finally {
      process.env.SHELL = saved;
    }
  });
});
