import { defineConfig, devices } from '@playwright/test';

/**
 * Browser acceptance of the TBI Lab Admin app (admin app design §3), on a desktop and on a phone
 * (Pixel 7: a mobile viewport, touch, device scale). The production build is served by Vite's
 * preview, whose proxy plays the gate (TBI_TEST_GATE=1, admin-app/vite.config.ts) in front of the
 * same REAL services as the Lab's administration tests: the admin service (with a fake root
 * helper that also writes the usage history and the audit view, app/e2e/fixtures/fake-admin.ts)
 * and the Session Host's owner routes, both from the fake Session Host process.
 */
export default defineConfig({
  testDir: './admin-app/e2e',
  testMatch: '**/*.spec.ts',
  // The dev host is small and shared: run serially.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:4176' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'npx vite-node app/e2e/fixtures/fake-session-host.ts',
      url: 'http://127.0.0.1:7499/health',
      env: { PORT: '7499' },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command:
        'npm run build --workspace @tbi-lab/admin-app -- --outDir .tmp/dist-e2e && npm run preview --workspace @tbi-lab/admin-app -- --outDir .tmp/dist-e2e --host 127.0.0.1',
      url: 'http://127.0.0.1:4176',
      env: {
        TBI_ADMIN_PROXY: 'http://127.0.0.1:7496',
        TBI_RUNTIME_PROXY: 'http://127.0.0.1:7499',
        TBI_TEST_GATE: '1',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
