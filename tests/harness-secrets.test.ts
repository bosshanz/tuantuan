import { describe, expect, test } from "bun:test";
import {
  harnessSecretEnv,
  missingKeyVar,
  publicHarnessEnv,
  setHarnessEnv,
  terminalLaunch,
} from "../server/harness-secrets";

describe("harness secrets & terminal login", () => {
  test("osascript runs the exact command in Terminal.app (quotes escaped)", () => {
    const cmd = `env A=1 '/Users/a b/Library/Application Support/团团/harnesses/node/bin/node' "/x/glm.js" --setup`;
    const argv = terminalLaunch(cmd, "darwin", () => false) ?? [];
    expect(argv[0]).toBe("osascript");
    expect(argv[2]).toBe(
      `tell application "Terminal" to do script "env A=1 '/Users/a b/Library/Application Support/团团/harnesses/node/bin/node' \\"/x/glm.js\\" --setup"`,
    );
    expect(argv[4]).toBe('tell application "Terminal" to activate');
  });
  test("Linux: first terminal emulator found; none → null (UI falls back to copy)", () => {
    expect(terminalLaunch("pi", "linux", (b) => b === "gnome-terminal")?.slice(0, 4)).toEqual([
      "gnome-terminal",
      "--",
      "bash",
      "-lc",
    ]);
    expect(terminalLaunch("pi", "linux", (b) => b === "x-terminal-emulator" || b === "xterm")?.[0]).toBe(
      "x-terminal-emulator",
    );
    expect(terminalLaunch("pi", "linux", () => false)).toBeNull();
    expect(terminalLaunch("pi", "win32", () => true)).toBeNull();
  });
  test("recognizes missing-key errors and the variable name", () => {
    expect(
      missingKeyVar(
        "[error] No API key found. Set the Z_AI_API_KEY environment variable, or run glm-acp-agent --setup",
      ),
    ).toBe("Z_AI_API_KEY");
    expect(missingKeyVar("OPENAI_API_KEY is missing; api key required")).toBe("OPENAI_API_KEY");
    expect(missingKeyVar("Authentication required")).toBeNull();
  });
  test("stored per harness, masked, cleared", () => {
    const m = new Map<string, unknown>();
    const store = {
      getSetting: <T>(k: string, f: T) => (m.get(k) as T) ?? f,
      setSetting: (k: string, v: unknown) => void m.set(k, v),
    };
    setHarnessEnv(store, "reg:glm", { Z_AI_API_KEY: " zk-123456789 " });
    expect(harnessSecretEnv(store, "reg:glm")).toEqual({ Z_AI_API_KEY: "zk-123456789" });
    expect(harnessSecretEnv(store, "codex")).toEqual({});
    expect(publicHarnessEnv(store, "reg:glm")).toEqual({ Z_AI_API_KEY: "zk-••••6789" });
    setHarnessEnv(store, "reg:glm", { Z_AI_API_KEY: "" });
    expect(harnessSecretEnv(store, "reg:glm")).toEqual({});
    expect(() => setHarnessEnv(store, "x", { "A-B": "1" })).toThrow();
  });
});
