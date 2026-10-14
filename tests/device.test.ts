import { afterAll, describe, expect, test } from "bun:test";
import { serve } from "../server/app";
import { DeviceHub, type DeviceSocket } from "../server/device";
import { ROBOT_ACTIONS, ROBOT_EXPRESSIONS } from "../server/device-protocol";
import { mockRobotCue } from "../server/mock";
import { Store } from "../server/store";
import { testConfig } from "./helpers";

const caps = { expressions: [...ROBOT_EXPRESSIONS], actions: [...ROBOT_ACTIONS], asr: false, tts: false };

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  const closed: { code: number; reason: string }[] = [];
  const socket: DeviceSocket = {
    send: (d) => sent.push(JSON.parse(d)),
    close: (code, reason) => closed.push({ code, reason }),
  };
  return { socket, sent, closed };
}

function agentInput(name: string) {
  return {
    name,
    color: "#000000",
    avatar: "R",
    systemPrompt: "",
    tools: [],
    skills: [],
    modelMode: "auto" as const,
    pinnedModel: null,
  };
}

describe("device protocol (unit)", () => {
  const store = new Store(":memory:");
  const agent = store.createAgent(agentInput("Robo"));

  test("invalid JSON or schema closes with 1008 invalid_message", () => {
    const hub = new DeviceHub(store);
    for (const raw of ["{nope", JSON.stringify({ type: "hello", protocol: 2 }), JSON.stringify({ type: "dance" })]) {
      const f = fakeSocket();
      hub.handle(hub.open(f.socket), raw);
      expect(f.sent[0]).toMatchObject({ type: "error", code: "invalid_message" });
      expect(f.closed).toEqual([{ code: 1008, reason: "invalid_message" }]);
    }
  });

  test("messages before hello close with not_ready", () => {
    const hub = new DeviceHub(store);
    const f = fakeSocket();
    hub.handle(hub.open(f.socket), JSON.stringify({ type: "interrupt" }));
    expect(f.sent[0]).toMatchObject({ type: "error", code: "not_ready" });
    expect(f.closed[0]?.code).toBe(1008);
  });

  test("hello creates one persistent DM room per device+agent; seq is monotonic", () => {
    const hub = new DeviceHub(store);
    const f = fakeSocket();
    const conn = hub.open(f.socket);
    const hello = { type: "hello", protocol: 1, deviceId: "dev-1", agentId: agent.id, capabilities: caps };
    hub.handle(conn, JSON.stringify(hello));
    hub.handle(conn, JSON.stringify(hello));
    const welcomes = f.sent.filter((m) => m.type === "welcome");
    expect(welcomes).toHaveLength(2);
    expect(welcomes[0]?.roomId).toBe(welcomes[1]?.roomId as string);
    const room = store.getRoom(welcomes[0]?.roomId as string);
    expect(room).toMatchObject({ kind: "dm", deviceId: "dev-1", agentIds: [agent.id], name: "桌面机器人 · Robo" });
    expect(f.sent.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(f.sent[1]).toMatchObject({ type: "session.state", state: "idle" });
  });

  test("unknown agent is reported without closing", () => {
    const hub = new DeviceHub(store);
    const f = fakeSocket();
    hub.handle(
      hub.open(f.socket),
      JSON.stringify({ type: "hello", protocol: 1, deviceId: "d", agentId: "nope", capabilities: caps }),
    );
    expect(f.sent[0]).toMatchObject({ type: "error", code: "unknown_agent" });
    expect(f.closed).toEqual([]);
  });

  test("action dispatch: sent to the bound device, resolved by ack, rejected on nack/timeout/unsupported/offline", async () => {
    const hub = new DeviceHub(store, 50);
    const f = fakeSocket();
    const conn = hub.open(f.socket);
    hub.handle(
      conn,
      JSON.stringify({
        type: "hello",
        protocol: 1,
        deviceId: "dev-2",
        agentId: agent.id,
        capabilities: { ...caps, actions: ["nod", "wave"] },
      }),
    );
    const roomId = f.sent[0]?.roomId as string;
    const ctl = hub.controlFor(roomId);
    if (!ctl) throw new Error("expected device control");

    const ok = ctl.command("action", "wave");
    const cmd = f.sent.at(-1) as { type: string; id: string; name: string };
    expect(cmd).toMatchObject({ type: "action", name: "wave" });
    hub.handle(conn, JSON.stringify({ type: "ack", id: cmd.id, ok: true }));
    expect(await ok).toBe("设备已执行：action wave");

    const nack = ctl.command("expression", "sad");
    const cmd2 = f.sent.at(-1) as { id: string; durationMs: number };
    expect(cmd2.durationMs).toBeGreaterThan(0);
    hub.handle(conn, JSON.stringify({ type: "ack", id: cmd2.id, ok: false, error: "电量低" }));
    await expect(nack).rejects.toThrow("设备拒绝执行：电量低");

    await expect(ctl.command("action", "nod")).rejects.toThrow("50ms 内未确认");
    await expect(ctl.command("action", "dance")).rejects.toThrow("设备不支持动作 dance");
    await expect(ctl.command("action", "fly")).rejects.toThrow("未知动作");
    hub.close(conn);
    await expect(ctl.command("action", "nod")).rejects.toThrow("机器人设备未连接");
  });

  test("ordinary rooms get no device control", () => {
    const hub = new DeviceHub(store);
    expect(hub.controlFor(store.createRoom("g", "group", []).id)).toBeNull();
  });

  test("mock robot cues are deterministic", () => {
    expect(mockRobotCue("你好呀")).toEqual({ expression: "happy", action: "wave" });
    expect(mockRobotCue("跳个舞吧，跳舞")).toEqual({ expression: "happy", action: "dance" });
    expect(mockRobotCue("今天好难过")).toEqual({ expression: "sad", action: "shake_head" });
    expect(mockRobotCue("真的吗？")).toEqual({ expression: "surprised", action: "tilt" });
    expect(mockRobotCue("讲个故事")).toEqual({ expression: "happy", action: "nod" });
  });
});

describe("device channel over WebSocket (integration, mock provider)", () => {
  const { app, server } = serve(
    {
      config: testConfig(),
      configSource: "test",
      skills: { skills: [], errors: [] },
      dbPath: ":memory:",
      deviceAckTimeoutMs: 200,
    },
    0,
  );
  afterAll(() => server.stop(true));
  const agent = app.store.createAgent(agentInput("小机"));

  async function connect(autoAck = true) {
    const ws = new WebSocket(`ws://localhost:${server.port}/device`);
    const inbox: Record<string, unknown>[] = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      inbox.push(m);
      if (autoAck && (m.type === "action" || m.type === "expression"))
        ws.send(JSON.stringify({ type: "ack", id: m.id, ok: true }));
    });
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const until = async (pred: (m: Record<string, unknown>) => boolean, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await Bun.sleep(5);
      }
      throw new Error(`timeout; inbox=${JSON.stringify(inbox.map((m) => m.type))}`);
    };
    return { ws, inbox, until, send: (m: unknown) => ws.send(JSON.stringify(m)) };
  }

  test("utterance → accepted, thinking, expression+action, streamed reply, idle; persisted as a DM", async () => {
    const d = await connect();
    d.send({
      type: "hello",
      protocol: 1,
      deviceId: "robot-1",
      agentId: agent.id,
      userName: "Andy",
      capabilities: caps,
    });
    const welcome = await d.until((m) => m.type === "welcome");
    d.send({ type: "utterance", id: "u1", text: "你好，小机" });
    await d.until((m) => m.type === "utterance.accepted" && m.id === "u1");
    const end = await d.until((m) => m.type === "reply.end");
    await d.until((m) => m.type === "session.state" && m.state === "idle" && (m.seq as number) > (end.seq as number));

    const types = d.inbox.map((m) => m.type);
    const order = (t: string) => types.indexOf(t);
    expect(order("session.state")).toBeLessThan(order("utterance.accepted") + 1);
    expect(d.inbox.find((m) => m.type === "expression")).toMatchObject({ name: "happy" });
    expect(d.inbox.find((m) => m.type === "action")).toMatchObject({ name: "wave" });
    expect(d.inbox.some((m) => m.type === "session.state" && m.state === "thinking")).toBe(true);
    expect(d.inbox.some((m) => m.type === "session.state" && m.state === "replying")).toBe(true);
    const deltas = d.inbox
      .filter((m) => m.type === "reply.delta")
      .map((m) => m.text)
      .join("");
    expect(end).toMatchObject({ status: "done", error: null });
    expect(deltas).toBe(end.text as string);
    expect(order("action")).toBeLessThan(order("reply.delta"));
    const seqs = d.inbox.map((m) => m.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const { messages } = (await (
      await fetch(`http://localhost:${server.port}/api/rooms/${welcome.roomId}/messages`)
    ).json()) as {
      messages: { senderName: string; toolCalls: { name: string; status: string; result?: string }[] }[];
    };
    expect(messages.map((m) => m.senderName)).toEqual(["Andy", "小机"]);
    expect(messages[1]?.toolCalls.map((t) => [t.name, t.status])).toEqual([
      ["robot_express", "ok"],
      ["robot_action", "ok"],
    ]);
    const rooms = (await (await fetch(`http://localhost:${server.port}/api/rooms`)).json()) as {
      id: string;
      deviceId: string;
    }[];
    expect(rooms.find((r) => r.id === welcome.roomId)?.deviceId).toBe("robot-1");
    d.ws.close();
  });

  test("a device that never acks makes the tool fail truthfully, the reply still completes", async () => {
    const d = await connect(false);
    d.send({ type: "hello", protocol: 1, deviceId: "robot-mute", agentId: agent.id, capabilities: caps });
    await d.until((m) => m.type === "welcome");
    d.send({ type: "utterance", id: "u1", text: "讲个故事" });
    const end = await d.until((m) => m.type === "reply.end");
    expect(end.status).toBe("done");
    const msg = app.store.getMessage(end.messageId as string);
    expect(msg?.toolCalls.map((t) => t.status)).toEqual(["error", "error"]);
    expect(msg?.toolCalls[0]?.error).toContain("未确认");
    d.ws.close();
  });

  test("interrupt cancels the reply; barge-in utterance supersedes the running one", async () => {
    const d = await connect();
    d.send({ type: "hello", protocol: 1, deviceId: "robot-2", agentId: agent.id, capabilities: caps });
    await d.until((m) => m.type === "welcome");
    process.env.MOCK_CHUNK_DELAY_MS = "30";
    try {
      d.send({ type: "utterance", id: "u1", text: "请讲一个很长很长很长很长很长很长的故事" });
      await d.until((m) => m.type === "reply.delta");
      d.send({ type: "interrupt" });
      expect(await d.until((m) => m.type === "interrupt.result")).toMatchObject({ cancelled: true });
      expect(await d.until((m) => m.type === "reply.end")).toMatchObject({ status: "cancelled" });

      d.send({ type: "utterance", id: "u2", text: "第二个很长很长很长很长很长很长的问题" });
      await d.until((m) => m.type === "reply.start" && d.inbox.filter((x) => x.type === "reply.start").length === 2);
      await d.until((m) => m.type === "reply.delta" && d.inbox.filter((x) => x.type === "reply.end").length === 1);
      d.send({ type: "utterance", id: "u3", text: "算了，换个话题" });
      const ends = async () => {
        await d.until(() => d.inbox.filter((x) => x.type === "reply.end").length === 3, 5000);
        return d.inbox.filter((x) => x.type === "reply.end").map((x) => x.status);
      };
      expect(await ends()).toEqual(["cancelled", "cancelled", "done"]);
    } finally {
      process.env.MOCK_CHUNK_DELAY_MS = "0";
    }
    d.ws.close();
  });

  test("bind switches to another agent's conversation", async () => {
    const other = app.store.createAgent(agentInput("小二"));
    const d = await connect();
    d.send({ type: "hello", protocol: 1, deviceId: "robot-3", agentId: agent.id, capabilities: caps });
    const w1 = await d.until((m) => m.type === "welcome");
    d.send({ type: "bind", agentId: other.id });
    const w2 = await d.until((m) => m.type === "welcome" && m !== w1);
    expect(w2.roomId).not.toBe(w1.roomId);
    expect(w2.agent).toEqual({ id: other.id, name: "小二" });
    d.ws.close();
  });
});
