import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node-side experiment tests only. Playwright specs under */browser/ are run by
    // `npx playwright test`, not by vitest.
    include: ['experiments/**/tests/**/*.test.ts'],
    // *.esp32.test.ts spawn a real QEMU classic-ESP32 runtime and take minutes.
    // They are run explicitly via `npm run test:esp32`.
    exclude: ['**/node_modules/**', '**/dist-browser/**', '**/*.esp32.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
