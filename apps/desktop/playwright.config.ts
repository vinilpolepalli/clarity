import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000, toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.015 } },
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" }
});
