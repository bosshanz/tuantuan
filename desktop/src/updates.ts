import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DesktopUpdateStatus } from "../../shared/desktopUpdate";

export interface UpdateInfo {
  version: string;
  releaseNotes?: string | { note: string | null; version: string }[] | null;
}
export interface UpdateAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<{ updateInfo: UpdateInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void | Promise<void>;
  cancelInstall?(): void;
  dispose?(): void;
}
export interface UpdateActivity {
  activeTasks: number;
  prepared: boolean;
}
interface UpdateOptions {
  version: string;
  mode: DesktopUpdateStatus["mode"];
  reason?: DesktopUpdateStatus["reason"];
  settingsPath: string;
  updater?: UpdateAdapter;
  activity(): Promise<UpdateActivity>;
  prepare(): Promise<UpdateActivity>;
  resume(): Promise<unknown>;
  checkpoint(): Promise<void>;
  changed(status: DesktopUpdateStatus): void;
  latestRelease?: () => Promise<{ version: string; notes: string }>;
  initialCheckMs?: number;
  checkIntervalMs?: number;
  activityIntervalMs?: number;
}
const RELEASES = "https://github.com/bosshanz/tuantuan/releases";

/** Stable releases only; prerelease channels and downgrades are intentionally excluded. */
export function newerRelease(candidate: string, current: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/.exec(v)?.slice(1, 4).map(Number);
  const a = parse(candidate);
  const b = parse(current.split("-")[0] ?? current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return current.includes("-");
}

export async function latestStableRelease(): Promise<{ version: string; notes: string }> {
  const response = await fetch("https://api.github.com/repos/bosshanz/tuantuan/releases/latest", {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`无法检查更新（HTTP ${response.status}）`);
  const value = await response.json();
  if (value.draft || value.prerelease || !/^v?\d+\.\d+\.\d+$/.test(value.tag_name)) throw new Error("更新版本信息无效");
  return { version: value.tag_name.replace(/^v/, ""), notes: String(value.body ?? "").slice(0, 30_000) };
}

/** One owner for checking, downloading and explicit installation. No timer ever installs. */
export class DesktopUpdates {
  private value: DesktopUpdateStatus;
  private listeners: [string, (...args: unknown[]) => void][] = [];
  private checkTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private activityTimer?: ReturnType<typeof setInterval>;
  private checking?: Promise<DesktopUpdateStatus>;
  private downloading?: Promise<DesktopUpdateStatus>;
  private installing?: Promise<DesktopUpdateStatus>;
  private polling = false;
  private recovering = false;
  private needsResume = false;
  private disposed = false;
  private ready = false;
  private installEpoch = 0;
  private updateQuitAllowed = false;

  constructor(private readonly options: UpdateOptions) {
    let settings: Record<string, unknown> = {};
    let settingsError: string | undefined;
    try {
      settings = this.readSettings();
    } catch {
      settingsError = "无法读取更新设置，请修复设置文件后重试";
    }
    this.value = {
      version: options.version,
      mode: options.mode,
      reason: options.reason,
      phase: "idle",
      automaticChecks: !settingsError && settings.automaticUpdateChecks !== false,
      error: settingsError,
      activity: "unknown",
      activeTasks: 0,
    };
    const updater = options.updater;
    if (updater) {
      // Set before any download: BaseUpdater otherwise registers an install-on-quit listener.
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      this.listen("download-progress", (value: unknown) => {
        const progress = value as { percent: number };
        if (!progress || !Number.isFinite(progress.percent)) return;
        if (this.value.phase === "downloading") this.patch({ progress: Math.max(0, Math.min(100, progress.percent)) });
      });
      this.listen("error", (value: unknown) => {
        const error = value instanceof Error ? value : new Error(String(value));
        if (this.value.phase === "installing") {
          ++this.installEpoch;
          this.updateQuitAllowed = false;
          updater.cancelInstall?.();
          void this.releaseAfterFailure(error);
        } else this.patch({ phase: this.ready ? "ready" : "error", error: error.message });
      });
    }
  }

  status(): DesktopUpdateStatus {
    return { ...this.value };
  }

  /** The native updater may close windows before Electron emits app.before-quit. */
  canQuitForUpdate(): boolean {
    return this.updateQuitAllowed && !this.disposed && this.value.phase === "installing";
  }

  start() {
    if (this.disposed || this.activityTimer) return;
    void this.refreshActivity();
    this.activityTimer = setInterval(() => void this.refreshActivity(), this.options.activityIntervalMs ?? 5_000);
    this.activityTimer.unref?.();
    this.scheduleChecks();
  }

  dispose() {
    ++this.installEpoch;
    this.updateQuitAllowed = false;
    this.options.updater?.cancelInstall?.();
    this.options.updater?.dispose?.();
    this.disposed = true;
    clearTimeout(this.checkTimer);
    clearInterval(this.interval);
    clearInterval(this.activityTimer);
    for (const [event, listener] of this.listeners) this.options.updater?.removeListener(event, listener);
    this.listeners = [];
  }

  setChecks(enabled: boolean) {
    const path = this.options.settingsPath;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ ...this.readSettings(), automaticUpdateChecks: enabled }));
    renameSync(`${path}.tmp`, path);
    this.patch({ automaticChecks: enabled });
    this.scheduleChecks();
    return this.status();
  }

  async refreshActivity() {
    if (this.polling || this.recovering || this.disposed || this.value.phase === "installing") return;
    this.polling = true;
    try {
      let activity = await this.options.activity();
      if (this.status().phase === "installing") return;
      // A failed/timed-out prepare can leave a lock behind. Recover admission, never install.
      if (activity.prepared || this.needsResume) {
        this.recovering = true;
        this.needsResume = true;
        this.patch({ activity: "unknown" });
        try {
          await this.options.resume();
          this.needsResume = false;
          activity = await this.options.activity();
          if (this.ready) this.patch({ phase: "ready" });
        } finally {
          this.recovering = false;
        }
      }
      if (this.status().phase !== "installing")
        this.patch({
          activity: activity.activeTasks > 0 ? "busy" : activity.prepared ? "unknown" : "idle",
          activeTasks: activity.activeTasks,
        });
    } catch {
      this.patch({ activity: "unknown" });
    } finally {
      this.polling = false;
    }
  }

  check(): Promise<DesktopUpdateStatus> {
    if (this.checking) return this.checking;
    if (this.value.mode === "disabled" || ["downloading", "ready", "installing"].includes(this.value.phase))
      return Promise.resolve(this.status());
    this.checking = this.doCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async doCheck() {
    this.patch({ phase: "checking", error: undefined });
    try {
      let version: string;
      let notes: string;
      if (this.value.mode === "automatic" && this.options.updater) {
        const result = await this.options.updater.checkForUpdates();
        if (!result) throw new Error("无法读取更新信息");
        version = result.updateInfo.version;
        const value = result.updateInfo.releaseNotes;
        notes = typeof value === "string" ? value : (value ?? []).map((entry) => entry.note ?? "").join("\n\n");
      } else {
        ({ version, notes } = await (this.options.latestRelease ?? latestStableRelease)());
      }
      const available = newerRelease(version, this.options.version);
      this.patch({
        phase: available ? "available" : "idle",
        availableVersion: available ? version : undefined,
        releaseNotes: available ? notes.slice(0, 30_000) : undefined,
        releaseUrl: available ? `${RELEASES}/tag/v${encodeURIComponent(version.replace(/^v/, ""))}` : undefined,
        checkedAt: Date.now(),
        progress: undefined,
        error: undefined,
      });
    } catch (error) {
      this.patch({ phase: "error", error: (error as Error).message });
    }
    return this.status();
  }

  download(): Promise<DesktopUpdateStatus> {
    if (this.downloading) return this.downloading;
    if (
      this.value.mode !== "automatic" ||
      !this.value.availableVersion ||
      !this.options.updater ||
      this.ready ||
      !["available", "error"].includes(this.value.phase)
    )
      return Promise.resolve(this.status());
    this.downloading = this.doDownload().finally(() => {
      this.downloading = undefined;
    });
    return this.downloading;
  }

  private async doDownload() {
    this.patch({ phase: "downloading", progress: 0, error: undefined });
    try {
      if (!this.options.updater) throw new Error("当前安装方式不支持自动更新");
      await this.options.updater.downloadUpdate();
      if (this.disposed) return this.status();
      // The SDK emits update-downloaded before asynchronous cache finalization can still fail.
      this.ready = true;
      this.patch({ phase: "ready", progress: 100, error: undefined });
    } catch (error) {
      this.ready = false;
      this.patch({ phase: "error", error: (error as Error).message });
    }
    return this.status();
  }

  install(): Promise<DesktopUpdateStatus> {
    if (this.installing) return this.installing;
    if (
      this.recovering ||
      this.needsResume ||
      !this.ready ||
      this.value.mode !== "automatic" ||
      !this.options.updater ||
      this.value.phase === "installing"
    )
      return Promise.resolve(this.status());
    this.installing = this.doInstall().finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }

  private async doInstall() {
    const epoch = ++this.installEpoch;
    this.updateQuitAllowed = false;
    this.patch({ phase: "installing", error: undefined });
    try {
      // Saving can take time. Acquire the server lock AFTER it, checking the real state afresh.
      await this.options.checkpoint();
      if (epoch !== this.installEpoch) return this.status();
      const activity = await this.options.prepare();
      if (!activity.prepared || activity.activeTasks !== 0) throw new Error("Agent 任务仍在运行，请结束后再更新");
      if (epoch !== this.installEpoch) {
        await this.options.resume();
        return this.status();
      }
      this.patch({ activity: "idle", activeTasks: 0 });
      if (!this.options.updater) throw new Error("当前安装方式不支持自动更新");
      this.updateQuitAllowed = true;
      await this.options.updater.quitAndInstall(false, true);
    } catch (error) {
      if (epoch === this.installEpoch) {
        ++this.installEpoch;
        this.updateQuitAllowed = false;
        this.options.updater?.cancelInstall?.();
        await this.releaseAfterFailure(error as Error);
      }
    }
    return this.status();
  }

  private async releaseAfterFailure(error: Error) {
    if (this.recovering) return;
    this.recovering = true;
    this.needsResume = true;
    try {
      await this.options.resume();
      this.needsResume = false;
    } catch (resumeError) {
      this.patch({
        phase: "error",
        activity: "unknown",
        error: `${error.message}；无法恢复任务接收：${(resumeError as Error).message}`,
      });
      return;
    } finally {
      this.recovering = false;
    }
    this.patch({ phase: this.ready ? "ready" : "error", error: error.message });
    void this.refreshActivity();
  }

  private listen(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.push([event, listener]);
    this.options.updater?.on(event, listener);
  }
  private patch(value: Partial<DesktopUpdateStatus>) {
    if (this.disposed) return;
    this.value = { ...this.value, ...value };
    this.options.changed(this.status());
  }
  private readSettings(): Record<string, unknown> {
    try {
      const value = JSON.parse(readFileSync(this.options.settingsPath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private scheduleChecks() {
    clearTimeout(this.checkTimer);
    clearInterval(this.interval);
    if (this.disposed || !this.value.automaticChecks || this.value.mode === "disabled") return;
    this.checkTimer = setTimeout(() => void this.check(), this.options.initialCheckMs ?? 30_000);
    this.interval = setInterval(() => void this.check(), this.options.checkIntervalMs ?? 6 * 60 * 60_000);
    this.checkTimer.unref?.();
    this.interval.unref?.();
  }
}
