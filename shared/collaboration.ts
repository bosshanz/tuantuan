import type { RoomTask } from "../server/orchestrator";
import type { Message } from "../server/store";
import type { Handoff } from "./timeline";

export interface CollaborationAssignment {
  sourceMessageId: string;
  agentId: string;
  agentName: string;
  task: string;
  messageId: string | null;
  taskId: string | null;
}

export interface CollaborationRun {
  runId: string;
  messages: Message[];
  tasks: RoomTask[];
  assignments: CollaborationAssignment[];
  sourceMessageIds: string[];
  participants: { id: string; name: string }[];
  status: "running" | "error" | "interrupted" | "cancelled" | "unknown" | "done";
  failed: number;
  interrupted: number;
  cancelled: number;
}

/** Attribution belongs to the individual turn, not the room's current leader. */
function validHandoff(source: unknown): source is Handoff {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const handoff = source as Record<string, unknown>;
  return (
    typeof handoff.agentId === "string" &&
    handoff.agentId.trim().length > 0 &&
    typeof handoff.agentName === "string" &&
    handoff.agentName.trim().length > 0 &&
    typeof handoff.task === "string" &&
    handoff.task.trim().length > 0
  );
}

export function isAssistantMessage(message: Pick<Message, "senderKind" | "timeline">): boolean {
  return message.senderKind === "agent" && validHandoff(message.timeline?.handoffFrom) && !message.timeline?.reviewOf;
}

