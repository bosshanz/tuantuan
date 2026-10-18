import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseUpdater, MacUpdater } from "../desktop/node_modules/electron-updater";
import { updatePolicy } from "../desktop/src/update-policy";
import { LaunchAwareNsisUpdater, NativeMacUpdateAdapter } from "../desktop/src/updater-adapter";
import { DesktopUpdates, newerRelease } from "../desktop/src/updates";

class Adapter extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checks = 0;
  downloads = 0;
  installs = 0;
  failure = false;
  async checkForUpdates() {
    this.checks++;
    return { updateInfo: { version: "0.3.0", releaseNotes: "An update" } };
  }
  async downloadUpdate() {
    this.downloads++;
    this.emit("download-progress", { percent: 30 });
    if (this.failure) throw new Error("offline");
    this.emit("update-downloaded");
    return [];
  }
  quitAndInstall() {
    this.installs++;
    if (this.failure) this.emit("error", new Error("installer failed"));
  }
}
const roots: string[] = [];
const managers: DesktopUpdates[] = [];
const restorers: (() => void)[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const restore of restorers.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(extra: Partial<ConstructorParameters<typeof DesktopUpdates>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "tuantuan-updates-"));
  roots.push(root);
  const updater = new Adapter();
  let active = 0;
  let locked = false;
  let saves = 0;
  let resumes = 0;
  const manager = new DesktopUpdates({
    version: "0.2.0",
    mode: "automatic",
    settingsPath: join(root, "settings.json"),
    updater,
    activity: async () => ({ activeTasks: active, prepared: locked }),
    prepare: async () => {
      if (active) throw new Error("Agent 任务仍在运行");
      locked = true;
      return { activeTasks: 0, prepared: true };
    },
    resume: async () => {
      resumes++;
      locked = false;
    },
    checkpoint: async () => {
      saves++;
    },
    changed: () => {},
    ...extra,
  });
  managers.push(manager);
  return {
    manager,
    updater,
    root,
    busy: () => {
      active = 1;
    },
    idle: () => {
      active = 0;
    },
    get locked() {
      return locked;
    },
    get saves() {
      return saves;
    },
    get resumes() {
      return resumes;
    },
  };
}
async function ready(manager: DesktopUpdates) {
  await manager.check();
  await manager.download();
}

test("a downloaded event cannot permit installation before cache finalization, and failure remains retryable", async () => {
  const ctx = setup();
  let finish!: () => void;
  const cache = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const download = spyOn(ctx.updater, "downloadUpdate").mockImplementationOnce(async () => {
    ctx.updater.emit("update-downloaded");
    await cache;
    const error = new Error("EACCES: current.blockmap");
    ctx.updater.emit("error", error);
    throw error;
  });
  restorers.push(() => download.mockRestore());
  await ctx.manager.check();
  const pending = ctx.manager.download();
  expect(ctx.manager.status().phase).toBe("downloading");
  await ctx.manager.install();
  expect(ctx.saves).toBe(0);
  expect(ctx.updater.installs).toBe(0);
  finish();
  await pending;
  expect(ctx.manager.status().phase).toBe("error");
  expect(ctx.manager.status().error).toContain("current.blockmap");
  await ctx.manager.check();
  await ctx.manager.download();
  expect(download).toHaveBeenCalledTimes(2);
  expect(ctx.manager.status().phase).toBe("ready");
  await ctx.manager.install();
  expect(ctx.updater.installs).toBe(1);
});

test("a late SDK error after a completed download preserves an actionable ready state", async () => {
  const ctx = setup();
  await ready(ctx.manager);
  ctx.updater.emit("error", new Error("late SDK error"));
  expect(ctx.manager.status().phase).toBe("ready");
  expect(ctx.manager.status().error).toContain("late SDK error");
  await ctx.manager.install();
  expect(ctx.updater.installs).toBe(1);
});

