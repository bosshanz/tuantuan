import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  autoUpdater as nativeUpdater,
  powerSaveBlocker,
  shell,
  Tray,
} from "electron";
import { isLocale, type Locale, translate } from "../../shared/i18n";
import { completeAppImageUpdate } from "./appimage-update";
import { registerNotifications, registerOnFirstLaunch } from "./notify";
import { serverLayout } from "./paths";
import { TaskPowerManager } from "./power";
import { type RunningServer, startServer } from "./server";
import { loginShellEnv } from "./shell-env";
import { DesktopCheckpoint, UpdateCheckpointFile } from "./update-checkpoint";
import { hasMacUpdateIdentity, isHomebrewApp, updatePolicy } from "./update-policy";
import { DesktopUpdates, type UpdateActivity } from "./updates";

const isMac = process.platform === "darwin";
app.setName("团团");
if (process.env.TUANTUAN_USER_DATA) app.setPath("userData", process.env.TUANTUAN_USER_DATA);

let win: BrowserWindow | null = null;
let srv: RunningServer | null = null;
let tray: Tray | null = null;
let quitting = false;
let taskPower: TaskPowerManager | null = null;
let desktopUpdates: DesktopUpdates | null = null;
let checkpointFile: UpdateCheckpointFile | null = null;
let checkpoint: DesktopCheckpoint | null = null;
let quitInFlight: Promise<void> | null = null;
let updateQuitRequested = false;
let windowReady = false;
let rendererReady = false;
let locale: Locale = "zh-CN";
const t = (source: string, params?: Record<string, string | number>) => translate(locale, source, params);

function setLocale(value: unknown) {
  if (!isLocale(value) || value === locale) return;
  locale = value;
  app.setAboutPanelOptions({ applicationName: t("团团") });
  win?.setTitle(t("团团"));
  menu();
  updateTrayMenu();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => restore());
  void app.whenReady().then(boot);
}

function restore() {
  if (!win) return void createWindow();
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  app.focus({ steal: true });
  win.focus();
  // Keyboard focus back into the page (the composer / last focused field), not just the frame.
  win.webContents.focus();
}

const boundsFile = () => join(app.getPath("userData"), "window.json");
function savedBounds(): Electron.Rectangle | null {
  try {
    return JSON.parse(readFileSync(boundsFile(), "utf8"));
  } catch {
    return null;
  }
}

function icon() {
  const p = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "build", "icon.png");
  return existsSync(p) ? nativeImage.createFromPath(p) : undefined;
}

function acknowledgeAppImageUpdate() {
  if (process.platform !== "linux" || !windowReady || !rendererReady) return;
  try {
    completeAppImageUpdate({
      userDataPath: app.getPath("userData"),
      current: process.env.APPIMAGE,
      args: process.argv,
    });
  } catch (error) {
    console.error("AppImage update recovery files retained", error);
  }
}

