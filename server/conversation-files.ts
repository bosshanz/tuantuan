import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { attachmentBytes, IMAGE_MIME_TYPES } from "../shared/attachments";
import {
  CONVERSATION_FILE_DOWNLOAD_MAX_BYTES,
  CONVERSATION_FILES_LIMIT_MAX,
  CONVERSATION_FILES_PAGE_SIZE,
  type ConversationFile,
  type ConversationFilesPage,
} from "../shared/conversationFiles";
import { FILE_PREVIEW_MAX_BYTES, type FilePreviewContent, getFilePreviewType } from "../shared/filePreview";
import { localFileTarget } from "../shared/localFileLink";
import {
  type ConversationFileMessage,
  type ConversationFileSource,
  type Room,
  type Store,
  ValidationError,
} from "./store";

const INLINE_BYTES_MAX = 20 * 1024 * 1024;
const SOURCE_BUDGET = 64;
const MESSAGE_BUDGET = 32;
const imageTypes = new Set<string>(IMAGE_MIME_TYPES);

interface Position {
  seq: number;
  key: string;
  offset: number;
}

interface FileReference {
  offset: number;
  path?: string;
  name?: string;
}

interface FileIdentity extends Position {
  version: 1;
  messageId: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(raw: string): Record<string, unknown> {
  if (raw.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new ValidationError("文件引用无效");
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new ValidationError("文件引用无效");
}

function validPosition(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    Number.isSafeInteger(value.seq) &&
    (value.seq as number) >= 0 &&
    typeof value.key === "string" &&
    value.key.length <= 2000 &&
    Number.isSafeInteger(value.offset) &&
    (value.offset as number) >= -1 &&
    (value.offset as number) <= Number.MAX_SAFE_INTEGER
  );
}

function cursor(raw: string, roomId: string): Position {
  const value = decode(raw);
  if (!validPosition(value) || value.roomId !== roomId) throw new ValidationError("文件列表游标无效");
  return value as unknown as Position;
}

function nextCursor(roomId: string, position: Position): string {
  return encode({ version: 1, roomId, ...position });
}

/** Only explicit Markdown targets count; examples in code do not identify deliverables. */
function* markdownReferences(source: ConversationFileSource): Generator<FileReference> {
  const text = source.text ?? "";
  let fence = "";
  let codeUntil = -1;
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]?.[0] === fence[0] && (marker[1]?.length ?? 0) >= fence.length && !marker[2]?.trim())
        fence = "";
    } else if (marker && !(marker[1]?.[0] === "`" && marker[2]?.includes("`"))) {
      fence = marker[1] ?? "";
      codeUntil = -1;
    } else if (!/^(?: {4}|\t)/.test(line)) {
      const tokens =
        /`+|!?\[([^\]\n]{0,2048})\]\(\s*(<[^>\n]{1,8192}>|(?:\\.|[^\s()\\]|\((?:\\.|[^()\\])*\)){1,8192})(?:\s+["'][^\n]*?["'])?\s*\)/g;
      for (const match of line.matchAll(tokens)) {
        const offset = start + match.index;
        if (offset < codeUntil) continue;
        let escapes = 0;
        for (let index = offset - 1; index >= start && text[index] === "\\"; index--) escapes++;
        if (escapes % 2) continue;
        if (match[0].startsWith("`")) {
          const ticks = match[0];
          let closing = text.indexOf(ticks, offset + ticks.length);
          while (closing >= 0 && (text[closing - 1] === "`" || text[closing + ticks.length] === "`"))
            closing = text.indexOf(ticks, closing + ticks.length);
          if (closing >= 0) codeUntil = closing + ticks.length;
          continue;
        }
        const raw = (match[2] ?? "").replace(/^<|>$/g, "").replace(/\\([\s()[\]<>\\])/g, "$1");
        const path = localPath(raw);
        if (path !== null) yield { offset, path };
      }
    }
    start = end + 1;
  }
}

/** null means a remote URL or non-file target; explicit local but inaccessible paths stay visible. */
const localPath = localFileTarget;

