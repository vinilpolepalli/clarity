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
  provider: "demo",
  model: "clarity-demo",
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
    prompt: "Summarize the launch readiness review.",
    timestamp: "Today, 10:42 AM",
    excerpt: "Decisions, owners, and the remaining release gate.",
    response: "The team agreed to keep provider keys on this Mac, finish the overlay parity gate before visual differentiation, and make the unsigned package smoke test the release blocker.\n\n• Owner: Desktop shell — today\n• Owner: Native capture — tomorrow\n• Decision: Optional cloud stays off by default"
  },
  {
    id: "demo-empty",
    title: "Untitled session",
    prompt: "",
    timestamp: "Yesterday, 4:18 PM",
    excerpt: "No conversation was detected.",
    response: ""
  },
  {
    id: "demo-lecture",
    title: "Geometry lecture notes",
    prompt: "Explain the key geometry proof strategy.",
    timestamp: "Monday, 2:05 PM",
    excerpt: "Inscribed angles and proof strategy.",
    response: "An inscribed angle equals half the measure of its intercepted arc. Start by identifying the center, draw radii to create isosceles triangles, and use the triangle angle sum to connect the central and inscribed angles."
  }
]);

export function createInitialOverlayState(visible = true) {
  return {
    version: 2,
    phase: visible ? "compact-idle" : "hidden",
    previousVisiblePhase: "compact-idle",
    prompt: "",
    response: "",
    conversationId: null,
    conversationTitle: "",
    messages: [],
    error: null,
    selectedHistoryId: null,
    requestId: null,
    activeAssistantMessageId: null,
    lastPrompt: "",
    startedAt: null
  };
}

export function isExpandedPhase(phase) {
  return typeof phase === "string" && phase.startsWith("expanded-");
}

export function assertOverlayState(value) {
  if (!value || typeof value !== "object") throw new TypeError("Overlay state must be an object");
  if (!OVERLAY_PHASES.includes(value.phase)) throw new TypeError(`Unknown overlay phase: ${String(value.phase)}`);
  if (value.version !== 2) throw new TypeError("Unsupported overlay state version");
  return value;
}

function message(role, content, { id = crypto.randomUUID(), status = "complete", createdAt = new Date().toISOString() } = {}) {
  return { id: String(id), role, content: String(content), status, createdAt };
}

function replaceMessage(messages, id, patch) {
  return messages.map((item) => item.id === id ? { ...item, ...patch } : item);
}

