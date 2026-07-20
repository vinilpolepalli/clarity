import { describe, expect, it } from "vitest";
import { createInitialOverlayState, demoResponse, mergePreferences, reduceOverlay } from "./index.mjs";

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
    expect(preferences.providerModels.nvidia).toBe("meta/llama-3.2-11b-vision-instruct");
    expect(mergePreferences({ provider: "nvidia", model: "custom/nvidia-vision" }).providerModels.nvidia).toBe("custom/nvidia-vision");
  });

  it("provides a deterministic offline response", () => {
    expect(demoResponse("What is next?")).toContain("focused sequence");
  });
});
