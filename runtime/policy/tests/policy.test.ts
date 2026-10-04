/**
 * Sprint 8 Phase 4 — policy, quotas, rate limits and admission (adversarial and concurrent).
 * Real `preview`-shaped limits (made small where a test needs to reach them quickly).
 */
import { rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Grants } from '../../builder/grants.js';
import { createBuildHttpServer } from '../../builder/http.js';
import { BuildService, DEFAULT_LIMITS } from '../../builder/service.js';
import { ArtifactStore } from '../../builder/store.js';
import { FakeProvider, fakeImage, sketch, tempDir } from '../../builder/tests/support.js';
import { createHttpServer } from '../../host/http.js';
import { createRequest, fakeHost } from '../../host/tests/support.js';
import {
  TEST_IDENTITY,
  TEST_TICKET_KEY,
  principalFor,
  startTestGate,
  ticketFor,
} from '../../identity/test-gate.js';
import { DEFAULT_POLICY, Policy, validatePolicy, type PolicyConfig } from '../policy.js';
import { RateLimiter } from '../rate.js';
import type { ResourceProbe } from '../resources.js';

const A = principalFor('user-a');
const B = principalFor('user-b');
const C = principalFor('user-c');
const D = principalFor('user-d');
const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const plenty: ResourceProbe = { freeDiskMb: () => 1e9, availableMemoryMb: () => 1e9 };

/** The real preview plan and global limits, with selected values made reachable in a test. */
function preview(tweak: (c: PolicyConfig) => void = () => {}, cpus = 1): Policy {
  const c = structuredClone(DEFAULT_POLICY);
  tweak(c);
  return new Policy(c, cpus);
}

function buildWorld(
  policy: Policy,
  opts: { live?: () => number | null; probe?: ResourceProbe; capImages?: number } = {},
) {
  const storeDir = tempDir('tbi-pol-store-');
  const work = tempDir('tbi-pol-work-');
  const state = tempDir('tbi-pol-state-');
  dirs.push(storeDir, work, state);
  const grants = new Grants(join(state, 'grants.db'));
  const rates = new RateLimiter(join(state, 'rates.db'));
  const store = new ArtifactStore({
    dir: storeDir,
    capBytes: (opts.capImages ?? 64) * 4 * 1024 * 1024,
    graceMs: 0,
    onEvicted: (sha) => grants.dropArtifact(sha),
  });
  const provider = new FakeProvider();
  const service = new BuildService(
    [provider],
    store,
    work,
    { ...DEFAULT_LIMITS, timeoutMs: 1500 },
    {
      grants,
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(),
      policy,
      rates,
      probe: opts.probe ?? plenty,
      ...(opts.live ? { liveSessions: opts.live } : {}),
    },
  );
  // Stalled test builds end at the 1.5 s timeout: let them finish before the state goes away.
  closers.push(async () => {
    await service.whenIdle();
    service.close();
  });
  return { service, provider, store, grants, rates, state };
}

const refusalOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'admitted';
};

async function finish(service: BuildService, out: ReturnType<BuildService['submit']>, who = A) {
  if ('cached' in out) return out.cached;
  await service.whenIdle();
  return service.status(out.buildId, out.token, who)!.result!;
}

describe('policy configuration', () => {
  it('the built-in preview/system policy validates; cpus resolves per host', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toBeTruthy();
    const p = new Policy(DEFAULT_POLICY, 4);
    expect(p.maxLiveSessions).toBe(4);
    expect(p.deferBuildsAtLiveSessions).toBe(4);
    expect(p.planName(A)).toBe('preview');
  });

  it('principals map to plans by assignment; a bad policy is refused at load', () => {
    const p = preview((c) => (c.assignments[A] = 'system'));
    expect(p.planName(A)).toBe('system');
    expect(p.planName(B)).toBe('preview');
    expect(() => validatePolicy({ ...DEFAULT_POLICY, defaultPlan: 'pro' })).toThrow(/defaultPlan/);
    expect(() => validatePolicy({ ...DEFAULT_POLICY, assignments: { [A]: 'enterprise' } })).toThrow(
      /assignment/,
    );
    const bad = structuredClone(DEFAULT_POLICY);
    bad.plans.preview!.build.submissions.windowMs = 10;
    expect(() => validatePolicy(bad)).toThrow(/rate rule/);
    const file = join(tempDir('tbi-pol-file-'), 'p.json');
    dirs.push(join(file, '..'));
    writeFileSync(file, JSON.stringify(DEFAULT_POLICY));
    expect(Policy.fromEnv({ TBI_POLICY_FILE: file }).planName(A)).toBe('preview');
  });
});

