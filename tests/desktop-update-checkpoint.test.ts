import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateCheckpointFile } from "../desktop/src/update-checkpoint";
import type { DesktopUpdateCheckpoint } from "../shared/desktopUpdate";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function file() {
  const dir = mkdtempSync(join(tmpdir(), "tuantuan-checkpoint-"));
  dirs.push(dir);
  const path = join(dir, "update-checkpoint.json");
  return { path, store: new UpdateCheckpointFile(path) };
}
const checkpoint = (id = "checkpoint-1"): DesktopUpdateCheckpoint => ({
  schema: 1,
  id,
  route: "#/c/room-1",
  rooms: {
    "room-1": {
      draft: "尚未发送",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      quote: { messageId: "message-1", senderName: "Agent", senderKind: "agent", text: "这一段", partIndex: 2 },
      reading: { id: "message-1", offset: -24, top: 120 },
    },
  },
});
test("private host checkpoint survives process/origin changes until acknowledged", () => {
  const { path, store } = file();
  expect(store.read()).toBeNull();
  store.save(checkpoint());
  const restarted = new UpdateCheckpointFile(path);
  expect(restarted.read()).toEqual(checkpoint());
  expect(restarted.read()).toEqual(checkpoint());
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  restarted.clear("checkpoint-1");
  expect(existsSync(path)).toBe(false);
});
test("stale acknowledgements cannot delete a later durable checkpoint", () => {
  const { store } = file();
  store.save(checkpoint());
  store.save(checkpoint("checkpoint-2"));
  store.clear("checkpoint-1");
  expect(store.read()?.id).toBe("checkpoint-2");
});
test("bad renderer payloads never replace the valid saved workspace", () => {
  const { store } = file();
  store.save(checkpoint());
  for (const invalid of [
    null,
    { ...checkpoint(), schema: 2 },
    { ...checkpoint(), route: "https://example.com" },
    {
      ...checkpoint(),
      rooms: { "room-1": { draft: "", images: [], quote: null, reading: { id: "a", offset: NaN, top: 0 } } },
    },
  ]) {
    expect(() => store.save(invalid)).toThrow();
    expect(store.read()).toEqual(checkpoint());
  }
});
test("corrupt disk checkpoint remains available for recovery", () => {
  const { path, store } = file();
  writeFileSync(path, "{broken");
  expect(() => store.read()).toThrow();
  expect(() => store.clear("checkpoint-1")).toThrow();
  expect(readFileSync(path, "utf8")).toBe("{broken");
});
