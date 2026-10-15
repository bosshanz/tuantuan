import { spawn } from "node:child_process";
import { maskKey } from "./custom";

export { missingKeyVar } from "../shared/auth";

import { which } from "./harness";

/**
 * Per-harness secrets (ACP `env_var` auth methods, e.g. Z_AI_API_KEY for glm-acp-agent).
 * Stored server-side in the same SQLite file as 服务商 keys, shown masked, and injected only
 * into that harness's own processes (an agent's own 环境变量 still win). Never written to disk elsewhere.
 */
export interface SettingsStore {
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
}

const KEY = "harnessEnv";
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function harnessSecretEnv(store: SettingsStore, harnessId: string): Record<string, string> {
  return { ...(store.getSetting<Record<string, Record<string, string>>>(KEY, {})[harnessId] ?? {}) };
}

/** Masked view for the browser: name → hint. */
export function publicHarnessEnv(store: SettingsStore, harnessId: string): Record<string, string> {
  return Object.fromEntries(Object.entries(harnessSecretEnv(store, harnessId)).map(([k, v]) => [k, maskKey(v)]));
}

/** values: name → new value; "" or null clears it. Unknown names are refused by the caller. */
export function setHarnessEnv(store: SettingsStore, harnessId: string, values: Record<string, string | null>) {
  const all = store.getSetting<Record<string, Record<string, string>>>(KEY, {});
  const cur = { ...(all[harnessId] ?? {}) };
  for (const [k, v] of Object.entries(values)) {
    if (!ENV_NAME.test(k)) throw new Error(`环境变量名不合法：${k}`);
    if (v?.trim()) cur[k] = v.trim();
    else delete cur[k];
  }
  if (Object.keys(cur).length) all[harnessId] = cur;
  else delete all[harnessId];
  store.setSetting(KEY, all);
}

/**
 * How to open a terminal window running `command` (already shell-quoted, absolute paths).
 * macOS: Terminal.app via osascript; Linux: the first terminal emulator found. null = none.
 */
export function terminalLaunch(
  command: string,
  platform: NodeJS.Platform,
  has: (bin: string) => boolean,
): string[] | null {
  if (platform === "darwin") {
    const esc = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return [
      "osascript",
      "-e",
      `tell application "Terminal" to do script "${esc}"`,
      "-e",
      'tell application "Terminal" to activate',
    ];
  }
  if (platform === "linux") {
    // keep the window open after the command so the user can read its output
    const sh = `${command}; echo; read -r -p "按回车关闭" _`;
    if (has("x-terminal-emulator")) return ["x-terminal-emulator", "-e", "bash", "-lc", sh];
    if (has("gnome-terminal")) return ["gnome-terminal", "--", "bash", "-lc", sh];
    if (has("konsole")) return ["konsole", "-e", "bash", "-lc", sh];
    if (has("xfce4-terminal")) return ["xfce4-terminal", "-x", "bash", "-lc", sh];
    if (has("xterm")) return ["xterm", "-e", "bash", "-lc", sh];
  }
  return null;
}

export function openTerminal(command: string, env: Record<string, string>): boolean {
  const argv = terminalLaunch(command, process.platform, (b) => !!which(b, env.PATH ?? process.env.PATH ?? ""));
  if (!argv) return false;
  const [cmd, ...args] = argv as [string, ...string[]];
  spawn(cmd, args, { env, detached: true, stdio: "ignore" }).unref();
  return true;
}
