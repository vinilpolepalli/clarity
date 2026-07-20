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
  assembleSystemPrompt,
  assertModeId,
  createInitialOverlayState,
  createModeModel,
  DEMO_HISTORY,
  demoResponse,
  isExpandedPhase,
  reduceOverlay,
  resolveMode
} from "@clarity/domain";
import {
  COMPACT_HEIGHT,
  boundsEqual,
  defaultCompactBounds,
  pickerPresentationBounds,
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
const SETTINGS_TABS = new Set(["general", "models", "audio", "modes", "keybindings", "profile", "privacy", "integrations", "about"]);

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
let activeRequestContext = null;
let lastFailedRequestContext = null;
let storage = null;
let capture = null;
let pickerAnchorBounds = null;
const recentAudio = new RollingAudioBuffer();

async function persistResponse(prompt, response, modeId, modePromptVersion) {
  if (!storage || !response) return;
  const id = crypto.randomUUID();
  const title = prompt.trim().slice(0, 72) || "Untitled session";
  try { await storage.call("create", { id, title, prompt, response, mode: modeId, modePromptVersion }); }
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

function getModeModel() {
  return createModeModel(preferences.mode);
}

function sendOverlayModeModel() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay:mode-model", getModeModel());
  }
}

async function setActiveMode(modeId) {
  const validatedModeId = assertModeId(modeId);
  const nextPreferences = await store.update({ mode: validatedModeId });
  preferences = nextPreferences;
  sendSettingsModel();
  sendOverlayModeModel();
  return getModeModel();
}

function displayForBounds(bounds) {
  return screen.getDisplayMatching(bounds).workArea;
}

function validatePickerLayout(layout) {
  const desiredHeight = Number(layout?.desiredHeight);
  const anchorRect = layout?.anchorRect;
  if (!Number.isFinite(desiredHeight) || desiredHeight < 120 || desiredHeight > 800) throw new TypeError("Invalid mode picker height");
  if (!anchorRect || [anchorRect.x, anchorRect.y, anchorRect.width, anchorRect.height].some((value) => !Number.isFinite(Number(value)))) {
    throw new TypeError("Invalid mode picker anchor");
  }
  return { desiredHeight };
}

function openModePicker(layout) {
  if (!overlayWindow || overlayWindow.isDestroyed() || overlayState.phase === "hidden") throw new Error("Overlay is not available");
  const { desiredHeight } = validatePickerLayout(layout);
  if (pickerAnchorBounds) closeModePicker();
  const anchorBounds = overlayWindow.getBounds();
  const presentation = pickerPresentationBounds(anchorBounds, displayForBounds(anchorBounds), desiredHeight);
  if (presentation.viewportHeight < 120) throw new Error("There is not enough room to open the mode picker");
  pickerAnchorBounds = anchorBounds;
  programmaticBounds = true;
  overlayWindow.setMinimumSize(1, 1);
  overlayWindow.setMaximumSize(displayForBounds(anchorBounds).width, displayForBounds(anchorBounds).height);
  overlayWindow.setResizable(false);
  overlayWindow.setBounds(presentation.bounds, false);
  setTimeout(() => { programmaticBounds = false; }, 0);
  return { placement: presentation.placement, viewportHeight: presentation.viewportHeight, surfaceOffsetY: presentation.surfaceOffsetY };
}

