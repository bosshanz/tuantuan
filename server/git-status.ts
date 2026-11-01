import { execFile } from "node:child_process";
import { closeSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GitStatusDetailResponse, GitStatusItem, GitStatusResponse, GitStatusSection } from "../shared/gitStatus";
import { openCheckedFile } from "./conversation-files";
import type { Room, Store } from "./store";

const exec = promisify(execFile);
const DIFF_MAX_BYTES = 1024 * 1024;
const LIST_MAX_BYTES = 16 * 1024 * 1024;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
};
// Never allow the surrounding process to redirect Git to an unrelated repository or index.
for (const key of Object.keys(env)) {
  if (
    /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT)$/.test(
      key,
    ) ||
    /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)
  )
    delete env[key];
}

async function git(
  cwd: string,
  args: string[],
  maxBuffer = DIFF_MAX_BYTES,
  safeOptions: string[] = [],
): Promise<string> {
  const result = await exec(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      ...safeOptions,
      "-C",
      cwd,
      ...args,
    ],
    {
      env,
      encoding: "buffer",
      maxBuffer,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new Error("Git 输出不是有效 UTF-8，无法安全展示");
  }
}

function message(error: unknown): string {
  const e = error as { code?: string | number; stderr?: string | Buffer; message?: string };
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "Git 输出超过大小限制";
  if (e.code === "ENOENT") return "无法运行 Git";
  return (e.stderr?.toString().trim() || e.message || "Git 操作失败").slice(0, 1000);
}

function trimNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function within(root: string, path: string): boolean {
  const p = relative(root, path);
  return p !== ".." && !p.startsWith(`..${sep}`) && !isAbsolute(p);
}

function strictlyInside(root: string, path: string): boolean {
  const p = relative(root, path);
  return p !== "" && p !== ".." && !p.startsWith(`..${sep}`) && !isAbsolute(p);
}

