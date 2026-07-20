/** @typedef {'hidden'|'compact-idle'|'compact-listening'|'expanded-empty'|'expanded-response'|'expanded-error'|'expanded-history'} OverlayPhase */

export const OVERLAY_PHASES = Object.freeze([
  "hidden",
  "compact-idle",
  "compact-listening",
  "expanded-empty",
  "expanded-response",
  "expanded-error",
  "expanded-history"
]);

export const DEFAULT_PREFERENCES = Object.freeze({
  version: 1,
  onboardingComplete: false,
  launchAtLogin: false,
  launchOverlayAtLogin: true,
  reduceMotion: false,
  reduceTransparency: false,
  protectOverlayContent: true,
  transcriptLanguage: "auto",
  outputLanguage: "English",
  microphoneId: "default",
  captureSystemAudio: true,
  screenContextEnabled: false,
  provider: "demo",
  model: "clarity-demo",
  providerModels: {
    demo: "clarity-demo",
    nvidia: "meta/llama-3.2-11b-vision-instruct",
    openai: "gpt-4.1-mini",
    anthropic: "claude-sonnet"
  },
  imageInputOverrides: {},
  mode: "meeting",
  selectedSettingsTab: "general",
  cloudEnabled: false,
  integrations: { notion: false, googleCalendar: false },
  keybindings: {
    toggleOverlay: "CommandOrControl+Shift+Space",
    toggleListening: "CommandOrControl+Shift+L",
    submit: "CommandOrControl+Enter"
  }
});

export const DEMO_HISTORY = Object.freeze([
  {
    id: "demo-decision",
    title: "Launch readiness review",
    timestamp: "Today, 10:42 AM",
    excerpt: "Decisions, owners, and the remaining release gate.",
    response: "The team agreed to keep provider keys on this Mac, finish the overlay parity gate before visual differentiation, and make the unsigned package smoke test the release blocker.\n\n• Owner: Desktop shell — today\n• Owner: Native capture — tomorrow\n• Decision: Optional cloud stays off by default"
  },
  {
    id: "demo-empty",
    title: "Untitled session",
    timestamp: "Yesterday, 4:18 PM",
    excerpt: "No conversation was detected.",
    response: ""
  },
  {
    id: "demo-lecture",
    title: "Geometry lecture notes",
    timestamp: "Monday, 2:05 PM",
    excerpt: "Inscribed angles and proof strategy.",
    response: "An inscribed angle equals half the measure of its intercepted arc. Start by identifying the center, draw radii to create isosceles triangles, and use the triangle angle sum to connect the central and inscribed angles."
  }
]);

export function createInitialOverlayState(visible = true, screenContextEnabled = false) {
  return {
    version: 1,
    phase: visible ? "compact-idle" : "hidden",
    previousVisiblePhase: "compact-idle",
    prompt: "",
    response: "",
    error: null,
    selectedHistoryId: null,
    requestId: null,
    startedAt: null,
    screenContext: {
      enabled: Boolean(screenContextEnabled),
      status: "idle",
      capability: "unknown",
      attachmentId: null,
      capturedAt: null,
      displayId: null,
      errorCode: null,
      error: null
    }
  };
}

export function isExpandedPhase(phase) {
  return typeof phase === "string" && phase.startsWith("expanded-");
}

export function assertOverlayState(value) {
  if (!value || typeof value !== "object") throw new TypeError("Overlay state must be an object");
  if (!OVERLAY_PHASES.includes(value.phase)) throw new TypeError(`Unknown overlay phase: ${String(value.phase)}`);
  if (value.version !== 1) throw new TypeError("Unsupported overlay state version");
  return value;
}

export function mergePreferences(value) {
  const candidate = value && typeof value === "object" ? value : {};
  const keybindings = candidate.keybindings && typeof candidate.keybindings === "object" ? candidate.keybindings : {};
  const integrations = candidate.integrations && typeof candidate.integrations === "object" ? candidate.integrations : {};
  const imageInputOverrides = candidate.imageInputOverrides && typeof candidate.imageInputOverrides === "object" ? candidate.imageInputOverrides : {};
  const candidateProviderModels = candidate.providerModels && typeof candidate.providerModels === "object" ? candidate.providerModels : {};
  const providerModels = { ...DEFAULT_PREFERENCES.providerModels, ...candidateProviderModels };
  if (candidate.provider && candidate.model && !Object.hasOwn(candidateProviderModels, candidate.provider)) providerModels[candidate.provider] = candidate.model;
  return {
    ...DEFAULT_PREFERENCES,
    ...candidate,
    version: 1,
    keybindings: { ...DEFAULT_PREFERENCES.keybindings, ...keybindings },
    integrations: { ...DEFAULT_PREFERENCES.integrations, ...integrations },
    providerModels,
    imageInputOverrides: { ...imageInputOverrides }
  };
}

