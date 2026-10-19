import { homedir } from "node:os";
import type * as acp from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import {
  type ElicitationField,
  type ElicitationIssues,
  type ElicitationValues,
  elicitationFields,
  validateElicitation,
} from "../shared/elicitation";
import { AcpProcess, type TerminalSnapshot, withTimeout } from "./acp";
import { customFileBlocks, nativeFileBlocks, restoredAttachmentPaths } from "./attachments";
import { harnessSecretEnv } from "./harness-secrets";
import { providerReasoningDefaults } from "./provider-reasoning";
import { prepareProviderRuntime } from "./provider-runtime";
import {
  claudeSettingsOverride,
  codexProviderSet,
  type ProviderSecret,
  providerAsCustom,
  providerConfigOptions,
  providerEnv,
  providerModelValues,
  providerSupports,
} from "./providers";

const CANCEL_GRACE_MS = Number(process.env.TUANTUAN_CANCEL_GRACE_MS) || 4000;
const RESUME_TIMEOUT_MS = 45_000;
const CONFIG_TIMEOUT_MS = 20_000;

import {
  CUSTOM_HARNESS,
  CUSTOM_HISTORY_MAX_CHARS,
  CUSTOM_HISTORY_MAX_IMAGE_BYTES,
  commitBoundedTurn,
  fitTurns,
  historyChars,
  historyForRequest,
  historyImageBytes,
  type Item,
  runTurn,
  turnImageBytes,
} from "./custom";
import { detectHarness, type HarnessSpec, harnessSpec, loginShellEnv } from "./harness";
import { harnessProcessEnv } from "./harness-env";
import { harnessRuntimeIdentity } from "./harness-runtime";
import { pluginOverlay } from "./library";
import { loadSkillBody, materializeSkills, selectedSkillIndex } from "./skills";
import type { Agent, Room, Store } from "./store";
import { ValidationError } from "./store";
import type { TuantuanMcp } from "./tuantuan-mcp";
import { expandHome } from "./workspace";

/** Live, per-(room, agent) view of the harness session the UI needs: pickers, slash commands, usage. */
export interface SessionView {
  sessionId: string | null;
  harness: string;
  configOptions: acp.SessionConfigOption[];
  modes: acp.SessionModeState | null;
  commands: acp.AvailableCommand[];
  /** Skills for the $ picker (agent + room). Prefix is always "$". */
  skills: { name: string; description: string }[];
  usage: { used: number; size: number; cost?: { amount: number; currency: string } | null } | null;
  title: string | null;
  /** BYOK only: model for this conversation (free text) and the agent's default. */
  customModel?: { value: string; default: string } | null;
  capabilities: {
    image: boolean;
    loadSession: boolean;
    list: boolean;
    resume: boolean;
  };
}

export interface PermissionAsk {
  id: string;
  roomId: string;
  agentId: string;
  toolCall: acp.ToolCallUpdate;
  options: acp.PermissionOption[];
}

/** A pending ACP form elicitation, normalized for the browser. */
export interface ElicitationAsk {
  id: string;
  roomId: string;
  agentId: string;
  message: string;
  fields: ElicitationField[];
}

export interface HostEvents {
  session(roomId: string, agentId: string, view: SessionView): void;
  permission(ask: PermissionAsk | { id: string; roomId: string; resolved: true }): void;
  elicitation?(ask: ElicitationAsk | { id: string; roomId: string; resolved: true }): void;
  terminal(roomId: string, t: TerminalSnapshot): void;
}

interface Proc {
  key: string;
  roomId: string;
  agentId: string;
  signature: string;
  runtimeCurrent: () => boolean;
  acp: AcpProcess;
  spec: HarnessSpec;
  provider: ProviderSecret | null;
  /** Undefined permits a recommendation; an empty object preserves native choices. */
  reasoningPreferences?: Record<string, string>;
  ready: Promise<acp.InitializeResponse>;
  /** sessionId -> where its updates go. */
  sessions: Map<string, SessionSlot>;
}

interface SessionSlot {
  roomId: string;
  agentId: string;
  view: SessionView;
  /** Set while a prompt turn runs; receives reply content updates. */
  turn: ((u: acp.SessionUpdate) => void) | null;
  turnSignal: AbortSignal | null;
  /** While loading/resuming, replayed history is dropped (Tuantuan keeps its own transcript). */
  replaying: boolean;
  /** Updates the harness replayed on session/load (history Tuantuan may not have); shown read-only. */
  replay: acp.SessionUpdate[];
  identityPending: boolean;
  managedSkills: SessionView["skills"];
  harnessSkills: SessionView["skills"];
  /** The effective MCP config (user list + plugins + Tuantuan's own entry) the session was attached with. */
  mcpSignature: string;
  /** Session-cumulative cost known before any turn: 0 for a fresh session, null when resumed. */
  costBase: number | null;
  /** Model named by the harness in `_meta` (Claude Code's `_claude/model` on usage_update). */
  usageModel: string | null;
}

/**
 * Owns harness processes (one per room + agent + working directory) and their ACP sessions.
 * Rooms map to sessions through the acp_sessions table so conversations survive restarts when the
 * harness can resume or load them.
 */
export class HarnessHost {
  private procs = new Map<string, Proc>();
  private slots = new Map<string, SessionSlot>(); // `${roomId}|${agentId}` -> slot
  private opening = new Map<
    string,
    { signature: string; generation: symbol; harness: string; pending: Promise<{ proc: Proc; slot: SessionSlot }> }
  >();
  private asks = new Map<
    string,
    { ask: PermissionAsk; slot: SessionSlot; resolve: (r: acp.RequestPermissionResponse) => void }
  >();
  private elicitations = new Map<
    string,
    { ask: ElicitationAsk; slot: SessionSlot; resolve: (r: acp.CreateElicitationResponse) => void }
  >();

  /** Slots whose next attach should session/load (to get the harness's history) rather than resume. */
  private wantLoad = new Set<string>();
  /** Includes session warm-up: concurrent callers must never replace another turn's callback. */
  private activeTurns = new Set<string>();

  constructor(
    private store: Store,
    private dataDir: string,
    private events: HostEvents,
    private mcp: TuantuanMcp | null = null,
  ) {}

  /** History the harness replayed when this room's session was loaded (empty if none). */
  replay(roomId: string, agentId: string): acp.SessionUpdate[] {
    return this.slots.get(`${roomId}|${agentId}`)?.replay ?? [];
  }

  /** Working directory for this conversation: the room's own folder (shared by every agent in it). */
  cwdFor(room: Room, _agent?: Agent): string {
    return room.cwd ? expandHome(room.cwd) : homedir();
  }

  view(roomId: string, agentId: string): SessionView | null {
    return this.slots.get(`${roomId}|${agentId}`)?.view ?? null;
  }

  pendingAsks(roomId: string): PermissionAsk[] {
    return [...this.asks.values()].filter((a) => a.ask.roomId === roomId).map((a) => a.ask);
  }

