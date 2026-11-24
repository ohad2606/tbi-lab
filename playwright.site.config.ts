import { defineConfig, devices } from '@playwright/test';

/**
 * Public static site (TBI-013): builds site/dist and serves it with a tiny static server.
 * Separate from the app config; no app build, no fake services.
 */
export default defineConfig({
  testDir: './site/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4391' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // --signup-preview: also build the noindex, unlinked sign-up page (the published build has no page while the
    // flag is off); every other page is byte-identical either way (site/tests/signup-review-fixes.test.mjs).
    command: 'node site/build.mjs --signup-preview && node site/serve.mjs 4391',
    url: 'http://127.0.0.1:4391/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
