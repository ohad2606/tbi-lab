/**
 * Sprint 18F, build performance: the Arduino core seed (coreSeed.ts) and the prewarm of the
 * curated sources (BuildService.prewarm). No toolchain here; the real-toolchain equivalence
 * (a seeded build is byte-identical to a cold one, every curated example) and the latency
 * benchmark are runtime/tests/s18f-build-seed.runtime.test.ts.
 */
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceKey } from '@tbi-lab/domain';
import {
  applyCoreSeed,
  coreSeedKey,
  harvestCoreSeed,
  pruneCoreSeeds,
  removeCoreSeed,
} from '../coreSeed.js';
import { Grants } from '../grants.js';
import { BuildService, DEFAULT_LIMITS } from '../service.js';
import { ArtifactStore } from '../store.js';
import { systemBuildRequests, systemSourceKeys } from '../system-sources.js';
import { TEST_TICKET_KEY, principalFor } from '../../identity/test-gate.js';
import { openAccessPolicy } from '../../policy/testing.js';
import { FakeProvider, sketch, tempDir } from './support.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = (p: string) => {
  const d = tempDir(p);
  cleanup.push(d);
  return d;
};

/** A build directory as arduino-cli leaves it: core objects, its options file, the sketch. */
function fakeBuild(root: string, stamp = 1_700_000_000) {
  const b = join(root, 'build');
  mkdirSync(join(b, 'core'), { recursive: true });
  mkdirSync(join(b, 'sketch'), { recursive: true });
  for (const f of ['Print.cpp.o', 'Print.cpp.d', 'core.a']) {
    writeFileSync(join(b, 'core', f), `obj ${f}`);
    utimesSync(join(b, 'core', f), stamp, stamp);
  }
  writeFileSync(join(b, 'build.options.json'), '{"fqbn":"esp32:esp32:esp32"}');
  writeFileSync(join(b, 'sketch', 'sketch.ino.cpp.o'), 'user object');
  return b;
}

const base = {
  profileHash: 'a'.repeat(64),
  argv: ['compile', '--build-path', '/job/build'],
  config: 'directories:\n',
  env: { HOME: '/job' },
};

