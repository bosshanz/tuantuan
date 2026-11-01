const COMPACT_KEY = "tuantuan:compact";

export interface CompactStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Concise mode for one conversation. A room with no saved choice still follows
 * the previous device-wide value, so existing readers do not all flip at once.
 */
export function compactForRoom(storage: CompactStorage, roomId: string): boolean {
  const own = storage.getItem(`${COMPACT_KEY}:${roomId}`);
  if (own === "0" || own === "1") return own === "1";
  return storage.getItem(COMPACT_KEY) !== "0";
}

/** Records the choice for this conversation and leaves every other room alone. */
export function rememberCompact(storage: CompactStorage, roomId: string, compact: boolean): void {
  storage.setItem(`${COMPACT_KEY}:${roomId}`, compact ? "1" : "0");
}