function closeModePicker({ notifyRenderer = false } = {}) {
  if (!pickerAnchorBounds || !overlayWindow || overlayWindow.isDestroyed()) return false;
  const anchorBounds = pickerAnchorBounds;
  pickerAnchorBounds = null;
  programmaticBounds = true;
  overlayWindow.setMinimumSize(1, 1);
  overlayWindow.setMaximumSize(displayForBounds(anchorBounds).width, displayForBounds(anchorBounds).height);
  overlayWindow.setBounds(anchorBounds, false);
  applyOverlayPresentation(overlayState.phase, false);
  setTimeout(() => { programmaticBounds = false; }, 0);
  if (notifyRenderer) overlayWindow.webContents.send("overlay:picker-closed");
  return true;
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
  if (pickerAnchorBounds && event.type !== "SET_PROMPT") closeModePicker({ notifyRenderer: true });
  if (event.type === "CLEAR") {
    activeRequestContext?.controller.abort();
    activeRequestContext = null;
    lastFailedRequestContext = null;
  }
  let effectiveEvent = event;
  let retrySource = null;
  if (event.type === "RETRY") {
    retrySource = lastFailedRequestContext;
    if (!retrySource) return structuredClone(overlayState);
    effectiveEvent = { type: "RETRY", prompt: retrySource.prompt, requestId: crypto.randomUUID() };
  }
  const previousPhase = overlayState.phase;
  overlayState = reduceOverlay(overlayState, effectiveEvent);
  applyOverlayPresentation(previousPhase, options.animate !== false);
  sendOverlayState();

  if (effectiveEvent.type === "START_LISTENING" && capture) {
    void capture.start({ microphone: true, systemAudio: Boolean(preferences.captureSystemAudio) }).catch((error) => {
      dispatchOverlay({ type: "STOP_LISTENING" }, { animate: false });
      dispatchOverlay({ type: "FAIL", error: `Capture could not start: ${error.message}` });
    });
  }
  if (effectiveEvent.type === "STOP_LISTENING" && capture) void capture.stop().catch((error) => console.warn("Capture stop failed:", error.message));

  if ((effectiveEvent.type === "SUBMIT" || effectiveEvent.type === "RETRY") && overlayState.requestId) {
    activeRequestContext?.controller.abort();
    const requestId = overlayState.requestId;
    const prompt = overlayState.prompt;
    const assembled = retrySource
      ? { modeId: retrySource.modeId, promptVersion: retrySource.promptVersion, systemPrompt: retrySource.systemPrompt }
      : assembleSystemPrompt(preferences.mode);
    const context = {
      requestId,
      prompt,
      ...assembled,
      controller: new AbortController()
    };
    activeRequestContext = context;
    if (effectiveEvent.type === "SUBMIT") lastFailedRequestContext = null;
    const selectedMode = resolveMode(context.modeId);
    if (preferences.provider === "demo") {
      setTimeout(() => {
        if (activeRequestContext?.requestId !== requestId || overlayState.requestId !== requestId) return;
        try {
          const response = demoResponse(prompt, selectedMode);
          dispatchOverlay({ type: "RESOLVE", requestId, response });
          activeRequestContext = null;
          lastFailedRequestContext = null;
          void persistResponse(prompt, response, context.modeId, context.promptVersion);
        } catch (error) {
          lastFailedRequestContext = { ...context, controller: null };
          activeRequestContext = null;
          dispatchOverlay({ type: "FAIL", requestId, error: error.message });
        }
      }, preferences.reduceMotion ? 80 : 680);
    } else {
      void (async () => {
        try {
          const key = await readProviderKey(preferences.provider);
          const response = await streamProviderResponse({
            provider: preferences.provider,
            model: preferences.model,
            prompt,
            systemPrompt: context.systemPrompt,
            key,
            signal: context.controller.signal,
            onToken: (_token, accumulated) => {
              if (activeRequestContext?.requestId === requestId) dispatchOverlay({ type: "STREAM", requestId, response: accumulated }, { animate: false });
            }
          });
          if (activeRequestContext?.requestId !== requestId || overlayState.requestId !== requestId) return;
          dispatchOverlay({ type: "RESOLVE", requestId, response });
          activeRequestContext = null;
          lastFailedRequestContext = null;
          void persistResponse(prompt, response, context.modeId, context.promptVersion);
        } catch (error) {
          if (error?.name !== "AbortError" && activeRequestContext?.requestId === requestId) {
            lastFailedRequestContext = { ...context, controller: null };
            activeRequestContext = null;
            dispatchOverlay({ type: "FAIL", requestId, error: error.message });
          }
        }
      })();
    }
  }
  return structuredClone(overlayState);
}