  answer(askId: string, optionId: string | null): boolean {
    const a = this.asks.get(askId);
    if (!a) return false;
    this.asks.delete(askId);
    a.resolve(
      optionId && a.ask.options.some((o) => o.optionId === optionId)
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
    this.events.permission({ id: askId, roomId: a.ask.roomId, resolved: true });
    return true;
  }

  pendingElicitations(roomId: string): ElicitationAsk[] {
    return [...this.elicitations.values()].filter((e) => e.ask.roomId === roomId).map((e) => e.ask);
  }

  /**
   * Resolve one form elicitation. Accept validates against the same schema the browser renders;
   * an invalid or unsupported answer leaves the request pending so the user can retry. Removing the
   * entry before resolving makes a duplicate submission fail instead of answering twice.
   */
  answerElicitation(
    id: string,
    action: "accept" | "decline" | "cancel",
    values: ElicitationValues = {},
  ):
    | { ok: true; action: "accept" | "decline" | "cancel" }
    | { ok: false; error: string; issues?: ElicitationIssues }
    | null {
    const pending = this.elicitations.get(id);
    if (!pending) return null;
    if (action === "accept") {
      const result = validateElicitation(pending.ask.fields, values);
      if (result.blocked || Object.keys(result.issues).length)
        return { ok: false, error: "请检查提问回答", issues: result.issues };
      this.elicitations.delete(id);
      pending.resolve({ action: "accept", content: result.content });
    } else {
      this.elicitations.delete(id);
      pending.resolve({ action });
    }
    this.events.elicitation?.({ id, roomId: pending.ask.roomId, resolved: true });
    return { ok: true, action };
  }

  /** Cancel every pending question owned by a slot/agent that is going away. */
  private cancelElicitations(match: (slot: SessionSlot, ask: ElicitationAsk) => boolean) {
    for (const [id, pending] of [...this.elicitations])
      if (match(pending.slot, pending.ask)) this.answerElicitation(id, "cancel");
  }

  /** A cancellation escalation can only terminate the process owned by this room and agent. */
  private async proc(
    roomId: string,
    agent: Agent,
    cwd: string,
    identity: string,
    assertCurrent: () => void,
  ): Promise<Proc> {
    const spec = harnessSpec(agent.harness);
    if (!spec) throw new ValidationError(`「${agent.name}」还没有绑定 Harness，请在 Agent 设置或新手引导里选择`);
    const overrides = this.store.getSetting<Record<string, string>>("harnessPaths", {});
    const status = await detectHarness(spec, overrides[spec.id] ?? null);
    if (!status.command) throw new ValidationError(`${spec.name} 未安装：${status.error}。在「Harness」页安装`);
    const base = await loginShellEnv();
    assertCurrent();
    const mat = materializeSkills(
      this.dataDir,
      agent.id,
      agent.harness,
      cwd,
      pluginOverlay(this.dataDir, agent.id, agent.harness).skills,
      { ...base, ...status.env, ...agent.env },
    );
    // Keep the user's CC Switch / Codex config: inherit ANTHROPIC_* / OPENAI_*, never isolate
    // CLAUDE_CONFIG_DIR or CODEX_HOME; only merge developer_instructions into CODEX_CONFIG.
    const env = harnessProcessEnv(base, mat.env, agent.env, spec, identity);
    // Registry entries may ask for env (e.g. a default model); the agent's own env still wins.
    for (const [k, v] of Object.entries(status.env)) if (!(k in agent.env)) env[k] = v;
    // API keys saved for this harness in 团团 (Harness 页); the agent's own env still wins.
    for (const [k, v] of Object.entries(harnessSecretEnv(this.store, spec.id))) if (!(k in agent.env)) env[k] = v;
    // 服务商: only this child process's env changes; ~/.claude / ~/.codex are never touched.
    const prov = agent.providerId ? this.store.getProvider(agent.providerId) : null;
    if (agent.providerId && !prov) throw new ValidationError("服务商不存在，请重新选择服务商");
    if (prov && !providerSupports(prov, agent.harness))
      throw new ValidationError(`「${prov.name}」不能用于 ${spec.name}，请检查服务商的接口地址、格式和主模型`);
    if (prov && providerSupports(prov, agent.harness)) {
      const pe = providerEnv(prov, agent.harness, env);
      for (const k of pe.unset) delete env[k];
      Object.assign(env, pe.set);
    }
    const key = `${roomId}|${agent.id}|${cwd}`;
    const runtimeIdentity = harnessRuntimeIdentity(status, env);
    const signature = JSON.stringify([
      runtimeIdentity,
      status.command,
      status.args,
      env.CODEX_CONFIG ?? "",
      agent.env,
      mat.env,
      prov ? [prov.id, prov.updatedAt] : null,
    ]);
    const existing = this.procs.get(key);
    if (existing && existing.signature === signature && existing.acp.proc.exitCode === null) {
      existing.acp.setSkillReadRoots(mat.skills.map((s) => s.dir));
      return existing;
    }
    if (existing) this.dropProc(existing);

    const runtime: Awaited<ReturnType<typeof prepareProviderRuntime>> = prov
      ? await prepareProviderRuntime(prov, agent.harness, env, status.version, {
          command: status.command,
          args: status.args,
          cwd,
        })
      : { env, cleanup: () => {} };
    try {
      assertCurrent();
      if (harnessRuntimeIdentity(status, env) !== runtimeIdentity)
        throw new ValidationError("会话配置已更改，请重试", 409);
    } catch (error) {
      runtime.cleanup();
      throw error;
    }
    const nativePreferences = nativeReasoningPreferences(agent.harness, env);

    const proc: Proc = {
      key,
      roomId,
      agentId: agent.id,
      signature,
      runtimeCurrent: () => harnessRuntimeIdentity(status, env) === runtimeIdentity,
      spec,
      provider: prov,
      reasoningPreferences:
        runtime.reasoningPreferences !== undefined || Object.keys(nativePreferences).length
          ? { ...runtime.reasoningPreferences, ...nativePreferences }
          : undefined,
      sessions: new Map(),
      acp: null as unknown as AcpProcess,
      ready: null as never,
    };
    try {
      proc.acp = new AcpProcess(
        {
          command: status.command,
          args: status.args,
          env: runtime.env,
          cwd,
          skillReadRoots: mat.skills.map((s) => s.dir),
        },
        {
          onUpdate: (n) => this.onUpdate(proc, n),
          requestPermission: (p) => this.requestPermission(proc, agent.id, p),
          requestElicitation: (p) => this.requestElicitation(proc, agent.id, p),
          onTerminal: (t) => {
            const slot = proc.sessions.get(t.sessionId);
            if (slot) this.events.terminal(slot.roomId, t);
          },
        },
      );
    } catch (error) {
      runtime.cleanup();
      throw error;
    }
    const useProv = prov && providerSupports(prov, agent.harness) ? prov : null;
    proc.ready = proc.acp.initialize().then(async (init) => {
      if (!proc.runtimeCurrent()) throw new ValidationError("会话配置已更改，请重试", 409);
      if (useProv && agent.harness === "codex")
        await proc.acp.agent.request(
          methods.agent.providers.set,
          codexProviderSet(useProv) as unknown as acp.SetProviderRequest,
        );
      return init;
    });
    proc.ready.catch(() => this.dropProc(proc));
    void proc.acp.exited.then(() => {
      runtime.cleanup();
      if (this.procs.get(key) === proc) this.dropProc(proc);
    });
    this.procs.set(key, proc);
    return proc;
  }

  private dropProc(p: Proc, signal?: NodeJS.Signals) {
    if (this.procs.get(p.key) === p) this.procs.delete(p.key);
    const slots = new Set(p.sessions.values());
    for (const [id, a] of this.asks) if (slots.has(a.slot)) this.answer(id, null);
    this.cancelElicitations((slot) => slots.has(slot));
    for (const slot of p.sessions.values()) {
      const key = `${slot.roomId}|${slot.agentId}`;
      if (this.slots.get(key) === slot) this.slots.delete(key);
    }
    p.sessions.clear();
    p.acp.kill(signal);
  }

  private onUpdate(p: Proc, n: acp.SessionNotification) {
    const slot = p.sessions.get(n.sessionId);
    if (!slot) return;
    const u = n.update;
    const v = slot.view;
    let changed = true;
    switch (u.sessionUpdate) {
      case "available_commands_update": {
        const split = splitCommands(u.availableCommands);
        v.commands = split.commands;
        slot.harnessSkills = split.skills;
        v.skills = pickerSkills(slot.managedSkills, slot.harnessSkills);
        break;
      }
      case "config_option_update":
        v.configOptions = providerConfigOptions(p.provider, p.spec.id, u.configOptions, p.acp.launch.env);
        break;
      case "current_mode_update":
        if (v.modes) v.modes = { ...v.modes, currentModeId: u.currentModeId };
        break;
      case "usage_update":
        v.usage = { used: u.used, size: u.size, cost: u.cost ?? null };
        {
          const m = (u._meta as Record<string, unknown> | null | undefined)?.["_claude/model"];
          if (typeof m === "string" && m) slot.usageModel = m;
        }
        break;
      case "session_info_update":
        if (u.title !== undefined) v.title = u.title ?? null;
        break;
      default:
        changed = false;
    }
    if (changed) {
      if (this.slots.get(`${slot.roomId}|${slot.agentId}`) === slot)
        this.events.session(slot.roomId, slot.agentId, { ...v });
    } else if (slot.replaying) slot.replay.push(u);
    else slot.turn?.(u);
  }

  private requestPermission(p: Proc, agentId: string, req: acp.RequestPermissionRequest) {
    const slot = p.sessions.get(req.sessionId);
    if (!slot || slot.turnSignal?.aborted)
      return Promise.resolve<acp.RequestPermissionResponse>({ outcome: { outcome: "cancelled" } });
    const agent = this.store.getAgent(agentId);
    if (agent?.permissionPolicy === "allow") {
      const allow =
        req.options.find((o) => o.kind === "allow_once") ?? req.options.find((o) => o.kind.startsWith("allow"));
      if (allow)
        return Promise.resolve<acp.RequestPermissionResponse>({
          outcome: { outcome: "selected", optionId: allow.optionId },
        });
    }
    const ask: PermissionAsk = {
      id: crypto.randomUUID(),
      roomId: slot.roomId,
      agentId,
      toolCall: req.toolCall,
      options: req.options,
    };
    return new Promise<acp.RequestPermissionResponse>((res) => {
      this.asks.set(ask.id, { ask, slot, resolve: res });
      this.events.permission(ask);
    });
  }

  /**
   * ACP form elicitation. Tuantuan advertises form mode only, and a question outside a live turn
   * has no room to render in, so both answer cancel instead of leaving the agent waiting.
   */
  private requestElicitation(
    p: Proc,
    agentId: string,
    req: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    if (req.mode !== "form") return Promise.resolve<acp.CreateElicitationResponse>({ action: "cancel" });
    const form = req as acp.ElicitationFormMode & { message: string };
    if (!("sessionId" in form)) return Promise.resolve<acp.CreateElicitationResponse>({ action: "cancel" });
    const slot = p.sessions.get(form.sessionId);
    if (!slot?.turnSignal || slot.turnSignal.aborted)
      return Promise.resolve<acp.CreateElicitationResponse>({ action: "cancel" });
    const ask: ElicitationAsk = {
      id: crypto.randomUUID(),
      roomId: slot.roomId,
      agentId,
      message: form.message,
      fields: elicitationFields(form.requestedSchema),
    };
    return new Promise<acp.CreateElicitationResponse>((res) => {
      this.elicitations.set(ask.id, { ask, slot, resolve: res });
      this.events.elicitation?.(ask);
    });
  }

  /**
   * Returns the session for this room and agent, creating, resuming or loading it as the harness allows.
   * `identity` is the Tuantuan identity + group context, delivered per the harness (plan §3.4).
   */
  async session(
    room: Room,
    agent: Agent,
    identity: string,
    options: { startingTurn?: boolean } = {},
  ): Promise<{ proc: Proc; slot: SessionSlot }> {
    const key = `${room.id}|${agent.id}`;
    const opening = this.opening.get(key);
    // Inspectors may observe membership/config changes during a turn, but must not reattach its
    // session or replace its process. The next prompt refreshes the idle attachment itself.
    if (!options.startingTurn && this.activeTurns.has(key)) {
      if (opening) return opening.pending;
      const slot = this.slots.get(key);
      const sessionId = slot?.view.sessionId;
      const proc = sessionId ? [...this.procs.values()].find((p) => p.sessions.get(sessionId) === slot) : undefined;
      if (slot && proc?.acp.proc.exitCode === null) return { proc, slot };
    }
    const hasMcp = () =>
      !!(this.mcp?.baseUrl && this.mcp.provider?.tools({ roomId: room.id, agentId: agent.id }).length);
    // The user's MCP server rows and linked plugin files are part of the session's effective
    // config even though neither shows up in the Agent row: a mid-initialization change must
    // invalidate the opening instead of publishing a stale attachment.
    const signature = JSON.stringify([this.cwdFor(room), agent, identity, hasMcp(), this.mcpFingerprint(agent)]);
    if (opening?.signature === signature) return opening.pending;
    // A cancelled caller can stop waiting while the shared warm-up finishes. A subsequent turn
    // must join that same initialization instead of racing it for the room's session mapping.
    const generation = Symbol();
    const assertCurrent = () => {
      const currentRoom = this.store.getRoom(room.id);
      const currentAgent = this.store.getAgent(agent.id);
      if (
        this.opening.get(key)?.generation !== generation ||
        !currentRoom ||
        !currentAgent ||
        JSON.stringify([
          this.cwdFor(currentRoom),
          currentAgent,
          identity,
          hasMcp(),
          this.mcpFingerprint(currentAgent),
        ]) !== signature
      )
        throw new ValidationError("会话配置已更改，请重试", 409);
    };
    const pending = this.openSession(room, agent, identity, assertCurrent);
    this.opening.set(key, { signature, generation, harness: agent.harness, pending });
    try {
      return await pending;
    } catch (error) {
      assertCurrent();
      throw error;
    } finally {
      if (this.opening.get(key)?.generation === generation) this.opening.delete(key);
    }
  }

  private async openSession(
    room: Room,
    agent: Agent,
    identity: string,
    assertCurrent: () => void,
  ): Promise<{ proc: Proc; slot: SessionSlot }> {
    const cwd = this.cwdFor(room, agent);
    const proc = await this.proc(room.id, agent, cwd, identity, assertCurrent);
    const assertConfiguration = assertCurrent;
    assertCurrent = () => {
      assertConfiguration();
      if (!proc.runtimeCurrent()) throw new ValidationError("会话配置已更改，请重试", 409);
    };
    const init = await proc.ready;
    assertCurrent();
    const slotKey = `${room.id}|${agent.id}`;
    const caps = init.agentCapabilities ?? {};
    const own = this.mcp?.serverEntry({ roomId: room.id, agentId: agent.id }, caps.mcpCapabilities);
    const previous = this.slots.get(slotKey);
    const cached =
      previous?.view.sessionId && proc.sessions.get(previous.view.sessionId) === previous ? previous : undefined;
    const plugins = pluginOverlay(this.dataDir, agent.id, agent.harness);
    const mat = materializeSkills(this.dataDir, agent.id, agent.harness, cwd, plugins.skills, proc.acp.launch.env);
    const managedSkills = [...mat.skills, ...mat.roomSkills].map((x) => ({ name: x.name, description: x.description }));
    // The whole effective MCP config the session must be attached to: the user's list, plugin
    // servers and Tuantuan's own entry. Any change re-attaches through resume/load (or session/new);
    // an equal signature means the live session already has exactly these servers, so it is reused.
    const mcpServers = [...this.mcpServers(agent), ...plugins.mcp];
    if (own) mcpServers.push(own);
    const mcpSignature = JSON.stringify(mcpServers);
    // An active turn must not be re-attached underneath; its refresh lands on the next turn.
    if (cached && (cached.turn || cached.mcpSignature === mcpSignature)) {
      const before = JSON.stringify(cached.view.skills);
      cached.managedSkills = managedSkills;
      cached.view.skills = pickerSkills(managedSkills, cached.harnessSkills);
      if (JSON.stringify(cached.view.skills) !== before) this.events.session(room.id, agent.id, { ...cached.view });
      return { proc, slot: cached };
    }
    proc.acp.grantAttachmentReads(
      restoredAttachmentPaths(this.store.humanAttachmentMessages(room.id), this.dataDir, room.id),
    );
    const view: SessionView = {
      sessionId: null,
      harness: proc.spec.id,
      configOptions: [],
      modes: null,
      commands: [],
      skills: pickerSkills(managedSkills, []),
      usage: null,
      title: null,
      capabilities: {
        // Grok Build's ACP server accepts ContentBlock::Image in session/prompt,
        // but xai-grok-shell's initialize omits PromptCapabilities::image(true).
        image: !!caps.promptCapabilities?.image || proc.spec.id === "grok" || proc.spec.registry === "grok-build",
        loadSession: !!caps.loadSession,
        list: !!caps.sessionCapabilities?.list,
        resume: !!caps.sessionCapabilities?.resume,
      },
    };
    const slot: SessionSlot = {
      roomId: room.id,
      agentId: agent.id,
      view,
      turn: null,
      turnSignal: null,
      replaying: false,
      replay: [],
      identityPending: false,
      managedSkills,
      harnessSkills: [],
      mcpSignature,
      costBase: null,
      usageModel: null,
    };
    const checkCurrent = () => {
      try {
        assertCurrent();
      } catch (error) {
        const id = slot.view.sessionId;
        if (id && proc.sessions.get(id) === slot) proc.sessions.delete(id);
        throw error;
      }
    };
    const preferLoad = this.wantLoad.delete(slotKey);
    const meta = withClaudePlugins(
      withProviderMeta(identityMeta(proc.spec, identity), agent, this.store, {
        provider: proc.provider,
        env: proc.acp.launch.env,
      }),
      plugins.claudePlugins,
    );
    const saved = this.store.getAcpSession(room.id, agent.id);
    let res: { configOptions?: acp.SessionConfigOption[] | null; modes?: acp.SessionModeState | null } | null = null;
    if (saved && saved.harness === proc.spec.id && (view.capabilities.resume || view.capabilities.loadSession)) {
      proc.sessions.set(saved.sessionId, slot);
      view.sessionId = saved.sessionId;
      slot.replaying = true;
      try {
        res =
          view.capabilities.resume && !(preferLoad && view.capabilities.loadSession)
            ? await withTimeout(
                proc.acp.agent.request(methods.agent.session.resume, {
                  sessionId: saved.sessionId,
                  cwd,
                  mcpServers,
                  _meta: meta,
                }),
                RESUME_TIMEOUT_MS,
                "session/resume 超时",
              )
            : await withTimeout(
                proc.acp.agent.request(methods.agent.session.load, {
                  sessionId: saved.sessionId,
                  cwd,
                  mcpServers,
                  _meta: meta,
                }),
                RESUME_TIMEOUT_MS,
                "session/load 超时",
              );
      } catch {
        if (proc.sessions.get(saved.sessionId) === slot) proc.sessions.delete(saved.sessionId);
        view.sessionId = null;
        res = null;
      } finally {
        slot.replaying = false;
      }
    }
    checkCurrent();
    if (cached && view.sessionId === cached.view.sessionId) {
      slot.harnessSkills = cached.harnessSkills;
      view.skills = pickerSkills(managedSkills, slot.harnessSkills);
      slot.identityPending = cached.identityPending;
      slot.costBase = cached.costBase;
      if (slot.replay.length === 0) slot.replay = [...cached.replay];
      if (view.commands.length === 0) view.commands = cached.view.commands;
      view.usage ??= cached.view.usage;
      view.title ??= cached.view.title;
    }
    let fresh = false;
    if (!view.sessionId) {
      let created: acp.NewSessionResponse;
      try {
        created = await withTimeout(
          proc.acp.agent.request(methods.agent.session.new, { cwd, mcpServers, _meta: meta }),
          120_000,
          "session/new 超时",
        );
      } catch (e) {
        throw harnessError(proc, e);
      }
      checkCurrent();
      view.sessionId = created.sessionId;
      proc.sessions.set(created.sessionId, slot);
      slot.identityPending = proc.spec.identity === "first-prompt" && identity.trim() !== "";
      res = created;
      fresh = true;
      slot.costBase = 0;
    }
    view.configOptions = providerConfigOptions(
      proc.provider,
      agent.harness,
      res?.configOptions ?? [],
      proc.acp.launch.env,
    );
    view.modes = res?.modes ?? null;
    const profileModels = providerModelValues(proc.provider, agent.harness);
    if (profileModels) {
      // A resumed OpenCode session can retain the old provider/model. Apply the current
      // profile before prompting, while preserving explicit choices within this profile.
      const opt = view.configOptions.find((o) => o.type === "select" && (o.category === "model" || o.id === "model"));
      if (opt?.type !== "select") throw new ValidationError(`${proc.spec.name} 未返回模型设置，请更新 Harness`);
      const preferences = { ...agent.configDefaults, ...this.store.getRoomConfig(room.id, agent.id) };
      const wanted = preferences[opt.id];
      const value = wanted && profileModels.includes(wanted) ? wanted : (profileModels[0] as string);
      if (opt.currentValue !== value) {
        const set = await withTimeout(
          proc.acp.agent.request(methods.agent.session.setConfigOption, {
            sessionId: view.sessionId as string,
            configId: opt.id,
            value,
          }),
          CONFIG_TIMEOUT_MS,
          "设置服务商模型超时",
        );
        view.configOptions = providerConfigOptions(
          proc.provider,
          agent.harness,
          set.configOptions,
          proc.acp.launch.env,
        );
        const selected = view.configOptions.find((o) => o.id === opt.id);
        if (selected?.type !== "select" || selected.currentValue !== value)
          throw new ValidationError(`${proc.spec.name} 未采用服务商模型 ${value}`);
      }
    }
    // Fresh-session defaults: conversation > Agent > explicit native settings > recommendation.
    if (fresh) {
      const preferences = { ...agent.configDefaults, ...this.store.getRoomConfig(room.id, agent.id) };
      // A model change may replace reasoning choices. Derive defaults from its real response,
      // including when a rejected model preference leaves the original model active.
      const model = view.configOptions.find((option) => option.category === "model" || option.id === "model");
      const preferredModel =
        model &&
        (preferences[model.id] ?? (agent.harness === "claude-code" && proc.provider ? proc.provider.model : undefined));
      if (model && preferredModel !== undefined) {
        await this.applyConfigPreferences(proc, slot, { [model.id]: preferredModel }, checkCurrent);
        delete preferences[model.id];
      }
      await this.applyConfigPreferences(
        proc,
        slot,
        {
          ...(proc.reasoningPreferences ?? providerReasoningDefaults(proc.provider, agent.harness, view.configOptions)),
          ...preferences,
        },
        checkCurrent,
      );
    } else {
      // Some adapters reconstruct native defaults on restore. Replay only explicit room/Agent
      // reasoning intent; an unsupported choice remains saved for a later compatible model.
      await this.applyConfigPreferences(proc, slot, this.reasoningPreferences(room, agent, view), checkCurrent);
    }
    checkCurrent();
    if (fresh) this.store.setAcpSession(room.id, agent.id, proc.spec.id, view.sessionId as string);
    this.slots.set(slotKey, slot);
    this.events.session(room.id, agent.id, { ...view });
    return { proc, slot };
  }

  private reasoningPreferences(room: Room, agent: Agent, view: SessionView): Record<string, string> {
    const preferences = { ...agent.configDefaults, ...this.store.getRoomConfig(room.id, agent.id) };
    return Object.fromEntries(
      view.configOptions
        .filter((option) => option.category === "thought_level" || /thinking|reasoning|effort/.test(option.id))
        .filter((option) => preferences[option.id] !== undefined)
        .map((option) => [option.id, preferences[option.id] as string]),
    );
  }

  private async applyConfigPreferences(
    proc: Proc,
    slot: SessionSlot,
    preferences: Record<string, string>,
    checkCurrent: () => void = () => {},
  ): Promise<void> {
    for (const [configId, value] of Object.entries(preferences)) {
      checkCurrent();
      const option = slot.view.configOptions.find((item) => item.id === configId);
      if (!option) continue;
      let params: acp.SetSessionConfigOptionRequest;
      if (option.type === "select") {
        if (option.currentValue === value || !selectValues(option).includes(value)) continue;
        params = { sessionId: slot.view.sessionId as string, configId, value };
      } else if (option.type === "boolean") {
        const selected = value === "true";
        if (option.currentValue === selected) continue;
        params = { sessionId: slot.view.sessionId as string, configId, type: "boolean", value: selected };
      } else continue;
      try {
        const set = await withTimeout(
          proc.acp.agent.request(methods.agent.session.setConfigOption, params),
          CONFIG_TIMEOUT_MS,
          "设置超时",
        );
        slot.view.configOptions = providerConfigOptions(
          proc.provider,
          proc.spec.id,
          set.configOptions,
          proc.acp.launch.env,
        );
      } catch {
        // Keep the actual Harness value and saved intent when a preferred value is rejected.
      }
    }
  }

  private mcpServers(agent: Agent): acp.McpServer[] {
    const all = this.store.listMcpServers();
    // User-configured servers are HTTP; harnesses must accept them (ACP makes only stdio mandatory).
    return agent.mcpServerIds
      .map((id) => all.find((s) => s.id === id))
      .filter((s) => s !== undefined)
      .map((s) => ({ type: "http" as const, name: s.name, url: s.url, headers: [] }));
  }

  /** Identity of the MCP config that lives outside the Agent row: bound user servers and plugin
   * servers. Used in the opening signature so mid-initialization changes cannot publish stale state. */
  private mcpFingerprint(agent: Agent): string {
    return JSON.stringify([...this.mcpServers(agent), ...pluginOverlay(this.dataDir, agent.id, agent.harness).mcp]);
  }

  /**
   * Runs one prompt turn. Reply content updates go to `onUpdate`; returns the stop reason.
   * Aborting the signal sends session/cancel and resolves any open permission prompt as cancelled.
   */
  /** Opens (or reuses) the session and returns just the UI view — works for ACP and BYOK. */
  async sessionView(room: Room, agent: Agent, identity: string): Promise<SessionView> {
    if (agent.harness === CUSTOM_HARNESS) return this.ensureCustom(room, agent).view;
    return (await this.session(room, agent, identity)).slot.view;
  }

  async prompt(
    room: Room,
    agent: Agent,
    identity: string,
    blocks: acp.ContentBlock[],
    onUpdate: (u: acp.SessionUpdate) => void,
    signal: AbortSignal,
  ): Promise<{ stopReason: acp.StopReason }> {
    signal.throwIfAborted();
    const key = `${room.id}|${agent.id}`;
    if (this.activeTurns.has(key))
      throw new ValidationError("这个 Agent 在当前会话中仍有任务正在运行，请稍后重试", 409);
    this.activeTurns.add(key);
    try {
      return agent.harness === CUSTOM_HARNESS
        ? await this.promptCustom(room, agent, identity, blocks, onUpdate, signal)
        : await this.promptAcp(room, agent, identity, blocks, onUpdate, signal);
    } finally {
      this.activeTurns.delete(key);
    }
  }

  private async promptAcp(
    room: Room,
    agent: Agent,
    identity: string,
    blocks: acp.ContentBlock[],
    onUpdate: (u: acp.SessionUpdate) => void,
    signal: AbortSignal,
  ): Promise<{ stopReason: acp.StopReason }> {
    const { proc, slot } = await waitForSession(this.session(room, agent, identity, { startingTurn: true }), signal);
    signal.throwIfAborted();
    if (!slot.view.capabilities.image && blocks.some((block) => block.type === "image"))
      throw new ValidationError("当前 Harness 不支持图片，请移除图片或切换 Harness");
    const attachments = nativeFileBlocks(
      blocks,
      this.dataDir,
      room.id,
      !!proc.acp.init?.agentCapabilities?.promptCapabilities?.embeddedContext,
    );
    blocks = attachments.blocks;
    proc.acp.grantAttachmentReads(attachments.readPaths);
    const sessionId = slot.view.sessionId as string;
    const selection = materializeSkills(
      this.dataDir,
      agent.id,
      agent.harness,
      this.cwdFor(room),
      pluginOverlay(this.dataDir, agent.id, agent.harness).skills,
      proc.acp.launch.env,
    );
    proc.acp.setSkillReadRoots(selection.skills.map((s) => s.dir));
    // Harness slash handlers inspect the original leading text. Context before /usage, /logout,
    // etc. would bypass that handler and accidentally turn a native command into a model prompt.
    const nativeCommand = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trimStart()
      .startsWith("/");
    // Declarations may arrive after session/new. Unknown slash commands also belong to the
    // harness: preserve them rather than changing their routing by injecting context first.
    if (!nativeCommand) {
      blocks = [{ type: "text", text: selectedSkillIndex(selection.skills) }, ...blocks];
      if (slot.identityPending) {
        blocks = [{ type: "text", text: `<tuantuan-identity>\n${identity}\n</tuantuan-identity>` }, ...blocks];
        slot.identityPending = false;
      }
    }
    slot.turn = (update) => {
      if (!signal.aborted) onUpdate(update);
    };
    slot.turnSignal = signal;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let abandon!: (reason: unknown) => void;
    const abandoned = new Promise<never>((_, reject) => {
      abandon = reject;
    });
    const onAbort = () => {
      void proc.acp.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
      for (const [id, a] of this.asks)
        if (a.ask.roomId === room.id && a.ask.agentId === agent.id) this.answer(id, null);
      this.cancelElicitations((_slot, ask) => ask.roomId === room.id && ask.agentId === agent.id);
      // An unresponsive harness must not keep executing or send old updates into the next turn.
      // The process belongs to this room and agent, so other conversations keep running.
      graceTimer = setTimeout(() => {
        this.dropProc(proc, "SIGKILL");
        abandon(signal.reason ?? new DOMException("用户取消", "AbortError"));
      }, CANCEL_GRACE_MS);
    };
    signal.addEventListener("abort", onAbort);
    const stderrBefore = proc.acp.stderr;
    const costBefore = slot.view.usage?.cost?.amount ?? slot.costBase;
    slot.usageModel = null;
    try {
      const res = await Promise.race([
        abandoned,
        proc.acp.agent.request(methods.agent.session.prompt, { sessionId, prompt: blocks }),
        proc.acp.exited.then((code) => {
          throw new Error(
            `${proc.spec.name} 进程退出（code ${code}）${proc.acp.stderr ? `：${proc.acp.stderr.slice(-300)}` : ""}`,
          );
        }),
      ]);
      // Token usage exactly as the harness reports it (never estimated): ACP `usage` (Claude Code,
      // Codex, OpenCode); Grok Build reports the same counters under `_meta.usage`.
      const u = res.usage ?? grokMetaUsage(res._meta);
      if (u) {
        const after = slot.view.usage?.cost;
        const cost = after && costBefore !== null && after.amount >= costBefore ? after.amount - costBefore : null;
        this.store.logUsage({
          roomId: room.id,
          agentId: agent.id,
          harness: agent.harness,
          providerId: agent.providerId,
          model: usageModel(res._meta) ?? slot.usageModel ?? modelOption(slot.view.configOptions)?.currentValue ?? null,
          input: u.inputTokens ?? 0,
          output: u.outputTokens ?? 0,
          cacheRead: u.cachedReadTokens ?? 0,
          cacheWrite: u.cachedWriteTokens ?? 0,
          thought: u.thoughtTokens ?? 0,
          total: u.totalTokens ?? 0,
          cost,
          currency: cost !== null ? (after?.currency ?? null) : null,
        });
      }
      return { stopReason: res.stopReason };
    } catch (e) {
      if (signal.aborted) throw signal.reason ?? e;
      throw harnessError(proc, e, stderrBefore);
    } finally {
      clearTimeout(graceTimer);
      signal.removeEventListener("abort", onAbort);
      // A harness that ends its turn without answering must not leave a modal in the room.
      this.cancelElicitations((owner) => owner === slot);
      slot.turn = null;
      slot.turnSignal = null;
    }
  }

  private ensureCustom(room: Room, agent: Agent): SessionSlot {
    const key = `${room.id}|${agent.id}`;
    let slot = this.slots.get(key);
    const mat = materializeSkills(
      this.dataDir,
      agent.id,
      CUSTOM_HARNESS,
      this.cwdFor(room),
      pluginOverlay(this.dataDir, agent.id, CUSTOM_HARNESS).skills,
    );
    const managedSkills = [...mat.skills, ...mat.roomSkills].map((x) => ({ name: x.name, description: x.description }));
    if (!slot) {
      slot = {
        roomId: room.id,
        agentId: agent.id,
        view: {
          sessionId: `custom-${agent.id}`,
          harness: CUSTOM_HARNESS,
          configOptions: [],
          modes: null,
          commands: [],
          skills: [...mat.skills, ...mat.roomSkills].map((x) => ({ name: x.name, description: x.description })),
          usage: null,
          title: null,
          customModel: {
            value: this.store.getRoomModel(room.id, agent.id) ?? agent.custom?.model ?? "",
            default: agent.custom?.model ?? "",
          },
          capabilities: { image: true, loadSession: false, list: false, resume: false },
        },
        turn: null,
        turnSignal: null,
        replaying: false,
        replay: [],
        identityPending: false,
        managedSkills,
        harnessSkills: [],
        mcpSignature: "",
        costBase: null,
        usageModel: null,
      };
      this.slots.set(key, slot);
      this.events.session(room.id, agent.id, { ...slot.view });
    }
    const before = JSON.stringify(slot.view.skills);
    slot.managedSkills = managedSkills;
    slot.view.skills = pickerSkills(managedSkills, []);
    if (JSON.stringify(slot.view.skills) !== before) this.events.session(room.id, agent.id, { ...slot.view });
    const model = this.store.getRoomModel(room.id, agent.id) ?? agent.custom?.model ?? "";
    slot.view.customModel = { value: model, default: agent.custom?.model ?? "" };
    return slot;
  }

  /**
   * The bounded BYOK context for this room and agent. A missing row is initialized once from
   * completed conversations only: each human task is paired with this agent's successful reply
   * from the same run, so failed or cancelled replies never come back as context. A group starts
   * empty (its turns carry the relay). An explicitly reset conversation persists as `[]`, which
   * restarts must not revive.
   */
  private customTurns(room: Room, agent: Agent): Item[][] {
    const stored = this.store.getCustomHistory(room.id, agent.id);
    if (stored) return stored;
    if (room.kind !== "dm") {
      this.store.setCustomHistory(room.id, agent.id, []);
      return [];
    }
    const runs = new Map<string, { user?: string; reply?: string }>();
    for (const m of this.store.recentMessages(room.id, 40)) {
      if (m.senderKind === "system" || !m.content.trim()) continue;
      const entry = runs.get(m.runId) ?? {};
      if (m.senderKind === "human" && m.status === "done") entry.user ??= m.content;
      if (m.senderKind === "agent" && m.senderId === agent.id && m.status === "done") entry.reply ??= m.content;
      runs.set(m.runId, entry);
    }
    const seed: Item[][] = [];
    for (const { user, reply } of runs.values())
      if (user !== undefined && reply !== undefined)
        seed.push([
          { kind: "user", text: user },
          { kind: "assistant", text: reply, calls: [] },
        ]);
    const bounded = fitTurns(seed);
    this.store.setCustomHistory(room.id, agent.id, bounded);
    return bounded;
  }

  private async promptCustom(
    room: Room,
    agent: Agent,
    identity: string,
    blocks: acp.ContentBlock[],
    onUpdate: (u: acp.SessionUpdate) => void,
    signal: AbortSignal,
  ): Promise<{ stopReason: acp.StopReason }> {
    const prov = agent.providerId ? this.store.getProvider(agent.providerId) : null;
    const saved =
      prov && providerSupports(prov, "custom") ? providerAsCustom(prov) : this.store.getCustomSecret(agent.id);
    if (!saved) throw new ValidationError("请先在 Agent 设置里填写自定义 API 或选择服务商");
    const cfg = { ...saved, model: this.store.getRoomModel(room.id, agent.id) || saved.model };
    if (!cfg.apiKey) throw new ValidationError("请填写 API Key");
    const provider = this.mcp?.provider;
    const context = { roomId: room.id, agentId: agent.id };
    const toolContext = provider?.captureContext(context) ?? context;
    // Slot identity guards the commit: a release below (project reset, member removal, room
    // deletion) deletes it, so a late completion cannot overwrite the cleared state.
    const slot = this.ensureCustom(room, agent);
    const turns = this.customTurns(room, agent);
    const userImages = blocks.flatMap((block) =>
      block.type === "image" ? [{ mimeType: block.mimeType, data: block.data }] : [],
    );
    const userText = customFileBlocks(blocks, room.id)
      .filter((b): b is acp.ContentBlock & { type: "text" } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (userText.length > CUSTOM_HISTORY_MAX_CHARS)
      throw new ValidationError(
        `当前输入 ${userText.length} 字符，超过自定义 API 的上下文预算 ${CUSTOM_HISTORY_MAX_CHARS} 字符；请缩短输入或开启新会话`,
      );
    // Old turns leave as whole units; runTurn re-measures every request and may drop more.
    const history = historyForRequest(
      turns,
      userText.length,
      turnImageBytes([{ kind: "user", text: userText, userImages }]),
    );
    const mat = materializeSkills(
      this.dataDir,
      agent.id,
      CUSTOM_HARNESS,
      this.cwdFor(room),
      pluginOverlay(this.dataDir, agent.id, CUSTOM_HARNESS).skills,
    );
    const skillTools = mat.skills.length
      ? [
          {
            name: "load_skill",
            description: "加载一个 Skill 的完整说明（按需调用）。",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string", description: "Skill 名称" } },
              required: ["name"],
            },
          },
        ]
      : [];
    const tools = [...(provider?.tools(toolContext) ?? []), ...skillTools];
    const skillIndex = mat.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    const system = identity + (skillIndex ? `\n\n可用 Skills（用 load_skill 加载正文）：\n${skillIndex}` : "");
    const { stopReason, newItems } = await runTurn({
      cfg,
      system,
      history,
      userText,
      userImages,
      tools,
      callTool: async (name, args) => {
        signal.throwIfAborted();
        if (name === "load_skill")
          return loadSkillBody(
            this.dataDir,
            agent.id,
            this.cwdFor(room),
            String(args.name ?? ""),
            pluginOverlay(this.dataDir, agent.id, CUSTOM_HARNESS).skills,
          );
        if (!provider) throw new Error("工具不可用");
        return provider.call(toolContext, name, args);
      },
      onUpdate,
      signal,
    });
    // A failed, cancelled or reset turn never reaches the commit, so the stored context keeps the
    // last successful one. A turn that alone exceeds the budget is reported instead of half-saving.
    signal.throwIfAborted();
    if (this.slots.get(`${room.id}|${agent.id}`) !== slot) throw new ValidationError("会话已重置，本轮回复未保存", 409);
    if (historyChars([newItems]) > CUSTOM_HISTORY_MAX_CHARS)
      throw new ValidationError(
        `本轮对话 ${historyChars([newItems])} 字符，超过自定义 API 的上下文预算 ${CUSTOM_HISTORY_MAX_CHARS} 字符；回复已保留，但没有写入会话上下文，下一轮将从更早的记录继续`,
      );
    if (historyImageBytes([newItems]) > CUSTOM_HISTORY_MAX_IMAGE_BYTES)
      throw new ValidationError("本轮图片超过自定义 API 的图片上下文预算 20 MiB，未写入会话上下文");
    this.store.setCustomHistory(room.id, agent.id, commitBoundedTurn(turns, newItems));
    return { stopReason };
  }

  async setConfig(room: Room, agent: Agent, identity: string, configId: string, value: string | boolean) {
    if (agent.harness === CUSTOM_HARNESS) {
      if (configId !== "model" || typeof value !== "string" || !value.trim())
        throw new ValidationError("自定义 API 只能改模型");
      const slot = this.ensureCustom(room, agent);
      this.store.setRoomModel(room.id, agent.id, value.trim());
      slot.view.customModel = { value: value.trim(), default: agent.custom?.model ?? "" };
      this.events.session(room.id, agent.id, { ...slot.view });
      return slot.view;
    }
    const { proc, slot } = await this.session(room, agent, identity);
    const profileModels = providerModelValues(proc.provider, agent.harness);
    const option = slot.view.configOptions.find((o) => o.id === configId);
    if (
      profileModels &&
      (option?.category === "model" || configId === "model") &&
      !profileModels.includes(String(value))
    )
      throw new ValidationError("请选择当前服务商的模型；其他模型可在服务商设置中填写");
    const params =
      typeof value === "boolean"
        ? { sessionId: slot.view.sessionId as string, configId, type: "boolean" as const, value }
        : { sessionId: slot.view.sessionId as string, configId, value };
    let res: acp.SetSessionConfigOptionResponse;
    try {
      res = (await withTimeout(
        proc.acp.agent.request(methods.agent.session.setConfigOption, params as acp.SetSessionConfigOptionRequest),
        CONFIG_TIMEOUT_MS,
        "设置超时",
      )) as acp.SetSessionConfigOptionResponse;
    } catch (e) {
      throw new ValidationError(`${proc.spec.name} 拒绝了这个设置：${harnessError(proc, e).message}`);
    }
    slot.view.configOptions = providerConfigOptions(
      proc.provider,
      agent.harness,
      res.configOptions,
      proc.acp.launch.env,
    );
    this.store.setRoomConfig(room.id, agent.id, configId, String(value));
    if (option?.category === "model" || configId === "model")
      await this.applyConfigPreferences(proc, slot, this.reasoningPreferences(room, agent, slot.view));
    this.events.session(room.id, agent.id, { ...slot.view });
    return slot.view;
  }

  async setMode(room: Room, agent: Agent, identity: string, modeId: string) {
    if (agent.harness === CUSTOM_HARNESS) throw new ValidationError("自定义 API 没有模式");
    const { proc, slot } = await this.session(room, agent, identity);
    await proc.acp.agent.request(methods.agent.session.setMode, { sessionId: slot.view.sessionId as string, modeId });
    if (slot.view.modes) slot.view.modes = { ...slot.view.modes, currentModeId: modeId };
    this.events.session(room.id, agent.id, { ...slot.view });
    return slot.view;
  }

  /** Sessions the harness remembers for this working directory (session/list). */
  async listSessions(room: Room, agent: Agent, identity: string): Promise<acp.SessionInfo[]> {
    if (agent.harness === CUSTOM_HARNESS) return [];
    const { proc } = await this.session(room, agent, identity);
    const init = await proc.ready;
    if (!init.agentCapabilities?.sessionCapabilities?.list) return [];
    const res = await proc.acp.agent.request(methods.agent.session.list, { cwd: this.cwdFor(room, agent) });
    return res.sessions;
  }

  /** Points this room at another harness session (from listSessions), or at a fresh one when null. */
  async switchSession(room: Room, agent: Agent, identity: string, sessionId: string | null) {
    const slotKey = `${room.id}|${agent.id}`;
    if (this.activeTurns.has(slotKey))
      throw new ValidationError("这个 Agent 在当前会话中仍有任务正在运行，暂时不能切换会话", 409);
    if (agent.harness === CUSTOM_HARNESS) {
      if (sessionId) throw new ValidationError("自定义 API 没有会话列表");
      // 新会话：清空并落盘，重启不能复活旧聊天（空数组与“从未初始化”是两种状态）。
      this.store.setCustomHistory(room.id, agent.id, []);
      return this.ensureCustom(room, agent).view;
    }
    this.opening.delete(slotKey);
    const old = this.slots.get(slotKey);
    if (old) {
      this.slots.delete(slotKey);
      for (const p of this.procs.values())
        if (old.view.sessionId && p.sessions.get(old.view.sessionId) === old) p.sessions.delete(old.view.sessionId);
    }
    if (sessionId) {
      this.store.setAcpSession(room.id, agent.id, agent.harness, sessionId);
      this.wantLoad.add(slotKey);
    } else this.store.clearAcpSession(room.id, agent.id);
    return (await this.session(room, agent, identity)).slot.view;
  }

  /** Release a room's harness resources, optionally only for a removed Agent. */
  releaseRoom(roomId: string, agentId?: string) {
    const matches = (owner: { roomId: string; agentId: string }) =>
      owner.roomId === roomId && (agentId === undefined || owner.agentId === agentId);
    const matchesKey = (key: string) =>
      agentId === undefined ? key.startsWith(`${roomId}|`) : key === `${roomId}|${agentId}`;
    // Invalidate warm-ups before killing their processes; late completions must not reattach.
    for (const key of this.opening.keys()) if (matchesKey(key)) this.opening.delete(key);
    for (const key of this.wantLoad) if (matchesKey(key)) this.wantLoad.delete(key);
    // Project directory/ownership changes, member removal and room deletion reset the BYOK
    // conversation: the cleared state is persisted as [] so neither a restart nor the next turn
    // can seed the old chat back from the message log. Room/agent deletion then cascades in the
    // database; a plain shutdown only releases processes and keeps successful context.
    if (agentId === undefined) {
      const room = this.store.getRoom(roomId);
      if (room) for (const id of room.agentIds) this.store.setCustomHistory(roomId, id, []);
    } else this.store.setCustomHistory(roomId, agentId, []);
    for (const [key, slot] of this.slots) if (matches(slot)) this.slots.delete(key);
    for (const [id, pending] of this.asks) if (matches(pending.ask)) this.answer(id, null);
    this.cancelElicitations((_slot, ask) => matches(ask));
    for (const proc of [...this.procs.values()]) if (matches(proc)) this.dropProc(proc);
    // Active prompt guards are released by their own finally blocks after cancellation settles.
  }

  /** Stop every process of one harness (before uninstalling it). */
  dropHarness(harnessId: string) {
    for (const [key, opening] of this.opening) if (opening.harness === harnessId) this.opening.delete(key);
    for (const p of [...this.procs.values()]) if (p.spec.id === harnessId) this.dropProc(p);
  }

  shutdown() {
    this.opening.clear();
    for (const p of [...this.procs.values()]) this.dropProc(p);
  }
}

/** Stop waiting promptly without cancelling another caller's session warm-up. */
async function waitForSession<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("用户取消", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Claude Code + 服务商: session-only settings that outrank the user's settings.json env. */
export function withProviderMeta(
  meta: Record<string, unknown> | undefined,
  agent: Pick<Agent, "harness" | "providerId">,
  store: Pick<Store, "getProvider">,
  runtime?: { provider: ProviderSecret | null; env: Record<string, string> },
): Record<string, unknown> | undefined {
  if (agent.harness !== "claude-code" || !agent.providerId) return meta;
  const prov = runtime ? runtime.provider : store.getProvider(agent.providerId);
  if (!prov || !providerSupports(prov, "claude-code")) return meta;
  return { ...meta, claudeCode: { options: { settings: claudeSettingsOverride(prov, runtime?.env) } } };
}

/** Checked library plugins for Claude Code: session-only `plugins` option, merged with other options. */
export function withClaudePlugins(
  meta: Record<string, unknown> | undefined,
  plugins: { type: "local"; path: string }[],
): Record<string, unknown> | undefined {
  if (!plugins.length) return meta;
  const cc = (meta?.claudeCode ?? {}) as { options?: Record<string, unknown> };
  return { ...meta, claudeCode: { ...cc, options: { ...cc.options, plugins } } };
}

function identityMeta(spec: HarnessSpec, identity: string): Record<string, unknown> | undefined {
  if (!identity.trim()) return undefined;
  if (spec.identity === "claude-meta") return { systemPrompt: { append: identity } };
  if (spec.identity === "grok-meta") return { rules: identity };
  return undefined;
}

function harnessError(proc: Proc, e: unknown, stderrBefore = ""): Error {
  let msg = (e as { message?: string }).message ?? JSON.stringify(e);
  // JSON-RPC errors often say just "Internal error": add the details and what the harness printed
  // on stderr during this turn (e.g. glm-acp-agent's "No API key found. Set the Z_AI_API_KEY …").
  const data = (e as { data?: unknown }).data;
  const detail =
    typeof data === "string" ? data : (data as { details?: string; message?: string } | undefined)?.details;
  if (detail && !msg.includes(detail)) msg = `${msg}：${detail}`;
  const now = proc.acp.stderr;
  const fresh = (now.startsWith(stderrBefore) ? now.slice(stderrBefore.length) : now).trim();
  const errLines = fresh
    .split("\n")
    .filter((l) => /error|api[ _-]?key|denied|unauthori[sz]ed|forbidden|invalid/i.test(l))
    .slice(-3)
    .join("\n");
  if (!detail && errLines && !msg.includes(errLines)) msg = `${msg}\n${errLines.slice(-600)}`;
  if (/auth/i.test(msg)) return new ValidationError(`${proc.spec.name} 需要登录：${proc.spec.auth}`, 401);
  return e instanceof Error && e.message === msg ? e : new Error(msg);
}

function pickerSkills(managed: SessionView["skills"], advertised: SessionView["skills"]): SessionView["skills"] {
  return [...new Map([...managed, ...advertised].map((s) => [s.name, s])).values()];
}

/** Codex advertises skills as available_commands whose names start with "$". */
function splitCommands(all: acp.AvailableCommand[]): {
  commands: acp.AvailableCommand[];
  skills: { name: string; description: string }[];
} {
  const commands: acp.AvailableCommand[] = [];
  const skills: { name: string; description: string }[] = [];
  for (const c of all) {
    if (c.name.startsWith("$")) skills.push({ name: c.name.replace(/^\$/, ""), description: c.description ?? "" });
    else commands.push(c);
  }
  return { commands, skills };
}

/** The harness's model picker, if it advertises one (ACP session config option, category "model"). */
export function modelOption(opts: acp.SessionConfigOption[]): (acp.SessionConfigOption & { type: "select" }) | null {
  const o = opts.find((x) => x.type === "select" && (x.category === "model" || x.id === "model"));
  return (o as (acp.SessionConfigOption & { type: "select" }) | undefined) ?? null;
}

export function nativeReasoningPreferences(harness: string, env: Record<string, string>): Record<string, string> {
  if (harness === "codex") {
    try {
      const config = JSON.parse(env.CODEX_CONFIG || "{}");
      return typeof config.model_reasoning_effort === "string"
        ? { reasoning_effort: config.model_reasoning_effort }
        : {};
    } catch {
      return {};
    }
  }
  if (harness === "claude-code") {
    if (env.MAX_THINKING_TOKENS === "0") return { effort: "off" };
    if (env.CLAUDE_CODE_EFFORT_LEVEL) return { effort: env.CLAUDE_CODE_EFFORT_LEVEL };
  }
  return {};
}

export function selectValues(o: acp.SessionConfigOption): string[] {
  if (o.type !== "select") return [];
  const out: string[] = [];
  for (const x of o.options as unknown[]) {
    const g = x as { options?: { value: string }[]; value?: string };
    if (g.options) out.push(...g.options.map((y) => y.value));
    else if (g.value !== undefined) out.push(g.value);
  }
  return out;
}

/** Model of a turn from `_meta.quota.model_usage` (Claude Code, Codex): the row with the most tokens. */
export function usageModel(meta: unknown): string | null {
  const rows = (meta as { quota?: { model_usage?: unknown } } | null | undefined)?.quota?.model_usage;
  if (!Array.isArray(rows)) return null;
  let best: { model: string; n: number } | null = null;
  for (const r of rows as { model?: unknown; token_count?: { totalTokens?: unknown } }[]) {
    if (typeof r?.model !== "string" || !r.model) continue;
    const n = typeof r.token_count?.totalTokens === "number" ? r.token_count.totalTokens : 0;
    if (!best || n > best.n) best = { model: r.model, n };
  }
  return best?.model ?? null;
}

function grokMetaUsage(meta: unknown): acp.Usage | null {
  const u = (meta as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!u || typeof u.totalTokens !== "number") return null;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return {
    inputTokens: n("inputTokens"),
    outputTokens: n("outputTokens"),
    cachedReadTokens: n("cachedReadTokens"),
    cachedWriteTokens: n("cacheCreationTokens"),
    totalTokens: n("totalTokens"),
  };
}