describe('the deployed policy file', () => {
  it('deploy/dev-lab/s8/policy.json validates and states exactly the built-in preview/system values', async () => {
    const { readFileSync } = await import('node:fs');
    const file = JSON.parse(
      readFileSync(new URL('../../../deploy/dev-lab/s8/policy.json', import.meta.url), 'utf8'),
    ) as PolicyConfig;
    expect(validatePolicy(file)).toEqual(DEFAULT_POLICY);
    expect(Object.keys(file.plans).sort()).toEqual(['preview', 'system']);
  });
});

describe('rate windows', () => {
  it('a window allows `count` events, refuses with the wait, and survives a restart', () => {
    let now = 1_000_000;
    const dir = tempDir('tbi-rate-');
    dirs.push(dir);
    const rule = { count: 2, windowMs: 60_000 };
    const r1 = new RateLimiter(join(dir, 'r.db'), () => now);
    expect(r1.take(A, 'x', rule).ok).toBe(true);
    now += 10_000;
    expect(r1.take(A, 'x', rule).ok).toBe(true);
    expect(r1.take(A, 'x', rule)).toEqual({ ok: false, retryAfterMs: 50_000 });
    expect(r1.take(B, 'x', rule).ok).toBe(true); // another principal is untouched
    // A new process (restart) sees the same window.
    const r2 = new RateLimiter(join(dir, 'r.db'), () => now);
    expect(r2.take(A, 'x', rule).ok).toBe(false);
    now += 50_001;
    expect(r2.take(A, 'x', rule).ok).toBe(true);
  });

  it('concurrent takes through two connections never exceed the count', () => {
    const dir = tempDir('tbi-rate-');
    dirs.push(dir);
    const a = new RateLimiter(join(dir, 'r.db'));
    const b = new RateLimiter(join(dir, 'r.db'));
    const rule = { count: 5, windowMs: 60_000 };
    let ok = 0;
    for (let i = 0; i < 20; i++) if ((i % 2 ? a : b).take(A, 'y', rule).ok) ok++;
    expect(ok).toBe(5);
  });
});

