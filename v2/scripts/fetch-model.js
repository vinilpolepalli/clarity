#!/usr/bin/env node
// Pre-download the Whisper speech-to-text weights into v2/models/ so the app
// transcribes offline and never stalls mid-meeting on a 40 MB download.
//
// Run: node scripts/fetch-model.js
const fs = require('fs');
const path = require('path');

const asr = require('../asr');
// Fetch whichever model is configured (CLARITY_ASR_MODEL), plus tiny as a
// fallback so dropping to it later needs no download mid-meeting.
const MODEL = asr.model();
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
];


async function fetchModel(id) {
  const DEST = path.join(__dirname, '..', 'models', id);
  const BASE = `https://huggingface.co/${id}/resolve/main`;
  console.log(`\n${id}`);
  let fetched = 0;
  for (const rel of FILES) {
    const out = path.join(DEST, rel);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      console.log(`  ok   ${rel}`);
      continue;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    process.stdout.write(`  get  ${rel} … `);
    const res = await fetch(`${BASE}/${rel}`);
    if (!res.ok) throw new Error(`${res.status} fetching ${rel}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(out, buf);
    fetched++;
    console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
  }
  console.log(`  ready at models/${id} (${fetched} newly downloaded)`);
}

async function main() {
  // Always keep tiny available as the quick fallback.
  const wanted = [...new Set([MODEL, 'Xenova/whisper-tiny.en'])];
  for (const id of wanted) await fetchModel(id);
}

main().catch((e) => {
  console.error('Model fetch failed:', e.message);
  process.exit(1);
});
