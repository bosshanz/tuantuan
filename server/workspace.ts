import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { workspaceSlug } from "../shared/workspace";
import { ValidationError } from "./store";

/** Root for auto-created room directories: $TUANTUAN_WORKSPACES, default ~/Tuantuan. */
export function workspacesRoot(): string {
  return expandHome(process.env.TUANTUAN_WORKSPACES?.trim() || "~/Tuantuan");
}

export function expandHome(p: string): string {
  return resolve(p.replace(/^~(?=$|\/)/, homedir()));
}

/** Creates <root>/<slug of name> (adding -2, -3… if taken) and returns its absolute path. */
export function createWorkspace(name: string): string {
  const root = workspacesRoot();
  const base = workspaceSlug(name);
  for (let i = 1; ; i++) {
    const dir = join(root, i === 1 ? base : `${base}-${i}`);
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/** A folder the user picked: must already exist. Returns the absolute path. */
export function existingFolder(p: string): string {
  const raw = p.trim();
  if (!raw.startsWith("~") && !isAbsolute(raw)) throw new ValidationError("请填写绝对路径");
  const dir = expandHome(raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ValidationError(`文件夹不存在：${dir}`);
  return dir;
}
