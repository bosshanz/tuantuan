import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { methods as acpMethods, RequestError } from "@agentclientprotocol/sdk";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import { IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from "../shared/attachments";
import { missingKeyVar } from "../shared/auth";
import { translate } from "../shared/i18n";
import { type GlobalEvent, notifyForMessage, preview } from "../shared/notify";
import { messagePreview } from "../shared/roomPreview";
import { replayTurns } from "../shared/timeline";
import { AcpProcess, shellQuote, withTimeout } from "./acp";
import { AVATAR_SHAPES } from "./avatars";
import { CUSTOM_FORMATS, CUSTOM_HARNESS, maskKey, testConnection } from "./custom";
import { listDirs, pickFolderNative, places } from "./dirpicker";
import {
  detectHarness,
  harnessSpec,
  installerStatuses,
  loginShellEnv,
  REG_PREFIX,
  registryInstallable,
  resetLoginShellEnv,
  setRegistry,
  specForRegistryAgent,
  visibleHarnesses,
} from "./harness";
import { harnessRuntimeIdentity, invalidateHarnessRuntime } from "./harness-runtime";
import { ENV_NAME, harnessSecretEnv, openTerminal, publicHarnessEnv, setHarnessEnv } from "./harness-secrets";
import { HarnessHost, nativeReasoningPreferences, withProviderMeta } from "./host";
import { Installer } from "./installer";
import * as library from "./library";
import { installManaged, readManifest, setManagedRoot, uninstallManaged } from "./managed";
import { EVERYONE_NAMES } from "./mentions";
import { Orchestrator, type RoomEvent } from "./orchestrator";
import { ProfileSchema, readProfile } from "./profile";
import { PROJECT_TERMINAL_LIMITS, ProjectTerminals } from "./project-terminal";
import { providerReasoningDefaults } from "./provider-reasoning";
import { prepareProviderRuntime } from "./provider-runtime";
import {
  codexProviderSet,
  PRESETS,
  presetFor,
  providerBalance,
  providerConfigOptions,
  providerEnv,
  providerSupports,
  publicProvider,
  readCcSwitch,
  testProvider,
} from "./providers";
import { platformKey, Registry } from "./registry";
import {
  isRegistryUsageId,
  queryRegistryQuota,
  REGISTRY_USAGE_IDS,
  type RegistryQuota,
  type RegistryQuotaSnapshot,
  RegistryUsageCollector,
  type RegistryUsageId,
  registryUsageSource,
  ZCODE_070_NOTE,
} from "./registry-usage";
import * as skills from "./skills";
import { type AgentInput, PERMISSION_POLICIES, Store, ValidationError } from "./store";
import { TuantuanMcp } from "./tuantuan-mcp";
import {
  claudeLocalUsage,
  codexLocalUsage,
  grokLocalUsage,
  type HarnessUsage,
  type LimitWindow,
  parseClaudeUsageMarkdown,
  parseCodexStatusMarkdown,
  parseGrokBilling,
} from "./usage";
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
  useProfile: z.boolean().optional(),
  providerId: z.string().max(64).nullable().optional(),
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
  mimeType: z.enum(IMAGE_MIME_TYPES),
  data: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4, "每个附件不能超过 5 MiB"),
});

const FileSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  data: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4, "每个附件不能超过 5 MiB"),
});

export interface AppDeps {
  dbPath: string;
  staticDir?: string;
  /** Main-process secret; omitted for the ordinary browser server. */
  desktopUpdateToken?: string;
}

/** UI clients subscribe to room topics. */
type WsData = { kind: "ui"; rooms: Set<string> } | { kind: "project-terminal"; id: string; unsubscribe?: () => void };

function loopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Local clients and the Vite proxy share this boundary, including WebSocket upgrades and MCP. */
function localRequest(req: Request, url: URL): boolean {
  const host = req.headers.get("host");
  try {
    if (!loopbackHost(url.hostname) || (host && !loopbackHost(new URL(`http://${host}`).hostname))) return false;
    const origin = req.headers.get("origin");
    if (origin) {
      const source = new URL(origin);
      if (!/^https?:$/.test(source.protocol) || !loopbackHost(source.hostname)) return false;
    }
    // Browser navigation can omit Origin. Native local API/MCP clients omit both headers.
    return req.headers.get("sec-fetch-site") !== "cross-site";
  } catch {
    return false;
  }
}

