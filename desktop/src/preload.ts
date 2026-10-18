import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopCheckpointRequest,
  DesktopCheckpointState,
  DesktopUpdateCheckpoint,
  DesktopUpdateStatus,
} from "../../shared/desktopUpdate";

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
  updateStatus: () => ipcRenderer.invoke("tuantuan:update-status"),
  checkForUpdates: () => ipcRenderer.invoke("tuantuan:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("tuantuan:update-download"),
  installUpdate: () => ipcRenderer.invoke("tuantuan:update-install"),
  setUpdateChecks: (enabled: boolean) => ipcRenderer.invoke("tuantuan:update-checks", enabled),
  openUpdateRelease: () => ipcRenderer.invoke("tuantuan:update-open-release"),
  saveUpdateCheckpoint: (checkpoint: DesktopUpdateCheckpoint, requestId?: string) =>
    ipcRenderer.invoke("tuantuan:update-checkpoint-save", checkpoint, requestId),
  readUpdateCheckpoint: () => ipcRenderer.invoke("tuantuan:update-checkpoint-read"),
  clearUpdateCheckpoint: (id: string) => ipcRenderer.invoke("tuantuan:update-checkpoint-clear", id),
  onUpdateState: (cb: (status: DesktopUpdateStatus) => void) => {
    const listener = (_event: unknown, status: DesktopUpdateStatus) => cb(status);
    ipcRenderer.on("tuantuan:update-state", listener);
    return () => ipcRenderer.removeListener("tuantuan:update-state", listener);
  },
  onCheckpointState: (cb: (state: DesktopCheckpointState) => void) => {
    const listener = (_event: unknown, state: DesktopCheckpointState) => cb(state);
    ipcRenderer.on("tuantuan:checkpoint-state", listener);
    return () => ipcRenderer.removeListener("tuantuan:checkpoint-state", listener);
  },
  onPrepareUpdate: (cb: (request: DesktopCheckpointRequest) => Promise<void>) => {
    const listener = (_event: unknown, request: DesktopCheckpointRequest) => {
      Promise.resolve()
        .then(() => cb(request))
        .then(
          () => ipcRenderer.send("tuantuan:update-checkpoint", { id: request.id, ok: true }),
          (error) =>
            ipcRenderer.send("tuantuan:update-checkpoint", {
              id: request.id,
              ok: false,
              error: String(error?.message ?? error),
            }),
        );
    };
    ipcRenderer.on("tuantuan:update-prepare", listener);
    return () => ipcRenderer.removeListener("tuantuan:update-prepare", listener);
  },
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
