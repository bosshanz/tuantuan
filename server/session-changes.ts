import { basename } from "node:path";
import type {
  SessionChangeDetailResponse,
  SessionChangeRequestsResponse,
  SessionChangesResponse,
} from "../shared/sessionChanges";
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

function roomOccurrences(
  store: Store,
  roomId: string,
  runId?: string,
): { cwd: string; items: SessionEditOccurrence[] } {
  const room = store.getRoom(roomId);
  if (!room) throw new ValidationError("会话不存在", 404);
  if (runId !== undefined && !store.hasChangeRequest(roomId, runId))
    throw new ValidationError("请求不存在或不属于当前会话", 404);
  const items: SessionEditOccurrence[] = [];
  for (const message of store.agentEditMessages(roomId, runId)) {
    items.push(...occurrencesFromMessage(message, room.cwd));
  }
  return { cwd: room.cwd, items };
}

function requestedRun(url?: URL): string | undefined {
  const runId = url?.searchParams.get("runId");
  if (runId === null || runId === undefined) return undefined;
  if (!runId.trim() || runId.length > 200) throw new ValidationError("runId 无效");
  return runId;
}

export function handleSessionChangeRequests(store: Store, roomId: string, url: URL): Response {
  try {
    if (!store.getRoom(roomId)) throw new ValidationError("会话不存在", 404);
    const parsePositive = (value: string | null, name: string): number | undefined => {
      if (value === null) return undefined;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ValidationError(`${name} 无效`);
      return Number(value);
    };
    const limit = Math.min(parsePositive(url.searchParams.get("limit"), "limit") ?? 40, 100);
    const beforeSeq = parsePositive(url.searchParams.get("beforeSeq"), "beforeSeq");
    const page = store.changeRequests(roomId, limit + 1, beforeSeq);
    const items = page.slice(0, limit);
    const body: SessionChangeRequestsResponse = {
      items,
      nextBeforeSeq: page.length > limit ? (items.at(-1)?.seq ?? null) : null,
    };
    return Response.json(body);
  } catch (error) {
    return failure(error);
  }
}

export function handleSessionChanges(store: Store, roomId: string, url?: URL): Response {
  try {
    const { items } = roomOccurrences(store, roomId, requestedRun(url));
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
    const { cwd, items } = roomOccurrences(store, roomId, requestedRun(url));
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
