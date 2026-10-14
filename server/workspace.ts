import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { workspaceRel, workspaceSlug } from "../shared/workspace";
import { ValidationError } from "./store";

export { workspaceRel, workspaceSlug };

/** Root for auto-created room directories: $TUANTUAN_WORKSPACES, default ~/Tuantuan. */
export function workspacesRoot(): string {
  return expandHome(process.env.TUANTUAN_WORKSPACES?.trim() || "~/Tuantuan");
}

export function expandHome(p: string): string {
  return resolve(p.replace(/^~(?=$|\/)/, homedir()));
}

/** Creates <root>/dm/<agent> or <root>/groups/<name> (adding -2, -3… if taken). */
export function createWorkspace(kind: "group" | "dm", name: string, agentName?: string): string {
  const root = workspacesRoot();
  const rel = workspaceRel(kind, name, agentName);
  for (let i = 1; ; i++) {
    const dir = join(root, i === 1 ? rel : `${rel}-${i}`);
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

/**
 * Move an old flat auto-folder (<root>/<slug>) to dm/… or groups/… when it is empty and under the
 * workspaces root. Returns the new path, or the old one if moving would be unsafe.
 */
export function migrateAutoWorkspace(cwd: string, kind: "group" | "dm", name: string, agentName?: string): string {
  const root = workspacesRoot();
  const abs = resolve(cwd);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return abs; // outside root → user-chosen
  if (rel.startsWith("dm/") || rel.startsWith("groups/")) return abs; // already new layout
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return abs;
  try {
    if (readdirSync(abs).length > 0) return abs; // touched → leave
  } catch {
    return abs;
  }
  const dest = createWorkspace(kind, name, agentName);
  try {
    // createWorkspace already made dest; remove it and rename the empty old folder into place.
    rmdirSync(dest);
    mkdirSync(join(dest, ".."), { recursive: true });
    renameSync(abs, dest);
    return dest;
  } catch {
    return abs;
  }
}
