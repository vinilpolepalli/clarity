// Screenshot harness. Launches the real app over a mock meeting backdrop and
// captures the *composited screen* (not the transparent window), so the glass
// is photographed with something behind it to refract.
//
// Run: NVIDIA_API_KEY=... xvfb-run -a npx playwright test demo/shoot.spec.js
const { test, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'assets', 'gallery');
fs.mkdirSync(OUT, { recursive: true });

test('capture the gallery', async () => {
  test.setTimeout(600000);
  const app = await electron.launch({
    args: [
      path.join(__dirname, '..'),
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream'
    ],
    env: { ...process.env, CLARITY_DEMO_BACKDROP: '1' }
  });

  // firstWindow() may hand back the backdrop; pick the overlay by its title.
  let win;
  for (let i = 0; i < 40 && !win; i++) {
    const wins = app.windows();
    for (const w of wins) {
      if ((await w.title()) === 'Clarity') win = w;
    }
    if (!win) await new Promise((r) => setTimeout(r, 250));
  }
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1200);

  /** Grab the whole X display, overlay composited over the backdrop. */
  async function shoot(name) {
    await win.waitForTimeout(500);
    const dataUrl = await app.evaluate(async ({ desktopCapturer, screen }) => {
      const d = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: d.size.width, height: d.size.height }
      });
      return sources[0].thumbnail.toDataURL();
    });
    fs.writeFileSync(
      path.join(OUT, name),
      Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')
    );
  }

  const wait = (re, ms = 120000) =>
    win.locator('#status').filter({ hasText: re }).waitFor({ timeout: ms }).catch(() => {});

  // --- Ask ---
  await win.locator('.tab[data-tab="ask"]').click();
  await win.locator('#askInput').fill('What should I say if the CFO pushes back on our Q3 burn rate?');
  await win.locator('#askSend').click();
  await wait(/Answered|Error/);
  await shoot('01-ask.png');

  // --- Listen: real speech through the real pipeline, both speakers ---
  await win.locator('.tab[data-tab="listen"]').click();
  await win.evaluate(async () => {
    const res = await fetch('../test/fixtures/speech.wav');
    const octx = new OfflineAudioContext(1, 1, 44100);
    const decoded = await octx.decodeAudioData(await res.arrayBuffer());
    const pcm = window.AudioEngine.resample(decoded.getChannelData(0), decoded.sampleRate);
    const e = window.__clarityEngine;
    for (let i = 0; i < pcm.length; i += 4096) e.pushSamples(pcm.slice(i, i + 4096), window.SPEAKER_THEM);
    e.flush(window.SPEAKER_THEM);
  });
  await wait(/Guidance updated|Error/, 240000);
  await shoot('02-listen.png');

  // --- Code ---
  await win.locator('.tab[data-tab="code"]').click();
  await win.locator('#codeInput').fill('Merge overlapping intervals and return the merged list.');
  await win.locator('#codeSend').click();
  await wait(/Code ready|Error/);
  await shoot('03-code.png');

  // --- Screen ---
  await win.locator('.tab[data-tab="screen"]').click();
  await win.locator('#screenInput').fill('What is on the slide behind this overlay?');
  await win.locator('#screenGo').click();
  await wait(/Screen analyzed|Error/);
  await shoot('04-screen.png');

  // --- Models dashboard ---
  await win.locator('.tab[data-tab="models"]').click();
  await win.locator('#refreshModels').click();
  await wait(/Models: \d+\/\d+ online/);
  await shoot('05-models.png');

  // --- Adaptive material over a bright backdrop ---
  // Swap the dark call for a white document; the luminance sampler should flip
  // the glass light on its own, with no help from the harness.
  await win.locator('.tab[data-tab="ask"]').click();
  await win.evaluate(() => {
    document.getElementById('demoBackdrop').src = '../demo/backdrop-light.html';
  });
  await win.waitForTimeout(1500);
  await win.locator('#askInput').fill('Churn fell from 3.4% to 2.1% this quarter. Give me one line I can say about it.');
  await win.locator('#askSend').click();
  await wait(/Answered|Error/);
  // give the 2.5s sampler a cycle to notice the bright backdrop
  await win.waitForFunction(() => document.body.classList.contains('light-backdrop'), null, { timeout: 20000 })
    .catch(() => {});
  await shoot('07-adaptive-light.png');

  // back to the dark call
  await win.evaluate(() => {
    document.getElementById('demoBackdrop').src = '../demo/backdrop.html';
  });
  await win.waitForTimeout(3500);

  // --- Collapsed pill (hidden body) ---
  await win.locator('.tab[data-tab="ask"]').click();
  await win.locator('#hideBtn').click();
  await shoot('06-collapsed.png');
  await win.locator('#hideBtn').click();

  await app.close();
});
