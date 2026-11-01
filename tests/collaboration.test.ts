import { describe, expect, test } from "bun:test";
import type { RoomTask } from "../server/orchestrator";
import type { Message } from "../server/store";
import { collaborationAnchors, collaborationRuns, isAssistantMessage } from "../shared/collaboration";
import { emptyTimeline } from "../shared/timeline";

const source = { agentId: "lead", agentName: "Leader", task: "Implement" };
function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    roomId: "room",
    seq: 1,
    runId: "run1",
    hop: 2,
    senderKind: "agent",
    senderId: "dev",
    senderName: "Dev",
    content: "result",
    status: "done",
    error: null,
    timeline: { ...emptyTimeline(), handoffFrom: source },
    quote: null,
    createdAt: 1,
    ...overrides,
  };
}
function task(overrides: Partial<RoomTask> = {}): RoomTask {
  return {
    id: "child",
    runId: "run1",
    parentTaskId: "root",
    agentId: "dev",
    agentName: "Dev",
    messageId: null,
    status: "queued",
    text: "Implement",
    coordination: "work",
    ...overrides,
  };
}

describe("collaboration attribution", () => {
  test("only valid handoff evidence marks a reply, regardless of the current leader", () => {
    const delegated = message({ senderId: "former-leader" });
    expect(isAssistantMessage(delegated)).toBe(true);
    for (const invalid of [
      null,
      emptyTimeline(),
      { ...emptyTimeline(), handoffFrom: {} },
      { ...emptyTimeline(), handoffFrom: { ...source, task: "" } },
      { ...emptyTimeline(), handoffFrom: source, reviewOf: ["Dev"] },
    ]) {
      expect(isAssistantMessage(message({ timeline: invalid as Message["timeline"] }))).toBe(false);
    }
    expect(isAssistantMessage(message({ senderKind: "human" }))).toBe(false);
    // Root replies for one explicit mention, multiple mentions or everyone have no handoff source.
    for (const senderId of ["explicit-one", "explicit-two", "everyone"]) {
      expect(isAssistantMessage(message({ senderId, timeline: emptyTimeline() }))).toBe(false);
    }
  });

  test("groups interleaved runs and repeated participants without confusing their results", () => {
    const runs = collaborationRuns(
      [
        message({ id: "late", seq: 5, senderName: "Renamed" }),
        message({ id: "other", seq: 3, runId: "run2" }),
        message({ id: "early", seq: 2, status: "error" }),
        message({ id: "review", seq: 6, timeline: { ...emptyTimeline(), reviewOf: ["Dev"] } }),
        message({ id: "old", seq: 7, timeline: null }),
      ],
      [],
    );
    expect(runs.size).toBe(2);
    expect(runs.get("run1")?.messages.map((m) => m.id)).toEqual(["early", "late"]);
    expect(runs.get("run1")).toMatchObject({
      status: "error",
      failed: 1,
      participants: [{ id: "dev", name: "Renamed" }],
    });
    expect(runs.get("run2")?.messages.map((m) => m.id)).toEqual(["other"]);
  });

  test("queued delegated tasks produce an entry; direct roots, missing parents and reviews do not", () => {
    const root = task({ id: "root", parentTaskId: null, coordination: "lead", agentId: "lead" });
    const child = task();
    const review = task({ id: "review", coordination: "review", agentId: "lead" });
    const direct = task({ id: "direct", runId: "run2", parentTaskId: null, coordination: undefined });
    const orphan = task({ id: "orphan", runId: "run3", parentTaskId: "missing", coordination: undefined });
    const runs = collaborationRuns([], [root, child, review, direct, orphan]);
    expect([...runs.keys()]).toEqual(["run1"]);
    expect(runs.get("run1")).toMatchObject({
      tasks: [child],
      status: "running",
      participants: [{ id: "dev", name: "Dev" }],
    });
    // Explicitly addressed agents can themselves delegate in direct mode.
    expect(
      collaborationRuns(
        [],
        [direct, task({ id: "nested", runId: "run2", parentTaskId: "direct", coordination: undefined })],
      ).get("run2")?.tasks,
    ).toHaveLength(1);
  });

  test("running does not hide failures, interruptions or cancellations", () => {
    const root = task({ id: "root", parentTaskId: null, coordination: "lead" });
    const runs = collaborationRuns(
      [
        message({ id: "error", status: "error" }),
        message({ id: "interrupted", status: "interrupted" }),
        message({ id: "cancelled", status: "cancelled" }),
        message({ id: "stream", status: "streaming" }),
      ],
      [root, task()],
    );
    expect(runs.get("run1")).toMatchObject({ status: "running", failed: 1, interrupted: 1, cancelled: 1 });
    expect(collaborationRuns([message({ status: "interrupted" })], []).get("run1")?.status).toBe("interrupted");
    expect(collaborationRuns([message({ status: "cancelled" })], []).get("run1")?.status).toBe("cancelled");
  });

  test("retains a named participant when legacy delegated messages have no sender id", () => {
    const runs = collaborationRuns(
      [message({ id: "one", senderId: null }), message({ id: "two", senderId: null, seq: 2 })],
      [],
    );
    expect(runs.get("run1")?.participants).toEqual([{ id: "name:Dev", name: "Dev" }]);
    expect(collaborationRuns([message({ senderId: null, timeline: null })], []).size).toBe(0);
  });

  test("keeps a successful assignment with no task or reply as unknown", () => {
    const lead = message({
      id: "lead1",
      seq: 1,
      senderId: "lead",
      timeline: { ...emptyTimeline(), handoffs: [{ agentId: "dev", agentName: "Dev", task: "Implement" }] },
    });
    const run = collaborationRuns([lead], []).get("run1");
    expect(run).toMatchObject({
      status: "unknown",
      participants: [{ id: "dev", name: "Dev" }],
      assignments: [{ sourceMessageId: "lead1", agentId: "dev", task: "Implement", taskId: null, messageId: null }],
    });
    // Unfinished or invalid handoff records never establish an assignment.
    expect(collaborationRuns([{ ...lead, status: "error" }], []).size).toBe(0);
    expect(
      collaborationRuns([{ ...lead, timeline: { ...emptyTimeline(), handoffs: [{}] } as Message["timeline"] }], [])
        .size,
    ).toBe(0);
  });

  test("matches each batch to its actual reply and keeps unmatched later work unknown", () => {
    const lead = (id: string, seq: number, taskText: string) =>
      message({
        id,
        seq,
        senderId: "lead",
        timeline: { ...emptyTimeline(), handoffs: [{ agentId: "dev", agentName: "Dev", task: taskText }] },
      });
    const first = lead("lead1", 1, "Implement");
    const second = lead("lead2", 4, "Verify");
    const reply = message({ id: "reply1", seq: 2 });
    const unrelated = message({ id: "other", runId: "other", seq: 3 });
    const run = collaborationRuns([first, reply, unrelated, second], []).get("run1");
    expect(run?.assignments).toMatchObject([
      { sourceMessageId: "lead1", messageId: "reply1", taskId: null },
      { sourceMessageId: "lead2", messageId: null, taskId: null },
    ]);
    expect(run?.status).toBe("unknown");
    // A reply outside this assignment's sequence window does not settle an earlier batch.
    expect(
      collaborationRuns([first, second, { ...reply, seq: 5 }], []).get("run1")?.assignments[0]?.messageId,
    ).toBeNull();
  });

  test("matches a queued task through its source parent without fabricating a reply", () => {
    const lead = message({
      id: "lead1",
      senderId: "lead",
      timeline: { ...emptyTimeline(), handoffs: [{ agentId: "dev", agentName: "Dev", task: "Implement" }] },
    });
    const root = task({ id: "root", parentTaskId: null, agentId: "lead", messageId: "lead1", coordination: "lead" });
    const run = collaborationRuns([lead], [root, task()]).get("run1");
    expect(run).toMatchObject({ status: "running", assignments: [{ taskId: "child", messageId: null }] });
    const withoutSourceId = collaborationRuns([{ ...lead, senderId: null }], [root, task()]).get("run1");
    expect(withoutSourceId?.assignments[0]).toMatchObject({ taskId: null, messageId: null });
  });

  test("anchors each collaboration block at its first delegation source or assistant reply", () => {
    const human1 = message({ id: "h1", seq: 1, senderKind: "human", senderId: null, timeline: null });
    const leadStart = message({
      id: "lead1",
      seq: 2,
      senderId: "lead",
      timeline: { ...emptyTimeline(), handoffs: [{ agentId: "dev", agentName: "Dev", task: "Implement" }] },
    });
    const worker = message({ id: "dev1", seq: 3 });
    const leadReview = message({
      id: "lead2",
      seq: 4,
      senderId: "lead",
      timeline: { ...emptyTimeline(), reviewOf: ["Dev"] },
    });
    const transcript = [human1, leadStart, worker, leadReview];
    const runs = collaborationRuns(transcript, []);
    expect(runs.get("run1")?.sourceMessageIds).toEqual(["lead1"]);
    expect(collaborationAnchors(transcript, runs).get("run1")).toBe("lead1");

    // When the source reply has no handoff list (or is paged out), anchor at the first assistant reply.
    const unrecordedLead = message({ id: "leadPlain", seq: 2, senderId: "lead", timeline: emptyTimeline() });
    const legacyTranscript = [human1, unrecordedLead, worker, leadReview];
    const legacyRuns = collaborationRuns(legacyTranscript, []);
    expect(collaborationAnchors(legacyTranscript, legacyRuns).get("run1")).toBe("dev1");

    // Active child tasks anchor after their parent reply, or the run's last loaded message as a fallback.
    const root = task({
      id: "root",
      parentTaskId: null,
      agentId: "lead",
      messageId: "leadPlain",
      coordination: "lead",
    });
    const liveRuns = collaborationRuns([human1, unrecordedLead], [root, task()]);
    expect(collaborationAnchors([human1, unrecordedLead], liveRuns).get("run1")).toBe("leadPlain");
    const orphanParent = task({
      id: "root2",
      runId: "run2",
      parentTaskId: null,
      messageId: null,
      coordination: "lead",
    });
    const human2 = message({ id: "h2", runId: "run2", seq: 10, senderKind: "human", senderId: null, timeline: null });
    const fallbackRuns = collaborationRuns(
      [human2],
      [orphanParent, task({ id: "child2", runId: "run2", parentTaskId: "root2" })],
    );
    expect(collaborationAnchors([human2], fallbackRuns).get("run2")).toBe("h2");
  });
});
