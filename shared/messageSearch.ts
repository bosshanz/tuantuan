/** Literal, case-insensitive (SQLite's ASCII folding) search of persisted message bodies. */
export const MESSAGE_SEARCH_QUERY_MAX = 200;
export const MESSAGE_SEARCH_PAGE_SIZE = 30;
export const MESSAGE_SEARCH_LIMIT_MAX = 100;
export const MESSAGE_SEARCH_SNIPPET_LENGTH = 320;

export type MessageSearchScope = "all" | "current";

export interface MessageSearchResult {
  messageId: string;
  roomId: string;
  roomName: string;
  projectName: string | null;
  senderName: string;
  senderKind: "human" | "agent";
  createdAt: number;
  /** Sequence is unique only within this room, and is used for source navigation. */
  seq: number;
  /** Bounded plain text around the first match; never includes timeline or attachments. */
  snippet: string;
}

export interface MessageSearchPage {
  items: MessageSearchResult[];
  nextCursor: string | null;
}

/** Internal storage query; HTTP validation and opaque cursor encoding belong to the route. */
export interface MessageSearchQuery {
  query: string;
  roomId?: string;
  limit: number;
  before?: { createdAt: number; messageId: string };
}
