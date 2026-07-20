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
import {
  curatedModels,
  listModels,
  ProviderError,
  serializeProviderError,
  streamProviderResponse,
  testConnection
} from "@clarity/providers";
import { NativeCaptureClient, RollingAudioBuffer } from "@clarity/capture-client";
import { PreferenceStore } from "./persistence.mjs";
import { deleteProviderKey, hasProviderKey, readProviderKey, saveProviderKey } from "./keychain.mjs";
import { StorageService } from "./storage-service.mjs";

const APP_ROOT = join(import.meta.dirname, "..");
const isDemo = process.env.CLARITY_DEMO === "1" || process.argv.includes("--demo");
const isTest = process.env.CLARITY_TEST === "1";
const testOnboarding = process.env.CLARITY_TEST_ONBOARDING === "1";
const preserveTestContentProtection = process.env.CLARITY_TEST_PRESERVE_CONTENT_PROTECTION === "1";
const testInferenceDelay = isTest ? Number(process.env.CLARITY_TEST_INFERENCE_DELAY) : Number.NaN;

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
let connectionRevision = 0;
let providerConnection = untestedProviderConnection();
let activeInference = null;
let storage = null;
let capture = null;
const recentAudio = new RollingAudioBuffer();

function untestedProviderConnection() {
  return { state: "untested", provider: null, model: null, testedAt: null, latencyMs: null, error: null };
}

function invalidateProviderConnection() {
  connectionRevision += 1;
  providerConnection = untestedProviderConnection();
}

async function selectedProviderKey(provider) {
  if (!keyConfigured[provider]) {
    throw new ProviderError("Save this provider's API key before testing the connection.", { code: "key_missing", provider });
  }
  return readProviderKey(provider);
}

function applyOverlayContentProtection() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  const requested = Boolean(preferences.protectOverlayContent);
  overlayWindow.setContentProtection(requested);
  return overlayWindow.isContentProtected();
}

async function persistConversationMessage(conversationId, message, sequence) {
  if (!storage) return;
  await storage.call("appendMessage", {
    id: message.id,
    sessionId: conversationId,
    sequence,
    role: message.role,
    content: message.content,
    status: "complete",
    createdAt: message.createdAt
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    }, { once: true });
  });
}

async function runConversationInference({ requestId, createConversation, persistUser }) {
  const snapshot = structuredClone(overlayState);
  const conversationId = snapshot.conversationId;
  const assistantIndex = snapshot.messages.findIndex((item) => item.id === snapshot.activeAssistantMessageId);
  const assistantMessage = snapshot.messages[assistantIndex];
  const userIndex = [...snapshot.messages].map((item) => item.role).lastIndexOf("user");
  const userMessage = snapshot.messages[userIndex];
  const providerMessages = snapshot.messages
    .filter((item) => (item.role === "user" || item.role === "assistant") && item.content && item.status !== "error")
    .map(({ role, content }) => ({ role, content }));
  const inference = activeInference;

  try {
    if (createConversation) {
      await storage?.call("createConversation", {
        id: conversationId,
        title: snapshot.conversationTitle || "Untitled conversation",
        mode: preferences.mode
      });
    }
    if (persistUser && userMessage) await persistConversationMessage(conversationId, userMessage, userIndex);

    let response;
    if (preferences.provider === "demo") {
      const milliseconds = Number.isFinite(testInferenceDelay) && testInferenceDelay >= 0
        ? testInferenceDelay
        : preferences.reduceMotion ? 80 : 680;
      await delay(milliseconds, inference.signal);
      response = demoResponse(userMessage?.content ?? snapshot.lastPrompt);
    } else {
      const key = await readProviderKey(preferences.provider);
      response = await streamProviderResponse({
        provider: preferences.provider,
        model: preferences.model,
        messages: providerMessages,
        key,
        signal: inference.signal,
        onToken: (_token, accumulated) => dispatchOverlay({ type: "STREAM", requestId, response: accumulated }, { animate: false })
      });
    }

    if (overlayState.requestId !== requestId) return;
    await persistConversationMessage(conversationId, { ...assistantMessage, content: response }, assistantIndex);
    dispatchOverlay({ type: "RESOLVE", requestId, response });
  } catch (error) {
    if (error?.name !== "AbortError") dispatchOverlay({ type: "FAIL", requestId, error: error.message });
  }
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
  applyOverlayContentProtection();
  if (!overlayWindow.isVisible()) overlayWindow.showInactive();
}

