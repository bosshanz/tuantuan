import { z } from "zod";
import {
  conciseForSpeech,
  DEVICE_PROTOCOL_VERSION,
  type DeviceInbound,
  type DeviceOutboundBody,
  ROBOT_ACTIONS,
  ROBOT_EXPRESSIONS,
  type SessionState,
} from "./device-protocol";
import type { Orchestrator, RoomEvent } from "./orchestrator";
import type { Store } from "./store";

/** Lets an agent drive the robot's face and body (Tuantuan MCP tools set_expression / play_action). */
export interface DeviceControl {
  command(kind: "expression" | "action", name: string, signal?: AbortSignal): Promise<string>;
}

const InboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(DEVICE_PROTOCOL_VERSION),
    deviceId: z.string().min(1).max(64),
    agentId: z.string().min(1),
    userName: z.string().max(32).optional(),
    capabilities: z.object({
      expressions: z.array(z.string()),
      actions: z.array(z.string()),
      asr: z.boolean(),
      tts: z.boolean(),
    }),
  }),
  z.object({ type: z.literal("bind"), agentId: z.string().min(1) }),
  z.object({ type: z.literal("utterance"), id: z.string().min(1).max(64), text: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("state"), listening: z.boolean(), speaking: z.boolean() }),
  z.object({ type: z.literal("ack"), id: z.string(), ok: z.boolean(), error: z.string().optional() }),
]);

export interface DeviceSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

interface Session {
  deviceId: string;
  agentId: string;
  roomId: string;
  userName: string;
  capabilities: { expressions: string[]; actions: string[] };
}

export interface DeviceConn {
  socket: DeviceSocket;
  seq: number;
  session: Session | null;
  /** Device-reported local state; informational (logged in state, used for barge-in decisions on the device). */
  local: { listening: boolean; speaking: boolean };
}

const EXPRESSION_MS = 2500;

/**
 * Owns device (robot) connections and translates between the device protocol and
 * room events. Conversation state stays in the Orchestrator/Store; the hub only
 * derives the per-room session phase it reports to devices.
 */
