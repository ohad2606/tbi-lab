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
    },
    {
      command:
        'npm run build --workspace @tbi-lab/app && npm run preview --workspace @tbi-lab/app -- --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      env: { TBI_RUNTIME_PROXY: process.env.TBI_RUNTIME_PROXY ?? 'http://127.0.0.1:7499' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The same source built as a protected preview is: with a sign-out destination
      // (signout.spec.ts). Its own output directory; the routine build above has none.
      command:
        'npm run build --workspace @tbi-lab/app -- --outDir .tmp/dist-signout && npm run preview --workspace @tbi-lab/app -- --outDir .tmp/dist-signout --host 127.0.0.1 --port 4174 --strictPort',
      url: 'http://127.0.0.1:4174',
      env: { VITE_SIGN_OUT_URL: '/oauth2/sign_out' },
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
});
