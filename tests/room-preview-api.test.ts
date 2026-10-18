import { afterAll, beforeAll, expect, test } from "bun:test";
import { serve } from "../server/app";
import type { Room } from "../server/store";
import type { GlobalEvent } from "../shared/notify";
import { messagePreview } from "../shared/roomPreview";
import { agentInput, until } from "./helpers";

const { app, server } = serve({ dbPath: ":memory:" }, 0);
const base = `http://localhost:${server.port}`;
const events: (GlobalEvent | { type: "message" })[] = [];
let socket: WebSocket;
beforeAll(async () => {
  socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
  socket.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
});
afterAll(() => {
  socket.close();
  app.host.shutdown();
  server.stop(true);
});

const previews = (roomId: string) =>
  events.filter(
    (e): e is Extract<GlobalEvent, { type: "room.preview" }> => e.type === "room.preview" && e.roomId === roomId,
  );
async function send(roomId: string, content: string) {
  const response = await fetch(`${base}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ senderName: "我", content }),
  });
  expect(response.ok).toBe(true);
}

test("a global-only socket gets human, streaming and final previews for an unopened room", async () => {
  const agent = app.store.createAgent(agentInput("SidebarBot"));
  const room = app.store.createRoom("unopened preview", [agent.id]);
  await send(room.id, "new sidebar reply");
  await app.orchestrator.idle(room.id);
  await until(() => previews(room.id).some((e) => e.last.status === "done" && e.last.sender === agent.name));
  const all = previews(room.id);
  expect(all[0]?.last).toMatchObject({ sender: null, text: "new sidebar reply" });
  expect(all.some((e) => e.last.status === "streaming")).toBe(true);
  const done = all.at(-1)?.last;
  expect(done?.text).toContain("new sidebar reply");
  const snapshot = (await (await fetch(`${base}/api/rooms`)).json()) as Room[];
  expect(snapshot.find((r) => r.id === room.id)?.last).toEqual(done);
  expect(events.some((e) => e.type === "message")).toBe(false); // No room subscription was sent.
});

test("failed and cancelled replies update the global preview even though cancellations do not notify", async () => {
  const broken = app.store.createAgent(agentInput("NoHarness", { harness: "" }));
  const failedRoom = app.store.createRoom("failed preview", [broken.id]);
  await send(failedRoom.id, "try unavailable harness");
  await app.orchestrator.idle(failedRoom.id);
  await until(() => previews(failedRoom.id).some((e) => e.last.status === "error"));
  const failed = app.store.recentMessages(failedRoom.id, 10).at(-1);
  expect(previews(failedRoom.id).at(-1)?.last).toEqual(
    messagePreview(failed as NonNullable<typeof failed>) ?? undefined,
  );
  expect(previews(failedRoom.id).at(-1)?.last.text).toContain("Harness");

  const agent = app.store.createAgent(agentInput("CancelSidebar"));
  const room = app.store.createRoom("cancel preview", [agent.id]);
  await app.host.sessionView(room, agent, app.orchestrator.identityFor(room, agent));
  await send(room.id, "/slow");
  await until(() => previews(room.id).some((e) => e.last.status === "streaming"));
  await fetch(`${base}/api/rooms/${room.id}/cancel`, { method: "POST" });
  await app.orchestrator.idle(room.id);
  await until(() => previews(room.id).some((e) => e.last.status === "cancelled"));
  expect(previews(room.id).at(-1)?.last.status).toBe("cancelled");
  expect(events.some((e) => e.type === "notify" && e.roomId === room.id)).toBe(false);
});

test("attachment-only messages have identical safe summaries in global events and refreshed room lists", async () => {
  const room = app.store.createRoom("attachment preview", []);
  const response = await fetch(`${base}/api/rooms/${room.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderName: "我",
      content: "",
      files: [{ name: "report.txt", mimeType: "text/plain", data: "c2VjcmV0LXRleHQ=" }],
    }),
  });
  expect(response.ok).toBe(true);
  await app.orchestrator.idle(room.id);
  await until(() => previews(room.id).some((event) => event.last.attachment?.name === "report.txt"));
  const all = previews(room.id);
  const snapshot = (await (await fetch(`${base}/api/rooms`)).json()) as Room[];
  expect(snapshot.find((value) => value.id === room.id)?.last).toEqual(all.at(-1)?.last);
  expect(JSON.stringify(all)).not.toContain("c2VjcmV0LXRleHQ=");
  expect(all.at(-1)?.last).toMatchObject({ text: "", attachment: { kind: "file", name: "report.txt", count: 1 } });
});