test("a download never installs, including a normal app exit; only explicit idle installation does", async () => {
  const ctx = setup();
  expect(ctx.updater.autoDownload).toBe(false);
  expect(ctx.updater.autoInstallOnAppQuit).toBe(false);
  expect(ctx.updater.allowPrerelease).toBe(false);
  expect(ctx.updater.allowDowngrade).toBe(false);
  ctx.busy();
  await ready(ctx.manager);
  expect(ctx.manager.status().phase).toBe("ready");
  expect(ctx.updater.installs).toBe(0);
  ctx.idle();
  await ctx.manager.install();
  expect(ctx.saves).toBe(1);
  expect(ctx.locked).toBe(true);
  expect(ctx.updater.installs).toBe(1);
});

test("task starting after the UI observed idle blocks installation; settling tasks does not auto-install", async () => {
  const ctx = setup();
  await ready(ctx.manager);
  await ctx.manager.refreshActivity();
  expect(ctx.manager.status().activity).toBe("idle");
  ctx.busy();
  await ctx.manager.install();
  expect(ctx.updater.installs).toBe(0);
  expect(ctx.locked).toBe(false);
  expect(ctx.manager.status().error).toContain("Agent");
  ctx.idle();
  await ctx.manager.refreshActivity();
  expect(ctx.updater.installs).toBe(0);
  await ctx.manager.install();
  expect(ctx.updater.installs).toBe(1);
});

test("unsaved work or unavailable authoritative state rejects restart", async () => {
  const save = setup({
    checkpoint: async () => {
      throw new Error("draft quota");
    },
  });
  await ready(save.manager);
  await save.manager.install();
  expect(save.updater.installs).toBe(0);
  expect(save.manager.status().error).toContain("draft quota");
  const offline = setup({
    activity: async () => {
      throw new Error("offline");
    },
    prepare: async () => {
      throw new Error("offline");
    },
  });
  await ready(offline.manager);
  await offline.manager.refreshActivity();
  expect(offline.manager.status().activity).toBe("unknown");
  await offline.manager.install();
  expect(offline.updater.installs).toBe(0);
  expect(offline.resumes).toBe(1);
});

test("duplicate clicks share one install and preserve the checkpoint-before-lock order", async () => {
  const steps: string[] = [];
  let resolve!: () => void;
  const saving = new Promise<void>((done) => {
    resolve = done;
  });
  const ctx = setup({
    checkpoint: async () => {
      steps.push("save");
      await saving;
    },
    prepare: async () => {
      steps.push("lock");
      return { activeTasks: 0, prepared: true };
    },
  });
  await ready(ctx.manager);
  const first = ctx.manager.install();
  const second = ctx.manager.install();
  expect(steps).toEqual(["save"]);
  expect(ctx.updater.installs).toBe(0);
  resolve();
  await Promise.all([first, second]);
  expect(steps).toEqual(["save", "lock"]);
  expect(ctx.updater.installs).toBe(1);
});

test("installer failure releases admission lock and allows a later explicit retry", async () => {
  const ctx = setup();
  await ready(ctx.manager);
  ctx.updater.failure = true;
  await ctx.manager.install();
  await Bun.sleep(0);
  expect(ctx.locked).toBe(false);
  expect(ctx.manager.status().phase).toBe("ready");
  expect(ctx.manager.status().error).toContain("installer failed");
  ctx.updater.failure = false;
  await ctx.manager.install();
  expect(ctx.updater.installs).toBe(2);
});

test("download failure can be retried without installing or losing the candidate", async () => {
  const ctx = setup();
  await ctx.manager.check();
  ctx.updater.failure = true;
  await ctx.manager.download();
  expect(ctx.manager.status().phase).toBe("error");
  ctx.updater.failure = false;
  await ctx.manager.download();
  expect(ctx.manager.status().phase).toBe("ready");
  expect(ctx.updater.installs).toBe(0);
});

