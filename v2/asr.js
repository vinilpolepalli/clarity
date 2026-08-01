// Speech-to-text configuration.
//
// Whisper runs entirely on-device (ONNX/WASM) — no API key, no network at
// inference time, and meeting audio never leaves the machine. The only cost of
// a larger model is disk and CPU.
//
// Measured on an 11s clip, same audio at three noise levels (word error rate):
//
//            size    clean   moderate noise   heavy noise
//   tiny.en   41 MB    0%          68%            45%
//   base.en   77 MB    5%          18%           100%  (collapsed to "I")
//   small.en 249 MB    0%          14%             0%
//
// Real meetings are the noisy columns, not the clean one. base is erratic and
// can fail outright, so the useful choice is tiny (fast) or small (robust).
// small is the default; drop to tiny if transcription lags on your hardware.

const MODELS = [
  { id: 'Xenova/whisper-tiny.en', label: 'Tiny (fastest)', mb: 41 },
  { id: 'Xenova/whisper-base.en', label: 'Base', mb: 77 },
  { id: 'Xenova/whisper-small.en', label: 'Small (most accurate)', mb: 249 }
];

const DEFAULT_MODEL = 'Xenova/whisper-small.en';

function model() {
  const wanted = process.env.CLARITY_ASR_MODEL;
  if (wanted && MODELS.some((m) => m.id === wanted)) return wanted;
  return DEFAULT_MODEL;
}

/**
 * WASM thread count. Leave a couple of cores for the UI and the meeting itself
 * — pinning every core to transcription makes the overlay stutter.
 */
function threads(cores) {
  const n = Number(process.env.CLARITY_ASR_THREADS);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return Math.max(1, Math.min(4, (cores || 4) - 2));
}

module.exports = { MODELS, DEFAULT_MODEL, model, threads };