describe('build admission (per-principal quota, shared capacity, fairness)', () => {
  it('one user cannot fill the queue: their in-flight builds stop at the quota while others still get in', () => {
    const { service } = buildWorld(preview());
    expect(refusalOf(() => service.submit(sketch('#stall a1'), A))).toBe('admitted'); // active
    expect(refusalOf(() => service.submit(sketch('#stall a2'), A))).toBe('admitted'); // queued
    expect(refusalOf(() => service.submit(sketch('#stall a3'), A))).toBe('build_quota');
    // B and C still make progress; the shared queue (3) then fills and D is told it is busy.
    expect(refusalOf(() => service.submit(sketch('#stall b1'), B))).toBe('admitted');
    expect(refusalOf(() => service.submit(sketch('#stall c1'), C))).toBe('admitted');
    expect(refusalOf(() => service.submit(sketch('#stall d1'), D))).toBe('builder_busy');
    expect(service.inFlight(A)).toBe(2);
  });

  it('every user’s builds complete in turn (bounded progress), and a finished build frees the slot', async () => {
    const { service, provider } = buildWorld(preview());
    const outs = [A, B, C].map((p, i) => ({
      p,
      out: service.submit(sketch(`void setup(){} // ${i}`), p),
    }));
    for (const { p, out } of outs) expect((await finish(service, out, p)).ok).toBe(true);
    expect(provider.builds).toBe(3);
    expect(refusalOf(() => service.submit(sketch('void setup(){} // again'), A))).toBe('admitted');
  });

  it('cache hits and lookups use no compile slot and no rate', async () => {
    const policy = preview((c) => (c.plans.preview!.build.submissions.count = 1));
    const { service, rates } = buildWorld(policy);
    const out = service.submit(sketch('void setup(){} // cached'), A);
    await finish(service, out);
    for (let i = 0; i < 5; i++) {
      const again = service.submit(sketch('void setup(){} // cached'), A);
      expect('cached' in again).toBe(true);
    }
    // The one submission is the only one counted.
    expect(rates.check(A, 'build-submit', { count: 2, windowMs: 600_000 }).ok).toBe(true);
    expect(refusalOf(() => service.submit(sketch('void setup(){} // new'), A))).toBe(
      'rate_limited',
    );
  });

  it('the submission rate refuses with a wait; a refused attempt consumes nothing', async () => {
    const policy = preview((c) => {
      c.plans.preview!.build.submissions = { count: 2, windowMs: 60_000 };
      c.global.build.maxQueued = 1;
    });
    const { service } = buildWorld(policy);
    // Others take the worker and the one queue slot.
    service.submit(sketch('#stall b'), B);
    service.submit(sketch('#stall c'), C);
    // A is refused for shared capacity, repeatedly — before its rate is touched.
    for (let i = 0; i < 5; i++)
      expect(refusalOf(() => service.submit(sketch(`void setup(){} // a${i}`), A))).toBe(
        'builder_busy',
      );
    await service.whenIdle();
    // A still has its whole allowance (2), then the window refuses with a wait.
    await finish(service, service.submit(sketch('void setup(){} // a-ok-1'), A));
    await finish(service, service.submit(sketch('void setup(){} // a-ok-2'), A));
    let code: string | undefined;
    let retry = 0;
    try {
      service.submit(sketch('void setup(){} // a-3'), A);
    } catch (e) {
      code = (e as { code: string }).code;
      retry = (e as { retryAfterMs: number }).retryAfterMs;
    }
    expect(code).toBe('rate_limited');
    expect(retry).toBeGreaterThan(0);
  });

  it('deliberate compile failures lead to a cool-down for that user only, and hold no capacity', async () => {
    const policy = preview((c) => {
      c.plans.preview!.build.failures = { count: 2, windowMs: 60_000 };
      c.plans.preview!.build.cooldownMs = 60_000;
    });
    const { service } = buildWorld(policy);
    for (let i = 0; i < 2; i++) {
      const r = await finish(service, service.submit(sketch(`#error ${i}`), A));
      expect(r.failure).toBe('compile_error');
    }
    expect(service.inFlight(A)).toBe(0);
    expect(refusalOf(() => service.submit(sketch('#error 3'), A))).toBe('build_cooldown');
    expect(refusalOf(() => service.submit(sketch('void setup(){} // b'), B))).toBe('admitted');
  });

  it('simultaneous submissions cannot race past the quota (over HTTP, 12 at once)', async () => {
    const { service } = buildWorld(preview());
    const server = createBuildHttpServer(service, { leaseMs: 60_000, identity: TEST_IDENTITY });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => void server.close());
    const gate = await startTestGate(
      { host: '127.0.0.1', port: (server.address() as AddressInfo).port },
      TEST_IDENTITY,
      'user-a',
    );
    closers.push(gate.close);
    const answers = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fetch(`${gate.base}/v1/builds`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sketch(`#stall race ${i}`)),
        }).then(async (r) => ({ status: r.status, body: (await r.json()) as { error?: string } })),
      ),
    );
    const admitted = answers.filter((a) => a.status === 202);
    const refused = answers.filter((a) => a.status === 429);
    expect(admitted).toHaveLength(2); // maxActive 1 + maxQueued 1
    expect(refused).toHaveLength(10);
    expect(new Set(refused.map((a) => a.body.error))).toEqual(new Set(['build_quota']));
    expect(service.inFlight(A)).toBe(2);
  });

  it('rate windows and cool-downs survive a service restart', async () => {
    const policy = preview(
      (c) => (c.plans.preview!.build.submissions = { count: 1, windowMs: 600_000 }),
    );
    const w = buildWorld(policy);
    await finish(w.service, w.service.submit(sketch('void setup(){} // once'), A));
    expect(refusalOf(() => w.service.submit(sketch('void setup(){} // twice'), A))).toBe(
      'rate_limited',
    );
    // A new process on the same state directory.
    const rates = new RateLimiter(join(w.state, 'rates.db'));
    const again = new BuildService(
      [new FakeProvider()],
      w.store,
      tempDir('tbi-pol-work-'),
      DEFAULT_LIMITS,
      {
        grants: w.grants,
        ticketKey: TEST_TICKET_KEY,
        systemKeys: new Set(),
        policy,
        rates,
        probe: plenty,
      },
    );
    closers.push(() => again.close());
    expect(refusalOf(() => again.submit(sketch('void setup(){} // thrice'), A))).toBe(
      'rate_limited',
    );
  });
});

