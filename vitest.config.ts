import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node-side experiment tests only. Playwright specs under */browser/ are run by
    // `npx playwright test`, not by vitest.
    include: ['experiments/**/tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
