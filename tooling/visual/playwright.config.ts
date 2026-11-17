import { defineConfig, devices } from '@playwright/test';

// UI V2-B2-1 visual regression (docs/ui/pixa-visual-identity-v2-b2.md §14 B2-1, §15).
// Goldens are lossless PNGs, rendered in the pinned Playwright image (scripts/docker.sh, and the
// `Visual regression` workflow) so local and CI renders come from the same Chromium, fonts and libraries.
// They are evidence only: they do not replace the WKWebView (macOS) and WebView2 (Windows) checks.
const PORT = 5199;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  snapshotPathTemplate: '{testDir}/../goldens/{arg}{ext}',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: CI,
  // No retries: a capture that only passes on a second attempt is a flake, and the flake rate is
  // what decides when this suite may become gating (D-V2A-11).
  retries: 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]] : [['list'], ['html', { open: 'never' }]],
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'device', maxDiffPixels: 0 },
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}/`,
    // Scale 1 keeps the committed goldens small (README); text and 1 px rules still render exactly.
    deviceScaleFactor: 1,
    locale: 'en-AU',
    timezoneId: 'Australia/Perth',
    reducedMotion: 'reduce',
    trace: 'off',
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config vite.config.ts',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: 'ignore',
  },
});
