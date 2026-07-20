const { contextBridge, ipcRenderer } = require("electron");

const allowedActions = new Set([
  "SHOW", "HIDE", "TOGGLE_VISIBILITY", "SET_PROMPT", "SUBMIT", "EXPAND", "COLLAPSE",
  "START_LISTENING", "STOP_LISTENING", "SHOW_HISTORY", "LOAD_CONVERSATION", "RETRY", "CLEAR"
]);

const overlayBridge = {
  getState: () => ipcRenderer.invoke("overlay:get-state"),
  dispatch: (action) => {
    if (!action || !allowedActions.has(action.type)) return Promise.reject(new Error("Unsupported overlay action"));
    return ipcRenderer.invoke("overlay:dispatch", action);
  },
  getHistory: () => ipcRenderer.invoke("overlay:get-history"),
  getConversation: (id) => ipcRenderer.invoke("overlay:get-conversation", id),
  openSettings: () => ipcRenderer.invoke("overlay:open-settings"),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("overlay:state", handler);
    return () => ipcRenderer.removeListener("overlay:state", handler);
  }
};

if (process.env.CLARITY_TEST === "1") {
  overlayBridge.testSnapshot = () => ipcRenderer.invoke("test:snapshot");
  overlayBridge.testSetBounds = (bounds) => ipcRenderer.invoke("test:set-bounds", bounds);
}

contextBridge.exposeInMainWorld("clarityOverlay", Object.freeze(overlayBridge));
