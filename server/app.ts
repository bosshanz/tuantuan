import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { methods as acpMethods } from "@agentclientprotocol/sdk";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import { replayTurns } from "../shared/timeline";
import { AcpProcess, withTimeout } from "./acp";
import { AVATAR_SHAPES } from "./avatars";
import { detectHarness, harnessSpec, loginShellEnv, visibleHarnesses } from "./harness";
import { HarnessHost } from "./host";
import { EVERYONE_NAMES } from "./mentions";
import { Orchestrator, type RoomEvent } from "./orchestrator";
import { type AgentInput, PERMISSION_POLICIES, Store, ValidationError } from "./store";
import { TuantuanMcp } from "./tuantuan-mcp";
import { createWorkspace, existingFolder, workspacesRoot } from "./workspace";

const AgentInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "名称不能为空")
    .max(32, "名称最多 32 个字符")
    .refine((s) => !/[@\s`]/.test(s), "名称不能包含 @、空白或反引号（名称用于 @ 提及）")
    .refine(
      (s) => !(EVERYONE_NAMES as readonly string[]).includes(s.toLowerCase()),
      `名称不能是 ${EVERYONE_NAMES.join(" / ")}（保留给 @所有人）`,
    ),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "颜色格式应为 #RRGGBB")
    .optional(),
  avatar: z.string().trim().min(1).max(4).optional(),
  avatarShape: z.enum(AVATAR_SHAPES).optional(),
  identity: z.string().max(40000).default(""),
  harness: z.string().max(32).default(""),
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "环境变量名只能包含字母、数字和下划线"), z.string().max(8000))
    .default({}),
  mcpServerIds: z.array(z.string()).max(32).default([]),
  permissionPolicy: z.enum(PERMISSION_POLICIES).default("ask"),
});

const RoomInputSchema = z.object({
  name: z.string().trim().min(1, "房间名不能为空").max(64),
  kind: z.enum(["group", "dm"]),
  agentIds: z.array(z.string()),
  mainAgentId: z.string().nullable().optional(),
  cwd: z.string().max(1024).optional(),
});

const McpInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:/.test(u), "只支持 http(s) 地址"),
});

const ImageSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().max(7_000_000, "图片不能超过 5MB"),
});

export interface AppDeps {
  dbPath: string;
  staticDir?: string;
}

/** UI clients subscribe to room topics. */
type WsData = { kind: "ui"; rooms: Set<string> };

export function createApp(deps: AppDeps) {
  const store = new Store(deps.dbPath);
  let server: Server<WsData> | null = null;
  const publish = (roomId: string, event: RoomEvent) => {
    server?.publish(`room:${roomId}`, JSON.stringify(event));
  };
  const mcp = new TuantuanMcp();
  const host = new HarnessHost(
    store,
    {
      session: (roomId, agentId, view) => publish(roomId, { type: "session", roomId, agentId, view }),
      permission: (a) =>
        "resolved" in a
          ? publish(a.roomId, { type: "permission", roomId: a.roomId, ask: null, resolvedId: a.id })
          : publish(a.roomId, { type: "permission", roomId: a.roomId, ask: a }),
      terminal: (roomId, terminal) => publish(roomId, { type: "terminal", roomId, terminal }),
    },
    mcp,
  );
  const orchestrator = new Orchestrator(store, host, publish);
  mcp.provider = orchestrator;

  // Every conversation owns a working directory; older rooms without one get a workspace now.
  for (const r of store.listRooms()) if (!r.cwd) store.updateRoom(r.id, { cwd: createWorkspace(r.name) });

  const json = (data: unknown, status = 200) => Response.json(data, { status });

  function validateAgent(raw: unknown): AgentInput {
    const a = AgentInputSchema.parse(raw);
    if (a.harness && !harnessSpec(a.harness)) throw new ValidationError(`未知 Harness：${a.harness}`);
    const mcpIds = new Set(store.listMcpServers().map((s) => s.id));
    for (const m of a.mcpServerIds) if (!mcpIds.has(m)) throw new ValidationError(`未知 MCP 服务：${m}`);
    return { ...a, avatar: a.avatar ?? ([...a.name][0] as string) };
  }

  async function harnessStatuses() {
    const overrides = store.getSetting<Record<string, string>>("harnessPaths", {});
    return Promise.all(visibleHarnesses().map((h) => detectHarness(h, overrides[h.id] ?? null)));
  }

  /**
   * Spawns the harness once and runs the ACP handshake, optionally `authenticate` with one of its
   * agent-driven auth methods, then tries session/new to tell whether it is logged in.
   */
  async function probeHarness(id: string, methodId?: string) {
    const spec = harnessSpec(id);
    if (!spec) throw new ValidationError(`未知 Harness：${id}`, 404);
    const status = await detectHarness(spec, store.getSetting<Record<string, string>>("harnessPaths", {})[id] ?? null);
    if (!status.path) return { ok: false, error: status.error, install: spec.install, login: spec.login };
    const env = await loginShellEnv();
    const scratch = mkdtempSync(join(tmpdir(), "tuantuan-probe-"));
    const p = new AcpProcess(
      { command: status.path, args: spec.args, env, cwd: scratch },
      { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
    );
    try {
      const init = await p.initialize(30_000);
      const authMethods = (init.authMethods ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? null,
        type: "type" in m && m.type === "terminal" ? ("terminal" as const) : ("agent" as const),
        command: "type" in m && m.type === "terminal" ? [status.path, ...spec.args, ...(m.args ?? [])].join(" ") : null,
      }));
      let authError: string | null = null;
      if (methodId) {
        const m = authMethods.find((x) => x.id === methodId);
        if (!m) throw new ValidationError(`${spec.name} 没有登录方式 ${methodId}`);
        if (m.type !== "agent") throw new ValidationError(`「${m.name}」需要在终端里运行：${m.command}`);
        try {
          // Agent-driven login may open a browser and wait for the user: allow a long time.
          await withTimeout(
            p.agent.request(acpMethods.agent.authenticate, { methodId }),
            600_000,
            "登录超时（10 分钟）",
          );
        } catch (e) {
          authError = (e as Error).message;
        }
      }
      let loggedIn: boolean | null = null;
      let sessionError: string | null = null;
      try {
        await withTimeout(
          p.agent.request(acpMethods.agent.session.new, { cwd: scratch, mcpServers: [] }),
          60_000,
          "session/new 超时",
        );
        loggedIn = true;
      } catch (e) {
        const msg = (e as { message?: string }).message ?? String(e);
        if (/auth/i.test(msg)) loggedIn = false;
        else sessionError = msg;
      }
      return {
        ok: true,
        protocolVersion: init.protocolVersion,
        agentInfo: init.agentInfo ?? null,
        authMethods,
        capabilities: init.agentCapabilities ?? {},
        auth: spec.auth,
        login: spec.login,
        loggedIn,
        sessionError,
        authError,
      };
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      return { ok: false, error: (e as Error).message, login: spec.login };
    } finally {
      p.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  function agentIn(roomId: string, agentId: string | undefined) {
    const room = store.getRoom(roomId);
    if (!room) throw new ValidationError("房间不存在", 404);
    const agent = agentId && room.agentIds.includes(agentId) ? store.getAgent(agentId) : null;
    if (!agent) throw new ValidationError("该 Agent 不在这个会话里", 404);
    return { room, agent, identity: orchestrator.identityFor(room, agent) };
  }

  async function handleApi(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const [resource, id, sub, subId, action] = parts;
    const method = req.method;
    const body = async () => (method === "GET" || method === "DELETE" ? undefined : await req.json());

    // Onboarding shows once: finishing or skipping it is remembered in the database.
    if (resource === "onboarding" && method === "POST") {
      store.setSetting("onboarded", true);
      return json({ onboarded: true });
    }

    if (resource === "meta" && method === "GET")
      return json({
        onboarded: store.getSetting("onboarded", false),
        workspacesRoot: workspacesRoot(),
        harnesses: visibleHarnesses().map(({ id, name, install, auth, login, docs, identity }) => ({
          id,
          name,
          install,
          auth,
          login,
          docs,
          identity,
        })),
      });

    if (resource === "harnesses") {
      if (!id && method === "GET") return json(await harnessStatuses());
      if (id && sub === "path" && method === "PUT") {
        const { path } = z.object({ path: z.string().max(1024).nullable() }).parse(await body());
        const overrides = store.getSetting<Record<string, string>>("harnessPaths", {});
        if (path?.trim()) overrides[id] = path.trim();
        else delete overrides[id];
        store.setSetting("harnessPaths", overrides);
        return json(await harnessStatuses());
      }
      if (id && sub === "test" && method === "POST") return json(await probeHarness(id));
      if (id && sub === "authenticate" && method === "POST") {
        const { methodId } = z.object({ methodId: z.string().min(1) }).parse(await body());
        return json(await probeHarness(id, methodId));
      }
    }

    if (resource === "permissions" && id && method === "POST") {
      const { optionId } = z.object({ optionId: z.string().nullable() }).parse(await body());
      return host.answer(id, optionId) ? json({ ok: true }) : json({ error: "授权请求已失效" }, 404);
    }

    if (resource === "agents") {
      if (!id && method === "GET") return json(store.listAgents());
      if (!id && method === "POST") return json(store.createAgent(validateAgent(await body())), 201);
      if (id && method === "PUT") return json(store.updateAgent(id, validateAgent(await body())));
      if (id && method === "DELETE")
        return store.deleteAgent(id) ? json({ ok: true }) : json({ error: "Agent 不存在" }, 404);
    }

    if (resource === "mcp-servers") {
      if (!id && method === "GET") return json(store.listMcpServers());
      if (!id && method === "POST") {
        const s = McpInputSchema.parse(await body());
        return json(store.createMcpServer(s.name, s.url), 201);
      }
      if (id && !sub && method === "DELETE")
        return store.deleteMcpServer(id) ? json({ ok: true }) : json({ error: "MCP 服务不存在" }, 404);
    }

    if (resource === "rooms") {
      if (!id && method === "GET") return json(store.listRooms());
      if (!id && method === "POST") {
        const r = RoomInputSchema.parse(await body());
        if (r.kind === "dm" && r.agentIds.length !== 1) throw new ValidationError("私聊必须且只能包含 1 个 Agent");
        // A chosen folder must exist; otherwise the room gets a fresh workspace folder.
        const cwd = r.cwd?.trim() ? existingFolder(r.cwd) : createWorkspace(r.name);
        return json(store.createRoom(r.name, r.kind, r.agentIds, { mainAgentId: r.mainAgentId, cwd }), 201);
      }
      const room = id ? store.getRoom(id) : null;
      if (id && !room) return json({ error: "房间不存在" }, 404);
      if (room && !sub && method === "DELETE") {
        orchestrator.cancel(room.id);
        store.deleteRoom(room.id);
        return json({ ok: true });
      }
      if (room && !sub && method === "PATCH") {
        const g = z
          .object({ mainAgentId: z.string().nullable().optional(), cwd: z.string().max(1024).optional() })
          .parse(await body());
        if (g.mainAgentId !== undefined && room.kind !== "group") throw new ValidationError("只有群聊有主 Agent");
        return json(store.updateRoom(room.id, { ...g, cwd: g.cwd === undefined ? undefined : existingFolder(g.cwd) }));
      }
      if (room && sub === "agents" && !subId && method === "PUT") {
        const { agentIds } = z.object({ agentIds: z.array(z.string()) }).parse(await body());
        if (room.kind === "dm") throw new ValidationError("私聊的成员不能修改");
        return json(store.setRoomAgents(room.id, agentIds));
      }
      // Per-agent harness session controls: /api/rooms/:id/agents/:agentId/<action>
      if (room && sub === "agents" && subId) {
        const t = agentIn(room.id, subId);
        if (action === "session" && method === "GET")
          return json(await host.session(t.room, t.agent, t.identity).then((x) => x.slot.view));
        if (action === "session" && method === "POST") {
          const { sessionId } = z.object({ sessionId: z.string().nullable() }).parse(await body());
          return json(await host.switchSession(t.room, t.agent, t.identity, sessionId));
        }
        if (action === "history" && method === "GET") return json(await host.listSessions(t.room, t.agent, t.identity));
        if (action === "replay" && method === "GET") {
          // Drop turns this room already shows (same user text), so only history Tuantuan never saw remains.
          const seen = new Set(
            store
              .recentMessages(t.room.id, 500)
              .filter((m) => m.senderKind === "human")
              .map((m) => m.content.trim()),
          );
          return json(replayTurns(host.replay(t.room.id, t.agent.id)).filter((x) => !seen.has(x.user)));
        }
        if (action === "config" && method === "POST") {
          const c = z.object({ configId: z.string(), value: z.union([z.string(), z.boolean()]) }).parse(await body());
          return json(await host.setConfig(t.room, t.agent, t.identity, c.configId, c.value));
        }
        if (action === "mode" && method === "POST") {
          const { modeId } = z.object({ modeId: z.string() }).parse(await body());
          return json(await host.setMode(t.room, t.agent, t.identity, modeId));
        }
      }
      if (room && sub === "messages" && method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
        return json({
          messages: store.recentMessages(room.id, limit),
          state: orchestrator.state(room.id),
          sessions: Object.fromEntries(
            room.agentIds.map((a) => [a, host.view(room.id, a)]).filter((e) => e[1] !== null),
          ),
          asks: host.pendingAsks(room.id),
        });
      }
      if (room && sub === "messages" && method === "POST") {
        const m = z
          .object({
            senderName: z.string().max(32).default("我"),
            content: z.string().max(100000),
            images: z.array(ImageSchema).max(8).default([]),
          })
          .parse(await body());
        return json(orchestrator.postHumanMessage(room.id, m.senderName, m.content, m.images), 201);
      }
      if (room && sub === "cancel" && method === "POST") return json({ cancelled: orchestrator.cancel(room.id) });
    }
    return json({ error: "Not found" }, 404);
  }

  const staticDir = deps.staticDir ? resolve(deps.staticDir) : null;

  return {
    store,
    orchestrator,
    host,
    mcp,
    attach(s: Server<WsData>) {
      server = s;
      mcp.baseUrl = `http://127.0.0.1:${s.port}`;
    },
    async fetch(req: Request, srv: Server<WsData>): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { kind: "ui", rooms: new Set<string>() } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname.startsWith("/mcp/")) return mcp.handle(url.pathname.slice(5), req);
      if (url.pathname.startsWith("/api/")) {
        try {
          return await handleApi(req, url);
        } catch (e) {
          if (e instanceof ValidationError) return json({ error: e.message }, e.status);
          if (e instanceof z.ZodError) return json({ error: e.issues.map((i) => i.message).join("；") }, 400);
          if (e instanceof SyntaxError) return json({ error: "请求体不是合法 JSON" }, 400);
          console.error(e);
          return json({ error: `服务器错误：${(e as Error).message}` }, 500);
        }
      }
      if (staticDir) {
        const path = join(staticDir, url.pathname === "/" ? "index.html" : url.pathname);
        if (path.startsWith(staticDir) && existsSync(path) && !path.endsWith("/")) return new Response(Bun.file(path));
        return new Response(Bun.file(join(staticDir, "index.html")));
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        const data = ws.data;
        let msg: { type?: string; roomId?: string };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          ws.send(JSON.stringify({ type: "error", error: "消息不是合法 JSON" }));
          return;
        }
        if (typeof msg.roomId !== "string") {
          ws.send(JSON.stringify({ type: "error", error: "缺少 roomId" }));
          return;
        }
        if (msg.type === "subscribe") {
          ws.subscribe(`room:${msg.roomId}`);
          data.rooms.add(msg.roomId);
          ws.send(JSON.stringify({ type: "subscribed", roomId: msg.roomId, state: orchestrator.state(msg.roomId) }));
        } else if (msg.type === "unsubscribe") {
          ws.unsubscribe(`room:${msg.roomId}`);
          data.rooms.delete(msg.roomId);
        } else {
          ws.send(JSON.stringify({ type: "error", error: `未知消息类型 ${String(msg.type)}` }));
        }
      },
    },
  };
}

export function serve(deps: AppDeps, port: number) {
  const app = createApp(deps);
  const server = Bun.serve<WsData>({
    port,
    fetch: (req, srv) => app.fetch(req, srv),
    websocket: app.websocket,
  });
  app.attach(server);
  return { app, server };
}
