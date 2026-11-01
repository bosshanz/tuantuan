import type { Message } from "../server/store";
import { type Locale, translate } from "./i18n";
import { messageWithdrawn } from "./timeline";

export interface RoomPreview {
  messageId: string;
  seq: number;
  sender: string | null;
  text: string;
  at: number;
  status: Message["status"];
  attachment?: { kind: "file" | "image" | "mixed"; count: number; name?: string };
}

type PreviewMessage = Pick<
  Message,
  "id" | "seq" | "senderKind" | "senderName" | "content" | "error" | "createdAt" | "status"
> & { timeline?: { parts: readonly { kind: string; name?: string | null }[]; withdrawn?: boolean } | null };

/** The list snapshot and global message events use the same last-message contract. */
export function messagePreview(message: PreviewMessage): RoomPreview | null {
  if (message.senderKind === "system" || messageWithdrawn(message.timeline)) return null;
  const text = (message.content.trim() || message.error || "").replace(/\s+/g, " ").slice(0, 120);
  let attachment: RoomPreview["attachment"];
  if (!text) {
    let fileCount = 0;
    let imageCount = 0;
    let name: string | undefined;
    for (const part of message.timeline?.parts ?? []) {
      if (part.kind === "file") {
        fileCount++;
        if (!name && part.name) name = part.name.replace(/\s+/g, " ").slice(0, 80);
      } else if (part.kind === "image") imageCount++;
    }
    if (fileCount || imageCount)
      attachment = {
        kind: fileCount ? (imageCount ? "mixed" : "file") : "image",
        count: fileCount + imageCount,
        ...(name ? { name } : {}),
      };
  }
  return {
    messageId: message.id,
    seq: message.seq,
    sender: message.senderKind === "human" ? null : message.senderName,
    text,
    at: message.createdAt,
    status: message.status,
    ...(attachment ? { attachment } : {}),
  };
}

/** A late completion of an older turn must not replace a newer human message or reply. */
export function newerPreview(current: RoomPreview | undefined, incoming: RoomPreview): RoomPreview {
  if (!current || incoming.seq > current.seq) return incoming;
  if (incoming.seq < current.seq) return current;
  if (current.status !== "streaming" && incoming.status === "streaming") return current;
  if (current.status === "streaming" && incoming.status === "streaming" && incoming.text.length < current.text.length)
    return current;
  return incoming;
}

export function previewText(last: RoomPreview, locale: Locale = "zh-CN"): string {
  if (last.text) return last.text;
  const attachment = last.attachment;
  if (attachment?.kind === "image")
    return `（${translate(locale, "图片")}${attachment.count > 1 ? ` × ${attachment.count}` : ""}）`;
  if (attachment) {
    if (attachment.name) {
      if (attachment.count === 1) return translate(locale, "文件：{name}", { name: attachment.name });
      return translate(locale, attachment.kind === "mixed" ? "{name} 等 {count} 个附件" : "{name} 等 {count} 个文件", {
        name: attachment.name,
        count: attachment.count,
      });
    }
    return translate(locale, "{count} 个附件", { count: attachment.count });
  }
  const empty = {
    streaming: "正在回复…",
    done: "（空回复）",
    error: "回复失败",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  return translate(locale, empty[last.status]);
}
