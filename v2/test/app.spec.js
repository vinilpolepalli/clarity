const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const SHOTS = path.join(__dirname, '..', 'assets', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let app, win;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [
      path.join(__dirname, '..'),
      // Headless CI has no real microphone; Chromium's fake capture device lets
      // the genuine getUserMedia/AudioContext wiring be exercised.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'
    ],
    env: {
      ...process.env,
      NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || '',
      ELECTRON_DISABLE_SANDBOX: '1'
    }
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(600);
});

test.afterAll(async () => { await app.close(); });

async function shot(name) {
  await win.screenshot({ path: path.join(SHOTS, name) });
}

test('loads with Ask tab active and glass bar', async () => {
  await expect(win.locator('.brand')).toContainText('Clarity');
  await expect(win.locator('.tab.active')).toHaveText('Ask');
  await shot('01-launch.png');
});

test('every tab switches panels', async () => {
  for (const tab of ['listen', 'code', 'screen', 'models', 'ask']) {
    await win.locator(`.tab[data-tab="${tab}"]`).click();
    await win.waitForTimeout(150);
    await expect(win.locator(`.panel[data-panel="${tab}"]`)).toBeVisible();
  }
  await win.locator('.tab[data-tab="ask"]').click();
});

test('Ask calls NIM and renders an answer', async () => {
  await win.locator('.tab[data-tab="ask"]').click();
  await win.locator('#askInput').fill('What is 17 + 25? Answer with just the number.');
  await win.locator('#askSend').click();
  await expect(win.locator('#status')).toContainText(/Answered|Error/, { timeout: 90000 });
  const status = await win.locator('#status').textContent();
  expect(status, `Ask status was: ${status}`).toContain('Answered');
  await shot('02-ask.png');
});

test('Code generates a solution', async () => {
  await win.locator('.tab[data-tab="code"]').click();
  await win.locator('#codeInput').fill('Write a function to reverse a string.');
  await win.locator('#codeSend').click();
  await expect(win.locator('#status')).toContainText(/Code ready|Error/, { timeout: 90000 });
  const status = await win.locator('#status').textContent();
  expect(status, `Code status was: ${status}`).toContain('Code ready');
  await shot('03-code.png');
});

test('Listen adds transcript and produces guidance', async () => {
  await win.locator('.tab[data-tab="listen"]').click();
  await win.locator('#meetInput').fill('Interviewer: Tell me about a time you resolved a conflict.');
  await win.locator('#meetAdd').click();
  await expect(win.locator('#transcript .line')).toHaveCount(1);
  await expect(win.locator('#status')).toContainText(/Guidance updated|Error/, { timeout: 90000 });
  const status = await win.locator('#status').textContent();
  expect(status, `Listen status was: ${status}`).toContain('Guidance updated');
  await shot('04-listen.png');
});

test('live speech is transcribed by Whisper and appended to the transcript', async () => {
  test.setTimeout(300000); // first call loads ~42 MB of weights into WASM
  await win.locator('.tab[data-tab="listen"]').click();
  const before = await win.locator('#transcript .line').count();

  // Push real recorded speech through the exact resample -> VAD -> Whisper
  // path that the live microphone feeds, in the same 4096-sample frames the
  // live ScriptProcessor delivers.
  const pushed = await win.evaluate(async () => {
    const res = await fetch('../test/fixtures/speech.wav');
    const ab = await res.arrayBuffer();
    const octx = new OfflineAudioContext(1, 1, 44100);
    const decoded = await octx.decodeAudioData(ab);
    const pcm = window.AudioEngine.resample(decoded.getChannelData(0), decoded.sampleRate);
    const e = window.__clarityEngine;
    for (let i = 0; i < pcm.length; i += 4096) e.pushSamples(pcm.slice(i, i + 4096));
    e.flush();
    return pcm.length;
  });
  expect(pushed).toBeGreaterThan(16000);

  // First run downloads the Whisper weights, so allow generous time.
  await expect(win.locator('#transcript .line')).toHaveCount(before + 1, { timeout: 240000 });
  const lines = await win.locator('#transcript .line').allTextContents();
  const transcribed = lines[lines.length - 1].toLowerCase();
  expect(transcribed, `Whisper produced: ${transcribed}`).toContain('country');
  await shot('08-live-transcription.png');
});