function* references(source: ConversationFileSource): Generator<FileReference> {
  if (source.kind === "text") yield* markdownReferences(source);
  else if (source.kind === "inline") yield { offset: 0, ...(source.name ? { name: source.name } : {}) };
  else {
    const path = typeof source.path === "string" ? localPath(source.path) : null;
    if (path !== null) yield { offset: 0, path, ...(source.name ? { name: source.name } : {}) };
  }
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

interface LocalFile {
  state: ConversationFile["state"];
  size: number | null;
  realPath?: string;
  root?: string;
  dev?: number;
  ino?: number;
}

interface FileLookupCache {
  root?: string | null;
  files: Map<string, LocalFile>;
}

function currentFile(cwd: string, path: string, cache?: FileLookupCache): LocalFile {
  const unavailable: LocalFile = { state: "unavailable", size: null };
  if (!cwd || !path || path.length > 8192 || path.includes("\0") || /(^|[\\/])\.\.([\\/]|$)/.test(path))
    return unavailable;
  const cached = cache?.files.get(path);
  if (cached) return cached;
  const remember = (result: LocalFile) => {
    cache?.files.set(path, result);
    return result;
  };
  try {
    let root: string | null | undefined = cache?.root;
    if (root === undefined) {
      try {
        root = realpathSync(cwd);
      } catch {
        root = null;
      }
      if (cache) cache.root = root;
    }
    if (!root) return remember(unavailable);
    const absolute = resolve(cwd, path);
    if (!inside(resolve(cwd), absolute) && !inside(root, absolute)) return remember(unavailable);
    // Resolve existing parents too: a missing target beneath an outside symlink is unavailable.
    let ancestor = absolute;
    for (;;) {
      try {
        const realAncestor = realpathSync(ancestor);
        if (!inside(root, realAncestor) && realAncestor !== root) return remember(unavailable);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return remember(unavailable);
        try {
          if (lstatSync(ancestor).isSymbolicLink()) return remember(unavailable);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return remember(unavailable);
        }
        const parent = resolve(ancestor, "..");
        if (parent === ancestor) return remember(unavailable);
        ancestor = parent;
      }
    }
    let realPath: string;
    try {
      realPath = realpathSync(absolute);
    } catch (error) {
      return remember(
        (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing", size: null } : unavailable,
      );
    }
    if (!inside(root, realPath)) return remember(unavailable);
    const stat = statSync(realPath);
    if (!stat.isFile()) return remember(unavailable);
    return remember({
      state: stat.size <= CONVERSATION_FILE_DOWNLOAD_MAX_BYTES ? "available" : "unavailable",
      size: stat.size,
      realPath,
      root,
      dev: stat.dev,
      ino: stat.ino,
    });
  } catch {
    return remember(unavailable);
  }
}

export function mimeFor(name: string, declared: string | null): string {
  if (declared && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(declared)) return declared.toLowerCase();
  return Bun.file(name).type || "application/octet-stream";
}

function inlineName(source: ConversationFileSource): string {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[
    source.mimeType ?? ""
  ];
  const index = Number(source.key.split(":").at(-1)) + 1;
  return source.name || `image-${Number.isFinite(index) ? index : 1}.${extension ?? "bin"}`;
}

function fileItem(
  room: Room,
  message: ConversationFileMessage,
  source: ConversationFileSource,
  reference: FileReference,
  cache?: FileLookupCache,
): ConversationFile {
  const id = encode({
    version: 1,
    messageId: message.id,
    seq: message.seq,
    key: source.key,
    offset: reference.offset,
  } satisfies FileIdentity);
  const name = reference.path ? reference.name || basename(reference.path) || reference.path : inlineName(source);
  const mimeType = mimeFor(name, source.mimeType);
  const local = reference.path ? currentFile(room.cwd, reference.path, cache) : null;
  const size = local ? local.size : source.size;
  const state = local
    ? local.state
    : source.valid === 1 && size !== null && size >= 0 && size <= INLINE_BYTES_MAX
      ? "available"
      : "unavailable";
  return {
    id,
    messageId: message.id,
    seq: message.seq,
    name,
    mimeType,
    source: message.senderKind === "human" ? "attachment" : "agent",
    senderName: message.senderName,
    createdAt: message.createdAt,
    ...(reference.path ? { path: reference.path } : {}),
    size,
    state,
    image: imageTypes.has(mimeType),
    ...(state === "available" ? { downloadUrl: `/api/rooms/${encodeURIComponent(room.id)}/files/${id}/content` } : {}),
  };
}

function failure(error: unknown): Response {
  if (error instanceof ValidationError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
}

export function handleConversationFiles(store: Store, roomId: string, url: URL): Response {
  try {
    const room = store.getRoom(roomId);
    if (!room) throw new ValidationError("会话不存在", 404);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? CONVERSATION_FILES_PAGE_SIZE : Number(rawLimit);
    if (
      (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > CONVERSATION_FILES_LIMIT_MAX
    )
      throw new ValidationError("文件条数必须是 1 到 100 的整数");
    const rawCursor = url.searchParams.get("cursor");
    let position: Position =
      rawCursor === null ? { seq: Number.MAX_SAFE_INTEGER, key: "", offset: -1 } : cursor(rawCursor, roomId);
    const items: ConversationFile[] = [];
    const lookupCache: FileLookupCache = { files: new Map() };
    let scanned = 0;
    for (let messages = 0; messages < MESSAGE_BUDGET && scanned < SOURCE_BUDGET; messages++) {
      const message = store.conversationFileMessage(roomId, position.seq);
      if (!message) return Response.json({ items, nextCursor: null } satisfies ConversationFilesPage);
      if (message.seq !== position.seq) position = { seq: message.seq, key: "", offset: -1 };
      // Continue directly at a reference coordinate rather than loading preceding binary sources.
      const page = position.key
        ? [
            ...store.conversationFileSources(roomId, message.id, "", 1, position.key),
            ...store.conversationFileSources(roomId, message.id, position.key, SOURCE_BUDGET - scanned + 1),
          ]
        : store.conversationFileSources(roomId, message.id, "", SOURCE_BUDGET - scanned + 1);
      for (const source of page) {
        if (scanned++ >= SOURCE_BUDGET)
          return Response.json({ items, nextCursor: nextCursor(roomId, position) } satisfies ConversationFilesPage);
        for (const reference of references(source)) {
          if (source.key === position.key && reference.offset <= position.offset) continue;
          items.push(fileItem(room, message, source, reference, lookupCache));
          position = { seq: message.seq, key: source.key, offset: reference.offset };
          if (items.length === limit)
            return Response.json({ items, nextCursor: nextCursor(roomId, position) } satisfies ConversationFilesPage);
        }
        position = { seq: message.seq, key: source.key, offset: Number.MAX_SAFE_INTEGER };
      }
      position = { seq: message.seq - 1, key: "", offset: -1 };
    }
    return Response.json({ items, nextCursor: nextCursor(roomId, position) } satisfies ConversationFilesPage);
  } catch (error) {
    return failure(error);
  }
}

export function downloadHeaders(name: string, size: number): Headers {
  const safe =
    Array.from(basename(name), (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? "_" : character,
    ).join("") || "download";
  const ascii = safe.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const utf8 = encodeURIComponent(safe).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
    "content-length": String(size),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
}

export function inlineImageHeaders(mimeType: string, size: number): Headers {
  if (!imageTypes.has(mimeType)) throw new ValidationError("此文件不支持图片预览", 415);
  if (size > INLINE_BYTES_MAX) throw new ValidationError("文件当前不可用", 413);
  return new Headers({
    "content-type": mimeType,
    "content-disposition": "inline",
    "content-length": String(size),
    "content-security-policy": "default-src 'none'",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
}

/** Download and preview share the exact same persisted-reference and current-path grant. */
function resolveConversationFile(store: Store, roomId: string, fileId: string) {
  const room = store.getRoom(roomId);
  if (!room) throw new ValidationError("会话不存在", 404);
  const identity = decode(fileId);
  if (!validPosition(identity) || typeof identity.messageId !== "string" || identity.messageId.length > 200)
    throw new ValidationError("文件不存在", 404);
  const message = store.conversationFileMessage(roomId, identity.seq as number);
  if (!message || message.seq !== identity.seq || message.id !== identity.messageId)
    throw new ValidationError("文件不存在", 404);
  const source = store.conversationFileSources(roomId, message.id, "", 1, identity.key as string)[0];
  let reference: FileReference | undefined;
  if (source) {
    for (const entry of references(source)) {
      if (entry.offset === identity.offset) {
        reference = entry;
        break;
      }
      if (entry.offset > (identity.offset as number)) break;
    }
  }
  if (!source || !reference) throw new ValidationError("文件不存在", 404);
  const item = fileItem(room, message, source, reference);
  if (item.id !== fileId) throw new ValidationError("文件不存在", 404);
  return { room, message, source, reference, item };
}

function requireAvailableFile(item: ConversationFile) {
  if (item.state === "available") return;
  if (item.size !== null && item.size > CONVERSATION_FILE_DOWNLOAD_MAX_BYTES)
    throw new ValidationError("文件超过 100 MiB 下载上限", 403);
  throw new ValidationError("文件当前不可用", item.state === "missing" ? 404 : 403);
}

export function openCheckedFile(room: Room, path: string): { fd: number; size: number } {
  const local = currentFile(room.cwd, path);
  if (local.state !== "available" || !local.realPath || !local.root)
    throw new ValidationError("文件当前不可用", local.state === "missing" ? 404 : 403);
  const fd = openSync(local.realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    const current = currentFile(room.cwd, path);
    if (
      !stat.isFile() ||
      stat.dev !== local.dev ||
      stat.ino !== local.ino ||
      current.state !== "available" ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.root !== local.root
    )
      throw new ValidationError("文件当前不可用", 403);
    return { fd, size: stat.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function inlineFileBytes(
  store: Store,
  roomId: string,
  messageId: string,
  source: ConversationFileSource,
  maxBytes = INLINE_BYTES_MAX,
): Buffer<ArrayBuffer> {
  const payload = store.conversationFileSources(roomId, messageId, "", 1, source.key, true, maxBytes)[0]?.data;
  const size = typeof payload === "string" ? attachmentBytes(payload) : null;
  if (size === null || size > maxBytes) throw new ValidationError("附件内容无效", 403);
  return Buffer.from(payload as string, "base64");
}

export function fileFailure(error: unknown): Response {
  if ((error as NodeJS.ErrnoException).code === "ENOENT")
    return Response.json({ error: "文件不存在" }, { status: 404 });
  if (["EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
    return Response.json({ error: "文件当前不可用" }, { status: 403 });
  return failure(error);
}

export function readBoundedPreviewBytes(fd: number, size: number): Buffer {
  if (size > FILE_PREVIEW_MAX_BYTES) throw new ValidationError("文件超过 1 MiB 预览上限", 413);
  // One extra byte detects growth after fstat, without allowing an unbounded read.
  const buffer = Buffer.alloc(FILE_PREVIEW_MAX_BYTES + 1);
  let total = 0;
  while (total <= FILE_PREVIEW_MAX_BYTES) {
    const count = readSync(fd, buffer, total, buffer.length - total, null);
    if (!count) break;
    total += count;
  }
  if (total > FILE_PREVIEW_MAX_BYTES) throw new ValidationError("文件超过 1 MiB 预览上限", 413);
  return buffer.subarray(0, total);
}

export function decodePreviewText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError("文件不是有效的 UTF-8 文本", 415);
  }
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159))
      throw new ValidationError("文件包含二进制或控制字符，无法预览", 415);
  }
  return text;
}

export function handleConversationFileContent(store: Store, roomId: string, fileId: string, url?: URL): Response {
  let fd: number | undefined;
  try {
    const { room, message, source, reference, item } = resolveConversationFile(store, roomId, fileId);
    requireAvailableFile(item);
    const inline = url?.searchParams.get("inline") === "1";
    if (reference.path) {
      const opened = openCheckedFile(room, reference.path);
      fd = opened.fd;
      const headers = inline ? inlineImageHeaders(item.mimeType, opened.size) : downloadHeaders(item.name, opened.size);
      if (!opened.size) {
        closeSync(fd);
        fd = undefined;
        return new Response(new Uint8Array(), { headers });
      }
      const stream = createReadStream("", { fd, autoClose: true, start: 0, end: opened.size - 1 });
      fd = undefined;
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { headers });
    }
    const bytes = inlineFileBytes(store, roomId, message.id, source);
    const headers = inline ? inlineImageHeaders(item.mimeType, bytes.length) : downloadHeaders(item.name, bytes.length);
    return new Response(bytes, { headers });
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    return fileFailure(error);
  }
}

export function handleConversationFilePreview(store: Store, roomId: string, fileId: string): Response {
  let fd: number | undefined;
  try {
    const { room, message, source, reference, item } = resolveConversationFile(store, roomId, fileId);
    if (item.size !== null && item.size > FILE_PREVIEW_MAX_BYTES)
      throw new ValidationError("文件超过 1 MiB 预览上限", 413);
    requireAvailableFile(item);
    const type = getFilePreviewType(item.name, item.mimeType);
    if (!type) throw new ValidationError("此文件类型不支持预览", 415);
    let bytes: Buffer;
    if (reference.path) {
      const opened = openCheckedFile(room, reference.path);
      fd = opened.fd;
      bytes = readBoundedPreviewBytes(fd, opened.size);
    } else bytes = inlineFileBytes(store, roomId, message.id, source, FILE_PREVIEW_MAX_BYTES);
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
