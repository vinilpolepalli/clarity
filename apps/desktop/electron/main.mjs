import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  systemPreferences
} from "electron";
import {
  createInitialOverlayState,
  DEMO_HISTORY,
  demoResponse,
  isExpandedPhase,
  reduceOverlay
} from "@clarity/domain";
import {
  COMPACT_HEIGHT,
  boundsEqual,
  defaultCompactBounds,
  transitionBounds
} from "@clarity/windowing";
import { streamProviderResponse } from "@clarity/providers";
import { NativeCaptureClient, RollingAudioBuffer } from "@clarity/capture-client";
import { PreferenceStore } from "./persistence.mjs";
import { deleteProviderKey, hasProviderKey, readProviderKey, saveProviderKey } from "./keychain.mjs";
import { StorageService } from "./storage-service.mjs";

const APP_ROOT = join(import.meta.dirname, "..");
const isDemo = process.env.CLARITY_DEMO === "1" || process.argv.includes("--demo");
const isTest = process.env.CLARITY_TEST === "1";
const testOnboarding = process.env.CLARITY_TEST_ONBOARDING === "1";

app.setName("Clarity");
if (isTest && process.env.CLARITY_TEST_USER_DATA) app.setPath("userData", process.env.CLARITY_TEST_USER_DATA);
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let overlayWindow = null;
let settingsWindow = null;
let overlayState = createInitialOverlayState(false);
let preferences;
let store;
let boundsWriteTimer = null;
let programmaticBounds = false;
let keyConfigured = { openai: false, anthropic: false, nvidia: false };
let activeInference = null;
let storage = null;
let capture = null;
const recentAudio = new RollingAudioBuffer();

async function persistResponse(prompt, response) {
  if (!storage || !response) return;
  const id = crypto.randomUUID();
  const title = prompt.trim().slice(0, 72) || "Untitled session";
  try { await storage.call("create", { id, title, prompt, response, mode: preferences.mode }); }
  catch (error) { console.warn("Could not persist the local response:", error.message); }
}

function rendererTarget(page) {
  const developmentUrl = process.env.CLARITY_RENDERER_URL;
  if (developmentUrl) return `${developmentUrl}/${page}.html`;
  return pathToFileURL(join(APP_ROOT, "dist", `${page}.html`)).toString();
}

function sendOverlayState() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay:state", structuredClone(overlayState));
  }
}

function sendSettingsModel() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("settings:model", getSettingsModel());
  }
}

function displayForBounds(bounds) {
  return screen.getDisplayMatching(bounds).workArea;
}

function rememberedGeometry() {
  return {
    compactWidth: preferences.overlayCompactBounds?.width,
    expandedHeight: preferences.overlayExpandedBounds?.height
  };
}

function applyOverlayPresentation(previousPhase, animate = true) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayState.phase === "hidden") {
    overlayWindow.hide();
    return;
  }

  const wasExpanded = isExpandedPhase(previousPhase);
  const expanded = isExpandedPhase(overlayState.phase);
  const current = overlayWindow.getBounds();
  const workArea = displayForBounds(current);
  if (expanded) {
    overlayWindow.setMaximumSize(760, workArea.height);
    overlayWindow.setMinimumSize(420, 300);
    overlayWindow.setResizable(true);
  } else {
    overlayWindow.setMaximumSize(760, workArea.height);
    overlayWindow.setMinimumSize(420, COMPACT_HEIGHT);
  }
  if (wasExpanded !== expanded || current.height !== (expanded ? current.height : COMPACT_HEIGHT)) {
    const next = transitionBounds(current, workArea, expanded, rememberedGeometry());
    if (!boundsEqual(current, next)) {
      programmaticBounds = true;
      overlayWindow.setBounds(next, animate && !preferences.reduceMotion);
      setTimeout(() => { programmaticBounds = false; }, preferences.reduceMotion ? 0 : 260);
    }
  }
  if (!expanded) {
    const compact = overlayWindow.getBounds();
    overlayWindow.setResizable(false);
    overlayWindow.setMinimumSize(compact.width, COMPACT_HEIGHT);
    overlayWindow.setMaximumSize(compact.width, COMPACT_HEIGHT);
  }
  overlayWindow.setContentProtection(Boolean(preferences.protectOverlayContent));
  if (!overlayWindow.isVisible()) overlayWindow.showInactive();
}

