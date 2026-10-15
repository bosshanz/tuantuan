import { spawn } from "node:child_process";
import { delimiter } from "node:path";

/**
 * GUI apps on macOS start from launchd with a bare PATH and none of the user's shell exports, so
 * harnesses installed by Homebrew / npm / curl scripts and CC Switch style ANTHROPIC_* variables
 * would be invisible. Read them from an interactive login shell once, like a terminal would.
 */
export function loginShellEnv(timeoutMs = 6000): Promise<Record<string, string>> {
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null));
  if (process.platform === "win32") return Promise.resolve(base);
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const marker = "__TUANTUAN_ENV__";
  return new Promise((done) => {
    let out = "";
    const p = spawn(shell, ["-ilc", `printf ${marker}; env -0; printf ${marker}`], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...base, DISABLE_AUTO_UPDATE: "true" },
      detached: false,
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    p.on("error", () => done(base));
    p.on("close", () => {
      clearTimeout(timer);
      const body = out.split(marker)[1];
      if (!body) return done(base);
      const env = { ...base };
      for (const kv of body.split("\0")) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      // Electron's own variables must not leak into the server or harnesses.
      for (const k of Object.keys(env)) if (k.startsWith("ELECTRON_")) delete env[k];
      const home = env.HOME ?? "";
      env.PATH = [...(env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`]
        .filter((d, i, a) => d && a.indexOf(d) === i)
        .join(delimiter);
      done(env);
    });
  });
}
