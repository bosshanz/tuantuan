import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ProjectTerminalEvent, ProjectTerminalMeta } from "../shared/project-terminal";
import { ValidationError } from "./store";

export const PROJECT_TERMINAL_LIMITS = {
  terminals: 12,
  scrollback: 256 * 1024,
  message: 64 * 1024,
  inputPerSecond: 256 * 1024,
  pendingInput: 256 * 1024,
  connections: 8,
  minCols: 2,
  maxCols: 500,
  minRows: 1,
  maxRows: 200,
} as const;

type Listener = (event: ProjectTerminalEvent) => void;
type ProcessRow = { pid: number; ppid: number; tty: string; identity: string };
type Entry = {
  meta: ProjectTerminalMeta;
  proc: Bun.Subprocess;
  pty: Bun.Terminal;
  output: string;
  decoder: TextDecoder;
  listeners: Set<Listener>;
  tty: string | null;
  identity: string | null;
  stopping: Promise<void> | null;
  removing: boolean;
  inputWindow: number;
  inputBytes: number;
  input: Buffer;
  inputTimer: ReturnType<typeof setTimeout> | null;
};

function processTable(): ProcessRow[] {
  // macOS does not expose numeric session IDs through ps. TTY membership also covers
  // foreground/background job groups and children reparented by the interactive shell.
  const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,tty=,lstart="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`无法读取终端进程：${result.stderr.toString().trim()}`);
  return result.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) return [];
      return [
        { pid: Number(parts[0]), ppid: Number(parts[1]), tty: parts[2] as string, identity: parts.slice(3).join(" ") },
      ];
    });
}

