import type { Message } from "../server/store";
import { type Locale, translate } from "./i18n";

export interface RoomPreview {
  messageId: string;
  seq: number;
  sender: string | null;
  text: string;
  at: number;
  status: Message["status"];
}

type PreviewMessage = Pick<
  Message,
  "id" | "seq" | "senderKind" | "senderName" | "content" | "error" | "createdAt" | "status"
>;

/** The list snapshot and global message events use the same last-message contract. */
export function messagePreview(message: PreviewMessage): RoomPreview | null {
  if (message.senderKind === "system") return null;
  return {
    messageId: message.id,
    seq: message.seq,
    sender: message.senderKind === "human" ? null : message.senderName,
    text: (message.content || message.error || "").replace(/\s+/g, " ").slice(0, 120),
    at: message.createdAt,
    status: message.status,
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
  const empty = {
    streaming: "正在回复…",
    done: "（空回复）",
    error: "回复失败",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  return translate(locale, empty[last.status]);
}
