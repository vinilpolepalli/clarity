// Whisper speech-to-text worker (Transformers.js / ONNX WASM).
// Runs off the UI thread so live transcription never janks the overlay.
import { pipeline, env } from '@huggingface/transformers';

// Serve the ONNX WASM binaries from node_modules instead of a CDN.
env.backends.onnx.wasm.wasmPaths = '../node_modules/@huggingface/transformers/dist/';


// Load weights from the bundled models/ directory (populated by
// scripts/fetch-model.js) so transcription works offline and starts instantly.
env.allowRemoteModels = false;
env.allowLocalModels = true;
// In a packaged build the weights ship as an extra resource next to the asar,
// so the path differs from the checkout layout.
env.localModelPath = new URLSearchParams(self.location.search).get('models') || '../models/';

let MODEL = 'Xenova/whisper-small.en';
let transcriber = null;
let loading = null;

// The host configures the model and thread count over a message, but a
// transcribe request can arrive first. Hold every request until configuration
// lands, otherwise the first load silently pins the default model.
let markConfigured;
const configured = new Promise((resolve) => { markConfigured = resolve; });

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
  const { type, id, pcm, model, threads } = e.data;
  if (type === 'configure') {
    // Applied before the first load; changing the model later means a reload.
    if (model) MODEL = model;
    if (threads) env.backends.onnx.wasm.numThreads = threads;
    markConfigured();
    return;
  }
  await configured;
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
