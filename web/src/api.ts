import type { RoomEvent, RoomState } from "../../server/orchestrator";
import type { Agent, AgentInput, McpServer, Message, Room, RoutingDecision } from "../../server/store";

export type { Agent, AgentInput, McpServer, Message, Room, RoomEvent, RoomState, RoutingDecision };

export interface Meta {
  configSource: string;
  models: { id: string; tags: string[]; costTier: number; contextWindow: number }[];
  classifierModel: string | null;
  limits: { maxAgentHops: number; maxToolIterations: number; contextMessages: number; contextChars: number };
  builtinTools: { id: string; name: string; description: string }[];
  skills: { name: string; description: string }[];
  skillErrors: { dir: string; error: string }[];
}

export interface McpTool {
  name: string;
  description: string;
}

/** Throws an Error carrying the server's error message for any non-2xx response. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export type WsEvent =
  | RoomEvent
  | { type: "subscribed"; roomId: string; state: RoomState }
  | { type: "error"; error: string };

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
