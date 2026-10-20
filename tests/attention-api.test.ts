import { expect, test } from "bun:test";
import { serve } from "../server/app";
import type { AttentionSnapshot } from "../shared/attention";
import { agentInput, until } from "./helpers";

test("attention endpoints validate dismissal and publish invalidations to clients without a room subscription", async () => {
  const { app, server } = serve({ dbPath: ":memory:" }, 0);
  const base = `http://127.0.0.1:${server.port}`;
  const events: { type: string }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  ws.addEventListener("message", (event) => events.push(JSON.parse(String(event.data))));
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  const request = async (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const snapshot = async () => {
    const response = await request("GET", "/api/attention");
    expect(response.status).toBe(200);
    return (await response.json()) as AttentionSnapshot;
  };
  try {
    const worker = app.store.createAgent(agentInput("AttentionApiWorker"));
    const room = app.store.createRoom("Attention API", [worker.id]);
    const failed = app.store.insertMessage({
      roomId: room.id,
      runId: "run",
      hop: 1,
      senderKind: "agent",
      senderId: worker.id,
      senderName: worker.name,
      content: "",
      status: "error",
    });
    expect((await snapshot()).failures.map((item) => item.messageId)).toContain(failed.id);
    const beforeDismiss = events.filter((event) => event.type === "attention.changed").length;
    expect((await request("POST", `/api/attention/${failed.id}/dismiss`)).status).toBe(200);
    await until(() => events.filter((event) => event.type === "attention.changed").length > beforeDismiss);
    expect((await request("POST", `/api/attention/${failed.id}/dismiss`)).status).toBe(200);
    expect((await snapshot()).totalCount).toBe(0);
    expect(app.store.getMessage(failed.id)?.status).toBe("error");
    expect((await request("POST", "/api/attention/missing/dismiss")).status).toBe(404);
    const beforeAsk = events.filter((event) => event.type === "attention.changed").length;
    app.orchestrator.postHumanMessage(room.id, "Tester", "/ask");
    const ask = await until(() => app.host.pendingElicitations(room.id)[0]);
    await until(() => events.filter((event) => event.type === "attention.changed").length > beforeAsk);
    expect((await snapshot()).active.map((item) => item.askId)).toEqual([ask.id]);
    expect((await request("POST", `/api/attention/${ask.id}/dismiss`)).status).toBe(404);
    const permissionRoom = app.store.createRoom("Attention permission", [worker.id]);
    const beforePermission = events.filter((event) => event.type === "attention.changed").length;
    app.orchestrator.postHumanMessage(permissionRoom.id, "Tester", "/edit");
    const permission = await until(() => app.host.pendingAsks(permissionRoom.id)[0]);
    await until(() => events.filter((event) => event.type === "attention.changed").length > beforePermission);
    expect((await snapshot()).active).toHaveLength(2);
    const beforeApproval = events.filter((event) => event.type === "attention.changed").length;
    expect((await request("POST", `/api/permissions/${permission.id}`, { optionId: null })).status).toBe(200);
    await until(() => events.filter((event) => event.type === "attention.changed").length > beforeApproval);
    await app.orchestrator.idle(permissionRoom.id);
    expect((await snapshot()).active.map((item) => item.askId)).toEqual([ask.id]);
    const beforeAnswer = events.filter((event) => event.type === "attention.changed").length;
    expect((await request("POST", `/api/elicitations/${ask.id}`, { action: "cancel" })).status).toBe(200);
    await until(() => events.filter((event) => event.type === "attention.changed").length > beforeAnswer);
    await app.orchestrator.idle(room.id);
    expect((await snapshot()).active).toEqual([]);
    const beforeFailure = events.filter((event) => event.type === "attention.changed").length;
    app.host.prompt = async () => {
      throw new Error("401 Unauthorized");
    };
    app.orchestrator.postHumanMessage(room.id, "Tester", "trigger a failed reply");
    await app.orchestrator.idle(room.id);
    await until(() => events.filter((event) => event.type === "attention.changed").length > beforeFailure);
    expect((await snapshot()).failures).toHaveLength(1);
    expect((await snapshot()).failures[0]?.kind).toBe("auth");
    for (const query of ["limit=0", "limit=51", "limit=1.2", "cursor=invalid"])
      expect((await request("GET", `/api/attention?${query}`)).status).toBe(400);
  } finally {
    ws.close();
    app.orchestrator.shutdown();
    await Promise.all(app.store.listRooms().map((room) => app.orchestrator.idle(room.id)));
    app.host.shutdown();
    app.installer.shutdown();
    app.registry.stop();
    await app.projectTerminals.shutdown();
    server.stop(true);
    app.store.db.close();
  }
});
