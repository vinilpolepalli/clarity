const { contextBridge, ipcRenderer } = require("electron");

const allowedActions = new Set([
  "SHOW", "HIDE", "TOGGLE_VISIBILITY", "SET_PROMPT", "SUBMIT", "EXPAND", "COLLAPSE",
  "START_LISTENING", "STOP_LISTENING", "SHOW_HISTORY", "LOAD_CONVERSATION", "RETRY", "CLEAR"
]);

const overlayBridge = {
  getState: () => ipcRenderer.invoke("overlay:get-state"),
  getAppearance: () => ipcRenderer.invoke("overlay:get-appearance"),
  dispatch: (action) => {
    if (!action || !allowedActions.has(action.type)) return Promise.reject(new Error("Unsupported overlay action"));
    return ipcRenderer.invoke("overlay:dispatch", action);
  },
  getHistory: () => ipcRenderer.invoke("overlay:get-history"),
  getConversation: (id) => ipcRenderer.invoke("overlay:get-conversation", id),
  getModeModel: () => ipcRenderer.invoke("overlay:get-mode-model"),
  setMode: (modeId) => ipcRenderer.invoke("overlay:set-mode", modeId),
  openModePicker: (layout) => ipcRenderer.invoke("overlay:open-mode-picker", layout),
  closeModePicker: () => ipcRenderer.invoke("overlay:close-mode-picker"),
  openSettings: (tab) => ipcRenderer.invoke("overlay:open-settings", tab),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("overlay:state", handler);
    return () => ipcRenderer.removeListener("overlay:state", handler);
  },
  onAppearance: (listener) => {
    const handler = (_event, appearance) => listener(appearance);
    ipcRenderer.on("overlay:appearance", handler);
    return () => ipcRenderer.removeListener("overlay:appearance", handler);
  },
  onModeModel: (listener) => {
    const handler = (_event, model) => listener(model);
    ipcRenderer.on("overlay:mode-model", handler);
    return () => ipcRenderer.removeListener("overlay:mode-model", handler);
  },
  onPickerClosed: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("overlay:picker-closed", handler);
    return () => ipcRenderer.removeListener("overlay:picker-closed", handler);
  }
};

if (process.env.CLARITY_TEST === "1") {
  overlayBridge.testSnapshot = () => ipcRenderer.invoke("test:snapshot");
  overlayBridge.testSetBounds = (bounds) => ipcRenderer.invoke("test:set-bounds", bounds);
}

contextBridge.exposeInMainWorld("clarityOverlay", Object.freeze(overlayBridge));