function sendSignal(row: ProcessRow, signal: NodeJS.Signals) {
  try {
    process.kill(row.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    (cols as number) < PROJECT_TERMINAL_LIMITS.minCols ||
    (cols as number) > PROJECT_TERMINAL_LIMITS.maxCols ||
    (rows as number) < PROJECT_TERMINAL_LIMITS.minRows ||
    (rows as number) > PROJECT_TERMINAL_LIMITS.maxRows
  )
    throw new ValidationError("终端尺寸无效（列 2–500，行 1–200）");
  return { cols: cols as number, rows: rows as number };
}

export class ProjectTerminals {
  private entries = new Map<string, Entry>();
  private projects = new Map<string, Set<string>>();
  private removingProjects = new Map<string, Promise<void>>();
  private closed = false;

  get(id: string): ProjectTerminalMeta | null {
    const entry = this.entries.get(id);
    return entry ? { ...entry.meta } : null;
  }

  forProject(projectId: string): ProjectTerminalMeta | null {
    return this.get(this.projects.get(projectId)?.values().next().value ?? "");
  }

  list(projectId: string): ProjectTerminalMeta[] {
    return [...(this.projects.get(projectId) ?? [])].flatMap((id) => {
      const meta = this.get(id);
      return meta ? [meta] : [];
    });
  }

  open(project: { id: string; cwd: string }, env: Record<string, string>, cols = 80, rows = 24): ProjectTerminalMeta {
    if (this.closed) throw new ValidationError("服务正在关闭", 503);
    if (this.removingProjects.has(project.id)) throw new ValidationError("项目终端正在关闭，请稍后重试", 409);
    const existingId = this.projects.get(project.id)?.values().next().value;
    const existing = existingId ? this.entries.get(existingId) : null;
    if (existing?.removing || (existing?.stopping && existing.meta.status === "running"))
      throw new ValidationError("终端正在关闭，请稍后重试", 409);
    if (existing) return { ...existing.meta };
    return this.create(project, env, cols, rows);
  }

  create(project: { id: string; cwd: string }, env: Record<string, string>, cols = 80, rows = 24): ProjectTerminalMeta {
    if (this.closed) throw new ValidationError("服务正在关闭", 503);
    if (this.removingProjects.has(project.id)) throw new ValidationError("项目终端正在关闭，请稍后重试", 409);
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new ValidationError("内嵌终端需要 macOS 或 Linux", 501);
    if (typeof Bun.Terminal !== "function")
      throw new ValidationError("内嵌终端需要支持 Bun.Terminal 的 Bun 1.3.5 或更新版本", 501);
    if (this.entries.size >= PROJECT_TERMINAL_LIMITS.terminals)
      throw new ValidationError("已达到 12 个终端上限，请先结束一个终端", 409);
    const size = terminalSize(cols, rows);
    try {
      if (!statSync(project.cwd).isDirectory()) throw new Error("not a directory");
      accessSync(project.cwd, constants.R_OK | constants.X_OK);
    } catch {
      throw new ValidationError("项目文件夹不存在或无法访问");
    }
    const shell = [env.SHELL, process.env.SHELL, "/bin/bash", "/bin/sh"].find((candidate) => {
      if (!candidate || !isAbsolute(candidate)) return false;
      try {
        accessSync(candidate, constants.X_OK);
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!shell) throw new ValidationError("找不到可执行的登录 shell", 503);
    let entry: Entry | undefined;
    const decoder = new TextDecoder();
    const early: string[] = [];
    const terminal: Bun.TerminalOptions = {
      ...size,
      name: "xterm-256color",
      data: (_terminal, bytes) => {
        const data = decoder.decode(bytes, { stream: true });
        if (entry) this.output(entry, data);
        else early.push(data);
      },
    };
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn([shell, "-il"], {
        cwd: project.cwd,
        env: { ...env, SHELL: shell, TERM: "xterm-256color", COLORTERM: "truecolor" },
        terminal,
      });
    } catch (error) {
      throw new ValidationError(`终端启动失败：${(error as Error).message}`, 503);
    }
    const pty = proc.terminal;
    if (!pty) {
      proc.kill("SIGKILL");
      throw new ValidationError("运行时未创建 PTY，请更新 Bun", 503);
    }
    const meta: ProjectTerminalMeta = {
      id: crypto.randomUUID(),
      projectId: project.id,
      number: Math.max(0, ...this.list(project.id).map((terminal) => terminal.number)) + 1,
      cwd: project.cwd,
      shell,
      ...size,
      status: "running",
      exitCode: null,
    };
    entry = {
      meta,
      proc,
      pty,
      decoder,
      output: "",
      listeners: new Set(),
      tty: null,
      identity: null,
      stopping: null,
      removing: false,
      inputWindow: Date.now(),
      inputBytes: 0,
      input: Buffer.alloc(0),
      inputTimer: null,
    };
    try {
      // The child establishes its controlling TTY after fork; the first ps can
      // briefly observe it before login_tty has completed.
      let shellRow: ProcessRow | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        shellRow = processTable().find((row) => row.pid === proc.pid);
        if (shellRow && shellRow.tty !== "??" && shellRow.tty !== "?") break;
      }
      const tty = shellRow?.tty;
      entry.tty = tty && tty !== "??" && tty !== "?" ? tty : null;
      entry.identity = shellRow?.identity ?? null;
      if (!entry.tty) throw new Error("无法识别项目终端的 PTY");
    } catch (error) {
      proc.kill("SIGKILL");
      pty.close();
      throw new ValidationError(`终端启动失败：${(error as Error).message}`, 503);
    }
    this.entries.set(meta.id, entry);
    const terminals = this.projects.get(project.id) ?? new Set<string>();
    terminals.add(meta.id);
    this.projects.set(project.id, terminals);
    for (const data of early) this.output(entry, data);
    const current = entry;
    void proc.exited.then(async (code) => {
      current.meta.status = "exited";
      current.meta.exitCode = code;
      await this.stop(current);
      this.output(current, decoder.decode());
      this.emit(current, { type: "exit", exitCode: code });
    });
    return { ...meta };
  }

  subscribe(id: string, listener: Listener): () => void {
    const entry = this.require(id);
    if (entry.listeners.size >= PROJECT_TERMINAL_LIMITS.connections)
      throw new ValidationError("该项目终端连接过多，请先关闭其他窗口", 409);
    listener({ type: "snapshot", terminal: { ...entry.meta }, output: entry.output });
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  message(id: string, raw: string): void {
    if (Buffer.byteLength(raw) > PROJECT_TERMINAL_LIMITS.message) throw new ValidationError("终端消息过大");
    const entry = this.require(id);
    if (entry.meta.status !== "running" || entry.stopping) throw new ValidationError("终端已退出，请重新打开", 409);
    let message: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      throw new ValidationError("消息不是合法 JSON");
    }
    if (!message || typeof message !== "object") throw new ValidationError("终端消息无效");
    if (message.type === "input" && typeof message.data === "string") {
      const now = Date.now();
      if (now - entry.inputWindow >= 1000) {
        entry.inputWindow = now;
        entry.inputBytes = 0;
      }
      entry.inputBytes += Buffer.byteLength(message.data);
      if (entry.inputBytes > PROJECT_TERMINAL_LIMITS.inputPerSecond) throw new ValidationError("终端输入过快");
      const bytes = Buffer.from(message.data);
      if (entry.input.length + bytes.length > PROJECT_TERMINAL_LIMITS.pendingInput)
        throw new ValidationError("终端正在处理输入，请稍后重试");
      entry.input = Buffer.concat([entry.input, bytes]);
      this.flushInput(entry);
    } else if (message.type === "resize") {
      const size = terminalSize(message.cols, message.rows);
      entry.pty.resize(size.cols, size.rows);
      Object.assign(entry.meta, size);
    } else throw new ValidationError("终端消息类型无效");
  }

  async remove(projectId: string, terminalId?: string): Promise<void> {
    if (terminalId === undefined) {
      const existing = this.removingProjects.get(projectId);
      if (existing) return existing;
      const removal = Promise.all(
        [...(this.projects.get(projectId) ?? [])].map((id) => this.remove(projectId, id)),
      ).then(() => {});
      this.removingProjects.set(projectId, removal);
      try {
        await removal;
      } finally {
        this.removingProjects.delete(projectId);
      }
      return;
    }
    const entry = this.entries.get(terminalId);
    if (!entry || entry.meta.projectId !== projectId) throw new ValidationError("终端已更换，请刷新后重试", 409);
    entry.removing = true;
    await this.stop(entry);
    await entry.proc.exited;
    this.entries.delete(entry.meta.id);
    const terminals = this.projects.get(projectId);
    terminals?.delete(entry.meta.id);
    if (terminals?.size === 0) this.projects.delete(projectId);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.projects.keys()].map((id) => this.remove(id)));
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new ValidationError("终端不存在", 404);
    return entry;
  }

  private output(entry: Entry, data: string) {
    if (!data) return;
    entry.output = (entry.output + data).slice(-PROJECT_TERMINAL_LIMITS.scrollback);
    // Never replay a lone low surrogate after truncating a supplementary character.
    if (/^[\uDC00-\uDFFF]/.test(entry.output)) entry.output = entry.output.slice(1);
    this.emit(entry, { type: "output", data });
  }

  private flushInput(entry: Entry) {
    if (entry.inputTimer || entry.stopping) return;
    while (entry.input.length) {
      // Bun 1.3 can return a partial write; newer versions accept/buffer the
      // entire chunk. Only resend bytes the runtime has not accepted.
      let accepted: number;
      try {
        accepted = entry.pty.write(entry.input);
      } catch (error) {
        entry.input = Buffer.alloc(0);
        this.emit(entry, { type: "error", error: `终端输入失败：${(error as Error).message}` });
        return;
      }
      if (accepted <= 0) break;
      entry.input = entry.input.subarray(accepted);
    }
    if (entry.input.length)
      entry.inputTimer = setTimeout(() => {
        entry.inputTimer = null;
        this.flushInput(entry);
      }, 20);
  }

  private emit(entry: Entry, event: ProjectTerminalEvent) {
    for (const listener of entry.listeners) listener(event);
  }

  private stop(entry: Entry): Promise<void> {
    entry.stopping ??= (async () => {
      if (entry.inputTimer) clearTimeout(entry.inputTimer);
      entry.inputTimer = null;
      entry.input = Buffer.alloc(0);
      const table = processTable();
      const targets = new Map<number, ProcessRow>();
      for (const row of table)
        if ((row.pid === entry.proc.pid && row.identity === entry.identity) || (entry.tty && row.tty === entry.tty))
          targets.set(row.pid, row);
      for (let previous = -1; previous !== targets.size; ) {
        previous = targets.size;
        for (const row of table) if (targets.has(row.ppid)) targets.set(row.pid, row);
      }
      targets.delete(process.pid);
      // Keep the shell frozen during the grace period. Job control creates different
      // groups, and shell exit can erase the TTY association before jobs are collected.
      for (const row of targets.values()) sendSignal(row, "SIGSTOP");
      for (const row of targets.values()) if (row.pid !== entry.proc.pid) sendSignal(row, "SIGTERM");
      for (const row of targets.values()) if (row.pid !== entry.proc.pid) sendSignal(row, "SIGCONT");
      await Bun.sleep(150);
      const remaining = processTable();
      for (const row of remaining) if (entry.tty && row.tty === entry.tty) targets.set(row.pid, row);
      for (let previous = -1; previous !== targets.size; ) {
        previous = targets.size;
        for (const row of remaining) if (targets.has(row.ppid)) targets.set(row.pid, row);
      }
      for (const row of remaining)
        if (row.pid !== entry.proc.pid && targets.get(row.pid)?.identity === row.identity) sendSignal(row, "SIGKILL");
      const shell = remaining.find((row) => row.pid === entry.proc.pid);
      if (shell && targets.get(shell.pid)?.identity === shell.identity) sendSignal(shell, "SIGKILL");
      entry.pty.close();
    })();
    return entry.stopping;
  }
}
