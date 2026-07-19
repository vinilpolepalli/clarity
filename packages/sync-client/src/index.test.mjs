import { describe, expect, it } from "vitest";
import { createSyncKey, decryptEnvelope, encryptEnvelope, syncPolicy } from "./index.mjs";

describe("encrypted optional sync", () => {
  it("round-trips an encrypted artifact", async () => {
    const key = await createSyncKey(); const envelope = await encryptEnvelope({ summary: "private" }, key);
    expect(envelope.ciphertext).not.toContain("private"); expect(await decryptEnvelope(envelope, key)).toEqual({ summary: "private" });
  });
  it("requires both opt-in and review", () => expect(syncPolicy({ cloudEnabled: true }, { reviewed: false }).allowed).toBe(false));
});
