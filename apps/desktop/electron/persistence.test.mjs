import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreferenceStore } from "./persistence.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryPath() {
  const directory = await mkdtemp(join(tmpdir(), "clarity-preferences-"));
  temporaryDirectories.push(directory);
  return join(directory, "preferences.json");
}

describe("PreferenceStore", () => {
  it("serializes updates and commits only after the atomic rename", async () => {
    const path = await temporaryPath();
    const store = new PreferenceStore(path);
    await Promise.all([
      store.update({ mode: "sales" }),
      store.update({ reduceMotion: true })
    ]);
    expect(store.snapshot()).toMatchObject({ mode: "sales", reduceMotion: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ mode: "sales", reduceMotion: true });
  });

  it("keeps the committed value when rename fails and allows a later update", async () => {
    const path = await temporaryPath();
    let failRename = true;
    const store = new PreferenceStore(path, {
      rename: async (from, to) => {
        if (failRename) throw new Error("disk unavailable");
        return (await import("node:fs/promises")).rename(from, to);
      }
    });
    await expect(store.update({ mode: "sales" })).rejects.toThrow("disk unavailable");
    expect(store.snapshot().mode).toBe("general");
    failRename = false;
    await store.update({ mode: "lecture" });
    expect(store.snapshot().mode).toBe("lecture");
  });
});
