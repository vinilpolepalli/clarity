import { describe, expect, it } from "vitest";
import {
  assembleSystemPrompt,
  assertModeId,
  BUILT_IN_MODES,
  CLARITY_BASE_PROMPT,
  createInitialOverlayState,
  createModeModel,
  DEFAULT_PROVIDER_MODELS,
  demoResponse,
  isModeId,
  mergePreferences,
  reduceOverlay,
  resolveMode
} from "./index.mjs";

describe("overlay reducer", () => {
  it("round-trips visibility through the last visible phase", () => {
    let state = createInitialOverlayState(true);
    state = reduceOverlay(state, { type: "SHOW_HISTORY" });
    state = reduceOverlay(state, { type: "HIDE" });
    expect(state.phase).toBe("hidden");
    expect(reduceOverlay(state, { type: "SHOW" }).phase).toBe("expanded-history");
  });

  it("ignores stale provider completions", () => {
    let state = reduceOverlay(createInitialOverlayState(true), { type: "SUBMIT", prompt: "hello", requestId: "current" });
    state = reduceOverlay(state, { type: "RESOLVE", requestId: "old", response: "wrong" });
    expect(state.phase).toBe("expanded-response");
    expect(state.response).toBe("");
  });

  it("ignores duplicate submits and stale stream updates while a request is active", () => {
    const active = reduceOverlay(createInitialOverlayState(true), { type: "SUBMIT", prompt: "hello", requestId: "current" });
    expect(reduceOverlay(active, { type: "SUBMIT", prompt: "duplicate", requestId: "new" })).toBe(active);
    expect(reduceOverlay(active, { type: "STREAM", requestId: "old", response: "wrong" })).toBe(active);
  });

  it("keeps follow-up turns in one conversation", () => {
    let state = reduceOverlay(createInitialOverlayState(true), {
      type: "SUBMIT", prompt: "hello", requestId: "one", conversationId: "thread", userMessageId: "u1", assistantMessageId: "a1"
    });
    state = reduceOverlay(state, { type: "RESOLVE", requestId: "one", response: "Hi there" });
    state = reduceOverlay(state, { type: "SUBMIT", prompt: "build on that", requestId: "two", userMessageId: "u2", assistantMessageId: "a2" });
    expect(state.conversationId).toBe("thread");
    expect(state.prompt).toBe("");
    expect(state.messages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "hello"], ["assistant", "Hi there"], ["user", "build on that"], ["assistant", ""]
    ]);
  });

  it("retries a failed assistant turn without duplicating the user message", () => {
    let state = reduceOverlay(createInitialOverlayState(true), { type: "SUBMIT", prompt: "hello", requestId: "one" });
    state = reduceOverlay(state, { type: "FAIL", requestId: "one", error: "offline" });
    state = reduceOverlay(state, { type: "RETRY", requestId: "two", assistantMessageId: "retry" });
    expect(state.messages.filter((item) => item.role === "user")).toHaveLength(1);
    expect(state.messages.at(-1)).toMatchObject({ id: "retry", role: "assistant", status: "streaming" });
  });

  it("retains listening through collapse", () => {
    let state = reduceOverlay(createInitialOverlayState(true), { type: "START_LISTENING" });
    state = reduceOverlay(state, { type: "EXPAND" });
    expect(reduceOverlay(state, { type: "COLLAPSE" }).phase).toBe("compact-listening");
  });

  it("tracks a source-selected live-notes session without replacing chat state", () => {
    let state = reduceOverlay(createInitialOverlayState(true), { type: "START_LISTENING", sessionId: "meeting-1", source: "system" });
    state = reduceOverlay(state, { type: "MEETING_STATUS", meeting: { transcriptCount: 2, status: "ready", artifact: { title: "Notes", summary: "Done", decisions: [], actions: [] } } });
    state = reduceOverlay(state, { type: "SHOW_LIVE_NOTES" });
    expect(state).toMatchObject({ phase: "expanded-notes", meeting: { sessionId: "meeting-1", source: "system", transcriptCount: 2, status: "ready" } });
  });

  it("keeps screen opt-in across clear while dropping attachment metadata", () => {
    let state = createInitialOverlayState(true, true);
    state = reduceOverlay(state, { type: "SUBMIT", prompt: "screen", requestId: "current" });
    state = reduceOverlay(state, { type: "SCREEN_CAPTURE_ATTACHED", requestId: "current", attachmentId: "image-1", capturedAt: 10, displayId: "2" });
    state = reduceOverlay(state, { type: "CLEAR" });
    expect(state.screenContext.enabled).toBe(true);
    expect(state.screenContext.status).toBe("idle");
    expect(state.screenContext.attachmentId).toBeNull();
  });

  it("ignores stale screen capture completions", () => {
    let state = reduceOverlay(createInitialOverlayState(true, true), { type: "SUBMIT", prompt: "screen", requestId: "current" });
    state = reduceOverlay(state, { type: "SCREEN_CAPTURE_ATTACHED", requestId: "old", attachmentId: "wrong" });
    expect(state.screenContext.attachmentId).toBeNull();
  });

  it("starts a new chat without collapsing the expanded overlay", () => {
    let state = reduceOverlay(createInitialOverlayState(true), { type: "SUBMIT", prompt: "hello", requestId: "one" });
    state = reduceOverlay(state, { type: "RESOLVE", requestId: "one", response: "Hi" });
    state = reduceOverlay(state, { type: "CLEAR" });
    expect(state).toMatchObject({ phase: "expanded-empty", conversationId: null, messages: [] });
  });

  it("loads only valid conversation roles and restores the latest user prompt", () => {
    const state = reduceOverlay(createInitialOverlayState(true), {
      type: "LOAD_CONVERSATION",
      conversation: {
        id: "thread",
        title: "Saved chat",
        messages: [
          { id: "ignored", role: "system", content: "hidden" },
          { id: "user", role: "user", content: "question" },
          { id: "assistant", role: "assistant", content: "answer" }
        ]
      }
    });
    expect(state.messages).toHaveLength(2);
    expect(state).toMatchObject({ conversationId: "thread", lastPrompt: "question", response: "answer" });
  });

  it("keeps non-conversation failures on the standalone error screen", () => {
    const state = reduceOverlay(createInitialOverlayState(true), { type: "FAIL", error: "Microphone permission denied" });
    expect(state).toMatchObject({ phase: "expanded-error", error: "Microphone permission denied" });
  });
});

