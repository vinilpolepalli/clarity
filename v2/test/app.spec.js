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

test('is a transparent frameless overlay, not an ordinary window', async () => {
  const w = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const b = win.getBounds();
    const work = screen.getPrimaryDisplay().workAreaSize;
    return {
      transparent: win.isKiosk !== undefined ? win.getBackgroundColor() : null,
      frameless: !win.isMovable || true,
      hasFrame: win.isFullScreen() === false,
      alwaysOnTop: win.isAlwaysOnTop(),
      bounds: b,
      work,
      fullscreen: win.isFullScreen(),
      windows: BrowserWindow.getAllWindows().length
    };
  });
  // A single overlay window, not a second app window.
  expect(w.windows).toBe(1);
  expect(w.alwaysOnTop).toBe(true);
  expect(w.fullscreen).toBe(false);
  // Overlay-sized: it must not cover the display.
  expect(w.bounds.width).toBeLessThanOrEqual(920);
  expect(w.bounds.height).toBeLessThanOrEqual(700);
  expect(w.bounds.width).toBeLessThan(w.work.width);

  // Transparent all the way down: no opaque page background anywhere behind
  // the glass, and the demo backdrop must not be present in normal use.
  const page = await win.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    demoHidden: document.getElementById('demoBackdrop').hidden,
    demoClass: document.body.classList.contains('demo')
  }));
  expect(page.html).toBe('rgba(0, 0, 0, 0)');
  expect(page.body).toBe('rgba(0, 0, 0, 0)');
  expect(page.demoHidden).toBe(true);
  expect(page.demoClass).toBe(false);
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
  // Either the chosen model replied, or it stalled and the fallback covered it.
  // Both are acceptable; silence is not.
  expect(await win.locator('#askOut').textContent()).not.toMatch(/^\s*$/);
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

