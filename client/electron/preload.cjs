// Minimal, typed bridge between the renderer and the desktop shell.
// Mirrors the NovaDesktop interface in src/vite-env.d.ts.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel, cb) => {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("nova", {
  platform: process.platform,
  version: ipcRenderer.sendSync("app:version"),
  getSources: () => ipcRenderer.invoke("screen:sources"),
  selectSource: (id, withAudio) => ipcRenderer.send("screen:select", id, withAudio),
  onScreenPick: (cb) => on("screen:pick", cb),
  onAppAudio: (cb) => on("appaudio", cb),
  stopAppAudio: () => ipcRenderer.send("appaudio:stop"),
  setBadge: (count, dataUrl) => ipcRenderer.send("badge", { count, dataUrl }),
  flashFrame: (flag) => ipcRenderer.send("flash", flag),
  notify: (title, body, tag) => ipcRenderer.send("notify", { title, body, tag }),
  onNotificationClick: (cb) => on("notification:click", cb),
  window: {
    minimize: () => ipcRenderer.send("win:minimize"),
    maximize: () => ipcRenderer.send("win:maximize"),
    close: () => ipcRenderer.send("win:close"),
    isMaximized: () => ipcRenderer.sendSync("win:isMaximized"),
    onMaximizeChange: (cb) => on("win:maximized", cb),
  },
  onUpdate: (cb) => on("update", cb),
  installUpdate: () => ipcRenderer.send("update:install"),
  onActivity: (cb) => on("activity", cb),
  setGlobalShortcuts: (map) => ipcRenderer.send("shortcuts", map),
  onGlobalShortcut: (cb) => on("shortcut", cb),
  setOverlay: (state) => ipcRenderer.send("overlay:state", state),
  onOverlayData: (cb) => on("overlay:data", cb),
  openExternal: (url) => ipcRenderer.send("open-external", url),
  setAutoLaunch: (flag) => ipcRenderer.send("autolaunch", flag),
  setCloseToTray: (flag) => ipcRenderer.send("close-to-tray", flag),
});
