/**
 * Capacity A4, first slice: current curated build images are pinned against LRU eviction, and the
 * prewarm pass repeats. Fake provider, fake clock, no toolchain.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestKey } from '../libraries.js';
import { Grants } from '../grants.js';
import { PREWARM_ATTEMPTS, startPrewarm } from '../prewarm.js';
import { BuildService, DEFAULT_LIMITS } from '../service.js';
import { ArtifactStore } from '../store.js';
import { TEST_TICKET_KEY, principalFor } from '../../identity/test-gate.js';
import { Policy } from '../../policy/policy.js';
import { openPolicy, openPolicyConfig } from '../../policy/testing.js';
import { RateLimiter } from '../../policy/rate.js';
import type { ResourceProbe } from '../../policy/resources.js';
import { FakeProvider, IMAGE_BYTES, fakeImage, sketch, tempDir } from './support.js';

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const A = principalFor('user-a');
const curated = [1, 2, 3].map((n) => sketch(`void setup() {} void loop() {} // curated ${n}\n`));
const user = (n: number) => sketch(`void setup() {} void loop() {} // user ${n}\n`);
const GRACE = 1000;

interface WorldOptions {
  live?: () => number;
  /** Host free disk and memory, checked against floors of 1 (default: no floors). */
  probe?: ResourceProbe;
}

function floorPolicy() {
  const c = openPolicyConfig();
  c.global.resources = { minFreeDiskMb: 1, minAvailableMemoryMb: 1 };
  return new Policy(c, 1);
}

function world(capImages: number, opts: WorldOptions = {}) {
  const storeDir = tempDir('tbi-a4-store-');
  const work = tempDir('tbi-a4-work-');
  const state = tempDir('tbi-a4-state-');
  dirs.push(storeDir, work, state);
  const clock = { now: 1_000_000 };
  const provider = new FakeProvider();
  const warnings: string[] = [];
  /** A new process on the same directories (restart). */
  const start = async () => {
    const grants = new Grants(join(state, 'grants.db'), () => clock.now);
    const store: ArtifactStore = new ArtifactStore({
      dir: storeDir,
      capBytes: capImages * IMAGE_BYTES,
      graceMs: GRACE,
      now: () => clock.now,
      onEvicted: (sha) => grants.dropArtifact(sha),
      isPinned: (sha) => service.isPinned(sha),
      warn: (l) => warnings.push(l),
    });
    await store.load();
    const service: BuildService = new BuildService([provider], store, work, DEFAULT_LIMITS, {
      grants,
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(curated.map(requestKey)),
      policy: opts.probe ? floorPolicy() : openPolicy(),
      ...(opts.probe ? { probe: opts.probe } : {}),
      rates: new RateLimiter(':memory:'),
      ...(opts.live ? { liveSessions: opts.live } : {}),
    });
    return { service, store, grants };
  };
  return { start, provider, clock, warnings, storeDir };
}

type World = ReturnType<typeof world>;
type Proc = Awaited<ReturnType<World['start']>>;

async function build(w: World, p: Proc, request = user(0)) {
  w.clock.now += 10 * GRACE;
  const out = p.service.submit(request, A);
  if ('cached' in out) return out.cached;
  await p.service.whenIdle();
  return p.service.status(out.buildId, out.token, A)!.result!;
}

const hits = (p: Proc) => curated.map((c) => p.service.lookup(requestKey(c), A) !== null);

