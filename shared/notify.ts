import { missingKeyVar } from "./auth";

/** Global, room-independent events every UI client gets (sidebar activity + desktop notifications). */
export type NotifyKind = "reply" | "permission" | "error" | "auth";
export type GlobalEvent =
  | { type: "activity"; roomId: string; busy: boolean }
  | {
      type: "notify";
      kind: NotifyKind;
      roomId: string;
      agentId: string | null;
      agentName: string;
      text: string;
      /** Dedupe key (message id / permission id). */
      id: string;
    };

export const NOTIFY_KINDS: NotifyKind[] = ["reply", "permission", "error", "auth"];
export const NOTIFY_LABEL: Record<NotifyKind, string> = {
  reply: "回复完成",
  permission: "需要你批准",
  error: "出错",
  auth: "需要登录或 Key",
};

export function preview(text: string, max = 90): string {
  const t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

type Msg = {
  id: string;
  senderKind: string;
  senderId: string | null;
  senderName: string;
  status: string;
  content: string;
  error: string | null;
};

/** Maps a finished agent message to a notification, or null (streaming, human, cancelled). */
export function notifyForMessage(roomId: string, m: Msg): GlobalEvent | null {
  if (m.senderKind !== "agent") return null;
  const base = { type: "notify" as const, roomId, agentId: m.senderId, agentName: m.senderName, id: m.id };
  if (m.status === "done") return { ...base, kind: "reply", text: preview(m.content) || "（空回复）" };
  if (m.status === "error") {
    const err = m.error ?? "出错了";
    if (missingKeyVar(err) !== null || /登录|log ?in|auth|401|unauthori[sz]ed/i.test(err))
      return { ...base, kind: "auth", text: preview(err) };
    return { ...base, kind: "error", text: preview(err) };
  }
  return null;
}
