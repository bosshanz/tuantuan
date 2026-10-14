import type { Message } from "./api";

/** Insert or replace one message by id, keeping chronological order. */
export function upsertMessage(ms: Message[], m: Message): Message[] {
  const i = ms.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const copy = [...ms];
    copy[i] = newer(ms[i] as Message, m);
    return copy;
  }
  const at = ms.findIndex((x) => x.createdAt > m.createdAt);
  return at < 0 ? [...ms, m] : [...ms.slice(0, at), m, ...ms.slice(at)];
}

/** Of two copies of one message, prefer the finished one, then the one with more streamed text. */
function newer(a: Message, b: Message): Message {
  if (a.status === "streaming" && b.status !== "streaming") return b;
  if (b.status === "streaming" && a.status !== "streaming") return a;
  return b.content.length >= a.content.length ? b : a;
}

/** Merge a fetched snapshot with what live events already delivered for this room. */
export function mergeMessages(snapshot: Message[], live: Message[], roomId: string): Message[] {
  let out = snapshot;
  for (const m of live) if (m.roomId === roomId) out = upsertMessage(out, m);
  return out;
}
