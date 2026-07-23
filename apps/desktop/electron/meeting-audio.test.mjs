import { describe, expect, it } from "vitest";
import { mixPcm16, pcmDurationMs, rmsPcm16 } from "./meeting-audio.mjs";

describe("meeting audio", () => {
  it("mixes sources without clipping and preserves PCM duration", () => {
    const left = Buffer.alloc(4); left.writeInt16LE(30_000, 0); left.writeInt16LE(-30_000, 2);
    const right = Buffer.alloc(4); right.writeInt16LE(10_000, 0); right.writeInt16LE(10_000, 2);
    const mixed = mixPcm16(left, right);
    expect([...mixed.values()]).toHaveLength(4);
    expect(mixed.readInt16LE(0)).toBe(20_000);
    expect(mixed.readInt16LE(2)).toBe(-10_000);
    expect(pcmDurationMs(Buffer.alloc(32_000))).toBe(1_000);
    expect(rmsPcm16(Buffer.alloc(4))).toBe(0);
  });
});
