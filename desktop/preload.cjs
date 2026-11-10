const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("brito", {
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  load: () => ipcRenderer.invoke("store:load"),
  save: (state) => ipcRenderer.invoke("store:save", state),
  pickFolder: () => ipcRenderer.invoke("pickFolder"),
  listDir: (root, rel) => ipcRenderer.invoke("fs:list", { root, rel }),
  readFile: (root, rel) => ipcRenderer.invoke("fs:read", { root, rel }),
  env: () => ipcRenderer.invoke("env"),
  start: (sessionId, root, claudeId) => ipcRenderer.invoke("backend:start", { sessionId, root, claudeId }),
  write: (sessionId, msg) => ipcRenderer.send("backend:write", { sessionId, msg }),
  stop: (sessionId) => ipcRenderer.send("backend:stop", sessionId),
  update: {
    check: (force) => ipcRenderer.invoke("update:check", { force: !!force }),
    install: () => ipcRenderer.invoke("update:install"),
    openPage: () => ipcRenderer.invoke("update:page"),
    onProgress: (cb) => ipcRenderer.on("update:progress", (_e, p) => cb(p)),
  },
  onEvent: (cb) => ipcRenderer.on("brito:event", (_e, p) => cb(p.sessionId, p.ev)),
});
