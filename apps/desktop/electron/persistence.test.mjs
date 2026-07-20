import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PreferenceStore } from "./persistence.mjs";

describe("PreferenceStore", () => {
  it("serializes concurrent atomic updates without dropping screen preferences", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clarity-preferences-"));
    const path = join(directory, "preferences.json");
    try {
      const store = new PreferenceStore(path);
      await store.load();
      await Promise.all([
        store.update({ screenContextEnabled: true }),
        store.update({ provider: "nvidia", model: "custom/vision" })
      ]);
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted.screenContextEnabled).toBe(true);
      expect(persisted.provider).toBe("nvidia");
      expect(persisted.model).toBe("custom/vision");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
