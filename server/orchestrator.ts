import type * as acp from "@agentclientprotocol/sdk";
import { quotePrompt } from "../shared/messageQuote";
import { applyUpdate, emptyTimeline, type Handoff, type Timeline, timelineText } from "../shared/timeline";
import type { TerminalSnapshot } from "./acp";
import { CUSTOM_HARNESS } from "./custom";
import { harnessSpec } from "./harness";
import type { HarnessHost, PermissionAsk, SessionView } from "./host";
import { mentionsEveryone, parseMentions } from "./mentions";
import { profileInstructions, readProfile } from "./profile";
import type { Agent, Message, Room, Store } from "./store";
import { ValidationError } from "./store";
import type { ToolCtx, ToolDef, ToolProvider } from "./tuantuan-mcp";

export type RoomEvent =
  | { type: "message"; message: Message }
  /** One ACP session/update for a streaming reply; clients fold it with shared/timeline.ts. */
  | { type: "update"; roomId: string; messageId: string; update: acp.SessionUpdate }
  | { type: "room.state"; roomId: string; state: RoomState }
  | { type: "session"; roomId: string; agentId: string; view: SessionView }
  | { type: "permission"; roomId: string; ask: PermissionAsk | null; resolvedId?: string }
  | { type: "terminal"; roomId: string; terminal: TerminalSnapshot };

export interface RoomTask {
  id: string;
  runId: string;
  parentTaskId: string | null;
  agentId: string;
  agentName: string;
  messageId: string | null;
  status: "queued" | "running" | "cancelling" | "waiting";
  text: string;
}

export interface RoomState {
  /** One active human message id, retained as a compatibility busy indicator. */
  activeRunId: string | null;
  queued: number;
  tasks: RoomTask[];
}

export interface ImageAttachment {
  mimeType: string;
  /** base64, no data: prefix */
  data: string;
}

interface Task extends Omit<RoomTask, "status"> {
  status: RoomTask["status"] | "done" | "error" | "cancelled";
  hop: number;
  from?: Handoff;
  abort: AbortController;
  handoffs?: Handoff[];
}

interface Run {
  human: Message;
  images: ImageAttachment[];
  everyone: boolean;
  triggered: Set<string>;
  handoffs: number;
  reservations: Set<string>;
  limitNotified: boolean;
}

/** MCP calls are accepted only while this exact turn is still running. */
interface TurnCtx {
  signal: AbortSignal;
  task: Task;
  run: Run;
  handoffs: Handoff[];
}

/** Agent-to-agent hand-offs per human message. */
export const MAX_AGENT_HOPS = 5;
/** Group relay (会话转述): messages since this agent last spoke, at most this many / this many characters. */
const GROUP_CONTEXT_MESSAGES = 30;
export const RELAY_MAX_CHARS = 8000;
const RELAY_MESSAGE_MAX_CHARS = 2000;

interface RoomRuntime {
  tasks: Map<string, Task>;
  runs: Map<string, Run>;
  idleWaiters: (() => void)[];
}

/** Owns the task graph and one FIFO execution lane per (room, agent). */
export class Orchestrator implements ToolProvider {
  private rooms = new Map<string, RoomRuntime>();
  private closed = false;
  private turns = new Map<string, TurnCtx>(); // `${roomId}|${agentId}`

  constructor(
    private store: Store,
    private host: HarnessHost,
    private publish: (roomId: string, event: RoomEvent) => void,
  ) {}