export function createApp(deps: AppDeps) {
  const desktopUpdateToken = deps.desktopUpdateToken ?? process.env.TUANTUAN_DESKTOP_UPDATE_TOKEN;
  const store = new Store(deps.dbPath);
  const projectTerminals = new ProjectTerminals();
  const changingProjects = new Set<string>();
  const dataDir =
    deps.dbPath === ":memory:" ? join(tmpdir(), `tuantuan-data-${process.pid}`) : dirname(resolve(deps.dbPath));
  let server: Server<WsData> | null = null;
  const publishAll = (e: GlobalEvent) => server?.publish("all", JSON.stringify(e));
  const publish = (roomId: string, event: RoomEvent) => {
    server?.publish(`room:${roomId}`, JSON.stringify(event));
    if (event.type === "room.state") publishAll({ type: "activity", roomId, busy: !!event.state.activeRunId });
    else if (event.type === "message") {
      const last = messagePreview(event.message);
      if (last) publishAll({ type: "room.preview", roomId, last });
      const n = notifyForMessage(roomId, event.message, readProfile(store.getSetting("profile", {})).language);
      if (n) publishAll(n);
    } else if (event.type === "permission" && event.ask) {
      const agent = store.getAgent(event.ask.agentId);
      const locale = readProfile(store.getSetting("profile", {})).language;
      publishAll({
        type: "notify",
        kind: "permission",
        roomId,
        agentId: event.ask.agentId,
        agentName: agent?.name ?? "Agent",
        text: preview(
          translate(locale, "想要：{action}", {
            action: event.ask.toolCall.title ?? translate(locale, "执行操作"),
          }),
        ),
        id: event.ask.id,
      });
    }
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
      elicitation: (a) =>
        "resolved" in a
          ? publish(a.roomId, { type: "elicitation", roomId: a.roomId, ask: null, resolvedId: a.id })
          : publish(a.roomId, { type: "elicitation", roomId: a.roomId, ask: a }),
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
    if (a.providerId) {
      const prov = store.getProvider(a.providerId);
      if (!prov) throw new ValidationError("服务商不存在");
      if ((a.harness === "opencode" || a.harness === "pi") && !prov.model.trim())
        throw new ValidationError("OpenCode / Pi 使用服务商前，请先在服务商中填写主模型");
      if (!providerSupports(prov, a.harness)) throw new ValidationError(`「${prov.name}」不能用于这个 Harness`);
    }
    if (a.harness === CUSTOM_HARNESS && !a.providerId) {
      if (!a.custom) throw new ValidationError("请填写自定义 API 设置");
      if (!a.custom.model) throw new ValidationError("请填写模型");
    } else if (a.harness !== CUSTOM_HARNESS) {
      if (a.harness && !harnessSpec(a.harness)) throw new ValidationError(`未知 Harness：${a.harness}`);
      a.custom = null;
    }
    const mcpIds = new Set(store.listMcpServers().map((s) => s.id));
    for (const m of a.mcpServerIds) if (!mcpIds.has(m)) throw new ValidationError(`未知 MCP 服务：${m}`);
    return { ...a, avatar: a.avatar ?? ([...a.name][0] as string) };
  }

  const installer = new Installer((job) => {
    resetLoginShellEnv();
    if (job.state === "done") invalidateHarness(job.harnessId);
  });
  // ACP registry: harnesses Tuantuan installs into <data>/harnesses on click.
  setManagedRoot(join(dataDir, "harnesses"));
  const registry = new Registry(join(dataDir, "registry"));
  setRegistry(registry);
  registry.start();

  function registryView() {
    const st = registry.get();
    const plat = platformKey();
    return {
      source: st.source,
      fetchedAt: st.fetchedAt,
      error: st.error,
      invalid: st.invalid,
      platform: plat,
      agents: st.agents.map((a) => {
        const spec = specForRegistryAgent(a.id);
        const m = readManifest(a.id);
        const kinds = [
          a.distribution.npx && "npx",
          a.distribution.uvx && "uvx",
          a.distribution.binary && "binary",
        ].filter(Boolean);
        return {
          id: a.id,
          name: a.name,
          version: a.version,
          description: a.description,
          license: a.license,
          authors: a.authors,
          website: a.website ?? null,
          repository: a.repository ?? null,
          hasIcon: !!a.icon,
          kinds,
          platforms: a.distribution.binary ? Object.keys(a.distribution.binary) : ["all"],
          installable: registryInstallable(a),
          harnessId: spec?.id ?? `${REG_PREFIX}${a.id}`,
          curated: !!spec?.curated,
          installedVersion: m?.version ?? null,
          updateAvailable: !!(m && m.version !== a.version),
          experimental: "experimental" in a ? !!a.experimental : false,
          origin: a.origin ?? "acp",
          note: "note" in a ? (a.note as string) : null,
        };
      }),
    };
  }

  /** One-click install / update of a harness from its registry entry, as an install job. */
  function startRegistryInstall(harnessId: string, regId: string) {
    const a = registry.agent(regId);
    if (!a) throw new ValidationError(`Registry 里没有 ${regId}`, 404);
    if (!registryInstallable(a)) throw new ValidationError(`${a.name} 没有适合这台电脑（${platformKey()}）的安装包`);
    const spec = harnessSpec(harnessId);
    return installer.startTask(
      harnessId,
      "registry",
      `安装 ${a.name} ${a.version}（${a.origin === "tuantuan" ? "团团补充目录" : "ACP Registry"}）`,
      async (log, signal) => {
        const env = await loginShellEnv();
        await installManaged(a, { log, signal, env, runtime: spec?.runtime });
      },
    );
  }

  async function harnessStatuses() {
    const overrides = store.getSetting<Record<string, string>>("harnessPaths", {});
    return Promise.all(
      visibleHarnesses().map(async (h) => ({
        ...(await detectHarness(h, overrides[h.id] ?? null)),
        /** API keys saved for this harness in 团团 (masked). */
        secretEnv: publicHarnessEnv(store, h.id),
      })),
    );
  }
  /** Terminal login commands seen in the last handshake, per harness: only these can be opened. */
  const terminalCommands = new Map<string, Record<string, string>>();

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
  function invalidateHarness(id: string) {
    invalidateHarnessRuntime(id);
    for (const key of harnessOptions.keys()) if (key.startsWith(`${id}|`)) harnessOptions.delete(key);
    terminalCommands.delete(id);
  }
  const optionsKey = (id: string, prov: { id: string; updatedAt: number } | null, identity: string) =>
    `${id}|${identity}|${prov ? `${prov.id}|${prov.updatedAt}|${store.modelCatalog.status().sha256}` : "native"}`;
  async function harnessProbeLaunch(id: string, providerId?: string | null) {
    const spec = harnessSpec(id);
    if (!spec) throw new ValidationError(`未知 Harness：${id}`, 404);
    const status = await detectHarness(spec, store.getSetting<Record<string, string>>("harnessPaths", {})[id] ?? null);
    const env = { ...(await loginShellEnv()), ...status.env, ...harnessSecretEnv(store, id) };
    const prov = providerId ? store.getProvider(providerId) : null;
    if (providerId && !prov) throw new ValidationError("服务商不存在");
    if (prov && !providerSupports(prov, id)) throw new ValidationError(`「${prov.name}」不能用于这个 Harness`);
    if (prov) {
      const pe = providerEnv(prov, id, env);
      for (const key of pe.unset) delete env[key];
      Object.assign(env, pe.set);
    }
    return { spec, status, env, provider: prov, identity: harnessRuntimeIdentity(status, env) };
  }
  async function harnessOptionsFor(id: string, refresh: boolean, providerId: string | null = null) {
    const launch = await harnessProbeLaunch(id, providerId);
    const key = optionsKey(id, launch.provider, launch.identity);
    const hit = harnessOptions.get(key);
    if (hit && !refresh && !hit.error && Date.now() - hit.at < 30 * 60_000) return hit;
    let job = optionsInflight.get(key);
    if (!job) {
      job = probeHarness(id, undefined, providerId, launch)
        .then((r) => {
          const res = r as { ok: boolean; error?: string; sessionError?: string | null; loggedIn?: boolean | null };
          if (!harnessOptions.has(key) || harnessOptions.get(key)?.error || refresh) {
            const err = !res.ok
              ? (res.error ?? "无法启动")
              : res.loggedIn === false
                ? "需要先登录"
                : (res.sessionError ?? null);
            if (err) harnessOptions.set(key, { at: Date.now(), configOptions: [], modes: null, error: err });
          }
        })
        .catch((e) =>
          harnessOptions.set(key, { at: Date.now(), configOptions: [], modes: null, error: (e as Error).message }),
        )
        .finally(() => optionsInflight.delete(key));
      optionsInflight.set(key, job);
    }
    await job;
    if (harnessRuntimeIdentity(launch.status, launch.env) !== launch.identity)
      return harnessOptionsFor(id, refresh, providerId);
    return harnessOptions.get(key) ?? { at: Date.now(), configOptions: [], modes: null, error: "无法读取" };
  }

  /**
   * Live limits straight from the harness: runs its own usage command (Claude Code `/usage`,
   * codex-acp `/status`) in a throwaway session and parses the Markdown it prints. Grok uses
   * its read-only billing extension without a session or prompt. Uses the user's own login.
   */
  const liveLimits = new Map<
    string,
    { at: number; limits: LimitWindow[]; plan: string | null; error: string | null; creditBalanceUsd?: number | null }
  >();
  async function harnessLiveLimits(id: "claude-code" | "codex" | "grok") {
    const spec = harnessSpec(id);
    if (!spec) throw new ValidationError(`未知 Harness：${id}`, 404);
    const status = await detectHarness(spec, store.getSetting<Record<string, string>>("harnessPaths", {})[id] ?? null);
    const done = (
      limits: LimitWindow[],
      plan: string | null,
      error: string | null,
      creditBalanceUsd?: number | null,
    ) => {
      const r = { at: Date.now(), limits, plan, error, creditBalanceUsd };
      liveLimits.set(id, r);
      return r;
    };
    if (!status.command) return done([], null, status.error ?? "未安装");
    const env = { ...(await loginShellEnv()), ...status.env, ...harnessSecretEnv(store, id) };
    const scratch = mkdtempSync(join(tmpdir(), "tuantuan-usage-"));
    let text = "";
    const p = new AcpProcess(
      { command: status.command, args: status.args, env, cwd: scratch },
      {
        onUpdate: (n) => {
          const u = n.update;
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text += u.content.text;
        },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
    );
    try {
      await p.initialize(30_000);
      if (id === "grok") {
        // Billing is an ACP extension request, never a prompt or a model call.
        const billing = await withTimeout(p.agent.request("_x.ai/billing", {}), 30_000, "读取 Grok 额度超时");
        const r = parseGrokBilling(billing);
        return done(
          r.limits,
          r.plan,
          r.limits.length || r.creditBalanceUsd !== null ? null : "Grok 未返回额度或余额数据",
          r.creditBalanceUsd,
        );
      }
      const created = await withTimeout(
        p.agent.request(acpMethods.agent.session.new, { cwd: scratch, mcpServers: [] }),
        60_000,
        "session/new 超时",
      );
      await withTimeout(
        p.agent.request(acpMethods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: id === "claude-code" ? "/usage" : "/status" }],
        }),
        60_000,
        "读取用量超时",
      );
      if (id === "claude-code") {
        const r = parseClaudeUsageMarkdown(text);
        return done(
          r.limits,
          r.plan,
          r.limits.length ? null : "没有额度数据（API Key 或第三方服务没有 5 小时 / 每周额度）",
        );
      }
      const r = parseCodexStatusMarkdown(text);
      const err = r.limits.length
        ? null
        : r.account === "not logged in"
          ? "未登录"
          : "没有额度数据（API Key 登录没有额度窗口）";
      return done(r.limits, r.account, err);
    } catch (e) {
      const msg = (e as Error).message;
      return done(
        [],
        null,
        /auth/i.test(msg)
          ? "未登录"
          : id === "grok" && /method not found/i.test(msg)
            ? "当前 Grok 版本不支持额度查询，请更新 Grok"
            : msg,
      );
    } finally {
      // Grok has no session to save here; finish this read-only subprocess immediately.
      // No graceful-save interval or delayed process-group signal is needed.
      p.kill(id === "grok" ? "SIGKILL" : "SIGTERM");
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  const registryLimits = new Map<RegistryUsageId, RegistryQuotaSnapshot | null>();
  const registryLimitsInflight = new Map<RegistryUsageId, Promise<RegistryQuotaSnapshot>>();
  const registryQuotaKey = (id: RegistryUsageId) => `registryQuota:${id}`;
  const registryVersion = (id: RegistryUsageId) =>
    readManifest(id.slice(REG_PREFIX.length))?.version ?? registry.agent(id.slice(REG_PREFIX.length))?.version ?? null;
  function cachedRegistryLimits(id: RegistryUsageId) {
    if (!registryLimits.has(id))
      registryLimits.set(id, store.getSetting<RegistryQuotaSnapshot | null>(registryQuotaKey(id), null));
    return registryLimits.get(id) ?? null;
  }
  function registryQuotaFailure(error: unknown): RegistryQuota {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: number } | null)?.code;
    // Persist public status, never raw stderr, auth payloads or credential-bearing exceptions.
    const detail =
      code === RequestError.authRequired().code || /auth|not logged|unauthorized/i.test(message)
        ? "尚未登录或认证已失效，请先通过 Harness 的原生方式登录"
        : /method not found|not supported|unsupported/i.test(message)
          ? "当前 Harness 版本不支持额度查询"
          : /timeout|超时/i.test(message)
            ? "额度查询超时，请重试"
            : "额度查询失败，请重试或检查 Harness 的原生状态";
    return { limits: [], plan: null, notes: [], error: detail };
  }
  function syncRegistryLimits(id: RegistryUsageId, read: () => Promise<RegistryQuota>, freshAfterPending = false) {
    const pending = registryLimitsInflight.get(id);
    if (pending && !freshAfterPending) return pending;
    // A successful login changes the account state. Reserve a fresh read behind any older one;
    // manual refreshes can join this reservation, and the old snapshot cannot finish after it.
    const ready = pending ? pending.catch(() => undefined) : Promise.resolve();
    const job = ready
      .then(read)
      .catch(registryQuotaFailure)
      .then((result) => {
        const snapshot = { ...result, at: Date.now() };
        registryLimits.set(id, snapshot);
        store.setSetting(registryQuotaKey(id), snapshot);
        return snapshot;
      })
      .finally(() => {
        if (registryLimitsInflight.get(id) === job) registryLimitsInflight.delete(id);
      });
    registryLimitsInflight.set(id, job);
    return job;
  }
  async function registryLiveLimits(id: RegistryUsageId) {
    return syncRegistryLimits(id, async () => {
      const spec = harnessSpec(id);
      if (!spec) throw new ValidationError(`未知 Harness：${id}`, 404);
      const status = await detectHarness(
        spec,
        store.getSetting<Record<string, string>>("harnessPaths", {})[id] ?? null,
      );
      if (!status.command) return { limits: [], plan: null, notes: [], error: "Harness 未安装或配置的路径不可用" };
      const scratch = mkdtempSync(join(tmpdir(), "tuantuan-registry-usage-"));
      const collector = new RegistryUsageCollector();
      const process = new AcpProcess(
        {
          command: status.command,
          args: status.args,
          env: { ...(await loginShellEnv()), ...status.env, ...harnessSecretEnv(store, id) },
          cwd: scratch,
        },
        {
          onUpdate: collector.onUpdate,
          requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        },
      );
      try {
        await process.initialize(30_000);
        return await queryRegistryQuota(id, process, collector, { version: registryVersion(id) });
      } finally {
        process.kill();
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }

  let grokCache: { at: number; v: { usage: Awaited<ReturnType<typeof grokLocalUsage>>; note: string | null } } | null =
    null;
  async function grokUsage(force = false) {
    if (!force && grokCache && Date.now() - grokCache.at < 60_000) return grokCache.v;
    const spec = harnessSpec("grok");
    const status = spec
      ? await detectHarness(spec, store.getSetting<Record<string, string>>("harnessPaths", {}).grok ?? null)
      : null;
    let v: { usage: Awaited<ReturnType<typeof grokLocalUsage>>; note: string | null };
    if (!status?.command) v = { usage: null, note: "没有安装 Grok" };
    else {
      const usage = await grokLocalUsage(status.command);
      v = { usage, note: usage ? null : "没有 ~/.grok/sessions 记录" };
    }
    grokCache = { at: Date.now(), v };
    return v;
  }

  async function usageOverview(): Promise<HarnessUsage[]> {
    const out: HarnessUsage[] = [];
    const cl = claudeLocalUsage();
    const clLive = liveLimits.get("claude-code");
    out.push({
      harness: "claude-code",
      today: cl?.today ?? null,
      week: cl?.week ?? null,
      limits: clLive?.limits ?? [],
      limitsAt: clLive?.at ?? null,
      limitsSource: clLive ? "Claude Code /usage" : null,
      plan: clLive?.plan ?? null,
      notes: [
        ...(cl ? [] : ["没有 ~/.claude/projects 记录"]),
        ...(clLive?.error ? [clLive.error] : clLive ? [] : ["额度：点刷新向 Claude Code 查询"]),
      ],
    });
    const cx = codexLocalUsage();
    const cxLive = liveLimits.get("codex");
    const liveFresh = cxLive && cxLive.limits.length > 0 && (!cx?.limitsAt || cxLive.at > cx.limitsAt);
    out.push({
      harness: "codex",
      today: cx?.today ?? null,
      week: cx?.week ?? null,
      limits: liveFresh ? cxLive.limits : (cx?.limits ?? []),
      limitsAt: liveFresh ? cxLive.at : (cx?.limitsAt ?? null),
      limitsSource: liveFresh ? "codex /status" : cx?.limits.length ? "~/.codex/sessions token_count" : null,
      plan: cx?.plan ?? (liveFresh ? cxLive.plan : null),
      notes: [...(cx ? [] : ["没有 ~/.codex/sessions 记录"]), ...(cxLive?.error && !liveFresh ? [cxLive.error] : [])],
    });
    const gk = await grokUsage();
    const gkLive = liveLimits.get("grok");
    out.push({
      harness: "grok",
      today: gk.usage?.today ?? null,
      week: gk.usage?.week ?? null,
      costToday: gk.usage?.costToday ?? null,
      limits: gkLive?.limits ?? [],
      limitsAt: gkLive?.at ?? null,
      limitsSource:
        [gkLive ? "Grok ACP x.ai/billing" : null, gk.usage ? "grok usage <session>" : null]
          .filter(Boolean)
          .join("；") || null,
      plan: gkLive?.plan ?? null,
      creditBalanceUsd: gkLive?.creditBalanceUsd ?? null,
      notes: [
        ...(gk.note ? [gk.note] : []),
        ...(gkLive?.error ? [gkLive.error] : gkLive ? [] : ["额度：点刷新向 Grok 查询"]),
      ],
    });
    const configured = new Set(store.listAgents().map((agent) => agent.harness));
    const paths = store.getSetting<Record<string, string>>("harnessPaths", {});
    for (const id of REGISTRY_USAGE_IDS) {
      if (!readManifest(id.slice(REG_PREFIX.length)) && !paths[id] && !configured.has(id)) continue;
      const hit = cachedRegistryLimits(id);
      const notes = [
        ...(hit?.notes ?? []),
        ...(hit?.error ? [hit.error] : hit ? [] : ["额度尚未查询；请点刷新，或在 Harness 登录/测试成功后同步"]),
        ...(id === "reg:zcode-acp" && registryVersion(id) === "0.70.0" ? [ZCODE_070_NOTE] : []),
      ];
      out.push({
        harness: id,
        name: registry.agent(id.slice(REG_PREFIX.length))?.name ?? harnessSpec(id)?.name ?? id,
        live: true,
        today: null,
        week: null,
        limits: hit?.limits ?? [],
        limitsAt: hit?.at ?? null,
        limitsSource: hit ? registryUsageSource(id) : null,
        plan: hit?.plan ?? null,
        notes: [...new Set(notes)],
      });
    }
    return out;
  }

  async function probeHarness(
    id: string,
    methodId?: string,
    providerId?: string | null,
    launch?: Awaited<ReturnType<typeof harnessProbeLaunch>>,
  ) {
    const context = launch ?? (await harnessProbeLaunch(id, providerId));
    const { spec, status, env, provider: useProv, identity } = context;
    const current = () => harnessRuntimeIdentity(status, env) === identity;
    const command = status.command;
    if (!command) {
      if (isRegistryUsageId(id))
        await syncRegistryLimits(id, async () => ({
          limits: [],
          plan: null,
          notes: [],
          error: "Harness 未安装或配置的路径不可用",
        }));
      return { ok: false, error: status.error, install: spec.install, login: status.login };
    }
    const cacheKey = optionsKey(id, useProv, identity);
    const scratch = mkdtempSync(join(tmpdir(), "tuantuan-probe-"));
    const usageCollector = new RegistryUsageCollector();
    let runtime: Awaited<ReturnType<typeof prepareProviderRuntime>> | undefined;
    let p: AcpProcess;
    try {
      runtime = useProv
        ? await prepareProviderRuntime(useProv, id, env, status.version, { command, args: status.args, cwd: scratch })
        : undefined;
      p = new AcpProcess(
        { command, args: status.args, env: runtime?.env ?? env, cwd: scratch },
        { onUpdate: usageCollector.onUpdate, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
      );
    } catch (error) {
      runtime?.cleanup();
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
    void p.exited.then(() => runtime?.cleanup());
    try {
      const init = await p.initialize(30_000);
      const authMethods = (init.authMethods ?? []).map((m) => {
        const raw = m as { type?: string; vars?: { name: string }[] };
        return {
          id: m.id,
          name: m.name,
          description: m.description ?? null,
          type:
            "type" in m && m.type === "terminal"
              ? ("terminal" as const)
              : raw.type === "env_var"
                ? ("env" as const)
                : ("agent" as const),
          /** env_var methods: which variables to set (saved here, or in the agent's 环境变量). */
          vars: raw.type === "env_var" && Array.isArray(raw.vars) ? raw.vars.map((v) => v.name) : null,
          /** …and which of them are not set anywhere yet. */
          missing:
            raw.type === "env_var" && Array.isArray(raw.vars)
              ? raw.vars.map((v) => v.name).filter((n) => !env[n])
              : null,
          // Absolute command (managed runtime + script), with the env the registry asks for.
          command:
            "type" in m && m.type === "terminal"
              ? [
                  ...(Object.keys({ ...status.env, ...(m.env ?? {}) }).length
                    ? ["env", ...Object.entries({ ...status.env, ...(m.env ?? {}) }).map(([k, v]) => `${k}=${v}`)]
                    : []),
                  command,
                  ...status.args,
                  ...(m.args ?? []),
                ]
                  .map(shellQuote)
                  .join(" ")
              : null,
        };
      });
      // DSH's ACP authentication is a no-op. Offer its documented env fallback without claiming
      // the key is required: its native credential file can already provide a higher-priority key.
      if (id === "deepseek")
        authMethods.push({
          id: "deepseek-api-key",
          name: "DeepSeek API Key",
          description: spec.auth,
          type: "env",
          vars: ["DEEPSEEK_API_KEY"],
          missing: null,
          command: null,
        });
      // A method whose description says "run `glm-acp-agent --setup`" gets a terminal login too,
      // with the real (managed, absolute) command instead of a name that is not on PATH.
      const bins = new Set(
        [command, ...status.args].map((x) => basename(x).replace(/\.(c|m)?js$/, "")).filter(Boolean),
      );
      for (const m of [...authMethods]) {
        const hit = (m.description ?? "").match(/`([\w.@/-]+)((?:\s+--?[\w-]+)+)`/);
        const name = basename(hit?.[1] ?? "");
        const ours =
          bins.has(name) ||
          name === spec.registry ||
          [command, ...status.args].some((x) => x.split(/[\\/]/).includes(name));
        if (!hit || !ours || m.type === "terminal") continue;
        const flags = (hit[2] as string).trim().split(/\s+/);
        authMethods.push({
          id: `${m.id}:terminal`,
          name: `${hit[1]} ${flags.join(" ")}`,
          description: m.description,
          type: "terminal" as const,
          vars: null,
          missing: null,
          command: [
            ...(Object.keys(status.env).length
              ? ["env", ...Object.entries(status.env).map(([k, v]) => `${k}=${v}`)]
              : []),
            command,
            ...status.args,
            ...flags,
          ]
            .map(shellQuote)
            .join(" "),
        });
      }
      if (current())
        terminalCommands.set(
          id,
          Object.fromEntries(authMethods.filter((m) => m.command).map((m) => [m.id, m.command as string])),
        );
      // API-key login offered, no key set anywhere, and no agent-driven login: the first prompt will
      // likely fail (glm-acp-agent opens sessions fine and fails on the prompt). With a terminal
      // method too (e.g. `--setup` storing the key in its own file) we can't tell, so only hint.
      const envMethods = authMethods.filter((m) => m.type === "env");
      const keyVars = envMethods.flatMap((m) => m.vars ?? []);
      // An "agent" method that is really the same key (its description names the variable, like
      // glm-acp-agent's) is not a separate way to sign in.
      const realAgentLogin = authMethods.some(
        (m) => m.type === "agent" && !keyVars.some((v) => (m.description ?? "").includes(v)),
      );
      const needsKey =
        envMethods.length > 0 && envMethods.every((m) => (m.missing?.length ?? 0) > 0) && !realAgentLogin;
      const keyOnly = needsKey && !authMethods.some((m) => m.type === "terminal") && !realAgentLogin;
      let authError: string | null = null;
      if (methodId) {
        const m = authMethods.find((x) => x.id === methodId);
        if (!m) throw new ValidationError(`${spec.name} 没有登录方式 ${methodId}`);
        if (m.type === "env")
          throw new ValidationError(`「${m.name}」要在 Agent 的环境变量里设置 ${m.vars?.join("、") ?? ""}`);
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
      let createdSession: acp.NewSessionResponse | null = null;
      let loggedIn: boolean | null = null;
      let sessionError: string | null = null;
      let configOptions: acp.SessionConfigOption[] = [];
      let modes: acp.SessionModeState | null = null;
      try {
        const created = await withTimeout(
          (async () => {
            if (useProv && id === "codex")
              await p.agent.request(
                acpMethods.agent.providers.set,
                codexProviderSet(useProv) as unknown as acp.SetProviderRequest,
              );
            return p.agent.request(acpMethods.agent.session.new, {
              cwd: scratch,
              mcpServers: [],
              _meta: withProviderMeta(undefined, { harness: id, providerId: useProv?.id ?? null }, store, {
                provider: useProv,
                env: p.launch.env,
              }),
            });
          })(),
          60_000,
          "session/new 超时",
        );
        createdSession = created;
        configOptions = providerConfigOptions(useProv, id, created.configOptions ?? [], p.launch.env);
        const modelOption = configOptions.find((option) => option.category === "model" || option.id === "model");
        if (
          useProv?.model &&
          id === "claude-code" &&
          modelOption?.type === "select" &&
          modelOption.currentValue !== useProv.model &&
          modelOption.options
            .flatMap((item) => ("options" in item ? item.options : [item]))
            .some((item) => item.value === useProv.model)
        ) {
          try {
            const applied = await withTimeout(
              p.agent.request(acpMethods.agent.session.setConfigOption, {
                sessionId: created.sessionId,
                configId: modelOption.id,
                value: useProv.model,
              }),
              20_000,
              "设置服务商模型超时",
            );
            configOptions = providerConfigOptions(useProv, id, applied.configOptions, p.launch.env);
          } catch {
            /* Keep the real model if the optional raw-ID picker is rejected. */
          }
        }
        for (const [configId, value] of Object.entries({
          ...(runtime?.reasoningPreferences ?? providerReasoningDefaults(useProv, id, configOptions)),
          ...nativeReasoningPreferences(id, env),
        })) {
          try {
            const applied = await withTimeout(
              p.agent.request(acpMethods.agent.session.setConfigOption, {
                sessionId: created.sessionId,
                configId,
                value,
              }),
              20_000,
              "设置服务商默认推理等级超时",
            );
            configOptions = providerConfigOptions(useProv, id, applied.configOptions, p.launch.env);
          } catch {
            // A rejected default is optional; show the harness's actual current configuration.
          }
        }
        modes = created.modes ?? null;
        if (current()) harnessOptions.set(cacheKey, { at: Date.now(), configOptions, modes, error: null });
        loggedIn = id === "deepseek" ? null : true;
      } catch (e) {
        const error = e as { message?: string; code?: number } | null;
        const msg = error?.message ?? String(e);
        sessionError = msg;
        if (
          error?.code === RequestError.authRequired().code ||
          missingKeyVar(msg) !== null ||
          /\b(?:auth(?:entication|orization)?(?:[ _-]+is)?[ _-]+(?:required|failed)|unauthenticated|unauthorized|not authenticated)\b/i.test(
            msg,
          )
        )
          loggedIn = false;
      }
      if (keyOnly) loggedIn = false;
      if (isRegistryUsageId(id) && !useProv) {
        const created = createdSession;
        if (loggedIn === true && !authError && created)
          await syncRegistryLimits(
            id,
            () => queryRegistryQuota(id, p, usageCollector, { created, version: registryVersion(id) }),
            true,
          );
        else if (loggedIn === false || authError || sessionError)
          await syncRegistryLimits(id, async () =>
            registryQuotaFailure(new Error(authError ?? sessionError ?? "authentication required")),
          );
      }
      if (!current()) throw new ValidationError("会话配置已更改，请重试", 409);
      return {
        ok: true,
        protocolVersion: init.protocolVersion,
        agentInfo: init.agentInfo ?? null,
        authMethods,
        capabilities: init.agentCapabilities ?? {},
        auth: spec.auth,
        login: spec.login,
        loggedIn,
        needsKey,
        secretEnv: publicHarnessEnv(store, id),
        sessionError,
        authError,
        configOptions,
      };
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      if (isRegistryUsageId(id) && !useProv) await syncRegistryLimits(id, async () => registryQuotaFailure(e));
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

  async function handleApi(req: Request, url: URL, srv: Server<WsData>): Promise<Response> {
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .slice(1) // drop "api"
      .map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          return p;
        }
      });
    const [resource, id, sub, subId, action] = parts;
    const method = req.method;
    const body = async () => (method === "GET" || method === "DELETE" ? undefined : await req.json());

    if (resource === "desktop") {
      if (!desktopUpdateToken) return json({ error: "Not found" }, 404);
      if (req.headers.get("authorization") !== `Bearer ${desktopUpdateToken}`)
        return json({ error: "Unauthorized" }, 401);
      if (parts.length === 2) {
        if (id === "update-activity" && method === "GET") return json(orchestrator.desktopUpdateActivity());
        if (id === "update-prepare" && method === "POST") return json(orchestrator.prepareDesktopUpdate());
        if (id === "update-resume" && method === "POST") return json(orchestrator.resumeAfterDesktopUpdate());
      }
      return json({ error: "Not found" }, 404);
    }

    // Onboarding shows once: finishing or skipping it is remembered in the database.
    if (resource === "onboarding" && method === "POST") {
      store.setSetting("onboarded", true);
      return json({ onboarded: true });
    }

    // 个人资料: name, avatar, 「关于我」, appearance, timezone, language.
    if (resource === "profile" && !id) {
      if (method === "GET") return json(readProfile(store.getSetting("profile", {})));
      if (method === "PUT") {
        const p = ProfileSchema.parse(await body());
        store.setSetting("profile", p);
        publishAll({ type: "profile.updated", profile: p });
        return json(p);
      }
    }

    if (resource === "health" && method === "GET") return json({ ok: true, pid: process.pid });

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

    if (resource === "providers") {
      if (id === "models" && method === "GET")
        return json({
          ...store.modelCatalog.status(),
          items: store.modelCatalog.search((url.searchParams.get("query") ?? "").slice(0, 200)),
        });
      if (id === "models" && sub === "sync" && method === "POST") {
        srv.timeout(req, 45);
        try {
          return json(await store.modelCatalog.sync());
        } catch (error) {
          throw new ValidationError(`模型能力同步失败：${(error as Error).message}`, 502);
        }
      }
      const ProviderBody = z.object({
        name: z.string().trim().min(1, "名称不能为空").max(40),
        preset: z.string().max(32).default("custom"),
        anthropicBaseUrl: z.string().trim().max(500).default(""),
        openaiBaseUrl: z.string().trim().max(500).default(""),
        apiKey: z.string().max(4000).default(""),
        mgmtKey: z.string().max(4000).default(""),
        model: z.string().trim().max(200).default(""),
        smallModel: z.string().trim().max(200).default(""),
        wireApi: z.enum(["responses", "chat"]).default("chat"),
        modelCatalog: z
          .record(z.string().trim().min(1).max(200), z.string().trim().max(400))
          .refine((value) => Object.keys(value).length <= 20, "模型能力来源最多 20 项")
          .optional(),
      });
      const urlOk = (u: string) => !u || /^https?:\/\//.test(u);
      const check = (b: z.infer<typeof ProviderBody>, previous?: Record<string, string>) => {
        if (!b.anthropicBaseUrl && !b.openaiBaseUrl) throw new ValidationError("至少填写一个接口地址");
        if (!urlOk(b.anthropicBaseUrl) || !urlOk(b.openaiBaseUrl))
          throw new ValidationError("地址需以 http(s):// 开头");
        for (const [model, reference] of Object.entries(b.modelCatalog ?? {})) {
          // A catalog removal must not prevent unrelated provider edits. Keep an
          // unchanged binding as user intent; unknown capabilities stay unknown.
          if (reference && reference !== previous?.[model] && !store.modelCatalog.has(reference))
            throw new ValidationError("模型能力来源不存在，请从目录建议中选择");
        }
      };
      const usedBy = (pid: string) =>
        store
          .listAgents()
          .filter((a) => a.providerId === pid)
          .map((a) => a.name);
      const list = () => store.listProviders().map((x) => ({ ...publicProvider(x), usedBy: usedBy(x.id) }));
      if (!id && method === "GET") return json({ items: list(), presets: PRESETS });
      if (id === "ccswitch" && method === "GET") {
        const r = readCcSwitch();
        return json({
          found: r.found,
          source: r.source,
          entries: r.entries.map(({ apiKey, ...e }) => ({ ...e, keyHint: maskKey(apiKey) })),
        });
      }
      if (id === "ccswitch" && method === "POST") {
        const { keys } = z.object({ keys: z.array(z.string()).max(200) }).parse(await body());
        const r = readCcSwitch();
        let n = 0;
        for (const e of r.entries.filter((x) => keys.includes(x.key))) {
          store.saveProvider({
            name: e.name,
            preset: presetFor(e.anthropicBaseUrl || e.openaiBaseUrl),
            anthropicBaseUrl: e.anthropicBaseUrl,
            openaiBaseUrl: e.openaiBaseUrl,
            apiKey: e.apiKey,
            model: e.model,
            smallModel: e.smallModel,
            wireApi: e.wireApi,
          });
          n++;
        }
        return json({ imported: n, items: list() });
      }
      if (!id && method === "POST") {
        const b = ProviderBody.parse(await body());
        check(b);
        const saved = store.saveProvider(b);
        return json({ ...publicProvider(saved), usedBy: [] }, 201);
      }
      const prov = id ? store.getProvider(id) : null;
      if (id && !prov) throw new ValidationError("服务商不存在", 404);
      if (prov && !sub && method === "PUT") {
        const b = ProviderBody.parse(await body());
        check(b, prov.modelCatalog);
        const incompatible = store
          .listAgents()
          .filter((a) => a.providerId === prov.id && !providerSupports(b, a.harness));
        if (incompatible.length)
          throw new ValidationError(
            `这个配置无法用于 ${incompatible.map((a) => a.name).join("、")}，请保留所需的接口地址、格式和主模型，或先切换这些 Agent 的服务商`,
          );
        // agents using it pick the change up on their next turn (process signature changes)
        return json({ ...publicProvider(store.saveProvider({ ...b, id: prov.id })), usedBy: usedBy(prov.id) });
      }
      if (prov && !sub && method === "DELETE") {
        store.deleteProvider(prov.id);
        return json({ ok: true });
      }
      if (prov && sub === "test" && method === "POST") return json(await testProvider(prov));
      if (prov && sub === "balance" && method === "GET") return json(await providerBalance(prov));
    }

    if (resource === "usage") {
      if (!id && method === "GET") {
        const day = new Date();
        const since = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
        return json({ harnesses: await usageOverview(), tuantuan: store.usageSince(since) });
      }
      // Token dashboard: only what harnesses reported per turn; `reporting` = harnesses that ever did.
      if (id === "stats" && method === "GET") {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const tz = Number(url.searchParams.get("tz") ?? 0) || 0;
        return json({ ...store.usageStats(since, tz), reporting: store.usageHarnesses() });
      }
      if ((id === "claude-code" || id === "codex") && sub === "live" && parts.length === 3 && method === "POST") {
        // ACP supplies bounded operation deadlines; the HTTP connection must survive those operations.
        srv.timeout(req, 0);
        await harnessLiveLimits(id);
        return json({ harnesses: await usageOverview() });
      }
      if (id && isRegistryUsageId(id) && sub === "live" && parts.length === 3 && method === "POST") {
        srv.timeout(req, 0);
        await registryLiveLimits(id);
        return json({ harnesses: await usageOverview() });
      }
      if (id === "grok" && sub === "live" && parts.length === 3 && method === "POST") {
        srv.timeout(req, 0);
        await Promise.all([grokUsage(true), harnessLiveLimits(id)]);
        return json({ harnesses: await usageOverview() });
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

    if (resource === "registry") {
      if (!id && method === "GET") return json(registryView());
      if (id === "refresh" && method === "POST") {
        await registry.refresh();
        return json(registryView());
      }
      if (id === "icon" && sub && method === "GET") {
        const svg = await registry.icon(sub);
        if (!svg) return new Response("not found", { status: 404 });
        return new Response(svg, {
          headers: {
            "content-type": "image/svg+xml",
            "cache-control": "public, max-age=86400",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          },
        });
      }
      if (id === "install" && sub && method === "POST") {
        const spec = specForRegistryAgent(sub);
        return json(startRegistryInstall(spec?.id ?? `${REG_PREFIX}${sub}`, sub), 202);
      }
    }

    if (resource === "harnesses") {
      if (!id && method === "GET") return json(await harnessStatuses());
      if (id && sub === "managed" && method === "DELETE") {
        const spec = harnessSpec(id);
        if (!spec?.registry) throw new ValidationError(`${id} 不是团团安装的`, 404);
        if (installer.get(id)?.state === "running") throw new ValidationError("正在安装，先取消");
        host.dropHarness(id);
        invalidateHarness(id);
        uninstallManaged(spec.registry);
        return json(await harnessStatuses());
      }
      if (id && sub === "path" && method === "PUT") {
        const { path } = z.object({ path: z.string().max(1024).nullable() }).parse(await body());
        const overrides = store.getSetting<Record<string, string>>("harnessPaths", {});
        if (path?.trim()) overrides[id] = path.trim();
        else delete overrides[id];
        store.setSetting("harnessPaths", overrides);
        invalidateHarness(id);
        return json(await harnessStatuses());
      }
      if (id && sub === "test" && parts.length === 3 && method === "POST") {
        if (!harnessSpec(id)) throw new ValidationError(`未知 Harness：${id}`, 404);
        srv.timeout(req, 0);
        return json(await probeHarness(id));
      }
      // API keys for this harness (env_var auth): saved masked, injected into its processes only.
      if (id && sub === "env") {
        if (!harnessSpec(id)) throw new ValidationError(`未知 Harness：${id}`, 404);
        if (method === "GET") return json({ secretEnv: publicHarnessEnv(store, id) });
        if (method === "PUT") {
          const { values } = z
            .object({ values: z.record(z.string().regex(ENV_NAME), z.string().max(4096).nullable()) })
            .parse(await body());
          setHarnessEnv(store, id, values);
          invalidateHarness(id);
          host.dropHarness(id); // running processes restart with the new env on next use
          return json({ secretEnv: publicHarnessEnv(store, id) });
        }
      }
      // Open a terminal running one of the harness's own terminal-login commands (from its handshake).
      if (id && sub === "terminal" && method === "POST") {
        const { methodId } = z.object({ methodId: z.string().min(1) }).parse(await body());
        const cmd = terminalCommands.get(id)?.[methodId];
        if (!cmd) throw new ValidationError("先做一次握手测试，再打开终端");
        const ok = openTerminal(cmd, await loginShellEnv());
        return json({ ok, command: cmd, error: ok ? null : "这台电脑上找不到终端程序，请复制命令到终端运行" });
      }
      if (id && sub === "options" && method === "GET") {
        if (id === "custom") return json({ configOptions: [], modes: null, error: null });
        const r = await harnessOptionsFor(
          id,
          url.searchParams.get("refresh") === "1",
          url.searchParams.get("provider") || null,
        );
        return json({ configOptions: r.configOptions, modes: r.modes, error: r.error });
      }
      if (id && sub === "install") {
        const spec = harnessSpec(id);
        if (!spec) throw new ValidationError(`未知 Harness：${id}`, 404);
        if (method === "GET") return json(installer.get(id, Number(url.searchParams.get("since") ?? 0) || 0));
        if (method === "DELETE") return json(installer.cancel(id));
        if (method === "POST") {
          const { installerId } = z.object({ installerId: z.string() }).parse(await body());
          if (installerId === "registry") {
            if (!spec.registry) throw new ValidationError(`${spec.name} 不在 ACP Registry 里`);
            return json(startRegistryInstall(id, spec.registry), 202);
          }
          const inst = spec.installers?.find((i) => i.id === installerId);
          if (!inst) throw new ValidationError(`${spec.name} 没有安装方式 ${installerId}`);
          const env = await loginShellEnv();
          const status = (await installerStatuses(spec, env)).find((i) => i.id === installerId);
          if (!status?.available) throw new ValidationError(status?.reason ?? "这台机器上不能用这种方式安装");
          return json(installer.start(id, inst, env), 202);
        }
      }
      if (id && sub === "authenticate" && parts.length === 3 && method === "POST") {
        const { methodId } = z.object({ methodId: z.string().min(1) }).parse(await body());
        if (!harnessSpec(id)) throw new ValidationError(`未知 Harness：${id}`, 404);
        srv.timeout(req, 0);
        return json(await probeHarness(id, methodId));
      }
    }

    if (resource === "permissions" && id && method === "POST") {
      const { optionId } = z.object({ optionId: z.string().nullable() }).parse(await body());
      return host.answer(id, optionId) ? json({ ok: true }) : json({ error: "授权请求已失效" }, 404);
    }

    // Closing the card submits cancel, so a departed user can never leave the agent waiting.
    if (resource === "elicitations" && id && method === "POST") {
      const input = z
        .object({
          action: z.enum(["accept", "decline", "cancel"]),
          content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
        })
        .parse(await body());
      const result = host.answerElicitation(id, input.action, input.content ?? {});
      if (!result) return json({ error: "提问已失效" }, 404);
      if (!result.ok) return json({ error: result.error, issues: result.issues }, 400);
      return json(result);
    }

    // 「Skills 与插件」 library: read-only discovery + managed imports (update / delete).
    if (resource === "library") {
      const projects = store.listProjects().filter((p) => p.id !== "drafts" && p.cwd);
      if (!id && method === "GET") return json(library.listLibrary(dataDir, projects));
      if (!id && method === "POST") {
        const b = z.object({ url: z.string().min(1).max(2048) }).parse(await body());
        try {
          return json(await library.importPackage(dataDir, b.url), 201);
        } catch (e) {
          throw new ValidationError((e as Error).message);
        }
      }
      if (id && sub === "update" && method === "POST") {
        try {
          return json(await library.updatePackage(dataDir, id));
        } catch (e) {
          throw new ValidationError((e as Error).message);
        }
      }
      if (id && !sub && method === "DELETE") {
        try {
          library.deletePackage(dataDir, id);
        } catch (e) {
          throw new ValidationError((e as Error).message, 404);
        }
        return json({ ok: true });
      }
    }

    // Skills on this machine for an agent that is not saved yet (new-agent form).
    if (resource === "skills" && !id && method === "GET") {
      const pid = url.searchParams.get("projectId");
      const project = pid ? store.getProject(pid) : null;
      const harness = url.searchParams.get("harness") ?? "";
      return json({
        items: skills.discoverSkills(dataDir, null, harness, project?.cwd ?? null),
        plugins: library.pluginsForAgent(dataDir, null, harness, store.listProjects()),
      });
    }
    if (resource === "agents") {
      if (!id && method === "GET") return json(store.listAgents());
      if (!id && method === "POST") return json(store.createAgent(validateAgent(await body())), 201);
      if (id && method === "PUT") return json(store.updateAgent(id, validateAgent(await body())));
      if (id && method === "DELETE") {
        if (!store.getAgent(id)) return json({ error: "Agent 不存在" }, 404);
        for (const room of store.listRooms()) {
          orchestrator.cancelAgent(room.id, id);
          host.releaseRoom(room.id, id);
        }
        store.deleteAgent(id);
        return json({ ok: true });
      }
      if (id && sub === "skills" && method === "GET") {
        const agent = store.getAgent(id);
        if (!agent) throw new ValidationError("Agent 不存在", 404);
        const pid = url.searchParams.get("projectId");
        const project = pid ? store.getProject(pid) : null;
        return json({
          items: skills.discoverSkills(dataDir, id, agent.harness, project?.cwd ?? null, agent.env),
          plugins: library.pluginsForAgent(dataDir, id, agent.harness, store.listProjects()),
        });
      }
      if (id && sub === "skills" && method === "POST") {
        const agent = store.getAgent(id);
        if (!agent) throw new ValidationError("Agent 不存在", 404);
        const b = z
          .object({
            action: z.enum([
              "import",
              "enable",
              "disable",
              "preview-url",
              "import-url",
              "enable-plugin",
              "disable-plugin",
            ]),
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
        if (b.action === "enable-plugin" || b.action === "disable-plugin") {
          try {
            library.setPluginLinked(dataDir, id, b.key, b.action === "enable-plugin");
          } catch (e) {
            throw new ValidationError((e as Error).message);
          }
          return json({ ok: true });
        }
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
      if (project && sub === "terminal") {
        if (method === "GET")
          return json(
            url.searchParams.get("all") === "1"
              ? projectTerminals.list(project.id)
              : projectTerminals.forProject(project.id),
          );
        if (method === "POST") {
          const text = await req.text();
          const size = z
            .object({ cols: z.number().optional(), rows: z.number().optional(), create: z.boolean().optional() })
            .parse(text ? JSON.parse(text) : {});
          const env = await loginShellEnv();
          // Login environment loading is async; a project may have been deleted or moved meanwhile.
          if (changingProjects.has(project.id)) throw new ValidationError("项目正在更新或删除，请稍后重试", 409);
          const current = store.getProject(project.id);
          if (!current) throw new ValidationError("项目不存在", 404);
          return json(
            size.create
              ? projectTerminals.create(current, env, size.cols, size.rows)
              : projectTerminals.open(current, env, size.cols, size.rows),
          );
        }
        if (method === "DELETE") {
          const terminalId = url.searchParams.get("terminalId");
          if (!terminalId) throw new ValidationError("缺少 terminalId");
          await projectTerminals.remove(project.id, terminalId);
          return json({ ok: true });
        }
      }
      if (project && !sub && method === "PATCH") {
        const p = ProjectInputSchema.partial().parse(await body());
        const cwd = p.cwd === undefined ? undefined : existingFolder(p.cwd);
        if (changingProjects.has(project.id)) throw new ValidationError("项目正在更新或删除，请稍后重试", 409);
        const current = store.getProject(project.id);
        if (!current) throw new ValidationError("项目不存在", 404);
        changingProjects.add(project.id);
        try {
          if (cwd !== undefined && cwd !== current.cwd) {
            await projectTerminals.remove(project.id);
            for (const r of store.listRooms())
              if (r.projectId === project.id) {
                orchestrator.cancelAll(r.id);
                host.releaseRoom(r.id);
              }
          }
          return json(store.updateProject(project.id, { name: p.name, cwd }));
        } finally {
          changingProjects.delete(project.id);
        }
      }
      if (project && !sub && method === "DELETE") {
        if (project.id === DRAFTS_PROJECT_ID) throw new ValidationError("「草稿」不能删除");
        if (changingProjects.has(project.id)) throw new ValidationError("项目正在更新或删除，请稍后重试", 409);
        changingProjects.add(project.id);
        try {
          await projectTerminals.remove(project.id);
          for (const r of store.listRooms())
            if (r.projectId === project.id) {
              orchestrator.cancelAll(r.id);
              host.releaseRoom(r.id);
            }
          store.deleteProject(project.id);
          return json({ ok: true });
        } finally {
          changingProjects.delete(project.id);
        }
      }
    }

    if (resource === "rooms") {
      if (!id && method === "GET")
        return json(store.listRooms().map((r) => ({ ...r, busy: !!orchestrator.state(r.id).activeRunId })));
      if (!id && method === "POST") {
        const r = RoomInputSchema.parse(await body());
        const projectId = r.projectId || ensureDrafts(store).id;
        if (!store.getProject(projectId)) throw new ValidationError("项目不存在", 404);
        return json(store.createRoom(r.name, r.agentIds, { mainAgentId: r.mainAgentId, projectId }), 201);
      }
      const room = id ? store.getRoom(id) : null;
      if (id && !room) return json({ error: "房间不存在" }, 404);
      if (room && !sub && method === "DELETE") {
        orchestrator.cancelAll(room.id);
        host.releaseRoom(room.id);
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
        if (g.projectId && g.projectId !== room.projectId) {
          orchestrator.cancelAll(room.id);
          host.releaseRoom(room.id);
        }
        return json(store.updateRoom(room.id, g));
      }
      if (room && sub === "agents" && !subId && method === "PUT") {
        const { agentIds } = z.object({ agentIds: z.array(z.string()) }).parse(await body());
        if (agentIds.length === 0) throw new ValidationError("至少保留 1 个 Agent");
        const updated = store.setRoomAgents(room.id, agentIds);
        for (const agentId of room.agentIds)
          if (!agentIds.includes(agentId)) {
            orchestrator.cancelAgent(room.id, agentId);
            host.releaseRoom(room.id, agentId);
          }
        return json(updated);
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
      if (room && sub === "messages" && !subId && method === "GET") {
        const limit = Math.min(
          z.coerce
            .number()
            .int()
            .positive()
            .safe()
            .parse(url.searchParams.get("limit") ?? 100),
          500,
        );
        const beforeSeq = z
          .string()
          .regex(/^[1-9]\d*$/)
          .transform(Number)
          .pipe(z.number().int().positive().safe())
          .optional()
          .parse(url.searchParams.get("beforeSeq") ?? undefined);
        const page = store.recentMessages(room.id, limit + 1, beforeSeq);
        const messages = page.slice(-limit);
        return json({
          messages,
          nextBeforeSeq: page.length > limit ? (messages[0]?.seq ?? null) : null,
          state: orchestrator.state(room.id),
          sessions: Object.fromEntries(
            room.agentIds.map((a) => [a, host.view(room.id, a)]).filter((e) => e[1] !== null),
          ),
          asks: host.pendingAsks(room.id),
          elicitations: host.pendingElicitations(room.id),
          conclusion: store.latestConclusion(room.id),
        });
      }
      if (room && sub === "messages" && !subId && method === "POST") {
        const m = z
          .object({
            senderName: z.string().max(32).default("我"),
            content: z.string().max(100000),
            images: z.array(ImageSchema).max(MAX_ATTACHMENT_COUNT).default([]),
            files: z.array(FileSchema).max(MAX_ATTACHMENT_COUNT).default([]),
            replyToId: z.string().min(1).max(200).nullable().optional(),
            replyToPartIndex: z.number().int().nonnegative().safe().optional(),
          })
          .parse(await body());
        return json(
          orchestrator.postHumanMessage(
            room.id,
            m.senderName,
            m.content,
            m.images,
            m.replyToId,
            m.replyToPartIndex,
            m.files,
          ),
          201,
        );
      }
      // Retry is a new request that quotes the original human message; it never resumes the old turn.
      if (room && sub === "messages" && subId && action === "retry" && method === "POST") {
        const interrupted = store.getMessage(subId);
        if (!interrupted || interrupted.roomId !== room.id || interrupted.senderKind !== "agent")
          throw new ValidationError("消息不存在", 404);
        if (interrupted.status !== "interrupted") throw new ValidationError("只有被中断的请求可以重试");
        const original = store.getMessage(interrupted.runId);
        if (!original || original.roomId !== room.id || original.senderKind !== "human")
          throw new ValidationError("找不到原请求", 409);
        const images = (original.timeline?.parts ?? []).flatMap((part) =>
          part.kind === "image" ? [{ mimeType: part.mimeType, data: part.data }] : [],
        );
        const files = (original.timeline?.parts ?? []).flatMap((part) =>
          part.kind === "file" ? [{ name: part.name, mimeType: part.mimeType, data: part.data }] : [],
        );
        return json(
          orchestrator.postHumanMessage(
            room.id,
            original.senderName,
            original.content,
            images,
            original.id,
            undefined,
            files,
          ),
          201,
        );
      }
      if (room && sub === "cancel" && method === "POST") {
        const text = await req.text();
        let input: unknown = {};
        try {
          if (text) input = JSON.parse(text);
        } catch {
          throw new ValidationError("无效的取消请求");
        }
        const { taskId } = z.object({ taskId: z.string().min(1).max(200).optional() }).parse(input);
        if (!taskId && room.kind === "group") throw new ValidationError("请选择要停止的任务");
        return json({ cancelled: orchestrator.cancel(room.id, taskId) });
      }
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
    registry,
    projectTerminals,
    attach(s: Server<WsData>) {
      server = s;
      mcp.baseUrl = `http://127.0.0.1:${s.port}`;
    },
    async fetch(req: Request, srv: Server<WsData>): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (!localRequest(req, url)) return new Response("Only local clients are allowed", { status: 403 });
      if (url.pathname.startsWith("/ws/terminal/")) {
        const id = url.pathname.slice("/ws/terminal/".length);
        if (!projectTerminals.get(id)) return json({ error: "终端不存在" }, 404);
        if (srv.upgrade(req, { data: { kind: "project-terminal", id } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { kind: "ui", rooms: new Set<string>() } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname.startsWith("/mcp/")) return mcp.handle(url.pathname.slice(5), req);
      if (url.pathname.startsWith("/api/")) {
        try {
          return await handleApi(req, url, srv);
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
      maxPayloadLength: PROJECT_TERMINAL_LIMITS.message,
      open(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "ui") ws.subscribe("all");
        else {
          try {
            ws.data.unsubscribe = projectTerminals.subscribe(ws.data.id, (event) => {
              if (ws.send(JSON.stringify(event)) < 0) ws.close(1013, "终端输出过快，请重新连接");
            });
          } catch (error) {
            ws.send(JSON.stringify({ type: "error", error: (error as Error).message }));
            ws.close(1008, "终端不存在");
          }
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "project-terminal") ws.data.unsubscribe?.();
      },
      message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        const data = ws.data;
        if (data.kind === "project-terminal") {
          try {
            projectTerminals.message(data.id, String(raw));
          } catch (error) {
            ws.send(JSON.stringify({ type: "error", error: (error as Error).message }));
          }
          return;
        }
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

export function serve(deps: AppDeps, port: number, hostname = "127.0.0.1") {
  const app = createApp(deps);
  const server = Bun.serve<WsData>({
    port,
    hostname,
    fetch: (req, srv) => app.fetch(req, srv),
    websocket: app.websocket,
  });
  app.attach(server);
  return { app, server };
}
