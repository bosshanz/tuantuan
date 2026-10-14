import type * as acp from "@agentclientprotocol/sdk";
import { applyUpdate, emptyTimeline, type Handoff, type Timeline, timelineText } from "../shared/timeline";
import type { TerminalSnapshot } from "./acp";
import { CUSTOM_HARNESS } from "./custom";
import { harnessSpec } from "./harness";
import type { HarnessHost, PermissionAsk, SessionView } from "./host";
import { mentionsEveryone, parseMentions } from "./mentions";
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

export interface RoomState {
  /** Human message id whose agent chain is executing, if any. */
  activeRunId: string | null;
  queued: number;
}

export interface ImageAttachment {
  mimeType: string;
  /** base64, no data: prefix */
  data: string;
}

interface Trigger {
  agentId: string;
  hop: number;
  /** Set when another agent handed this turn off through the `handoff` tool. */
  from?: Handoff;
}

/** A running agent turn; MCP tool calls from that agent land here. */
interface TurnCtx {
  signal: AbortSignal;
  handoffs: Handoff[];
}

const INTERJECTION = "被新消息打断";
/** Agent-to-agent hand-offs per human message. */
export const MAX_AGENT_HOPS = 5;
/** Group relay (会话转述): messages since this agent last spoke, at most this many / this many characters. */
const GROUP_CONTEXT_MESSAGES = 30;
export const RELAY_MAX_CHARS = 8000;
const RELAY_MESSAGE_MAX_CHARS = 2000;

interface RoomRuntime {
  queue: { msg: Message; images: ImageAttachment[] }[];
  active: { runId: string; abort: AbortController } | null;
  idle: Promise<void>;
}

/**
 * Owns in-flight agent work. Each room runs one human message chain at a time (later messages
 * queue; in groups a new message interrupts). Each agent turn is one ACP session/prompt on that
 * agent's harness; the reply's timeline is persisted and streamed as raw ACP updates.
 */
export class Orchestrator implements ToolProvider {
  private rooms = new Map<string, RoomRuntime>();
  private turns = new Map<string, TurnCtx>(); // `${roomId}|${agentId}`

  constructor(
    private store: Store,
    private host: HarnessHost,
    private publish: (roomId: string, event: RoomEvent) => void,
  ) {}

