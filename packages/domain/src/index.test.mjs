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
    expect(state.phase).toBe("expanded-empty");
    expect(state.response).toBe("");
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
