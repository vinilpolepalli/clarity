const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const SHOTS = path.join(__dirname, '..', 'assets', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let app, win;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, '..')],
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
