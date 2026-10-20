import { expect, test } from "bun:test";
import type { AttentionFailure, AttentionRequest, AttentionSnapshot } from "../shared/attention";
import { AttentionController } from "../web/src/AttentionCenter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const failure = (id: string): AttentionFailure => ({
  id: `message:${id}`,
  kind: "error",
  messageId: id,
  roomId: "room",
  roomName: "Conversation",
  projectId: "project",
  projectName: "Project",
  agentId: "agent",
  agentName: "Worker",
  reason: "failed",
  createdAt: 1,
});
const question: AttentionRequest = {
  id: "question:ask",
  askId: "ask",
  kind: "question",
  roomId: "room",
  roomName: "Conversation",
  projectId: "project",
  projectName: "Project",
  agentId: "agent",
  agentName: "Worker",
  reason: "waiting",
  createdAt: null,
};
const snapshot = (patch: Partial<AttentionSnapshot> = {}): AttentionSnapshot => ({
  active: [],
  failures: [],
  totalCount: 0,
  nextCursor: null,
  ...patch,
});
const settle = () => Bun.sleep(0);

function fixture() {
  const requests: { method: string; path: string; result: ReturnType<typeof deferred<unknown>> }[] = [];
  const controller = new AttentionController(<T>(method: string, path: string) => {
    const result = deferred<unknown>();
    requests.push({ method, path, result });
    return result.promise as Promise<T>;
  });
  return { controller, requests };
}

test("unknown, offline and failed attention snapshots never become a confirmed empty state; reconnection refreshes", async () => {
  const { controller, requests } = fixture();
  expect(controller.getSnapshot()).toMatchObject({ pendingCount: null, stale: true });
  controller.setConnected(true);
  requests[0]?.result.reject(new Error("offline"));
  await settle();
  expect(controller.getSnapshot()).toMatchObject({ pendingCount: null, stale: true, error: "offline", loading: false });
  const retry = controller.refresh();
  requests[1]?.result.resolve(snapshot({ active: [question], totalCount: 1 }));
  await retry;
  expect(controller.getSnapshot()).toMatchObject({ pendingCount: 1, stale: false, error: null });
  controller.setConnected(false);
  expect(controller.getSnapshot()).toMatchObject({ pendingCount: 1, stale: true, active: [question] });
  await controller.refresh();
  expect(requests).toHaveLength(2);
  controller.setConnected(true);
  expect(requests).toHaveLength(3);
  requests[2]?.result.resolve(snapshot());
  await settle();
  expect(controller.getSnapshot()).toMatchObject({ pendingCount: 0, stale: false, active: [] });
});

test("a slow snapshot cannot restore requests resolved by a later invalidation or overwrite a reconnect", async () => {
  const { controller, requests } = fixture();
  controller.setConnected(true);
  const fresh = controller.refresh();
  requests[1]?.result.resolve(snapshot());
  await fresh;
  requests[0]?.result.resolve(snapshot({ active: [question], totalCount: 1 }));
  await settle();
  expect(controller.getSnapshot()).toMatchObject({ active: [], pendingCount: 0 });
  const beforeDisconnect = controller.refresh();
  controller.setConnected(false);
  controller.setConnected(true);
  requests[3]?.result.resolve(snapshot({ failures: [failure("new")], totalCount: 1 }));
  await settle();
  requests[2]?.result.resolve(snapshot());
  await beforeDisconnect;
  expect(controller.getSnapshot().failures.map((item) => item.messageId)).toEqual(["new"]);
});

