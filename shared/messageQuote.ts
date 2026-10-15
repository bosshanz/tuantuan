import type { Message } from "../server/store";

export const MESSAGE_QUOTE_LIMIT = 400;

/** A server-created snapshot; quoting a quote does not recursively copy its own reference. */
export interface MessageQuote {
  messageId: string;
  senderName: string;
  senderKind: "human" | "agent";
  text: string;
}

type QuotableMessage = Pick<Message, "id" | "senderName" | "senderKind" | "content" | "status" | "timeline">;

export function canQuoteMessage(message: Pick<Message, "senderKind" | "status">): boolean {
  return message.status === "done" && (message.senderKind === "human" || message.senderKind === "agent");
}

function excerpt(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

export function messageQuote(message: QuotableMessage): MessageQuote | null {
  if (!canQuoteMessage(message)) return null;
  const fallback = message.timeline?.parts.some((p) => p.kind === "image") ? "（图片）" : "（无文本内容）";
  return {
    messageId: message.id,
    senderName: excerpt(message.senderName, 80),
    senderKind: message.senderKind as "human" | "agent",
    text: excerpt(message.content, MESSAGE_QUOTE_LIMIT) || fallback,
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
