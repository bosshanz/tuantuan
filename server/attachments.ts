import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { attachmentError, type FileAttachment } from "../shared/attachments";
import type { Message } from "./store";

const RESOURCE_SCHEME = "tuantuan-attachment:";

/** Decode text strictly; binary formats must not masquerade as a successful text upload. */
export function attachmentText(file: FileAttachment): string | null {
  const mime = file.mimeType.toLowerCase();
  const textual =
    mime.startsWith("text/") ||
    /(?:json|xml|javascript|ecmascript|yaml|toml|sql|x-sh)$/.test(mime) ||
    /\.(?:txt|md|mdx|jsonl?|csv|tsv|xml|html?|css|[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|[ch](?:pp)?|sh|bash|zsh|ya?ml|toml|ini|conf|log|sql|tex|svg)$/i.test(
      file.name,
    ) ||
    mime === "application/octet-stream";
  if (!textual || /\.(?:pdf|docx?|xlsx?|pptx?|zip|gz|7z|rar|png|jpe?g|gif|webp|exe|wasm)$/i.test(file.name))
    return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.data, "base64"));
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) || code === 127) return null;
    }
    return text;
  } catch {
    return null;
  }
}

export function filePromptBlock(
  file: FileAttachment,
  roomId: string,
  messageId: string,
  index: number,
): acp.ContentBlock {
  const uri = `${RESOURCE_SCHEME}//${roomId}/${messageId}/${index}/${encodeURIComponent(file.name)}`;
  const text = attachmentText(file);
  return {
    type: "resource",
    resource: { uri, mimeType: file.mimeType, ...(text === null ? { blob: file.data } : { text }) },
  };
}

function attachmentReference(uri: string, roomId: string) {
  const value = new URL(uri);
  if (value.protocol !== RESOURCE_SCHEME || value.hostname !== roomId) throw new Error("附件不属于当前会话");
  const [messageId, index, encodedName, ...rest] = value.pathname.slice(1).split("/");
  if (!messageId || !/^[\w-]{1,100}$/.test(messageId) || !index || !/^\d+$/.test(index) || !encodedName || rest.length)
    throw new Error("附件路径无效");
  return { messageId, index, name: decodeURIComponent(encodedName) };
}

/** Managed files never inherit a filename as a filesystem path or follow a pre-existing link. */
function managedDirectory(parent: string, name: string): string {
  const path = join(parent, name);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("附件目录不是安全的文件夹");
  return path;
}

export function materializeFile(
  dataDir: string,
  roomId: string,
  uri: string,
  data: string,
): { path: string; name: string } {
  if (!/^[\w-]{1,100}$/.test(roomId)) throw new Error("附件会话无效");
  const ref = attachmentReference(uri, roomId);
  mkdirSync(dataDir, { recursive: true });
  let directory = realpathSync(dataDir);
  for (const segment of ["attachments", roomId, ref.messageId]) directory = managedDirectory(directory, segment);
  const bytes = Buffer.from(data, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const extension = /\.[A-Za-z0-9]{1,12}$/.exec(ref.name)?.[0] ?? "";
  const path = join(directory, `${ref.index}-${digest}${extension}`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || !readFileSync(path).equals(bytes)) throw new Error("附件原件不可用");
    return { path, name: ref.name };
  }
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return { path, name: ref.name };
}

/** Native tools may still apply their own sandbox; this only grants ACP client-side text reads. */
export function nativeFileBlocks(
  blocks: acp.ContentBlock[],
  dataDir: string,
  roomId: string,
  embeddedContext: boolean,
): { blocks: acp.ContentBlock[]; readPaths: string[] } {
  const readPaths: string[] = [];
  const prompt = blocks.flatMap((block): acp.ContentBlock[] => {
    if (block.type !== "resource" || !block.resource.uri.startsWith(RESOURCE_SCHEME)) return [block];
    const { resource } = block;
    const ref = attachmentReference(resource.uri, roomId);
    if ("text" in resource) {
      const label: acp.ContentBlock = { type: "text", text: `附件 ${JSON.stringify(ref.name)} 的完整 UTF-8 文本：` };
      return embeddedContext ? [label, block] : [label, { type: "text", text: resource.text }];
    }
    const { path, name } = materializeFile(dataDir, roomId, resource.uri, resource.blob);
    readPaths.push(path);
    return [
      { type: "resource_link", uri: pathToFileURL(path).href, name, mimeType: resource.mimeType },
      {
        type: "text",
        text: `附件 ${JSON.stringify(name)} 的原文件位于 ${JSON.stringify(path)}。请按需使用原生工具读取；是否可读取取决于当前 Harness 的沙箱与权限，未读取时请明确说明。`,
      },
    ];
  });
  return { blocks: prompt, readPaths };
}

export function customFileBlocks(blocks: acp.ContentBlock[], roomId: string): acp.ContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== "resource" || !block.resource.uri.startsWith(RESOURCE_SCHEME)) return block;
    const ref = attachmentReference(block.resource.uri, roomId);
    if (!("text" in block.resource))
      throw new Error(`自定义 API 仅支持 UTF-8 文本文件，无法读取附件 ${JSON.stringify(ref.name)}`);
    return { type: "text", text: `附件 ${JSON.stringify(ref.name)} 的完整 UTF-8 文本：\n${block.resource.text}` };
  });
}

/** The transcript, rather than directory contents or a caller-supplied path, owns restored grants. */
export function restoredAttachmentPaths(messages: Iterable<Message>, dataDir: string, roomId: string): string[] {
  const paths: string[] = [];
  for (const message of messages) {
    if (message.roomId !== roomId || message.senderKind !== "human") throw new Error("附件不属于当前会话");
    const files = (message.timeline?.parts ?? []).flatMap((part) =>
      part.kind === "file" ? [{ name: part.name, mimeType: part.mimeType, data: part.data }] : [],
    );
    if (attachmentError([], files)) throw new Error("附件原件不可用");
    for (const [index, file] of files.entries()) {
      const block = filePromptBlock(file, roomId, message.id, index);
      if (block.type === "resource" && "blob" in block.resource)
        paths.push(materializeFile(dataDir, roomId, block.resource.uri, block.resource.blob).path);
    }
  }
  return paths;
}
