import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export function whisperArguments({ modelPath, audioPath, language = "auto", threads = 4 }) {
  if (!modelPath || !audioPath) throw new Error("Whisper model and audio paths are required");
  return ["--model", modelPath, "--file", audioPath, "--output-json", "--no-timestamps", "--threads", String(Math.max(1, Math.min(threads, 12))), ...(language === "auto" ? [] : ["--language", language])];
}

export async function transcribeWithWhisper({ executable = "whisper-cli", timeoutMs = 120_000, ...options }) {
  const { stdout } = await execFileAsync(executable, whisperArguments({ modelPath: options.modelPath, audioPath: options.audioPath, language: options.language, threads: options.threads }), { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  return { text: String(parsed.transcription?.map((part) => part.text).join(" ") ?? parsed.text ?? "").trim(), language: parsed.result?.language ?? options.language ?? "auto" };
}
