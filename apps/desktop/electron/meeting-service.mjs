import { utilityProcess } from "electron";
import { join } from "node:path";

export class MeetingProcessingService {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.child = null;
  }

  start({ sessionId, source, whisperExecutable, whisperModelPath }) {
    this.stop();
    this.child = utilityProcess.fork(join(import.meta.dirname, "meeting-worker.mjs"), [], { serviceName: "Clarity Meeting Processor", stdio: "pipe" });
    this.child.on("message", (message) => this.onEvent(message));
    this.child.on("exit", (code) => {
      if (this.child) this.onEvent({ type: "failure", stage: "processor", message: `Meeting processor exited with code ${code}.`, retryable: true });
      this.child = null;
    });
    this.child.stderr?.on("data", (chunk) => console.warn("Meeting processor:", String(chunk).trim()));
    this.child.postMessage({ type: "start", sessionId, source, whisperExecutable, whisperModelPath });
  }

  appendFrame(frame) {
    this.child?.postMessage({ type: "appendFrames", pcm: frame.pcm, source: frame.source, sampleRate: Math.round(frame.sampleRate ?? 16_000), channels: frame.channels ?? 1 });
  }

  stop() {
    if (!this.child) return;
    this.child.postMessage({ type: "stop" });
  }

  close() {
    this.child?.kill();
    this.child = null;
  }
}
