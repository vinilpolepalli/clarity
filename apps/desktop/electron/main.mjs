import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  desktopCapturer,
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
  DEFAULT_PROVIDER_MODELS,
  createModeModel,
  DEMO_HISTORY,
  demoResponse,
  isExpandedPhase,
  reduceOverlay,
  resolveMode
} from "@clarity/domain";
import {
  COMPACT_HEIGHT,
  DEFAULT_OVERLAY_WIDTH,
  boundsEqual,
  defaultCompactBounds,
  pickerPresentationBounds,
  transitionBounds
} from "@clarity/windowing";
import {
  curatedModels,
  imageInputCapability,
  listModels,
  providerDefinition,
  providerEndpointIdentity,
  ProviderError,
  serializeProviderError,
  streamProviderResponse,
  testConnection
} from "@clarity/providers";
import { NativeCaptureClient, RollingAudioBuffer } from "@clarity/capture-client";
import { ResourceGovernor } from "@clarity/ai-core";
import { PreferenceStore } from "./persistence.mjs";
import { deleteProviderKey, hasProviderKey, readProviderKey, saveProviderKey } from "./keychain.mjs";
import { StorageService } from "./storage-service.mjs";
import { MeetingProcessingService } from "./meeting-service.mjs";
import { parseMeetingArtifact, validateMeetingArtifact } from "./meeting-artifact.mjs";
import { ScreenContextError, ScreenContextService } from "./screen-context.mjs";

const APP_ROOT = join(import.meta.dirname, "..");
const isDemo = process.env.CLARITY_DEMO === "1" || process.argv.includes("--demo");
const isTest = process.env.CLARITY_TEST === "1";
const testOnboarding = process.env.CLARITY_TEST_ONBOARDING === "1";
const SETTINGS_TABS = new Set(["general", "models", "audio", "modes", "keybindings", "profile", "privacy", "integrations", "about"]);
const preserveTestContentProtection = process.env.CLARITY_TEST_PRESERVE_CONTENT_PROTECTION === "1";
const forceTestOverlayRecreation = isTest && process.env.CLARITY_TEST_FORCE_OVERLAY_RECREATION === "1";
const testInferenceDelay = isTest ? Number(process.env.CLARITY_TEST_INFERENCE_DELAY) : Number.NaN;
const testScreenCaptureDelay = isTest ? Number(process.env.CLARITY_TEST_SCREEN_CAPTURE_DELAY) : Number.NaN;
const execFileAsync = promisify(execFile);

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
let connectionRevision = 0;
let providerConnection = untestedProviderConnection();
let activeSubmission = null;
let storage = null;
let capture = null;
let screenContext = null;
let pendingOverlayRecreation = false;
let pickerAnchorBounds = null;
const recentAudio = new RollingAudioBuffer();
const meetingGovernor = new ResourceGovernor({ maxConcurrent: 1, maxQueued: 1 });
let meetingProcessor = null;
let meetingTranscriptSequence = 0;

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

function meetingArtifactFromDemo(segments) {
  const evidence = segments.map((segment) => segment.text).join(" ");
  return validateMeetingArtifact({
    title: "Live meeting notes",
    summary: evidence.slice(0, 1_200) || "No transcript was captured yet.",
    decisions: evidence ? [{ text: "Ship the live notes slice.", evidence: evidence.slice(0, 1_000) }] : [],
    actions: evidence ? [{ text: "Verify the browser system-audio test.", owner: "Alex", due: null }] : []
  }, segments);
}