describe('admission against live sessions (CPU is the binding resource)', () => {
  it('while live sessions occupy the CPUs a build waits in the queue (nothing is stopped); it starts when they end', async () => {
    let live = 1;
    const { service, provider } = buildWorld(preview(), { live: () => live });
    const out = service.submit(sketch('void setup(){} // deferred'), A);
    if ('cached' in out) throw new Error('unexpected');
    await new Promise((r) => setTimeout(r, 1500));
    expect(provider.builds).toBe(0);
    expect(service.status(out.buildId, out.token, A)?.state).toBe('queued');
    live = 0;
    await expect
      .poll(() => service.status(out.buildId, out.token, A)?.state, { timeout: 5000 })
      .toBe('succeeded');
  });

  it('a build that cannot start within the policy wait fails as capacity_timeout (never runs late)', async () => {
    const { service, provider } = buildWorld(
      preview((c) => (c.global.build.maxQueueWaitMs = 1000)),
      { live: () => 5 },
    );
    const out = service.submit(sketch('void setup(){} // starved'), A);
    if ('cached' in out) throw new Error('unexpected');
    await expect
      .poll(() => service.status(out.buildId, out.token, A)?.state, { timeout: 5000 })
      .toBe('failed');
    expect(service.status(out.buildId, out.token, A)?.result?.failure).toBe('capacity_timeout');
    expect(provider.builds).toBe(0);
    expect(service.inFlight(A)).toBe(0);
  });

  it('low disk or memory refuses new builds before any work', () => {
    const { service } = buildWorld(preview(), {
      probe: { freeDiskMb: () => 10, availableMemoryMb: () => 1e9 },
    });
    expect(refusalOf(() => service.submit(sketch('void setup(){}'), A))).toBe('storage_pressure');
    const m = buildWorld(preview(), {
      probe: { freeDiskMb: () => 1e9, availableMemoryMb: () => 10 },
    });
    expect(refusalOf(() => m.service.submit(sketch('void setup(){}'), A))).toBe('memory_pressure');
  });
});

