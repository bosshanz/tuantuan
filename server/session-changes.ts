import { basename } from "node:path";
import type { SessionChangeDetailResponse, SessionChangesResponse } from "../shared/sessionChanges";
import {
  aggregateSessionChanges,
  normalizeEditPath,
  occurrencesFromMessage,
  type SessionEditOccurrence,
} from "../shared/sessionEdits";
import { type Store, ValidationError } from "./store";

function failure(error: unknown): Response {
  if (error instanceof ValidationError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
}

function roomOccurrences(store: Store, roomId: string): { cwd: string; items: SessionEditOccurrence[] } {
  const room = store.getRoom(roomId);
  if (!room) throw new ValidationError("会话不存在", 404);
  const items: SessionEditOccurrence[] = [];
  for (const message of store.agentEditMessages(roomId)) {
    items.push(...occurrencesFromMessage(message, room.cwd));
  }
  return { cwd: room.cwd, items };
}

export function handleSessionChanges(store: Store, roomId: string): Response {
  try {
    const { items } = roomOccurrences(store, roomId);
    const body: SessionChangesResponse = {
      items: aggregateSessionChanges(items),
      scope: "agent-reported-edits",
    };
    return Response.json(body);
  } catch (error) {
    return failure(error);
  }
}

export function handleSessionChangeDetail(store: Store, roomId: string, url: URL): Response {
  try {
    const raw = url.searchParams.get("path");
    if (raw === null || !raw.trim()) throw new ValidationError("缺少 path 参数");
    if (raw.length > 8192) throw new ValidationError("path 过长");
    const { cwd, items } = roomOccurrences(store, roomId);
    const path = normalizeEditPath(raw, cwd);
    const edits = items.filter((item) => item.path === path).sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
    if (!edits.length) throw new ValidationError("没有该路径的 Agent 改动", 404);
    const authors = new Set(edits.map((item) => item.senderId ?? `name:${item.senderName}`));
    const body: SessionChangeDetailResponse = {
      path,
      name: basename(path) || path,
      overlap: authors.size >= 2,
      edits,
      scope: "agent-reported-edits",
    };
    return Response.json(body);
  } catch (error) {
    return failure(error);
  }
}
