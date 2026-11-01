import { messageWithdrawn } from "../../shared/timeline";
import type { Message } from "./api";

/** Insert or replace one message by id, keeping chronological order. */
export function upsertMessage(ms: Message[], m: Message): Message[] {
  const i = ms.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const copy = [...ms];
    copy[i] = newer(ms[i] as Message, m);
    return copy;
  }
  const at = ms.findIndex((x) => messageOrder(x, m) > 0);
  return at < 0 ? [...ms, m] : [...ms.slice(0, at), m, ...ms.slice(at)];
}

function messageOrder(a: Message, b: Message): number {
  return Number.isSafeInteger(a.seq) && Number.isSafeInteger(b.seq) ? a.seq - b.seq : a.createdAt - b.createdAt;
}

/** How far an immediate steer progressed on its human message; sent/interrupted outrank stopping. */
function steerRank(m: Message): number {
  const stage = m.timeline?.steer?.stage;
  return stage === "sent" || stage === "interrupted" ? 2 : stage === "stopping" ? 1 : 0;
}

/**
 * Of two copies of one message, a withdrawn queued message replaces the sent copy.
 * Otherwise prefer the finished one, then the one with more streamed text.
 */
function newer(a: Message, b: Message): Message {
  if (messageWithdrawn(a.timeline) || messageWithdrawn(b.timeline)) return messageWithdrawn(b.timeline) ? b : a;
  if (a.status === "streaming" && b.status !== "streaming") return b;
  if (b.status === "streaming" && a.status !== "streaming") return a;
  if (b.content.length !== a.content.length) return b.content.length > a.content.length ? b : a;
  return steerRank(b) >= steerRank(a) ? b : a;
}

/** Merge a fetched snapshot with what live events already delivered for this room. */
export function mergeMessages(snapshot: Message[], live: Message[], roomId: string): Message[] {
  const byId = new Map<string, Message>();
  for (const m of [...snapshot, ...live]) {
    if (m.roomId !== roomId) continue;
    const previous = byId.get(m.id);
    byId.set(m.id, previous ? newer(previous, m) : m);
  }
  return [...byId.values()].sort(messageOrder);
}