export function mergePreferences(value) {
  const candidate = value && typeof value === "object" ? value : {};
  const keybindings = candidate.keybindings && typeof candidate.keybindings === "object" ? candidate.keybindings : {};
  const integrations = candidate.integrations && typeof candidate.integrations === "object" ? candidate.integrations : {};
  return {
    ...DEFAULT_PREFERENCES,
    ...candidate,
    version: 1,
    keybindings: { ...DEFAULT_PREFERENCES.keybindings, ...keybindings },
    integrations: { ...DEFAULT_PREFERENCES.integrations, ...integrations }
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
    case "SUBMIT": {
      if (state.requestId) return state;
      const prompt = String(event.prompt ?? state.prompt).trim().slice(0, 8_000);
      if (!prompt) return { ...state, phase: state.messages.length ? "expanded-response" : "expanded-empty", error: null };
      const conversationId = state.conversationId ?? String(event.conversationId ?? crypto.randomUUID());
      const userMessage = message("user", prompt, { id: event.userMessageId });
      const assistantMessage = message("assistant", "", { id: event.assistantMessageId, status: "streaming" });
      return {
        ...state,
        phase: "expanded-response",
        prompt: "",
        response: "",
        conversationId,
        conversationTitle: state.conversationTitle || prompt.slice(0, 72),
        messages: [...state.messages, userMessage, assistantMessage],
        error: null,
        selectedHistoryId: null,
        requestId: String(event.requestId ?? crypto.randomUUID()),
        activeAssistantMessageId: assistantMessage.id,
        lastPrompt: prompt
      };
    }
    case "RETRY": {
      if (state.requestId || !state.lastPrompt || !state.conversationId) return state;
      const assistantMessage = message("assistant", "", { id: event.assistantMessageId, status: "streaming" });
      return {
        ...state,
        phase: "expanded-response",
        messages: [...state.messages.filter((item) => item.status !== "error"), assistantMessage],
        response: "",
        error: null,
        requestId: String(event.requestId ?? crypto.randomUUID()),
        activeAssistantMessageId: assistantMessage.id
      };
    }
    case "RESOLVE": {
      if (event.requestId && state.requestId && event.requestId !== state.requestId) return state;
      const response = String(event.response ?? "");
      return {
        ...state,
        phase: "expanded-response",
        response,
        messages: replaceMessage(state.messages, state.activeAssistantMessageId, { content: response, status: "complete" }),
        error: null,
        requestId: null,
        activeAssistantMessageId: null
      };
    }
    case "STREAM": {
      if (event.requestId && state.requestId && event.requestId !== state.requestId) return state;
      const response = String(event.response ?? "");
      return {
        ...state,
        phase: "expanded-response",
        response,
        messages: replaceMessage(state.messages, state.activeAssistantMessageId, { content: response, status: "streaming" }),
        error: null
      };
    }
    case "FAIL": {
      if (event.requestId && state.requestId && event.requestId !== state.requestId) return state;
      if (!state.activeAssistantMessageId) {
        return { ...state, phase: "expanded-error", error: String(event.error ?? "Something went wrong."), requestId: null };
      }
      return {
        ...state,
        phase: "expanded-response",
        messages: replaceMessage(state.messages, state.activeAssistantMessageId, { status: "error" }),
        error: String(event.error ?? "Something went wrong."),
        requestId: null,
        activeAssistantMessageId: null
      };
    }
    case "EXPAND":
      return { ...state, phase: state.messages.length ? "expanded-response" : "expanded-empty" };
    case "COLLAPSE":
      return { ...state, phase: state.startedAt ? "compact-listening" : "compact-idle", error: null, selectedHistoryId: null };
    case "START_LISTENING":
      return { ...state, phase: isExpandedPhase(state.phase) ? state.phase : "compact-listening", startedAt: state.startedAt ?? Date.now() };
    case "STOP_LISTENING":
      return { ...state, phase: isExpandedPhase(state.phase) ? state.phase : "compact-idle", startedAt: null };
    case "SHOW_HISTORY":
      return { ...state, phase: "expanded-history", selectedHistoryId: null, error: null };
    case "LOAD_CONVERSATION": {
      const conversation = event.conversation;
      if (!conversation || typeof conversation !== "object") return state;
      const messages = Array.isArray(conversation.messages)
        ? conversation.messages.filter((item) => item?.role === "user" || item?.role === "assistant").map((item) => message(item.role, item.content, item))
        : [];
      const lastUserMessage = [...messages].reverse().find((item) => item.role === "user");
      return {
        ...state,
        phase: messages.length ? "expanded-response" : "expanded-empty",
        prompt: "",
        response: [...messages].reverse().find((item) => item.role === "assistant")?.content ?? "",
        conversationId: String(conversation.id ?? ""),
        conversationTitle: String(conversation.title ?? "Untitled conversation"),
        messages,
        error: null,
        selectedHistoryId: null,
        requestId: null,
        activeAssistantMessageId: null,
        lastPrompt: lastUserMessage?.content ?? ""
      };
    }
    case "CLEAR": {
      const cleared = createInitialOverlayState(true);
      const phase = isExpandedPhase(state.phase) ? "expanded-empty" : state.startedAt ? "compact-listening" : "compact-idle";
      return { ...cleared, phase, previousVisiblePhase: phase, startedAt: state.startedAt };
    }
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