async function generateMeetingNotes(sessionId) {
  const segments = await storage?.call("getTranscript", { sessionId }) ?? [];
  if (!segments.length) return null;
  dispatchOverlay({ type: "MEETING_STATUS", meeting: { status: "generating", error: null } }, { animate: false });
  try {
    const artifact = await meetingGovernor.run(async () => {
      if (preferences.provider === "demo") return meetingArtifactFromDemo(segments);
      const key = await selectedProviderKey(preferences.provider);
      const transcript = segments.map((segment) => `[${Math.floor(segment.startedMs / 1_000)}s] ${segment.text}`).join("\n").slice(-48_000);
      const response = await streamProviderResponse({
        provider: preferences.provider,
        model: preferences.model,
        key,
        stream: true,
        maxTokens: 1_400,
        systemPrompt: "You create factual meeting notes from untrusted transcript text. Return JSON only with title, summary, decisions [{text,evidence}], actions [{text,owner,due}], and openQuestions string[]. Never invent owners or deadlines; use null when absent.",
        messages: [{ role: "user", content: `Transcript:\n${transcript}` }]
      });
      return parseMeetingArtifact(response, segments);
    });
    const saved = await storage?.call("upsertArtifact", {
      id: `live-meeting-notes-${sessionId}`,
      sessionId,
      kind: "live-meeting-notes",
      content: artifact
    });
    dispatchOverlay({ type: "MEETING_STATUS", meeting: { status: "ready", artifact: saved?.content ?? artifact, updatedAt: Date.now(), error: null } }, { animate: false });
    return artifact;
  } catch (error) {
    dispatchOverlay({ type: "MEETING_STATUS", meeting: { status: "error", error: error instanceof Error ? error.message : "Clarity could not update live notes." } }, { animate: false });
    return null;
  }
}

function handleMeetingProcessorEvent(event) {
  const sessionId = overlayState.meeting?.sessionId;
  if (!sessionId) return;
  if (event.type === "status") {
    dispatchOverlay({ type: "MEETING_STATUS", meeting: { status: event.status } }, { animate: false });
    return;
  }
  if (event.type === "transcript") {
    const sequence = meetingTranscriptSequence++;
    void storage?.call("appendSegment", {
      id: `${sessionId}-segment-${sequence}`,
      sessionId,
      sequence,
      text: event.text,
      startedMs: event.startedMs,
      endedMs: event.endedMs
    }).then(() => {
      dispatchOverlay({ type: "MEETING_STATUS", meeting: { transcriptCount: sequence + 1, status: "transcribing" } }, { animate: false });
      return generateMeetingNotes(sessionId);
    }).catch((error) => dispatchOverlay({ type: "MEETING_STATUS", meeting: { status: "error", error: error.message } }, { animate: false }));
    return;
  }
  if (event.type === "failure") {
    dispatchOverlay({ type: "MEETING_STATUS", meeting: { status: "error", error: event.message } }, { animate: false });
    return;
  }
  if (event.type === "stopped") {
    void generateMeetingNotes(sessionId).then((artifact) => {
      if (!artifact && overlayState.meeting.status !== "error") {
        dispatchOverlay({ type: "MEETING_STATUS", meeting: { status: "ready", updatedAt: Date.now() } }, { animate: false });
      }
    }).finally(() => {
      void storage?.call("completeMeetingSession", { sessionId });
      meetingProcessor?.close();
      meetingProcessor = null;
    });
  }
}

function startMeetingProcessor(meeting) {
  meetingTranscriptSequence = 0;
  meetingProcessor?.close();
  meetingProcessor = new MeetingProcessingService({ onEvent: handleMeetingProcessorEvent });
  meetingProcessor.start({
    sessionId: meeting.sessionId,
    source: meeting.source,
    whisperExecutable: preferences.whisperExecutable,
    whisperModelPath: preferences.whisperModelPath
  });
}

