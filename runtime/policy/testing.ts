/**
 * TEST ONLY: an open policy (limits far above any test's load) so suites that are not about
 * policy keep testing what they test; Phase 4 tests use the real `preview` limits instead.
 */
import { DEFAULT_POLICY, Policy, type PolicyConfig } from './policy.js';
import { RateLimiter } from './rate.js';

export function openPolicyConfig(): PolicyConfig {
  const c = structuredClone(DEFAULT_POLICY);
  for (const plan of Object.values(c.plans)) {
    plan.requests.count = 1_000_000;
    plan.build.maxActive = 64;
    plan.build.maxQueued = 64;
    plan.build.submissions.count = 1_000_000;
    plan.build.failures.count = 1_000_000;
    plan.runtime.maxSessions = 64;
    plan.runtime.creations.count = 1_000_000;
    plan.storage.maxArtifacts = 1_000_000;
    plan.storage.maxBytes = 2 ** 45;
    plan.storage.prebuiltUploads.count = 1_000_000;
  }
  c.global.build.maxQueued = 3; // the Sprint 7 shared queue
  c.global.runtime.maxLiveSessions = 64;
  c.global.build.deferWhileLiveSessionsAtLeast = 1024;
  c.global.resources = { minFreeDiskMb: 0, minAvailableMemoryMb: 0 };
  return c;
}

export const openPolicy = (): Policy => new Policy(openPolicyConfig(), 1);

/** Policy and an in-memory rate store, as the build service's access needs them. */
export const openAccessPolicy = () => ({
  policy: openPolicy(),
  rates: new RateLimiter(':memory:'),
});
