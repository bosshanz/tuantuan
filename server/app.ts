import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import type { AppConfig } from "./config";
import { type DeviceConn, DeviceHub } from "./device";
import { McpConnections } from "./mcp";
import { Orchestrator, type RoomEvent } from "./orchestrator";
import type { SkillLoadResult } from "./skills";
import { type AgentInput, Store, ValidationError } from "./store";
import { BUILTIN_TOOLS } from "./tools";

const AgentInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "名称不能为空")
    .max(32, "名称最多 32 个字符")
    .refine((s) => !/[@\s`]/.test(s), "名称不能包含 @、空白或反引号（名称用于 @ 提及）"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色格式应为 #RRGGBB"),
  avatar: z.string().trim().min(1).max(4),
  systemPrompt: z.string().max(20000),
  tools: z.array(z.string()).max(64),
  skills: z.array(z.string()).max(64),
  modelMode: z.enum(["auto", "pinned"]),
  pinnedModel: z.string().nullable(),
});

const RoomInputSchema = z.object({
  name: z.string().trim().min(1, "房间名不能为空").max(64),
  kind: z.enum(["group", "dm"]),
  agentIds: z.array(z.string()),
});

const McpInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:/.test(u), "只支持 http(s) 地址"),
});

export interface AppDeps {
  config: AppConfig;
  configSource: string;
  skills: SkillLoadResult;
  dbPath: string;
  staticDir?: string;
  deviceAckTimeoutMs?: number;
}

/** UI clients subscribe to room topics; device clients speak the device protocol. */
type WsData = { kind: "ui"; rooms: Set<string> } | { kind: "device"; conn: DeviceConn | null };

export function createApp(deps: AppDeps) {
  const store = new Store(deps.dbPath);
  const mcp = new McpConnections();
  let server: Server<WsData> | null = null;
  const devices = new DeviceHub(store, deps.deviceAckTimeoutMs);
  const orchestrator = new Orchestrator(
    store,
    deps.config,
    deps.skills.skills,
    mcp,
    (roomId, event: RoomEvent) => {
      server?.publish(`room:${roomId}`, JSON.stringify(event));
      devices.onRoomEvent(roomId, event);
    },
    devices,
  );
  devices.orchestrator = orchestrator;

  const json = (data: unknown, status = 200) => Response.json(data, { status });

  function validateAgent(raw: unknown): AgentInput {
    const a = AgentInputSchema.parse(raw);
    const mcpIds = new Set(store.listMcpServers().map((s) => s.id));
    for (const t of a.tools) {
      const [kind, x] = t.split(":");
      const ok = (kind === "builtin" && x && x in BUILTIN_TOOLS) || (kind === "mcp" && x && mcpIds.has(x));
      if (!ok) throw new ValidationError(`未知工具：${t}`);
    }
    const skillNames = new Set(deps.skills.skills.map((s) => s.name));
    for (const s of a.skills) if (!skillNames.has(s)) throw new ValidationError(`未知 Skill：${s}`);
    if (a.modelMode === "pinned" && !deps.config.models.some((m) => m.id === a.pinnedModel))
      throw new ValidationError(`固定模型不存在：${a.pinnedModel ?? "(空)"}`);
    return { ...a, pinnedModel: a.modelMode === "pinned" ? a.pinnedModel : null };
  }

  async function handleApi(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const [resource, id, sub] = parts;
    const method = req.method;
    const body = async () => (method === "GET" || method === "DELETE" ? undefined : await req.json());

    if (resource === "meta" && method === "GET")
      return json({
        configSource: deps.configSource,
        models: deps.config.models.map(({ id, tags, costTier, contextWindow }) => ({
          id,
          tags,
          costTier,
          contextWindow,
        })),
        classifierModel: deps.config.router.classifierModel ?? null,
        limits: deps.config.limits,
        builtinTools: Object.values(BUILTIN_TOOLS).map((t) => ({
          id: `builtin:${t.spec.function.name}`,
          name: t.spec.function.name,
          description: t.spec.function.description,
        })),
        skills: deps.skills.skills.map(({ name, description }) => ({ name, description })),
        skillErrors: deps.skills.errors,
      });

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
      if (id && !sub && method === "DELETE") {
        await mcp.drop(id);
        return store.deleteMcpServer(id) ? json({ ok: true }) : json({ error: "MCP 服务不存在" }, 404);
      }
      if (id && sub === "tools" && method === "GET") {
        const s = store.listMcpServers().find((x) => x.id === id);
        if (!s) return json({ error: "MCP 服务不存在" }, 404);
        try {
          return json(await mcp.listTools(s.id, s.url));
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }
    }

    if (resource === "rooms") {
      if (!id && method === "GET") return json(store.listRooms());
      if (!id && method === "POST") {
        const r = RoomInputSchema.parse(await body());
        if (r.kind === "dm" && r.agentIds.length !== 1) throw new ValidationError("私聊必须且只能包含 1 个 Agent");
        return json(store.createRoom(r.name, r.kind, r.agentIds), 201);
      }
      const room = id ? store.getRoom(id) : null;
      if (id && !room) return json({ error: "房间不存在" }, 404);
      if (room && !sub && method === "DELETE") {
        orchestrator.cancel(room.id);
        store.deleteRoom(room.id);
        return json({ ok: true });
      }
      if (room && sub === "agents" && method === "PUT") {
        const { agentIds } = z.object({ agentIds: z.array(z.string()) }).parse(await body());
        if (room.kind === "dm") throw new ValidationError("私聊的成员不能修改");
        return json(store.setRoomAgents(room.id, agentIds));
      }
      if (room && sub === "messages" && method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
        const messages = store.recentMessages(room.id, limit);
        return json({
          messages,
          routing: store.routingFor(messages.filter((m) => m.senderKind === "agent").map((m) => m.id)),
          state: orchestrator.state(room.id),
        });
      }
      if (room && sub === "messages" && method === "POST") {
        const m = z
          .object({ senderName: z.string().max(32).default("我"), content: z.string().max(20000) })
          .parse(await body());
        return json(orchestrator.postHumanMessage(room.id, m.senderName, m.content), 201);
      }
      if (room && sub === "cancel" && method === "POST") return json({ cancelled: orchestrator.cancel(room.id) });
    }
    return json({ error: "Not found" }, 404);
  }

  const staticDir = deps.staticDir ? resolve(deps.staticDir) : null;

  return {
    store,
    orchestrator,
    devices,
    mcp,
    attach(s: Server<WsData>) {
      server = s;
    },
    async fetch(req: Request, srv: Server<WsData>): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { kind: "ui", rooms: new Set<string>() } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/device") {
        if (srv.upgrade(req, { data: { kind: "device", conn: null } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
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
      open(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "device")
          ws.data.conn = devices.open({ send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) });
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "device" && ws.data.conn) devices.close(ws.data.conn);
      },
      message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        if (ws.data.kind === "device") {
          if (ws.data.conn) devices.handle(ws.data.conn, String(raw));
          return;
        }
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
