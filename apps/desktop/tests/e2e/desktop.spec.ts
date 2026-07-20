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
  test.setTimeout(60_000);
  const { application, userData } = await launch({ CLARITY_TEST_INFERENCE_DELAY: "1500" });
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
    await expect(overlay.getByRole("heading", { name: "What are the next steps?" })).toBeVisible();
    await expect(overlay.locator(".user-bubble")).toHaveText("What are the next steps?");
    await expect(overlay.getByText("Finish the smallest testable slice first")).toBeVisible();
    await expect(overlay).toHaveScreenshot("overlay-response.png");

    const resized = await overlay.evaluate(() => window.clarityOverlay.testSetBounds!({ width: 430, height: 330 }));
    expect(resized.width).toBe(430);
    await expect(overlay.getByText("Finish the smallest testable slice first")).toBeVisible();

    await overlay.getByRole("textbox", { name: "Ask Clarity" }).fill("Can you build on that?");
    await overlay.getByRole("button", { name: "Send" }).click();
    await expect(overlay.getByText("I heard: “Can you build on that?”")).toBeVisible();
    await expect(overlay.locator(".chat-turn")).toHaveCount(4);
    await expect(overlay.getByRole("textbox", { name: "Ask Clarity" })).toHaveAttribute("placeholder", "Ask a follow-up…");

    await overlay.getByRole("button", { name: "Recent conversations" }).click();
    await expect(overlay.getByRole("heading", { name: "Conversations" })).toBeVisible();
    await expect(overlay.locator(".history-row")).toHaveCount(1);
    await expect(overlay.locator(".message-count")).toHaveText("4 messages");
    await overlay.locator(".history-row").click();
    await expect(overlay.locator(".user-bubble")).toHaveCount(2);
    await expect(overlay.getByText("Can you build on that?", { exact: true })).toBeVisible();

    await overlay.getByRole("button", { name: "New chat" }).click();
    await overlay.getByRole("textbox", { name: "Ask Clarity" }).fill("Keep working while I reset");
    await overlay.getByRole("button", { name: "Send" }).click();
    await expect(overlay.getByLabel("Clarity is thinking")).toBeVisible();
    await overlay.getByRole("button", { name: "New chat" }).click();
    await expect(overlay.locator("[data-phase='expanded-empty']")).toBeVisible();
    await overlay.waitForTimeout(1_800);
    await expect(overlay.locator(".chat-turn")).toHaveCount(0);

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

test("demo history materializes into a conversation that accepts follow-ups", async () => {
  test.setTimeout(60_000);
  const { application, userData } = await launch();
  try {
    const overlay = await pageByTitle(application, "Clarity Overlay");
    await overlay.getByRole("button", { name: "Expand" }).click();
    await overlay.getByRole("button", { name: "Recent conversations" }).click();
    await overlay.locator(".history-row").filter({ hasText: "Launch readiness review" }).click();
    await expect(overlay.getByText("The team agreed to keep provider keys on this Mac")).toBeVisible();

    await overlay.getByRole("textbox", { name: "Ask Clarity" }).fill("What should happen next?");
    await overlay.getByRole("button", { name: "Send" }).click();
    await expect(overlay.getByText("Finish the smallest testable slice first")).toBeVisible();

    await overlay.getByRole("button", { name: "Recent conversations" }).click();
    await expect(overlay.locator(".history-row")).toHaveCount(1);
    await expect(overlay.locator(".message-count")).toHaveText("4 messages");
    await overlay.locator(".history-row").click();
    await expect(overlay.locator(".user-bubble")).toHaveCount(2);
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