describe('storage quota and retention', () => {
  it('over the quota the user’s own least recently used, unleased artifact goes; another user’s never', async () => {
    const policy = preview((c) => (c.plans.preview!.storage.maxArtifacts = 2));
    const { service, store, grants } = buildWorld(policy);
    const r1 = await finish(service, service.submit(sketch('void setup(){} // s1'), A));
    const b1 = await finish(service, service.submit(sketch('void setup(){} // s1'), B), B);
    expect(b1.artifact!.sha256).toBe(r1.artifact!.sha256); // one blob, two holders
    const r2 = await finish(service, service.submit(sketch('void setup(){} // s2'), A));
    service.lease(A, r1.artifact!.sha256, 60_000); // r1 is about to run: protected
    const r3 = await finish(service, service.submit(sketch('void setup(){} // s3'), A));
    expect(grants.usage(A).artifacts).toBe(2);
    expect(service.lookup(r2.key, A)).toBeNull(); // the unleased LRU went
    expect(service.lookup(r1.key, A)).not.toBeNull(); // the leased one stayed
    expect(service.lookup(r3.key, A)).not.toBeNull();
    expect(store.exists(r2.artifact!.sha256)).toBe(false); // nobody holds it any more
    expect(service.lookup(b1.key, B)).not.toBeNull(); // B's record of the shared blob is B's
  });

  it('when every own artifact is leased, a new build is refused as storage_quota', async () => {
    const policy = preview((c) => (c.plans.preview!.storage.maxArtifacts = 1));
    const { service } = buildWorld(policy);
    const r1 = await finish(service, service.submit(sketch('void setup(){} // q1'), A));
    service.lease(A, r1.artifact!.sha256, 60_000);
    expect(refusalOf(() => service.submit(sketch('void setup(){} // q2'), A))).toBe(
      'storage_quota',
    );
    expect(refusalOf(() => service.submit(sketch('void setup(){} // q2'), B))).toBe('admitted');
  });

  it('shared system records never count as a user’s storage', async () => {
    const policy = preview();
    const w = buildWorld(policy);
    // A curated source: built as `global`.
    const text = 'void setup(){} // curated';
    const { sourceKey } = await import('@tbi-lab/domain');
    const key = sourceKey(sketch(text).profile, sketch(text).files);
    const curated = new BuildService(
      [new FakeProvider()],
      w.store,
      tempDir('tbi-pol-work-'),
      DEFAULT_LIMITS,
      {
        ...w.service.access,
        systemKeys: new Set([key]),
      },
    );
    closers.push(() => curated.close());
    await finish(curated, curated.submit(sketch(text), A));
    expect(w.grants.usage(A)).toEqual({ artifacts: 0, bytes: 0 });
  });

  it('retention drops unused private grants after the plan’s period — not leased, not shared, not others’', async () => {
    const policy = preview((c) => (c.plans.preview!.storage.retentionDays = 30));
    const { service, store, grants } = buildWorld(policy);
    const old = await finish(service, service.submit(sketch('void setup(){} // old'), A));
    const kept = await finish(service, service.submit(sketch('void setup(){} // leased'), A));
    const other = await finish(service, service.submit(sketch('void setup(){} // other'), B), B);
    service.lease(A, kept.artifact!.sha256, 10 * 24 * 3600_000);
    const day = 24 * 3600_000;
    // 29 days later nothing is due; 31 days later the unused, unleased grants are.
    expect(await service.sweepRetention(Date.now() + 29 * day)).toBe(0);
    const dropped = await service.sweepRetention(Date.now() + 31 * day);
    expect(dropped).toBe(2); // A's `old` and B's `other`; A's leased one stays
    expect(grants.usage(A).artifacts).toBe(1);
    expect(store.exists(old.artifact!.sha256)).toBe(false);
    expect(store.exists(kept.artifact!.sha256)).toBe(true);
    expect(store.exists(other.artifact!.sha256)).toBe(false);
  });
});

