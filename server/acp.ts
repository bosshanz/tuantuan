import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { killProcessTree, processGroupOptions } from "./process-tree";

/**
 * One harness process speaking ACP over stdio. Tuantuan is the ACP *client*: it answers the agent's
 * fs/terminal/permission requests (scoped to the agent's working directory) and forwards
 * session/update notifications to `onUpdate`.
 */
export interface AcpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Directory the process starts in and every fs/terminal request must stay inside. */
  cwd: string;
  /** Explicit Agent selections: extra read-only directories or exact legacy files. */
  skillReadRoots?: string[];
}

export interface AcpHandlers {
  onUpdate(n: acp.SessionNotification): void;
  requestPermission(p: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  onTerminal?(t: TerminalSnapshot): void;
}

export interface TerminalSnapshot {
  terminalId: string;
  sessionId: string;
  command: string;
  output: string;
  truncated: boolean;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
}

interface Term extends TerminalSnapshot {
  proc: ReturnType<typeof Bun.spawn>;
  limit: number;
  exited: Promise<void>;
}

export class AcpProcess {
  readonly proc: ReturnType<typeof Bun.spawn>;
  private conn: acp.ClientConnection;
  private terms = new Map<string, Term>();
  private stderrTail = "";
  private stopping: NodeJS.Signals | null = null;
  private root: string;
  private skillReadRoots: { path: string; real: string; directory: boolean }[] = [];
  init: acp.InitializeResponse | null = null;
  /** Resolves (never rejects) when the process exits. */
  readonly exited: Promise<number>;

