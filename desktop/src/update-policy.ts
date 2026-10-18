import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DesktopUpdateStatus } from "../../shared/desktopUpdate";

type Policy = Pick<DesktopUpdateStatus, "mode" | "reason">;
export function updatePolicy(input: {
  packaged: boolean;
  disabled: boolean;
  platform: string;
  homebrew: boolean;
  signedMac: boolean;
  feed: boolean;
  appImage: boolean;
}): Policy {
  if (!input.packaged) return { mode: "disabled", reason: "development" };
  if (input.disabled) return { mode: "disabled", reason: "disabled" };
  if (input.homebrew) return { mode: "manual", reason: "homebrew" };
  if (input.platform === "darwin" && !input.signedMac) return { mode: "manual", reason: "unsigned-mac" };
  if (!input.feed || (input.platform === "linux" && !input.appImage)) return { mode: "manual", reason: "missing-feed" };
  return { mode: "automatic" };
}

/** A cask's symlink identifies the actual app, without invoking brew or changing it. */
export function isHomebrewApp(executable: string): boolean {
  let realExecutable: string;
  try {
    realExecutable = realpathSync(executable);
  } catch {
    return false;
  }
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    const root = join(prefix, "Caskroom", "tuantuan");
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root).filter((name) => !name.startsWith("."))) {
      try {
        if (realpathSync(join(root, version, "tuantuan.app", "Contents", "MacOS", "tuantuan")) === realExecutable)
          return true;
      } catch {
        /* Other installed cask versions may already have been removed. */
      }
    }
  }
  return false;
}

/** Ad-hoc signatures do not establish the identity continuity needed by Squirrel.Mac. */
export function hasMacUpdateIdentity(executable: string): boolean {
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", executable], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return (
    result.status === 0 &&
    /Authority=Developer ID Application:/.test(result.stderr) &&
    /TeamIdentifier=(?!not set)[A-Z0-9]+/.test(result.stderr)
  );
}
