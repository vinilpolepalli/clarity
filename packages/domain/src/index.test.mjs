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

  it("starts a new chat without collapsing the expanded overlay", () => {
    let state = reduceOverlay(createInitialOverlayState(true), { type: "SUBMIT", prompt: "hello", requestId: "one" });
    state = reduceOverlay(state, { type: "RESOLVE", requestId: "one", response: "Hi" });
    state = reduceOverlay(state, { type: "CLEAR" });
    expect(state).toMatchObject({ phase: "expanded-empty", conversationId: null, messages: [] });
  });

  it("keeps non-conversation failures on the standalone error screen", () => {
    const state = reduceOverlay(createInitialOverlayState(true), { type: "FAIL", error: "Microphone permission denied" });
    expect(state).toMatchObject({ phase: "expanded-error", error: "Microphone permission denied" });
  });
});

describe("portable contracts", () => {
  it("migrates partial preferences to version one", () => {
    expect(mergePreferences({ reduceMotion: true }).keybindings.toggleOverlay).toContain("Shift");
  });

  it("provides a deterministic offline response", () => {
    expect(demoResponse("What is next?")).toContain("focused sequence");
  });
});
