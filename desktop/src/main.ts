import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  shell,
  Tray,
} from "electron";
import { registerNotifications } from "./notify";
import { serverLayout } from "./paths";
import { type RunningServer, startServer } from "./server";
import { loginShellEnv } from "./shell-env";

const isMac = process.platform === "darwin";
app.setName("团团");
if (process.env.TUANTUAN_USER_DATA) app.setPath("userData", process.env.TUANTUAN_USER_DATA);

let win: BrowserWindow | null = null;
let srv: RunningServer | null = null;
let tray: Tray | null = null;
let quitting = false;

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

function createWindow() {
  if (!srv) return;
  const b = savedBounds();
  win = new BrowserWindow({
    width: b?.width ?? 1320,
    height: b?.height ?? 860,
    ...(b ? { x: b.x, y: b.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: "团团",
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
  win.once("ready-to-show", () => win?.show());
  // Full screen hides the traffic lights: the UI drops the space it kept for them.
  const sendFullscreen = () => win?.webContents.send("tuantuan:fullscreen", win.isFullScreen());
  win.on("enter-full-screen", sendFullscreen);
  win.on("leave-full-screen", sendFullscreen);
  win.webContents.on("did-finish-load", sendFullscreen);
  win.on("close", (e) => {
    if (win) writeFileSync(boundsFile(), JSON.stringify(win.getNormalBounds()));
    // macOS keeps the app (and its agents) running with the window closed, like Mail.
    if (isMac && !quitting) {
      e.preventDefault();
      win?.hide();
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
  const t: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "团团",
            submenu: [
              { role: "about", label: "关于团团" },
              { type: "separator" },
              { role: "hide", label: "隐藏团团" },
              { role: "hideOthers", label: "隐藏其他" },
              { role: "unhide", label: "全部显示" },
              { type: "separator" },
              { role: "quit", label: "退出团团" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac ? ([{ type: "separator" }, { role: "front", label: "前置全部窗口" }] as const) : []),
        ...(!isMac ? ([{ role: "quit", label: "退出" }] as const) : []),
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "打开数据文件夹", click: () => void shell.openPath(app.getPath("userData")) },
        { label: "打开日志", click: () => void shell.openPath(join(app.getPath("userData"), "logs")) },
        { label: "项目主页", click: () => void shell.openExternal("https://github.com/bosshanz/tuantuan") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

function trayIcon() {
  if (process.env.TUANTUAN_TRAY !== "1") return;
  const img = icon();
  if (!img) return;
  tray = new Tray(img.resize({ width: 18, height: 18 }));
  tray.setToolTip("团团");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开团团", click: () => restore() },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => restore());
}

async function updates() {
  // Only when the build was configured to publish (electron-builder writes app-update.yml then).
  if (!app.isPackaged || process.env.TUANTUAN_AUTO_UPDATE === "0") return;
  if (!existsSync(join(process.resourcesPath, "app-update.yml"))) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.autoDownload = true;
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    console.error("update check failed", e);
  }
}

async function boot() {
  menu();
  registerNotifications(() => win);
  ipcMain.handle("tuantuan:pick-folder", async (e, o: { title?: string; start?: string }) => {
    const owner = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = {
      title: o?.title || "选择文件夹",
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
    dialog.showErrorBox("团团无法启动", `${(e as Error).message}\n\n日志：${join(app.getPath("userData"), "logs")}`);
    app.exit(1);
    return;
  }
  srv.child.on("exit", () => {
    if (!quitting) {
      dialog.showErrorBox("团团的服务意外退出", `日志：${join(app.getPath("userData"), "logs", "server.log")}`);
      app.quit();
    }
  });
  if (process.env.TUANTUAN_DESKTOP_SMOKE) console.log(`TUANTUAN_SERVER_URL=${srv.url}`);
  createWindow();
  trayIcon();
  void updates();
  app.on("activate", () => restore());
}

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
app.on("before-quit", (e) => {
  quitting = true;
  if (srv && srv.child.exitCode === null) {
    e.preventDefault();
    const s = srv;
    srv = null;
    void s.stop().finally(() => app.quit());
  }
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.quit());
