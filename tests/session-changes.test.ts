import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionChangeDetail, handleSessionChanges } from "../server/session-changes";
import { type Message, Store } from "../server/store";
import type { SessionChangeDetailResponse, SessionChangesResponse } from "../shared/sessionChanges";
import {
  aggregateSessionChanges,
  editPathCounts,
  editsFromTimeline,
  normalizeEditPath,
  occurrencesFromMessage,
} from "../shared/sessionEdits";
import { emptyTimeline, type Timeline } from "../shared/timeline";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function tool(id: string, kind: string, status = "completed") {
  return {
    toolCallId: id,
    title: id,
    kind,
    status,
    locations: [] as { path: string }[],
    content: [] as Timeline["tools"][string]["content"],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tt-session-changes-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const database = join(root, "chat.sqlite");
  let store = new Store(database);
  cleanup.push(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = store.createProject("changes", cwd);
  const room = store.createRoom("room", [], { projectId: project.id });
  const insert = (tools: Timeline["tools"], patch: Partial<Message> = {}) => {
    const message = store.insertMessage({
      roomId: room.id,
      runId: "run",
      hop: 1,
      senderKind: "agent",
      senderId: patch.senderId ?? "agent-a",
      senderName: patch.senderName ?? "Alpha",
      content: patch.content ?? "done",
      status: "done",
      ...patch,
    });
    return store.updateReply(message.id, {
      content: patch.content ?? "done",
      status: patch.status ?? "done",
      timeline: { ...emptyTimeline(), tools },
    });
  };
  return {
    cwd,
    room,
    insert,
    list: async () => {
      const response = handleSessionChanges(store, room.id);
      expect(response.status).toBe(200);
      return (await response.json()) as SessionChangesResponse;
    },
    detail: async (path: string) => {
      const response = handleSessionChangeDetail(
        store,
        room.id,
        new URL(`http://localhost/api/rooms/${room.id}/changes/detail?path=${encodeURIComponent(path)}`),
      );
      return response;
    },
    reopen() {
      store.db.close();
      store = new Store(database);
    },
    get store() {
      return store;
    },
  };
}

describe("session edit extraction", () => {
  test("keeps completed edits and drops shell, read and failed tools", () => {
    const timeline: Timeline = {
      ...emptyTimeline(),
      tools: {
        e1: {
          ...tool("e1", "edit"),
          content: [{ type: "diff", path: "a.ts", oldText: "1", newText: "2" }],
          locations: [{ path: "a.ts" }],
        },
        shell: {
          ...tool("shell", "execute"),
          content: [{ type: "diff", path: "via-shell.ts", oldText: "", newText: "x" }],
        },
        read: { ...tool("read", "read"), locations: [{ path: "readme.md" }] },
        failed: {
          ...tool("failed", "edit", "failed"),
          content: [{ type: "diff", path: "fail.ts", oldText: "", newText: "" }],
        },
      },
    };
    expect(editsFromTimeline(timeline).map((e) => e.toolCallId)).toEqual(["e1"]);
    expect(editPathCounts(timeline)).toEqual([{ path: "a.ts", count: 1 }]);
  });

  test("normalizes absolute paths under cwd to relative keys", () => {
    const cwd = "/tmp/proj";
    expect(normalizeEditPath(`${cwd}/src/a.ts`, cwd)).toBe("src/a.ts");
    expect(normalizeEditPath("src/a.ts", cwd)).toBe("src/a.ts");
  });
});

describe("session changes API", () => {
  test("aggregates authors, marks overlap, exposes diffs, and survives reopen", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "a.ts"), "base");
    writeFileSync(join(f.cwd, "b.ts"), "base");
    f.insert(
      {
        e1: {
          ...tool("e1", "edit"),
          content: [{ type: "diff", path: "a.ts", oldText: "old-a", newText: "alpha-a" }],
          locations: [{ path: "a.ts" }],
        },
        e2: {
          ...tool("e2", "edit"),
          content: [{ type: "diff", path: "b.ts", oldText: "old-b", newText: "alpha-b" }],
          locations: [{ path: "b.ts" }],
        },
      },
      { senderId: "agent-a", senderName: "Alpha" },
    );
    f.insert(
      {
        e3: {
          ...tool("e3", "edit"),
          content: [{ type: "diff", path: "a.ts", oldText: "alpha-a", newText: "beta-a" }],
          locations: [{ path: "a.ts" }],
        },
      },
      { senderId: "agent-b", senderName: "Beta" },
    );
    // Shell-only change must not appear.
    f.insert(
      {
        sh: {
          ...tool("sh", "execute"),
          content: [{ type: "content", content: { type: "text", text: "sed ..." } }],
        },
      },
      { senderId: "agent-c", senderName: "Sheller" },
    );

    const page = await f.list();
    expect(page.scope).toBe("agent-reported-edits");
    expect(page.items.map((i) => i.path).sort()).toEqual(["a.ts", "b.ts"]);
    const a = page.items.find((i) => i.path === "a.ts");
    const b = page.items.find((i) => i.path === "b.ts");
    expect(a).toMatchObject({ editCount: 2, overlap: true });
    expect(a?.authors.map((x) => x.agentName).sort()).toEqual(["Alpha", "Beta"]);
    expect(b).toMatchObject({ editCount: 1, overlap: false });
    expect(b?.authors.map((x) => x.agentName)).toEqual(["Alpha"]);

    const detailResponse = await f.detail("a.ts");
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as SessionChangeDetailResponse;
    expect(detail.overlap).toBe(true);
    expect(detail.edits).toHaveLength(2);
    expect(detail.edits.map((e) => e.senderName).sort()).toEqual(["Alpha", "Beta"]);
    expect(detail.edits.some((e) => e.newText === "beta-a")).toBe(true);
    expect(detail.edits.some((e) => e.newText === "alpha-a")).toBe(true);

    f.reopen();
    const again = await f.list();
    expect(new Map(again.items.map((i) => [i.path, { editCount: i.editCount, overlap: i.overlap }]))).toEqual(
      new Map([
        ["a.ts", { editCount: 2, overlap: true }],
        ["b.ts", { editCount: 1, overlap: false }],
      ]),
    );
  });

  test("out-of-scope absolute paths still appear as reported edits but detail stays honest", async () => {
    const f = fixture();
    f.insert({
      e1: {
        ...tool("e1", "edit"),
        content: [{ type: "diff", path: "/etc/passwd", oldText: "x", newText: "y" }],
        locations: [{ path: "/etc/passwd" }],
      },
    });
    const page = await f.list();
    expect(page.items.some((i) => i.path.includes("passwd"))).toBe(true);
    // Aggregation is about reported edits; disk preview/download remains gated by conversation-files.
    const occurrences = occurrencesFromMessage(
      {
        id: "m",
        seq: 1,
        senderId: "a",
        senderName: "A",
        createdAt: 1,
        timeline: {
          ...emptyTimeline(),
          tools: {
            e1: {
              ...tool("e1", "edit"),
              content: [{ type: "diff", path: "/etc/passwd", oldText: "x", newText: "y" }],
            },
          },
        },
      },
      f.cwd,
    );
    expect(aggregateSessionChanges(occurrences)[0]?.path).toContain("passwd");
  });
});

describe("room usage aggregation", () => {
  test("usageForRoom totals a room and leaves unreported rooms empty", () => {
    const s = new Store(":memory:");
    cleanup.push(() => s.db.close());
    const empty = s.usageForRoom("missing");
    expect(empty).toMatchObject({ turns: 0, total: 0, cost: null, reporting: false });
    s.logUsage({
      roomId: "r1",
      agentId: "a",
      harness: "mock",
      providerId: null,
      input: 10,
      output: 5,
      total: 15,
      cost: 0.2,
      currency: "USD",
    });
    s.logUsage({
      roomId: "r1",
      agentId: "b",
      harness: "mock",
      providerId: null,
      input: 3,
      output: 1,
      total: 4,
    });
    s.logUsage({
      roomId: "r2",
      agentId: "a",
      harness: "mock",
      providerId: null,
      input: 100,
      output: 100,
      total: 200,
    });
    expect(s.usageForRoom("r1")).toMatchObject({
      turns: 2,
      input: 13,
      output: 6,
      total: 19,
      cost: 0.2,
      reporting: true,
    });
  });
});
