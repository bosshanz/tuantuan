import type * as acp from "@agentclientprotocol/sdk";
import { applyUpdate, emptyTimeline, type Timeline, timelineText } from "../shared/timeline";
import type { TerminalSnapshot } from "./acp";
import type { HarnessHost, PermissionAsk, SessionView } from "./host";
import { mentionsEveryone, parseMentions } from "./mentions";
import type { Agent, Message, Room, Store } from "./store";
import { ValidationError } from "./store";

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
}

const INTERJECTION = "被新消息打断";
/** Agent-to-agent hops per human message (hand-off arrives in M2 via Tuantuan's MCP tool). */
const MAX_AGENT_HOPS = 5;
/** Group context sent with a prompt: messages since this agent last spoke, capped. */
const GROUP_CONTEXT_MESSAGES = 30;

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
export class Orchestrator {
  private rooms = new Map<string, RoomRuntime>();

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
      room.deviceId !== null
        ? "你正通过一台桌面机器人和用户语音对话：回复要简短、口语化，适合朗读。"
        : room.kind === "group"
          ? [
              `你在团团的群聊「${room.name}」里，名字是「${agent.name}」。用户的消息以「[发言者]: 内容」给出。`,
              members.length > 0 ? `群里的其他 Agent：${members.map((m) => `@${m.name}`).join("、")}。` : "",
              room.mainAgentId === agent.id ? "你是本群的主 Agent：没人被 @ 时由你回复。" : "",
              "回复正文里的 @名字 只是普通文字，不会通知任何人。不要在回复开头写「[名字]:」。",
            ]
              .filter(Boolean)
              .join("")
          : `你在团团里和用户私聊，你的名字是「${agent.name}」。`;
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
      if (initial.length === 0) return this.system(room.id, human.id, 0, "该私聊的 Agent 已被删除，消息不会得到回复。");
    } else if (mentionsEveryone(human.content)) {
      initial = members.map((m) => m.id);
    } else {
      initial = parseMentions(human.content, members);
      if (initial.length === 0) {
        const main = room.mainAgentId ?? members[0]?.id;
        if (!main) return this.system(room.id, human.id, 0, "群里还没有 Agent，消息不会得到回复。");
        initial = [main];
      }
    }

    const queue: Trigger[] = initial.map((agentId) => ({ agentId, hop: 1 }));
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
      const reply = await this.runAgentTurn(room, agent, human, images, t.hop, signal);
      if (reply.status === "cancelled") return this.noteInterjection(room.id, human.id, signal, queue);
    }
  }

  private noteInterjection(roomId: string, runId: string, signal: AbortSignal, pending: Trigger[]) {
    if ((signal.reason as Error | undefined)?.message !== INTERJECTION || pending.length === 0) return;
    const names = pending.map((x) => `@${this.store.getAgent(x.agentId)?.name ?? x.agentId}`);
    this.system(roomId, runId, 0, `${INTERJECTION}，未执行的触发：${names.join("、")}`);
  }

  /** What the agent is told this turn: the human text in a DM; in a group, what happened since it last spoke. */
  promptFor(room: Room, agent: Agent, human: Message, images: ImageAttachment[]): acp.ContentBlock[] {
    const imageBlocks: acp.ContentBlock[] = images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data }));
    if (room.kind === "dm") return [{ type: "text", text: human.content }, ...imageBlocks];
    const history = this.store.recentMessages(room.id, GROUP_CONTEXT_MESSAGES);
    const lastOwn = history.findLastIndex(
      (m) => m.senderKind === "agent" && m.senderId === agent.id && m.status === "done",
    );
    const lines = history
      .slice(lastOwn + 1)
      .filter((m) => m.senderKind !== "system" && m.status !== "streaming" && m.content.trim())
      .map((m) => `[${m.senderName}]: ${m.content}`);
    return [{ type: "text", text: lines.join("\n\n") || `[${human.senderName}]: ${human.content}` }, ...imageBlocks];
  }

  private async runAgentTurn(
    room: Room,
    agent: Agent,
    human: Message,
    images: ImageAttachment[],
    hop: number,
    signal: AbortSignal,
  ): Promise<Message> {
    const blocks = this.promptFor(room, agent, human, images);
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
    let timeline: Timeline = emptyTimeline();
    let saved = Date.now();
    const finish = (status: Message["status"], error: string | null, stopReason: string | null = null) => {
      timeline = { ...timeline, stopReason };
      const done = this.store.updateReply(placeholder.id, { content: timelineText(timeline), status, error, timeline });
      this.publish(room.id, { type: "message", message: done });
      return done;
    };
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