function createWindow() {
  if (!srv) return;
  windowReady = false;
  rendererReady = false;
  const b = savedBounds();
  win = new BrowserWindow({
    width: b?.width ?? 1320,
    height: b?.height ?? 860,
    ...(b ? { x: b.x, y: b.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: t("团团"),
    show: false,
    backgroundColor: "#f7f6f3",
    icon: icon(),
    // macOS: no title bar; the web UI draws one 52px header row across all columns
    // (html[data-desktop="darwin"]). The 3 lights (≈52×12px) are centered in the 64px rail's top cell:
    // x = (64 − 52) / 2, y = (52 − 12) / 2.
    titleBarStyle: isMac ? "hidden" : "default",
    trafficLightPosition: isMac ? { x: 18, y: 20 } : undefined,
    webPreferences: {
      // (bun inlines __dirname at build time, so resolve from the app path)
      preload: join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => {
    windowReady = true;
    acknowledgeAppImageUpdate();
    win?.show();
    registerOnFirstLaunch(locale);
  });
  // Full screen hides the traffic lights: the UI drops the space it kept for them.
  const sendFullscreen = () => win?.webContents.send("tuantuan:fullscreen", win.isFullScreen());
  win.on("enter-full-screen", sendFullscreen);
  win.on("leave-full-screen", sendFullscreen);
  win.webContents.on("did-finish-load", sendFullscreen);
  win.on("close", (e) => {
    if (win) writeFileSync(boundsFile(), JSON.stringify(win.getNormalBounds()));
    if (updateQuitRequested && !desktopUpdates?.canQuitForUpdate()) {
      e.preventDefault();
      return;
    }
    // macOS keeps the app (and its agents) running with the window closed, like Mail.
    if (isMac && !quitting && !updateQuitRequested && !desktopUpdates?.canQuitForUpdate()) {
      e.preventDefault();
      win?.hide();
    } else if (!quitting && !updateQuitRequested && !desktopUpdates?.canQuitForUpdate()) {
      // Keep the last renderer alive until its cross-origin handoff has committed.
      e.preventDefault();
      app.quit();
    }
  });
  win.on("closed", () => {
    win = null;
  });
  // Links to other sites open in the browser; the app only ever shows its own server.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(srv?.url ?? "\0")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(srv?.url ?? "\0")) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  void win.loadURL(srv.url);
}

function menu() {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: t("团团"),
            submenu: [
              { role: "about", label: t("关于团团") },
              { type: "separator" },
              { role: "hide", label: t("隐藏团团") },
              { role: "hideOthers", label: t("隐藏其他") },
              { role: "unhide", label: t("全部显示") },
              { type: "separator" },
              { role: "quit", label: t("退出团团") },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t("编辑"),
      submenu: [
        { role: "undo", label: t("撤销") },
        { role: "redo", label: t("重做") },
        { type: "separator" },
        { role: "cut", label: t("剪切") },
        { role: "copy", label: t("复制") },
        { role: "paste", label: t("粘贴") },
        { role: "selectAll", label: t("全选") },
      ],
    },
    {
      label: t("显示"),
      submenu: [
        { role: "reload", label: t("重新加载") },
        { role: "toggleDevTools", label: t("开发者工具") },
        { type: "separator" },
        { role: "resetZoom", label: t("实际大小") },
        { role: "zoomIn", label: t("放大") },
        { role: "zoomOut", label: t("缩小") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("全屏") },
      ],
    },
    {
      label: t("窗口"),
      submenu: [
        { role: "minimize", label: t("最小化") },
        { role: "zoom", label: t("缩放") },
        ...(isMac ? ([{ type: "separator" }, { role: "front", label: t("前置全部窗口") }] as const) : []),
        ...(!isMac ? ([{ role: "quit", label: t("退出") }] as const) : []),
      ],
    },
    {
      label: t("帮助"),
      submenu: [
        { label: t("打开数据文件夹"), click: () => void shell.openPath(app.getPath("userData")) },
        { label: t("打开日志"), click: () => void shell.openPath(join(app.getPath("userData"), "logs")) },
        { label: t("项目主页"), click: () => void shell.openExternal("https://github.com/bosshanz/tuantuan") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trayIcon() {
  if (process.env.TUANTUAN_TRAY !== "1") return;
  const img = icon();
  if (!img) return;
  tray = new Tray(img.resize({ width: 18, height: 18 }));
  updateTrayMenu();
  tray.on("click", () => restore());
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(t("团团"));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("打开团团"), click: () => restore() },
      { type: "separator" },
      { label: t("退出"), click: () => app.quit() },
    ]),
  );
}

function trustedUpdateCaller(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!win || !srv || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
  try {
    return new URL(event.senderFrame.url).origin === srv.url;
  } catch {
    return false;
  }
}

async function updateActivity(action: "activity" | "prepare" | "resume"): Promise<UpdateActivity> {
  if (!srv || quitting) throw new Error("无法确认 Agent 任务状态");
  const response = await fetch(new URL(`/api/desktop/update-${action}`, srv.url), {
    method: action === "activity" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${srv.updateToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(typeof value.error === "string" ? value.error : `任务状态检查失败（HTTP ${response.status}）`);
  if (!Number.isSafeInteger(value.activeTasks) || value.activeTasks < 0 || typeof value.prepared !== "boolean")
    throw new Error("任务状态无效，尚未开始安装");
  return value;
}

async function updates() {
  checkpointFile = new UpdateCheckpointFile(join(app.getPath("userData"), "update-checkpoint.json"));
  const handoff = new DesktopCheckpoint(
    checkpointFile,
    (request) => {
      if (!win || win.isDestroyed()) throw new Error("请打开团团窗口后重试保存");
      win.webContents.send("tuantuan:update-prepare", request);
    },
    (state) => {
      if (win && !win.isDestroyed()) win.webContents.send("tuantuan:checkpoint-state", state);
    },
  );
  checkpoint = handoff;
  ipcMain.on("tuantuan:update-checkpoint", (event, reply) => {
    if (trustedUpdateCaller(event)) checkpoint?.reply(reply);
  });
  const policy = updatePolicy({
    packaged: app.isPackaged,
    disabled: process.env.TUANTUAN_AUTO_UPDATE === "0",
    platform: process.platform,
    homebrew: app.isPackaged && isMac && isHomebrewApp(process.execPath),
    signedMac: !isMac || (app.isPackaged && hasMacUpdateIdentity(process.execPath)),
    feed: existsSync(join(process.resourcesPath, "app-update.yml")),
    appImage: !!process.env.APPIMAGE,
  });
  const updater =
    policy.mode === "automatic"
      ? (await import("./updater-adapter")).createUpdateAdapter({
          platform: process.platform,
          nativeUpdater,
          relaunch: (options) => app.relaunch(options),
        })
      : undefined;
  desktopUpdates = new DesktopUpdates({
    version: app.getVersion(),
    ...policy,
    updater,
    settingsPath: join(app.getPath("userData"), "settings.json"),
    activity: () => updateActivity("activity"),
    prepare: () => updateActivity("prepare"),
    resume: () => updateActivity("resume"),
    checkpoint: () => handoff.request("update"),
    changed: (status) => {
      // Installation was abandoned: later user edits must not be replaced by a stale restart snapshot.
      if (status.phase !== "installing") {
        try {
          checkpoint?.abandonUpdate();
        } catch (error) {
          console.error("Could not remove abandoned update checkpoint", error);
        }
      }
      if (win && !win.isDestroyed()) win.webContents.send("tuantuan:update-state", status);
    },
  });
  const manager = desktopUpdates;
  const actions = {
    "tuantuan:update-status": () => {
      rendererReady = true;
      acknowledgeAppImageUpdate();
      return manager.status();
    },
    "tuantuan:update-checkpoint-save": (value: unknown, requestId: unknown) => {
      checkpoint?.save(value, requestId);
    },
    "tuantuan:update-checkpoint-read": () => checkpointFile?.read() ?? null,
    "tuantuan:update-checkpoint-clear": (id: unknown) => {
      checkpoint?.clear(id);
    },
    "tuantuan:update-check": () => manager.check(),
    "tuantuan:update-download": () => manager.download(),
    "tuantuan:update-install": () => {
      if (quitInFlight) throw new Error("团团正在保存工作并退出，请稍后重试");
      return manager.install();
    },
    "tuantuan:update-checks": (enabled: unknown) => {
      if (typeof enabled !== "boolean") throw new Error(t("设置值必须为布尔值"));
      return manager.setChecks(enabled);
    },
    "tuantuan:update-open-release": () =>
      shell.openExternal(manager.status().releaseUrl ?? "https://github.com/bosshanz/tuantuan/releases/latest"),
  };
  for (const [channel, action] of Object.entries(actions))
    ipcMain.handle(channel, (event, value: unknown, requestId: unknown) => {
      if (!trustedUpdateCaller(event)) throw new Error("更新操作仅允许团团窗口调用");
      return action(value, requestId);
    });
  manager.start();
}

async function boot() {
  menu();
  registerNotifications(() => win);
  // The renderer derives this from the server profile and its existing global socket.
  ipcMain.handle("tuantuan:set-locale", (_e, value: unknown) => setLocale(value));
  ipcMain.handle("tuantuan:pick-folder", async (e, o: { title?: string; start?: string }) => {
    const owner = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = {
      title: o?.title || t("选择文件夹"),
      message: o?.title,
      defaultPath: o?.start && existsSync(o.start) ? o.start : homedir(),
      properties: ["openDirectory", "createDirectory"],
    };
    const r = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return { cancelled: true };
    return { path: r.filePaths[0] };
  });
  const layout = serverLayout({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  try {
    const env = await loginShellEnv();
    srv = await startServer({
      layout,
      env,
      userData: app.getPath("userData"),
      logDir: join(app.getPath("userData"), "logs"),
    });
  } catch (e) {
    dialog.showErrorBox(
      t("团团无法启动"),
      `${(e as Error).message}\n\n${t("日志：{path}", { path: join(app.getPath("userData"), "logs") })}`,
    );
    app.exit(1);
    return;
  }
  srv.child.on("exit", () => {
    taskPower?.dispose();
    if (!quitting) {
      dialog.showErrorBox(
        t("团团的服务意外退出"),
        t("日志：{path}", { path: join(app.getPath("userData"), "logs", "server.log") }),
      );
      app.quit();
    }
  });
  try {
    const response = await fetch(new URL("/api/profile", srv.url), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const profile = (await response.json()) as { language?: unknown };
    if (!isLocale(profile.language)) throw new Error("Invalid profile language");
    setLocale(profile.language);
  } catch (error) {
    console.error("desktop profile language sync failed", error);
  }
  if (quitting || !srv) return;
  taskPower = new TaskPowerManager({
    blocker: powerSaveBlocker,
    settingsPath: join(app.getPath("userData"), "settings.json"),
    serverUrl: srv.url,
  });
  ipcMain.handle("tuantuan:task-power-status", () => taskPower?.status());
  ipcMain.handle("tuantuan:task-power-set", (_e, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error(t("设置值必须为布尔值"));
    try {
      return taskPower?.setEnabled(enabled);
    } catch (error) {
      if (error instanceof Error && error.message === "桌面版正在退出") throw new Error(t(error.message));
      throw error;
    }
  });
  if (process.env.TUANTUAN_DESKTOP_SMOKE) console.log(`TUANTUAN_SERVER_URL=${srv.url}`);
  await updates();
  createWindow();
  trayIcon();
  app.on("activate", () => restore());
}

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
// Native macOS updates close windows before emitting app.before-quit; NSIS uses the same marker.
nativeUpdater.on("before-quit-for-update", () => {
  updateQuitRequested = true;
});
app.on("before-quit", (e) => {
  if (updateQuitRequested && !desktopUpdates?.canQuitForUpdate()) {
    e.preventDefault();
    updateQuitRequested = false;
    return;
  }
  updateQuitRequested = false;
  if (!quitting && !desktopUpdates?.canQuitForUpdate() && win && !win.isDestroyed()) {
    e.preventDefault();
    // An explicit update already owns its checkpoint and install lock. Do not race it.
    if (desktopUpdates?.status().phase === "installing" || quitInFlight) return;
    quitInFlight = (async () => {
      for (;;) {
        try {
          if (!checkpoint) throw new Error("团团尚未准备好保存工作，请稍后重试");
          await checkpoint.request("quit");
          quitting = true;
          app.quit();
          return;
        } catch (error) {
          restore();
          const options: Electron.MessageBoxOptions = {
            type: "error",
            title: t("无法保存当前工作"),
            message: t("保存工作失败，退出已暂停。"),
            detail: t((error as Error).message),
            buttons: [t("重试"), t("继续编辑")],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          };
          const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
          if (result.response !== 0) return;
        }
      }
    })().finally(() => {
      quitInFlight = null;
    });
    return;
  }
  quitting = true;
  desktopUpdates?.dispose();
  taskPower?.dispose();
  if (srv && srv.child.exitCode === null) {
    e.preventDefault();
    const s = srv;
    srv = null;
    void s.stop().finally(() => app.quit());
  }
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.quit());
