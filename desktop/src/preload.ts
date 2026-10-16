import { contextBridge, ipcRenderer } from "electron";

/** The only surface the web UI gets: no Node, just these calls. */
contextBridge.exposeInMainWorld("tuantuan", {
  desktop: true,
  platform: process.platform,
  setLocale: (locale: string) => ipcRenderer.invoke("tuantuan:set-locale", locale),
  pickFolder: (o: { title: string; start?: string }) => ipcRenderer.invoke("tuantuan:pick-folder", o),
  notify: (p: { title: string; body: string; roomId: string; icon?: string }) =>
    ipcRenderer.invoke("tuantuan:notify", p),
  setBadge: (count: number) => ipcRenderer.invoke("tuantuan:badge", count),
  notifyStatus: () => ipcRenderer.invoke("tuantuan:notify-status"),
  openNotificationSettings: () => ipcRenderer.invoke("tuantuan:open-notification-settings"),
  taskPowerStatus: () => ipcRenderer.invoke("tuantuan:task-power-status"),
  setTaskPower: (enabled: boolean) => ipcRenderer.invoke("tuantuan:task-power-set", enabled),
  onOpenRoom: (cb: (roomId: string) => void) => {
    const h = (_e: unknown, roomId: string) => cb(roomId);
    ipcRenderer.on("tuantuan:open-room", h);
    return () => ipcRenderer.removeListener("tuantuan:open-room", h);
  },
});
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.desktop = process.platform;
});
ipcRenderer.on("tuantuan:fullscreen", (_e, on: boolean) => {
  if (on) document.documentElement.dataset.fullscreen = "";
  else delete document.documentElement.dataset.fullscreen;
});
