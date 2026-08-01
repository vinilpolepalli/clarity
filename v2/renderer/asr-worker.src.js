// Whisper speech-to-text worker (Transformers.js / ONNX WASM).
// Runs off the UI thread so live transcription never janks the overlay.
import { pipeline, env } from '@huggingface/transformers';

// Serve the ONNX WASM binaries from node_modules instead of a CDN.
env.backends.onnx.wasm.wasmPaths = '../node_modules/@huggingface/transformers/dist/';
env.backends.onnx.wasm.numThreads = 1;

// Load weights from the bundled models/ directory (populated by
// scripts/fetch-model.js) so transcription works offline and starts instantly.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '../models/';

const MODEL = 'Xenova/whisper-tiny.en';
let transcriber = null;
let loading = null;

async function getTranscriber() {
  if (transcriber) return transcriber;
  if (!loading) {
    loading = pipeline('automatic-speech-recognition', MODEL, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file && p.total) {
          self.postMessage({
            type: 'load-progress',
            file: p.file,
            pct: Math.round((p.loaded / p.total) * 100)
          });
        }
      }
    }).then((t) => {
      transcriber = t;
      self.postMessage({ type: 'ready', model: MODEL });
      return t;
    });
  }
  return loading;
}

self.onmessage = async (e) => {
  const { type, id, pcm } = e.data;
  try {
    if (type === 'warmup') {
      await getTranscriber();
      return;
    }
    if (type === 'transcribe') {
      const t = await getTranscriber();
      const started = Date.now();
      const out = await t(pcm);
      const text = (out.text || '').trim();
      self.postMessage({ type: 'transcript', id, text, ms: Date.now() - started });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, error: String(err.message || err) });
  }
};