describe("portable contracts", () => {
  it("migrates partial preferences to version one", () => {
    const preferences = mergePreferences({ reduceMotion: true });
    expect(preferences.keybindings.toggleOverlay).toContain("Shift");
    expect(preferences.screenContextEnabled).toBe(false);
    expect(preferences.imageInputOverrides).toEqual({});
    expect(preferences.customModels.nvidia).toEqual([]);
    expect(preferences.meetingAudioSource).toBe("both");
    expect(preferences.whisperExecutable).toBe("whisper-cli");
    expect(DEFAULT_PROVIDER_MODELS.nvidia).toBe("deepseek-ai/deepseek-v4-flash");
  });

  it("rejects an invalid persisted meeting audio source", () => {
    expect(mergePreferences({ meetingAudioSource: "browser" }).meetingAudioSource).toBe("both");
    expect(mergePreferences({ meetingAudioSource: "system" }).meetingAudioSource).toBe("system");
  });

  it("normalizes saved custom provider models", () => {
    const preferences = mergePreferences({ customModels: { nvidia: [" custom/model ", "custom/model", ""] } });
    expect(preferences.customModels.nvidia).toEqual(["custom/model"]);
    expect(preferences.customModels.openai).toEqual([]);
  });

  it("bounds saved custom models and ignores malformed provider collections", () => {
    const models = Array.from({ length: 25 }, (_, index) => `custom/model-${index}`);
    models[3] = "x".repeat(161);
    const preferences = mergePreferences({ customModels: { nvidia: models, openai: "not-an-array" } });
    expect(preferences.customModels.nvidia).toHaveLength(20);
    expect(preferences.customModels.nvidia).not.toContain("x".repeat(161));
    expect(preferences.customModels.openai).toEqual([]);
  });

  it("provides a deterministic offline response", () => {
    expect(demoResponse("What is next?")).toContain("focused sequence");
  });

  it("defaults new and corrupt preferences to General while preserving legacy modes", () => {
    expect(mergePreferences({}).mode).toBe("general");
    expect(mergePreferences({ mode: "meeting" }).mode).toBe("meeting");
    expect(mergePreferences({ mode: "removed-mode" }).mode).toBe("general");
  });
});

describe("built-in assistant modes", () => {
  it("exposes twelve unique, ordered definitions", () => {
    expect(BUILT_IN_MODES).toHaveLength(12);
    expect(new Set(BUILT_IN_MODES.map((mode) => mode.id)).size).toBe(12);
    expect(BUILT_IN_MODES[0].id).toBe("general");
    expect(BUILT_IN_MODES.at(-1).id).toBe("lecture");
  });

  it("keeps system prompts out of renderer metadata", () => {
    const model = createModeModel("coding-interview");
    expect(model.activeModeId).toBe("coding-interview");
    expect(model.groups.map((group) => group.label)).toEqual(["Looking for work", "Work", "School"]);
    expect(model.modes.every((mode) => !("systemPrompt" in mode))).toBe(true);
  });

  it("strictly validates interactive IDs but safely resolves stored values", () => {
    expect(isModeId("sales")).toBe(true);
    expect(assertModeId("sales")).toBe("sales");
    expect(() => assertModeId("unknown")).toThrow("Unknown mode");
    expect(resolveMode("unknown").id).toBe("general");
  });

  it("assembles the common prefix with exactly one active prompt", () => {
    const coding = assembleSystemPrompt("coding-interview");
    expect(coding.modeId).toBe("coding-interview");
    expect(coding.promptVersion).toBe(1);
    expect(coding.systemPrompt).toContain(CLARITY_BASE_PROMPT);
    expect(coding.systemPrompt).toContain("ACTIVE MODE: Coding Interview");
    expect(coding.systemPrompt).toContain("time and space complexity");
    expect(coding.systemPrompt).not.toContain("Responses must be EXTREMELY short and terse");
  });
});