function dispatchOverlay(event, options = {}) {
  const previousPhase = overlayState.phase;
  overlayState = reduceOverlay(overlayState, event);
  applyOverlayPresentation(previousPhase, options.animate !== false);
  sendOverlayState();

  if (event.type === "START_LISTENING" && capture) {
    void capture.start({ microphone: true, systemAudio: Boolean(preferences.captureSystemAudio) }).catch((error) => {
      dispatchOverlay({ type: "STOP_LISTENING" }, { animate: false });
      dispatchOverlay({ type: "FAIL", error: `Capture could not start: ${error.message}` });
    });
  }
  if (event.type === "STOP_LISTENING" && capture) void capture.stop().catch((error) => console.warn("Capture stop failed:", error.message));

  if (event.type === "SUBMIT" && overlayState.requestId) {
    const requestId = overlayState.requestId;
    const prompt = overlayState.prompt;
    activeInference?.abort();
    activeInference = new AbortController();
    if (preferences.provider === "demo") {
      setTimeout(() => {
        if (overlayState.requestId !== requestId) return;
        try {
          dispatchOverlay({ type: "RESOLVE", requestId, response: demoResponse(prompt) });
          void persistResponse(prompt, overlayState.response);
        } catch (error) {
          dispatchOverlay({ type: "FAIL", requestId, error: error.message });
        }
      }, preferences.reduceMotion ? 80 : 680);
    } else {
      void (async () => {
        const inference = activeInference;
        try {
          const key = await readProviderKey(preferences.provider);
          const response = await streamProviderResponse({
            provider: preferences.provider,
            model: preferences.model,
            prompt,
            key,
            signal: inference.signal,
            onToken: (_token, accumulated) => dispatchOverlay({ type: "STREAM", requestId, response: accumulated }, { animate: false })
          });
          dispatchOverlay({ type: "RESOLVE", requestId, response });
          void persistResponse(prompt, response);
        } catch (error) {
          if (error?.name !== "AbortError") dispatchOverlay({ type: "FAIL", requestId, error: error.message });
        }
      })();
    }
  }
  return structuredClone(overlayState);
}

function queueBoundsWrite() {
  if (programmaticBounds || !overlayWindow || overlayWindow.isDestroyed()) return;
  clearTimeout(boundsWriteTimer);
  boundsWriteTimer = setTimeout(() => {
    const bounds = overlayWindow.getBounds();
    const patch = isExpandedPhase(overlayState.phase)
      ? { overlayExpandedBounds: bounds }
      : { overlayCompactBounds: { ...bounds, height: COMPACT_HEIGHT } };
    store.update(patch).then((next) => { preferences = next; });
  }, 180);
}

function createOverlayWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const initial = preferences.overlayCompactBounds ?? defaultCompactBounds(workArea);
  overlayWindow = new BrowserWindow({
    ...transitionBounds(initial, displayForBounds(initial), false, rememberedGeometry()),
    title: "Clarity Overlay",
    frame: false,
    transparent: !preferences.reduceTransparency,
    backgroundColor: preferences.reduceTransparency ? "#111113" : "#00000000",
    show: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    movable: true,
    roundedCorners: false,
    webPreferences: {
      preload: join(import.meta.dirname, "preload-overlay.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !app.isPackaged || isTest
    }
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver", 1);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setContentProtection(Boolean(preferences.protectOverlayContent));
  overlayWindow.on("move", queueBoundsWrite);
  overlayWindow.on("resize", queueBoundsWrite);
  overlayWindow.on("close", (event) => {
    if (!app.isQuitting && !isTest) {
      event.preventDefault();
      dispatchOverlay({ type: "HIDE" });
    }
  });
  overlayWindow.loadURL(rendererTarget("overlay"));
  overlayWindow.webContents.once("did-finish-load", () => sendOverlayState());
}

function createSettingsWindow({ onboarding = false } = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    sendSettingsModel();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    title: onboarding ? "Welcome to Clarity" : "Clarity Settings",
    width: 980,
    height: 680,
    minWidth: 820,
    minHeight: 580,
    show: false,
    backgroundColor: "#0d0e10",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 17 },
    webPreferences: {
      preload: join(import.meta.dirname, "preload-settings.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !app.isPackaged || isTest
    }
  });
  settingsWindow.loadURL(rendererTarget("settings"));
  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
  settingsWindow.on("closed", () => { settingsWindow = null; });
  settingsWindow.webContents.once("did-finish-load", () => sendSettingsModel());
  return settingsWindow;
}

