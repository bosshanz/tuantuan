import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow, ipcMain, Notification, nativeImage, shell } from "electron";
import { type Locale, translate } from "../../shared/i18n";

export interface NotifyPayload {
  title: string;
  body: string;
  roomId: string;
  /** data: URL (PNG) of the agent avatar, optional. */
  icon?: string;
  silent?: boolean;
}

export type NotifyResult = { ok: true; shown: boolean } | { ok: false; reason: string };

/** Keep references until closed: a GC'd Notification loses its click handler (and on macOS can vanish). */
const live = new Set<Notification>();
let lastResult: { at: number; result: NotifyResult } | null = null;

function log(line: string) {
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "notifications.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/** macOS: how the running bundle is signed. Unsigned / broken signatures get no Notification Center entry. */
function signature(): Promise<string> {
  if (process.platform !== "darwin" || !app.isPackaged) return Promise.resolve(app.isPackaged ? "n/a" : "dev");
  const bundle = join(app.getPath("exe"), "..", "..", "..");
  return new Promise((resolve) => {
    execFile("/usr/bin/codesign", ["-dv", bundle], (err, _out, stderr) => {
      if (err) return resolve(/not signed/i.test(stderr) ? "unsigned" : "invalid");
      if (/Signature=adhoc/.test(stderr)) return resolve("adhoc");
      const m = /Authority=([^\n]+)/.exec(stderr);
      resolve(m ? `signed: ${m[1]}` : "signed");
    });
  });
}

/**
 * Native notifications for the web UI (via the preload bridge). macOS asks for permission the
 * first time the app posts one — only for a properly signed bundle with a stable bundle id
 * (app.tuantuan.desktop); unsigned builds are silently dropped. Click focuses the window and
 * opens the conversation. Every show / failure is logged to logs/notifications.log.
 */
/**
 * macOS only lists an app under System Settings › Notifications after it has posted one from the
 * main process. Post a single welcome notification on the first launch of a packaged build so the
 * permission prompt appears right away (remembered in userData).
 */
export function registerOnFirstLaunch(locale: Locale = "zh-CN") {
  if (process.platform !== "darwin" || !app.isPackaged || !Notification.isSupported()) return;
  const flag = join(app.getPath("userData"), "notifications-registered");
  if (existsSync(flag)) return;
  const n = new Notification({
    title: translate(locale, "团团"),
    body: translate(locale, "通知已就绪：Agent 回复完成或需要你批准时会提醒你。"),
  });
  live.add(n);
  n.once("show", () => {
    log("first-launch show");
    writeFileSync(flag, new Date().toISOString());
  });
  n.once("failed", (_e, err) => log(`first-launch failed ${err}`));
  n.show();
}

export function registerNotifications(getWin: () => BrowserWindow | null) {
  if (process.platform === "win32") app.setAppUserModelId("app.tuantuan.desktop");
  ipcMain.handle("tuantuan:notify", (_e, p: NotifyPayload): Promise<NotifyResult> => {
    if (!Notification.isSupported()) {
      log("unsupported");
      lastResult = { at: Date.now(), result: { ok: false, reason: "unsupported" } };
      return Promise.resolve(lastResult.result);
    }
    const icon = p.icon?.startsWith("data:image/") ? nativeImage.createFromDataURL(p.icon) : undefined;
    const n = new Notification({
      title: String(p.title).slice(0, 120),
      body: String(p.body).slice(0, 300),
      silent: !!p.silent,
      ...(icon && !icon.isEmpty() ? { icon } : {}),
    });
    live.add(n);
    const drop = () => live.delete(n);
    n.on("click", () => {
      log(`click room=${p.roomId}`);
      drop();
      const w = getWin();
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      if (p.roomId) w.webContents.send("tuantuan:open-room", p.roomId);
    });
    n.on("close", drop);
    // Hold a reference for a while even if no close event comes (macOS often does not send one).
    setTimeout(drop, 10 * 60_000);
    return new Promise((resolve) => {
      const done = (r: NotifyResult) => {
        lastResult = { at: Date.now(), result: r };
        resolve(r);
      };
      const t = setTimeout(() => {
        log(`no-show title=${JSON.stringify(p.title)}`);
        done({ ok: true, shown: false });
      }, 4000);
      n.once("show", () => {
        clearTimeout(t);
        log(`show title=${JSON.stringify(p.title)}`);
        done({ ok: true, shown: true });
      });
      n.once("failed", (_ev, error) => {
        clearTimeout(t);
        log(`failed ${error}`);
        done({ ok: false, reason: String(error) });
      });
      n.show();
    });
  });
  ipcMain.handle("tuantuan:notify-status", async () => ({
    supported: Notification.isSupported(),
    platform: process.platform,
    packaged: app.isPackaged,
    bundleId: "app.tuantuan.desktop",
    signature: await signature(),
    last: lastResult,
  }));
  ipcMain.handle("tuantuan:open-notification-settings", async () => {
    if (process.platform === "darwin")
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.notifications");
    else if (process.platform === "win32") await shell.openExternal("ms-settings:notifications");
    return true;
  });
  ipcMain.handle("tuantuan:badge", (_e, count: number) => {
    const c = Math.max(0, Math.floor(Number(count) || 0));
    if (process.platform === "darwin") app.dock?.setBadge(c ? String(c) : "");
    else app.setBadgeCount(c);
    return c;
  });
}
