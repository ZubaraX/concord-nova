// End-to-end tests: real browsers (Chromium with fake camera/microphone)
// against the dev stack (`npm run dev`: LiveKit + API + Vite). Each test uses
// fresh accounts, so they can run against a stack that already has data.
//
//   npm run e2e            (starts the stack if it isn't running)
//   E2E_URL=https://… npm run e2e   (another server — careful, it creates accounts)
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "../.e2e-results",
  use: {
    baseURL: process.env.E2E_URL ?? "http://localhost:5173",
    locale: "ru-RU",
    viewport: { width: 1366, height: 768 },
    permissions: ["microphone", "camera", "notifications"],
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    },
    // A missing element fails fast instead of eating the whole test timeout.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_URL
    ? undefined
    : { command: "npm run dev", cwd: "..", url: "http://localhost:5173", reuseExistingServer: true, timeout: 240_000 },
});
