import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { workspaceSlug } from "../shared/workspace";
import type { Store } from "./store";
import { ValidationError } from "./store";

export { workspaceSlug };

export const DRAFTS_PROJECT_ID = "drafts";
export const DRAFTS_NAME = "草稿";

/** Root for auto-created project directories: $TUANTUAN_WORKSPACES, default ~/Tuantuan. */
export function workspacesRoot(): string {
  return expandHome(process.env.TUANTUAN_WORKSPACES?.trim() || "~/Tuantuan");
}

export function expandHome(p: string): string {
  return resolve(p.replace(/^~(?=$|\/)/, homedir()));
}

/** Creates <root>/<slug of name> (adding -2, -3… if taken) and returns its absolute path. */
export function createProjectDir(name: string): string {
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

/** The default 「草稿」 project (<root>/drafts), created on first use. */
export function ensureDrafts(store: Store) {
  const dir = join(workspacesRoot(), "drafts");
  mkdirSync(dir, { recursive: true });
  return store.getProject(DRAFTS_PROJECT_ID) ?? store.createProject(DRAFTS_NAME, dir, DRAFTS_PROJECT_ID);
}

const isEmptyDir = (d: string) => {
  try {
    return !existsSync(d) || (statSync(d).isDirectory() && readdirSync(d).length === 0);
  } catch {
    return false;
  }
};

/**
 * One-time move from per-room directories to projects. Rooms sharing a directory share a project;
 * auto-created folders under the workspaces root become projects named after the room (groups) or
 * the agent (DMs); a 1:1 conversation whose auto folder is still empty goes to 「草稿」.
 * Harness sessions are kept (the directory does not change, except for empty folders).
 */
export function migrateRoomsToProjects(store: Store) {
  const root = workspacesRoot();
  for (const room of store.listRooms()) {
    if (room.projectId) continue;
    const cwd = store.legacyRoomCwd(room.id);
    const rel = cwd ? relative(root, resolve(cwd)) : "";
    const underRoot = !!cwd && !!rel && !rel.startsWith("..") && !isAbsolute(rel);
    if (!cwd || (underRoot && room.kind === "dm" && isEmptyDir(cwd))) {
      store.assignProject(room.id, ensureDrafts(store).id);
      continue;
    }
    const abs = resolve(cwd);
    const same = store.listProjects().find((p) => resolve(p.cwd) === abs);
    if (same) {
      store.assignProject(room.id, same.id);
      continue;
    }
    const agentName = room.agentIds[0] ? store.getAgent(room.agentIds[0])?.name : undefined;
    const name = underRoot ? (room.kind === "dm" ? agentName || basename(abs) : room.name) : basename(abs) || room.name;
    store.assignProject(room.id, store.createProject(name, abs).id);
  }
}
