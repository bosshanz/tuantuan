import type { AppConfig } from "./config";
import type { ChatMessage } from "./llm";
import type { McpConnections } from "./mcp";
import { mentionsEveryone, parseMentions } from "./mentions";
import { pickResponder, type Selection } from "./picker";
import { type Attempt, planRoute, type RoutingPlan } from "./router";
import { type Skill, skillCatalogPrompt } from "./skills";
import type { Agent, Message, RoutingDecision, Store } from "./store";
import { ValidationError } from "./store";
import { runToolLoop, type ToolCallRecord } from "./tool-loop";
import { buildToolRuntime, type DeviceControl, HANDOFF_TOOL } from "./tools";

export type RoomEvent =
  | { type: "message"; message: Message }
  | { type: "delta"; roomId: string; messageId: string; text: string }
  | { type: "tools"; roomId: string; messageId: string; toolCalls: ToolCallRecord[] }
  | { type: "routing"; roomId: string; decision: RoutingDecision }
  | { type: "room.state"; roomId: string; state: RoomState };

export interface RoomState {
  /** Human message id whose agent chain is executing, if any. */
  activeRunId: string | null;
  queued: number;
}

interface Trigger {
  agentId: string;
  hop: number;
  selection?: Selection;
  /** Set when another agent handed this work over via the handoff tool. */
  handoff?: Handoff;
}

export interface Handoff {
  fromName: string;
  task: string;
}

const INTERJECTION = "被新消息打断";

interface RoomRuntime {
  queue: Message[];
  active: { runId: string; abort: AbortController } | null;
  /** Resolves when the queue is drained; used by tests and graceful shutdown. */
  idle: Promise<void>;
}

/**
 * Owns all in-flight agent work. Each room processes one human message chain at a
 * time (later human messages queue); within a chain agents run sequentially in
 * trigger order. Persistent results go to the Store; live progress goes to `publish`.
 */
export class Orchestrator {
  private rooms = new Map<string, RoomRuntime>();

  constructor(
    private store: Store,
    private config: AppConfig,
    private skills: Skill[],
    private mcp: McpConnections,
    private publish: (roomId: string, event: RoomEvent) => void,
    private devices: { controlFor(roomId: string): DeviceControl | null } | null = null,
  ) {}

  postHumanMessage(roomId: string, senderName: string, content: string): Message {
    const room = this.store.getRoom(roomId);
    if (!room) throw new ValidationError("房间不存在", 404);
    const text = content.trim();
    if (!text) throw new ValidationError("消息不能为空");
    const name = senderName.trim() || "我";
    const id = crypto.randomUUID();
    const msg = this.store.insertMessage({
      id,
      roomId,
      runId: id,
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: name,
      content: text,
      status: "done",
    });
    this.publish(roomId, { type: "message", message: msg });
    const rt = this.runtime(roomId);
    // Group interjection: a new human message stops the running chain (in-flight reply and
    // pending hops) so the conversation follows the user. DMs keep queueing in order.
    if (room.kind === "group" && rt.active && !rt.active.abort.signal.aborted)
      rt.active.abort.abort(new DOMException(INTERJECTION, "AbortError"));
    rt.queue.push(msg);
    if (!rt.active && rt.queue.length === 1) rt.idle = this.drain(roomId, rt);
    this.publishState(roomId);
    return msg;
  }

