import {
  MESSAGE_SEARCH_LIMIT_MAX,
  MESSAGE_SEARCH_PAGE_SIZE,
  MESSAGE_SEARCH_QUERY_MAX,
  type MessageSearchPage,
} from "../shared/messageSearch";
import { type Store, ValidationError } from "./store";

interface SearchCursor {
  version: 1;
  query: string;
  roomId: string | null;
  createdAt: number;
  messageId: string;
}

function cursorPosition(raw: string, query: string, roomId?: string): SearchCursor {
  if (raw.length > 2_000 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new ValidationError("搜索游标无效");
  let value: Partial<SearchCursor> | null = null;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ValidationError("搜索游标无效");
  }
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    value.query !== query ||
    value.roomId !== (roomId ?? null) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    typeof value.messageId !== "string" ||
    !value.messageId ||
    value.messageId.length > 200
  )
    throw new ValidationError("搜索游标无效");
  return value as SearchCursor;
}

/** GET /api/messages/search. Does not read message timelines, tools, thoughts or attachment data. */
export function handleMessageSearch(store: Store, url: URL): Response {
  try {
    const rawQuery = url.searchParams.get("q") ?? "";
    if (rawQuery.length > MESSAGE_SEARCH_QUERY_MAX || rawQuery.includes("\0"))
      throw new ValidationError("搜索词最多 200 个字符，且不能包含空字符");
    const query = rawQuery.trim();
    const roomId = url.searchParams.get("roomId") ?? undefined;
    if (roomId !== undefined && (!roomId || roomId.length > 200)) throw new ValidationError("搜索会话无效");
    if (roomId && !store.getRoom(roomId)) throw new ValidationError("会话不存在", 404);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? MESSAGE_SEARCH_PAGE_SIZE : Number(rawLimit);
    if (
      (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MESSAGE_SEARCH_LIMIT_MAX
    )
      throw new ValidationError("搜索条数必须是 1 到 100 的整数");
    const rawCursor = url.searchParams.get("cursor");
    const before = rawCursor === null ? undefined : cursorPosition(rawCursor, query, roomId);
    if (!query) return Response.json({ items: [], nextCursor: null } satisfies MessageSearchPage);

    const rows = store.searchMessages({ query, roomId, limit: limit + 1, before });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              query,
              roomId: roomId ?? null,
              createdAt: last.createdAt,
              messageId: last.messageId,
            } satisfies SearchCursor),
          ).toString("base64url")
        : null;
    return Response.json({ items, nextCursor } satisfies MessageSearchPage);
  } catch (error) {
    if (error instanceof ValidationError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
