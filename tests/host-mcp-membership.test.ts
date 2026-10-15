import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { serve } from "../server/app";
import type { Agent, Message, Room } from "../server/store";
import { agentInput, until } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "tt-host-mcp-membership-"));
const { app, server } = serve({ dbPath: join(scratch, "state.db") }, 0);
const base = `http://127.0.0.1:${server.port}`;

afterAll(async () => {
  app.orchestrator.shutdown();
  app.host.shutdown();
  app.installer.shutdown();
  app.registry.stop();
  await app.projectTerminals.shutdown();
  server.stop(true);
  await Bun.sleep(300);
  app.store.db.close();
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string, http = false) {
  const cwd = join(scratch, name);
  mkdirSync(cwd);
  const sessions = join(cwd, "sessions");
  const lead = app.store.createAgent(
    agentInput(`${name}Lead`, {
      env: { MOCK_AGENT_SESSION_DIR: sessions, ...(http ? { MOCK_AGENT_MCP_HTTP: "1" } : {}) },
    }),
  );
  const workers = ["Dev", "Test"].map((role) => app.store.createAgent(agentInput(`${name}${role}`)));
  const project = app.store.createProject(name, cwd);
  const room = app.store.createRoom(name, [lead.id], { projectId: project.id });
  return { lead, workers, room, sessions };
}

async function addMembers(room: Room, workers: Agent[]): Promise<Room> {
  const response = await fetch(`${base}/api/rooms/${room.id}/agents`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentIds: [...room.agentIds, ...workers.map((agent) => agent.id)] }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Room;
}

const warm = (room: Room, agent: Agent) => app.host.session(room, agent, app.orchestrator.identityFor(room, agent));
const replies = (roomId: string, runId: string) =>
  app.store.recentMessages(roomId, 100).filter((message) => message.runId === runId && message.senderKind === "agent");

function expectSummary(messages: Message[], lead: Agent, workers: Agent[]) {
  expect(messages.map((message) => message.senderId)).toEqual([lead.id, ...workers.map((agent) => agent.id), lead.id]);
  expect(Object.values(messages[0]?.timeline?.tools ?? {}).map((tool) => tool.status)).toEqual([
    "completed",
    "completed",
  ]);
  expect(messages.at(-1)).toMatchObject({
    status: "done",
    timeline: { reviewOf: workers.map((agent) => agent.name) },
  });
  for (const worker of workers) expect(messages.at(-1)?.content).toContain(`${worker.name} [done]：`);
}

for (const http of [false, true])
  test(`${http ? "HTTP" : "stdio"}: a prewarmed DM gains group MCP through resume without losing its history`, async () => {
    const { lead, workers, room, sessions } = fixture(http ? "Http" : "Stdio", http);
    const before = await warm(room, lead);
    const old = app.orchestrator.postHumanMessage(room.id, "用户", "原单聊历史");
    await app.orchestrator.idle(room.id);
    const request = spyOn(before.proc.acp.agent, "request");
    try {
      const group = await addMembers(room, workers);
      const view = await app.host.sessionView(group, lead, app.orchestrator.identityFor(group, lead));
      expect(view.sessionId).toBe(before.slot.view.sessionId);
      const names = workers.map((agent) => agent.name).join(" ");
      const run = app.orchestrator.postHumanMessage(group.id, "用户", `/coordinate ${names}`);
      await app.orchestrator.idle(group.id);
      expectSummary(replies(group.id, run.id), lead, workers);
      const after = await warm(group, lead);
      expect(after.proc).toBe(before.proc);
      expect(after.slot.view.sessionId).toBe(before.slot.view.sessionId);
      expect(request.mock.calls.filter(([method]) => method === methods.agent.session.resume)).toHaveLength(1);
      expect(replies(group.id, old.id)[0]?.content).toContain("原单聊历史");
      const saved = JSON.parse(readFileSync(join(sessions, `${view.sessionId}.json`), "utf8")) as {
        history: { sessionUpdate: string; content?: { type: string; text?: string } }[];
      };
      expect(
        saved.history.some(
          (update) => update.sessionUpdate === "user_message_chunk" && update.content?.text?.includes("原单聊历史"),
        ),
      ).toBe(true);
    } finally {
      request.mockRestore();
    }
  });

test("refreshing a never-prompted session still delivers its first-prompt identity exactly once", async () => {
  const { lead, workers, room, sessions } = fixture("Identity");
  const before = await warm(room, lead);
  const group = await addMembers(room, workers);
  const run = app.orchestrator.postHumanMessage(
    group.id,
    "用户",
    `/coordinate ${workers.map((agent) => agent.name).join(" ")}`,
  );
  await app.orchestrator.idle(room.id);
  expectSummary(replies(room.id, run.id), lead, workers);
  expect(app.host.view(room.id, lead.id)?.sessionId).toBe(before.slot.view.sessionId);
  const saved = JSON.parse(readFileSync(join(sessions, `${before.slot.view.sessionId}.json`), "utf8")) as {
    identity: string;
    history: { sessionUpdate: string; content?: { type: string; text?: string } }[];
  };
  expect(saved.identity).toContain(`会话「${group.name}」`);
  expect(
    saved.history.filter(
      (update) =>
        update.sessionUpdate === "user_message_chunk" && update.content?.text?.includes("<tuantuan-identity>"),
    ),
  ).toHaveLength(1);
});

test("adding group members does not replace an active DM; the next queued prompt gains MCP", async () => {
  const { lead, workers, room } = fixture("Active");
  const before = await warm(room, lead);
  const direct = app.orchestrator.postHumanMessage(room.id, "用户", "/edit");
  const ask = await until(() => app.host.pendingAsks(room.id)[0]);
  const callback = before.slot.turn;
  const request = spyOn(before.proc.acp.agent, "request");
  try {
    const group = await addMembers(room, workers);
    const view = await app.host.sessionView(group, lead, app.orchestrator.identityFor(group, lead));
    expect(view).toBe(before.slot.view);
    expect(before.slot.turn).toBe(callback);
    expect(app.host.pendingAsks(room.id).map((pending) => pending.id)).toContain(ask.id);
    expect(request.mock.calls.filter(([method]) => method === methods.agent.session.resume)).toHaveLength(0);
    const run = app.orchestrator.postHumanMessage(
      group.id,
      "用户",
      `/coordinate ${workers.map((agent) => agent.name).join(" ")}`,
    );
    expect(app.orchestrator.state(room.id).tasks.find((task) => task.runId === run.id)?.status).toBe("queued");
    app.host.answer(ask.id, "reject");
    await app.orchestrator.idle(room.id);
    expect(replies(room.id, direct.id)[0]).toMatchObject({ status: "done" });
    expect(replies(room.id, direct.id)[0]?.content).toContain("好的，没有修改");
    expectSummary(replies(room.id, run.id), lead, workers);
    expect((await warm(group, lead)).proc).toBe(before.proc);
    expect(app.host.view(room.id, lead.id)?.sessionId).toBe(before.slot.view.sessionId);
    expect(request.mock.calls.filter(([method]) => method === methods.agent.session.resume)).toHaveLength(1);
  } finally {
    app.host.answer(ask.id, "reject");
    request.mockRestore();
  }
});
