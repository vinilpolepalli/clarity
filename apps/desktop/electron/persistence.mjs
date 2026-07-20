import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mergePreferences } from "@clarity/domain";

export class PreferenceStore {
  constructor(path) {
    this.path = path;
    this.value = mergePreferences({});
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      this.value = mergePreferences(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn("Preferences were reset after a read error:", error.message);
      this.value = mergePreferences({});
    }
    return this.value;
  }

  snapshot() {
    return structuredClone(this.value);
  }

  update(patch) {
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      const next = mergePreferences({ ...this.value, ...patch });
      const payload = `${JSON.stringify(next, null, 2)}\n`;
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.next`;
      await writeFile(temporaryPath, payload, { mode: 0o600 });
      await rename(temporaryPath, this.path);
      this.value = next;
      return this.snapshot();
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
