// The quit button gets its own app instance — it terminates the process, so it
// cannot share the main suite's window.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');

test('quit button closes the app', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env } });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator('#quitBtn')).toBeVisible();

  const exited = new Promise((resolve) => app.process().once('exit', () => resolve(true)));
  await win.locator('#quitBtn').click();
  await expect(Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 15000))])).resolves.toBe(true);
});