export class DeviceHub {
  private conns = new Set<DeviceConn>();
  private phase = new Map<string, SessionState>();
  private deviceRooms = new Set<string>();
  private pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void; timer: Timer }>();
  orchestrator: Orchestrator | null = null;

  constructor(
    private store: Store,
    private ackTimeoutMs = 3000,
  ) {}

  open(socket: DeviceSocket): DeviceConn {
    const conn: DeviceConn = { socket, seq: 0, session: null, local: { listening: false, speaking: false } };
    this.conns.add(conn);
    return conn;
  }

  close(conn: DeviceConn) {
    this.conns.delete(conn);
  }

  private send(conn: DeviceConn, body: DeviceOutboundBody) {
    conn.seq += 1;
    conn.socket.send(JSON.stringify({ seq: conn.seq, ...body }));
  }

  private broadcast(roomId: string, body: DeviceOutboundBody) {
    for (const c of this.conns) if (c.session?.roomId === roomId) this.send(c, body);
  }

  /** Protocol violations (bad JSON / schema, or anything before hello) close the connection with 1008. */
  handle(conn: DeviceConn, raw: string) {
    let parsed: DeviceInbound;
    try {
      parsed = InboundSchema.parse(JSON.parse(raw));
    } catch (e) {
      const detail = e instanceof SyntaxError ? "不是合法 JSON" : (e as Error).message.slice(0, 300);
      this.send(conn, { type: "error", code: "invalid_message", message: detail });
      conn.socket.close(1008, "invalid_message");
      return;
    }
    if (parsed.type === "hello") return this.hello(conn, parsed);
    if (parsed.type === "ack") return this.ack(parsed.id, parsed.ok, parsed.error);
    const session = conn.session;
    if (!session) {
      this.send(conn, { type: "error", code: "not_ready", message: "需要先发送 hello" });
      conn.socket.close(1008, "not_ready");
      return;
    }
    const orch = this.orchestrator as Orchestrator;
    switch (parsed.type) {
      case "bind": {
        const agent = this.store.getAgent(parsed.agentId);
        if (!agent) return this.send(conn, { type: "error", code: "unknown_agent", message: "Agent 不存在" });
        this.bindTo(conn, { ...session, agentId: agent.id }, agent);
        return;
      }
      case "utterance": {
        // Barge-in: a new utterance supersedes whatever the agent is still doing.
        if (orch.state(session.roomId).activeRunId) orch.cancel(session.roomId);
        const msg = orch.postHumanMessage(session.roomId, session.userName, parsed.text);
        this.send(conn, { type: "utterance.accepted", id: parsed.id, messageId: msg.id });
        return;
      }
      case "interrupt":
        this.send(conn, { type: "interrupt.result", cancelled: orch.cancel(session.roomId) });
        return;
      case "state":
        conn.local = { listening: parsed.listening, speaking: parsed.speaking };
        return;
    }
  }

  private hello(conn: DeviceConn, h: Extract<DeviceInbound, { type: "hello" }>) {
    const agent = this.store.getAgent(h.agentId);
    if (!agent) return this.send(conn, { type: "error", code: "unknown_agent", message: "Agent 不存在" });
    this.bindTo(
      conn,
      {
        deviceId: h.deviceId,
        agentId: agent.id,
        roomId: "",
        userName: h.userName?.trim() || "我",
        capabilities: { expressions: h.capabilities.expressions, actions: h.capabilities.actions },
      },
      agent,
    );
  }

  private bindTo(conn: DeviceConn, s: Session, agent: { id: string; name: string }) {
    const room = this.store.deviceRoom(
      s.deviceId,
      this.store.getAgent(agent.id) as NonNullable<ReturnType<Store["getAgent"]>>,
    );
    conn.session = { ...s, roomId: room.id };
    this.deviceRooms.add(room.id);
    this.send(conn, {
      type: "welcome",
      protocol: DEVICE_PROTOCOL_VERSION,
      sessionId: `${s.deviceId}:${agent.id}`,
      roomId: room.id,
      agent: { id: agent.id, name: agent.name },
    });
    this.send(conn, { type: "session.state", state: this.phase.get(room.id) ?? "idle" });
  }

  private ack(id: string, ok: boolean, error?: string) {
    const p = this.pending.get(id);
    if (!p) return; // late or duplicate ack: the command already resolved or timed out
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve("设备已执行");
    else p.reject(new Error(`设备拒绝执行：${error ?? "未说明原因"}`));
  }

  private setPhase(roomId: string, state: SessionState) {
    if (this.phase.get(roomId) === state) return;
    this.phase.set(roomId, state);
    this.broadcast(roomId, { type: "session.state", state });
  }

  /** Called for every room event; translates agent replies into the device stream. */
  onRoomEvent(roomId: string, e: RoomEvent) {
    if (!this.deviceRooms.has(roomId)) return;
    if (e.type === "room.state")
      this.setPhase(
        roomId,
        e.state.activeRunId ? (this.phase.get(roomId) === "replying" ? "replying" : "thinking") : "idle",
      );
    else if (
      e.type === "update" &&
      e.update.sessionUpdate === "agent_message_chunk" &&
      e.update.content.type === "text"
    ) {
      this.setPhase(roomId, "replying");
      this.broadcast(roomId, { type: "reply.delta", messageId: e.messageId, text: e.update.content.text });
    }
    if (e.type === "message" && e.message.senderKind === "agent") {
      const m = e.message;
      if (m.status === "streaming") this.broadcast(roomId, { type: "reply.start", messageId: m.id });
      else
        this.broadcast(roomId, {
          type: "reply.end",
          messageId: m.id,
          status: m.status,
          text: m.content,
          spoken: m.timeline?.spoken ?? conciseForSpeech(m.content),
          error: m.error,
        });
    }
  }

  /** Device control for a room's tool runtime, or null when the room is not a device conversation. */
  controlFor(roomId: string): DeviceControl | null {
    if (!this.store.getRoom(roomId)?.deviceId) return null;
    return {
      command: (kind, name, signal) => {
        const allowed: readonly string[] = kind === "expression" ? ROBOT_EXPRESSIONS : ROBOT_ACTIONS;
        if (!allowed.includes(name))
          return Promise.reject(new Error(`未知${kind === "expression" ? "表情" : "动作"}：${name}`));
        const targets = [...this.conns].filter((c) => c.session?.roomId === roomId);
        if (targets.length === 0) return Promise.reject(new Error("机器人设备未连接"));
        const capable = targets.filter((c) =>
          (kind === "expression" ? c.session?.capabilities.expressions : c.session?.capabilities.actions)?.includes(
            name,
          ),
        );
        if (capable.length === 0)
          return Promise.reject(new Error(`设备不支持${kind === "expression" ? "表情" : "动作"} ${name}`));
        const id = crypto.randomUUID();
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`设备 ${this.ackTimeoutMs}ms 内未确认`));
          }, this.ackTimeoutMs);
          this.pending.set(id, { resolve: (v) => resolve(`${v}：${kind} ${name}`), reject, timer });
          signal?.addEventListener("abort", () => {
            if (this.pending.delete(id)) {
              clearTimeout(timer);
              reject(signal.reason);
            }
          });
          for (const c of capable)
            this.send(
              c,
              kind === "expression"
                ? {
                    type: "expression",
                    id,
                    name: name as (typeof ROBOT_EXPRESSIONS)[number],
                    durationMs: EXPRESSION_MS,
                  }
                : { type: "action", id, name: name as (typeof ROBOT_ACTIONS)[number] },
            );
        });
      },
    };
  }
}
