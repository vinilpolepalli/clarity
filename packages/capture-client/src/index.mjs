import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class BoundedQueue {
  constructor(capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError("Queue capacity must be positive");
    this.capacity = capacity;
    this.items = [];
    this.dropped = 0;
  }
  push(value) {
    if (this.items.length === this.capacity) { this.items.shift(); this.dropped += 1; }
    this.items.push(value);
  }
  shift() { return this.items.shift(); }
  get length() { return this.items.length; }
}

export class SequenceTracker {
  constructor() { this.epoch = null; this.next = 0; this.discontinuities = 0; }
  accept(frame) {
    if (this.epoch !== frame.epoch) { this.epoch = frame.epoch; this.next = frame.sequence + 1; return { accepted: true, reset: true, gap: 0 }; }
    const gap = Math.max(0, frame.sequence - this.next);
    if (gap) this.discontinuities += 1;
    if (frame.sequence < this.next) return { accepted: false, reset: false, gap: 0 };
    this.next = frame.sequence + 1;
    return { accepted: true, reset: false, gap };
  }
}

export class RollingAudioBuffer {
  constructor(maxBytes = 16_000 * 2 * 30) { this.maxBytes = maxBytes; this.chunks = []; this.bytes = 0; }
  append(chunk) {
    const data = Buffer.from(chunk);
    this.chunks.push(data); this.bytes += data.length;
    while (this.bytes > this.maxBytes) {
      const excess = this.bytes - this.maxBytes;
      const first = this.chunks[0];
      if (first.length <= excess) { this.chunks.shift(); this.bytes -= first.length; }
      else { this.chunks[0] = first.subarray(excess); this.bytes -= excess; }
    }
  }
  snapshot() { return Buffer.concat(this.chunks).subarray(Math.max(0, this.bytes - this.maxBytes)); }
  clear() { this.chunks = []; this.bytes = 0; }
}

export class NativeCaptureClient {
  constructor({ executable, onEvent = (_event) => {}, onFrame = (_frame) => {} }) {
    this.executable = executable; this.onEvent = onEvent; this.onFrame = onFrame;
    this.child = null; this.pending = new Map(); this.requestSequence = 0; this.watchdog = null;
  }
  async connect() {
    if (this.child) return;
    this.child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.consume(line));
    createInterface({ input: this.child.stderr }).on("line", (line) => this.onEvent({ type: "diagnostic", message: line.slice(0, 1_000) }));
    this.child.on("exit", (code) => { this.onEvent({ type: "exit", code }); this.failPending(new Error(`Capture helper exited with code ${code}`)); this.child = null; });
    await this.request("hello", { protocolVersion: 1 });
  }
  consume(line) {
    let event;
    try { event = JSON.parse(line); } catch { this.onEvent({ type: "protocol-error", message: "Capture helper returned invalid JSON" }); return; }
    if (event.type === "audio") { this.onFrame({ ...event, pcm: Buffer.from(event.pcm, "base64") }); return; }
    if (event.requestId && this.pending.has(event.requestId)) {
      const pending = this.pending.get(event.requestId); this.pending.delete(event.requestId);
      event.ok === false ? pending.reject(new Error(event.error ?? "Capture command failed")) : pending.resolve(event);
    }
    this.onEvent(event);
  }
  request(command, payload = {}) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Capture helper is not connected"));
    const requestId = `capture-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Capture helper timed out during ${command}`)); }, 5_000);
      this.pending.set(requestId, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
      this.child.stdin.write(`${JSON.stringify({ protocolVersion: 1, requestId, command, ...payload })}\n`);
    });
  }
  start(options) { return this.request("start", options); }
  stop() { return this.request("stop"); }
  async close() { if (!this.child) return; try { await this.stop(); } catch {} this.child.kill("SIGTERM"); this.child = null; }
  failPending(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
}
