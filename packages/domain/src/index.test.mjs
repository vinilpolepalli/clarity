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
});

describe("portable contracts", () => {
  it("migrates partial preferences to version one", () => {
    expect(mergePreferences({ reduceMotion: true }).keybindings.toggleOverlay).toContain("Shift");
  });

  it("normalizes saved custom provider models", () => {
    const preferences = mergePreferences({ customModels: { nvidia: [" custom/model ", "custom/model", ""] } });
    expect(preferences.customModels.nvidia).toEqual(["custom/model"]);
    expect(preferences.customModels.openai).toEqual([]);
  });

  it("provides a deterministic offline response", () => {
    expect(demoResponse("What is next?")).toContain("focused sequence");
  });
});