test("failure pages merge without duplicates, retry errors, and cannot overwrite a newer snapshot", async () => {
  const { controller, requests } = fixture();
  controller.setConnected(true);
  requests[0]?.result.resolve(
    snapshot({ active: [question], failures: [failure("first")], totalCount: 4, nextCursor: "page2" }),
  );
  await settle();
  const failedPage = controller.loadMore();
  requests[1]?.result.reject(new Error("page failed"));
  await failedPage;
  expect(controller.getSnapshot()).toMatchObject({
    loadMoreError: "page failed",
    loadingMore: false,
    nextCursor: "page2",
  });
  expect(controller.getSnapshot().failures).toHaveLength(1);
  const secondPage = controller.loadMore();
  requests[2]?.result.resolve(
    snapshot({
      active: [question],
      failures: [failure("first"), failure("second")],
      totalCount: 4,
      nextCursor: "page3",
    }),
  );
  await secondPage;
  expect(controller.getSnapshot().failures.map((item) => item.messageId)).toEqual(["first", "second"]);
  const oldPage = controller.loadMore();
  const refreshed = controller.refresh();
  requests[4]?.result.resolve(snapshot({ failures: [failure("fresh")], totalCount: 1 }));
  await refreshed;
  requests[3]?.result.resolve(snapshot({ active: [question], failures: [failure("old")], totalCount: 4 }));
  await oldPage;
  expect(controller.getSnapshot()).toMatchObject({
    active: [],
    pendingCount: 1,
    loadingMore: false,
    loadMoreError: null,
  });
  expect(controller.getSnapshot().failures.map((item) => item.messageId)).toEqual(["fresh"]);
});

test("dismiss deduplicates pending submissions, preserves failures on error and rejects late stale snapshots after success", async () => {
  const { controller, requests } = fixture();
  controller.setConnected(true);
  requests[0]?.result.resolve(snapshot({ failures: [failure("failed")], totalCount: 1 }));
  await settle();
  const oldRefresh = controller.refresh();
  const first = controller.dismiss("failed");
  expect(controller.dismiss("failed")).toBe(first);
  await settle();
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(controller.getSnapshot().dismissPending.has("failed")).toBe(true);
  requests[2]?.result.reject(new Error("cannot save"));
  expect(await first).toBe(false);
  expect(controller.getSnapshot().failures).toHaveLength(1);
  expect(controller.getSnapshot().dismissErrors.failed).toBe("cannot save");
  expect(controller.getSnapshot().dismissPending.has("failed")).toBe(false);
  const retry = controller.dismiss("failed");
  await settle();
  requests[3]?.result.resolve({ ok: true });
  expect(await retry).toBe(true);
  expect(controller.getSnapshot().failures).toEqual([]);
  expect(controller.getSnapshot().pendingCount).toBe(0);
  requests[1]?.result.resolve(snapshot({ failures: [failure("failed")], totalCount: 1 }));
  await oldRefresh;
  // A response racing with the mutation cannot resurrect an explicitly dismissed message.
  requests[4]?.result.resolve(snapshot({ failures: [failure("failed")], totalCount: 1 }));
  await settle();
  expect(controller.getSnapshot()).toMatchObject({ failures: [], pendingCount: 0, dismissErrors: {} });
  expect(await controller.dismiss("failed")).toBe(false);
});

test("a failed dismissal does not suppress a concurrent refresh that removes a resolved Host request", async () => {
  const { controller, requests } = fixture();
  controller.setConnected(true);
  requests[0]?.result.resolve(snapshot({ active: [question], failures: [failure("failed")], totalCount: 2 }));
  await settle();
  const refreshed = controller.refresh();
  expect(controller.getSnapshot().stale).toBe(true);
  const dismissed = controller.dismiss("failed");
  await settle();
  requests[1]?.result.resolve(snapshot({ failures: [failure("failed")], totalCount: 1 }));
  await refreshed;
  requests[2]?.result.reject(new Error("save failed"));
  expect(await dismissed).toBe(false);
  expect(controller.getSnapshot()).toMatchObject({ active: [], pendingCount: 1, stale: false });
  expect(controller.getSnapshot().failures.map((item) => item.messageId)).toEqual(["failed"]);
  expect(controller.getSnapshot().dismissErrors.failed).toBe("save failed");
});