test("manual channels only check stable releases; never use the installer", async () => {
  const ctx = setup({
    mode: "manual",
    reason: "homebrew",
    latestRelease: async () => ({ version: "0.3.0", notes: "notes" }),
  });
  await ready(ctx.manager);
  await ctx.manager.install();
  expect(ctx.manager.status()).toMatchObject({ phase: "available", availableVersion: "0.3.0" });
  expect(ctx.updater.checks + ctx.updater.downloads + ctx.updater.installs).toBe(0);
  expect(ctx.manager.status().releaseUrl).toBe("https://github.com/bosshanz/tuantuan/releases/tag/v0.3.0");
});

test("automatic check preference preserves other settings and disables scheduled network activity", async () => {
  const ctx = setup({ initialCheckMs: 5, checkIntervalMs: 10 });
  writeFileSync(join(ctx.root, "settings.json"), JSON.stringify({ keepAwakeDuringTasks: true }));
  ctx.manager.setChecks(false);
  ctx.manager.start();
  await Bun.sleep(30);
  expect(ctx.updater.checks).toBe(0);
  expect(JSON.parse(readFileSync(join(ctx.root, "settings.json"), "utf8"))).toEqual({
    keepAwakeDuringTasks: true,
    automaticUpdateChecks: false,
  });
  await ctx.manager.check();
  expect(ctx.updater.checks).toBe(1);
});

test("the policy preserves package-manager ownership and fails closed for unsigned macOS", () => {
  const base = {
    packaged: true,
    disabled: false,
    platform: "darwin",
    homebrew: false,
    signedMac: true,
    feed: true,
    appImage: false,
  };
  expect(updatePolicy(base).mode).toBe("automatic");
  expect(updatePolicy({ ...base, signedMac: false }).reason).toBe("unsigned-mac");
  expect(updatePolicy({ ...base, homebrew: true }).reason).toBe("homebrew");
  expect(updatePolicy({ ...base, packaged: false }).reason).toBe("development");
  expect(updatePolicy({ ...base, disabled: true }).mode).toBe("disabled");
  expect(updatePolicy({ ...base, platform: "linux" }).mode).toBe("manual");
  expect(updatePolicy({ ...base, platform: "linux", appImage: true }).mode).toBe("automatic");
});

test("version selection excludes prereleases, equal versions and downgrades", () => {
  expect(newerRelease("0.3.0", "0.2.0")).toBe(true);
  expect(newerRelease("0.2.0", "0.2.0")).toBe(false);
  expect(newerRelease("0.1.0", "0.2.0")).toBe(false);
  expect(newerRelease("0.3.0-beta.1", "0.2.0")).toBe(false);
  expect(newerRelease("0.3.0", "0.3.0-beta.1")).toBe(true);
});

