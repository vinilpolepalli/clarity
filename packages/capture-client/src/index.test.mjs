import { describe, expect, it } from "vitest";
import { BoundedQueue, RollingAudioBuffer, SequenceTracker } from "./index.mjs";

describe("capture pressure controls", () => {
  it("drops the oldest queue item under pressure", () => {
    const queue = new BoundedQueue(2); queue.push(1); queue.push(2); queue.push(3);
    expect(queue.dropped).toBe(1); expect(queue.shift()).toBe(2);
  });
  it("bounds the rolling audio snapshot", () => {
    const buffer = new RollingAudioBuffer(5); buffer.append(Buffer.from("abc")); buffer.append(Buffer.from("def"));
    expect(buffer.snapshot().toString()).toBe("bcdef");
  });
  it("detects sequence gaps and resets on a new epoch", () => {
    const tracker = new SequenceTracker();
    expect(tracker.accept({ epoch: "a", sequence: 0 }).reset).toBe(true);
    expect(tracker.accept({ epoch: "a", sequence: 2 }).gap).toBe(1);
    expect(tracker.accept({ epoch: "b", sequence: 0 }).reset).toBe(true);
  });
});
