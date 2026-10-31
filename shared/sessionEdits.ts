import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Timeline, ToolState } from "./timeline";

/** One completed Agent-reported edit tool call, possibly touching several paths. */
export interface SessionEditEvent {
  toolCallId: string;
  title: string;
  /** Paths this tool touched (locations + diff paths), normalized for aggregation. */
  paths: string[];
  /** Diff text when the tool reported one; keyed by normalized path. */
  diffs: Record<string, { oldText: string; newText: string }>;
}

export interface SessionEditOccurrence {
  toolCallId: string;
  title: string;
  path: string;
  messageId: string;
  seq: number;
  senderId: string | null;
  senderName: string;
  /** Final status of the reply that reported this completed edit. */
  replyStatus: "done" | "error" | "cancelled" | "interrupted";
  createdAt: number;
  oldText: string | null;
  newText: string | null;
}

export interface SessionFileAuthor {
  agentId: string | null;
  agentName: string;
  editCount: number;
  lastAt: number;
}

export interface SessionFileChange {
  /** Aggregation key (project-relative when possible). */
  path: string;
  name: string;
  editCount: number;
  lastAt: number;
  /** Two or more distinct Agents edited this path. */
  overlap: boolean;
  authors: SessionFileAuthor[];
}

/** Strip URL / fragment / line suffixes; reject remote targets. Mirrors conversation-files localPath. */
export function localEditPath(raw: string): string | null {
  if (!raw || raw.length > 8192 || raw.includes("\0") || raw.startsWith("#")) return null;
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname && url.hostname !== "localhost") return null;
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return null;
  if (raw.startsWith("//") || raw.startsWith("\\\\")) return null;
  try {
    return decodeURIComponent(raw.replace(/#(?:L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)?$/, "")).replace(
      /:\d+(?::\d+)?$/,
      "",
    );
  } catch {
    return null;
  }
}

/**
 * Prefer a stable project-relative key so absolute and relative reports of the same file merge.
 * Paths outside cwd keep their cleaned form; `..` escape attempts stay as cleaned strings and
 * never claim to be inside the project.
 */
export function normalizeEditPath(path: string, cwd?: string | null): string {
  const cleaned = localEditPath(path) ?? path;
  if (!cwd || !cleaned || cleaned.includes("\0") || /(^|[\\/])\.\.([\\/]|$)/.test(cleaned)) return cleaned;
  try {
    const absolute = resolve(cwd, cleaned);
    const part = relative(cwd, absolute);
    if (part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
      return part.split(/[\\/]/).join("/");
  } catch {
    /* keep cleaned */
  }
  return cleaned.split(/[\\/]/).join("/");
}

function pathsOf(tool: ToolState): { paths: string[]; diffs: SessionEditEvent["diffs"] } {
  const paths = new Set<string>();
  const diffs: SessionEditEvent["diffs"] = {};
  for (const location of tool.locations ?? []) {
    if (typeof location?.path === "string" && location.path) paths.add(location.path);
  }
  for (const item of tool.content ?? []) {
    if (item && typeof item === "object" && "type" in item && item.type === "diff" && typeof item.path === "string") {
      paths.add(item.path);
      diffs[item.path] = {
        oldText: typeof item.oldText === "string" ? item.oldText : "",
        newText: typeof item.newText === "string" ? item.newText : "",
      };
    }
  }
  return { paths: [...paths], diffs };
}

/** Completed `edit` tools only — shell / format / failed / read never count. */
export function editsFromTimeline(timeline: Timeline | null | undefined): SessionEditEvent[] {
  if (!timeline?.tools) return [];
  const out: SessionEditEvent[] = [];
  for (const tool of Object.values(timeline.tools)) {
    if (tool?.status !== "completed" || tool.kind !== "edit") continue;
    const { paths, diffs } = pathsOf(tool);
    if (!paths.length) continue;
    out.push({
      toolCallId: tool.toolCallId,
      title: tool.title || "edit",
      paths,
      diffs,
    });
  }
  return out;
}

/** Path → edit count for one reply (for owner reflux; no diffs). */
export function editPathCounts(
  timeline: Timeline | null | undefined,
  cwd?: string | null,
): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const event of editsFromTimeline(timeline)) {
    const seen = new Set<string>();
    for (const raw of event.paths) {
      const path = normalizeEditPath(raw, cwd);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
}

export function occurrencesFromMessage(
  message: {
    id: string;
    seq: number;
    senderId: string | null;
    senderName: string;
    status: SessionEditOccurrence["replyStatus"] | "streaming";
    createdAt: number;
    timeline: Timeline | null;
  },
  cwd?: string | null,
): SessionEditOccurrence[] {
  if (message.status === "streaming") return [];
  const out: SessionEditOccurrence[] = [];
  for (const event of editsFromTimeline(message.timeline)) {
    const seen = new Set<string>();
    for (const raw of event.paths) {
      const path = normalizeEditPath(raw, cwd);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const diff = event.diffs[raw] ?? event.diffs[path];
      out.push({
        toolCallId: event.toolCallId,
        title: event.title,
        path,
        messageId: message.id,
        seq: message.seq,
        senderId: message.senderId,
        senderName: message.senderName,
        replyStatus: message.status,
        createdAt: message.createdAt,
        oldText: diff ? diff.oldText : null,
        newText: diff ? diff.newText : null,
      });
    }
  }
  return out;
}

export function aggregateSessionChanges(occurrences: SessionEditOccurrence[]): SessionFileChange[] {
  type Bucket = {
    path: string;
    editCount: number;
    lastAt: number;
    authors: Map<string, SessionFileAuthor>;
  };
  const byPath = new Map<string, Bucket>();
  for (const item of occurrences) {
    let bucket = byPath.get(item.path);
    if (!bucket) {
      bucket = { path: item.path, editCount: 0, lastAt: 0, authors: new Map() };
      byPath.set(item.path, bucket);
    }
    bucket.editCount += 1;
    if (item.createdAt >= bucket.lastAt) bucket.lastAt = item.createdAt;
    const authorKey = item.senderId ?? `name:${item.senderName}`;
    const author = bucket.authors.get(authorKey) ?? {
      agentId: item.senderId,
      agentName: item.senderName,
      editCount: 0,
      lastAt: 0,
    };
    author.editCount += 1;
    if (item.createdAt >= author.lastAt) {
      author.lastAt = item.createdAt;
      author.agentName = item.senderName;
      author.agentId = item.senderId;
    }
    bucket.authors.set(authorKey, author);
  }
  return [...byPath.values()]
    .map((bucket) => {
      const authors = [...bucket.authors.values()].sort(
        (a, b) => b.lastAt - a.lastAt || a.agentName.localeCompare(b.agentName),
      );
      return {
        path: bucket.path,
        name: basename(bucket.path) || bucket.path,
        editCount: bucket.editCount,
        lastAt: bucket.lastAt,
        overlap: authors.length >= 2,
        authors,
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt || a.path.localeCompare(b.path));
}
