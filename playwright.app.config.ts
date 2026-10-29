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
  webServer: [
    {
      // Routine CI has no QEMU: ESP32 sessions go to a fake Session Host that serves the real
      // R2 transport and the real engine with a scripted MCU (app/e2e/fixtures). Heavy real-QEMU
      // acceptance points the preview at a real Session Host instead (TBI_RUNTIME_PROXY).
      command: 'npx vite-node app/e2e/fixtures/fake-session-host.ts',
      url: 'http://127.0.0.1:7499/health',
      env: { PORT: '7499' },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // Stop it with SIGTERM (not the default kill) so it removes its temporary stores.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command:
        'npm run build --workspace @tbi-lab/app && npm run preview --workspace @tbi-lab/app -- --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      env: {
        TBI_RUNTIME_PROXY: process.env.TBI_RUNTIME_PROXY ?? 'http://127.0.0.1:7499',
        TBI_BUILD_PROXY: process.env.TBI_BUILD_PROXY ?? 'http://127.0.0.1:7498',
        TBI_TEST_GATE: '1', // the proxy plays the authenticating gate (vite.config.ts)
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The same source built as a protected preview is: with a sign-out destination
      // (signout.spec.ts) and, Sprint 14, the in-app problem reports (s14-report-problem.spec.ts);
      // Sprint 23B, the extended feedback and the owner's administration (s23-*.spec.ts).
      // Its own output directory; the routine build above has neither.
      command:
        'npm run build --workspace @tbi-lab/app -- --outDir .tmp/dist-signout && npm run preview --workspace @tbi-lab/app -- --outDir .tmp/dist-signout --host 127.0.0.1 --port 4174 --strictPort',
      url: 'http://127.0.0.1:4174',
      env: {
        VITE_SIGN_OUT_URL: '/oauth2/sign_out',
        VITE_PROBLEM_REPORTS: '1',
        VITE_ADMIN_UI: 'full',
        TBI_RUNTIME_PROXY: process.env.TBI_RUNTIME_PROXY ?? 'http://127.0.0.1:7499',
        // Sprint 23C: the admin service (the real one, with a fake helper; fake-admin.ts).
        TBI_ADMIN_PROXY: 'http://127.0.0.1:7496',
        TBI_BUILD_PROXY: process.env.TBI_BUILD_PROXY ?? 'http://127.0.0.1:7498',
        TBI_TEST_GATE: '1', // the proxy plays the authenticating gate (vite.config.ts)
      },
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
    {
      // Sprint 23C: the feedback-only release (rc4-s23-feedback): feedback on, the
      // administration with the Feedback tab only (VITE_ADMIN_UI=reports), against the fake
      // Session Host's reports-mode listener (s23c-feedback-only.spec.ts).
      command:
        'npm run build --workspace @tbi-lab/app -- --outDir .tmp/dist-feedback && npm run preview --workspace @tbi-lab/app -- --outDir .tmp/dist-feedback --host 127.0.0.1 --port 4175 --strictPort',
      url: 'http://127.0.0.1:4175',
      env: {
        VITE_SIGN_OUT_URL: '/oauth2/sign_out',
        VITE_PROBLEM_REPORTS: '1',
        VITE_ADMIN_UI: 'reports',
        TBI_RUNTIME_PROXY: 'http://127.0.0.1:7497',
        TBI_BUILD_PROXY: process.env.TBI_BUILD_PROXY ?? 'http://127.0.0.1:7498',
        TBI_TEST_GATE: '1',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 360_000,
    },
  ],
});
