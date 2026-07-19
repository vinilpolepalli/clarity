import { utilityProcess } from "electron";
import { join } from "node:path";

export class StorageService {
  constructor({ directory }) {
    this.directory = directory;
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
  }

  async start() {
    if (this.child) return;
    this.child = utilityProcess.fork(join(import.meta.dirname, "storage-worker.mjs"), [`--directory=${this.directory}`], {
      serviceName: "Clarity Local Storage",
      stdio: "pipe"
    });
    this.child.on("message", (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`Storage process exited with code ${code}`));
      this.pending.clear();
      this.child = null;
    });
    this.child.stderr?.on("data", (chunk) => console.warn("Storage:", String(chunk).trim()));
    await this.call("health");
  }

  call(method, params = {}) {
    if (!this.child) return Promise.reject(new Error("Storage process is not running"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.postMessage({ id, method, params });
    });
  }

  close() {
    this.child?.kill();
    this.child = null;
  }
}