function dispatchOverlay(event, options = {}) {
  const previousPhase = overlayState.phase;
  const previousRequestId = overlayState.requestId;
  const previousConversationId = overlayState.conversationId;
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

  if (event.type === "CLEAR") activeInference?.abort();

  if ((event.type === "SUBMIT" || event.type === "RETRY") && overlayState.requestId && overlayState.requestId !== previousRequestId) {
    const requestId = overlayState.requestId;
    activeInference?.abort();
    activeInference = new AbortController();
    void runConversationInference({
      requestId,
      createConversation: event.type === "SUBMIT" && !previousConversationId,
      persistUser: event.type === "SUBMIT"
    });
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

function createOverlayWindow({ initialBounds, showWhenReady = false } = {}) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const initial = initialBounds ?? preferences.overlayCompactBounds ?? defaultCompactBounds(workArea);
  const bounds = initialBounds ?? transitionBounds(initial, displayForBounds(initial), false, rememberedGeometry());
  overlayWindow = new BrowserWindow({
    ...bounds,
    title: "Clarity Overlay",
    frame: false,
    transparent: !preferences.reduceTransparency,
    backgroundColor: preferences.reduceTransparency ? "#111113" : "#00000000",
    show: false,
    resizable: Boolean(initialBounds && isExpandedPhase(overlayState.phase)),
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
  if (initialBounds && isExpandedPhase(overlayState.phase)) {
    overlayWindow.setMinimumSize(420, 300);
    overlayWindow.setMaximumSize(760, displayForBounds(initialBounds).height);
  }
  applyOverlayContentProtection();
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
  if (showWhenReady) {
    const restoredWindow = overlayWindow;
    restoredWindow.once("ready-to-show", () => {
      if (!restoredWindow.isDestroyed() && overlayState.phase !== "hidden") restoredWindow.showInactive();
    });
  }
}

function recreateOverlayWindowForContentProtection() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const previousWindow = overlayWindow;
  const initialBounds = previousWindow.getBounds();
  const showWhenReady = previousWindow.isVisible() && overlayState.phase !== "hidden";
  previousWindow.removeAllListeners("close");
  previousWindow.destroy();
  if (overlayWindow === previousWindow) overlayWindow = null;
  createOverlayWindow({ initialBounds, showWhenReady });
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
  const provider = preferences.provider;
  const providerCatalog = provider === "demo"
    ? { curated: [{ id: "clarity-demo", label: "Clarity Demo", description: "Offline", source: "curated" }], discoverySupported: false }
    : { curated: curatedModels(provider), discoverySupported: provider === "nvidia" || provider === "openai" };
  return {
    preferences: structuredClone(preferences),
    permissions: permissionStatus(),
    app: { version: app.getVersion(), packaged: app.isPackaged, demo: isDemo },
    onboarding: !preferences.onboardingComplete,
    keyConfigured: structuredClone(keyConfigured),
    providerCatalog,
    providerConnection: structuredClone(providerConnection)
  };
}

function registerIpc() {
  ipcMain.handle("overlay:get-state", () => structuredClone(overlayState));
  ipcMain.handle("overlay:dispatch", (_event, action) => dispatchOverlay(action));
  ipcMain.handle("overlay:get-history", async () => {
    const local = storage ? await storage.call("list", { limit: 50 }) : [];
    return local.length ? local : structuredClone(DEMO_HISTORY);
  });
  ipcMain.handle("overlay:get-conversation", async (_event, id) => {
    const local = storage ? await storage.call("get", { id }) : null;
    if (local) return local;
    const demo = DEMO_HISTORY.find((item) => item.id === id);
    if (!demo) return null;
    const createdAt = new Date().toISOString();
    const messages = [
      demo.prompt ? { id: `${demo.id}-user`, role: "user", content: demo.prompt, status: "complete", createdAt } : null,
      demo.response ? { id: `${demo.id}-assistant`, role: "assistant", content: demo.response, status: "complete", createdAt } : null
    ].filter(Boolean);
    const conversation = {
      id: demo.id,
      title: demo.title,
      messages
    };
    if (!storage) return conversation;
    return storage.call("ensureConversation", { ...conversation, mode: preferences.mode });
  });
  ipcMain.handle("overlay:open-settings", () => { createSettingsWindow(); return true; });

  ipcMain.handle("settings:get-model", () => getSettingsModel());
  ipcMain.handle("settings:update", async (_event, patch) => {
    const allowed = [
      "launchAtLogin", "launchOverlayAtLogin", "reduceMotion", "reduceTransparency",
      "protectOverlayContent", "transcriptLanguage", "outputLanguage", "microphoneId",
      "captureSystemAudio", "provider", "model", "mode", "selectedSettingsTab",
      "cloudEnabled", "integrations", "keybindings", "customModels"
    ];
    const safePatch = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key)));
    const connectionChanged = (Object.hasOwn(safePatch, "provider") && safePatch.provider !== preferences.provider)
      || (Object.hasOwn(safePatch, "model") && safePatch.model !== preferences.model);
    preferences = await store.update(safePatch);
    if (connectionChanged) invalidateProviderConnection();
    if (Object.hasOwn(safePatch, "launchAtLogin") && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: Boolean(preferences.launchAtLogin), openAsHidden: true });
    }
    nativeTheme.themeSource = "dark";
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const requested = Boolean(preferences.protectOverlayContent);
      const applied = applyOverlayContentProtection();
      if (Object.hasOwn(safePatch, "protectOverlayContent") && applied !== requested) {
        // Some macOS releases keep NSWindowSharingNone sticky on an existing window.
        // Rebuilding only the overlay applies the requested state without losing UI state or geometry.
        recreateOverlayWindowForContentProtection();
      }
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
    invalidateProviderConnection();
    sendSettingsModel();
    return getSettingsModel();
  });
  ipcMain.handle("settings:delete-provider-key", async (_event, provider) => {
    await deleteProviderKey(provider);
    keyConfigured[provider] = false;
    invalidateProviderConnection();
    sendSettingsModel();
    return getSettingsModel();
  });
  ipcMain.handle("settings:list-provider-models", async () => {
    const provider = preferences.provider;
    if (provider === "demo") return { ok: true, models: [] };
    try {
      const key = await selectedProviderKey(provider);
      return { ok: true, models: await listModels({ provider, key }) };
    } catch (error) {
      return { ok: false, models: [], error: serializeProviderError(error, provider) };
    }
  });
  ipcMain.handle("settings:test-provider-connection", async () => {
    const provider = preferences.provider;
    const model = preferences.model;
    if (provider === "demo") return getSettingsModel();
    const revision = ++connectionRevision;
    providerConnection = { state: "testing", provider, model, testedAt: null, latencyMs: null, error: null };
    sendSettingsModel();
    try {
      const key = await selectedProviderKey(provider);
      const result = await testConnection({ provider, model, key });
      if (revision === connectionRevision && provider === preferences.provider && model === preferences.model) {
        providerConnection = { state: "connected", provider, model, testedAt: result.testedAt, latencyMs: result.latencyMs, error: null };
      }
    } catch (error) {
      if (revision === connectionRevision) {
        providerConnection = { state: "error", provider, model, testedAt: new Date().toISOString(), latencyMs: null, error: serializeProviderError(error, provider) };
      }
    }
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
      contentProtected: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isContentProtected()),
      resizable: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isResizable())
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
  keyConfigured = isTest
    ? { openai: false, anthropic: false, nvidia: false }
    : Object.fromEntries(await Promise.all(["openai", "anthropic", "nvidia"].map(async (provider) => [provider, await hasProviderKey(provider)])));
  if (isDemo || (isTest && !testOnboarding)) {
    const testOverrides = isTest && !preserveTestContentProtection ? { protectOverlayContent: false } : {};
    preferences = await store.update({ onboardingComplete: true, reduceMotion: isTest, ...testOverrides });
  }
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
