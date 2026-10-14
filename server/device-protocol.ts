/**
 * Device protocol v1 (see docs/device-protocol.md). Shared by the server and the
 * browser virtual robot so both sides use one definition.
 */
export const DEVICE_PROTOCOL_VERSION = 1;

/** Expressions the agent can set; listening/thinking/speaking/idle are driven by session state instead. */
export const ROBOT_EXPRESSIONS = ["neutral", "happy", "sad", "surprised"] as const;
export type RobotExpression = (typeof ROBOT_EXPRESSIONS)[number];
export const ROBOT_ACTIONS = ["nod", "shake_head", "tilt", "wave", "look_around", "dance"] as const;
export type RobotAction = (typeof ROBOT_ACTIONS)[number];

/** Server-owned conversation state of a device session. */
export type SessionState = "idle" | "thinking" | "replying";

/** Device → server messages. Validated by the zod schema in server/device.ts. */
export type DeviceInbound =
  | {
      type: "hello";
      protocol: typeof DEVICE_PROTOCOL_VERSION;
      deviceId: string;
      agentId: string;
      userName?: string;
      capabilities: { expressions: string[]; actions: string[]; asr: boolean; tts: boolean };
    }
  | { type: "bind"; agentId: string }
  | { type: "utterance"; id: string; text: string }
  | { type: "interrupt" }
  | { type: "state"; listening: boolean; speaking: boolean }
  | { type: "ack"; id: string; ok: boolean; error?: string };

export type DeviceOutbound = { seq: number } & (
  | { type: "welcome"; protocol: number; sessionId: string; roomId: string; agent: { id: string; name: string } }
  | { type: "session.state"; state: SessionState }
  | { type: "utterance.accepted"; id: string; messageId: string }
  | { type: "reply.start"; messageId: string }
  | { type: "reply.delta"; messageId: string; text: string }
  | {
      type: "reply.end";
      messageId: string;
      status: "done" | "error" | "cancelled" | "interrupted";
      text: string;
      error: string | null;
    }
  | { type: "expression"; id: string; name: RobotExpression; durationMs: number }
  | { type: "action"; id: string; name: RobotAction }
  | { type: "interrupt.result"; cancelled: boolean }
  | { type: "error"; code: "invalid_message" | "not_ready" | "unknown_agent" | "busy"; message: string }
);

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type DeviceOutboundBody = DistributiveOmit<DeviceOutbound, "seq">;
