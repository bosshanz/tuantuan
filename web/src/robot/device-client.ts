import {
  DEVICE_PROTOCOL_VERSION,
  type DeviceInbound,
  type DeviceOutbound,
  ROBOT_ACTIONS,
  ROBOT_EXPRESSIONS,
  type SessionState,
} from "../../../server/device-protocol";

export type Command = Extract<DeviceOutbound, { type: "expression" | "action" }>;

export interface DeviceHandlers {
  onConnection(connected: boolean): void;
  onWelcome(w: Extract<DeviceOutbound, { type: "welcome" }>): void;
  onSessionState(s: SessionState): void;
  onReplyStart(messageId: string): void;
  onReplyDelta(messageId: string, text: string): void;
  onReplyEnd(e: Extract<DeviceOutbound, { type: "reply.end" }>): void;
  /** Render a body command; return false (with reason) if it cannot be shown. */
  onCommand(c: Command): { ok: true } | { ok: false; error: string };
  onError(e: Extract<DeviceOutbound, { type: "error" }>): void;
}

/**
 * Browser implementation of the device side of docs/device-protocol.md.
 * A hardware robot would implement the same messages over the same /device socket.
 */
export class DeviceClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private agentId: string;

  constructor(
    private deviceId: string,
    agentId: string,
    private userName: string,
    private h: DeviceHandlers,
    private capabilities: { asr: boolean; tts: boolean },
  ) {
    this.agentId = agentId;
    this.open();
  }

  private open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/device`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.h.onConnection(true);
      this.send({
        type: "hello",
        protocol: DEVICE_PROTOCOL_VERSION,
        deviceId: this.deviceId,
        agentId: this.agentId,
        userName: this.userName,
        capabilities: { expressions: [...ROBOT_EXPRESSIONS], actions: [...ROBOT_ACTIONS], ...this.capabilities },
      });
    };
    ws.onmessage = (ev) => this.dispatch(JSON.parse(String(ev.data)) as DeviceOutbound);
    ws.onclose = () => {
      this.h.onConnection(false);
      if (!this.closed) setTimeout(() => !this.closed && this.open(), Math.min(5000, 500 * 2 ** this.retry++));
    };
  }

  private dispatch(m: DeviceOutbound) {
    switch (m.type) {
      case "welcome":
        return this.h.onWelcome(m);
      case "session.state":
        return this.h.onSessionState(m.state);
      case "reply.start":
        return this.h.onReplyStart(m.messageId);
      case "reply.delta":
        return this.h.onReplyDelta(m.messageId, m.text);
      case "reply.end":
        return this.h.onReplyEnd(m);
      case "expression":
      case "action": {
        const r = this.h.onCommand(m);
        return this.send(
          r.ok ? { type: "ack", id: m.id, ok: true } : { type: "ack", id: m.id, ok: false, error: r.error },
        );
      }
      case "error":
        return this.h.onError(m);
      default:
        return; // utterance.accepted / interrupt.result need no handling here
    }
  }

  private send(m: DeviceInbound): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  bind(agentId: string) {
    this.agentId = agentId;
    this.send({ type: "bind", agentId });
  }

  utter(text: string): boolean {
    return this.send({ type: "utterance", id: crypto.randomUUID().slice(0, 12), text });
  }

  interrupt() {
    this.send({ type: "interrupt" });
  }

  reportState(listening: boolean, speaking: boolean) {
    this.send({ type: "state", listening, speaking });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

/**
 * The browser robot is one logical device for the whole hub, so every browser (and every fresh
 * profile) reuses the same session room per agent instead of creating a new one each visit.
 */
export const WEB_ROBOT_ID = "web-robot";

export function deviceId(): string {
  return WEB_ROBOT_ID;
}