export function reduceOverlay(state, event) {
  assertOverlayState(state);
  if (!event || typeof event.type !== "string") throw new TypeError("Overlay event requires a type");
  switch (event.type) {
    case "SHOW": {
      const phase = state.previousVisiblePhase === "hidden" ? "compact-idle" : state.previousVisiblePhase;
      return { ...state, phase };
    }
    case "HIDE":
      return { ...state, previousVisiblePhase: state.phase === "hidden" ? state.previousVisiblePhase : state.phase, phase: "hidden" };
    case "TOGGLE_VISIBILITY":
      return state.phase === "hidden" ? reduceOverlay(state, { type: "SHOW" }) : reduceOverlay(state, { type: "HIDE" });
    case "SET_PROMPT":
      return { ...state, prompt: String(event.prompt ?? "").slice(0, 8_000) };
    case "SET_SCREEN_CONTEXT_ENABLED":
      {
      const keepActiveAttachment = state.screenContext.status === "attached" && state.screenContext.attachmentId;
      return {
        ...state,
        screenContext: {
          ...state.screenContext,
          enabled: Boolean(event.enabled),
          status: keepActiveAttachment ? "attached" : "idle",
          attachmentId: keepActiveAttachment ? state.screenContext.attachmentId : null,
          capturedAt: keepActiveAttachment ? state.screenContext.capturedAt : null,
          displayId: keepActiveAttachment ? state.screenContext.displayId : null,
          errorCode: null,
          error: null
        }
      };
      }
    case "SET_SCREEN_CAPABILITY":
      return { ...state, screenContext: { ...state.screenContext, capability: event.capability ?? "unknown" } };
    case "SCREEN_CAPTURE_STARTED":
      if (event.requestId && state.requestId && event.requestId !== state.requestId) return state;
      return { ...state, screenContext: { ...state.screenContext, status: "capturing", attachmentId: null, capturedAt: null, displayId: null, errorCode: null, error: null } };
    case "SCREEN_CAPTURE_ATTACHED":
      if (event.requestId && state.requestId && event.requestId !== state.requestId) return state;
      return {
        ...state,
        screenContext: {
          ...state.screenContext,
          status: "attached",
          attachmentId: String(event.attachmentId ?? ""),
          capturedAt: Number(event.capturedAt ?? Date.now()),
          displayId: String(event.displayId ?? ""),
          errorCode: null,
          error: null
        }
      };
    case "SCREEN_CAPTURE_FAILED":
      if (event.requestId && state.requestId && event.requestId !== state.requestId) return state;
      return {
        ...state,
        screenContext: {
          ...state.screenContext,
          status: event.status === "permission-blocked" || event.status === "unsupported" ? event.status : "error",
          attachmentId: null,
          capturedAt: null,
          displayId: null,
          errorCode: String(event.errorCode ?? "capture-failed"),
          error: String(event.error ?? "Screen context could not be captured.")
        }
      };
    case "SCREEN_CAPTURE_CLEARED":
      return {
        ...state,
        screenContext: { ...state.screenContext, status: "idle", attachmentId: null, capturedAt: null, displayId: null, errorCode: null, error: null }
      };
    case "SUBMIT": {
      const prompt = String(event.prompt ?? state.prompt).trim().slice(0, 8_000);
      if (!prompt) return { ...state, phase: "expanded-empty", response: "", error: null };
      return { ...state, phase: "expanded-empty", prompt, response: "", error: null, requestId: String(event.requestId ?? crypto.randomUUID()) };
    }
    case "RESOLVE":
      if (event.requestId && event.requestId !== state.requestId) return state;
      return { ...state, phase: "expanded-response", response: String(event.response ?? ""), error: null, requestId: null };
    case "STREAM":
      if (event.requestId && event.requestId !== state.requestId) return state;
      return { ...state, phase: "expanded-response", response: String(event.response ?? ""), error: null };
    case "FAIL":
      if (event.requestId && event.requestId !== state.requestId) return state;
      return { ...state, phase: "expanded-error", error: String(event.error ?? "Something went wrong."), requestId: null };
    case "EXPAND":
      return { ...state, phase: state.response ? "expanded-response" : "expanded-empty" };
    case "COLLAPSE":
      return { ...state, phase: state.startedAt ? "compact-listening" : "compact-idle", error: null, selectedHistoryId: null };
    case "START_LISTENING":
      return { ...state, phase: isExpandedPhase(state.phase) ? state.phase : "compact-listening", startedAt: state.startedAt ?? Date.now() };
    case "STOP_LISTENING":
      return { ...state, phase: isExpandedPhase(state.phase) ? state.phase : "compact-idle", startedAt: null };
    case "SHOW_HISTORY":
      return { ...state, phase: "expanded-history", selectedHistoryId: null, error: null };
    case "SELECT_HISTORY":
      return { ...state, phase: "expanded-history", selectedHistoryId: String(event.id ?? "") };
    case "CLEAR":
      return { ...createInitialOverlayState(true, state.screenContext.enabled), startedAt: state.startedAt, screenContext: { ...createInitialOverlayState(true, state.screenContext.enabled).screenContext, capability: state.screenContext.capability } };
    default:
      return state;
  }
}

export function demoResponse(prompt) {
  const compact = String(prompt).trim().replace(/\s+/g, " ");
  if (/error/i.test(compact)) throw new Error("The local demo provider intentionally failed. Your data stayed on this Mac.");
  if (/sequence|plan|next/i.test(compact)) {
    return "Here’s a focused sequence:\n\n• Confirm the outcome and the release gate\n• Capture decisions with a clear owner\n• Finish the smallest testable slice first\n• Verify failure recovery before adding integrations\n• Record the result and attach evidence";
  }
  return `I heard: “${compact}”\n\nThe important point is to turn that into a concrete decision, name an owner, and preserve the evidence needed to verify it later. Clarity can keep this session local unless you explicitly enable encrypted cloud sync.`;
}