describe('pinned curated images', () => {
  it.each([false, true])(
    'user builds never evict a curated image; user LRU order unchanged (restart: %s)',
    async (restart) => {
      const w = world(5);
      let p = await w.start();
      expect(await p.service.prewarm(curated, { pollMs: 1 })).toBe(3);
      if (restart) {
        p.grants.close();
        p = await w.start();
      }
      const shas: string[] = [];
      for (let i = 0; i < 10; i++) shas.push((await build(w, p, user(i))).artifact!.sha256);
      expect(hits(p)).toEqual([true, true, true]);
      expect(shas.map((s) => p.store.exists(s))).toEqual(shas.map((_, i) => i >= 8));
      expect(p.store.managedBytes()).toBe(5 * IMAGE_BYTES);
      expect(w.warnings).toEqual([]);
    },
  );

  it.each(['analyzer', 'profile', 'capabilities'])(
    'an outdated curated build (%s) is not pinned and can be evicted',
    async (what) => {
      const w = world(1);
      const p = await w.start();
      const r = await build(w, p, curated[0]);
      const sha = r.artifact!.sha256;
      expect(p.service.isPinned(sha)).toBe(true);
      if (what === 'profile') Object.assign(w.provider, { profileHash: 'e'.repeat(64) });
      else if (what === 'capabilities') w.provider.analysisCapabilities = ['unmodelled'];
      else p.grants.recordBuild('global', { ...p.grants.buildsOf('global', sha)[0]!, analyzer: 0 });
      expect(p.service.isPinned(sha)).toBe(false);
      await build(w, p);
      expect(p.store.exists(sha)).toBe(false);
    },
  );

  it('a user-built or uploaded image is never pinned', async () => {
    const w = world(8);
    const p = await w.start();
    const mine = (await build(w, p)).artifact!.sha256;
    const upload = (await p.service.publishPrebuilt(A, fakeImage('upload'))).sha256;
    expect([p.service.isPinned(mine), p.service.isPinned(upload)]).toEqual([false, false]);
    // A global grant whose key is not a system key is not pinned either.
    p.grants.recordBuild('global', p.grants.buildsOf(A, mine)[0]!);
    expect(p.service.isPinned(mine)).toBe(false);
  });

  it('an image of a profile that is no longer offered is not pinned', async () => {
    const w = world(8);
    const p = await w.start();
    const sha = (await build(w, p, curated[0])).artifact!.sha256;
    const without = new BuildService([], p.store, w.storeDir, DEFAULT_LIMITS, p.service.access);
    expect([p.service.isPinned(sha), without.isPinned(sha)]).toEqual([true, false]);
  });

  it('a failing pin check keeps that image, evicts the others and does not fail the build', async () => {
    const w = world(2);
    const p = await w.start();
    const unsure = (await build(w, p, user(1))).artifact!.sha256;
    const other = (await build(w, p, user(2))).artifact!.sha256;
    const real = p.service.isPinned.bind(p.service);
    vi.spyOn(p.service, 'isPinned').mockImplementation((sha) => {
      if (sha === unsure) throw new Error('database is locked');
      return real(sha);
    });
    const result = await build(w, p, user(3));
    expect(result.ok).toBe(true);
    expect(p.service.lookup(requestKey(user(3)), A)).not.toBeNull();
    expect([unsure, other].map((s) => p.store.exists(s))).toEqual([true, false]);
    await build(w, p, user(4));
    expect(p.store.exists(unsure)).toBe(true);
    // Once per process; never reported as pins over the cap.
    expect(w.warnings.map((l) => JSON.parse(l) as unknown)).toEqual([
      { event: 'artifact_pin_check_failed' },
    ]);
  });

  it('pins over the cap behave as a full store: publish works, protected images stay, one warning', async () => {
    const w = world(2);
    const p = await w.start();
    expect(await p.service.prewarm(curated, { pollMs: 1 })).toBe(3);
    // Warm-up inside the grace period; then user images respect lease and grace as before.
    const leased = (await build(w, p, user(1))).artifact!.sha256;
    p.store.lease(leased, 1_000_000);
    const old = (await build(w, p, user(2))).artifact!.sha256;
    const fresh = await build(w, p, user(3));
    expect(fresh.ok).toBe(true);
    expect(hits(p)).toEqual([true, true, true]);
    expect([leased, old, fresh.artifact!.sha256].map((s) => p.store.exists(s))).toEqual([
      true,
      false,
      true,
    ]);
    expect(p.store.managedBytes()).toBe(5 * IMAGE_BYTES);
    expect(w.warnings.map((l) => JSON.parse(l) as unknown)).toEqual([
      {
        event: 'artifact_pins_over_cap',
        pinnedBytes: 3 * IMAGE_BYTES,
        capBytes: 2 * IMAGE_BYTES,
      },
    ]);
  });
});

