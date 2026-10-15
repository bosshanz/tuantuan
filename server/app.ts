import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { methods as acpMethods } from "@agentclientprotocol/sdk";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import { replayTurns } from "../shared/timeline";
import { AcpProcess, shellQuote, withTimeout } from "./acp";
import { AVATAR_SHAPES } from "./avatars";
import { CUSTOM_FORMATS, CUSTOM_HARNESS, testConnection } from "./custom";
import { listDirs, pickFolderNative, places } from "./dirpicker";
import {
  detectHarness,
  harnessSpec,
  installerStatuses,
  loginShellEnv,
  resetLoginShellEnv,
  visibleHarnesses,
} from "./harness";
import { HarnessHost } from "./host";
import { Installer } from "./installer";
import { EVERYONE_NAMES } from "./mentions";
import { Orchestrator, type RoomEvent } from "./orchestrator";
import * as skills from "./skills";
import { type AgentInput, PERMISSION_POLICIES, Store, ValidationError } from "./store";
import { TuantuanMcp } from "./tuantuan-mcp";
import {
  createProjectDir,
  DRAFTS_PROJECT_ID,
  ensureDrafts,
  existingFolder,
  expandHome,
  migrateRoomsToProjects,
  workspacesRoot,
} from "./workspace";

const CustomSchema = z.object({
  format: z.enum(CUSTOM_FORMATS),
  baseUrl: z
    .string()
    .trim()
    .max(512)
    .refine((u) => u === "" || /^https?:\/\/\S+$/.test(u), "Base URL 需以 http(s):// 开头")
    .default(""),
  model: z.string().trim().max(200).default(""),
  apiKey: z.string().max(4000).optional(),
});

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
  configDefaults: z.record(z.string().max(64), z.string().max(200)).default({}),
  custom: CustomSchema.nullable().optional(),
});

const RoomInputSchema = z.object({
  name: z.string().trim().min(1, "会话名不能为空").max(64),
  agentIds: z.array(z.string()).min(1, "至少选择 1 个 Agent"),
  mainAgentId: z.string().nullable().optional(),
  projectId: z.string().optional(),
});