async function configuredFilterDrivers(cwd: string): Promise<Set<string>> {
  let config = "";
  try {
    config = await git(cwd, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"]);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  const drivers = new Set<string>();
  for (const key of config.split("\0")) {
    const match = /^filter\.(.*)\.(?:clean|process)$/.exec(key);
    if (match?.[1]) drivers.add(match[1]);
  }
  return drivers;
}

async function verifyNoCleanFilters(root: string, drivers: Set<string>, allPaths: string[]): Promise<string[]> {
  if (!drivers.size) return [];
  const safeOptions = [...drivers].flatMap((name) => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`]);
  if (!allPaths.length) return safeOptions;
  // check-attr accepts filenames as literal argv values after --; bound each batch.
  for (let i = 0; i < allPaths.length; ) {
    const batch: string[] = [];
    let size = 0;
    while (i < allPaths.length && batch.length < 100) {
      const path = allPaths[i];
      if (path === undefined) break;
      if (batch.length && size + path.length > 24_000) break;
      batch.push(path);
      size += path.length;
      i++;
    }
    const result = (await git(root, ["check-attr", "-z", "filter", "--", ...batch], LIST_MAX_BYTES)).split("\0");
    for (let j = 0; j + 2 < result.length; j += 3) {
      const driver = result[j + 2];
      if (driver && drivers.has(driver))
        throw new Error("当前目录的文件使用 Git clean filter，无法在不运行外部程序的情况下读取状态");
    }
  }
  return safeOptions;
}

/** Refuse configured clean filters on tracked paths instead of executing them or
 * presenting a patch produced with different conversion semantics. Git config includes
 * and all attribute sources are resolved by Git itself. Submodule status is also refused:
 * its own configuration could execute filters and is outside the parent repository. */
async function prepareReadOnlyGit(cwd: string, root: string): Promise<string[]> {
  const [entriesRaw, drivers] = await Promise.all([
    git(cwd, ["ls-files", "--stage", "--full-name", "-z", "--", "."], LIST_MAX_BYTES),
    configuredFilterDrivers(cwd),
  ]);
  const entries = entriesRaw.split("\0").filter(Boolean);
  const paths = new Set<string>();
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Git 索引格式无效");
    if (entry.startsWith("160000 ")) throw new Error("当前目录包含 Git 子模块，暂不支持安全读取状态");
    paths.add(entry.slice(tab + 1));
  }
  return verifyNoCleanFilters(root, drivers, [...paths]);
}

async function prepareReadOnlyGitForPath(cwd: string, root: string, path: string): Promise<string[]> {
  const literalPath = `:(literal)${path}`;
  const [entriesRaw, drivers] = await Promise.all([
    git(root, ["ls-files", "--stage", "--full-name", "-z", "--", literalPath], DIFF_MAX_BYTES),
    configuredFilterDrivers(cwd),
  ]);
  const tracked: string[] = [];
  for (const entry of entriesRaw.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Git 索引格式无效");
    if (entry.startsWith("160000 ")) throw new Error("当前目录包含 Git 子模块，暂不支持安全读取状态");
    tracked.push(entry.slice(tab + 1));
  }
  return verifyNoCleanFilters(root, drivers, tracked);
}

function parsePorcelainItems(raw: string, root: string): GitStatusItem[] {
  const items: GitStatusItem[] = [];
  const resolvedRoot = resolve(root);
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Git 状态格式无效");
    const path = entry.slice(3);
    if (!within(resolvedRoot, resolve(resolvedRoot, path)) || path === "") throw new Error("Git 返回了无效路径");
    const untracked = entry.slice(0, 2) === "??";
    items.push({
      path,
      staged: untracked || entry[0] === " " ? null : (entry[0] ?? null),
      unstaged: untracked || entry[1] === " " ? null : (entry[1] ?? null),
      untracked,
    });
  }
  return items;
}

async function resolveRepoScope(cwd: string): Promise<{ root: string; scope: string }> {
  const rev = trimNewline(await git(cwd, ["rev-parse", "--show-toplevel", "--show-prefix"]));
  const newline = rev.indexOf("\n");
  const root = (newline < 0 ? rev : rev.slice(0, newline)).replace(/\r$/, "");
  const prefix = newline < 0 ? "" : rev.slice(newline + 1).replace(/\r$/, "");
  const scope = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return { root, scope };
}

interface Snapshot {
  response: GitStatusResponse;
  cwd: string;
  safeOptions?: string[];
}

async function snapshot(room: Room): Promise<Snapshot> {
  const cwd = room.cwd;
  let root: string;
  let scope: string;
  try {
    ({ root, scope } = await resolveRepoScope(cwd));
  } catch (error) {
    const reason = message(error);
    return {
      cwd,
      response: {
        state: reason.includes("not a git repository") ? "not-repository" : "error",
        items: [],
        error: reason,
      },
    };
  }
  try {
    const safeOptions = await prepareReadOnlyGit(cwd, root);
    // -z forces root-relative paths, even when Git is run in a subdirectory.
    // --no-renames ensures both sides of a move appear independently in the scope.
    const raw = await git(
      cwd,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all", "--", "."],
      LIST_MAX_BYTES,
      safeOptions,
    );
    const items = parsePorcelainItems(raw, root);
    let state: "ready" | "unborn" = "ready";
    try {
      await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    } catch (error) {
      // --quiet returns 1 for an absent/unborn HEAD; other failures are real errors.
      if ((error as { code?: unknown }).code !== 1) throw error;
      state = "unborn";
    }
    return { cwd, safeOptions, response: { state, root, scope, items } };
  } catch (error) {
    return { cwd, response: { state: "error", root, items: [], error: message(error) } };
  }
}

export async function handleGitStatus(store: Store, roomId: string): Promise<Response> {
  const room = store.getRoom(roomId);
  if (!room) return Response.json({ error: "会话不存在" }, { status: 404 });
  return Response.json((await snapshot(room)).response);
}

function untrackedDetail(room: Room, root: string, path: string, section: GitStatusSection): GitStatusDetailResponse {
  const base = { path, section };
  let fd: number | undefined;
  try {
    const absolute = resolve(root, path);
    // openCheckedFile checks canonical parent paths, file identity and O_NOFOLLOW.
    const opened = openCheckedFile(room, relative(realpathSync(room.cwd), absolute));
    fd = opened.fd;
    if (opened.size > DIFF_MAX_BYTES) return { ...base, state: "too-large" };
    const bytes = Buffer.alloc(DIFF_MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset > DIFF_MAX_BYTES) return { ...base, state: "too-large" };
    const data = bytes.subarray(0, offset);
    if (data.includes(0)) return { ...base, state: "binary" };
    const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return { ...base, state: "text", content };
  } catch {
    return { ...base, state: "unavailable", reason: "文件不可读取或已变化" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function handleGitStatusDetail(store: Store, roomId: string, url: URL): Promise<Response> {
  const room = store.getRoom(roomId);
  if (!room) return Response.json({ error: "会话不存在" }, { status: 404 });
  const path = url.searchParams.get("path");
  const section = url.searchParams.get("section");
  if (
    !path ||
    path.length > 8192 ||
    path.includes("\0") ||
    (section !== "staged" && section !== "unstaged" && section !== "untracked")
  )
    return Response.json({ error: "无效路径或状态" }, { status: 400 });
  const base: { path: string; section: GitStatusSection } = { path, section };
  let root: string;
  let scope: string;
  try {
    ({ root, scope } = await resolveRepoScope(room.cwd));
  } catch (error) {
    return Response.json({
      ...base,
      state: "unavailable",
      reason: message(error) || "Git 状态不可用",
    } satisfies GitStatusDetailResponse);
  }
  const resolvedRoot = resolve(root);
  const resolvedScope = scope ? resolve(resolvedRoot, scope) : resolvedRoot;
  const targetAbsolute = resolve(resolvedRoot, path);
  if (!strictlyInside(resolvedRoot, targetAbsolute) || !strictlyInside(resolvedScope, targetAbsolute)) {
    return Response.json({
      ...base,
      state: "unavailable",
      reason: "状态已变化，请刷新",
    } satisfies GitStatusDetailResponse);
  }
  const literalPath = `:(literal)${path}`;
  let safeOptions: string[];
  let item: GitStatusItem | undefined;
  try {
    safeOptions = await prepareReadOnlyGitForPath(room.cwd, root, path);
    const raw = await git(
      root,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
        "--ignore-submodules=all",
        "--",
        literalPath,
      ],
      DIFF_MAX_BYTES,
      safeOptions,
    );
    item = parsePorcelainItems(raw, root).find((entry) => entry.path === path);
  } catch (error) {
    return Response.json({
      ...base,
      state: "unavailable",
      reason: message(error),
    } satisfies GitStatusDetailResponse);
  }
  if (!item?.[section])
    return Response.json({
      ...base,
      state: "unavailable",
      reason: "状态已变化，请刷新",
    } satisfies GitStatusDetailResponse);
  if (section === "untracked") return Response.json(untrackedDetail(room, root, path, section));
  const args = [
    "diff",
    ...(section === "staged" ? ["--cached"] : []),
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
  ];
  try {
    // --numstat marks binary files with '-' without relying on patch text.
    const stats = await git(root, [...args, "--numstat", "-z", "--", literalPath], DIFF_MAX_BYTES, safeOptions);
    if (stats.startsWith("-\t-\t"))
      return Response.json({ ...base, state: "binary" } satisfies GitStatusDetailResponse);
    const content = await git(root, [...args, "--", literalPath], DIFF_MAX_BYTES, safeOptions);
    if (!content)
      return Response.json({
        ...base,
        state: "unavailable",
        reason: "状态已变化或无法生成差异，请刷新",
      } satisfies GitStatusDetailResponse);
    return Response.json({ ...base, state: "text", content } satisfies GitStatusDetailResponse);
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      return Response.json({ ...base, state: "too-large" } satisfies GitStatusDetailResponse);
    return Response.json({ ...base, state: "unavailable", reason: message(error) } satisfies GitStatusDetailResponse);
  }
}
