import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopCheckpoint, UpdateCheckpointFile } from "../desktop/src/update-checkpoint";
import type {
  DesktopCheckpointRequest,
  DesktopCheckpointState,
  DesktopUpdateCheckpoint,
} from "../shared/desktopUpdate";

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

function handoff(timeout = 1000) {
  const { store, path } = file();
  const requests: DesktopCheckpointRequest[] = [];
  const states: DesktopCheckpointState[] = [];
  const host = new DesktopCheckpoint(
    store,
    (request) => requests.push(request),
    (state) => states.push(state),
    timeout,
  );
  const requestAt = (index: number) => {
    const request = requests[index];
    if (!request) throw new Error(`Missing checkpoint request ${index}`);
    return request;
  };
  return { host, store, path, requests, states, requestAt };
}

test("ordinary quits share one durable handoff that update status cannot discard", async () => {
  const { host, store, requests, states, requestAt } = handoff();
  const quitting = host.request("quit");
  expect(host.request("quit")).toBe(quitting);
  await expect(host.request("update")).rejects.toThrow("正在保存");
  expect(requests).toHaveLength(1);
  const request = requestAt(0);
  host.save(checkpoint(request.id), request.id);
  host.abandonUpdate();
  expect(store.read()?.id).toBe(request.id);
  host.reply({ id: request.id, ok: true });
  await quitting;
  host.abandonUpdate();
  expect(store.read()).toEqual(checkpoint(request.id));
  expect(states.map((state) => state.phase)).toEqual(["preparing", "saved"]);
});

test("timeouts unlock the handoff, remove partial snapshots and reject late writes/replies", async () => {
  const { host, store, states, requestAt } = handoff(10);
  const first = host.request("quit");
  const old = requestAt(0);
  host.save(checkpoint(old.id), old.id);
  await expect(first).rejects.toThrow("超时");
  expect(store.read()).toBeNull();
  const retry = host.request("quit");
  const current = requestAt(1);
  expect(() => host.save(checkpoint(old.id), old.id)).toThrow("过期");
  host.reply({ id: old.id, ok: true });
  host.save(checkpoint(current.id), current.id);
  host.reply({ id: current.id, ok: true });
  await retry;
  expect(store.read()?.id).toBe(current.id);
  expect(states.map((state) => state.phase)).toEqual(["preparing", "error", "preparing", "saved"]);
});

test("a failed quit retains the renderer and can save a fresh snapshot on retry", async () => {
  const { host, store, requestAt } = handoff();
  const first = host.request("quit");
  const old = requestAt(0);
  expect(() => host.save({ ...checkpoint(old.id), schema: 2 }, old.id)).toThrow();
  host.reply({ id: old.id, ok: false, error: "host disk full" });
  await expect(first).rejects.toThrow("host disk full");
  expect(store.read()).toBeNull();
  const retry = host.request("quit");
  const current = requestAt(1);
  const latest = checkpoint(current.id);
  latest.rooms["room-1"] = {
    ...latest.rooms["room-1"],
    draft: "edited after failure",
  } as (typeof latest.rooms)[string];
  host.save(latest, current.id);
  host.reply({ id: current.id, ok: true });
  await retry;
  expect(store.read()).toEqual(latest);
});

test("only a saved request can be acknowledged, and abandoned updates cannot leave stale snapshots", async () => {
  const { host, store, requestAt } = handoff();
  const empty = host.request("update");
  host.reply({ id: requestAt(0).id, ok: true });
  await expect(empty).rejects.toThrow("无法保存");
  const update = host.request("update");
  const request = requestAt(1);
  expect(() => host.save(checkpoint(), request.id)).toThrow("过期");
  host.save(checkpoint(request.id), request.id);
  host.reply({ id: request.id, ok: true });
  await update;
  expect(store.read()?.id).toBe(request.id);
  host.abandonUpdate();
  expect(store.read()).toBeNull();
  expect(() => host.save(checkpoint(request.id), request.id)).toThrow("过期");
});

test("abandoning an in-flight update invalidates it before a quit takes ownership", async () => {
  const { host, store, requestAt } = handoff();
  const update = host.request("update");
  const old = requestAt(0);
  host.save(checkpoint(old.id), old.id);
  host.abandonUpdate();
  await expect(update).rejects.toThrow("已取消");
  expect(store.read()).toBeNull();
  const quit = host.request("quit");
  const current = requestAt(1);
  host.reply({ id: old.id, ok: true });
  host.save(checkpoint(current.id), current.id);
  host.reply({ id: current.id, ok: true });
  await quit;
  expect(store.read()?.id).toBe(current.id);
});