  postHumanMessage(
    roomId: string,
    senderName: string,
    content: string,
    images: ImageAttachment[] = [],
    replyToId?: string | null,
  ): Message {
    if (this.closed) throw new ValidationError("服务正在关闭", 503);
    const room = this.store.getRoom(roomId);
    if (!room) throw new ValidationError("房间不存在", 404);
    const text = content.trim();
    if (!text && images.length === 0) throw new ValidationError("消息不能为空");
    const id = crypto.randomUUID();
    let msg = this.store.insertMessage({
      id,
      roomId,
      runId: id,
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: senderName.trim() || "我",
      content: text,
      status: "done",
      replyToId,
    });
    if (images.length > 0)
      msg = this.store.updateReply(id, {
        content: text,
        status: "done",
        timeline: { ...emptyTimeline(), parts: images.map((i) => ({ kind: "image" as const, ...i })) },
      });
    this.publish(roomId, { type: "message", message: msg });
    const rt = this.runtime(roomId);
    const members = room.agentIds.map((id) => this.store.getAgent(id)).filter((a): a is Agent => a !== null);
    const everyone = room.kind === "group" && mentionsEveryone(text);
    let initial =
      room.kind === "dm"
        ? room.agentIds.slice(0, 1)
        : everyone
          ? members.map((a) => a.id)
          : parseMentions(text, members);
    if (room.kind === "group" && initial.length === 0)
      initial = [room.mainAgentId ?? members[0]?.id].filter((id): id is string => !!id);
    const run: Run = {
      human: msg,
      images,
      everyone,
      triggered: new Set(initial),
      handoffs: 0,
      reservations: new Set(),
      limitNotified: false,
    };
    if (initial.length === 0) {
      this.system(roomId, id, 0, "会话里还没有 Agent，消息不会得到回复。");
      return msg;
    }
    rt.runs.set(id, run);
    // Register every root before starting any turn, so @所有人 and handoff dedup see the whole run.
    for (const agentId of initial) this.enqueue(rt, run, agentId, null, 1);
    this.pump(roomId, rt);
    return msg;
  }

  cancel(roomId: string, taskId?: string): boolean {
    const rt = this.rooms.get(roomId);
    if (!rt) return false;
    if (!taskId) {
      if (this.store.getRoom(roomId)?.kind !== "dm") return false;
      taskId = [...rt.tasks.values()].find((t) => t.status === "running" || t.status === "cancelling")?.id;
    }
    const task = taskId ? rt.tasks.get(taskId) : undefined;
    if (!task || !this.visibleTasks(rt).some((t) => t.id === task.id)) return false;
    this.cancelTasks(roomId, rt, new Set([task.id]));
    return true;
  }

  /** Destructive room/project operations explicitly discard all work. */
  cancelAll(roomId: string): boolean {
    const rt = this.rooms.get(roomId);
    if (!rt || rt.tasks.size === 0) return false;
    this.cancelTasks(roomId, rt, new Set(rt.tasks.keys()));
    return true;
  }

  cancelAgent(roomId: string, agentId: string): boolean {
    const rt = this.rooms.get(roomId);
    if (!rt) return false;
    const ids = new Set([...rt.tasks.values()].filter((t) => t.agentId === agentId).map((t) => t.id));
    if (ids.size === 0) return false;
    this.cancelTasks(roomId, rt, ids);
    return true;
  }

  shutdown() {
    this.closed = true;
    for (const roomId of this.rooms.keys()) this.cancelAll(roomId);
  }

  state(roomId: string): RoomState {
    const rt = this.rooms.get(roomId);
    const tasks = rt ? this.visibleTasks(rt) : [];
    return { activeRunId: tasks[0]?.runId ?? null, queued: tasks.filter((t) => t.status === "queued").length, tasks };
  }

  idle(roomId: string): Promise<void> {
    const rt = this.rooms.get(roomId);
    if (!rt || rt.runs.size === 0) return Promise.resolve();
    // Resolve on quiescence, after derived handoffs are registered, rather than taking a promise snapshot.
    return new Promise((resolve) => rt.idleWaiters.push(resolve));
  }

  /** Identity doc + room context for an agent, delivered to its harness (plan §3.4). */
  identityFor(room: Room, agent: Agent): string {
    const members = room.agentIds
      .map((id) => this.store.getAgent(id))
      .filter((a): a is Agent => a !== null && a.id !== agent.id);
    const context =
      room.kind === "group"
        ? [
            `你在团团的会话「${room.name}」里，名字是「${agent.name}」。用户的消息以「[发言者]: 内容」给出。`,
            members.length > 0 ? `会话里的其他 Agent：${members.map((m) => `@${m.name}`).join("、")}。` : "",
            room.mainAgentId === agent.id ? "你是本会话的主 Agent：没人被 @ 时由你回复。" : "",
            "回复正文里的 @名字 只是普通文字，不会通知任何人。需要别的成员现在动手时，调用 tuantuan 的 handoff 工具（agent=对方名字，task=要对方做的事），对方会在你这条回复结束后接手；只在用户这次的请求确实需要对方时交接，不要用来介绍别人。不要在回复开头写「[名字]:」。",
          ]
            .filter(Boolean)
            .join("")
        : `你在团团里和用户对话，你的名字是「${agent.name}」。`;
    const about = agent.useProfile ? profileInstructions(readProfile(this.store.getSetting("profile", {}))) : "";
    return [context, agent.identity.trim(), about].filter(Boolean).join("\n\n");
  }

