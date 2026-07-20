import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mergePreferences } from "@clarity/domain";

export class PreferenceStore {
  constructor(path, io = {}) {
    this.path = path;
    this.value = mergePreferences({});
    this.writeQueue = Promise.resolve();
    this.mkdir = io.mkdir ?? mkdir;
    this.readFile = io.readFile ?? readFile;
    this.rename = io.rename ?? rename;
    this.writeFile = io.writeFile ?? writeFile;
  }

  async load() {
    try {
      this.value = mergePreferences(JSON.parse(await this.readFile(this.path, "utf8")));
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
      const candidate = mergePreferences({ ...this.value, ...patch });
      const payload = `${JSON.stringify(candidate, null, 2)}\n`;
      await this.mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.next`;
      await this.writeFile(temporaryPath, payload, { mode: 0o600 });
      await this.rename(temporaryPath, this.path);
      this.value = candidate;
      return this.snapshot();
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
