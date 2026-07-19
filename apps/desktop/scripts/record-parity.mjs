import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const appDirectory = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(appDirectory, "..", "..", ".context", "verification", "parity-video");
await mkdir(outputDirectory, { recursive: true });
const userData = await mkdtemp(join(tmpdir(), "clarity-parity-"));
const events = [];

const application = await electron.launch({
  args: ["."],
  cwd: appDirectory,
  env: { ...process.env, CLARITY_TEST: "1", CLARITY_TEST_USER_DATA: userData },
  recordVideo: { dir: outputDirectory, size: { width: 800, height: 600 } }
});

const overlay = await application.firstWindow();
await overlay.waitForLoadState("domcontentloaded");
const overlayVideo = overlay.video();
const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
const snapshot = async (label) => {
  const state = await overlay.evaluate(() => window.clarityOverlay.testSnapshot());
  events.push({ label, at: new Date().toISOString(), phase: state.overlay.phase, bounds: state.bounds });
};

await pause(700);
await snapshot("compact-top-center");
let current = await overlay.evaluate(() => window.clarityOverlay.testSnapshot());
await overlay.evaluate((bounds) => window.clarityOverlay.testSetBounds({ x: bounds.x - 260, y: bounds.y + 240 }), current.bounds);
await pause(500);
await snapshot("compact-moved-left");
current = await overlay.evaluate(() => window.clarityOverlay.testSnapshot());
await overlay.evaluate((bounds) => window.clarityOverlay.testSetBounds({ x: bounds.x + 430, y: bounds.y + 220 }), current.bounds);
await pause(500);
await snapshot("compact-moved-bottom-right");

await overlay.getByRole("button", { name: "Expand" }).click();
await pause(500);
await snapshot("expanded-empty");
await overlay.getByRole("textbox", { name: "Ask Clarity" }).fill("What are the next steps?");
await overlay.getByRole("button", { name: "Send" }).click();
await overlay.getByRole("heading", { name: "A focused answer" }).waitFor();
await pause(900);
await snapshot("expanded-response");
await overlay.evaluate(() => window.clarityOverlay.testSetBounds({ width: 430, height: 330 }));
await pause(700);
await snapshot("expanded-narrow");
await overlay.evaluate(() => window.clarityOverlay.testSetBounds({ width: 690, height: 470 }));
await pause(700);
await snapshot("expanded-wide");
await overlay.getByRole("button", { name: "Recent sessions" }).click();
await pause(700);
await snapshot("expanded-history");

const settingsPromise = application.waitForEvent("window", { predicate: (page) => page.url().includes("settings") });
await overlay.getByRole("button", { name: "Settings" }).click();
const settings = await settingsPromise;
await settings.waitForLoadState("domcontentloaded");
const settingsVideo = settings.video();
for (const tab of ["Models", "Audio", "Modes", "Keys", "Cloud", "Privacy", "Integrations", "About", "General"]) {
  await settings.getByRole("button", { name: tab, exact: true }).click();
  await pause(350);
  events.push({ label: `settings-${tab.toLowerCase()}`, at: new Date().toISOString() });
}
await settings.close();
await overlay.getByRole("button", { name: "Collapse" }).click();
await pause(700);
await snapshot("compact-restored");

await application.close();
const videos = [];
if (overlayVideo) videos.push({ surface: "overlay", path: await overlayVideo.path() });
if (settingsVideo) videos.push({ surface: "settings", path: await settingsVideo.path() });
await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify({ createdAt: new Date().toISOString(), events, videos }, null, 2)}\n`);
await rm(userData, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ outputDirectory, events: events.length, videos }, null, 2)}\n`);
