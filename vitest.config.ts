import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fast suites: Sprint 0/1 experiment unit tests plus production unit tests.
    // Playwright specs (*/browser/*.spec.ts, app/e2e) are run by Playwright, not vitest.
    include: [
      'experiments/**/tests/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'app/tests/**/*.test.ts',
    ],
    // *.esp32.test.ts spawn a real QEMU classic-ESP32 runtime and take minutes.
    // They are run explicitly via `npm run test:esp32`.
    exclude: ['**/node_modules/**', '**/dist-browser/**', '**/*.esp32.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
