import type { TerminalSnapshot } from "../../server/acp";
import type { CustomFormat } from "../../server/custom";
import type { HarnessStatus } from "../../server/harness";
import type { PermissionAsk, SessionView } from "../../server/host";
import type { RoomEvent, RoomState } from "../../server/orchestrator";
import type {
  Agent,
  AgentInput,
  CustomInput,
  CustomPublic,
  McpServer,
  Message,
  Project,
  Room,
} from "../../server/store";
import type { GlobalEvent } from "../../shared/notify";

export type {
  Agent,
  AgentInput,
  CustomFormat,
  CustomInput,
  CustomPublic,
  HarnessStatus,
  McpServer,
  Message,
  PermissionAsk,
  Project,
  Room,
  RoomEvent,
  RoomState,
  SessionView,
  TerminalSnapshot,
};

export interface HarnessInfo {
  id: string;
  name: string;
  install: string;
  auth: string;
  login: string;
  docs: string;
  identity: "claude-meta" | "grok-meta" | "codex-env" | "first-prompt";
}

export interface Meta {
  workspacesRoot: string;
  onboarded: boolean;
  harnesses: HarnessInfo[];
}

export const IDENTITY_DELIVERY: Record<HarnessInfo["identity"], string> = {
  "claude-meta": "追加到系统提示",
  "grok-meta": "作为系统规则追加（_meta.rules）",
  "codex-env": "作为 developer_instructions（CODEX_CONFIG 环境变量）",
  "first-prompt": "放在每个新会话的第一条消息前",
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Throws an ApiError carrying the HTTP status and server's message for any non-2xx response. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

export type WsEvent =
  | RoomEvent
  | { type: "subscribed"; roomId: string; state: RoomState }
  | { type: "error"; error: string }
  | GlobalEvent;

/** One reconnecting WebSocket for the app; re-subscribes the current room after reconnect. */
export function connectWs(onEvent: (e: WsEvent) => void, onStatus: (connected: boolean) => void) {
  let ws: WebSocket | null = null;
  let room: string | null = null;
  let closed = false;
  let retry = 0;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      onStatus(true);
      if (room) ws?.send(JSON.stringify({ type: "subscribe", roomId: room }));
    };
    ws.onmessage = (m) => onEvent(JSON.parse(String(m.data)) as WsEvent);
    ws.onclose = () => {
      onStatus(false);
      if (!closed) setTimeout(open, Math.min(5000, 500 * 2 ** retry++));
    };
  };
  open();
  return {
    subscribe(roomId: string | null) {
      if (room && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "unsubscribe", roomId: room }));
      room = roomId;
      if (room && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "subscribe", roomId: room }));
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
