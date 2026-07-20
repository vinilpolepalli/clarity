import { describe, expect, it } from "vitest";
import {
  assembleSystemPrompt,
  assertModeId,
  BUILT_IN_MODES,
  CLARITY_BASE_PROMPT,
  createInitialOverlayState,
  createModeModel,
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
