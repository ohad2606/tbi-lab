import { defineConfig } from 'vitest/config';

/**
 * Runtime R1: tests against the provisioned classic-ESP32 runtime (runtime/provision/provision.sh).
 * Separate from routine CI: they need the built emulator and firmware artifacts and take minutes.
 * Sequential, so resource measurements and determinism runs are not perturbed by each other
 * (tests that are about concurrency start their own concurrent sessions).
 */
export default defineConfig({
  test: {
    include: ['runtime/tests/**/*.runtime.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
