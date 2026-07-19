import { describe, expect, it } from "vitest";
import { COMPACT_HEIGHT, defaultCompactBounds, transitionBounds } from "./index.mjs";

const screen = { x: 0, y: 25, width: 1440, height: 875 };

describe("overlay geometry", () => {
  it("starts centered near the top", () => {
    expect(defaultCompactBounds(screen)).toEqual({ x: 425, y: 49, width: 590, height: 88 });
  });

  it("grows down when there is room", () => {
    expect(transitionBounds({ x: 100, y: 100, width: 590, height: 88 }, screen, true).y).toBe(100);
  });

  it("grows upward at the bottom and keeps the compact control recoverable", () => {
    const expanded = transitionBounds({ x: 100, y: 800, width: 590, height: 88 }, screen, true);
    expect(expanded.y).toBe(474);
    const compact = transitionBounds(expanded, screen, false, { compactWidth: 590 });
    expect(compact.height).toBe(COMPACT_HEIGHT);
    expect(compact.x).toBe(100);
  });
});
