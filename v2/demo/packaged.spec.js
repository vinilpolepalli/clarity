// Validates the packaged artifact, not the checkout: different model path,
// asar-packed renderer, trimmed node_modules.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

function decodeWav(buf) {
  let off = 12, dataOff = 0, dataLen = 0, sr = 16000, ch = 1;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4), sz = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(off + 10); sr = buf.readUInt32LE(off + 12); }
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  const n = Math.floor(dataLen / 2 / ch), src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = buf.readInt16LE(dataOff + i * 2 * ch) / 32768;
  const ratio = sr / 16000, outN = Math.floor(n / ratio), out = new Float32Array(outN);
  for (let i = 0; i < outN; i++) {
    const p = i * ratio, i0 = Math.floor(p), fr = p - i0;
    out[i] = src[i0] * (1 - fr) + src[Math.min(i0 + 1, n - 1)] * fr;
  }
  return Array.from(out);
}

test('packaged app loads its bundled weights and transcribes', async () => {
  test.setTimeout(600000);
  const app = await electron.launch({
    executablePath: path.join(__dirname, '..', 'dist', 'linux-unpacked', 'clarity-v2'),
    args: ['--no-sandbox'],
    env: { ...process.env, CLARITY_ASR_MODEL: 'Xenova/whisper-tiny.en' }
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1000);
  await expect(win.locator('.brand')).toContainText('Clarity');

  // Weights must resolve from resources/, not the source-tree layout.
  const modelsArg = await win.evaluate(() => new URLSearchParams(location.search).get('models'));
  expect(modelsArg, 'packaged build must point at resources/models').toContain('resources/models');

  const pcm = decodeWav(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'speech.wav')));
  const text = await win.evaluate(async (samples) => {
    const e = window.__clarityEngine;
    const out = [];
    e.onTranscript = (t) => out.push(t);
    const buf = Float32Array.from(samples);
    for (let i = 0; i < buf.length; i += 4096) e.pushSamples(buf.slice(i, i + 4096), 'Them');
    e.flush('Them');
    const t0 = Date.now();
    while (!out.length && Date.now() - t0 < 300000) await new Promise((r) => setTimeout(r, 250));
    return out[0] || '';
  }, pcm);

  console.log('PACKAGED TRANSCRIPT: ' + JSON.stringify(text));
  expect(text.toLowerCase()).toContain('country');
  await app.close();
});