function queueBoundsWrite() {
  if (programmaticBounds || pickerAnchorBounds || !overlayWindow || overlayWindow.isDestroyed()) return;
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
  overlayWindow.on("will-move", () => { if (!programmaticBounds) closeModePicker({ notifyRenderer: true }); });
  overlayWindow.on("close", (event) => {
    if (!app.isQuitting && !isTest) {
      event.preventDefault();
      dispatchOverlay({ type: "HIDE" });
    }
  });
  overlayWindow.loadURL(rendererTarget("overlay"));
  overlayWindow.webContents.once("did-finish-load", () => { sendOverlayState(); sendOverlayModeModel(); });
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
    modeModel: getModeModel(),
    permissions: permissionStatus(),
    app: { version: app.getVersion(), packaged: app.isPackaged, demo: isDemo },
    onboarding: !preferences.onboardingComplete,
    keyConfigured: structuredClone(keyConfigured)
  };
}

function registerIpc() {
  ipcMain.handle("overlay:get-state", () => structuredClone(overlayState));
  ipcMain.handle("overlay:dispatch", (_event, action) => dispatchOverlay(action));
  ipcMain.handle("overlay:get-mode-model", () => getModeModel());
  ipcMain.handle("overlay:set-mode", (_event, modeId) => setActiveMode(modeId));
  ipcMain.handle("overlay:open-mode-picker", (_event, layout) => openModePicker(layout));
  ipcMain.handle("overlay:close-mode-picker", () => closeModePicker());
  ipcMain.handle("overlay:get-history", async () => {
    const local = storage ? await storage.call("list", { limit: 50 }) : [];
    return local.length ? local : structuredClone(DEMO_HISTORY);
  });
  ipcMain.handle("overlay:open-settings", async (_event, tab) => {
    if (tab !== undefined && !SETTINGS_TABS.has(tab)) throw new TypeError("Unknown settings tab");
    if (tab !== undefined && preferences.selectedSettingsTab !== tab) {
      preferences = await store.update({ selectedSettingsTab: tab });
    }
    createSettingsWindow();
    sendSettingsModel();
    return true;
  });

  ipcMain.handle("settings:get-model", () => getSettingsModel());
  ipcMain.handle("settings:update", async (_event, patch) => {
    const allowed = [
      "launchAtLogin", "launchOverlayAtLogin", "reduceMotion", "reduceTransparency",
      "protectOverlayContent", "transcriptLanguage", "outputLanguage", "microphoneId",
      "captureSystemAudio", "provider", "model", "mode", "selectedSettingsTab",
      "cloudEnabled", "integrations", "keybindings"
    ];
    const safePatch = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key)));
    if (Object.hasOwn(safePatch, "mode")) safePatch.mode = assertModeId(safePatch.mode);
    const nextPreferences = await store.update(safePatch);
    preferences = nextPreferences;
    if (Object.hasOwn(safePatch, "launchAtLogin") && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: Boolean(preferences.launchAtLogin), openAsHidden: true });
    }
    nativeTheme.themeSource = "dark";
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setContentProtection(Boolean(preferences.protectOverlayContent));
    }
    sendSettingsModel();
    if (Object.hasOwn(safePatch, "mode")) sendOverlayModeModel();
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
    ipcMain.handle("test:snapshot", () => ({
      overlay: structuredClone(overlayState),
      bounds: overlayWindow?.getBounds(),
      settings: getSettingsModel(),
      pickerOpen: Boolean(pickerAnchorBounds),
      activeRequest: activeRequestContext ? { requestId: activeRequestContext.requestId, modeId: activeRequestContext.modeId, promptVersion: activeRequestContext.promptVersion } : null,
      failedRequest: lastFailedRequestContext ? { modeId: lastFailedRequestContext.modeId, promptVersion: lastFailedRequestContext.promptVersion } : null
    }));
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
  screen.on("display-removed", () => closeModePicker({ notifyRenderer: true }));
  screen.on("display-metrics-changed", () => closeModePicker({ notifyRenderer: true }));
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
