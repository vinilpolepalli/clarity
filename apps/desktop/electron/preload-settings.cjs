const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("claritySettings", Object.freeze({
  getModel: () => ipcRenderer.invoke("settings:get-model"),
  update: (patch) => ipcRenderer.invoke("settings:update", patch),
  completeOnboarding: () => ipcRenderer.invoke("settings:complete-onboarding"),
  requestPermission: (capability) => ipcRenderer.invoke("settings:request-permission", capability),
  saveProviderKey: (provider, key) => ipcRenderer.invoke("settings:save-provider-key", { provider, key }),
  deleteProviderKey: (provider) => ipcRenderer.invoke("settings:delete-provider-key", provider),
  openExternal: (target) => ipcRenderer.invoke("settings:open-external", target),
  onModel: (listener) => {
    const handler = (_event, model) => listener(model);
    ipcRenderer.on("settings:model", handler);
    return () => ipcRenderer.removeListener("settings:model", handler);
  }
}));