const ProjectInputSchema = z.object({
  name: z.string().trim().min(1, "项目名不能为空").max(64),
  /** Existing folder; omitted/empty = create <root>/<slug>. */
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
  const dataDir =
    deps.dbPath === ":memory:" ? join(tmpdir(), `tuantuan-data-${process.pid}`) : dirname(resolve(deps.dbPath));
  let server: Server<WsData> | null = null;
  const publish = (roomId: string, event: RoomEvent) => {
    server?.publish(`room:${roomId}`, JSON.stringify(event));
  };
  const mcp = new TuantuanMcp();
  const host = new HarnessHost(
    store,
    dataDir,
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

  // Projects own the directories: make sure 「草稿」 exists and older rooms belong to a project.
  ensureDrafts(store);
  migrateRoomsToProjects(store);

  const json = (data: unknown, status = 200) => Response.json(data, { status });

  function validateAgent(raw: unknown): AgentInput {
    const a = AgentInputSchema.parse(raw);
    if (a.harness === CUSTOM_HARNESS) {
      if (!a.custom) throw new ValidationError("请填写自定义 API 设置");
      if (!a.custom.model) throw new ValidationError("请填写模型");
    } else {
      if (a.harness && !harnessSpec(a.harness)) throw new ValidationError(`未知 Harness：${a.harness}`);
      a.custom = null;
    }
    const mcpIds = new Set(store.listMcpServers().map((s) => s.id));
    for (const m of a.mcpServerIds) if (!mcpIds.has(m)) throw new ValidationError(`未知 MCP 服务：${m}`);
    return { ...a, avatar: a.avatar ?? ([...a.name][0] as string) };
  }

  const installer = new Installer(() => resetLoginShellEnv());

  async function harnessStatuses() {
    const overrides = store.getSetting<Record<string, string>>("harnessPaths", {});
    return Promise.all(visibleHarnesses().map((h) => detectHarness(h, overrides[h.id] ?? null)));
  }

  /**
   * Spawns the harness once and runs the ACP handshake, optionally `authenticate` with one of its
   * agent-driven auth methods, then tries session/new to tell whether it is logged in.
   */
  /** Config options a harness offers on a fresh session (for agent defaults), cached per harness. */
  const harnessOptions = new Map<
    string,
    { at: number; configOptions: acp.SessionConfigOption[]; modes: acp.SessionModeState | null; error: string | null }
  >();
  const optionsInflight = new Map<string, Promise<unknown>>();
  async function harnessOptionsFor(id: string, refresh: boolean) {
    const hit = harnessOptions.get(id);
    if (hit && !refresh && !hit.error && Date.now() - hit.at < 30 * 60_000) return hit;
    let job = optionsInflight.get(id);
    if (!job) {
      job = probeHarness(id)
        .then((r) => {
          const res = r as { ok: boolean; error?: string; sessionError?: string | null; loggedIn?: boolean | null };
          if (!harnessOptions.has(id) || harnessOptions.get(id)?.error || refresh) {
            const err = !res.ok
              ? (res.error ?? "无法启动")
              : res.loggedIn === false
                ? "需要先登录"
                : (res.sessionError ?? null);
            if (err) harnessOptions.set(id, { at: Date.now(), configOptions: [], modes: null, error: err });
          }
        })
        .catch((e) =>
          harnessOptions.set(id, { at: Date.now(), configOptions: [], modes: null, error: (e as Error).message }),
        )
        .finally(() => optionsInflight.delete(id));
      optionsInflight.set(id, job);
    }
    await job;
    return harnessOptions.get(id) ?? { at: Date.now(), configOptions: [], modes: null, error: "无法读取" };
  }

  async function probeHarness(id: string, methodId?: string) {
    const spec = harnessSpec(id);
    if (!spec) throw new ValidationError(`未知 Harness：${id}`, 404);
    const status = await detectHarness(spec, store.getSetting<Record<string, string>>("harnessPaths", {})[id] ?? null);
    const command = status.command;
    if (!command) return { ok: false, error: status.error, install: spec.install, login: status.login };
    const env = await loginShellEnv();
    const scratch = mkdtempSync(join(tmpdir(), "tuantuan-probe-"));
    const p = new AcpProcess(
      { command, args: status.args, env, cwd: scratch },
      { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
    );
    try {
      const init = await p.initialize(30_000);
      const authMethods = (init.authMethods ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? null,
        type: "type" in m && m.type === "terminal" ? ("terminal" as const) : ("agent" as const),
        command:
          "type" in m && m.type === "terminal"
            ? [command, ...status.args, ...(m.args ?? [])].map(shellQuote).join(" ")
            : null,
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
      let configOptions: acp.SessionConfigOption[] = [];
      let modes: acp.SessionModeState | null = null;
      try {
        const created = await withTimeout(
          p.agent.request(acpMethods.agent.session.new, { cwd: scratch, mcpServers: [] }),
          60_000,
          "session/new 超时",
        );
        configOptions = created.configOptions ?? [];
        modes = created.modes ?? null;
        harnessOptions.set(id, { at: Date.now(), configOptions, modes, error: null });
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
        configOptions,
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

    // BYOK connection test: one short request. The key comes from the form, or the saved agent's key.
    if (resource === "custom" && id === "test" && method === "POST") {
      const c = CustomSchema.extend({ agentId: z.string().optional() }).parse(await body());
      const saved = c.agentId ? store.getCustomSecret(c.agentId) : null;
      const cfg = {
        format: c.format,
        baseUrl: c.baseUrl,
        model: c.model,
        apiKey: c.apiKey?.trim() || saved?.apiKey || "",
      };
      try {
        const reply = await testConnection(cfg, AbortSignal.timeout(30_000));
        return json({ ok: true, reply });
      } catch (e) {
        return json({ ok: false, error: (e as Error).message });
      }
    }

    if (resource === "fs") {
      if (id === "pick" && method === "POST") {
        const b = z
          .object({ title: z.string().max(80).optional(), start: z.string().max(1024).optional() })
          .parse(await body());
        return json(await pickFolderNative(b.title || "选择文件夹", b.start ? expandHome(b.start) : undefined));
      }
      if (id === "dirs" && method === "GET")
        return json(listDirs(url.searchParams.get("path") ?? undefined, url.searchParams.get("hidden") === "1"));
      if (id === "places" && method === "GET") return json(places(store.listProjects().map((x) => x.cwd)));
    }

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
      if (id && sub === "options" && method === "GET") {
        if (id === "custom") return json({ configOptions: [], modes: null, error: null });
        const r = await harnessOptionsFor(id, url.searchParams.get("refresh") === "1");
        return json({ configOptions: r.configOptions, modes: r.modes, error: r.error });
      }
      if (id && sub === "install") {
        const spec = harnessSpec(id);
        if (!spec) throw new ValidationError(`未知 Harness：${id}`, 404);
        if (method === "GET") return json(installer.get(id, Number(url.searchParams.get("since") ?? 0) || 0));
        if (method === "DELETE") return json(installer.cancel(id));
        if (method === "POST") {
          const { installerId } = z.object({ installerId: z.string() }).parse(await body());
          const inst = spec.installers?.find((i) => i.id === installerId);
          if (!inst) throw new ValidationError(`${spec.name} 没有安装方式 ${installerId}`);
          const env = await loginShellEnv();
          const status = (await installerStatuses(spec, env)).find((i) => i.id === installerId);
          if (!status?.available) throw new ValidationError(status?.reason ?? "这台机器上不能用这种方式安装");
          return json(installer.start(id, inst, env), 202);
        }
      }
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
      if (id && sub === "skills" && method === "GET") {
        const agent = store.getAgent(id);
        if (!agent) throw new ValidationError("Agent 不存在", 404);
        const pid = url.searchParams.get("projectId");
        const project = pid ? store.getProject(pid) : null;
        return json({ items: skills.discoverSkills(dataDir, id, agent.harness, project?.cwd ?? null) });
      }
      if (id && sub === "skills" && method === "POST") {
        const agent = store.getAgent(id);
        if (!agent) throw new ValidationError("Agent 不存在", 404);
        const b = z
          .object({
            action: z.enum(["import", "enable", "disable", "preview-url", "import-url"]),
            path: z.string().optional(),
            key: z.string().optional(),
            url: z.string().max(2048).optional(),
            paths: z.array(z.string()).optional(),
          })
          .parse(await body());
        if (b.action === "import") {
          if (!b.path) throw new ValidationError("请选择文件夹");
          skills.importSkills(dataDir, id, b.path);
          return json({ ok: true });
        }
        if (b.action === "preview-url") {
          if (!b.url) throw new ValidationError("请填写链接");
          try {
            return json({ skills: (await skills.previewSkillUrl(dataDir, b.url)).skills });
          } catch (e) {
            throw new ValidationError((e as Error).message);
          }
        }
        if (b.action === "import-url") {
          if (!b.url || !b.paths?.length) throw new ValidationError("请选择要添加的 Skill");
          return json({ added: await skills.importSkillUrl(dataDir, id, b.url, b.paths) });
        }
        if (!b.key) throw new ValidationError("缺少 skill");
        const on = b.action === "enable";
        const imported = skills.listAgentSkills(dataDir, id).find((x) => resolve(x.dir) === resolve(b.key as string));
        if (imported) skills.setSkillEnabled(dataDir, id, imported.name, on);
        else skills.setSkillLinked(dataDir, id, b.key, on);
        return json({ ok: true });
      }
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

    if (resource === "projects") {
      if (!id && method === "GET") return json(store.listProjects());
      if (!id && method === "POST") {
        const p = ProjectInputSchema.parse(await body());
        const cwd = p.cwd?.trim() ? existingFolder(p.cwd) : createProjectDir(p.name);
        return json(store.createProject(p.name, cwd), 201);
      }
      const project = id ? store.getProject(id) : null;
      if (id && !project) return json({ error: "项目不存在" }, 404);
      if (project && method === "PATCH") {
        const p = ProjectInputSchema.partial().parse(await body());
        const cwd = p.cwd === undefined ? undefined : existingFolder(p.cwd);
        if (cwd !== undefined && cwd !== project.cwd)
          for (const r of store.listRooms()) if (r.projectId === project.id) orchestrator.cancel(r.id);
        return json(store.updateProject(project.id, { name: p.name, cwd }));
      }
      if (project && method === "DELETE") {
        if (project.id === DRAFTS_PROJECT_ID) throw new ValidationError("「草稿」不能删除");
        for (const r of store.listRooms()) if (r.projectId === project.id) orchestrator.cancel(r.id);
        store.deleteProject(project.id);
        return json({ ok: true });
      }
    }

    if (resource === "rooms") {
      if (!id && method === "GET") return json(store.listRooms());
      if (!id && method === "POST") {
        const r = RoomInputSchema.parse(await body());
        const projectId = r.projectId || ensureDrafts(store).id;
        if (!store.getProject(projectId)) throw new ValidationError("项目不存在", 404);
        return json(store.createRoom(r.name, r.agentIds, { mainAgentId: r.mainAgentId, projectId }), 201);
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
          .object({
            mainAgentId: z.string().nullable().optional(),
            name: z.string().trim().min(1).max(64).optional(),
            projectId: z.string().optional(),
          })
          .parse(await body());
        if (g.projectId && !store.getProject(g.projectId)) throw new ValidationError("项目不存在", 404);
        if (g.projectId && g.projectId !== room.projectId) orchestrator.cancel(room.id);
        return json(store.updateRoom(room.id, g));
      }
      if (room && sub === "agents" && !subId && method === "PUT") {
        const { agentIds } = z.object({ agentIds: z.array(z.string()) }).parse(await body());
        if (agentIds.length === 0) throw new ValidationError("至少保留 1 个 Agent");
        return json(store.setRoomAgents(room.id, agentIds));
      }
      // Per-agent harness session controls: /api/rooms/:id/agents/:agentId/<action>
      if (room && sub === "agents" && subId) {
        const t = agentIn(room.id, subId);
        if (action === "session" && method === "GET") return json(await host.sessionView(t.room, t.agent, t.identity));
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
    installer,
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