  postHumanMessage(roomId: string, senderName: string, content: string, images: ImageAttachment[] = []): Message {
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
    });
    if (images.length > 0)
      msg = this.store.updateReply(id, {
        content: text,
        status: "done",
        timeline: { ...emptyTimeline(), parts: images.map((i) => ({ kind: "image" as const, ...i })) },
      });
    this.publish(roomId, { type: "message", message: msg });
    const rt = this.runtime(roomId);
    if (room.kind === "group" && rt.active && !rt.active.abort.signal.aborted)
      rt.active.abort.abort(new DOMException(INTERJECTION, "AbortError"));
    rt.queue.push({ msg, images });
    if (!rt.active && rt.queue.length === 1) rt.idle = this.drain(roomId, rt);
    this.publishState(roomId);
    return msg;
  }

  cancel(roomId: string): boolean {
    const rt = this.rooms.get(roomId);
    if (!rt?.active) return false;
    const dropped = rt.queue.length;
    rt.queue = [];
    rt.active.abort.abort(new DOMException("用户取消", "AbortError"));
    if (dropped > 0) this.system(roomId, rt.active.runId, 0, `已取消；排队中的 ${dropped} 条消息不会再触发 Agent。`);
    return true;
  }

  state(roomId: string): RoomState {
    const rt = this.rooms.get(roomId);
    return { activeRunId: rt?.active?.runId ?? null, queued: rt?.queue.length ?? 0 };
  }

  idle(roomId: string): Promise<void> {
    return this.rooms.get(roomId)?.idle ?? Promise.resolve();
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
    return [context, agent.identity.trim()].filter(Boolean).join("\n\n");
  }

  private runtime(roomId: string): RoomRuntime {
    let rt = this.rooms.get(roomId);
    if (!rt) {
      rt = { queue: [], active: null, idle: Promise.resolve() };
      this.rooms.set(roomId, rt);
    }
    return rt;
  }

  private publishState(roomId: string) {
    this.publish(roomId, { type: "room.state", roomId, state: this.state(roomId) });
  }

  private async drain(roomId: string, rt: RoomRuntime): Promise<void> {
    for (let item = rt.queue[0]; item; item = rt.queue[0]) {
      const abort = new AbortController();
      rt.active = { runId: item.msg.id, abort };
      rt.queue.shift();
      this.publishState(roomId);
      try {
        await this.runChain(item.msg, item.images, abort.signal);
      } catch (e) {
        this.system(roomId, item.msg.id, 0, `内部错误，本轮已停止：${(e as Error).message}`);
      }
      rt.active = null;
      this.publishState(roomId);
    }
  }

  private async runChain(human: Message, images: ImageAttachment[], signal: AbortSignal) {
    const room = this.store.getRoom(human.roomId);
    if (!room) return;
    const members = room.agentIds.map((id) => this.store.getAgent(id)).filter((a): a is Agent => a !== null);

    let initial: string[];
    if (room.kind === "dm") {
      initial = room.agentIds.slice(0, 1);
      if (initial.length === 0) return this.system(room.id, human.id, 0, "该会话的 Agent 已被删除，消息不会得到回复。");
    } else if (mentionsEveryone(human.content)) {
      initial = members.map((m) => m.id);
    } else {
      initial = parseMentions(human.content, members);
      if (initial.length === 0) {
        const main = room.mainAgentId ?? members[0]?.id;
        if (!main) return this.system(room.id, human.id, 0, "会话里还没有 Agent，消息不会得到回复。");
        initial = [main];
      }
    }

    const queue: Trigger[] = initial.map((agentId) => ({ agentId, hop: 1 }));
    const everyone = room.kind === "group" && mentionsEveryone(human.content);
    const replied = new Set<string>();
    let agentHops = 0;
    while (queue.length > 0) {
      if (signal.aborted) return this.noteInterjection(room.id, human.id, signal, queue);
      const t = queue.shift() as Trigger;
      if (t.hop >= 2 && ++agentHops > MAX_AGENT_HOPS) {
        this.system(room.id, human.id, t.hop, `已达到每条消息最多 ${MAX_AGENT_HOPS} 次 Agent 交接的上限。`);
        return;
      }
      const agent = this.store.getAgent(t.agentId);
      if (!agent) continue;
      const { reply, handoffs } = await this.runAgentTurn(room, agent, human, images, t, signal);
      replied.add(agent.id);
      if (reply.status === "cancelled") return this.noteInterjection(room.id, human.id, signal, queue);
      if (reply.status !== "done") continue;
      for (const h of handoffs) {
        // Already queued for this message, or (in an @所有人 round) already answered: don't trigger twice.
        if (queue.some((q) => q.agentId === h.agentId) || (everyone && replied.has(h.agentId))) continue;
        queue.push({
          agentId: h.agentId,
          hop: t.hop + 1,
          from: { agentId: agent.id, agentName: agent.name, task: h.task },
        });
      }
    }
  }

  private noteInterjection(roomId: string, runId: string, signal: AbortSignal, pending: Trigger[]) {
    if ((signal.reason as Error | undefined)?.message !== INTERJECTION || pending.length === 0) return;
    const names = pending.map((x) => `@${this.store.getAgent(x.agentId)?.name ?? x.agentId}`);
    this.system(roomId, runId, 0, `${INTERJECTION}，未执行的触发：${names.join("、")}`);
  }

  /**
   * What the agent is told this turn: the human text in a DM; in a group, a relay (会话转述) of what
   * was said since it last spoke, newest kept when over RELAY_MAX_CHARS, plus the hand-off task if any.
   */
  promptFor(room: Room, agent: Agent, human: Message, images: ImageAttachment[], from?: Handoff): acp.ContentBlock[] {
    const imageBlocks: acp.ContentBlock[] = images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data }));
    if (room.kind === "dm") return [{ type: "text", text: human.content }, ...imageBlocks];
    const history = this.store.recentMessages(room.id, GROUP_CONTEXT_MESSAGES);
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
    let text = `${header}\n\n${kept.join("\n\n")}`;
    if (from)
      text += `\n\n<tuantuan-handoff from="${from.agentName}">\n${from.task}\n</tuantuan-handoff>\n@${from.agentName} 用 handoff 把上面这个任务交给了你，请接手处理。`;
    return [{ type: "text", text }, ...imageBlocks];
  }

  private async runAgentTurn(
    room: Room,
    agent: Agent,
    human: Message,
    images: ImageAttachment[],
    trigger: Trigger,
    signal: AbortSignal,
  ): Promise<{ reply: Message; handoffs: Handoff[] }> {
    const hop = trigger.hop;
    const blocks = this.promptFor(room, agent, human, images, trigger.from);
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
    this.publish(room.id, { type: "message", message: placeholder });
    let timeline: Timeline = trigger.from ? { ...emptyTimeline(), handoffFrom: trigger.from } : emptyTimeline();
    let saved = Date.now();
    const turnKey = `${room.id}|${agent.id}`;
    const turn: TurnCtx = { signal, handoffs: [] };
    this.turns.set(turnKey, turn);
    const finish = (status: Message["status"], error: string | null, stopReason: string | null = null) => {
      if (this.turns.get(turnKey) === turn) this.turns.delete(turnKey);
      timeline = { ...timeline, stopReason };
      if (turn.handoffs.length > 0) timeline.handoffs = turn.handoffs;
      const done = this.store.updateReply(placeholder.id, { content: timelineText(timeline), status, error, timeline });
      this.publish(room.id, { type: "message", message: done });
      return { reply: done, handoffs: status === "done" ? turn.handoffs : [] };
    };
    if (trigger.from)
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
        if (!turn) throw new Error("只能在回复过程中交接");
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
        turn.handoffs.push({ agentId: to.id, agentName: to.name, task: task.slice(0, 4000) });
        return `已交接给 @${to.name}：你这条回复结束后对方会接手。请简短告诉用户你交给了谁，不要替对方完成任务。`;
      }
      default:
        throw new Error(`未知工具：${name}`);
    }
  }

  private system(roomId: string, runId: string, hop: number, content: string) {
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
