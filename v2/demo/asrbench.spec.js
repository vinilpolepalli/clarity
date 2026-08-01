const { test, _electron: electron } = require('@playwright/test');
const path = require('path');
test('in-app ASR latency', async () => {
  test.setTimeout(900000);
  for (const model of ['Xenova/whisper-tiny.en', 'Xenova/whisper-small.en']) {
    const app = await electron.launch({
      args: [path.join(__dirname, '..')],
      env: { ...process.env, CLARITY_ASR_MODEL: model }
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForTimeout(800);
    const r = await win.evaluate(async () => {
      const res = await fetch('../test/fixtures/speech.wav');
      const octx = new OfflineAudioContext(1, 1, 44100);
      const d = await octx.decodeAudioData(await res.arrayBuffer());
      const pcm = window.AudioEngine.resample(d.getChannelData(0), d.sampleRate);
      const e = window.__clarityEngine;
      const out = [];
      let loaded = null;
      const origStatus = e.onStatus;
      e.onStatus = (m) => { if (/ready/.test(m)) loaded = Date.now(); };
      e.onTranscript = (text, spk, ms) => out.push({ text, ms });
      const t0 = Date.now();
      for (let i = 0; i < pcm.length; i += 4096) e.pushSamples(pcm.slice(i, i + 4096), 'Them');
      e.flush('Them');
      while (!out.length && Date.now() - t0 < 600000) await new Promise((r) => setTimeout(r, 200));
      return { total: Date.now() - t0, ...out[0], audioSec: pcm.length / 16000, reported: e.model };
    });
    const x = (r.ms / 1000 / r.audioSec).toFixed(2);
    console.log(`ASRBENCH ${model.split('/').pop().padEnd(17)} using=${(r.reported||'?').split('/').pop().padEnd(17)} transcribe=${String(r.ms).padStart(6)}ms  ${x}x realtime  "${(r.text||'').slice(0,60)}"`);
    await app.close();
  }
});