describe('core seed', () => {
  it('the key changes with every input the core compile sees', () => {
    const k = coreSeedKey(base);
    expect(coreSeedKey({ ...base })).toBe(k);
    expect(coreSeedKey({ ...base, profileHash: 'b'.repeat(64) })).not.toBe(k);
    expect(coreSeedKey({ ...base, argv: [...base.argv, '-O2'] })).not.toBe(k);
    expect(coreSeedKey({ ...base, config: 'directories:\n  user: /x\n' })).not.toBe(k);
    expect(coreSeedKey({ ...base, env: { HOME: '/job', LANG: 'C' } })).not.toBe(k);
  });

  it('harvest then apply: only the core and its options, timestamps kept, group-writable', async () => {
    const seeds = dir('seeds-');
    const key = coreSeedKey(base);
    const from = fakeBuild(dir('job-a-'));
    expect(await applyCoreSeed(seeds, key, from)).toBe(false); // none yet
    expect(await harvestCoreSeed(seeds, key, from)).toBe(true);
    expect(await harvestCoreSeed(seeds, key, from)).toBe(false); // exists: kept
    // The kept seed is never group-writable (only the copies a job gets are).
    expect(statSync(join(seeds, key)).mode & 0o777).toBe(0o750);
    expect(statSync(join(seeds, key, 'core')).mode & 0o777).toBe(0o750);
    expect(statSync(join(seeds, key, 'core', 'Print.cpp.o')).mode & 0o777).toBe(0o640);
    const to = join(dir('job-b-'), 'build');
    mkdirSync(to);
    expect(await applyCoreSeed(seeds, key, to)).toBe(true);
    expect(readdirSync(to).sort()).toEqual(['build.options.json', 'core']);
    expect(readdirSync(join(to, 'core')).sort()).toEqual(['Print.cpp.d', 'Print.cpp.o', 'core.a']);
    const st = statSync(join(to, 'core', 'Print.cpp.o'));
    expect(Math.round(st.mtimeMs / 1000)).toBe(1_700_000_000);
    expect(st.mode & 0o777).toBe(0o660);
    expect(statSync(join(to, 'core')).mode & 0o777).toBe(0o770);
    // Another configuration never gets it.
    const other = join(dir('job-c-'), 'build');
    mkdirSync(other);
    expect(await applyCoreSeed(seeds, coreSeedKey({ ...base, argv: ['x'] }), other)).toBe(false);
    expect(readdirSync(other)).toEqual([]);
    await removeCoreSeed(to);
    expect(readdirSync(to)).toEqual([]);
  });

  it('an incomplete seed (no marker, other format) is never applied; nothing partial is published', async () => {
    const seeds = dir('seeds-');
    const key = coreSeedKey(base);
    mkdirSync(join(seeds, key, 'core'), { recursive: true });
    writeFileSync(join(seeds, key, 'core', 'Print.cpp.o'), 'half');
    const to = join(dir('job-'), 'build');
    mkdirSync(to);
    expect(await applyCoreSeed(seeds, key, to)).toBe(false);
    writeFileSync(join(seeds, key, 'seed.json'), JSON.stringify({ key, format: 0 }));
    expect(await applyCoreSeed(seeds, key, to)).toBe(false);
    writeFileSync(join(seeds, key, 'seed.json'), JSON.stringify({ key: 'x', format: 1 }));
    expect(await applyCoreSeed(seeds, key, to)).toBe(false);
    expect(readdirSync(to)).toEqual([]);
    // A build without its core (failed early) leaves no seed.
    const empty = join(dir('job-'), 'build');
    mkdirSync(empty);
    expect(await harvestCoreSeed(seeds, coreSeedKey({ ...base, argv: ['y'] }), empty)).toBe(false);
    expect(readdirSync(seeds).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('prune keeps the current seed; interrupted harvests go only at start', async () => {
    const seeds = dir('seeds-');
    const k1 = coreSeedKey(base);
    const k2 = coreSeedKey({ ...base, argv: ['other'] });
    await harvestCoreSeed(seeds, k1, fakeBuild(dir('a-')));
    await harvestCoreSeed(seeds, k2, fakeBuild(dir('b-')));
    mkdirSync(join(seeds, '.tmp-abc'));
    await pruneCoreSeeds(seeds, new Set([k2]));
    expect(readdirSync(seeds).sort()).toEqual(['.tmp-abc', k2]);
    await pruneCoreSeeds(seeds, new Set([k2]), true);
    expect(readdirSync(seeds)).toEqual([k2]);
  });
});

function setup(systemKeys: ReadonlySet<string>) {
  const storeDir = dir('tbi-store-');
  const work = dir('tbi-work-');
  const state = dir('tbi-state-');
  const provider = new FakeProvider();
  const grants = new Grants(join(state, 'grants.db'));
  const service = new BuildService(
    [provider],
    new ArtifactStore({ dir: storeDir, capBytes: 256 * 1024 * 1024, graceMs: 0 }),
    work,
    DEFAULT_LIMITS,
    { grants, ticketKey: TEST_TICKET_KEY, systemKeys, ...openAccessPolicy() },
  );
  return { service, provider, grants };
}

const A = principalFor('user-a');
const curatedA = sketch('void setup() {}\nvoid loop() {} // curated A\n');
const curatedB = sketch('void setup() {}\nvoid loop() {} // curated B\n');
const keyOf = (r: typeof curatedA) => sourceKey(r.profile, r.files);

describe('prewarm of the curated sources', () => {
  it('builds each curated source without a current shared build, once; only those are curated jobs', async () => {
    const { service, provider } = setup(new Set([keyOf(curatedA), keyOf(curatedB)]));
    const user = sketch('void setup() {}\nvoid loop() {} // mine\n');
    // Not a system source: never prewarmed (even when passed).
    expect(await service.prewarm([curatedA, user, curatedB], { pollMs: 5 })).toBe(2);
    expect(provider.builds).toBe(2);
    expect(provider.curated).toEqual([true, true]);
    // Shared: any user now gets a cache hit; a second prewarm builds nothing.
    expect('cached' in service.submit(curatedA, A)).toBe(true);
    expect(await service.prewarm([curatedA, curatedB], { pollMs: 5 })).toBe(0);
    // A user's own source is never a curated job.
    const out = service.submit(user, A);
    expect('buildId' in out).toBe(true);
    await service.whenIdle();
    expect(provider.curated).toEqual([true, true, false]);
  });

  it('waits for user builds first; a user asking for a prewarming source joins it', async () => {
    const { service, provider } = setup(new Set([keyOf(curatedA)]));
    let release!: () => void;
    provider.gate = new Promise<void>((r) => (release = r));
    const mine = service.submit(sketch('void setup() {}\nvoid loop() {} // first\n'), A);
    expect('buildId' in mine).toBe(true);
    const warm = service.prewarm([curatedA], { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    expect(provider.builds).toBe(1); // still the user's build
    release();
    provider.gate = null;
    await service.whenIdle();
    // The prewarm build is queued or running now; the user's request for it shares it.
    await new Promise((r) => setTimeout(r, 20));
    const joined = service.submit(curatedA, A);
    expect(await warm).toBe(1);
    expect(provider.builds).toBe(2);
    if ('buildId' in joined)
      expect(service.status(joined.buildId, joined.token, A)?.result?.ok).toBe(true);
  });

  it('no seed (lost, new format): one current curated source is built again, which leaves it', async () => {
    const { service, provider } = setup(new Set([keyOf(curatedA), keyOf(curatedB)]));
    expect(await service.prewarm([curatedA, curatedB], { pollMs: 5 })).toBe(2);
    expect(provider.builds).toBe(2);
    // The seed is gone while both shared builds are current: exactly one rebuild, seed back.
    provider.seed = false;
    expect(await service.prewarm([curatedA, curatedB], { pollMs: 5 })).toBe(1);
    expect(provider.builds).toBe(3);
    expect(provider.seed).toBe(true);
    expect(await service.prewarm([curatedA, curatedB], { pollMs: 5 })).toBe(0);
    // A harvest that keeps failing costs one rebuild per run, not one per source.
    const failing = sketch('void setup() {}\nvoid loop() {} // #noseed\n');
    const s2 = setup(new Set([keyOf(failing), keyOf(curatedB)]));
    expect(await s2.service.prewarm([failing, curatedB], { pollMs: 5 })).toBe(2);
    s2.provider.seed = false;
    expect(await s2.service.prewarm([failing, curatedB], { pollMs: 5 })).toBe(1);
    expect(s2.provider.seed).toBe(false);
    expect(s2.provider.builds).toBe(3);
  });

  it('stops when asked; the real curated list is all system sources, each once', async () => {
    const { service, provider } = setup(new Set([keyOf(curatedA)]));
    expect(await service.prewarm([curatedA], { stopped: () => true })).toBe(0);
    expect(provider.builds).toBe(0);
    const requests = systemBuildRequests();
    const keys = systemSourceKeys();
    expect(requests.length).toBe(keys.size);
    expect(new Set(requests.map(keyOf))).toEqual(keys);
  });
});
