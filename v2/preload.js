const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clarity', {
  ask: (payload) => ipcRenderer.invoke('clarity:ask', payload),
  code: (payload) => ipcRenderer.invoke('clarity:code', payload),
  meeting: (payload) => ipcRenderer.invoke('clarity:meeting', payload),
  screen: (payload) => ipcRenderer.invoke('clarity:screen', payload),
  captureScreen: () => ipcRenderer.invoke('clarity:capture'),
  listModels: () => ipcRenderer.invoke('clarity:models'),
  pingModel: (id) => ipcRenderer.invoke('clarity:ping', id),
  setModel: (id) => ipcRenderer.invoke('clarity:setModel', id),
  getState: () => ipcRenderer.invoke('clarity:getState'),
  toggleClickThrough: (v) => ipcRenderer.invoke('clarity:clickThrough', v),
  toggleContentProtection: (v) => ipcRenderer.invoke('clarity:contentProtection', v),
  addTranscript: (line) => ipcRenderer.invoke('clarity:addTranscript', line),
  quit: () => ipcRenderer.invoke('clarity:quit'),
  openCatalog: () => ipcRenderer.invoke('clarity:openCatalog'),
  onHotkey: (cb) => ipcRenderer.on('clarity:hotkey', (_e, name) => cb(name))
});
