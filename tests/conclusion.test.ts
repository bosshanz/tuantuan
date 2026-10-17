import { afterAll, expect, test } from "bun:test";
import { serve } from "../server/app";
import type { Message } from "../server/store";
import { emptyTimeline, type TaskContext } from "../shared/timeline";
import { agentInput, until } from "./helpers";

const { app, server } = serve({ dbPath: ":memory:" }, 0);
const base = `http://localhost:${server.port}`;
afterAll(() => {
  app.host.shutdown();
  server.stop(true);
});

async function snapshot(roomId: string) {
  return (await (await fetch(`${base}/api/rooms/${roomId}/messages`)).json()) as {
    messages: Message[];
    conclusion: { messageId: string; seq: number; context: TaskContext } | null;
  };
}

function insert(
  roomId: string,
  content: string,
  extra: Partial<Parameters<typeof app.store.insertMessage>[0]> = {},
): Message {
  return app.store.insertMessage({
    roomId,
    runId: "fixture",
    hop: 0,
    senderKind: "human",
    senderId: null,
    senderName: "Andy",
    content,
    status: "done",
    ...extra,
  });
}

function note(
  roomId: string,
  context: TaskContext,
  opts: { hop?: number; reviewOf?: string[]; malformed?: boolean } = {},
): Message {
  const m = insert(roomId, "任务笔记", {
    runId: "fixture",
    hop: opts.hop ?? 1,
    senderKind: "agent",
    senderId: "fixture-agent",
    senderName: "开发工程师",
  });
  return app.store.updateReply(m.id, {
    content: "任务笔记",
    status: "done",
    timeline: {
      ...emptyTimeline(),
      ...(opts.malformed ? { taskContext: { goal: 1 } as unknown as TaskContext } : { taskContext: context }),
      ...(opts.reviewOf ? { reviewOf: opts.reviewOf } : {}),
    },
  });
}

test("a successful root-task note is derived as the conclusion and stays pinned for a quiet round", async () => {
  // The Tuantuan MCP tools (save_context included) are exposed in group rooms.
  const agent = app.store.createAgent(agentInput("ConclusionLive"));
  const mate = app.store.createAgent(agentInput("ConclusionMate"));
  const room = app.store.createRoom("结论卡", [agent.id, mate.id], { mainAgentId: agent.id });
  expect((await snapshot(room.id)).conclusion).toBeNull();

  const context = { goal: "发布 0.2.0", decisions: ["先做三项功能"], pending: ["真实 Harness 手测"] };
  app.orchestrator.postHumanMessage(room.id, "Andy", `/context ${JSON.stringify(context)}`);
  await app.orchestrator.idle(room.id);
  const saved = await until(() =>
    app.store.recentMessages(room.id, 20).find((m) => m.timeline?.taskContext && m.status === "done"),
  );
  expect(saved.hop).toBe(1);
  const first = await snapshot(room.id);
  expect(first.conclusion).toEqual({ messageId: saved.id, seq: saved.seq, context });

  // A later round without a saved note keeps showing the previous conclusion.
  app.orchestrator.postHumanMessage(room.id, "Andy", "随口聊一句");
  await app.orchestrator.idle(room.id);
  const second = await snapshot(room.id);
  expect(second.conclusion).toEqual(first.conclusion);
  // Older notes remain on their own messages; the card is only a derived view.
  expect(second.messages.find((m) => m.id === saved.id)?.timeline?.taskContext).toEqual(context);
});

test("member hand-off notes never become the room conclusion", () => {
  const room = app.store.createRoom("成员笔记", []);
  const root = note(room.id, { goal: "负责人目标", decisions: [], pending: [] });
  const member = note(room.id, { goal: "成员目标", decisions: ["成员决定"], pending: [] }, { hop: 2 });
  expect(member.seq).toBeGreaterThan(root.seq);
  expect(app.store.latestConclusion(room.id)?.messageId).toBe(root.id);
});

test("a coordinator follow-up after member results can replace the conclusion", () => {
  const room = app.store.createRoom("负责人跟进", []);
  note(room.id, { goal: "第一轮", decisions: [], pending: [] });
  const review = note(
    room.id,
    { goal: "汇总后目标", decisions: ["合并成员结果"], pending: [] },
    { hop: 2, reviewOf: ["成员"] },
  );
  expect(app.store.latestConclusion(room.id)).toMatchObject({
    messageId: review.id,
    context: { goal: "汇总后目标" },
  });
});

test("a malformed legacy note cannot hide an older valid conclusion", () => {
  const room = app.store.createRoom("损坏笔记", []);
  const valid = note(room.id, { goal: "有效目标", decisions: [], pending: [] });
  note(room.id, { goal: "无效", decisions: [], pending: [] }, { malformed: true });
  expect(app.store.latestConclusion(room.id)).toEqual({
    messageId: valid.id,
    seq: valid.seq,
    context: { goal: "有效目标", decisions: [], pending: [] },
  });
});

test("an interrupted note is not a conclusion", () => {
  const room = app.store.createRoom("中断笔记", []);
  const m = insert(room.id, "半途", {
    hop: 1,
    senderKind: "agent",
    senderId: "fixture-agent",
    status: "interrupted",
  });
  app.store.updateReply(m.id, {
    content: "半途",
    status: "interrupted",
    timeline: { ...emptyTimeline(), taskContext: { goal: "未完成", decisions: [], pending: [] } },
  });
  expect(app.store.latestConclusion(room.id)).toBeNull();
});
