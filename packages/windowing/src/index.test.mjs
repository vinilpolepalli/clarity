import { describe, expect, it } from "vitest";
import { COMPACT_HEIGHT, defaultCompactBounds, pickerPresentationBounds, transitionBounds } from "./index.mjs";

const screen = { x: 0, y: 25, width: 1440, height: 875 };

describe("overlay geometry", () => {
  it("starts centered near the top", () => {
    expect(defaultCompactBounds(screen)).toEqual({ x: 340, y: 49, width: 760, height: 116 });
  });

  it("grows down when there is room", () => {
    expect(transitionBounds({ x: 100, y: 100, width: 760, height: 116 }, screen, true).y).toBe(100);
  });

  it("grows upward at the bottom and keeps the compact control recoverable", () => {
    const expanded = transitionBounds({ x: 100, y: 800, width: 760, height: 116 }, screen, true);
    expect(expanded.y).toBe(502);
    const compact = transitionBounds(expanded, screen, false, { compactWidth: 760 });
    expect(compact.height).toBe(COMPACT_HEIGHT);
    expect(compact.x).toBe(100);
  });

  it("opens the mode picker below without moving its anchor", () => {
    expect(pickerPresentationBounds({ x: 100, y: 100, width: 760, height: 116 }, screen, 360)).toEqual({
      bounds: { x: 100, y: 100, width: 760, height: 476 },
      placement: "below",
      viewportHeight: 360,
      surfaceOffsetY: 0
    });
  });

  it("opens upward near the bottom and caps the menu viewport", () => {
    expect(pickerPresentationBounds({ x: 100, y: 800, width: 760, height: 116 }, screen, 600)).toEqual({
      bounds: { x: 100, y: 380, width: 760, height: 536 },
      placement: "above",
      viewportHeight: 420,
      surfaceOffsetY: 420
    });
  });
});
