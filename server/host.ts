import { homedir } from "node:os";
import { resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { AcpProcess, type TerminalSnapshot, withTimeout } from "./acp";
import { detectHarness, type HarnessSpec, harnessSpec, loginShellEnv } from "./harness";
import type { Agent, Room, Store } from "./store";
import { ValidationError } from "./store";

/** Live, per-(room, agent) view of the harness session the UI needs: pickers, slash commands, usage. */
export interface SessionView {
  sessionId: string | null;
  harness: string;
  configOptions: acp.SessionConfigOption[];
  modes: acp.SessionModeState | null;
  commands: acp.AvailableCommand[];
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

  constructor(
    private store: Store,
    private events: HostEvents,
  ) {}

  /** Working directory an agent uses in this room: the group's shared cwd, else the agent's own. */
  cwdFor(room: Room, agent: Agent): string {
    const raw = room.kind === "group" ? room.cwd || agent.cwd : agent.cwd;
    return resolve(raw ? raw.replace(/^~(?=$|\/)/, homedir()) : homedir());
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
    const env: Record<string, string> = { ...base, ...agent.env };
    if (spec.identity === "codex-env" && identity)
      env.CODEX_CONFIG = JSON.stringify({
        ...(base.CODEX_CONFIG ? JSON.parse(base.CODEX_CONFIG) : {}),
        developer_instructions: identity,
      });
    const key = `${agent.id}|${cwd}`;
    const signature = JSON.stringify([status.path, spec.args, env.CODEX_CONFIG ?? "", agent.env]);
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
      case "available_commands_update":
        v.commands = u.availableCommands;
        break;
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
    else if (!slot.replaying) slot.turn?.(u);
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
    const view: SessionView = {
      sessionId: null,
      harness: proc.spec.id,
      configOptions: [],
      modes: null,
      commands: [],
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
      identityPending: false,
    };
    const mcpServers = this.mcpServers(agent);
    const meta = identityMeta(proc.spec, identity);
    const saved = this.store.getAcpSession(room.id, agent.id);
    let res: { configOptions?: acp.SessionConfigOption[] | null; modes?: acp.SessionModeState | null } | null = null;
    if (saved && saved.harness === proc.spec.id && (view.capabilities.resume || view.capabilities.loadSession)) {
      proc.sessions.set(saved.sessionId, slot);
      view.sessionId = saved.sessionId;
      slot.replaying = true;
      try {
        res = view.capabilities.resume
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
    return agent.mcpServerIds
      .map((id) => all.find((s) => s.id === id))
      .filter((s) => s !== undefined)
      .map((s) => ({ type: "http" as const, name: s.name, url: s.url, headers: [] }));
  }

  /**
   * Runs one prompt turn. Reply content updates go to `onUpdate`; returns the stop reason.
   * Aborting the signal sends session/cancel and resolves any open permission prompt as cancelled.
   */
  async prompt(
    room: Room,
    agent: Agent,
    identity: string,
    blocks: acp.ContentBlock[],
    onUpdate: (u: acp.SessionUpdate) => void,
    signal: AbortSignal,
  ): Promise<{ stopReason: acp.StopReason }> {
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

  async setConfig(room: Room, agent: Agent, identity: string, configId: string, value: string | boolean) {
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
    const { proc, slot } = await this.session(room, agent, identity);
    await proc.acp.agent.request(methods.agent.session.setMode, { sessionId: slot.view.sessionId as string, modeId });
    if (slot.view.modes) slot.view.modes = { ...slot.view.modes, currentModeId: modeId };
    this.events.session(room.id, agent.id, { ...slot.view });
    return slot.view;
  }

  /** Sessions the harness remembers for this working directory (session/list). */
  async listSessions(room: Room, agent: Agent, identity: string): Promise<acp.SessionInfo[]> {
    const { proc } = await this.session(room, agent, identity);
    const init = await proc.ready;
    if (!init.agentCapabilities?.sessionCapabilities?.list) return [];
    const res = await proc.acp.agent.request(methods.agent.session.list, { cwd: this.cwdFor(room, agent) });
    return res.sessions;
  }

  /** Points this room at another harness session (from listSessions), or at a fresh one when null. */
  async switchSession(room: Room, agent: Agent, identity: string, sessionId: string | null) {
    const slotKey = `${room.id}|${agent.id}`;
    const old = this.slots.get(slotKey);
    if (old) {
      this.slots.delete(slotKey);
      for (const p of this.procs.values()) if (old.view.sessionId) p.sessions.delete(old.view.sessionId);
    }
    if (sessionId) this.store.setAcpSession(room.id, agent.id, agent.harness, sessionId);
    else this.store.clearAcpSession(room.id, agent.id);
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