function permissionStatus() {
  if (process.platform !== "darwin") {
    return { accessibility: "unsupported", microphone: "unsupported", screen: "unsupported" };
  }
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-determined",
    microphone: systemPreferences.getMediaAccessStatus("microphone"),
    screen: systemPreferences.getMediaAccessStatus("screen")
  };
}

function getSettingsModel() {
  return {
    preferences: structuredClone(preferences),
    permissions: permissionStatus(),
    app: { version: app.getVersion(), packaged: app.isPackaged, demo: isDemo },
    onboarding: !preferences.onboardingComplete,
    keyConfigured: structuredClone(keyConfigured)
  };
}

function registerIpc() {
  ipcMain.handle("overlay:get-state", () => structuredClone(overlayState));
  ipcMain.handle("overlay:dispatch", (_event, action) => dispatchOverlay(action));
  ipcMain.handle("overlay:get-history", async () => {
    const local = storage ? await storage.call("list", { limit: 50 }) : [];
    return local.length ? local : structuredClone(DEMO_HISTORY);
  });
  ipcMain.handle("overlay:open-settings", () => { createSettingsWindow(); return true; });

  ipcMain.handle("settings:get-model", () => getSettingsModel());
  ipcMain.handle("settings:update", async (_event, patch) => {
    const allowed = [
      "launchAtLogin", "launchOverlayAtLogin", "reduceMotion", "reduceTransparency",
      "protectOverlayContent", "transcriptLanguage", "outputLanguage", "microphoneId",
      "captureSystemAudio", "provider", "model", "mode", "selectedSettingsTab",
      "cloudEnabled", "integrations", "keybindings"
    ];
    const safePatch = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key)));
    preferences = await store.update(safePatch);
    if (Object.hasOwn(safePatch, "launchAtLogin") && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: Boolean(preferences.launchAtLogin), openAsHidden: true });
    }
    nativeTheme.themeSource = "dark";
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setContentProtection(Boolean(preferences.protectOverlayContent));
    }
    sendSettingsModel();
    return getSettingsModel();
  });
  ipcMain.handle("settings:complete-onboarding", async () => {
    preferences = await store.update({ onboardingComplete: true });
    settingsWindow?.close();
    dispatchOverlay({ type: "SHOW" });
    return true;
  });
  ipcMain.handle("settings:request-permission", async (_event, capability) => {
    if (process.platform !== "darwin") return permissionStatus();
    if (capability === "microphone") await systemPreferences.askForMediaAccess("microphone");
    if (capability === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
    if (capability === "screen") await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    sendSettingsModel();
    return permissionStatus();
  });
  ipcMain.handle("settings:save-provider-key", async (_event, payload) => {
    await saveProviderKey(payload?.provider, payload?.key);
    keyConfigured[payload.provider] = true;
    sendSettingsModel();
    return getSettingsModel();
  });
  ipcMain.handle("settings:delete-provider-key", async (_event, provider) => {
    await deleteProviderKey(provider);
    keyConfigured[provider] = false;
    sendSettingsModel();
    return getSettingsModel();
  });
  ipcMain.handle("settings:open-external", async (_event, target) => {
    const allowed = new Set(["https://github.com/vinilpolepalli/clarity", "https://www.gnu.org/licenses/agpl-3.0.html"]);
    if (!allowed.has(target)) throw new Error("External URL is not allowed");
    await shell.openExternal(target);
    return true;
  });
  if (isTest) {
    ipcMain.handle("test:snapshot", () => ({ overlay: structuredClone(overlayState), bounds: overlayWindow?.getBounds(), settings: getSettingsModel() }));
    ipcMain.handle("test:set-bounds", (_event, bounds) => {
      const current = overlayWindow.getBounds();
      overlayWindow.setBounds({ ...current, ...bounds }, false);
      return overlayWindow.getBounds();
    });
  }
}

