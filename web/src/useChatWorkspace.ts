import { useEffect, useSyncExternalStore } from "react";
import { type ChatWorkspace, chatWorkspace } from "./chatWorkspace";

export function useChatWorkspace(roomId: string) {
  const snapshot = useSyncExternalStore(chatWorkspace.subscribe, () => chatWorkspace.snapshot(roomId));
  useEffect(() => {
    void chatWorkspace.load(roomId).catch(() => {});
  }, [roomId]);
  return {
    ...snapshot,
    update: (patch: Partial<ChatWorkspace>) => chatWorkspace.update(roomId, patch),
  };
}