  private runtime(roomId: string): RoomRuntime {
    let rt = this.rooms.get(roomId);
    if (!rt) {
      rt = { tasks: new Map(), runs: new Map(), idleWaiters: [] };
      this.rooms.set(roomId, rt);
    }
    return rt;
  }

  private enqueue(rt: RoomRuntime, run: Run, agentId: string, parent: Task | null, hop: number, from?: Handoff) {
    const task: Task = {
      id: crypto.randomUUID(),
      runId: run.human.id,
      parentTaskId: parent?.id ?? null,
      agentId,
      agentName: this.store.getAgent(agentId)?.name ?? agentId,
      messageId: null,
      status: "queued",
      text: from?.task ?? run.human.content,
      hop,
      from,
      abort: new AbortController(),
    };
    rt.tasks.set(task.id, task);
    return task;
  }

  private isActive(task: Task): boolean {
    return task.status === "queued" || task.status === "running" || task.status === "cancelling";
  }

  private visibleTasks(rt: RoomRuntime): RoomTask[] {
    const visible = new Set<string>();
    for (const task of rt.tasks.values()) {
      if (!this.isActive(task)) continue;
      let ancestor: Task | undefined = task;
      while (ancestor && !visible.has(ancestor.id)) {
        visible.add(ancestor.id);
        ancestor = ancestor.parentTaskId ? rt.tasks.get(ancestor.parentTaskId) : undefined;
      }
    }
    return [...rt.tasks.values()]
      .filter((t) => visible.has(t.id))
      .map((t) => ({
        id: t.id,
        runId: t.runId,
        parentTaskId: t.parentTaskId,
        agentId: t.agentId,
        agentName: t.agentName,
        messageId: t.messageId,
        text: t.text,
        status: this.isActive(t) ? (t.status as RoomTask["status"]) : "waiting",
      }));
  }

  private publishState(roomId: string) {
    this.publish(roomId, { type: "room.state", roomId, state: this.state(roomId) });
  }

  private cancelTasks(roomId: string, rt: RoomRuntime, ids: Set<string>) {
    // A task owns only descendants created from its accepted handoffs, never sibling roots.
    for (const task of rt.tasks.values()) if (task.parentTaskId && ids.has(task.parentTaskId)) ids.add(task.id);
    for (const id of ids) {
      const task = rt.tasks.get(id);
      if (!task) continue;
      task.abort.abort(new DOMException("用户取消", "AbortError"));
      if (task.status === "queued") task.status = "cancelled";
      else if (task.status === "running") task.status = "cancelling";
    }
    this.pump(roomId, rt);
  }

  private pump(roomId: string, rt: RoomRuntime) {
    const busy = new Set(
      [...rt.tasks.values()].filter((t) => t.status === "running" || t.status === "cancelling").map((t) => t.agentId),
    );
    for (const task of rt.tasks.values()) {
      if (task.status !== "queued" || busy.has(task.agentId)) continue;
      const room = this.store.getRoom(roomId);
      const agent = this.store.getAgent(task.agentId);
      const run = rt.runs.get(task.runId);
      if (this.closed || !room || !agent || !room.agentIds.includes(task.agentId) || !run) {
        task.status = "cancelled";
        continue;
      }
      task.status = "running";
      busy.add(task.agentId);
      void this.execute(room, agent, run, task, rt);
    }
    for (const runId of rt.runs.keys()) {
      if ([...rt.tasks.values()].some((t) => t.runId === runId && this.isActive(t))) continue;
      rt.runs.delete(runId);
      for (const [id, task] of rt.tasks) if (task.runId === runId) rt.tasks.delete(id);
    }
    this.publishState(roomId);
    if (rt.runs.size === 0) {
      this.rooms.delete(roomId);
      for (const resolve of rt.idleWaiters.splice(0)) resolve();
    }
  }

