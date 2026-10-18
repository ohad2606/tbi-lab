import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fast suites: Sprint 0/1 experiment unit tests plus production unit tests.
    // Playwright specs (*/browser/*.spec.ts, app/e2e) are run by Playwright, not vitest.
    include: [
      'experiments/**/tests/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'app/tests/**/*.test.ts',
      // Runtime R2 Session Host: protocol, state machine and lifecycle against a fake runtime
      // that speaks the real bridge protocol. No QEMU; the heavy suite is npm run test:r2.
      'runtime/host/tests/**/*.test.ts',
      // Build service (Sprint 7) with a fake provider; the real toolchain is the heavy suite.
      'runtime/builder/tests/**/*.test.ts',
      // Sprint 8 identity boundary (principal derivation, listening, the test gate).
      'runtime/identity/tests/**/*.test.ts',
      // Sprint 8 Phase 4 policy, quotas, rate limits and admission.
      'runtime/policy/tests/**/*.test.ts',
      // RC4 packaging gate: release profile and built-frontend validation.
      'deploy/release/tests/**/*.test.mjs',
    ],
    // *.esp32.test.ts spawn a real QEMU classic-ESP32 runtime and take minutes.
    // They are run explicitly via `npm run test:esp32`.
    exclude: ['**/node_modules/**', '**/dist-browser/**', '**/*.esp32.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