test("failed cleanup is retried as admission recovery, never as an automatic install", async () => {
  let prepared = false;
  let offline = true;
  const ctx = setup({
    activity: async () => ({ activeTasks: 0, prepared }),
    prepare: async () => {
      prepared = true;
      throw new Error("response lost");
    },
    resume: async () => {
      if (offline) throw new Error("offline");
      prepared = false;
    },
  });
  await ready(ctx.manager);
  await ctx.manager.install();
  expect(prepared).toBe(true);
  expect(ctx.updater.installs).toBe(0);
  offline = false;
  await ctx.manager.refreshActivity();
  expect(prepared).toBe(false);
  expect(ctx.manager.status().activity).toBe("idle");
  expect(ctx.manager.status().phase).toBe("ready");
  expect(ctx.updater.installs).toBe(0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function windowsSdk(options: { requiresAdmin?: boolean; packageFile?: string } = {}) {
  let quits = 0;
  const native = new EventEmitter();
  const application = {
    version: "0.2.0",
    name: "Tuantuan",
    isPackaged: true,
    appUpdateConfigPath: "unused.yml",
    userDataPath: tmpdir(),
    baseCachePath: tmpdir(),
    whenReady: async () => {},
    relaunch() {},
    onQuit() {},
    quit() {
      quits++;
    },
  };
  class DownloadedNsis extends LaunchAwareNsisUpdater {
    constructor() {
      super(native, undefined, application);
      this.logger = null;
      // Download/verification is outside this installation regression; run the real SDK install/doInstall.
      this.downloadedUpdateHelper = {
        file: "verified-installer.exe",
        packageFile: options.packageFile ?? null,
        downloadedFileInfo: { isAdminRightsRequired: options.requiresAdmin ?? false },
      } as NonNullable<typeof this.downloadedUpdateHelper>;
    }
  }
  const updater = new DownloadedNsis();
  const info = {
    version: "0.3.0",
    files: [],
    releaseDate: "2026-10-18T00:00:00Z",
    path: "installer.exe",
    sha512: "fixture",
  };
  spyOn(updater, "checkForUpdates").mockResolvedValue({ updateInfo: info, versionInfo: info, isUpdateAvailable: true });
  spyOn(updater, "downloadUpdate").mockImplementation(async () => {
    updater.emit("update-downloaded", { ...info, downloadedFile: "verified-installer.exe" });
    return ["verified-installer.exe"];
  });
  // Replace the OS spawn boundary, keeping the installed electron-updater's NSIS/fallback methods real.
  const base = BaseUpdater.prototype as unknown as {
    spawnLog(command: string, args?: string[], env?: unknown, stdio?: unknown): Promise<boolean>;
  };
  const launch = spyOn(base, "spawnLog");
  restorers.push(() => launch.mockRestore());
  const previousResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: tmpdir() });
  restorers.push(() => {
    if (previousResources) Object.defineProperty(process, "resourcesPath", previousResources);
    else Reflect.deleteProperty(process, "resourcesPath");
  });
  return {
    updater,
    native,
    launch,
    get quits() {
      return quits;
    },
  };
}

test("real NSIS asynchronous launch failure never schedules app.quit, and explicit retry still works", async () => {
  const sdk = windowsSdk();
  const pending = deferred<boolean>();
  sdk.launch.mockReturnValueOnce(pending.promise);
  const ctx = setup({ updater: sdk.updater });
  await ready(ctx.manager);
  const installing = ctx.manager.install();
  await Bun.sleep(0);
  expect(sdk.quits).toBe(0);
  expect(ctx.locked).toBe(true);
  pending.reject(Object.assign(new Error("installer blocked"), { code: "EPERM" }));
  await installing;
  await Bun.sleep(0);
  expect(sdk.quits).toBe(0);
  expect(ctx.locked).toBe(false);
  expect(ctx.manager.canQuitForUpdate()).toBe(false);
  expect(ctx.manager.status()).toMatchObject({ phase: "ready", error: "installer blocked" });
  sdk.launch.mockResolvedValueOnce(true);
  await ctx.manager.install();
  expect(sdk.quits).toBe(1);
  expect(ctx.locked).toBe(true);
});

test("real NSIS elevation fallback must launch before quitting and preserves interactive restart arguments", async () => {
  const sdk = windowsSdk();
  const elevation = deferred<boolean>();
  sdk.launch
    .mockRejectedValueOnce(Object.assign(new Error("elevation required"), { code: "EACCES" }))
    .mockReturnValueOnce(elevation.promise);
  const ctx = setup({ updater: sdk.updater });
  await ready(ctx.manager);
  const installing = ctx.manager.install();
  await Bun.sleep(0);
  expect(sdk.launch.mock.calls).toEqual([
    ["verified-installer.exe", ["--updated", "--force-run"], undefined, undefined],
    [join(tmpdir(), "elevate.exe"), ["verified-installer.exe", "--updated", "--force-run"], undefined, undefined],
  ]);
  expect(sdk.quits).toBe(0);
  expect(ctx.locked).toBe(true);
  elevation.resolve(true);
  await installing;
  expect(sdk.quits).toBe(1);
  expect(ctx.resumes).toBe(0);
});

test("real NSIS failed elevation and missing artifacts both recover without quit or shell fallback", async () => {
  for (const code of ["EPERM", "ENOENT"]) {
    const sdk = windowsSdk();
    sdk.launch
      .mockRejectedValueOnce(Object.assign(new Error("elevation required"), { code: "EACCES" }))
      .mockRejectedValueOnce(Object.assign(new Error("installer unavailable"), { code }));
    const ctx = setup({ updater: sdk.updater });
    await ready(ctx.manager);
    await ctx.manager.install();
    expect(sdk.quits).toBe(0);
    expect(ctx.locked).toBe(false);
    expect(ctx.manager.status().phase).toBe("ready");
    expect(ctx.manager.status().error).toContain("installer unavailable");
    expect(ctx.manager.canQuitForUpdate()).toBe(false);
    sdk.launch.mockRestore();
  }
  const sdk = windowsSdk();
  sdk.launch.mockRejectedValueOnce(Object.assign(new Error("missing artifact"), { code: "ENOENT" }));
  const ctx = setup({ updater: sdk.updater });
  await ready(ctx.manager);
  await ctx.manager.install();
  expect(sdk.quits).toBe(0);
  expect(ctx.locked).toBe(false);
  expect(ctx.manager.status().error).toContain("missing artifact");
});

test("NSIS declared elevation keeps install-directory and package arguments", async () => {
  const sdk = windowsSdk({ requiresAdmin: true, packageFile: "verified-package.7z" });
  sdk.updater.installDirectory = "C:\\Tuantuan";
  sdk.launch.mockResolvedValueOnce(true);
  const ctx = setup({ updater: sdk.updater });
  await ready(ctx.manager);
  await ctx.manager.install();
  expect(sdk.launch.mock.calls).toEqual([
    [
      join(tmpdir(), "elevate.exe"),
      ["verified-installer.exe", "--updated", "--force-run", "/D=C:\\Tuantuan", "--package-file=verified-package.7z"],
      undefined,
      undefined,
    ],
  ]);
  expect(sdk.quits).toBe(1);
});

test("repeated installer errors share admission recovery instead of unlocking a future attempt", async () => {
  const recovery = deferred<void>();
  let resumes = 0;
  const ctx = setup({
    activity: async () => ({ activeTasks: 0, prepared: false }),
    prepare: async () => ({ activeTasks: 0, prepared: true }),
    resume: async () => {
      resumes++;
      await recovery.promise;
    },
  });
  await ready(ctx.manager);
  ctx.updater.failure = true;
  const installing = ctx.manager.install();
  await Bun.sleep(0);
  ctx.updater.emit("error", new Error("another installer error"));
  ctx.updater.emit("error", new Error("one more installer error"));
  expect(resumes).toBe(1);
  expect(ctx.manager.canQuitForUpdate()).toBe(false);
  recovery.resolve();
  await installing;
  await Bun.sleep(0);
  expect(ctx.manager.status().phase).toBe("ready");
  expect(resumes).toBe(1);
});

test("an old installer launch cannot borrow a retry's checkpoint or newly granted quit permission", async () => {
  const sdk = windowsSdk();
  const oldLaunch = deferred<boolean>();
  const newLaunch = deferred<boolean>();
  const checkpoint = deferred<void>();
  let saves = 0;
  sdk.launch.mockReturnValueOnce(oldLaunch.promise).mockReturnValueOnce(newLaunch.promise);
  const ctx = setup({
    updater: sdk.updater,
    checkpoint: async () => {
      if (++saves > 1) await checkpoint.promise;
    },
  });
  await ready(ctx.manager);
  const first = ctx.manager.install();
  await Bun.sleep(0);
  sdk.updater.emit("error", new Error("installation cancelled"));
  await first;
  const retry = ctx.manager.install();
  expect(ctx.manager.canQuitForUpdate()).toBe(false);
  checkpoint.resolve();
  await Bun.sleep(0);
  expect(ctx.manager.canQuitForUpdate()).toBe(true);
  oldLaunch.resolve(true);
  await Bun.sleep(0);
  expect(sdk.quits).toBe(0);
  newLaunch.resolve(true);
  await retry;
  expect(sdk.quits).toBe(1);
});

function macSdk() {
  let checks = 0;
  let quits = 0;
  const native = Object.assign(new EventEmitter(), {
    checkForUpdates() {
      checks++;
    },
    quitAndInstall() {
      native.emit("before-quit-for-update");
      quits++;
    },
  });
  const raw = Object.assign(new Adapter(), {
    nativeUpdater: native,
    squirrelDownloadedUpdate: false,
    autoRunAppAfterInstall: true,
    closeServerIfExists() {},
    handleUpdateDownloaded() {
      native.quitAndInstall();
    },
  });
  // Match MacUpdater's constructor forwarding; use its actual quitAndInstall implementation below.
  native.on("error", (error) => raw.emit("error", error));
  native.on("update-downloaded", () => {
    raw.squirrelDownloadedUpdate = true;
  });
  raw.quitAndInstall = MacUpdater.prototype.quitAndInstall.bind(raw as unknown as MacUpdater);
  const updater = new NativeMacUpdateAdapter(raw, native);
  return {
    updater,
    native,
    raw,
    get checks() {
      return checks;
    },
    get quits() {
      return quits;
    },
  };
}

test("mac native failure revokes the real SDK's late-download quit path until another explicit idle install", async () => {
  const sdk = macSdk();
  const unsafeQuit = spyOn(sdk.raw, "quitAndInstall");
  const ctx = setup({ updater: sdk.updater });
  await ready(ctx.manager);
  const installing = ctx.manager.install();
  await Bun.sleep(0);
  expect(sdk.checks).toBe(1);
  sdk.native.emit("error", new Error("native download failed"));
  // The previous callback must already be inert even before promise cleanup gets its microtask.
  sdk.native.emit("update-downloaded");
  await installing;
  ctx.busy();
  sdk.native.emit("update-downloaded");
  expect(sdk.quits).toBe(0);
  expect(ctx.locked).toBe(false);
  expect(ctx.manager.canQuitForUpdate()).toBe(false);
  expect(unsafeQuit).not.toHaveBeenCalled();
  expect(sdk.native.listenerCount("update-downloaded")).toBe(2);
  await ctx.manager.install();
  expect(sdk.quits).toBe(0);
  ctx.idle();
  await ctx.manager.install();
  expect(sdk.quits).toBe(1);
  expect(sdk.checks).toBe(1);
  expect(ctx.locked).toBe(true);
});

test("mac native completion waits for the fresh checkpoint and lock, and disposal cancels pending callbacks", async () => {
  const sdk = macSdk();
  const checkpoint = deferred<void>();
  const prepare = deferred<{ activeTasks: number; prepared: boolean }>();
  const ctx = setup({ updater: sdk.updater, checkpoint: () => checkpoint.promise, prepare: () => prepare.promise });
  await ready(ctx.manager);
  const installing = ctx.manager.install();
  sdk.native.emit("update-downloaded");
  expect(ctx.manager.canQuitForUpdate()).toBe(false);
  expect(sdk.quits).toBe(0);
  checkpoint.resolve();
  await Bun.sleep(0);
  expect(ctx.manager.canQuitForUpdate()).toBe(false);
  prepare.resolve({ activeTasks: 0, prepared: true });
  await installing;
  expect(sdk.quits).toBe(1);
  expect(ctx.manager.canQuitForUpdate()).toBe(true);

  const pending = macSdk();
  const other = setup({ updater: pending.updater });
  await ready(other.manager);
  const aborted = other.manager.install();
  await Bun.sleep(0);
  other.manager.dispose();
  pending.native.emit("update-downloaded");
  await aborted;
  expect(pending.quits).toBe(0);
  expect(other.manager.canQuitForUpdate()).toBe(false);
});
