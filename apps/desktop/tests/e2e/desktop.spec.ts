import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function launch(extraEnv: Record<string, string> = {}) {
  const userData = await mkdtemp(join(tmpdir(), "clarity-e2e-"));
  const application = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, "../.."),
    env: { ...process.env, CLARITY_TEST: "1", CLARITY_TEST_USER_DATA: userData, ...extraEnv }
  });
  return { application, userData };
}

async function pageByTitle(application: Awaited<ReturnType<typeof electron.launch>>, title: string) {
  // Synchronize with Playwright's first BrowserWindow event before polling the
  // full window list. Under load, the list can be transiently empty even after
  // Electron has started creating renderer storage for its first window.
  await application.firstWindow();
  await expect.poll(async () => Promise.all(application.windows().map(async (page) => {
    try { return page.isClosed() ? "" : await page.title(); } catch { return ""; }
  }))).toContain(title);
  for (const page of application.windows().filter((candidate) => !candidate.isClosed())) {
    try { if (await page.title() === title) return page; } catch { /* Window closed during the handoff. */ }
  }
  throw new Error(`No open Electron page has the title ${title}`);
}

test("overlay preserves its anchor, reflows, and keeps settings separate", async () => {
  const { application, userData } = await launch();
  try {
    const overlay = await pageByTitle(application, "Clarity Overlay");
    await expect(overlay.locator("[data-phase='compact-idle']")).toBeVisible();
    const compact = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(compact.bounds.width).toBe(590);
    expect(compact.bounds.height).toBe(88);
    await expect(overlay).toHaveScreenshot("overlay-compact.png");

    await overlay.getByRole("button", { name: "Expand" }).click();
    await expect(overlay.locator("[data-phase='expanded-empty']")).toBeVisible();
    const expanded = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(expanded.bounds.x).toBe(compact.bounds.x);
    expect(expanded.bounds.width).toBe(compact.bounds.width);
    expect(expanded.bounds.height).toBeGreaterThanOrEqual(390);

    await overlay.getByRole("textbox", { name: "Ask Clarity" }).fill("What are the next steps?");
    await overlay.getByRole("button", { name: "Send" }).click();
    await expect(overlay.getByRole("heading", { name: "A focused answer" })).toBeVisible();
    await expect(overlay).toHaveScreenshot("overlay-response.png");

    const resized = await overlay.evaluate(() => window.clarityOverlay.testSetBounds!({ width: 430, height: 330 }));
    expect(resized.width).toBe(430);
    await expect(overlay.getByText("Finish the smallest testable slice first")).toBeVisible();

    await overlay.getByRole("button", { name: "Settings" }).click();
    const settings = await pageByTitle(application, "Clarity");
    await expect(settings.getByRole("heading", { name: "General" })).toBeVisible();
    const afterSettings = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(afterSettings.bounds).toMatchObject(resized);
    await expect(settings).toHaveScreenshot("settings-general.png");

    await settings.getByRole("button", { name: "Privacy" }).click();
    await expect(settings.getByRole("heading", { name: "Privacy" })).toBeVisible();
    await expect(settings.getByText("No desktop app can guarantee invisibility.")).toBeVisible();

    await settings.close();
    await overlay.getByRole("button", { name: "Collapse" }).click();
    const collapsed = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(collapsed.bounds.width).toBe(430);
    expect(collapsed.bounds.height).toBe(88);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("fresh launch completes the split onboarding without forced permissions", async () => {
  const { application, userData } = await launch({ CLARITY_TEST_ONBOARDING: "1" });
  try {
    const settings = await pageByTitle(application, "Clarity");
    await expect(settings.getByRole("heading", { name: /Stay present/ })).toBeVisible();
    await expect(settings).toHaveScreenshot("onboarding-welcome.png");
    await settings.getByRole("button", { name: "Continue" }).click();
    await expect(settings.getByRole("heading", { name: /You remain/ })).toBeVisible();
    await expect(settings.getByRole("button", { name: /Accessibility/ })).toBeVisible();
    await settings.getByRole("button", { name: "Continue with current access" }).click();
    await expect(settings.getByRole("heading", { name: /Choose your/ })).toBeVisible();
    await settings.getByRole("button", { name: "Open Clarity" }).click();
    const overlay = await pageByTitle(application, "Clarity Overlay");
    await expect(overlay.locator("[data-phase='compact-idle']")).toBeVisible();
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("built-in modes stay synchronized across Settings, the overlay, inference, and native picker bounds", async () => {
  const { application, userData } = await launch();
  try {
    const overlay = await pageByTitle(application, "Clarity Overlay");
    const initial = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    await expect(overlay.getByRole("button", { name: "Assistant mode: General" })).toBeVisible();

    await overlay.getByRole("button", { name: "Assistant mode: General" }).click();
    await expect(overlay.getByRole("listbox", { name: "Assistant mode" })).toBeVisible();
    const opened = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(opened.pickerOpen).toBe(true);
    expect(opened.bounds.height).toBeGreaterThan(initial.bounds.height);
    await expect(overlay).toHaveScreenshot("overlay-mode-picker.png");

    await overlay.getByRole("option", { name: "Coding Interview" }).click();
    await expect(overlay.getByRole("button", { name: "Assistant mode: Coding Interview" })).toBeVisible();
    const restored = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(restored.pickerOpen).toBe(false);
    expect(restored.bounds).toEqual(initial.bounds);

    await overlay.getByRole("button", { name: "Assistant mode: Coding Interview" }).click();
    await overlay.getByRole("button", { name: "Manage" }).click();
    const settings = await pageByTitle(application, "Clarity");
    await expect(settings.getByRole("heading", { name: "Modes" })).toBeVisible();
    await expect(settings.getByRole("option", { name: "General" })).toBeVisible();
    await expect(settings.getByRole("option", { name: "Lecture" })).toBeVisible();
    await expect(settings).toHaveScreenshot("settings-modes.png");

    await settings.getByRole("option", { name: "Sales Call" }).click();
    await expect(settings.locator(".mode-detail").getByRole("heading", { name: "Sales Call" })).toBeVisible();
    await expect(overlay.getByRole("button", { name: "Assistant mode: Coding Interview" })).toBeVisible();
    await settings.getByRole("button", { name: "Set Active" }).click();
    await expect(overlay.getByRole("button", { name: "Assistant mode: Sales Call" })).toBeVisible();

    await settings.getByRole("option", { name: "Team Meeting" }).click();
    await overlay.evaluate(() => window.clarityOverlay.setMode("lecture"));
    await expect(settings.locator(".mode-detail").getByRole("heading", { name: "Team Meeting" })).toBeVisible();
    await expect(overlay.getByRole("button", { name: "Assistant mode: Lecture" })).toBeVisible();
    await expect(overlay.evaluate(() => window.clarityOverlay.setMode("unknown-mode"))).rejects.toThrow("Unknown mode");

    await overlay.evaluate(async () => {
      await window.clarityOverlay.setMode("coding-interview");
      await window.clarityOverlay.dispatch({ type: "SUBMIT", prompt: "Explain the next approach" });
      await window.clarityOverlay.setMode("sales");
    });
    await expect(overlay.getByText(/Coding Interview mode/)).toBeVisible();
    const completed = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(completed.settings.modeModel.activeModeId).toBe("sales");
    expect(completed.activeRequest).toBeNull();

    await overlay.evaluate(async () => {
      await window.clarityOverlay.setMode("coding-interview");
      await window.clarityOverlay.dispatch({ type: "SUBMIT", prompt: "trigger an error" });
    });
    await expect(overlay.getByRole("heading", { name: /couldn’t finish/ })).toBeVisible();
    await overlay.evaluate(() => window.clarityOverlay.setMode("sales"));
    await overlay.getByRole("button", { name: "Try again" }).click();
    await expect(overlay.getByRole("heading", { name: /couldn’t finish/ })).toBeVisible();
    const retried = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(retried.failedRequest).toEqual({ modeId: "coding-interview", promptVersion: 1 });
    expect(retried.settings.modeModel.activeModeId).toBe("sales");
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