async function preflightMeetingNotes() {
  if (isTest) return null;
  if (!preferences.whisperModelPath || !existsSync(preferences.whisperModelPath)) {
    return "Choose an existing local Whisper model file in Audio settings before starting live notes.";
  }
  if (preferences.provider === "demo" || !keyConfigured[preferences.provider]) {
    return "Choose a BYOK generation provider and save its API key before starting live notes.";
  }
  try {
    await execFileAsync(preferences.whisperExecutable, ["--help"], { timeout: 5_000, maxBuffer: 256 * 1_024 });
  } catch (error) {
    if (error?.code === "ENOENT") return "Choose a working local Whisper executable in Audio settings before starting live notes.";
    if (error?.code === "EACCES") return "The configured Whisper executable is not permitted to run.";
  }
  return null;
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

async function runConversationInference({ context, createConversation, persistUser }) {
  const { requestId } = context;
  const snapshot = structuredClone(overlayState);
  const conversationId = snapshot.conversationId;
  const assistantIndex = snapshot.messages.findIndex((item) => item.id === snapshot.activeAssistantMessageId);
  const assistantMessage = snapshot.messages[assistantIndex];
  const userIndex = [...snapshot.messages].map((item) => item.role).lastIndexOf("user");
  const userMessage = snapshot.messages[userIndex];
  const providerMessages = snapshot.messages
    .filter((item) => (item.role === "user" || item.role === "assistant") && item.content && item.status !== "error")
    .map(({ role, content }) => ({ role, content }));
  const selectedMode = resolveMode(context.modeId);
  const requestScreenContext = screenContext;
  const targetDisplayId = String(screen.getDisplayMatching(overlayWindow.getBounds()).id);
  const request = {
    requestId,
    provider: preferences.provider,
    model: preferences.model,
    imageCapability: currentImageInput().capability,
    screenContextEnabled: Boolean(preferences.screenContextEnabled),
    targetDisplayId
  };
  activeSubmission = { requestId, phase: request.screenContextEnabled ? "capturing" : "transmitting" };
  screenContext?.clear();
  dispatchOverlay({ type: "SCREEN_CAPTURE_CLEARED" }, { animate: false });
  dispatchOverlay({ type: "SET_SCREEN_CAPABILITY", capability: request.imageCapability }, { animate: false });

  try {
    if (createConversation) {
      await storage?.call("createConversation", {
        id: conversationId,
        title: snapshot.conversationTitle || "Untitled conversation",
        mode: context.modeId,
        modePromptVersion: context.promptVersion
      });
    }
    if (persistUser && userMessage) await persistConversationMessage(conversationId, userMessage, userIndex);

    let image;
    if (request.screenContextEnabled) {
      if (request.imageCapability !== "supported") {
        const unknown = request.imageCapability === "unknown";
        const message = unknown
          ? "Confirm that this exact model accepts image inputs in Models settings before using screen context."
          : "The selected model does not accept image inputs. Choose a vision model or turn off Uses screen.";
        dispatchOverlay({ type: "SCREEN_CAPTURE_FAILED", requestId, status: "unsupported", errorCode: unknown ? "capability-unknown" : "model-unsupported", error: message }, { animate: false });
        dispatchOverlay({ type: "FAIL", requestId, error: message });
        lastFailedRequestContext = { ...context, controller: null };
        activeRequestContext = null;
        return;
      }
      dispatchOverlay({ type: "SCREEN_CAPTURE_STARTED", requestId }, { animate: false });
      if (!requestScreenContext) throw new ScreenContextError("capture-unavailable", "Screen capture is not available yet. Try again.");
      const metadata = await requestScreenContext.capture(requestId, request, { signal: context.controller.signal });
      if (overlayState.requestId !== requestId) return;
      dispatchOverlay({ type: "SCREEN_CAPTURE_ATTACHED", requestId, attachmentId: metadata.id, capturedAt: metadata.capturedAt, displayId: metadata.displayId }, { animate: false });
      image = requestScreenContext.readForProvider(requestId);
      if (!image) throw new ScreenContextError("attachment-expired", "The screen capture expired before it could be sent. Try again.");
    }

    if (activeSubmission?.requestId === requestId) activeSubmission.phase = "transmitting";
    if (pendingOverlayRecreation) recreateOverlayWindowForContentProtection();
    let response;
    if (request.provider === "demo") {
      const milliseconds = Number.isFinite(testInferenceDelay) && testInferenceDelay >= 0
        ? testInferenceDelay
        : preferences.reduceMotion ? 80 : 680;
      await delay(milliseconds, context.controller.signal);
      response = demoResponse(userMessage?.content ?? snapshot.lastPrompt, selectedMode);
    } else {
      const key = await readProviderKey(request.provider);
      response = await streamProviderResponse({
        provider: request.provider,
        model: request.model,
        messages: providerMessages,
        systemPrompt: context.systemPrompt,
        key,
        image,
        signal: context.controller.signal,
        onToken: (_token, accumulated) => {
          if (activeRequestContext?.requestId === requestId) {
            dispatchOverlay({ type: "STREAM", requestId, response: accumulated }, { animate: false });
          }
        }
      });
    }

    if (activeRequestContext?.requestId !== requestId || overlayState.requestId !== requestId) return;
    await persistConversationMessage(conversationId, { ...assistantMessage, content: response }, assistantIndex);
    dispatchOverlay({ type: "RESOLVE", requestId, response });
    activeRequestContext = null;
    lastFailedRequestContext = null;
  } catch (error) {
    if (error?.name === "AbortError") {
      if (activeSubmission?.requestId === requestId && activeSubmission.phase === "capturing") {
        requestScreenContext?.clear(requestId);
        dispatchOverlay({ type: "SCREEN_CAPTURE_CLEARED" }, { animate: false });
      }
      if (activeRequestContext?.requestId === requestId) activeRequestContext = null;
      return;
    }
    if (activeRequestContext?.requestId === requestId) {
      if (error instanceof ScreenContextError) {
        dispatchOverlay({ type: "SCREEN_CAPTURE_FAILED", requestId, status: screenFailureStatus(error), errorCode: error.code, error: error.message }, { animate: false });
      } else if (request.screenContextEnabled && overlayState.screenContext.status === "capturing") {
        dispatchOverlay({ type: "SCREEN_CAPTURE_FAILED", requestId, status: "error", errorCode: "capture-failed", error: "Clarity could not capture the current display. Try again." }, { animate: false });
      }
      lastFailedRequestContext = { ...context, controller: null };
      activeRequestContext = null;
      dispatchOverlay({ type: "FAIL", requestId, error: error instanceof Error ? error.message : "Clarity could not finish that response." });
    }
  } finally {
    if (activeSubmission?.requestId === requestId) activeSubmission = null;
    if (pendingOverlayRecreation) recreateOverlayWindowForContentProtection();
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

function currentImageInput() {
  const provider = preferences.provider;
  const endpoint = provider === "demo" ? "demo://local" : providerDefinition(provider).endpoint;
  const endpointIdentity = providerEndpointIdentity(provider, endpoint);
  const normalizedModel = String(preferences.model ?? "").trim().toLowerCase();
  const overrideKey = `${endpointIdentity}:${normalizedModel}`;
  return {
    capability: isTest && process.env.CLARITY_TEST_SCREEN_CONTEXT === "1" ? "supported" : imageInputCapability({ provider, model: preferences.model, endpoint, overrides: preferences.imageInputOverrides }),
    endpointIdentity,
    overrideKey,
    explicitOverride: preferences.imageInputOverrides?.[overrideKey] ?? null
  };
}

function publishScreenCapability() {
  const { capability } = currentImageInput();
  overlayState = reduceOverlay(overlayState, { type: "SET_SCREEN_CAPABILITY", capability });
  sendOverlayState();
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

function hasLegacyDefaultCompactBounds(bounds) {
  return Number(bounds?.width) === 590 && Number(bounds?.height) === 88;
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
  if (pickerAnchorBounds && event.type !== "SET_PROMPT") closeModePicker({ notifyRenderer: true });
  let effectiveEvent = event;
  let retrySource = null;
  if (event.type === "RETRY") {
    retrySource = lastFailedRequestContext;
    if (!retrySource) return structuredClone(overlayState);
    effectiveEvent = { type: "RETRY", prompt: retrySource.prompt, requestId: crypto.randomUUID() };
  }
  if (event.type === "START_LISTENING" && !event.sessionId) {
    effectiveEvent = {
      ...event,
      sessionId: crypto.randomUUID(),
      source: ["microphone", "system", "both"].includes(event.source) ? event.source : preferences.meetingAudioSource
    };
  }
  const previousPhase = overlayState.phase;
  const previousRequestId = overlayState.requestId;
  const previousConversationId = overlayState.conversationId;
  overlayState = reduceOverlay(overlayState, effectiveEvent);
  applyOverlayPresentation(previousPhase, options.animate !== false);
  sendOverlayState();

  if (effectiveEvent.type === "START_LISTENING") {
    const meeting = overlayState.meeting;
    void storage?.call("createMeetingSession", { id: meeting.sessionId, title: "Live meeting", captureSource: meeting.source })
      .then(async () => {
        const preflightError = await preflightMeetingNotes();
        if (preflightError) {
          dispatchOverlay({ type: "MEETING_STATUS", meeting: { status: "error", error: preflightError } }, { animate: false });
          dispatchOverlay({ type: "STOP_LISTENING" }, { animate: false });
          void storage?.call("completeMeetingSession", { sessionId: meeting.sessionId });
          return;
        }
        if (overlayState.meeting.sessionId !== meeting.sessionId || !overlayState.startedAt) {
          void storage?.call("completeMeetingSession", { sessionId: meeting.sessionId });
          return;
        }
        startMeetingProcessor(meeting);
        if (capture) {
          await capture.start({ microphone: meeting.source !== "system", systemAudio: meeting.source !== "microphone" });
        }
      })
      .catch((error) => {
        dispatchOverlay({ type: "MEETING_STATUS", meeting: { status: "error", error: `Capture could not start: ${error.message}` } }, { animate: false });
        dispatchOverlay({ type: "STOP_LISTENING" }, { animate: false });
        void storage?.call("completeMeetingSession", { sessionId: meeting.sessionId });
      });
  }
  if (effectiveEvent.type === "STOP_LISTENING") meetingProcessor?.stop();
  if (effectiveEvent.type === "STOP_LISTENING" && capture) void capture.stop().catch((error) => console.warn("Capture stop failed:", error.message));

  if (event.type === "CLEAR" || event.type === "LOAD_CONVERSATION") {
    activeRequestContext?.controller.abort();
    activeRequestContext = null;
    lastFailedRequestContext = null;
    screenContext?.clear();
    activeSubmission = null;
    if (event.type === "LOAD_CONVERSATION") {
      overlayState = reduceOverlay(overlayState, { type: "SCREEN_CAPTURE_CLEARED" });
      sendOverlayState();
    }
  }

  if ((effectiveEvent.type === "SUBMIT" || effectiveEvent.type === "RETRY") && overlayState.requestId && overlayState.requestId !== previousRequestId) {
    activeRequestContext?.controller.abort();
    const requestId = overlayState.requestId;
    const prompt = retrySource?.prompt ?? overlayState.lastPrompt;
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
    void runConversationInference({
      context,
      createConversation: effectiveEvent.type === "SUBMIT" && !previousConversationId,
      persistUser: effectiveEvent.type === "SUBMIT"
    });
  }
  return structuredClone(overlayState);
}

function screenFailureStatus(error) {
  if (error instanceof ScreenContextError && error.code.startsWith("permission-")) return "permission-blocked";
  return "error";
}

async function setScreenContextEnabled(enabled) {
  const next = await store.update({ screenContextEnabled: Boolean(enabled) });
  preferences = next;
  applyScreenContextPreference(preferences.screenContextEnabled);
  sendSettingsModel();
  return structuredClone(overlayState);
}

function applyScreenContextPreference(enabled) {
  dispatchOverlay({ type: "SET_SCREEN_CONTEXT_ENABLED", enabled: Boolean(enabled) }, { animate: false });
  if (!enabled && activeSubmission?.phase === "capturing") {
    const requestId = activeSubmission.requestId;
    if (activeRequestContext?.requestId === requestId) {
      const requestContext = activeRequestContext;
      lastFailedRequestContext = { ...requestContext, controller: null };
      activeRequestContext = null;
      requestContext.controller.abort();
    }
    screenContext?.clear(requestId);
    dispatchOverlay({ type: "SCREEN_CAPTURE_CLEARED" }, { animate: false });
    dispatchOverlay({ type: "FAIL", requestId, error: "Screen context was turned off before capture completed." });
  }
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
  overlayWindow.on("will-move", () => { if (!programmaticBounds) closeModePicker({ notifyRenderer: true }); });
  overlayWindow.on("close", (event) => {
    if (!app.isQuitting && !isTest) {
      event.preventDefault();
      dispatchOverlay({ type: "HIDE" });
    }
  });
  overlayWindow.loadURL(rendererTarget("overlay"));
  const captureFixture = isTest && process.env.CLARITY_TEST_SCREEN_CONTEXT === "1"
    ? async ({ targetDisplayId }) => {
        if (Number.isFinite(testScreenCaptureDelay) && testScreenCaptureDelay > 0) await delay(testScreenCaptureDelay);
        return {
          bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
          mediaType: "image/png",
          width: 1,
          height: 1,
          displayId: targetDisplayId
        };
      }
    : null;
  const createdWindow = overlayWindow;
  if (screenContext) screenContext.setOverlayWindow(createdWindow);
  else screenContext = new ScreenContextService({ desktopCapturer, screen, systemPreferences, overlayWindow: createdWindow, captureFixture });
  createdWindow.webContents.on("render-process-gone", () => {
    if (overlayWindow !== createdWindow) return;
    screenContext?.clear();
    overlayState = reduceOverlay(overlayState, { type: "SCREEN_CAPTURE_CLEARED" });
    sendOverlayState();
  });
  createdWindow.webContents.once("did-finish-load", () => {
    if (overlayWindow === createdWindow) {
      sendOverlayState();
      sendOverlayModeModel();
    }
    createdWindow.webContents.on("did-start-loading", () => {
      if (overlayWindow !== createdWindow) return;
      screenContext?.clear();
      overlayState = reduceOverlay(overlayState, { type: "SCREEN_CAPTURE_CLEARED" });
      sendOverlayState();
    });
  });
  if (showWhenReady) {
    const restoredWindow = overlayWindow;
    restoredWindow.once("ready-to-show", () => {
      if (!restoredWindow.isDestroyed() && overlayState.phase !== "hidden") restoredWindow.showInactive();
    });
  }
}

function recreateOverlayWindowForContentProtection() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (activeSubmission?.phase === "capturing") {
    pendingOverlayRecreation = true;
    return;
  }
  pendingOverlayRecreation = false;
  const previousWindow = overlayWindow;
  const initialBounds = previousWindow.getBounds();
  const showWhenReady = previousWindow.isVisible() && overlayState.phase !== "hidden";
  previousWindow.removeAllListeners("close");
  if (overlayWindow === previousWindow) overlayWindow = null;
  previousWindow.destroy();
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
    modeModel: getModeModel(),
    permissions: permissionStatus(),
    app: { version: app.getVersion(), packaged: app.isPackaged, demo: isDemo },
    onboarding: !preferences.onboardingComplete,
    keyConfigured: structuredClone(keyConfigured),
    defaultProviderModels: structuredClone(DEFAULT_PROVIDER_MODELS),
    imageInput: currentImageInput(),
    providerCatalog,
    providerConnection: structuredClone(providerConnection)
  };
}

function isAuthorizedOverlaySender(event) {
  if (!overlayWindow || overlayWindow.isDestroyed() || event.sender.id !== overlayWindow.webContents.id) return false;
  return event.senderFrame?.url === rendererTarget("overlay");
}

function registerIpc() {
  ipcMain.handle("overlay:get-state", () => structuredClone(overlayState));
  ipcMain.handle("overlay:dispatch", async (_event, action) => {
    if (action?.type === "SET_SCREEN_CONTEXT_ENABLED") return setScreenContextEnabled(action.enabled);
    return dispatchOverlay(action);
  });
  ipcMain.handle("overlay:get-mode-model", () => getModeModel());
  ipcMain.handle("overlay:set-mode", (_event, modeId) => setActiveMode(modeId));
  ipcMain.handle("overlay:open-mode-picker", (_event, layout) => openModePicker(layout));
  ipcMain.handle("overlay:close-mode-picker", () => closeModePicker());
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
    const assembled = assembleSystemPrompt(preferences.mode);
    return storage.call("ensureConversation", { ...conversation, mode: assembled.modeId, modePromptVersion: assembled.promptVersion });
  });
  ipcMain.handle("overlay:retry-meeting-notes", async (event) => {
    if (!isAuthorizedOverlaySender(event)) throw new Error("Meeting notes access denied");
    const sessionId = overlayState.meeting?.sessionId;
    if (!sessionId) throw new Error("No active meeting notes session");
    await generateMeetingNotes(sessionId);
    return structuredClone(overlayState.meeting);
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
  ipcMain.handle("overlay:open-model-settings", async () => {
    preferences = await store.update({ selectedSettingsTab: "models" });
    createSettingsWindow();
    sendSettingsModel();
    return true;
  });
  ipcMain.handle("overlay:get-screen-preview", (event, attachmentId) => {
    if (!isAuthorizedOverlaySender(event)) throw new Error("Screen preview access denied");
    return screenContext?.getPreview(String(attachmentId ?? "")) ?? null;
  });
  ipcMain.handle("overlay:open-screen-permission-settings", async (event) => {
    if (!isAuthorizedOverlaySender(event)) throw new Error("Permission settings access denied");
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    return true;
  });
  ipcMain.handle("overlay:recheck-screen-permission", (event) => {
    if (!isAuthorizedOverlaySender(event)) throw new Error("Permission status access denied");
    return permissionStatus().screen;
  });

  ipcMain.handle("settings:get-model", () => getSettingsModel());
  ipcMain.handle("settings:update", async (_event, patch) => {
    const allowed = [
      "launchAtLogin", "launchOverlayAtLogin", "reduceMotion", "reduceTransparency",
      "protectOverlayContent", "transcriptLanguage", "outputLanguage", "microphoneId",
      "captureSystemAudio", "meetingAudioSource", "whisperExecutable", "whisperModelPath", "provider", "model", "mode", "selectedSettingsTab",
      "cloudEnabled", "integrations", "keybindings", "screenContextEnabled", "imageInputOverrides", "customModels"
    ];
    const safePatch = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key)));
    if (Object.hasOwn(safePatch, "mode")) safePatch.mode = assertModeId(safePatch.mode);
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
      if (Object.hasOwn(safePatch, "protectOverlayContent") && (applied !== requested || forceTestOverlayRecreation)) {
        // Some macOS releases keep NSWindowSharingNone sticky on an existing window.
        // Rebuilding only the overlay applies the requested state without losing UI state or geometry.
        recreateOverlayWindowForContentProtection();
      }
    }
    if (Object.hasOwn(safePatch, "screenContextEnabled")) {
      applyScreenContextPreference(preferences.screenContextEnabled);
    }
    if (Object.hasOwn(safePatch, "provider") || Object.hasOwn(safePatch, "model") || Object.hasOwn(safePatch, "imageInputOverrides")) publishScreenCapability();
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
      pickerOpen: Boolean(pickerAnchorBounds),
      activeRequest: activeRequestContext ? { requestId: activeRequestContext.requestId, modeId: activeRequestContext.modeId, promptVersion: activeRequestContext.promptVersion } : null,
      failedRequest: lastFailedRequestContext ? { modeId: lastFailedRequestContext.modeId, promptVersion: lastFailedRequestContext.promptVersion } : null,
      contentProtected: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isContentProtected()),
      resizable: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isResizable()),
      windowId: overlayWindow?.id ?? null
    }));
    ipcMain.handle("test:set-bounds", (_event, bounds) => {
      const current = overlayWindow.getBounds();
      overlayWindow.setBounds({ ...current, ...bounds }, false);
      return overlayWindow.getBounds();
    });
    ipcMain.handle("test:meeting-frame", (_event, frame) => {
      if (!meetingProcessor) throw new Error("Meeting processor is not running");
      meetingProcessor.appendFrame({
        pcm: Buffer.from(frame?.pcm ?? []),
        source: frame?.source ?? "system",
        sampleRate: frame?.sampleRate ?? 16_000,
        channels: frame?.channels ?? 1
      });
      return true;
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
  if (hasLegacyDefaultCompactBounds(preferences.overlayCompactBounds)) {
    preferences = await store.update({
      overlayCompactBounds: {
        ...preferences.overlayCompactBounds,
        width: DEFAULT_OVERLAY_WIDTH,
        height: COMPACT_HEIGHT
      }
    });
  }
  storage = new StorageService({ directory: join(app.getPath("userData"), "local-data") });
  await storage.start();
  const captureExecutable = app.isPackaged
    ? join(process.resourcesPath, "native", "ClarityCapture")
    : join(APP_ROOT, "..", "..", "native", "ClarityCapture", ".build", "debug", "ClarityCapture");
  if (existsSync(captureExecutable) && !isTest) {
    capture = new NativeCaptureClient({
      executable: captureExecutable,
      onFrame: (frame) => {
        recentAudio.append(frame.pcm);
        if (overlayState.startedAt && meetingProcessor) meetingProcessor.appendFrame(frame);
      },
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
  overlayState = createInitialOverlayState(showOverlayAtBoot, preferences.screenContextEnabled);
  overlayState = reduceOverlay(overlayState, { type: "MEETING_STATUS", meeting: { source: preferences.meetingAudioSource } });
  overlayState = reduceOverlay(overlayState, { type: "SET_SCREEN_CAPABILITY", capability: currentImageInput().capability });
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
    sendSettingsModel();
  });
  app.on("will-quit", () => { globalShortcut.unregisterAll(); screenContext?.dispose(); meetingProcessor?.close(); storage?.close(); void capture?.close(); });
  app.on("window-all-closed", (event) => {
    if (isTest) app.quit();
    else if (process.platform === "darwin") event?.preventDefault?.();
  });
}
