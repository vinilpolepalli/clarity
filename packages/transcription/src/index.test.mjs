import { describe, expect, it } from "vitest";
import { whisperArguments } from "./index.mjs";

describe("local whisper adapter", () => {
  it("builds bounded local-only arguments", () => {
    const args = whisperArguments({ modelPath: "/models/model.bin", audioPath: "/tmp/audio.wav", language: "en", threads: 99 });
    expect(args).toContain("/models/model.bin"); expect(args).toContain("12"); expect(args).toContain("en");
  });
});
