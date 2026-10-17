import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter } from "node:path";

/** Install locations harness CLIs commonly use that a login profile may not export (or when the shell fails). */
export function fallbackPathDirs(home: string): string[] {
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    `${home}/.grok/bin`,
    `${home}/.opencode/bin`,
    `${home}/.claude/local`,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

export function withFallbackPath(env: Record<string, string>): Record<string, string> {
  const home = env.HOME || homedir();
  const PATH = [...(env.PATH ?? "").split(delimiter), ...fallbackPathDirs(home)]
    .filter((d, i, a) => d && a.indexOf(d) === i)
    .join(delimiter);
  return { ...env, PATH };
}

/**
 * GUI apps on macOS start from launchd with a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) and none of the
 * user's shell exports, so harnesses installed by Homebrew / npm / curl scripts and CC Switch style
 * ANTHROPIC_* variables would be invisible. Read them from an interactive login shell once, like a
 * terminal would; if that shell fails or hangs, still add the common install directories.
 */
export function loginShellEnv(timeoutMs = 6000): Promise<Record<string, string>> {
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null));
  if (process.platform === "win32") return Promise.resolve(base);
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const marker = "__TUANTUAN_ENV__";
  const clean = (env: Record<string, string>) => {
    // Electron's own variables must not leak into the server or harnesses.
    for (const k of Object.keys(env)) if (k.startsWith("ELECTRON_")) delete env[k];
    return withFallbackPath(env);
  };
  return new Promise((done) => {
    let out = "";
    let settled = false;
    const finish = (env: Record<string, string>) => {
      if (settled) return;
      settled = true;
      done(clean(env));
    };
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(shell, ["-ilc", `printf ${marker}; env -0; printf ${marker}`], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...base, DISABLE_AUTO_UPDATE: "true" },
        detached: false,
      });
    } catch {
      finish({ ...base });
      return;
    }
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    p.on("error", () => {
      clearTimeout(timer);
      finish({ ...base });
    });
    p.on("close", () => {
      clearTimeout(timer);
      const body = out.split(marker)[1];
      if (!body) return finish({ ...base });
      const env = { ...base };
      for (const kv of body.split("\0")) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      finish(env);
    });
  });
}