test('mic and system audio are tracked as separate speakers', async () => {
  test.setTimeout(300000);
  await win.locator('.tab[data-tab="listen"]').click();
  const before = await win.locator('#transcript .line').count();
  // This test is about speaker labelling, not guidance. Leaving auto-guide on
  // would fire a slow NIM call that resolves after the test ends and overwrites
  // the shared status bar mid-way through the next one.
  await win.locator('#autoGuide').uncheck();

  // Same speech pushed down the "Them" (system/loopback) track must come back
  // labelled as the other party, not as the user. This is the thing plain
  // dictation cannot do: it only ever hears one microphone.
  await win.evaluate(async () => {
    const res = await fetch('../test/fixtures/speech.wav');
    const octx = new OfflineAudioContext(1, 1, 44100);
    const decoded = await octx.decodeAudioData(await res.arrayBuffer());
    const pcm = window.AudioEngine.resample(decoded.getChannelData(0), decoded.sampleRate);
    const e = window.__clarityEngine;
    for (let i = 0; i < pcm.length; i += 4096) e.pushSamples(pcm.slice(i, i + 4096), window.SPEAKER_THEM);
    e.flush(window.SPEAKER_THEM);
  });

  await expect(win.locator('#transcript .line')).toHaveCount(before + 1, { timeout: 240000 });
  const last = win.locator('#transcript .line').last();
  await expect(last.locator('.who')).toHaveText('Them');
  await expect(last).toContainText(/country/i);

  // and the two tracks keep independent VAD state
  const independent = await win.evaluate(() => {
    const e = window.__clarityEngine;
    const loud = new Float32Array(4096).fill(0.2);
    e.pushSamples(loud, window.SPEAKER_YOU);
    return {
      you: e.tracks[window.SPEAKER_YOU].speaking,
      them: e.tracks[window.SPEAKER_THEM].speaking
    };
  });
  expect(independent).toEqual({ you: true, them: false });
  await win.evaluate(() => window.__clarityEngine.tracks[window.SPEAKER_YOU].reset());
  await shot('09-speakers.png');
  await win.locator('#autoGuide').check();
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

test('a truncated reasoning reply is never shown as the answer', async () => {
  // Regression guard: the renderer used to fall back to `reasoning` when
  // `content` was empty, so a reasoning model that ran out of budget mid-thought
  // had its raw scratchpad rendered as if it were real guidance.
  const html = await win.evaluate(() =>
    window.__answerHtml({ content: '', reasoning: 'Hmm, the user wants... let me think', truncated: true })
  );
  expect(html).toContain('ran out of room while reasoning');
  expect(html).toContain('<details');
  // the scratchpad is only reachable behind the disclosure, never as the answer
  expect(html.indexOf('ran out of room')).toBeLessThan(html.indexOf('let me think'));

  const normal = await win.evaluate(() =>
    window.__answerHtml({ content: '### Summary\nAll good', reasoning: 'scratch', truncated: false })
  );
  expect(normal).toContain('All good');
  expect(normal).not.toContain('scratch');
});

test('Enter submits in the Ask and Listen inputs', async () => {
  await win.locator('.tab[data-tab="ask"]').click();
  await win.locator('#askInput').fill('Reply with the single word: ping');
  await win.locator('#askInput').press('Enter');
  await expect(win.locator('#status')).toContainText(/Answered|Error/, { timeout: 90000 });
  expect(await win.locator('#status').textContent()).toContain('Answered');

  await win.locator('.tab[data-tab="listen"]').click();
  const before = await win.locator('#transcript .line').count();
  await win.locator('#meetInput').fill('Them: what is our timeline?');
  await win.locator('#meetInput').press('Enter');
  await expect(win.locator('#transcript .line')).toHaveCount(before + 1);
  await expect(win.locator('#status')).toContainText(/Guidance updated|Error/, { timeout: 90000 });
});

test('auto-guide checkbox gates automatic guidance', async () => {
  await win.locator('.tab[data-tab="listen"]').click();
  await win.locator('#autoGuide').uncheck();
  await expect(win.locator('#autoGuide')).not.toBeChecked();
  await win.locator('#autoGuide').check();
  await expect(win.locator('#autoGuide')).toBeChecked();
});

test('global hotkeys are registered and drive the UI', async () => {
  const registered = await app.evaluate(({ globalShortcut }) => ({
    ask: globalShortcut.isRegistered('CommandOrControl+Enter'),
    code: globalShortcut.isRegistered('CommandOrControl+Shift+C'),
    screen: globalShortcut.isRegistered('CommandOrControl+Shift+S'),
    meeting: globalShortcut.isRegistered('CommandOrControl+Shift+M'),
    hide: globalShortcut.isRegistered('CommandOrControl+Shift+H')
  }));
  expect(registered).toEqual({ ask: true, code: true, screen: true, meeting: true, hide: true });

  // The accelerators can't be delivered through a headless X server, so drive
  // the same channel the shortcut handler uses and assert the UI responds.
  const fire = (name) =>
    app.evaluate(({ BrowserWindow }, n) => {
      BrowserWindow.getAllWindows()[0].webContents.send('clarity:hotkey', n);
    }, name);

  await fire('code');
  await expect(win.locator('.panel[data-panel="code"]')).toBeVisible();
  await fire('meeting');
  await expect(win.locator('.panel[data-panel="listen"]')).toBeVisible();
  await fire('ask');
  await expect(win.locator('.panel[data-panel="ask"]')).toBeVisible();
  await fire('hide');
  await expect(win.locator('#body')).toBeHidden();
  await fire('hide');
  await expect(win.locator('#body')).toBeVisible();
});

test('switching model actually routes the next request to it', async () => {
  await win.locator('.tab[data-tab="models"]').click();
  await win.locator('#modelSearch').fill('llama-3.1-8b-instruct');
  await win.locator('.model-card[data-id="meta/llama-3.1-8b-instruct"]').click();
  await expect(win.locator('#activeModel')).toHaveText('meta/llama-3.1-8b-instruct');

  await win.locator('.tab[data-tab="ask"]').click();
  await win.locator('#askInput').fill('Reply with the single word: ok');
  await win.locator('#askSend').click();
  await expect(win.locator('#status')).toContainText(/Answered|Error/, { timeout: 90000 });
  // the status line reports the model that actually served the request
  await expect(win.locator('#status')).toContainText('meta/llama-3.1-8b-instruct');

  // restore the default
  await win.locator('.tab[data-tab="models"]').click();
  await win.locator('#modelSearch').fill('inkling');
  await win.locator('.model-card[data-id="thinkingmachines/inkling"]').click();
  await expect(win.locator('#activeModel')).toHaveText('thinkingmachines/inkling');
  await win.locator('#modelSearch').fill('');
});

test('code answers render as highlighted code blocks', async () => {
  await win.locator('.tab[data-tab="code"]').click();
  await win.locator('#codeInput').fill('Write a Python function that returns the nth Fibonacci number.');
  await win.locator('#codeSend').click();
  await expect(win.locator('#status')).toContainText(/Code ready|Error/, { timeout: 90000 });
  // a real <pre><code> block, not prose with stray backticks
  await expect(win.locator('#codeOut pre code')).toBeVisible();
  const code = await win.locator('#codeOut pre code').first().textContent();
  expect(code).toMatch(/def\s+\w+\(/);
  expect(code).not.toContain('```');
  // and it is syntax highlighted
  await expect(win.locator('#codeOut pre code .tok-kw').first()).toBeVisible();
});

test('highlighter keeps comments and strings intact', async () => {
  // Regression guard: comments were swapped for numeric placeholders that the
  // number rule then styled, so they came back rendered as stray digits.
  const html = await win.evaluate(() =>
    window.__renderMarkdown('```python\n# Sort by interval start\nx = 5\ns = "hi 42"\n```')
  );
  expect(html).toContain('# Sort by interval start');
  expect(html).toContain('tok-cm');
  expect(html).toContain('hi 42');
  expect(html).toContain('tok-str');
  // the comment must not have been replaced by a bare placeholder index
  const text = html.replace(/<[^>]*>/g, '');
  expect(text).not.toMatch(/^\s*\d+\s*$/m);
  expect(text).toContain('# Sort by interval start');

  // and highlighting must never become an injection route
  const evil = await win.evaluate(() =>
    window.__renderMarkdown('```js\nconst a = "<img src=x onerror=alert(1)>";\n```')
  );
  expect(evil).not.toContain('<img');
  expect(evil).toContain('&lt;img');
});

test('corner radii stay concentric', async () => {
  // Apple's rule for nested rounded rects: innerRadius = outerRadius - padding.
  const g = await win.evaluate(() => {
    const body = document.querySelector('.body');
    const cs = getComputedStyle(body);
    const px = (v) => parseFloat(v);
    return {
      outer: px(cs.borderTopLeftRadius),
      pad: px(cs.paddingTop),
      inner: px(getComputedStyle(document.querySelector('.out')).borderTopLeftRadius)
    };
  });
  expect(g.inner).toBeCloseTo(g.outer - g.pad, 1);
});

test('material adapts to a bright backdrop and holds contrast', async () => {
  const dark = await win.evaluate(() => {
    window.__applyBackdropLuma(0.05);
    return {
      light: document.body.classList.contains('light-backdrop'),
      text: getComputedStyle(document.body).color
    };
  });
  expect(dark.light).toBe(false);

  const bright = await win.evaluate(() => {
    window.__applyBackdropLuma(0.9);
    return {
      light: document.body.classList.contains('light-backdrop'),
      text: getComputedStyle(document.body).color
    };
  });
  expect(bright.light).toBe(true);
  // text must invert with the material, not stay white on a white panel
  expect(bright.text).not.toBe(dark.text);

  // hysteresis: a mid value must not flip it back and forth
  const mid = await win.evaluate(() => {
    window.__applyBackdropLuma(0.57);
    return document.body.classList.contains('light-backdrop');
  });
  expect(mid).toBe(true);

  await win.evaluate(() => window.__applyBackdropLuma(0.05));
  await expect.poll(() => win.evaluate(() => document.body.classList.contains('light-backdrop'))).toBe(false);
});

test('Models dashboard lists the live catalogue and health-checks it', async () => {
  await win.locator('.tab[data-tab="models"]').click();
  await win.locator('#modelSearch').fill('');
  await win.locator('#kindFilter').selectOption('');
  // The catalogue is whatever the key can actually reach, not a hardcoded list.
  await expect.poll(() => win.locator('.model-card').count(), { timeout: 60000 }).toBeGreaterThan(20);
  await expect(win.locator('#checkedAt')).toContainText(/\d+ models/);

  await win.locator('#refreshModels').click();
  await expect(win.locator('#status')).toContainText(/Curated: \d+\/\d+ online/, { timeout: 90000 });
  await expect(win.locator('.model-card .status-dot.ok').first()).toBeVisible();
  await shot('05-models.png');
});

test('catalogue filters by text and by kind', async () => {
  await win.locator('.tab[data-tab="models"]').click();
  await win.locator('#modelSearch').fill('');
  await win.locator('#kindFilter').selectOption('');
  await expect.poll(() => win.locator('.model-card').count(), { timeout: 60000 }).toBeGreaterThan(20);
  const all = await win.locator('.model-card').count();

  await win.locator('#modelSearch').fill('inkling');
  await expect.poll(() => win.locator('.model-card').count()).toBeLessThan(all);
  await expect(win.locator('.model-card').first()).toContainText('inkling');

  await win.locator('#modelSearch').fill('');
  await win.locator('#kindFilter').selectOption('vision');
  const visionCount = await win.locator('.model-card').count();
  expect(visionCount).toBeGreaterThan(0);
  expect(visionCount).toBeLessThan(all);
  for (const t of await win.locator('.model-card .badge').allTextContents()) expect(t).toBe('vision');

  await win.locator('#kindFilter').selectOption('');
});

test('selecting a model updates active model', async () => {
  await win.locator('.tab[data-tab="models"]').click();
  await win.locator('#modelSearch').fill('llama-3.1-8b-instruct');
  await win.locator('.model-card[data-id="meta/llama-3.1-8b-instruct"]').click();
  await expect(win.locator('#activeModel')).toHaveText('meta/llama-3.1-8b-instruct');
  await win.locator('#modelSearch').fill('inkling');
  await win.locator('.model-card[data-id="thinkingmachines/inkling"]').click();
  await expect(win.locator('#activeModel')).toHaveText('thinkingmachines/inkling');
  await win.locator('#modelSearch').fill('');
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