  /** Aborts the running chain and drops queued human messages. Returns false if nothing was running. */
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
    for (let msg = rt.queue[0]; msg; msg = rt.queue[0]) {
      const abort = new AbortController();
      rt.active = { runId: msg.id, abort };
      rt.queue.shift();
      this.publishState(roomId);
      try {
        await this.runChain(msg, abort.signal);
      } catch (e) {
        this.system(roomId, msg.id, 0, `内部错误，本轮已停止：${(e as Error).message}`);
      }
      rt.active = null;
      this.publishState(roomId);
    }
  }

  private async runChain(human: Message, signal: AbortSignal) {
    const room = this.store.getRoom(human.roomId);
    if (!room) return;
    const members = () =>
      (this.store.getRoom(human.roomId)?.agentIds ?? [])
        .map((id) => this.store.getAgent(id))
        .filter((a): a is Agent => a !== null);

    let initial: string[];
    let fanOut = false;
    let selection: Selection | undefined;
    if (room.kind === "dm") {
      initial = room.agentIds.slice(0, 1);
      if (initial.length === 0) {
        this.system(room.id, human.id, 0, "该私聊的 Agent 已被删除，消息不会得到回复。");
        return;
      }
    } else if (mentionsEveryone(human.content)) {
      fanOut = true;
      initial = members().map((m) => m.id);
    } else {
      initial = parseMentions(human.content, members());
      if (initial.length === 0) {
        const pool = members();
        if (pool.length === 0) {
          this.system(room.id, human.id, 0, "群里还没有 Agent，消息不会得到回复。");
          return;
        }
        try {
          selection = await pickResponder(this.config, human.content, pool, signal);
        } catch (e) {
          if (signal.aborted) return;
          throw e;
        }
        initial = [selection.agentId];
      }
    }

    const queue: Trigger[] = initial.map((agentId) => ({ agentId, hop: 1, selection }));
    const replied = new Set<string>();
    const maxHops = this.config.limits.maxAgentHops;
    let agentHops = 0;
    while (queue.length > 0) {
      if (signal.aborted) return this.noteInterjection(room.id, human.id, signal, queue);
      const t = queue.shift() as Trigger;
      // In an @所有人 turn every member answers once; hand-offs to someone who already answered are skipped.
      if (fanOut && replied.has(t.agentId)) continue;
      if (t.hop >= 2) {
        if (agentHops >= maxHops) {
          const skipped = [t, ...queue].map((x) => this.store.getAgent(x.agentId)?.name ?? x.agentId);
          this.system(
            room.id,
            human.id,
            t.hop,
            `已达到每条消息最多 ${maxHops} 次 Agent 互相 @ 的上限，未执行的触发：${skipped.map((n) => `@${n}`).join("、")}`,
          );
          return;
        }
        agentHops++;
      }
      const agent = this.store.getAgent(t.agentId);
      if (!agent) continue;
      replied.add(agent.id);
      const handoffs: { agentId: string; task: string }[] = [];
      const reply = await this.runAgentTurn(agent, human, t.hop, members(), signal, t.selection, t.handoff, handoffs);
      if (reply.status !== "done") {
        if (reply.status === "cancelled") return this.noteInterjection(room.id, human.id, signal, queue);
        continue;
      }
      // Only explicit handoff tool calls trigger other agents; "@名字" in reply text is display-only.
      // An agent already waiting in the queue is not queued twice (e.g. human @A @B, then A hands off to B).
      for (const h of handoffs)
        if (!queue.some((q) => q.agentId === h.agentId) && !(fanOut && replied.has(h.agentId)))
          queue.push({ agentId: h.agentId, hop: t.hop + 1, handoff: { fromName: agent.name, task: h.task } });
    }
  }

  /** After an interjection, says which pending hand-offs were dropped (silent for user cancel, which reports itself). */
  private noteInterjection(roomId: string, runId: string, signal: AbortSignal, pending: Trigger[]) {
    if ((signal.reason as Error | undefined)?.message !== INTERJECTION || pending.length === 0) return;
    const names = pending.map((x) => `@${this.store.getAgent(x.agentId)?.name ?? x.agentId}`);
    this.system(roomId, runId, 0, `${INTERJECTION}，未执行的触发：${names.join("、")}`);
  }

  private async runAgentTurn(
    agent: Agent,
    human: Message,
    hop: number,
    members: Agent[],
    signal: AbortSignal,
    selection?: Selection,
    handoff?: Handoff,
    handoffsOut?: { agentId: string; task: string }[],
  ): Promise<Message> {
    const { limits } = this.config;
    const history = this.store.recentMessages(human.roomId, limits.contextMessages);
    const placeholder = this.store.insertMessage({
      roomId: human.roomId,
      runId: human.id,
      hop,
      senderKind: "agent",
      senderId: agent.id,
      senderName: agent.name,
      content: "",
      status: "streaming",
    });
    this.publish(human.roomId, { type: "message", message: placeholder });

    const skills = this.skills.filter((s) => agent.skills.includes(s.name));
    const room = this.store.getRoom(human.roomId);
    const device = this.devices?.controlFor(human.roomId) ?? undefined;
    const isGroup = room?.kind === "group" && device === undefined;
    let systemPrompt = buildSystemPrompt(agent, members, room?.kind ?? "group", skills, device !== undefined);
    if (handoff) systemPrompt += `\n\n「${handoff.fromName}」把这项工作交给了你：${handoff.task}`;
    const messages = buildContext(systemPrompt, agent, history, limits.contextChars);
    const trigger = [...history].reverse().find((m) => m.senderKind !== "system" && m.senderId !== agent.id);

    let content = "";
    let toolCalls: ToolCallRecord[] = [];
    const attempts: Attempt[] = [];
    let plan: RoutingPlan | null = null;
    let chosenModel: string | null = null;
    const finish = (status: Message["status"], error: string | null) => {
      if (plan) {
        const decision = { messageId: placeholder.id, plan, attempts, chosenModel, createdAt: Date.now() };
        this.store.saveRouting(decision);
        this.publish(human.roomId, { type: "routing", roomId: human.roomId, decision });
      }
      const done = this.store.finishMessage(placeholder.id, { content, status, error, toolCalls });
      this.publish(human.roomId, { type: "message", message: done });
      return done;
    };

    try {
      const { runtime, warnings } = await buildToolRuntime({
        toolIds: agent.tools,
        skills,
        mcpServers: this.store.listMcpServers(),
        mcp: this.mcp,
        device,
        handoff:
          isGroup && handoffsOut
            ? {
                targets: members.filter((m) => m.id !== agent.id).map((m) => ({ id: m.id, name: m.name })),
                record: (target, task) => {
                  if (!handoffsOut.some((h) => h.agentId === target.id)) handoffsOut.push({ agentId: target.id, task });
                },
              }
            : undefined,
      });
      const contextChars = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
      plan = await planRoute(
        this.config,
        agent,
        {
          text: trigger?.content ?? human.content,
          contextTokens: Math.ceil(contextChars / 3),
          toolCount: runtime.specs.filter((s) => s.function.name !== HANDOFF_TOOL).length,
          hasImages: false,
        },
        signal,
      );
      if (warnings.length > 0) plan.reason += `；工具警告：${warnings.join("；")}`;
      if (selection) plan.selection = selection;
      this.publish(human.roomId, {
        type: "routing",
        roomId: human.roomId,
        decision: { messageId: placeholder.id, plan, attempts: [], chosenModel: null, createdAt: Date.now() },
      });
      const result = await runToolLoop({
        config: this.config,
        candidates: plan.candidates,
        messages,
        tools: runtime,
        attempts,
        maxIterations: limits.maxToolIterations,
        signal,
        onDelta: (text) => {
          content += text;
          this.publish(human.roomId, { type: "delta", roomId: human.roomId, messageId: placeholder.id, text });
        },
        onToolCalls: (calls) => {
          toolCalls = calls.map((c) => ({ ...c }));
          this.publish(human.roomId, { type: "tools", roomId: human.roomId, messageId: placeholder.id, toolCalls });
        },
      });
      chosenModel = result.modelId ?? null;
      content = result.content;
      toolCalls = result.toolCalls;
      if (result.outcome === "max_iterations")
        return finish("error", `达到最大工具迭代次数（${limits.maxToolIterations}），回复未完成`);
      return finish("done", null);
    } catch (e) {
      if (signal.aborted) return finish("cancelled", (signal.reason as Error | undefined)?.message || "用户取消");
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

export function buildSystemPrompt(
  agent: Agent,
  members: Agent[],
  kind: "group" | "dm",
  skills: Skill[],
  onDevice = false,
): string {
  const others = members.filter((m) => m.id !== agent.id).map((m) => `@${m.name}`);
  const parts = [
    `你的名字是「${agent.name}」。`,
    onDevice
      ? "你正通过一台桌面机器人和用户语音对话：回复要简短、口语化，适合朗读；可以调用 robot_express 设置表情、robot_action 做动作来配合表达。"
      : kind === "dm"
        ? "你正在和用户私聊。"
        : `你在一个群聊中，消息以「[发言者]: 内容」的形式给出。${
            others.length > 0
              ? `群里的其他 Agent：${others.join("、")}。回复正文里的 @名字 只是普通文字，不会通知任何人。只有当用户这次的请求确实需要对方现在动手时，才调用 handoff 工具把具体任务交给对方；不要为了介绍、推荐或预告别人能做什么而交接。不要在回复开头写「[名字]:」。`
              : ""
          }`,
    agent.systemPrompt,
    skillCatalogPrompt(skills),
  ];
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Converts room history into chat messages from this agent's point of view:
 * its own replies are `assistant`, everyone else is `user` prefixed with the speaker
 * name. Oldest messages are dropped first once `maxChars` is exceeded.
 */
export function buildContext(systemPrompt: string, agent: Agent, history: Message[], maxChars: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  let used = systemPrompt.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i] as Message;
    if (m.status === "streaming" || m.content.trim() === "") continue;
    const entry: ChatMessage =
      m.senderKind === "agent" && m.senderId === agent.id
        ? { role: "assistant", content: m.content }
        : { role: "user", content: `[${m.senderName}]: ${m.content}` };
    const len = (entry.content ?? "").length;
    if (used + len > maxChars && out.length > 0) break;
    used += len;
    out.unshift(entry);
  }
  return [{ role: "system", content: systemPrompt }, ...out];
}
