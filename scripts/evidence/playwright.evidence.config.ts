import { defineConfig, devices } from '@playwright/test';

/**
 * 3D evidence capture (Sprint 10 realism pass): renders the evidence benches at fixed cameras
 * against an already running production preview (`npm run preview`, port 4173). Not part of CI:
 * it writes images, it asserts nothing about pixels.
 *   EVIDENCE_OUT=<dir> EVIDENCE_QUALITY=full|reduced npx playwright test -c scripts/evidence/playwright.evidence.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: process.env.EVIDENCE_SPEC ?? 'capture-3d.spec.ts',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 600_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.EVIDENCE_URL ?? 'http://127.0.0.1:4173',
    viewport: { width: 1400, height: 860 },
  },
});