  private async execute(room: Room, agent: Agent, run: Run, task: Task, rt: RoomRuntime) {
    try {
      const { reply, handoffs } = await this.runAgentTurn(room, agent, run, task);
      task.status = reply.status === "done" ? "done" : reply.status === "cancelled" ? "cancelled" : "error";
      if (reply.status === "done" && !task.abort.signal.aborted && this.store.getRoom(room.id)) {
        for (const h of handoffs) {
          run.triggered.add(h.agentId);
          this.enqueue(rt, run, h.agentId, task, task.hop + 1, {
            agentId: agent.id,
            agentName: agent.name,
            task: h.task,
          });
        }
      }
    } catch (e) {
      task.status = task.abort.signal.aborted ? "cancelled" : "error";
      if (!task.abort.signal.aborted)
        this.system(room.id, run.human.id, task.hop, `内部错误，本任务已停止：${(e as Error).message}`);
    } finally {
      const turn = this.turns.get(`${room.id}|${agent.id}`);
      if (turn?.task === task) this.turns.delete(`${room.id}|${agent.id}`);
      // Reservations outlive the host promise until children are atomically registered.
      for (const h of task.handoffs ?? []) run.reservations.delete(h.agentId);
      if (task.status !== "done" || task.abort.signal.aborted) run.handoffs -= task.handoffs?.length ?? 0;
      this.pump(room.id, rt);
    }
  }

