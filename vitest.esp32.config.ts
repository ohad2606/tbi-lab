import { defineConfig } from 'vitest/config';

/**
 * Integration tests that spawn a real classic-ESP32 QEMU runtime. Separate from the fast
 * suite because they take minutes and need the built emulator.
 */
export default defineConfig({
  test: {
    include: ['experiments/**/tests/**/*.esp32.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