describe('repeated prewarm', () => {
  const INTERVAL = 600_000;
  async function scheduled(requests = curated, opts: WorldOptions = {}) {
    const w = world(64, opts);
    const p = await w.start();
    const realTimeout = setTimeout;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const lines: string[] = [];
    const run = () => {
      const stop = startPrewarm(p.service, requests, {
        intervalMs: INTERVAL,
        pollMs: 5,
        log: (l) => lines.push(l),
      });
      stops.push(stop);
      return stop;
    };
    /** Advance the fake clock while real file work finishes, until `n` passes have logged. */
    const passes = async (n: number) => {
      for (let i = 0; lines.length < n; i++) {
        if (i > 5000) throw new Error(`only ${lines.length} passes`);
        await vi.advanceTimersByTimeAsync(2_000);
        await new Promise((r) => realTimeout(r, 2)); // real file work
      }
      return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    };
    return { w, p, run, passes, lines };
  }

  it('a failed pass (capacity_timeout, runner error) is retried and succeeds', async () => {
    let live = 5000;
    const s = await scheduled([curated[0]!, curated[1]!], { live: () => live });
    s.run();
    expect((await s.passes(1))[0]).toEqual({ event: 'prewarm', built: 0, missing: 2 });
    expect(s.w.provider.builds).toBe(0); // capacity_timeout: never started
    // The pass ended at the first one: the second source took no queue slot.
    const { records } = s.p.service as unknown as { records: Map<string, unknown> };
    expect(records.size).toBe(1);
    live = 0;
    const real = s.w.provider.build.bind(s.w.provider);
    let broken = true;
    s.w.provider.build = async (job) => {
      if (broken) throw new Error('runner');
      return real(job);
    };
    expect((await s.passes(2))[1]).toEqual({ event: 'prewarm', built: 0, missing: 2 });
    broken = false;
    expect((await s.passes(3))[2]).toEqual({ event: 'prewarm', built: 2, missing: 0 });
  });

  it('a persistent failure backs off (twice as many passes each time) and stops at the limit', async () => {
    const bad = sketch('#error curated');
    const s = await scheduled([bad]);
    (s.p.service.access.systemKeys as Set<string>).add(requestKey(bad));
    s.run();
    const builtAt: number[] = [];
    for (let n = 1; n <= 2 ** PREWARM_ATTEMPTS; n++) {
      const before = builtAt.length;
      await s.passes(n);
      if (s.w.provider.builds > before) builtAt.push(n);
    }
    expect(builtAt).toEqual([1, 2, 4, 8, 16, 32]);
    expect(s.w.provider.builds).toBe(PREWARM_ATTEMPTS);
    expect((await s.passes(2 ** PREWARM_ATTEMPTS)).at(-1)).toEqual({
      event: 'prewarm',
      built: 0,
      missing: 1,
    });
  });

  it('builds that never started (capacity_timeout) are not attempts', async () => {
    let live = 5000;
    const s = await scheduled([curated[0]!], { live: () => live });
    s.run();
    await s.passes(PREWARM_ATTEMPTS + 2);
    expect(s.w.provider.builds).toBe(0);
    live = 0;
    expect((await s.passes(PREWARM_ATTEMPTS + 3)).at(-1)).toEqual({
      event: 'prewarm',
      built: 1,
      missing: 0,
    });
  });

  it('a seed rebuild that never started does not spend the seed budget', async () => {
    let live = 0;
    const s = await scheduled([curated[0]!], { live: () => live });
    s.run();
    await s.passes(1);
    live = 5000;
    s.w.provider.seed = false;
    await s.passes(PREWARM_ATTEMPTS + 3);
    live = 0;
    await s.passes(PREWARM_ATTEMPTS + 4);
    expect(s.w.provider.builds).toBe(2);
    expect(s.w.provider.seed).toBe(true);
  });

  it.each(['disk', 'memory'])(
    'no build starts below the free %s floor; skipped passes are not attempts',
    async (what) => {
      let low = true;
      const s = await scheduled([curated[0]!], {
        probe: {
          freeDiskMb: () => (low && what === 'disk' ? 0 : 10),
          availableMemoryMb: () => (low && what === 'memory' ? 0 : 10),
        },
      });
      s.run();
      expect((await s.passes(PREWARM_ATTEMPTS + 2)).at(-1)).toEqual({
        event: 'prewarm',
        built: 0,
        missing: 1,
      });
      expect(s.w.provider.builds).toBe(0);
      low = false;
      expect((await s.passes(PREWARM_ATTEMPTS + 3)).at(-1)).toEqual({
        event: 'prewarm',
        built: 1,
        missing: 0,
      });
    },
  );

  it('a seed that is never left costs a bounded number of rebuilds', async () => {
    const s = await scheduled([curated[0]!]);
    s.w.provider.seed = false;
    s.w.provider.hasCoreSeed = async () => false;
    s.run();
    await s.passes(PREWARM_ATTEMPTS + 4);
    expect(s.w.provider.builds).toBe(1 + PREWARM_ATTEMPTS);
  });

  it('a missing curated blob is dropped and rebuilt by the next pass', async () => {
    const s = await scheduled([curated[0]!]);
    s.run();
    await s.passes(1);
    const sha = s.p.service.lookup(requestKey(curated[0]!), A)!.artifact!.sha256;
    rmSync(s.p.store.binPath(sha), { force: true });
    expect((await s.passes(2))[1]).toEqual({ event: 'prewarm', built: 1, missing: 0 });
    expect(readFileSync(s.p.store.binPath(sha)).length).toBe(IMAGE_BYTES);
  });

  it('never overlaps, waits for queued users, and honours stop', async () => {
    const s = await scheduled([curated[0]!]);
    let release!: () => void;
    s.w.provider.gate = new Promise<void>((r) => (release = r));
    s.p.service.submit(user(1), A);
    const spy = vi.spyOn(s.p.service, 'prewarm');
    const stop = s.run();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s.lines).toEqual([]);
    expect(s.p.service.inFlight('p_service-prewarm' as typeof A)).toBe(0);
    stop();
    s.w.provider.gate = null;
    release();
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    await s.p.service.whenIdle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s.w.provider.builds).toBe(1);
    expect(s.lines).toEqual([]);
  });
});
