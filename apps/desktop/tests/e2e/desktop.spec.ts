import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function launch(extraEnv: Record<string, string> = {}, existingUserData?: string) {
  const userData = existingUserData ?? await mkdtemp(join(tmpdir(), "clarity-e2e-"));
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

    await settings.getByRole("button", { name: "Models" }).click();
    await expect(settings.getByRole("heading", { name: "Models" })).toBeVisible();
    await settings.getByRole("combobox", { name: "Provider" }).selectOption("nvidia");
    const modelPicker = settings.getByRole("combobox", { name: "Model" });
    const preferredModels = await modelPicker.locator("option").allTextContents();
    expect(preferredModels.slice(0, 5)).toEqual([
      "DeepSeek V4 Flash · #1 Recommended · Best balance",
      "GPT OSS 20B · #2 Fastest · Reasoning",
      "GLM 5.2 · #3 Best quality · Slower",
      "Nemotron 3 Nano 30B · #4 Fast · NVIDIA",
      "Llama 3.1 8B Instruct · #5 Lightweight · Fast"
    ]);
    await expect(settings.getByRole("button", { name: "Refresh" })).toBeDisabled();
    await expect(settings.getByRole("button", { name: "Test connection" })).toBeDisabled();
    await expect(settings.getByText("Not tested for this configuration")).toBeVisible();
    await settings.getByRole("textbox", { name: "Custom model ID" }).fill("invalid model id");
    await settings.getByRole("button", { name: "Add custom model" }).click();
    await expect(settings.getByText("Enter a model ID without spaces, up to 160 characters.")).toBeVisible();
    await expect(modelPicker).toHaveValue("deepseek-ai/deepseek-v4-flash");
    await settings.getByRole("textbox", { name: "Custom model ID" }).fill("custom/meeting-model");
    await settings.getByRole("button", { name: "Add custom model" }).click();
    await expect(modelPicker).toHaveValue("custom/meeting-model");
    await expect(settings.getByText("Added custom/meeting-model and selected it.")).toBeVisible();
    await settings.getByRole("button", { name: "Remove custom/meeting-model" }).click();
    await expect(modelPicker).toHaveValue("deepseek-ai/deepseek-v4-flash");

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

test("system-audio sessions continuously save live notes without a media URL", async () => {
  test.setTimeout(60_000);
  const { application, userData } = await launch();
  try {
    const overlay = await pageByTitle(application, "Clarity Overlay");
    await overlay.getByRole("combobox", { name: "Meeting audio source" }).selectOption("system");
    await overlay.getByRole("button", { name: "Start listening" }).click();
    await expect(overlay.getByRole("button", { name: "Stop listening" })).toBeVisible();
    expect((await overlay.evaluate(() => window.clarityOverlay.testSnapshot!())).overlay.meeting.source).toBe("system");
    await overlay.waitForTimeout(400);

    const speech = Array.from({ length: 32_000 }, () => 8);
    const silence = Array.from({ length: 32_000 }, () => 0);
    await overlay.evaluate(async ({ speech, silence }) => {
      await window.clarityOverlay.testMeetingFrame!({ pcm: speech, source: "system" });
      await window.clarityOverlay.testMeetingFrame!({ pcm: silence, source: "system" });
    }, { speech, silence });

    await overlay.getByRole("button", { name: "Live meeting notes" }).click();
    await expect.poll(async () => (await overlay.evaluate(() => window.clarityOverlay.testSnapshot!())).overlay.phase).toBe("expanded-notes");
    await expect(overlay.getByRole("heading", { name: /meeting notes/i })).toBeVisible();
    await expect(overlay.getByText("Test meeting transcript: the team agreed to ship the live notes slice.").first()).toBeVisible();
    await expect(overlay.getByText("Ship the live notes slice.", { exact: true })).toBeVisible();
    await overlay.getByRole("button", { name: "Stop listening" }).click();
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

test("screen context persists, discloses its preview, and expires on clear", async () => {
  const userData = await mkdtemp(join(tmpdir(), "clarity-e2e-screen-"));
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null;
  try {
    ({ application } = await launch({ CLARITY_TEST_SCREEN_CONTEXT: "1" }, userData));
    let overlay = await pageByTitle(application, "Clarity Overlay");
    const screenToggle = overlay.getByRole("button", { name: "Does not use screen" });
    await screenToggle.click();
    await expect(overlay.getByRole("button", { name: "Uses screen" })).toHaveAttribute("aria-pressed", "true");

    await overlay.getByRole("textbox", { name: "Ask Clarity" }).fill("What is visible on my screen?");
    await overlay.getByRole("button", { name: "Send" }).click();
    const viewedScreen = overlay.getByRole("button", { name: "Viewed screen" });
    await expect(viewedScreen).toBeVisible();
    const attached = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    const attachmentId = attached.overlay.screenContext.attachmentId;
    expect(attachmentId).toBeTruthy();

    await viewedScreen.hover();
    await expect(overlay.getByRole("dialog", { name: "Screen used for this response" })).toBeVisible();
    await expect(overlay.getByAltText("Screen captured for this response")).toBeVisible();

    await overlay.getByRole("textbox", { name: "Ask Clarity" }).fill("What changed since the first screenshot?");
    await overlay.getByRole("button", { name: "Send" }).click();
    await expect(viewedScreen).toBeVisible();
    const followUp = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    const followUpAttachmentId = followUp.overlay.screenContext.attachmentId;
    expect(followUpAttachmentId).toBeTruthy();
    expect(followUpAttachmentId).not.toBe(attachmentId);
    expect(await overlay.evaluate((id) => window.clarityOverlay.getScreenPreview(id), attachmentId!)).toBeNull();

    await overlay.getByRole("button", { name: "New chat" }).click();
    await expect(viewedScreen).toHaveCount(0);
    const expired = await overlay.evaluate((id) => window.clarityOverlay.getScreenPreview(id), followUpAttachmentId!);
    expect(expired).toBeNull();
    const cleared = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(cleared.overlay.screenContext.enabled).toBe(true);
    expect(cleared.settings.preferences.screenContextEnabled).toBe(true);

    await application.close();
    application = null;
    ({ application } = await launch({ CLARITY_TEST_SCREEN_CONTEXT: "1" }, userData));
    overlay = await pageByTitle(application, "Clarity Overlay");
    await expect(overlay.getByRole("button", { name: "Uses screen" })).toHaveAttribute("aria-pressed", "true");
    const restored = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(restored.settings.preferences.screenContextEnabled).toBe(true);

    await overlay.getByRole("textbox", { name: "Ask Clarity" }).fill("Trigger an error after viewing my screen");
    await overlay.getByRole("button", { name: "Send" }).click();
    await expect(overlay.getByText("The local demo provider intentionally failed")).toBeVisible();
    const errorDisclosure = overlay.getByRole("button", { name: "Viewed screen" });
    await expect(errorDisclosure).toBeVisible();
    await errorDisclosure.hover();
    await expect(overlay.getByAltText("Screen captured for this response")).toBeVisible();
  } finally {
    await application?.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("screen capture survives overlay recreation requested from Privacy settings", async () => {
  const { application, userData } = await launch({
    CLARITY_TEST_SCREEN_CONTEXT: "1",
    CLARITY_TEST_SCREEN_CAPTURE_DELAY: "1000",
    CLARITY_TEST_PRESERVE_CONTENT_PROTECTION: "1",
    CLARITY_TEST_FORCE_OVERLAY_RECREATION: "1"
  });
  try {
    let overlay = await pageByTitle(application, "Clarity Overlay");
    await overlay.getByRole("button", { name: "Does not use screen" }).click();
    const initialWindowId = (await overlay.evaluate(() => window.clarityOverlay.testSnapshot!())).windowId;
    await overlay.getByRole("textbox", { name: "Ask Clarity" }).fill("What is visible right now?");
    await overlay.getByRole("button", { name: "Send" }).click();
    await expect.poll(async () => (await overlay.evaluate(() => window.clarityOverlay.testSnapshot!())).overlay.screenContext.status).toBe("capturing");

    await overlay.evaluate(() => window.clarityOverlay.openSettings());
    const settings = await pageByTitle(application, "Clarity");
    await settings.getByRole("button", { name: "Privacy" }).click();
    const protection = settings.getByRole("switch", { name: "Hide overlay from screen sharing (best effort)" });
    await expect(protection).toHaveAttribute("aria-checked", "true");
    await protection.click();
    await expect(protection).toHaveAttribute("aria-checked", "false");

    await settings.waitForTimeout(1_400);
    overlay = await pageByTitle(application, "Clarity Overlay");
    await expect(overlay.getByRole("button", { name: "Viewed screen" })).toBeVisible();
    await expect(overlay.getByText("I heard: “What is visible right now?”")).toBeVisible();
    const after = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(after.windowId).not.toBe(initialWindowId);
    expect(after.overlay.screenContext.status).toBe("attached");
    expect(after.contentProtected).toBe(false);
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
    await expect(overlay.getByText(/local demo provider intentionally failed/)).toBeVisible();
    await overlay.evaluate(() => window.clarityOverlay.setMode("sales"));
    await overlay.getByRole("button", { name: "Try again" }).click();
    await expect(overlay.getByText(/local demo provider intentionally failed/)).toBeVisible();
    const retried = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(retried.failedRequest).toEqual({ modeId: "coding-interview", promptVersion: 1 });
    expect(retried.settings.modeModel.activeModeId).toBe("sales");
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("screen-share protection toggles immediately and persists", async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), "clarity-e2e-protection-"));
  const env = { CLARITY_TEST_PRESERVE_CONTENT_PROTECTION: "1" };
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null;
  try {
    ({ application } = await launch(env, userData));
    let overlay = await pageByTitle(application, "Clarity Overlay");
    await overlay.getByRole("button", { name: "Expand" }).click();
    await expect(overlay.locator("[data-phase='expanded-empty']")).toBeVisible();
    const before = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(before.settings.preferences.protectOverlayContent).toBe(true);
    expect(before.contentProtected).toBe(true);
    expect(before.resizable).toBe(true);

    await overlay.evaluate(() => window.clarityOverlay.openSettings());
    const settings = await pageByTitle(application, "Clarity");
    await settings.getByRole("button", { name: "Privacy" }).click();
    const protection = settings.getByRole("switch", { name: "Hide overlay from screen sharing (best effort)" });
    await expect(protection).toHaveAttribute("aria-checked", "true");

    await protection.click();
    await expect(protection).toHaveAttribute("aria-checked", "false");
    overlay = await pageByTitle(application, "Clarity Overlay");
    await expect.poll(async () => overlay.evaluate(() => window.clarityOverlay.testSnapshot!())).toMatchObject({
      contentProtected: false,
      settings: { preferences: { protectOverlayContent: false } }
    });

    await protection.click();
    await expect(protection).toHaveAttribute("aria-checked", "true");
    overlay = await pageByTitle(application, "Clarity Overlay");
    await expect.poll(async () => (await overlay.evaluate(() => window.clarityOverlay.testSnapshot!())).contentProtected).toBe(true);

    await protection.click();
    await expect(protection).toHaveAttribute("aria-checked", "false");
    overlay = await pageByTitle(application, "Clarity Overlay");
    const after = await overlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(after.contentProtected).toBe(false);
    expect(after.settings.preferences.protectOverlayContent).toBe(false);
    expect(after.resizable).toBe(true);
    expect(after.overlay).toEqual(before.overlay);
    expect(after.bounds).toEqual(before.bounds);

    await application.close();
    application = null;

    ({ application } = await launch(env, userData));
    const relaunchedOverlay = await pageByTitle(application, "Clarity Overlay");
    const relaunched = await relaunchedOverlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(relaunched.settings.preferences.protectOverlayContent).toBe(false);
    expect(relaunched.contentProtected).toBe(false);

    await relaunchedOverlay.evaluate(() => window.clarityOverlay.openSettings());
    const relaunchedSettings = await pageByTitle(application, "Clarity");
    await relaunchedSettings.getByRole("button", { name: "Privacy" }).click();
    const relaunchedProtection = relaunchedSettings.getByRole("switch", { name: "Hide overlay from screen sharing (best effort)" });
    await relaunchedProtection.click();
    await expect(relaunchedProtection).toHaveAttribute("aria-checked", "true");
    await relaunchedProtection.click();
    await expect(relaunchedProtection).toHaveAttribute("aria-checked", "false");
    const rebuiltCompactOverlay = await pageByTitle(application, "Clarity Overlay");
    const rebuiltCompact = await rebuiltCompactOverlay.evaluate(() => window.clarityOverlay.testSnapshot!());
    expect(rebuiltCompact.contentProtected).toBe(false);
    expect(rebuiltCompact.resizable).toBe(false);
    expect(rebuiltCompact.overlay).toEqual(relaunched.overlay);
    expect(rebuiltCompact.bounds).toEqual(relaunched.bounds);
  } finally {
    await application?.close();
    await rm(userData, { recursive: true, force: true });
  }
});
