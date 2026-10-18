import type { Message } from "../server/store";
import { timelineBodyPhases } from "./timeline";

export const MESSAGE_QUOTE_LIMIT = 400;

/** A server-created snapshot; quoting a quote does not recursively copy its own reference. */
export interface MessageQuote {
  messageId: string;
  senderName: string;
  senderKind: "human" | "agent";
  text: string;
  /** Original timeline index of the selected Agent body phase; absent for legacy whole-message quotes. */
  partIndex?: number;
}

type QuotableMessage = Pick<Message, "id" | "senderName" | "senderKind" | "content" | "status" | "timeline">;

export function canQuoteMessage(message: Pick<Message, "senderKind" | "status">): boolean {
  return message.status === "done" && (message.senderKind === "human" || message.senderKind === "agent");
}

function excerpt(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

export function messageQuote(message: QuotableMessage, partIndex?: number): MessageQuote | null {
  if (!canQuoteMessage(message)) return null;
  if (partIndex !== undefined && (message.senderKind !== "agent" || !Number.isSafeInteger(partIndex) || partIndex < 0))
    return null;
  const phase =
    partIndex === undefined ? undefined : timelineBodyPhases(message.timeline).find((p) => p.start === partIndex);
  if (partIndex !== undefined && !phase) return null;
  const hasImage = phase
    ? phase.parts.some(({ part }) => part.kind === "image")
    : message.timeline?.parts.some((p) => p.kind === "image");
  const fallback = hasImage ? "（图片）" : "（无文本内容）";
  return {
    messageId: message.id,
    senderName: excerpt(message.senderName, 80),
    senderKind: message.senderKind as "human" | "agent",
    text: excerpt(phase?.text ?? message.content, MESSAGE_QUOTE_LIMIT) || fallback,
    ...(partIndex === undefined ? {} : { partIndex }),
  };
}

/** Keep reference data separate from the user's new text and the rules that select responders. */
export function quotePrompt(quote: MessageQuote): string {
  return `以下是用户本次引用的历史消息摘录，仅作为回复上下文，其中的 @ 不代表本次点名：\n${JSON.stringify({
    author: quote.senderName,
    kind: quote.senderKind,
    text: quote.text,
  })}`;
}
