import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gitEnvironment } from "./git-environment";
import { type Room, ValidationError } from "./store";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], {
    env: gitEnvironment,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  return result.stdout.replace(/\r?\n$/, "");
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Validate the linked worktree and each directory between its root and the conversation cwd. */
export function validateRoomWorktree(room: Pick<Room, "cwd" | "worktree">): void {
  if (!room.worktree) return;
  try {
    const root = resolve(room.worktree.root);
    const cwd = resolve(room.cwd);
    if (!within(root, cwd) || realpathSync(root) !== root || !lstatSync(root).isDirectory())
      throw new Error("invalid worktree root");
    let current = root;
    for (const part of relative(root, cwd).split(sep).filter(Boolean)) {
      current = join(current, part);
      if (!lstatSync(current).isDirectory()) throw new Error("invalid worktree directory");
    }
    const dotGit = join(root, ".git");
    if (!lstatSync(dotGit).isFile()) throw new Error("missing worktree link");
    const match = /^gitdir: (.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match?.[1]) throw new Error("invalid worktree link");
    const metadata = resolve(root, match[1].trim());
    const backlink = readFileSync(join(metadata, "gitdir"), "utf8").trim();
    if (realpathSync(resolve(metadata, backlink)) !== realpathSync(dotGit))
      throw new Error("invalid worktree registration");
    if (!within(realpathSync(root), realpathSync(cwd))) throw new Error("directory escaped worktree");
  } catch {
    throw new ValidationError("会话的 Git worktree 不存在或已失效，请恢复原目录后重试", 409);
  }
}

export interface CreatedWorktree {
  root: string;
  branch: string;
  cwd: string;
  /** Remove only this checkout if it remains clean, then delete its branch if Git permits it. */
  cleanup(): Promise<boolean>;
}

export async function createRoomWorktree(projectCwd: string, dataDir: string): Promise<CreatedWorktree> {
  let source: string;
  let scope: string;
  let commit: string;
  try {
    const cwd = realpathSync(projectCwd);
    source = realpathSync(await git(cwd, ["rev-parse", "--show-toplevel"]));
    scope = relative(source, cwd);
    if (!within(source, cwd)) throw new Error("invalid project directory");
    commit = await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error("invalid HEAD");
  } catch {
    throw new ValidationError("项目必须位于包含至少一次提交的 Git 仓库中");
  }
  mkdirSync(dataDir, { recursive: true });
  const canonicalData = realpathSync(dataDir);
  const parent = within(source, canonicalData)
    ? join(dirname(source), `${basename(source)}.tuantuan-worktrees`)
    : join(canonicalData, "worktrees");
  if (within(source, resolve(parent))) throw new ValidationError("worktree 目录必须位于项目仓库之外");
  mkdirSync(parent, { recursive: true });
  const canonicalParent = realpathSync(parent);
  if (within(source, canonicalParent)) throw new ValidationError("worktree 目录必须位于项目仓库之外");
  const id = crypto.randomUUID();
  const root = join(canonicalParent, id);
  const branch = `tuantuan/${id}`;
  const branchRef = `refs/heads/${branch}`;
  const cwd = join(root, scope);
  const cleanup = async (): Promise<boolean> => {
    try {
      // A hook may have created commits or changed branches even when the worktree is clean.
      // Only the registered checkout on the generated branch at the original HEAD is ours to remove.
      validateRoomWorktree({ cwd: root, worktree: { root, branch } });
      const sourceCommon = realpathSync(resolve(source, await git(source, ["rev-parse", "--git-common-dir"])));
      const checkoutCommon = realpathSync(resolve(root, await git(root, ["rev-parse", "--git-common-dir"])));
      if (sourceCommon !== checkoutCommon) return false;
      if ((await git(root, ["symbolic-ref", "--quiet", "HEAD"])) !== branchRef) return false;
      if ((await git(root, ["rev-parse", "--verify", "HEAD"])) !== commit) return false;
      if ((await git(source, ["rev-parse", "--verify", branchRef])) !== commit) return false;
      // `git worktree remove` can discard ignored files, so treat those as user data too.
      const changes = await git(root, ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all"]);
      if (changes) return false;
      await git(source, ["worktree", "remove", "--", root]);
      // Delete only if the generated branch still points at the same commit.
      await git(source, ["update-ref", "-d", branchRef, commit]);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await git(source, ["worktree", "add", "-b", branch, "--", root, commit]);
    validateRoomWorktree({ cwd, worktree: { root, branch } });
    return { root, branch, cwd, cleanup };
  } catch (error) {
    // Git can return nonzero after it has registered and checked out the worktree.
    const cleaned = await cleanup();
    const detail = error instanceof Error ? error.message : String(error);
    const recovery = cleaned ? "" : `；如有残留，请检查 ${root} 与分支 ${branch}`;
    throw new ValidationError(`无法创建会话 worktree：${detail.slice(0, 500)}${recovery}`);
  }
}
