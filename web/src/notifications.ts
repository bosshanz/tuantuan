import type { TaskPowerStatus } from "../../shared/desktopPower";
import type { DesktopUpdateBridge } from "../../shared/desktopUpdate";
import type { Locale } from "../../shared/i18n";
import { type GlobalEvent, NOTIFY_KINDS, type NotifyKind } from "../../shared/notify";

export type NotifySettings = { enabled: boolean } & Record<NotifyKind, boolean>;
const KEY = "tuantuan:notify";
export const DEFAULT_NOTIFY: NotifySettings = { enabled: true, reply: true, permission: true, error: true, auth: true };

export function loadNotifySettings(): NotifySettings {
  try {
    return { ...DEFAULT_NOTIFY, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_NOTIFY };
  }
}
export function saveNotifySettings(s: NotifySettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

type Notify = Extract<GlobalEvent, { type: "notify" }>;

/** Whether to show a notification: category on, and not when you are already looking at that conversation. */
export function shouldNotify(
  e: Notify,
  ctx: { settings: NotifySettings; focused: boolean; openRoomId: string | null },
) {
  if (!ctx.settings.enabled || !ctx.settings[e.kind]) return false;
  return !(ctx.focused && ctx.openRoomId === e.roomId);
}

/** Unread counter per room (the dock badge is the total). */
export function bumpUnread(unread: Record<string, number>, roomId: string): Record<string, number> {
  return { ...unread, [roomId]: (unread[roomId] ?? 0) + 1 };
}
export function totalUnread(unread: Record<string, number>): number {
  return Object.values(unread).reduce((a, b) => a + b, 0);
}

export type DesktopStatus = {
  supported: boolean;
  platform: string;
  packaged: boolean;
  bundleId: string;
  signature: string;
  last: { at: number; result: { ok: boolean; shown?: boolean; reason?: string } } | null;
};
type Bridge = Partial<DesktopUpdateBridge> & {
  setLocale?: (locale: Locale) => Promise<unknown>;
  notify?: (p: {
    title: string;
    body: string;
    roomId: string;
    icon?: string;
  }) => Promise<{ ok: boolean; shown?: boolean; reason?: string } | undefined>;
  notifyStatus?: () => Promise<DesktopStatus>;
  openNotificationSettings?: () => Promise<unknown>;
  setBadge?: (n: number) => Promise<unknown>;
  onOpenRoom?: (cb: (roomId: string) => void) => () => void;
  taskPowerStatus?: () => Promise<TaskPowerStatus>;
  setTaskPower?: (enabled: boolean) => Promise<TaskPowerStatus>;
};
export const bridge = (): Bridge | undefined => (window as { tuantuan?: Bridge }).tuantuan;

export function updateBridge(): DesktopUpdateBridge | undefined {
  const desktop = bridge();
  if (
    desktop?.updateStatus &&
    desktop.checkForUpdates &&
    desktop.downloadUpdate &&
    desktop.installUpdate &&
    desktop.setUpdateChecks &&
    desktop.openUpdateRelease &&
    desktop.onUpdateState &&
    desktop.onPrepareUpdate &&
    desktop.saveUpdateCheckpoint &&
    desktop.readUpdateCheckpoint &&
    desktop.clearUpdateCheckpoint
  )
    return desktop as DesktopUpdateBridge;
  return undefined;
}

export function notifySupport(): "desktop" | "web" | "none" {
  if (bridge()?.notify) return "desktop";
  return typeof Notification !== "undefined" ? "web" : "none";
}

/** Desktop app: native notification via the preload bridge. Browser: the Web Notification API. */
export async function showNotification(
  p: { title: string; body: string; roomId: string; icon?: string },
  open: (roomId: string) => void,
): Promise<"shown" | "not-shown" | "denied" | "unsupported"> {
  const b = bridge();
  if (b?.notify) {
    const r = await b.notify(p);
    if (!r) return "shown";
    if (!r.ok) return r.reason === "unsupported" ? "unsupported" : "denied";
    return r.shown ? "shown" : "not-shown";
  }
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission !== "granted") return "denied";
  const n = new Notification(p.title, { body: p.body, icon: p.icon, tag: `${p.roomId}:${p.body.slice(0, 20)}` });
  n.onclick = () => {
    window.focus();
    open(p.roomId);
    n.close();
  };
  return "shown";
}

export function setBadge(n: number) {
  void bridge()?.setBadge?.(n);
  const nav = navigator as Navigator & {
    setAppBadge?: (n: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (!bridge()?.setBadge) void (n ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
}

/** PNG data URL of an agent avatar, rendered from its SVG (for the notification icon). */
export async function avatarIcon(svg: SVGSVGElement | null, color: string): Promise<string | undefined> {
  if (!svg) return undefined;
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", "128");
    clone.setAttribute("height", "128");
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `.ba-body>*{fill:${color};stroke:${color}}.ba-body>*:not(.ba-stroke){stroke-width:0}.ba-face line,.ba-face path{stroke:#fff;stroke-width:7.5;stroke-linecap:round;fill:none}.ba-dot{fill:#fff;stroke:none}`;
    clone.prepend(style);
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    c.getContext("2d")?.drawImage(img, 8, 8, 112, 112);
    return c.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

export { NOTIFY_KINDS };