  /**
   * What the agent is told this turn: the human text in a DM; in a group, a relay (会话转述) of what
   * was said since it last spoke, newest kept when over RELAY_MAX_CHARS, plus the hand-off task if any.
   */
  promptFor(room: Room, agent: Agent, human: Message, images: ImageAttachment[], from?: Handoff): acp.ContentBlock[] {
    const quoted = human.quote ? `${quotePrompt(human.quote)}\n\n` : "";
    const imageBlocks: acp.ContentBlock[] = images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data }));
    if (room.kind === "dm") return [{ type: "text", text: quoted + human.content }, ...imageBlocks];
    const history = this.store.recentMessages(room.id, GROUP_CONTEXT_MESSAGES, human.seq + 1);
    // Later independent messages cannot replace this task. Handoffs also see their own run's completed replies.
    if (from)
      history.push(
        ...this.store
          .recentMessages(room.id, GROUP_CONTEXT_MESSAGES)
          .filter((m) => m.seq > human.seq && m.runId === human.id && m.senderKind === "agent" && m.status === "done"),
      );
    const lastOwn = history.findLastIndex(
      (m) => m.senderKind === "agent" && m.senderId === agent.id && m.status === "done",
    );
    const fresh = history
      .slice(lastOwn + 1)
      .filter((m) => m.senderKind !== "system" && m.status !== "streaming" && m.content.trim())
      .map((m) => {
        const body = m.content.trim();
        const clipped =
          body.length > RELAY_MESSAGE_MAX_CHARS ? `${body.slice(0, RELAY_MESSAGE_MAX_CHARS)}…（已截断）` : body;
        return `[${m.senderName}${m.senderKind === "agent" ? "（Agent）" : ""}]: ${clipped}`;
      });
    const kept: string[] = [];
    let budget = RELAY_MAX_CHARS;
    for (let i = fresh.length - 1; i >= 0; i--) {
      const line = fresh[i] as string;
      if (line.length > budget && kept.length > 0) break;
      kept.unshift(line);
      budget -= line.length;
    }
    if (kept.length === 0) kept.push(`[${human.senderName}]: ${human.content}`);
    const omitted = fresh.length - kept.length;
    const header = `${lastOwn >= 0 ? "你上次发言之后，会话里的新消息" : "会话里最近的消息"}${
      omitted > 0 ? `（更早的 ${omitted} 条已省略）` : ""
    }：`;
    let text = `${header}\n\n${kept.join("\n\n")}\n\n<tuantuan-task>\n${quoted}[${human.senderName}]: ${human.content}\n</tuantuan-task>`;
    if (from)
      text += `\n\n<tuantuan-handoff from="${from.agentName}">\n${from.task}\n</tuantuan-handoff>\n@${from.agentName} 用 handoff 把上面这个任务交给了你，请接手处理。`;
    return [{ type: "text", text }, ...imageBlocks];
  }

  private async runAgentTurn(
    room: Room,
    agent: Agent,
    run: Run,
    task: Task,
  ): Promise<{ reply: Message; handoffs: Handoff[] }> {
    const { human, images } = run;
    const signal = task.abort.signal;
    const hop = task.hop;
    const blocks = this.promptFor(room, agent, human, images, task.from);
    const placeholder = this.store.insertMessage({
      roomId: room.id,
      runId: human.id,
      hop,
      senderKind: "agent",
      senderId: agent.id,
      senderName: agent.name,
      content: "",
      status: "streaming",
    });
    task.messageId = placeholder.id;
    this.publish(room.id, { type: "message", message: placeholder });
    let timeline: Timeline = task.from ? { ...emptyTimeline(), handoffFrom: task.from } : emptyTimeline();
    let saved = Date.now();
    const turnKey = `${room.id}|${agent.id}`;
    const turn: TurnCtx = { signal, task, run, handoffs: [] };
    task.handoffs = turn.handoffs;
    this.turns.set(turnKey, turn);
    const finish = (status: Message["status"], error: string | null, stopReason: string | null = null) => {
      if (this.turns.get(turnKey) === turn) this.turns.delete(turnKey);
      timeline = { ...timeline, stopReason };
      if (turn.handoffs.length > 0) timeline.handoffs = turn.handoffs;
      // A room may be deleted while its harness is acknowledging cancellation.
      const done = this.store.getMessage(placeholder.id)
        ? this.store.updateReply(placeholder.id, { content: timelineText(timeline), status, error, timeline })
        : { ...placeholder, content: timelineText(timeline), status, error, timeline };
      if (this.store.getMessage(placeholder.id)) this.publish(room.id, { type: "message", message: done });
      return { reply: done, handoffs: status === "done" ? turn.handoffs : [] };
    };
    if (task.from)
      this.publish(room.id, {
        type: "message",
        message: this.store.updateReply(placeholder.id, { content: "", status: "streaming", timeline }),
      });
    try {
      const { stopReason } = await this.host.prompt(
        room,
        agent,
        this.identityFor(room, agent),
        blocks,
        (update) => {
          if (signal.aborted || !this.store.getMessage(placeholder.id)) return;
          const next = applyUpdate(timeline, update);
          if (next === timeline) return;
          timeline = next;
          this.publish(room.id, { type: "update", roomId: room.id, messageId: placeholder.id, update });
          // Checkpoint so a refresh mid-reply still shows progress.
          if (Date.now() - saved > 1000) {
            saved = Date.now();
            this.store.updateReply(placeholder.id, { content: timelineText(timeline), status: "streaming", timeline });
          }
        },
        signal,
      );
      if (stopReason === "cancelled" || signal.aborted)
        return finish("cancelled", (signal.reason as Error | undefined)?.message || "已取消", stopReason);
      if (stopReason === "refusal") return finish("error", "Agent 拒绝了这个请求", stopReason);
      if (stopReason === "max_tokens" || stopReason === "max_turn_requests")
        return finish("error", `回复未完成（${stopReason}）`, stopReason);
      return finish("done", null, stopReason);
    } catch (e) {
      if (signal.aborted) return finish("cancelled", (signal.reason as Error | undefined)?.message || "已取消");
      return finish("error", (e as Error).message);
    }
  }

  // ---- Tuantuan MCP tools (server/tuantuan-mcp.ts) ----

  captureContext(ctx: ToolCtx): ToolCtx {
    const turn = this.turns.get(`${ctx.roomId}|${ctx.agentId}`);
    return { ...ctx, taskId: turn?.task.id ?? null };
  }

  tools(ctx: ToolCtx): ToolDef[] {
    const room = this.store.getRoom(ctx.roomId);
    if (!room?.agentIds.includes(ctx.agentId)) return [];
    if (room.kind !== "group") return [];
    return [
      {
        name: "handoff",
        description:
          "把任务交给会话里的另一个 Agent：你这条回复结束后，对方会收到 task 并接手。只在用户的请求确实需要对方现在动手时使用；回复正文里写 @名字 不会通知对方。",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "对方的名字（不带 @）" },
            task: { type: "string", description: "要对方做的事，写清楚上下文" },
          },
          required: ["agent", "task"],
        },
      },
      {
        name: "list_members",
        description: "列出会话里的 Agent 成员（名字、Harness、谁是主 Agent）。",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  }

  async call(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<string> {
    const room = this.store.getRoom(ctx.roomId);
    if (!room) throw new Error("会话不存在");
    const turn = this.turns.get(`${ctx.roomId}|${ctx.agentId}`);
    const members = room.agentIds.map((id) => this.store.getAgent(id)).filter((a): a is Agent => a !== null);
    switch (name) {
      case "list_members":
        return members
          .map(
            (m) =>
              `@${m.name}${m.id === ctx.agentId ? "（你）" : ""}${m.id === room.mainAgentId ? "（主 Agent）" : ""} · ${
                (m.harness === CUSTOM_HARNESS ? "自定义 API" : harnessSpec(m.harness)?.name) ?? "未绑定 Harness"
              }`,
          )
          .join("\n");
      case "handoff": {
        if (!turn || turn.signal.aborted) throw new Error("只能在未取消的回复过程中交接");
        if (ctx.taskId !== undefined && ctx.taskId !== turn.task.id)
          throw new Error("交接请求不属于当前任务，原任务已结束或请求到达时没有任务");
        const target = String(args.agent ?? "")
          .trim()
          .replace(/^@/, "");
        const task = String(args.task ?? "").trim();
        if (!task) throw new Error("task 不能为空");
        const to = members.find((m) => m.name.toLowerCase() === target.toLowerCase());
        if (!to)
          throw new Error(
            `会话里没有「${target}」。可以交接给：${members
              .filter((m) => m.id !== ctx.agentId)
              .map((m) => m.name)
              .join("、")}`,
          );
        if (to.id === ctx.agentId) throw new Error("不能交接给自己");
        if (turn.handoffs.some((h) => h.agentId === to.id)) return `这条回复已经交接给 @${to.name} 了。`;
        const rt = this.rooms.get(ctx.roomId) as RoomRuntime;
        const duplicate =
          [...rt.tasks.values()].some((t) => t.runId === turn.task.runId && t.agentId === to.id && this.isActive(t)) ||
          turn.run.reservations.has(to.id);
        if (duplicate || (turn.run.everyone && turn.run.triggered.has(to.id)))
          return `@${to.name} 已有本轮任务，本次交接已忽略。`;
        if (turn.run.handoffs >= MAX_AGENT_HOPS) {
          if (!turn.run.limitNotified) {
            turn.run.limitNotified = true;
            this.system(
              ctx.roomId,
              turn.task.runId,
              turn.task.hop,
              `已达到每条消息最多 ${MAX_AGENT_HOPS} 次 Agent 交接的上限。`,
            );
          }
          return `已达到最多 ${MAX_AGENT_HOPS} 次 Agent 交接的上限，本次交接已忽略。`;
        }
        // Reserve synchronously before returning to concurrent callers in other agent lanes.
        turn.run.handoffs++;
        turn.run.reservations.add(to.id);
        turn.handoffs.push({ agentId: to.id, agentName: to.name, task: task.slice(0, 4000) });
        return `已交接给 @${to.name}：你这条回复结束后对方会接手。请简短告诉用户你交给了谁，不要替对方完成任务。`;
      }
      default:
        throw new Error(`未知工具：${name}`);
    }
  }

  private system(roomId: string, runId: string, hop: number, content: string) {
    if (!this.store.getRoom(roomId)) return;
    const msg = this.store.insertMessage({
      roomId,
      runId,
      hop,
      senderKind: "system",
      senderId: null,
      senderName: "系统",
      content,
      status: "done",
    });
    this.publish(roomId, { type: "message", message: msg });
  }
}