test('mic capture starts and stops through the real getUserMedia path', async () => {
  await win.locator('.tab[data-tab="listen"]').click();
  await win.locator('#listenBtn').click();
  await expect(win.locator('#listenState')).toContainText(/Live — capturing/, { timeout: 30000 });
  await expect(win.locator('#listenBtn')).toHaveText(/Stop Listening/);
  await win.locator('#listenBtn').click();
  await expect(win.locator('#listenBtn')).toHaveText(/Start Listening/);
  await expect(win.locator('#status')).toContainText('Stopped listening');
});

test('Screen tab captures the screen and analyzes it with a vision model', async () => {
  await win.locator('.tab[data-tab="screen"]').click();
  await win.locator('#screenInput').fill('What application is shown here?');
  await win.locator('#screenGo').click();
  await expect(win.locator('#status')).toContainText(/Screen analyzed|Error/, { timeout: 120000 });
  const status = await win.locator('#status').textContent();
  expect(status, `Screen status was: ${status}`).toContain('Screen analyzed');

  // The capture must be a compact JPEG — NIM rejects inline images much over
  // ~180 KB, and oversized PNGs previously caused silent 500s.
  const cap = await win.evaluate(() => window.clarity.captureScreen());
  expect(cap.startsWith('data:image/jpeg;base64,')).toBe(true);
  expect(cap.length).toBeLessThan(180000);

  const out = (await win.locator('#screenOut').textContent()).trim();
  expect(out.length).toBeGreaterThan(20);
  // Regression guard: passing the image as an <img> tag made the model describe
  // the data URI ("a PNG image with a binary data representation") not the screen.
  expect(out, `Vision output was: ${out}`).not.toMatch(/binary data|data representation/i);
  await shot('07-screen.png');
});

test('undetectable (content protection) is on by default and toggles', async () => {
  const st = await win.evaluate(() => window.clarity.getState());
  expect(st.contentProtection).toBe(true);
  await expect
    .poll(() => win.locator('#stealthBtn').evaluate((b) => b.classList.contains('on')))
    .toBe(true);

  await win.locator('#stealthBtn').click();
  await expect(win.locator('#status')).toContainText('Undetectable OFF');
  expect((await win.evaluate(() => window.clarity.getState())).contentProtection).toBe(false);

  await win.locator('#stealthBtn').click();
  await expect(win.locator('#status')).toContainText('Undetectable ON');
  expect((await win.evaluate(() => window.clarity.getState())).contentProtection).toBe(true);
});

test('Models dashboard pings NIM models', async () => {
  await win.locator('.tab[data-tab="models"]').click();
  await win.locator('#refreshModels').click();
  await expect(win.locator('.model-card')).toHaveCount(8, { timeout: 5000 });
  await expect(win.locator('#status')).toContainText(/Models: \d+\/\d+ online/, { timeout: 60000 });
  // at least one online, and inkling default is selected
  await expect(win.locator('.model-card .status-dot.ok').first()).toBeVisible();
  await shot('05-models.png');
});

test('selecting a model updates active model', async () => {
  await win.locator('.tab[data-tab="models"]').click();
  await win.locator('.model-card[data-id="meta/llama-3.1-8b-instruct"]').click();
  await expect(win.locator('#activeModel')).toHaveText('meta/llama-3.1-8b-instruct');
  // restore default
  await win.locator('.model-card[data-id="thinkingmachines/inkling"]').click();
  await expect(win.locator('#activeModel')).toHaveText('thinkingmachines/inkling');
});

test('top-bar hide toggle works', async () => {
  await win.locator('#hideBtn').click();
  await expect(win.locator('#body')).toBeHidden();
  await win.locator('#hideBtn').click();
  await expect(win.locator('#body')).toBeVisible();
  await shot('06-final.png');
});

test('click-through toggle sets state (last: window then ignores mouse)', async () => {
  // Enabling click-through makes the OS window ignore mouse events, so a second
  // real click can't reach the button — drive the toggles via DOM click().
  await win.locator('#clickThroughBtn').evaluate((b) => b.click());
  await expect.poll(() => win.locator('#clickThroughBtn').evaluate((b) => b.classList.contains('on'))).toBe(true);
  await expect(win.locator('#status')).toContainText('Click-through ON');
  await win.locator('#clickThroughBtn').evaluate((b) => b.click());
  await expect.poll(() => win.locator('#clickThroughBtn').evaluate((b) => b.classList.contains('on'))).toBe(false);
  await expect(win.locator('#status')).toContainText('Click-through OFF');
});
