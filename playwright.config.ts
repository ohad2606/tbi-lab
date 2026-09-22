import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './experiments',
  testMatch: '**/browser/*.spec.ts',
  // *.wasm.spec.ts need a multi-hour QEMU-wasm build; run them via `npm run test:qemu-wasm`.
  testIgnore: process.env.TBI_QEMU_WASM ? [] : ['**/*.wasm.spec.ts'],
  // The dev host has a single CPU core: run browser specs serially.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
