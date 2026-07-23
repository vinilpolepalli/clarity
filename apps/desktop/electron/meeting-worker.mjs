import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { mixPcm16, pcmDurationMs, rmsPcm16, takePcm } from "./meeting-audio.mjs";

const execFileAsync = promisify(execFile);
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const PAUSE_MS = 900;
const MAX_BATCH_MS = 60_000;
const MIN_BATCH_MS = 1_000;
const ENERGY_THRESHOLD = 450;
const MIX_HOLD_BYTES = 1_600;

let session = null;

function send(type, payload = {}) {
  process.parentPort.postMessage({ type, ...payload });
}

function acceptsSource(source) {
  return session?.source === "both" || session?.source === source;
}

function resetBatch() {
  session.chunks = [];
  session.batchBytes = 0;
  session.batchStartedMs = session.elapsedMs;
  session.lastSpeechMs = session.elapsedMs;
}

function wavHeader(dataLength, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function appendMono(data) {
  const duration = pcmDurationMs(data, SAMPLE_RATE, 1);
  if (!duration) return;
  session.chunks.push(data);
  session.batchBytes += data.length;
  session.elapsedMs += duration;
  if (rmsPcm16(data) >= ENERGY_THRESHOLD) session.lastSpeechMs = session.elapsedMs;
  const batchDuration = session.elapsedMs - session.batchStartedMs;
  const quietFor = session.elapsedMs - session.lastSpeechMs;
  if (batchDuration >= MAX_BATCH_MS) void finalizeBatch("max-duration");
  else if (batchDuration >= MIN_BATCH_MS && quietFor >= PAUSE_MS) void finalizeBatch("speech-pause");
}

function drainMixedSources({ flush = false } = {}) {
  const pending = session.pendingBySource;
  while (pending.microphone.length && pending.system.length) {
    const length = Math.min(pending.microphone.length, pending.system.length) - (Math.min(pending.microphone.length, pending.system.length) % BYTES_PER_SAMPLE);
    const microphone = takePcm(pending.microphone, length);
    const system = takePcm(pending.system, length);
    pending.microphone = microphone.tail;
    pending.system = system.tail;
    appendMono(mixPcm16(microphone.head, system.head));
  }
  for (const source of ["microphone", "system"]) {
    while (pending[source].length >= MIX_HOLD_BYTES || (flush && pending[source].length)) {
      const length = flush ? pending[source].length : MIX_HOLD_BYTES;
      const chunk = takePcm(pending[source], length);
      pending[source] = chunk.tail;
      appendMono(chunk.head);
    }
  }
}

async function transcribePcm(pcm, startedMs, endedMs) {
  if (process.env.CLARITY_TEST === "1") {
    return { text: "Test meeting transcript: the team agreed to ship the live notes slice. Alex will verify the YouTube playback test.", startedMs, endedMs };
  }
  if (!session?.whisperModelPath) throw new Error("Choose a local Whisper model in Audio settings before starting live notes.");
  const directory = await mkdtemp(join(tmpdir(), "clarity-meeting-"));
  const audioPath = join(directory, "batch.wav");
  try {
    await writeFile(audioPath, Buffer.concat([wavHeader(pcm.length), pcm]), { mode: 0o600 });
    const { stdout } = await execFileAsync(session.whisperExecutable, ["--model", session.whisperModelPath, "--file", audioPath, "--output-json", "--no-timestamps", "--threads", "4"], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    const text = String(parsed.transcription?.map((part) => part.text).join(" ") ?? parsed.text ?? "").trim();
    return { text, startedMs, endedMs };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function finalizeBatch(reason) {
  if (!session || session.batchBytes === 0) return;
  const startedMs = session.batchStartedMs;
  const endedMs = session.elapsedMs;
  const duration = endedMs - startedMs;
  if (duration < MIN_BATCH_MS && reason !== "stop") return;
  const pcm = Buffer.concat(session.chunks);
  resetBatch();
  send("status", { status: "transcribing" });
  try {
    const transcript = await transcribePcm(pcm, startedMs, endedMs);
    if (transcript.text) send("transcript", transcript);
    send("status", { status: "listening" });
  } catch (error) {
    send("failure", { stage: "transcription", message: error instanceof Error ? error.message : "Local transcription failed.", retryable: false });
  }
}

function appendFrame({ pcm, source, sampleRate = SAMPLE_RATE, channels = 1 }) {
  if (!session || !acceptsSource(source)) return;
  if (sampleRate !== SAMPLE_RATE || channels !== 1) {
    send("failure", { stage: "capture", message: "This capture source must provide 16 kHz mono PCM for live notes.", retryable: false });
    return;
  }
  const data = Buffer.from(pcm);
  if (session.source === "both") {
    session.pendingBySource[source] = Buffer.concat([session.pendingBySource[source], data]);
    drainMixedSources();
    return;
  }
  appendMono(data);
}

process.parentPort.on("message", (event) => {
  const message = event.data ?? {};
  if (message.type === "start") {
    session = {
      id: message.sessionId,
      source: message.source ?? "both",
      whisperExecutable: message.whisperExecutable ?? "whisper-cli",
      whisperModelPath: message.whisperModelPath ?? "",
      chunks: [],
      batchBytes: 0,
      batchStartedMs: 0,
      lastSpeechMs: 0,
      elapsedMs: 0,
      pendingBySource: { microphone: Buffer.alloc(0), system: Buffer.alloc(0) }
    };
    send("status", { status: "listening" });
    return;
  }
  if (message.type === "appendFrames") return appendFrame(message);
  if (message.type === "stop") {
    drainMixedSources({ flush: true });
    void finalizeBatch("stop").finally(() => { send("stopped"); session = null; });
    return;
  }
  if (message.type === "finalizeBatch") void finalizeBatch("manual");
});
