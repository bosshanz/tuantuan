import type { StdioOptions } from "node:child_process";
import { MacUpdater, NsisUpdater } from "electron-updater";
import { type AppImageRelaunchOptions, SafeAppImageUpdater } from "./appimage-update";
import type { UpdateAdapter } from "./updates";

export interface NativeUpdateAdapter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): boolean;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

function installAttempt() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
type InstallAttempt = ReturnType<typeof installAttempt>;
const cancelled = () => new DOMException("更新安装已取消", "AbortError");

/** Keep NSIS's verified installer, arguments and elevation fallback, but own the quit boundary. */
export class LaunchAwareNsisUpdater extends NsisUpdater {
  private attempt?: InstallAttempt;

  constructor(
    private readonly native: Pick<NativeUpdateAdapter, "emit">,
    options?: ConstructorParameters<typeof NsisUpdater>[0],
    application?: ConstructorParameters<typeof NsisUpdater>[1],
  ) {
    super(options, application);
  }

  override async quitAndInstall(isSilent = false, isForceRunAfter = false): Promise<void> {
    if (this.attempt) return this.attempt.promise;
    const attempt = installAttempt();
    this.attempt = attempt;
    const failed = (error: Error) => attempt.reject(error);
    this.on("error", failed);
    try {
      if (!this.install(isSilent, isForceRunAfter)) attempt.reject(new Error("无法启动更新安装器"));
      await attempt.promise;
      if (this.attempt !== attempt) throw cancelled();
      this.native.emit("before-quit-for-update");
      this.app.quit();
    } finally {
      this.removeListener("error", failed);
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }

  cancelInstall() {
    const attempt = this.attempt;
    this.attempt = undefined;
    if (attempt) {
      this.quitAndInstallCalled = false;
      attempt.reject(cancelled());
    }
  }

  protected override async spawnLog(
    cmd: string,
    args?: string[],
    env?: unknown,
    stdio?: StdioOptions,
  ): Promise<boolean> {
    const attempt = this.attempt;
    try {
      const started = await super.spawnLog(cmd, args, env, stdio);
      if (started && this.attempt === attempt) attempt?.resolve();
      return started;
    } catch (error) {
      // SDK's ENOENT shell.openPath fallback resolves an error string without reporting failure.
      // A missing verified artifact cannot be installed; fail through its normal final-error path.
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(`无法启动更新安装器：${(error as Error).message}`, { cause: error });
      throw error;
    }
  }
}

/** MacUpdater serves its verified ZIP locally; only the public native updater stages and quits. */
export class NativeMacUpdateAdapter implements UpdateAdapter {
  private attempt?: InstallAttempt;
  private nativeReady = false;
  private readonly markReady = () => {
    this.nativeReady = true;
  };

  constructor(
    private readonly updater: UpdateAdapter,
    private readonly native: NativeUpdateAdapter,
  ) {
    native.on("update-downloaded", this.markReady);
  }

  get autoDownload() {
    return this.updater.autoDownload;
  }
  set autoDownload(value: boolean) {
    this.updater.autoDownload = value;
  }
  get autoInstallOnAppQuit() {
    return this.updater.autoInstallOnAppQuit;
  }
  set autoInstallOnAppQuit(value: boolean) {
    this.updater.autoInstallOnAppQuit = value;
  }
  get allowPrerelease() {
    return this.updater.allowPrerelease;
  }
  set allowPrerelease(value: boolean) {
    this.updater.allowPrerelease = value;
  }
  get allowDowngrade() {
    return this.updater.allowDowngrade;
  }
  set allowDowngrade(value: boolean) {
    this.updater.allowDowngrade = value;
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    return this.updater.on(event, listener);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void) {
    return this.updater.removeListener(event, listener);
  }
  checkForUpdates() {
    return this.updater.checkForUpdates();
  }
  downloadUpdate() {
    return this.updater.downloadUpdate();
  }

  async quitAndInstall(): Promise<void> {
    if (this.attempt) return this.attempt.promise;
    const attempt = installAttempt();
    this.attempt = attempt;
    const ready = () => {
      if (this.attempt === attempt) attempt.resolve();
    };
    const failed = (error: unknown) => attempt.reject(error instanceof Error ? error : new Error(String(error)));
    this.native.on("update-downloaded", ready);
    this.native.on("error", failed);
    try {
      if (this.nativeReady) attempt.resolve();
      else this.native.checkForUpdates();
      await attempt.promise;
      if (this.attempt !== attempt) throw cancelled();
      this.native.quitAndInstall();
    } finally {
      this.native.removeListener("update-downloaded", ready);
      this.native.removeListener("error", failed);
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }

  cancelInstall() {
    const attempt = this.attempt;
    this.attempt = undefined;
    attempt?.reject(cancelled());
  }

  dispose() {
    this.cancelInstall();
    this.native.removeListener("update-downloaded", this.markReady);
  }
}

export function createUpdateAdapter(options: {
  platform: NodeJS.Platform;
  nativeUpdater: NativeUpdateAdapter;
  relaunch?: (options: AppImageRelaunchOptions) => void;
}): UpdateAdapter {
  if (options.platform === "win32") return new LaunchAwareNsisUpdater(options.nativeUpdater);
  if (options.platform === "darwin") return new NativeMacUpdateAdapter(new MacUpdater(), options.nativeUpdater);
  return new SafeAppImageUpdater(options.nativeUpdater, options.relaunch);
}
