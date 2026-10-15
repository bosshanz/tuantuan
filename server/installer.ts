import type { InstallerSpec } from "./harness";

/**
 * One-click harness installs: runs a harness's own official install command in the background, only
 * when the user clicks it on the Harness page. Output is kept as a line log the page polls; the job
 * can be cancelled. Commands come from the registry only, never from the request.
 */
export type InstallState = "running" | "done" | "error" | "cancelled";

export interface InstallJob {
  harnessId: string;
  installerId: string;
  command: string;
  state: InstallState;
  /** Lines with ANSI codes and carriage-return progress collapsed. */
  log: string[];
  /** Total lines ever written (log keeps the last MAX_LINES). */
  lines: number;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

const MAX_LINES = 800;
const TIMEOUT_MS = 15 * 60_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal escape sequences
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export class Installer {
  private jobs = new Map<
    string,
    { job: InstallJob; proc: ReturnType<typeof Bun.spawn> | null; abort?: AbortController }
  >();

  constructor(private onFinish: (job: InstallJob) => void = () => {}) {}

  start(harnessId: string, spec: InstallerSpec, env: Record<string, string>): InstallJob {
    const cur = this.jobs.get(harnessId);
    if (cur?.job.state === "running") return cur.job;
    const command = spec.command.replaceAll("{bun}", process.execPath);
    const job: InstallJob = {
      harnessId,
      installerId: spec.id,
      command: spec.command.replaceAll('"{bun}"', "bun"),
      state: "running",
      log: [`$ ${spec.command.replaceAll('"{bun}"', "bun")}`],
      lines: 1,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    const shell = Bun.which("bash", { PATH: env.PATH ?? "" }) ?? "/bin/sh";
    const proc = Bun.spawn([shell, "-c", command], {
      cwd: env.HOME || undefined,
      env: { ...env, NONINTERACTIVE: "1", CI: "1", npm_config_yes: "true", TERM: "dumb" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const entry = { job, proc: proc as ReturnType<typeof Bun.spawn> | null };
    this.jobs.set(harnessId, entry);
    const timer = setTimeout(() => this.stop(harnessId, "error", "安装超时（15 分钟）"), TIMEOUT_MS);
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream) {
        buf += dec.decode(chunk, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const l of parts) this.push(job, l);
      }
      if (buf) this.push(job, buf);
    };
    void Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(async () => {
      const code = await proc.exited;
      clearTimeout(timer);
      if (job.state !== "running") return;
      job.state = code === 0 ? "done" : "error";
      if (code !== 0) job.error = lastMeaningful(job.log) ?? `退出码 ${code}`;
      job.endedAt = Date.now();
      entry.proc = null;
      this.onFinish(job);
    });
    return job;
  }

  /**
   * Same job tracking for an in-process install (registry downloads): `task` gets a line logger and
   * an abort signal; cancelling aborts it.
   */
  startTask(
    harnessId: string,
    installerId: string,
    label: string,
    task: (log: (line: string) => void, signal: AbortSignal) => Promise<void>,
  ): InstallJob {
    const cur = this.jobs.get(harnessId);
    if (cur?.job.state === "running") return cur.job;
    const job: InstallJob = {
      harnessId,
      installerId,
      command: label,
      state: "running",
      log: [label],
      lines: 1,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    const ac = new AbortController();
    const entry = { job, proc: null as ReturnType<typeof Bun.spawn> | null, abort: ac };
    this.jobs.set(harnessId, entry);
    const timer = setTimeout(() => this.stop(harnessId, "error", "安装超时（15 分钟）"), TIMEOUT_MS);
    void task((l) => this.push(job, l), ac.signal).then(
      () => {
        clearTimeout(timer);
        if (job.state !== "running") return;
        job.state = "done";
        job.endedAt = Date.now();
        this.onFinish(job);
      },
      (e) => {
        clearTimeout(timer);
        if (job.state !== "running") return;
        job.state = "error";
        job.error = (e as Error).message;
        this.push(job, job.error);
        job.endedAt = Date.now();
        this.onFinish(job);
      },
    );
    return job;
  }

  /** The job, with only the log lines after `since` (total-line index). */
  get(harnessId: string, since = 0): (InstallJob & { from: number }) | null {
    const cur = this.jobs.get(harnessId);
    if (!cur) return null;
    const { job } = cur;
    const first = job.lines - job.log.length;
    const from = Math.max(since, first);
    return { ...job, log: job.log.slice(from - first), from };
  }

  cancel(harnessId: string): InstallJob | null {
    this.stop(harnessId, "cancelled", null);
    return this.jobs.get(harnessId)?.job ?? null;
  }

  shutdown() {
    for (const id of this.jobs.keys()) this.stop(id, "cancelled", null);
  }

  private stop(harnessId: string, state: InstallState, error: string | null) {
    const cur = this.jobs.get(harnessId);
    if (!cur || cur.job.state !== "running") return;
    const pid = cur.proc?.pid;
    // Stop the pipeline too (curl | bash), not just the shell.
    if (pid) Bun.spawnSync(["pkill", "-TERM", "-P", String(pid)], { stdout: "ignore", stderr: "ignore" });
    cur.proc?.kill();
    cur.proc = null;
    cur.abort?.abort();
    cur.job.state = state;
    cur.job.error = error;
    cur.job.endedAt = Date.now();
    this.push(cur.job, state === "cancelled" ? "已取消" : (error ?? ""));
    this.onFinish(cur.job);
  }

  private push(job: InstallJob, raw: string) {
    // Progress bars redraw with \r: keep only what the terminal would finally show.
    const line = (
      raw
        .split("\r")
        .filter((x) => x.trim())
        .pop() ?? ""
    )
      .replace(ANSI, "")
      .trimEnd();
    if (!line) return;
    job.log.push(line.slice(0, 500));
    job.lines += 1;
    if (job.log.length > MAX_LINES) job.log.splice(0, job.log.length - MAX_LINES);
  }
}

function lastMeaningful(log: string[]): string | null {
  for (let i = log.length - 1; i > 0; i--) {
    const l = log[i]?.trim();
    if (l && !l.startsWith("$ ")) return l.slice(0, 300);
  }
  return null;
}
