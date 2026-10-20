import { notifyForMessage } from "./notify";

export type AttentionKind = "permission" | "question" | "auth" | "error" | "interrupted";

interface AttentionBase {
  id: string;
  kind: AttentionKind;
  projectId: string | null;
  projectName: string | null;
  roomId: string;
  roomName: string;
  agentId: string | null;
  agentName: string;
  /** A bounded summary. Request details and credentials stay in the existing conversation flow. */
  reason: string;
  createdAt: number | null;
}

export interface AttentionRequest extends AttentionBase {
  kind: "permission" | "question";
  askId: string;
}

export interface AttentionFailure extends AttentionBase {
  kind: "auth" | "error" | "interrupted";
  messageId: string;
  createdAt: number;
}

export type AttentionItem = AttentionRequest | AttentionFailure;
export type AttentionNavigateTarget =
  | Pick<AttentionRequest, "kind" | "roomId" | "askId">
  | Pick<AttentionFailure, "kind" | "roomId" | "messageId">;

export interface AttentionSnapshot {
  /** Live Host requests, always complete, including on subsequent failure pages. */
  active: AttentionRequest[];
  failures: AttentionFailure[];
  /** All pending requests and undismissed failures, including failures outside this page. */
  totalCount: number;
  nextCursor: string | null;
}

/** Use the notification classification for auth errors; interruptions keep their own recovery label. */
export function attentionFailureKind(message: { status: string; error: string | null }): AttentionFailure["kind"] {
  if (message.status === "interrupted") return "interrupted";
  const notification = notifyForMessage("", {
    id: "",
    senderKind: "agent",
    senderId: null,
    senderName: "",
    content: "",
    status: "error",
    error: message.error,
  });
  return notification?.type === "notify" && notification.kind === "auth" ? "auth" : "error";
}
