import { describe, expect, test } from "bun:test";
import { type CompactStorage, compactForRoom, rememberCompact } from "../web/src/compactPreference";

function memory(): CompactStorage & { getItem(key: string): string | null } {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

describe("per-conversation display mode", () => {
  test("defaults to concise and keeps each room's choice", () => {
    const storage = memory();
    expect(compactForRoom(storage, "a")).toBe(true);
    rememberCompact(storage, "a", false);
    expect(compactForRoom(storage, "a")).toBe(false);
    expect(compactForRoom(storage, "b")).toBe(true);
    rememberCompact(storage, "b", true);
    expect(compactForRoom(storage, "a")).toBe(false);
  });

  test("rooms without their own choice follow the previous device-wide setting", () => {
    const storage = memory();
    storage.setItem("tuantuan:compact", "0");
    expect(compactForRoom(storage, "a")).toBe(false);
    rememberCompact(storage, "a", true);
    storage.setItem("tuantuan:compact", "0");
    expect(compactForRoom(storage, "a")).toBe(true);
    expect(compactForRoom(storage, "b")).toBe(false);
  });

  test("ignores a corrupt room value and does not rewrite the device-wide key", () => {
    const storage = memory();
    storage.setItem("tuantuan:compact", "1");
    storage.setItem("tuantuan:compact:a", "maybe");
    expect(compactForRoom(storage, "a")).toBe(true);
    rememberCompact(storage, "a", false);
    expect(storage.getItem("tuantuan:compact")).toBe("1");
    expect(storage.getItem("tuantuan:compact:a")).toBe("0");
  });
});
