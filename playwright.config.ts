import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './experiments',
  testMatch: '**/browser/*.spec.ts',
  // The dev host has a single CPU core: run browser specs serially.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