function createApplicationMenu() {
  const template = [
    {
      label: "Clarity",
      submenu: [
        { label: "About Clarity", click: () => createSettingsWindow() },
        { type: "separator" },
        { label: "Settings…", accelerator: "CommandOrControl+,", click: () => createSettingsWindow() },
        { type: "separator" },
        { label: "Quit Clarity", accelerator: "CommandOrControl+Q", click: () => { app.isQuitting = true; app.quit(); } }
      ]
    },
    {
      label: "Overlay",
      submenu: [
        { label: "Show or Hide", accelerator: preferences.keybindings.toggleOverlay, click: () => dispatchOverlay({ type: "TOGGLE_VISIBILITY" }) },
        { label: "Start or Stop Listening", accelerator: preferences.keybindings.toggleListening, click: () => dispatchOverlay({ type: overlayState.startedAt ? "STOP_LISTENING" : "START_LISTENING" }) }
      ]
    },
    { role: "editMenu" },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  nativeTheme.themeSource = "dark";
  store = new PreferenceStore(join(app.getPath("userData"), isTest ? "preferences.test.json" : "preferences.json"));
  preferences = await store.load();
  storage = new StorageService({ directory: join(app.getPath("userData"), "local-data") });
  await storage.start();
  const captureExecutable = app.isPackaged
    ? join(process.resourcesPath, "native", "ClarityCapture")
    : join(APP_ROOT, "..", "..", "native", "ClarityCapture", ".build", "debug", "ClarityCapture");
  if (existsSync(captureExecutable) && !isTest) {
    capture = new NativeCaptureClient({
      executable: captureExecutable,
      onFrame: (frame) => recentAudio.append(frame.pcm),
      onEvent: (event) => { if (event.type === "protocol-error" || event.type === "exit") console.warn("Capture helper:", event); }
    });
    try { await capture.connect(); } catch (error) { console.warn("Native capture is unavailable:", error.message); capture = null; }
  }
  keyConfigured = Object.fromEntries(await Promise.all(["openai", "anthropic", "nvidia"].map(async (provider) => [provider, await hasProviderKey(provider)])));
  if (isDemo || (isTest && !testOnboarding)) preferences = await store.update({ onboardingComplete: true, reduceMotion: isTest, protectOverlayContent: !isTest });
  if (isTest && testOnboarding) preferences = await store.update({ onboardingComplete: false, reduceMotion: true, protectOverlayContent: false });
  const showOverlayAtBoot = Boolean(preferences.onboardingComplete && (preferences.launchOverlayAtLogin || isDemo || isTest));
  overlayState = createInitialOverlayState(showOverlayAtBoot);
  registerIpc();
  createOverlayWindow();
  createApplicationMenu();
  globalShortcut.register(preferences.keybindings.toggleOverlay, () => dispatchOverlay({ type: "TOGGLE_VISIBILITY" }));
  globalShortcut.register(preferences.keybindings.toggleListening, () => dispatchOverlay({ type: overlayState.startedAt ? "STOP_LISTENING" : "START_LISTENING" }));
  if (showOverlayAtBoot) dispatchOverlay({ type: "SHOW" }, { animate: false });
  else createSettingsWindow({ onboarding: true });
}

if (singleInstance) {
  app.whenReady().then(boot);
  app.on("second-instance", () => {
    if (overlayState.phase === "hidden") dispatchOverlay({ type: "SHOW" });
    else overlayWindow?.focus();
  });
  app.on("activate", () => {
    if (!overlayWindow) createOverlayWindow();
    if (overlayState.phase === "hidden") dispatchOverlay({ type: "SHOW" });
  });
  app.on("will-quit", () => { globalShortcut.unregisterAll(); storage?.close(); void capture?.close(); });
  app.on("window-all-closed", (event) => {
    if (isTest) app.quit();
    else if (process.platform === "darwin") event?.preventDefault?.();
  });
}