/** Collect only explicitly delegated turns and live child tasks in each request. */
export function collaborationRuns(messages: Message[], tasks: RoomTask[]): Map<string, CollaborationRun> {
  const runs = new Map<string, CollaborationRun>();
  const getRun = (runId: string): CollaborationRun => {
    let run = runs.get(runId);
    if (!run) {
      run = {
        runId,
        messages: [],
        tasks: [],
        assignments: [],
        sourceMessageIds: [],
        participants: [],
        status: "done",
        failed: 0,
        interrupted: 0,
        cancelled: 0,
      };
      runs.set(runId, run);
    }
    return run;
  };
  for (const message of messages) {
    if (!message.runId || !isAssistantMessage(message)) continue;
    getRun(message.runId).messages.push(message);
  }
  const sources = [...messages]
    .filter((message) => message.runId && message.senderKind === "agent" && message.status === "done")
    .sort((a, b) => a.seq - b.seq);
  for (const source of sources) {
    const handoffs: unknown = source.timeline?.handoffs;
    if (!Array.isArray(handoffs)) continue;
    for (const handoff of handoffs) {
      if (!validHandoff(handoff)) continue;
      getRun(source.runId).assignments.push({
        sourceMessageId: source.id,
        agentId: handoff.agentId,
        agentName: handoff.agentName,
        task: handoff.task,
        messageId: null,
        taskId: null,
      });
    }
  }
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    const parent = task.parentTaskId ? tasksById.get(task.parentTaskId) : undefined;
    if (
      !task.runId ||
      !parent ||
      parent.id === task.id ||
      parent.runId !== task.runId ||
      task.coordination === "review" ||
      task.coordination === "lead"
    )
      continue;
    getRun(task.runId).tasks.push(task);
  }
  for (const run of runs.values()) {
    run.messages.sort((a, b) => a.seq - b.seq);
    const sourceById = new Map(
      sources.filter((source) => source.runId === run.runId).map((source) => [source.id, source]),
    );
    const usedMessages = new Set<string>();
    const usedTasks = new Set<string>();
    for (const [index, assignment] of run.assignments.entries()) {
      const source = sourceById.get(assignment.sourceMessageId);
      if (!source?.senderId) continue;
      // Duplicate assignments to the same target from one source are ambiguous.
      if (
        run.assignments.some(
          (other, i) => i !== index && other.sourceMessageId === source.id && other.agentId === assignment.agentId,
        )
      )
        continue;
      const nextSource = run.assignments.slice(index + 1).find((other) => other.agentId === assignment.agentId);
      const beforeSeq = nextSource ? sourceById.get(nextSource.sourceMessageId)?.seq : undefined;
      const matchingMessages = run.messages.filter(
        (message) =>
          !usedMessages.has(message.id) &&
          message.senderId === assignment.agentId &&
          message.timeline?.handoffFrom?.agentId === source.senderId &&
          message.timeline?.handoffFrom?.task === assignment.task &&
          message.seq > source.seq &&
          (beforeSeq === undefined || message.seq < beforeSeq),
      );
      const matchingTasks = run.tasks.filter(
        (task) =>
          !usedTasks.has(task.id) &&
          task.agentId === assignment.agentId &&
          task.text === assignment.task &&
          task.parentTaskId !== null &&
          tasksById.get(task.parentTaskId)?.messageId === source.id,
      );
      if (matchingMessages.length === 1 && matchingMessages[0]) {
        assignment.messageId = matchingMessages[0].id;
        usedMessages.add(matchingMessages[0].id);
      }
      if (
        matchingTasks.length === 1 &&
        matchingTasks[0] &&
        (!assignment.messageId || !matchingTasks[0].messageId || matchingTasks[0].messageId === assignment.messageId)
      ) {
        assignment.taskId = matchingTasks[0].id;
        usedTasks.add(matchingTasks[0].id);
      }
    }
    const sourceIds = new Set<string>();
    for (const assignment of run.assignments) sourceIds.add(assignment.sourceMessageId);
    for (const task of run.tasks) {
      const parentMessageId = task.parentTaskId ? tasksById.get(task.parentTaskId)?.messageId : null;
      if (parentMessageId) sourceIds.add(parentMessageId);
    }
    run.sourceMessageIds = [...sourceIds];
    const participants = new Map<string, string>();
    for (const assignment of run.assignments) participants.set(assignment.agentId, assignment.agentName);
    for (const message of run.messages) {
      // Legacy rows can lack a sender id; retain a stable, visibly named entry
      // instead of dropping an otherwise attributable assistant from the count.
      const id = message.senderId || `name:${message.senderName}`;
      participants.set(id, message.senderName);
    }
    for (const task of run.tasks) participants.set(task.agentId, task.agentName);
    run.participants = [...participants].map(([id, name]) => ({ id, name }));
    run.failed = run.messages.filter((message) => message.status === "error").length;
    run.interrupted = run.messages.filter((message) => message.status === "interrupted").length;
    run.cancelled = run.messages.filter((message) => message.status === "cancelled").length;
    run.status =
      run.tasks.length || run.messages.some((message) => message.status === "streaming")
        ? "running"
        : run.failed
          ? "error"
          : run.interrupted
            ? "interrupted"
            : run.cancelled
              ? "cancelled"
              : run.assignments.some((assignment) => !assignment.messageId && !assignment.taskId)
                ? "unknown"
                : "done";
  }
  return runs;
}

/**
 * Pick the message in the loaded transcript where each collaboration block belongs:
 * right after the first delegation source (or at the first assistant reply when the source is
 * absent/unrecorded), falling back to the run's last loaded message so active runs never jump
 * ahead of the speaker who initiated them.
 */
export function collaborationAnchors(
  messages: Pick<Message, "id" | "runId" | "senderKind" | "timeline">[],
  runs: Map<string, CollaborationRun>,
): Map<string, string> {
  const primary = new Map<string, string>();
  const fallback = new Map<string, string>();
  for (const message of messages) {
    const run = runs.get(message.runId);
    if (!run) continue;
    fallback.set(run.runId, message.id);
    if (!primary.has(run.runId) && (isAssistantMessage(message) || run.sourceMessageIds.includes(message.id))) {
      primary.set(run.runId, message.id);
    }
  }
  const anchors = new Map<string, string>(fallback);
  for (const [runId, messageId] of primary) anchors.set(runId, messageId);
  return anchors;
}