describe('Advanced prebuilt under policy', () => {
  it('capability OFF is refused; ON follows the upload rate and storage quota like any firmware', async () => {
    const off = buildWorld(
      preview((c) => (c.plans.preview!.capabilities.allowPrebuiltBinary = false)),
    );
    await expect(off.service.publishPrebuilt(A, fakeImage('x'))).rejects.toMatchObject({
      code: 'capability_disabled',
    });
    const on = buildWorld(
      preview((c) => {
        c.plans.preview!.storage.prebuiltUploads = { count: 1, windowMs: 60_000 };
      }),
    );
    await on.service.publishPrebuilt(A, fakeImage('one'));
    await expect(on.service.publishPrebuilt(A, fakeImage('two'))).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await on.service.publishPrebuilt(B, fakeImage('two')); // B has its own allowance
    expect(on.grants.usage(A).artifacts).toBe(1);
  });
});

describe('runtime admission (Session Host)', () => {
  async function hostWorld(policy: Policy, probe: ResourceProbe = plenty) {
    const state = tempDir('tbi-pol-host-');
    dirs.push(state);
    const rates = new RateLimiter(join(state, 'rates.db'));
    const { host, art } = fakeHost('normal', { policy, rates, probe });
    const server = createHttpServer(host, TEST_IDENTITY);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
    const gates = await Promise.all(
      ['user-a', 'user-b', 'user-c'].map((u) => startTestGate(target, TEST_IDENTITY, u)),
    );
    closers.push(async () => {
      for (const g of gates) g.close();
      server.closeAllConnections();
      server.close();
      await host.shutdown();
    });
    const create = async (gate: number, who = [A, B, C][gate]!) => {
      const r = await fetch(`${gates[gate]!.base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createRequest(art.sha256, { ticket: ticketFor(art.sha256, who) })),
      });
      return {
        status: r.status,
        retryAfter: r.headers.get('retry-after'),
        body: (await r.json()) as { error?: string; sessionId?: string; token?: string },
      };
    };
    return { host, create, state, art };
  }

  it('a user’s own session limit, then the host’s capacity — nobody else’s session is touched or named', async () => {
    const { host, create } = await hostWorld(
      preview((c) => (c.global.runtime.maxLiveSessions = 2)),
    );
    const a1 = await create(0);
    expect(a1.status).toBe(201);
    const a2 = await create(0);
    expect(a2).toMatchObject({ status: 429, body: { error: 'session_quota' } });
    expect((await create(1)).status).toBe(201);
    const c1 = await create(2);
    expect(c1.status).toBe(503);
    expect(c1.body).toEqual({ error: 'runtime_capacity', retryAfterS: 15 }); // no names, no counts
    expect(c1.retryAfter).toBe('15');
    expect(host.get(a1.body.sessionId!, a1.body.token!, A).ok).toBe(true); // A's session runs on
  });

  it('the creation rate refuses with a wait and survives a host restart', async () => {
    const policy = preview(
      (c) => (c.plans.preview!.runtime.creations = { count: 2, windowMs: 600_000 }),
    );
    const { host, create, state } = await hostWorld(policy);
    for (let i = 0; i < 2; i++) {
      const s = await create(0);
      expect(s.status).toBe(201);
      const got = host.get(s.body.sessionId!, s.body.token!, A);
      if (got.ok) await host.terminate(got.value);
    }
    const third = await create(0);
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('rate_limited');
    expect(Number(third.retryAfter)).toBeGreaterThan(0);
    // A restarted host on the same state directory remembers the window.
    const again = new RateLimiter(join(state, 'rates.db'));
    expect(again.check(A, 'session-create', { count: 2, windowMs: 600_000 }).ok).toBe(false);
  });

  it('low memory refuses new sessions; the plan’s lifetime caps every session', async () => {
    const low = await hostWorld(preview(), { freeDiskMb: () => 1e9, availableMemoryMb: () => 10 });
    expect((await low.create(0)).body.error).toBe('memory_pressure');
    const capped = await hostWorld(
      preview((c) => (c.plans.preview!.runtime.maxLifetimeMs = 60_000)),
    );
    const s = await capped.create(0);
    expect(s.status).toBe(201);
    const session = capped.host.get(s.body.sessionId!, s.body.token!, A);
    expect(session.ok && session.value.lifetimeMs).toBe(60_000);
  });
});
