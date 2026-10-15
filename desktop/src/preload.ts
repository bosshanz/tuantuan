import { contextBridge, ipcRenderer } from "electron";

/** The only surface the web UI gets: no Node, just these calls. */
contextBridge.exposeInMainWorld("tuantuan", {
  desktop: true,
  platform: process.platform,
  pickFolder: (o: { title: string; start?: string }) => ipcRenderer.invoke("tuantuan:pick-folder", o),
});
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.desktop = process.platform;
});
