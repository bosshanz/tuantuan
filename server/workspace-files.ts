import { closeSync, createReadStream, type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { type FilePreviewContent, getFilePreviewType } from "../shared/filePreview";
import {
  isMutedWorkspaceDir,
  WORKSPACE_DIR_ENTRY_LIMIT,
  WORKSPACE_SEARCH_RESULT_LIMIT,
  WORKSPACE_SEARCH_VISIT_LIMIT,
  type WorkspaceEntry,
  type WorkspaceSearchResponse,
  type WorkspaceTreeResponse,
} from "../shared/workspaceFiles";
import {
  decodePreviewText,
  downloadHeaders,
  fileFailure,
  inlineImageHeaders,
  mimeFor,
  openCheckedFile,
  readBoundedPreviewBytes,
} from "./conversation-files";
import { type Store, ValidationError } from "./store";

const RASTER_IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function strictlyInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function toPosixPath(relPath: string): string {
  return sep === "\\" ? relPath.split("\\").join("/") : relPath;
}

function validateRelativeInput(raw: string, allowEmpty: boolean): string {
  if (raw.includes("\0") || raw.length > 8192) throw new ValidationError("文件路径无效");
  if (!raw) {
    if (allowEmpty) return "";
    throw new ValidationError("文件路径无效");
  }
  if (isAbsolute(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    throw new ValidationError("文件路径无效");
  }
  const normalized = raw.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized) {
    if (allowEmpty) return "";
    throw new ValidationError("文件路径无效");
  }
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ValidationError("文件路径无效");
  }
  return normalized;
}

