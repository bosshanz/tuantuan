import { app, type BrowserWindow, ipcMain, Notification, nativeImage } from "electron";

export interface NotifyPayload {
  title: string;
  body: string;
  roomId: string;
  /** data: URL (PNG) of the agent avatar, optional. */
  icon?: string;
  silent?: boolean;
}

/** Keep references so macOS click handlers survive GC. */
const live = new Set<Notification>();

/**
 * Native notifications for the web UI (via the preload bridge). macOS shows its own permission
 * prompt the first time the app posts one; nothing to request up front. Click focuses the window
 * and opens the conversation.
 */
export function registerNotifications(getWin: () => BrowserWindow | null) {
  app.setAppUserModelId("app.tuantuan.desktop");
  ipcMain.handle("tuantuan:notify", (_e, p: NotifyPayload) => {
    if (!Notification.isSupported()) return { ok: false, reason: "unsupported" };
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
      drop();
      const w = getWin();
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      if (p.roomId) w.webContents.send("tuantuan:open-room", p.roomId);
    });
    n.on("close", drop);
    n.show();
    return { ok: true };
  });
  ipcMain.handle("tuantuan:badge", (_e, count: number) => {
    const c = Math.max(0, Math.floor(Number(count) || 0));
    if (process.platform === "darwin") app.dock?.setBadge(c ? String(c) : "");
    else app.setBadgeCount(c);
    return c;
  });
}
