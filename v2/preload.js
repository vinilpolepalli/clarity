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
  backdropLuma: () => ipcRenderer.invoke('clarity:backdropLuma'),
  asrConfig: (cores) => ipcRenderer.invoke('clarity:asrConfig', cores),
  getConfig: () => ipcRenderer.invoke('clarity:getConfig'),
  setConfig: (patch) => ipcRenderer.invoke('clarity:setConfig', patch),
  testKey: () => ipcRenderer.invoke('clarity:testKey'),
  catalog: () => ipcRenderer.invoke('clarity:catalog'),
  healthCheck: (ids) => ipcRenderer.invoke('clarity:healthCheck', ids),
  onHealthProgress: (cb) => ipcRenderer.on('clarity:healthProgress', (_e, p) => cb(p)),
  // A MediaStream cannot cross contextBridge, so only the enable/disable hooks
  // are exposed; getDisplayMedia itself is called in the page.
  enableLoopback: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopback: () => ipcRenderer.invoke('disable-loopback-audio'),
  onHotkey: (cb) => ipcRenderer.on('clarity:hotkey', (_e, name) => cb(name))
});
