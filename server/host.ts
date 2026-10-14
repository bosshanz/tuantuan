import { homedir } from "node:os";
import type * as acp from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { AcpProcess, type TerminalSnapshot, withTimeout } from "./acp";
import { CUSTOM_HARNESS, type Item, runTurn } from "./custom";
import { detectHarness, type HarnessSpec, harnessSpec, loginShellEnv } from "./harness";
import { harnessProcessEnv } from "./harness-env";
import { loadSkillBody, materializeSkills } from "./skills";
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

export interface HostEvents {
  session(roomId: string, agentId: string, view: SessionView): void;
  permission(ask: PermissionAsk | { id: string; roomId: string; resolved: true }): void;
  terminal(roomId: string, t: TerminalSnapshot): void;
}

interface Proc {
  key: string;
  signature: string;
  acp: AcpProcess;
  spec: HarnessSpec;
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
  /** While loading/resuming, replayed history is dropped (Tuantuan keeps its own transcript). */
  replaying: boolean;
  /** Updates the harness replayed on session/load (history Tuantuan may not have); shown read-only. */
  replay: acp.SessionUpdate[];
  identityPending: boolean;
}

/**
 * Owns harness processes (one per agent + working directory) and the ACP sessions inside them.
 * Rooms map to sessions through the acp_sessions table so conversations survive restarts when the
 * harness can resume or load them.
 */
export class HarnessHost {
  private procs = new Map<string, Proc>();
  private slots = new Map<string, SessionSlot>(); // `${roomId}|${agentId}` -> slot
  private asks = new Map<
    string,
    { ask: PermissionAsk; resolve: (r: acp.RequestPermissionResponse) => void; signal?: AbortSignal }
  >();

  /** Slots whose next attach should session/load (to get the harness's history) rather than resume. */
  private wantLoad = new Set<string>();
  /** In-process BYOK chat history per (room, agent). */
  private customHistory = new Map<string, Item[]>();

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

  /** Starts (or reuses) the harness process for this agent and working directory. */
  private async proc(agent: Agent, cwd: string, identity: string): Promise<Proc> {
    const spec = harnessSpec(agent.harness);
    if (!spec) throw new ValidationError(`「${agent.name}」还没有绑定 Harness，请在 Agent 设置或新手引导里选择`);
    const overrides = this.store.getSetting<Record<string, string>>("harnessPaths", {});
    const status = await detectHarness(spec, overrides[spec.id] ?? null);
    if (!status.path) throw new ValidationError(`${spec.name} 未安装：${status.error}。安装：${spec.install}`);
    const base = await loginShellEnv();
    const mat = materializeSkills(this.dataDir, agent.id, agent.harness, cwd);
    // Keep the user's CC Switch / Codex config: inherit ANTHROPIC_* / OPENAI_*, never isolate
    // CLAUDE_CONFIG_DIR or CODEX_HOME; only merge developer_instructions into CODEX_CONFIG.
    const env = harnessProcessEnv(base, mat.env, agent.env, spec, identity);
    const key = `${agent.id}|${cwd}`;
    const signature = JSON.stringify([status.path, spec.args, env.CODEX_CONFIG ?? "", agent.env, mat.env]);
    const existing = this.procs.get(key);
    if (existing && existing.signature === signature && existing.acp.proc.exitCode === null) return existing;
    if (existing) this.dropProc(existing);

    const proc: Proc = {
      key,
      signature,
      spec,
      sessions: new Map(),
      acp: null as unknown as AcpProcess,
      ready: null as never,
    };
    proc.acp = new AcpProcess(
      { command: status.path, args: spec.args, env, cwd },
      {
        onUpdate: (n) => this.onUpdate(proc, n),
        requestPermission: (p) => this.requestPermission(proc, agent.id, p),
        onTerminal: (t) => {
          const slot = proc.sessions.get(t.sessionId);
          if (slot) this.events.terminal(slot.roomId, t);
        },
      },
    );
    proc.ready = proc.acp.initialize();
    proc.ready.catch(() => this.dropProc(proc));
    void proc.acp.exited.then(() => {
      if (this.procs.get(key) === proc) this.dropProc(proc);
    });
    this.procs.set(key, proc);
    return proc;
  }

