/**
 * Sprint 13 (H5, five-session capacity): parallel build workers (`global.build.maxActive`) and a
 * shared queue large enough that five users' simultaneous builds are queued, never refused for a
 * full queue. Fake provider, no toolchain. Per-user quotas, first-come-first-served start order,
 * the live-session deferral and cleanup are unchanged.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPolicyConfig } from '../../policy/testing.js';
import { Policy, validatePolicy, type PolicyConfig } from '../../policy/policy.js';
import { RateLimiter } from '../../policy/rate.js';
import { TEST_TICKET_KEY, principalFor } from '../../identity/test-gate.js';
import { Grants } from '../grants.js';
import type { JobContext, ProviderOutput } from '../provider.js';
import { BuildService, DEFAULT_LIMITS } from '../service.js';
import { ArtifactStore } from '../store.js';
import { FakeProvider, sketch, tempDir } from './support.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Records the order builds START in and how many compile at once. */
class CountingProvider extends FakeProvider {
  started: string[] = [];
  running = 0;
  peak = 0;
  override async build(job: JobContext): Promise<ProviderOutput> {
    this.started.push(job.files[0]!.text);
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    try {
      // Hold every build briefly so that concurrency is observable.
      await new Promise((r) => setTimeout(r, 50));
      return await super.build(job);
    } finally {
      this.running--;
    }
  }
}

function setup(
  global: Partial<PolicyConfig['global']['build']>,
  opts: { preview?: boolean; live?: () => number | null; timeoutMs?: number } = {},
) {
  const c = openPolicyConfig();
  Object.assign(c.global.build, global);
  if (opts.preview)
    for (const plan of Object.values(c.plans)) {
      plan.build.maxActive = 1; // the preview plan's own limits (deploy/dev-lab/s8/policy.json)
      plan.build.maxQueued = 1;
    }
  if (opts.live) c.global.build.deferWhileLiveSessionsAtLeast = 2;
  const storeDir = tempDir('tbi-store-');
  const work = tempDir('tbi-work-');
  const state = tempDir('tbi-state-');
  cleanup.push(storeDir, work, state);
  const provider = new CountingProvider();
  const grants = new Grants(join(state, 'grants.db'));
  const store = new ArtifactStore({
    dir: storeDir,
    capBytes: 256 * 1024 * 1024,
    graceMs: 0,
    onEvicted: (sha) => grants.dropArtifact(sha),
  });
  const service = new BuildService(
    [provider],
    store,
    work,
    { ...DEFAULT_LIMITS, timeoutMs: opts.timeoutMs ?? DEFAULT_LIMITS.timeoutMs },
    {
      grants,
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(),
      policy: new Policy(c, 6),
      rates: new RateLimiter(':memory:'),
      ...(opts.live ? { liveSessions: opts.live } : {}),
    },
  );
  return { service, provider };
}

const users = [1, 2, 3, 4, 5].map((i) => principalFor(`tester-${i}`));

describe('parallel build workers (global.build.maxActive)', () => {
  it('absent maxActive keeps one compilation at a time (Sprint 7 behaviour)', async () => {
    const { service, provider } = setup({ maxQueued: 10 });
    for (const [i, u] of users.entries()) service.submit(sketch(`s${i}`), u);
    await service.whenIdle();
    expect(provider.peak).toBe(1);
    expect(provider.started).toHaveLength(5);
  });

  it('maxActive 2: two compile at once, the rest wait in order', async () => {
    const { service, provider } = setup({ maxQueued: 10, maxActive: 2 });
    for (const [i, u] of users.entries()) service.submit(sketch(`s${i}`), u);
    await service.whenIdle();
    expect(provider.peak).toBe(2);
    // First come, first served: builds START in submission order.
    expect(provider.started.map((t) => t.match(/s\d/)![0])).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  it('five users submitting at once (two each, preview quotas): all queued, none refused; per-user quota still applies', async () => {
    const { service, provider } = setup({ maxQueued: 10, maxActive: 2 }, { preview: true });
    const accepted = [];
    for (const [i, u] of users.entries()) {
      accepted.push(service.submit(sketch(`a${i}`), u));
      accepted.push(service.submit(sketch(`b${i}`), u));
    }
    expect(accepted).toHaveLength(10);
    // The user's own limit (1 active + 1 queued) is what refuses a third, not the shared queue.
    expect(() => service.submit(sketch('c0'), users[0]!)).toThrow('build_quota');
    await service.whenIdle();
    expect(provider.started).toHaveLength(10);
    expect(provider.peak).toBe(2);
    for (const u of users) expect(service.inFlight(u)).toBe(0);
  });

  it('a full shared queue still refuses explicitly (builder_busy), never silently', () => {
    const { service } = setup({ maxQueued: 2, maxActive: 1 });
    service.submit(sketch('#stall x'), users[0]!);
    service.submit(sketch('q1'), users[1]!);
    service.submit(sketch('q2'), users[2]!);
    expect(() => service.submit(sketch('q3'), users[3]!)).toThrow('busy');
    service.close();
  });

  it('live sessions at the deferral threshold: no new build starts, whatever maxActive allows', async () => {
    let live = 2;
    const { service, provider } = setup({ maxQueued: 10, maxActive: 4 }, { live: () => live });
    service.submit(sketch('d0'), users[0]!);
    service.submit(sketch('d1'), users[1]!);
    await new Promise((r) => setTimeout(r, 300));
    expect(provider.started).toHaveLength(0);
    live = 0;
    await service.whenIdle();
    expect(provider.started).toHaveLength(2);
    service.close();
  });
});

describe('policy: global.build.maxActive', () => {
  it('accepts 1..64 or absent; refuses anything else', () => {
    const ok = openPolicyConfig();
    expect(new Policy(ok, 6).maxActiveBuilds).toBe(1);
    for (const v of [1, 2, 64]) {
      const c = openPolicyConfig();
      c.global.build.maxActive = v;
      expect(new Policy(c, 6).maxActiveBuilds).toBe(v);
    }
    for (const v of [0, 65, 1.5, -1, '2']) {
      const c = openPolicyConfig();
      (c.global.build as Record<string, unknown>).maxActive = v;
      expect(() => validatePolicy(c)).toThrow('bad global limits');
    }
  });
});

describe('repository policies', () => {
  it('dev-lab/staging policy unchanged (one build worker); alpha policy: queue 10, two workers, sessions per CPU', async () => {
    const { readFileSync } = await import('node:fs');
    const load = (f: string) =>
      new Policy(
        validatePolicy(
          JSON.parse(
            readFileSync(new URL(`../../../deploy/dev-lab/s8/${f}`, import.meta.url), 'utf8'),
          ),
        ),
        6,
      );
    const dev = load('policy.json');
    expect(dev.maxActiveBuilds).toBe(1);
    expect(dev.config.global.build.maxQueued).toBe(3);
    const alpha = load('policy.alpha.json');
    expect(alpha.maxActiveBuilds).toBe(2);
    expect(alpha.config.global.build.maxQueued).toBeGreaterThanOrEqual(10);
    expect(alpha.maxLiveSessions).toBe(6);
    expect(alpha.deferBuildsAtLiveSessions).toBe(6);
    // Everything else identical: per-user plans, quotas, retention, resources.
    expect(alpha.config.plans).toEqual(dev.config.plans);
    expect(alpha.config.global.runtime).toEqual(dev.config.global.runtime);
    expect(alpha.config.global.resources).toEqual(dev.config.global.resources);
  });
});