function classifyName(name: string): { image: boolean; previewable: boolean; mimeType: string } {
  const ext = extname(name).toLowerCase();
  const raster = RASTER_IMAGE_EXTS[ext];
  if (raster) return { image: true, previewable: false, mimeType: raster };
  const previewType = getFilePreviewType(name, "");
  return {
    image: false,
    previewable: previewType !== null,
    mimeType: "application/octet-stream",
  };
}

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  if (Boolean(a.muted) !== Boolean(b.muted)) return a.muted ? 1 : -1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function resolveWorkspaceRoot(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const root = realpathSync(cwd);
    return statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

export function handleWorkspaceTree(store: Store, roomId: string, url: URL): Response {
  try {
    const room = store.getRoom(roomId);
    if (!room) throw new ValidationError("会话不存在", 404);
    const dir = validateRelativeInput(url.searchParams.get("dir") ?? "", true);
    const cwdName = basename(room.cwd) || room.name;
    const root = resolveWorkspaceRoot(room.cwd);
    if (!root) {
      return Response.json({
        state: "unavailable",
        dir,
        cwdName,
        entries: [],
        truncated: false,
        error: "工作区目录当前不可用",
      } satisfies WorkspaceTreeResponse);
    }

    let realDir = root;
    if (dir) {
      const candidate = resolve(root, dir);
      if (!strictlyInside(root, candidate)) throw new ValidationError("目录超出当前工作区", 403);
      try {
        realDir = realpathSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ValidationError("目录不存在", 404);
        throw new ValidationError("目录当前不可用", 403);
      }
      if (!strictlyInside(root, realDir) || !statSync(realDir).isDirectory()) {
        throw new ValidationError("目录超出当前工作区", 403);
      }
    }

    let dirents: Dirent[];
    try {
      dirents = readdirSync(realDir, { withFileTypes: true });
    } catch {
      throw new ValidationError("目录当前不可用", 403);
    }

    const entries: WorkspaceEntry[] = [];
    let truncated = false;
    for (const dirent of dirents) {
      const name = dirent.name;
      if (!name || name === ".git") continue;
      if (entries.length >= WORKSPACE_DIR_ENTRY_LIMIT) {
        truncated = true;
        break;
      }
      const childPath = dir ? `${dir}/${name}` : name;
      const fullPath = join(realDir, name);
      let kind: "dir" | "file" | null = null;
      let size: number | null = null;
      let mtimeMs: number | null = null;

      if (dirent.isSymbolicLink()) {
        try {
          const targetReal = realpathSync(fullPath);
          if (!strictlyInside(root, targetReal)) continue;
          const st = statSync(targetReal);
          if (st.isDirectory()) {
            // Skip ancestor symlink cycles so expanding trees always terminates.
            if (realDir === targetReal || strictlyInside(targetReal, realDir)) continue;
            kind = "dir";
            mtimeMs = st.mtimeMs;
          } else if (st.isFile()) {
            kind = "file";
            size = st.size;
            mtimeMs = st.mtimeMs;
          }
        } catch {
          continue;
        }
      } else if (dirent.isDirectory()) {
        kind = "dir";
      } else if (dirent.isFile()) {
        kind = "file";
        try {
          const st = statSync(fullPath);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
      }

      if (!kind) continue;
      if (kind === "dir") {
        const muted = isMutedWorkspaceDir(name);
        entries.push({
          path: childPath,
          name,
          kind: "dir",
          size: null,
          mtimeMs,
          image: false,
          previewable: false,
          ...(muted ? { muted: true } : {}),
        });
      } else {
        const info = classifyName(name);
        entries.push({
          path: childPath,
          name,
          kind: "file",
          size,
          mtimeMs,
          image: info.image,
          previewable: info.previewable,
        });
      }
    }

    entries.sort(compareEntries);
    return Response.json({
      state: "ready",
      dir,
      cwdName,
      entries,
      truncated,
    } satisfies WorkspaceTreeResponse);
  } catch (error) {
    return fileFailure(error);
  }
}

function matchScore(pathLower: string, nameLower: string, queryLower: string): number {
  if (nameLower === queryLower) return 0;
  if (nameLower.startsWith(queryLower)) return 1;
  if (nameLower.includes(queryLower)) return 2;
  if (pathLower.includes(queryLower)) return 3;
  return -1;
}

export function handleWorkspaceSearch(store: Store, roomId: string, url: URL): Response {
  try {
    const room = store.getRoom(roomId);
    if (!room) throw new ValidationError("会话不存在", 404);
    const rawQuery = (url.searchParams.get("q") ?? "").trim();
    if (rawQuery.length > 256 || rawQuery.includes("\0")) throw new ValidationError("搜索词无效");
    const root = resolveWorkspaceRoot(room.cwd);
    if (!root) {
      return Response.json({
        state: "unavailable",
        query: rawQuery,
        items: [],
        truncated: false,
        error: "工作区目录当前不可用",
      } satisfies WorkspaceSearchResponse);
    }
    if (!rawQuery) {
      return Response.json({
        state: "ready",
        query: "",
        items: [],
        truncated: false,
      } satisfies WorkspaceSearchResponse);
    }

    const queryLower = rawQuery.replace(/\\/g, "/").toLowerCase();
    const firstSegment = queryLower.split("/")[0] ?? "";
    const queue: Array<{ realDir: string; relDir: string }> = [{ realDir: root, relDir: "" }];
    const scored: Array<{ score: number; depth: number; entry: WorkspaceEntry }> = [];
    let visited = 0;
    let truncated = false;

    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      if (!current) break;
      let dirents: Dirent[];
      try {
        dirents = readdirSync(current.realDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        const name = dirent.name;
        if (!name || name === ".git") continue;
        if (++visited > WORKSPACE_SEARCH_VISIT_LIMIT) {
          truncated = true;
          break;
        }
        const relPath = current.relDir ? `${current.relDir}/${name}` : name;
        const nameLower = name.toLowerCase();
        const pathLower = relPath.toLowerCase();

        if (dirent.isSymbolicLink()) {
          // Never recurse into symlink directories during workspace search; check safe file targets only.
          try {
            const targetReal = realpathSync(join(current.realDir, name));
            if (!strictlyInside(root, targetReal)) continue;
            const st = statSync(targetReal);
            if (!st.isFile()) continue;
            const score = matchScore(pathLower, nameLower, queryLower);
            if (score >= 0) {
              const info = classifyName(name);
              scored.push({
                score,
                depth: relPath.split("/").length,
                entry: {
                  path: toPosixPath(relPath),
                  name,
                  kind: "file",
                  size: st.size,
                  mtimeMs: st.mtimeMs,
                  image: info.image,
                  previewable: info.previewable,
                },
              });
            }
          } catch {
            continue;
          }
          continue;
        }

        if (dirent.isDirectory()) {
          const muted = isMutedWorkspaceDir(name);
          if (!muted || firstSegment === nameLower || pathLower.startsWith(`${queryLower}/`)) {
            queue.push({ realDir: join(current.realDir, name), relDir: relPath });
          }
          continue;
        }

        if (dirent.isFile()) {
          const score = matchScore(pathLower, nameLower, queryLower);
          if (score >= 0) {
            const info = classifyName(name);
            scored.push({
              score,
              depth: relPath.split("/").length,
              entry: {
                path: toPosixPath(relPath),
                name,
                kind: "file",
                size: null,
                mtimeMs: null,
                image: info.image,
                previewable: info.previewable,
              },
            });
          }
        }
      }
      if (truncated) break;
    }

    scored.sort(
      (a, b) =>
        a.score - b.score ||
        a.depth - b.depth ||
        collator.compare(a.entry.name, b.entry.name) ||
        collator.compare(a.entry.path, b.entry.path),
    );
    if (scored.length > WORKSPACE_SEARCH_RESULT_LIMIT) truncated = true;
    const items = scored.slice(0, WORKSPACE_SEARCH_RESULT_LIMIT).map(({ entry }) => {
      if (entry.size === null) {
        try {
          const st = statSync(join(root, entry.path));
          if (st.isFile()) return { ...entry, size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          /* Keep null size if file disappeared concurrently. */
        }
      }
      return entry;
    });

    return Response.json({
      state: "ready",
      query: rawQuery,
      items,
      truncated,
    } satisfies WorkspaceSearchResponse);
  } catch (error) {
    return fileFailure(error);
  }
}

export function handleWorkspaceFilePreview(store: Store, roomId: string, url: URL): Response {
  let fd: number | undefined;
  try {
    const room = store.getRoom(roomId);
    if (!room) throw new ValidationError("会话不存在", 404);
    const path = validateRelativeInput(url.searchParams.get("path") ?? "", false);
    const name = basename(path) || path;
    const mimeType = mimeFor(name, null);
    const type = getFilePreviewType(name, mimeType);
    if (!type) throw new ValidationError("此文件类型不支持预览", 415);
    const opened = openCheckedFile(room, path);
    fd = opened.fd;
    const bytes = readBoundedPreviewBytes(fd, opened.size);
    const text = decodePreviewText(bytes);
    return Response.json({ ...type, text, size: bytes.length } satisfies FilePreviewContent, {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return fileFailure(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function handleWorkspaceFileContent(store: Store, roomId: string, url: URL): Response {
  let fd: number | undefined;
  try {
    const room = store.getRoom(roomId);
    if (!room) throw new ValidationError("会话不存在", 404);
    const path = validateRelativeInput(url.searchParams.get("path") ?? "", false);
    const name = basename(path) || path;
    const opened = openCheckedFile(room, path);
    fd = opened.fd;
    const inline = url.searchParams.get("inline") === "1";
    const headers = inline ? inlineImageHeaders(mimeFor(name, null), opened.size) : downloadHeaders(name, opened.size);
    if (!opened.size) {
      closeSync(fd);
      fd = undefined;
      return new Response(new Uint8Array(), { headers });
    }
    const stream = createReadStream("", { fd, autoClose: true, start: 0, end: opened.size - 1 });
    fd = undefined;
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { headers });
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    return fileFailure(error);
  }
}
