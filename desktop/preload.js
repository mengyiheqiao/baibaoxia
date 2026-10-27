// 桌面版给页面开的几个小接口（页面只能用这些，碰不到电脑上别的东西）
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('baibaoDesktop', {
  get: () => ipcRenderer.invoke('baibao:get-desktop'),
  setKey: (name, acc) => ipcRenderer.invoke('baibao:set-key', name, acc),
  setCloseMode: mode => ipcRenderer.invoke('baibao:set-close-mode', mode),
  openDataDir: () => ipcRenderer.invoke('baibao:open-data-dir'),
  dragOut: name => ipcRenderer.send('baibao:drag-out', String(name)),
  onCommand: cb => ipcRenderer.on('baibao:cmd', (_e, cmd) => cb(String(cmd))),
});