  constructor(
    readonly launch: AcpLaunch,
    private h: AcpHandlers,
  ) {
    this.root = realpathSync(launch.cwd);
    this.setSkillReadRoots(launch.skillReadRoots ?? []);
    this.proc = Bun.spawn([launch.command, ...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...processGroupOptions,
    });
    const sink = this.proc.stdin as import("bun").FileSink;
    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        sink.write(chunk);
        return sink.flush() as unknown as Promise<void>;
      },
      close() {
        sink.end();
      },
    });
    void this.collectStderr();
    this.exited = this.proc.exited.then((c) => c ?? -1);
    const stream = acp.ndJsonStream(input, this.proc.stdout as ReadableStream<Uint8Array>);
    this.conn = acp
      .client({ name: "tuantuan" })
      .onNotification(acp.methods.client.session.update, (ctx) => this.h.onUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.h.requestPermission(ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => this.readTextFile(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => this.writeTextFile(ctx.params))
      .onRequest(acp.methods.client.terminal.create, (ctx) => this.createTerminal(ctx.params))
      .onRequest(acp.methods.client.terminal.output, (ctx) => this.terminalOutput(ctx.params.terminalId))
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) => this.waitForExit(ctx.params.terminalId))
      .onRequest(acp.methods.client.terminal.kill, (ctx) => this.killTerminal(ctx.params.terminalId))
      .onRequest(acp.methods.client.terminal.release, (ctx) => this.releaseTerminal(ctx.params.terminalId))
      .connect(stream);
  }

  get agent() {
    return this.conn.agent;
  }

  /** Last stderr lines, for error messages when the harness dies or refuses to start. */
  get stderr() {
    return this.stderrTail.trim();
  }

  async initialize(timeoutMs = 30_000): Promise<acp.InitializeResponse> {
    const res = await withTimeout(
      Promise.race([
        this.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: { name: "tuantuan", title: "团团", version: "0.1.0" },
        }),
        this.exited.then((code) => {
          throw new Error(`Harness 进程退出（code ${code}）${this.stderr ? `：${this.stderr.slice(-400)}` : ""}`);
        }),
      ]),
      timeoutMs,
      "initialize 超时",
    );
    this.init = res;
    return res;
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    if (this.stopping && (signal !== "SIGKILL" || this.stopping === "SIGKILL")) return;
    const previous = this.stopping;
    this.stopping = signal;
    try {
      for (const t of this.terms.values()) killProcessTree(t.proc, signal);
      // Closing stdin first can make a starting harness exit before it is signalled.
      // On macOS, signalling a process group containing only that zombie returns EPERM.
      killProcessTree(this.proc, signal);
    } catch (error) {
      this.stopping = previous;
      throw error;
    }
    this.conn.close();
  }

  private async collectStderr() {
    const dec = new TextDecoder();
    for await (const chunk of this.proc.stderr as ReadableStream<Uint8Array>)
      this.stderrTail = (this.stderrTail + dec.decode(chunk)).slice(-4000);
  }

  // ---- client side: fs + terminal, confined to launch.cwd ----

  /** Resolves a path the agent sent and refuses anything outside the agent's working directory. */
  inside(path: string): string {
    const lexicalRoot = resolve(this.launch.cwd);
    const p = resolve(lexicalRoot, path);
    const within = (candidate: string, root: string) =>
      candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
    const denied = () => acp.RequestError.invalidParams({ path }, `路径不在 Agent 工作目录内：${path}`);
    if (!within(p, lexicalRoot) && !within(p, this.root)) throw denied();

    // New files may have missing parents. Resolve the nearest existing ancestor, including links,
    // then append only missing components. A dangling link is an error, never a missing directory.
    let ancestor = p;
    const missing: string[] = [];
    for (;;) {
      try {
        lstatSync(ancestor);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw denied();
        missing.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
    let target: string;
    try {
      target = join(realpathSync(ancestor), ...missing);
    } catch {
      throw denied();
    }
    if (!within(target, this.root))
      throw acp.RequestError.invalidParams({ path }, `路径不在 Agent 工作目录内：${path}`);
    return target;
  }

  /** Replace, rather than accumulate, grants before each prompt so unchecked skills are revoked. */
  setSkillReadRoots(paths: string[]) {
    this.skillReadRoots = paths.flatMap((path) => {
      try {
        const real = realpathSync(path);
        return [{ path: resolve(path), real, directory: lstatSync(real).isDirectory() }];
      } catch {
        return []; // A removed skill must not keep its old grant.
      }
    });
  }

  private readable(path: string): string {
    try {
      return this.inside(path);
    } catch (denied) {
      const requested = resolve(this.launch.cwd, path);
      const within = (candidate: string, root: string) => candidate === root || candidate.startsWith(root + sep);
      const roots = this.skillReadRoots.filter((root) =>
        root.directory
          ? within(requested, root.path) || within(requested, root.real)
          : requested === root.path || requested === root.real,
      );
      if (!roots.length) throw denied;
      let real: string;
      try {
        real = realpathSync(requested);
      } catch {
        throw denied;
      }
      if (!roots.some((root) => (root.directory ? within(real, root.real) : real === root.real))) throw denied;
      return real;
    }
  }

  private async readTextFile(p: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const file = Bun.file(this.readable(p.path));
    if (!(await file.exists())) throw acp.RequestError.resourceNotFound(p.path);
    let text = await file.text();
    if (p.line != null || p.limit != null) {
      const lines = text.split("\n");
      const from = Math.max(0, (p.line ?? 1) - 1);
      text = lines.slice(from, p.limit != null ? from + p.limit : undefined).join("\n");
    }
    return { content: text };
  }

  private async writeTextFile(p: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await Bun.write(this.inside(p.path), p.content);
    return {};
  }

  private async createTerminal(p: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const cwd = this.inside(p.cwd ?? this.launch.cwd);
    const env = { ...this.launch.env, ...Object.fromEntries((p.env ?? []).map((e) => [e.name, e.value])) };
    // Agents send either a shell line in `command` or an argv split; run both through the shell like Zed does.
    const line = [p.command, ...(p.args ?? []).map(shellQuote)].join(" ");
    const proc = Bun.spawn(["/bin/sh", "-c", line], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      ...processGroupOptions,
    });
    const t: Term = {
      terminalId: crypto.randomUUID(),
      sessionId: p.sessionId,
      command: line,
      output: "",
      truncated: false,
      exitStatus: null,
      proc,
      limit: p.outputByteLimit ?? 256_000,
      exited: Promise.resolve(),
    };
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const c of s) {
        t.output += dec.decode(c);
        if (t.output.length > t.limit) {
          t.output = t.output.slice(t.output.length - t.limit);
          t.truncated = true;
        }
        this.h.onTerminal?.(snapshot(t));
      }
    };
    t.exited = Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array>),
      pump(proc.stderr as ReadableStream<Uint8Array>),
      proc.exited,
    ]).then(() => {
      t.exitStatus = { exitCode: proc.exitCode, signal: proc.signalCode != null ? String(proc.signalCode) : null };
      this.h.onTerminal?.(snapshot(t));
    });
    this.terms.set(t.terminalId, t);
    this.h.onTerminal?.(snapshot(t));
    return { terminalId: t.terminalId };
  }

  private term(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw acp.RequestError.resourceNotFound(id);
    return t;
  }

  private terminalOutput(id: string): acp.TerminalOutputResponse {
    const t = this.term(id);
    return { output: t.output, truncated: t.truncated, exitStatus: t.exitStatus };
  }

  private async waitForExit(id: string): Promise<acp.WaitForTerminalExitResponse> {
    const t = this.term(id);
    await t.exited;
    return { exitCode: t.exitStatus?.exitCode ?? null, signal: t.exitStatus?.signal ?? null };
  }

  private killTerminal(id: string): acp.KillTerminalResponse {
    killProcessTree(this.term(id).proc);
    return {};
  }

  private releaseTerminal(id: string): acp.ReleaseTerminalResponse {
    const t = this.terms.get(id);
    if (t) killProcessTree(t.proc);
    this.terms.delete(id);
    return {};
  }
}

function snapshot(t: Term): TerminalSnapshot {
  return {
    terminalId: t.terminalId,
    sessionId: t.sessionId,
    command: t.command,
    output: t.output,
    truncated: t.truncated,
    exitStatus: t.exitStatus,
  };
}

export function shellQuote(s: string) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
