import { defineConfig, devices } from '@playwright/test';

/**
 * Browser acceptance suite for the production app (Sprint 2+). Separate from the Sprint 0/1
 * experiment specs in playwright.config.ts. Builds the app and serves the production bundle.
 */
export default defineConfig({
  testDir: './app/e2e',
  testMatch: '**/*.spec.ts',
  // The dev host has a single CPU core: run serially.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1400, height: 860 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 } },
    },
  ],
  webServer: {
    command:
      'npm run build --workspace @tbi-lab/app && npm run preview --workspace @tbi-lab/app -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
