import { defineConfig, devices } from '@playwright/test';

/**
 * Accessibility suite (a11y-audit branch): the Lab and the Admin app, axe-core scans plus scripted
 * keyboard checks. Self-contained so it can run on its own (`npx playwright test -c
 * playwright.a11y.config.ts`): one fake Session Host (with the fake build service and the real
 * admin service on a fake helper, app/e2e/fixtures), one Lab preview built as a protected
 * deployment is (sign-out, problem reports, owner administration) and one Admin app preview.
 *
 * The Lab specs (app/e2e/a11y-*.spec.ts) also run unchanged under playwright.app.config.ts, i.e. in
 * the existing `npm run test:e2e` CI step; the admin spec (admin-app/e2e/a11y-*.spec.ts) also runs
 * under playwright.admin.config.ts.
 *
 * Own ports (4274, 4276) and no server reuse: never test another session's preview by accident.
 * The fake Session Host ports (7496-7499) are fixed by the fixture, so this suite must not run at
 * the same time as another browser suite on the host (take the heavy lock).
 */
const LAB = 'http://127.0.0.1:4274';
const ADMIN = 'http://127.0.0.1:4276';
/** Local iteration only: reuse servers started by hand on these ports (never in CI). */
const REUSE = !process.env.CI && process.env.TBI_A11Y_REUSE === '1';

export default defineConfig({
  testDir: '.',
  // The dev host has a single CPU core: run serially.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  projects: [
    {
      name: 'lab',
      testMatch: 'app/e2e/a11y-*.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 }, baseURL: LAB },
    },
    {
      name: 'admin',
      testMatch: 'admin-app/e2e/a11y-*.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL: ADMIN },
    },
  ],
  webServer: [
    {
      command: 'npx vite-node app/e2e/fixtures/fake-session-host.ts',
      url: 'http://127.0.0.1:7499/health',
      env: { PORT: '7499' },
      reuseExistingServer: REUSE,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command:
        'npm run build --workspace @tbi-lab/app -- --outDir .tmp/dist-a11y && npm run preview --workspace @tbi-lab/app -- --outDir .tmp/dist-a11y --host 127.0.0.1 --port 4274 --strictPort',
      url: LAB,
      env: {
        VITE_SIGN_OUT_URL: '/oauth2/sign_out',
        VITE_PROBLEM_REPORTS: '1',
        VITE_ADMIN_UI: 'full',
        TBI_RUNTIME_PROXY: 'http://127.0.0.1:7499',
        TBI_ADMIN_PROXY: 'http://127.0.0.1:7496',
        TBI_BUILD_PROXY: 'http://127.0.0.1:7498',
        TBI_TEST_GATE: '1',
      },
      reuseExistingServer: REUSE,
      timeout: 300_000,
    },
    {
      command:
        'npm run build --workspace @tbi-lab/admin-app -- --outDir .tmp/dist-a11y-admin && npm run preview --workspace @tbi-lab/admin-app -- --outDir .tmp/dist-a11y-admin --host 127.0.0.1 --port 4276 --strictPort',
      url: ADMIN,
      env: {
        TBI_ADMIN_PROXY: 'http://127.0.0.1:7496',
        TBI_RUNTIME_PROXY: 'http://127.0.0.1:7499',
        TBI_TEST_GATE: '1',
      },
      reuseExistingServer: REUSE,
      timeout: 300_000,
    },
  ],
});