  private dropProc(p: Proc) {
    if (this.procs.get(p.key) === p) this.procs.delete(p.key);
    const rooms = new Set([...p.sessions.values()].map((s) => `${s.roomId}|${s.agentId}`));
    for (const [id, a] of this.asks) if (rooms.has(`${a.ask.roomId}|${a.ask.agentId}`)) this.answer(id, null);
    for (const k of rooms) this.slots.delete(k);
    p.sessions.clear();
    p.acp.kill();
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
        // Merge harness $skills over same-named entries; keep room/agent skills otherwise.
        const by = new Map(v.skills.map((x) => [x.name, x]));
        for (const sk of split.skills) by.set(sk.name, sk);
        v.skills = [...by.values()];
        break;
      }
      case "config_option_update":
        v.configOptions = u.configOptions;
        break;
      case "current_mode_update":
        if (v.modes) v.modes = { ...v.modes, currentModeId: u.currentModeId };
        break;
      case "usage_update":
        v.usage = { used: u.used, size: u.size, cost: u.cost ?? null };
        break;
      case "session_info_update":
        if (u.title !== undefined) v.title = u.title ?? null;
        break;
      default:
        changed = false;
    }
    if (changed) this.events.session(slot.roomId, slot.agentId, { ...v });
    else if (slot.replaying) slot.replay.push(u);
    else slot.turn?.(u);
  }

  private requestPermission(p: Proc, agentId: string, req: acp.RequestPermissionRequest) {
    const slot = p.sessions.get(req.sessionId);
    const agent = this.store.getAgent(agentId);
    if (agent?.permissionPolicy === "allow") {
      const allow =
        req.options.find((o) => o.kind === "allow_once") ?? req.options.find((o) => o.kind.startsWith("allow"));
      if (allow)
        return Promise.resolve<acp.RequestPermissionResponse>({
          outcome: { outcome: "selected", optionId: allow.optionId },
        });
    }
    if (!slot) return Promise.resolve<acp.RequestPermissionResponse>({ outcome: { outcome: "cancelled" } });
    const ask: PermissionAsk = {
      id: crypto.randomUUID(),
      roomId: slot.roomId,
      agentId,
      toolCall: req.toolCall,
      options: req.options,
    };
    return new Promise<acp.RequestPermissionResponse>((res) => {
      this.asks.set(ask.id, { ask, resolve: res });
      this.events.permission(ask);
    });
  }

  /**
   * Returns the session for this room and agent, creating, resuming or loading it as the harness allows.
   * `identity` is the Tuantuan identity + group context, delivered per the harness (plan §3.4).
   */
  async session(room: Room, agent: Agent, identity: string): Promise<{ proc: Proc; slot: SessionSlot }> {
    const cwd = this.cwdFor(room, agent);
    const proc = await this.proc(agent, cwd, identity);
    const init = await proc.ready;
    const slotKey = `${room.id}|${agent.id}`;
    const cached = this.slots.get(slotKey);
    if (cached?.view.sessionId && proc.sessions.get(cached.view.sessionId) === cached) return { proc, slot: cached };

    const caps = init.agentCapabilities ?? {};
    const mat = materializeSkills(this.dataDir, agent.id, agent.harness, cwd);
    const view: SessionView = {
      sessionId: null,
      harness: proc.spec.id,
      configOptions: [],
      modes: null,
      commands: [],
      skills: [...mat.skills, ...mat.roomSkills].map((x) => ({ name: x.name, description: x.description })),
      usage: null,
      title: null,
      capabilities: {
        image: !!caps.promptCapabilities?.image,
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
      replaying: false,
      replay: [],
      identityPending: false,
    };
    const mcpServers = this.mcpServers(agent);
    const own = this.mcp?.serverEntry({ roomId: room.id, agentId: agent.id }, caps.mcpCapabilities);
    if (own) mcpServers.push(own);
    const preferLoad = this.wantLoad.delete(slotKey);
    const meta = identityMeta(proc.spec, identity);
    const saved = this.store.getAcpSession(room.id, agent.id);
    let res: { configOptions?: acp.SessionConfigOption[] | null; modes?: acp.SessionModeState | null } | null = null;
    if (saved && saved.harness === proc.spec.id && (view.capabilities.resume || view.capabilities.loadSession)) {
      proc.sessions.set(saved.sessionId, slot);
      view.sessionId = saved.sessionId;
      slot.replaying = true;
      try {
        res =
          view.capabilities.resume && !(preferLoad && view.capabilities.loadSession)
            ? await proc.acp.agent.request(methods.agent.session.resume, {
                sessionId: saved.sessionId,
                cwd,
                mcpServers,
                _meta: meta,
              })
            : await proc.acp.agent.request(methods.agent.session.load, {
                sessionId: saved.sessionId,
                cwd,
                mcpServers,
                _meta: meta,
              });
      } catch {
        proc.sessions.delete(saved.sessionId);
        view.sessionId = null;
        res = null;
      } finally {
        slot.replaying = false;
      }
    }
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
      view.sessionId = created.sessionId;
      proc.sessions.set(created.sessionId, slot);
      slot.identityPending = proc.spec.identity === "first-prompt" && identity.trim() !== "";
      this.store.setAcpSession(room.id, agent.id, proc.spec.id, created.sessionId);
      res = created;
    }
    view.configOptions = res?.configOptions ?? [];
    view.modes = res?.modes ?? null;
    this.slots.set(slotKey, slot);
    this.events.session(room.id, agent.id, { ...view });
    return { proc, slot };
  }

  private mcpServers(agent: Agent): acp.McpServer[] {
    const all = this.store.listMcpServers();
    // User-configured servers are HTTP; harnesses must accept them (ACP makes only stdio mandatory).
    return agent.mcpServerIds
      .map((id) => all.find((s) => s.id === id))
      .filter((s) => s !== undefined)
      .map((s) => ({ type: "http" as const, name: s.name, url: s.url, headers: [] }));
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
    if (agent.harness === CUSTOM_HARNESS) return this.promptCustom(room, agent, identity, blocks, onUpdate, signal);
    const { proc, slot } = await this.session(room, agent, identity);
    const sessionId = slot.view.sessionId as string;
    if (slot.identityPending) {
      blocks = [{ type: "text", text: `<tuantuan-identity>\n${identity}\n</tuantuan-identity>` }, ...blocks];
      slot.identityPending = false;
    }
    if (!slot.view.capabilities.image) blocks = blocks.filter((b) => b.type !== "image");
    slot.turn = onUpdate;
    const onAbort = () => {
      void proc.acp.agent.notify(methods.agent.session.cancel, { sessionId });
      for (const [id, a] of this.asks)
        if (a.ask.roomId === room.id && a.ask.agentId === agent.id) this.answer(id, null);
    };
    signal.addEventListener("abort", onAbort);
    try {
      const res = await Promise.race([
        proc.acp.agent.request(methods.agent.session.prompt, { sessionId, prompt: blocks }),
        proc.acp.exited.then((code) => {
          throw new Error(
            `${proc.spec.name} 进程退出（code ${code}）${proc.acp.stderr ? `：${proc.acp.stderr.slice(-300)}` : ""}`,
          );
        }),
      ]);
      return { stopReason: res.stopReason };
    } catch (e) {
      throw harnessError(proc, e);
    } finally {
      signal.removeEventListener("abort", onAbort);
      slot.turn = null;
    }
  }

  private ensureCustom(room: Room, agent: Agent): SessionSlot {
    const key = `${room.id}|${agent.id}`;
    let slot = this.slots.get(key);
    if (!slot) {
      const mat = materializeSkills(this.dataDir, agent.id, CUSTOM_HARNESS, this.cwdFor(room));
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
          capabilities: { image: false, loadSession: false, list: false, resume: false },
        },
        turn: null,
        replaying: false,
        replay: [],
        identityPending: false,
      };
      this.slots.set(key, slot);
      this.events.session(room.id, agent.id, { ...slot.view });
    }
    return slot;
  }

  private dmTranscript(room: Room, agent: Agent): Item[] {
    const done = this.store
      .recentMessages(room.id, 40)
      .filter((m) => m.status === "done" && m.content.trim() && m.senderKind !== "system");
    // The last human message is this turn's prompt.
    if (done.at(-1)?.senderKind === "human") done.pop();
    return done.map((m) =>
      m.senderKind === "agent" && m.senderId === agent.id
        ? { kind: "assistant" as const, text: m.content, calls: [] }
        : { kind: "user" as const, text: m.content },
    );
  }

  private async promptCustom(
    room: Room,
    agent: Agent,
    identity: string,
    blocks: acp.ContentBlock[],
    onUpdate: (u: acp.SessionUpdate) => void,
    signal: AbortSignal,
  ): Promise<{ stopReason: acp.StopReason }> {
    const cfg = this.store.getCustomSecret(agent.id);
    if (!cfg) throw new ValidationError("请先在 Agent 设置里填写自定义 API");
    if (!cfg.apiKey) throw new ValidationError("请填写 API Key");
    this.ensureCustom(room, agent);
    const key = `${room.id}|${agent.id}`;
    let history = this.customHistory.get(key);
    if (!history) {
      // After a restart a DM picks up its recent transcript (groups get it through the relay).
      history = room.kind === "dm" ? this.dmTranscript(room, agent) : [];
      this.customHistory.set(key, history);
    }
    const userText = blocks
      .filter((b): b is acp.ContentBlock & { type: "text" } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const mat = materializeSkills(this.dataDir, agent.id, CUSTOM_HARNESS, this.cwdFor(room));
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
    const tools = [...(this.mcp?.provider?.tools({ roomId: room.id, agentId: agent.id }) ?? []), ...skillTools];
    const skillIndex = mat.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    const system = identity + (skillIndex ? `\n\n可用 Skills（用 load_skill 加载正文）：\n${skillIndex}` : "");
    return runTurn({
      cfg,
      system,
      history,
      userText,
      tools,
      callTool: async (name, args) => {
        if (name === "load_skill")
          return loadSkillBody(this.dataDir, agent.id, this.cwdFor(room), String(args.name ?? ""));
        if (!this.mcp?.provider) throw new Error("工具不可用");
        return this.mcp.provider.call({ roomId: room.id, agentId: agent.id }, name, args);
      },
      onUpdate,
      signal,
    });
  }

  async setConfig(room: Room, agent: Agent, identity: string, configId: string, value: string | boolean) {
    if (agent.harness === CUSTOM_HARNESS) throw new ValidationError("自定义 API 没有配置项");
    const { proc, slot } = await this.session(room, agent, identity);
    const params =
      typeof value === "boolean"
        ? { sessionId: slot.view.sessionId as string, configId, type: "boolean" as const, value }
        : { sessionId: slot.view.sessionId as string, configId, value };
    const res = (await proc.acp.agent.request(
      methods.agent.session.setConfigOption,
      params as acp.SetSessionConfigOptionRequest,
    )) as acp.SetSessionConfigOptionResponse;
    slot.view.configOptions = res.configOptions;
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
    if (agent.harness === CUSTOM_HARNESS) {
      if (sessionId) throw new ValidationError("自定义 API 没有会话列表");
      this.customHistory.delete(`${room.id}|${agent.id}`); // 新会话：忘掉之前的对话
      return this.ensureCustom(room, agent).view;
    }
    const slotKey = `${room.id}|${agent.id}`;
    const old = this.slots.get(slotKey);
    if (old) {
      this.slots.delete(slotKey);
      for (const p of this.procs.values()) if (old.view.sessionId) p.sessions.delete(old.view.sessionId);
    }
    if (sessionId) {
      this.store.setAcpSession(room.id, agent.id, agent.harness, sessionId);
      this.wantLoad.add(slotKey);
    } else this.store.clearAcpSession(room.id, agent.id);
    return (await this.session(room, agent, identity)).slot.view;
  }

  shutdown() {
    for (const p of [...this.procs.values()]) this.dropProc(p);
  }
}

function identityMeta(spec: HarnessSpec, identity: string): Record<string, unknown> | undefined {
  if (!identity.trim()) return undefined;
  if (spec.identity === "claude-meta") return { systemPrompt: { append: identity } };
  if (spec.identity === "grok-meta") return { rules: identity };
  return undefined;
}

function harnessError(proc: Proc, e: unknown): Error {
  const msg = (e as { message?: string }).message ?? JSON.stringify(e);
  if (/auth/i.test(msg)) return new ValidationError(`${proc.spec.name} 需要登录：${proc.spec.auth}`, 401);
  return e instanceof Error ? e : new Error(msg);
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
