/**
 * Offline unit test of the BETA-G2 queue load harness's run guard: it refuses every instance that is
 * not staging, and refuses (does not skip) a half-configured opt-in. No service, no lock, no network.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../runtime/plans/config.ts';
import { DEFAULT_SIM_HOUSEKEEPING_MS } from '../../runtime/plans/hostboot.ts';
import { defaultConfig } from '../../runtime/host/config.ts';
import {
  g2Decision,
  g2FailedReport,
  g2FreeUsers,
  g2Report,
  pollUntil,
  G2_FREE_LIVE,
  G2_PAID_DRILL,
  G2_PAUSE_PROBE,
  G2_PAUSE_REMOVAL_MS,
  G2_QUEUED,
} from '../../runtime/tests/g2-guard.ts';

const locked = () => true;
const unlocked = () => false;
const ok = {
  TBI_G2_DEPLOYED: 'tbi-s8',
  TBI_ALLOW_SERVICE_MUTATION: 'tbi-s8',
  TBI_G2_PREVIEW_USERS: 'p1,p2',
};

describe('g2-deployed guard', () => {
  it('is off (file excluded) without the opt-in', () => {
    expect(g2Decision({}, locked)).toEqual({ kind: 'off' });
    expect(g2Decision({ TBI_ALLOW_SERVICE_MUTATION: 'tbi-s8' }, locked)).toEqual({ kind: 'off' });
  });

  it.each(['tbi', 'tbi-prod', 'alpha', 'tbi-s8x', 'tbi-s88', 'TBI-S8'])(
    'refuses instance %s even with every other condition met',
    (instance) => {
      const d = g2Decision(
        { ...ok, TBI_G2_DEPLOYED: instance, TBI_ALLOW_SERVICE_MUTATION: `${instance},tbi-s8` },
        locked,
      );
      expect(d.kind).toBe('refused');
    },
  );

  it('refuses when the mutation opt-in does not name staging', () => {
    for (const m of [undefined, '', 'tbi', 'tbi-s88'])
      expect(g2Decision({ ...ok, TBI_ALLOW_SERVICE_MUTATION: m }, locked).kind).toBe('refused');
  });

  it('refuses without the pipeline lock', () => {
    expect(g2Decision(ok, unlocked).kind).toBe('refused');
  });

  it('refuses (fails, not skips) a missing or wrong preview identity list', () => {
    for (const p of [undefined, '', 'p1', 'p1,p2,p3'])
      expect(g2Decision({ ...ok, TBI_G2_PREVIEW_USERS: p }, locked).kind).toBe('refused');
  });

  it('refuses a heavy workload', () => {
    expect(g2Decision({ ...ok, TBI_C5_WORKLOAD: 'sonar' }, locked).kind).toBe('refused');
  });

  it('refuses (fails, not skips) when CI is set, even empty', () => {
    for (const CI of ['true', '1', ''])
      expect(g2Decision({ ...ok, CI }, locked).kind).toBe('refused');
    expect(g2Decision({ CI: 'true' }, locked).kind).toBe('off');
  });

  it('refuses a drain budget that is not a bounded positive number of seconds', () => {
    for (const TBI_G2_SECONDS of ['', 'x', '0', '-1', '3601'])
      expect(g2Decision({ ...ok, TBI_G2_SECONDS }, locked).kind).toBe('refused');
    expect(g2Decision({ ...ok, TBI_G2_SECONDS: '900' }, locked).kind).toBe('run');
  });

  it('runs only on staging with gate, lock and two preview identities', () => {
    expect(g2Decision({ ...ok, TBI_C5_WORKLOAD: 'gpio' }, locked)).toEqual({
      kind: 'run',
      instance: 'tbi-s8',
      previewUsers: ['p1', 'p2'],
      payingUsers: [],
    });
  });

  it('takes an optional list of extra paying identities; a repeated one is refused', () => {
    const d = g2Decision({ ...ok, TBI_G2_EXTRA_PAYING_USERS: ' p3, p4,' }, locked);
    expect(d).toMatchObject({ kind: 'run', payingUsers: ['p3', 'p4'] });
    for (const TBI_G2_EXTRA_PAYING_USERS of ['p3,p3', 'p3,p1'])
      expect(g2Decision({ ...ok, TBI_G2_EXTRA_PAYING_USERS }, locked).kind).toBe('refused');
  });
});

describe('g2-deployed drill helpers', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms) => void (t += ms) };
  };
  const zero = (v) => v === 0;

  it('has a Free identity for every index the drill uses (live, queued, pause probe)', () => {
    const free = g2FreeUsers('r1');
    expect(G2_PAUSE_PROBE).toBe(G2_FREE_LIVE + G2_QUEUED); // outside the live and queued slices
    expect(free[G2_PAUSE_PROBE]).toBeDefined();
    expect(new Set(free).size).toBe(G2_PAUSE_PROBE + 1);
  });

  it('removal bound exceeds a housekeeping interval and ends before a waiter can vanish', () => {
    const host = defaultConfig({ qemu: '', artifactsDir: '', ticketKey: Buffer.alloc(32) });
    expect(G2_PAUSE_REMOVAL_MS).toBeGreaterThan(DEFAULT_SIM_HOUSEKEEPING_MS + host.housekeepingMs);
    expect(G2_PAUSE_REMOVAL_MS).toBeLessThan(DEFAULT_CONFIG.queue.vanishMs);
  });

  it('poll returns on the first match, fails at the deadline, rejects a late match', async () => {
    const c = clock();
    const late = await pollUntil(async () => (c.now() >= 5250 ? 0 : 9), zero, 10_000, c);
    expect(late).toEqual({ ok: true, value: 0, atMs: 5500 });
    const never = await pollUntil(async () => 9, zero, 6700, c);
    expect(never).toEqual({ ok: false, value: 9, atMs: 6700 });
    const slow = async () => (await c.sleep(2000), 0);
    expect((await pollUntil(slow, zero, 7000, c)).ok).toBe(false);
  });

  it('failed report is marked FAILED, drops unlisted fields and fakes no maximum', () => {
    const progress = {
      instance: 'tbi-s8',
      phase: 'pause',
      seconds: 40,
      admitted: [201],
      builds: [{ user: 'secret-user', sha: 'x', status: 200, ms: 5 }],
      promotedPositions: [1],
      samples: [{ freeLive: 4, hostLive: 6 }],
      token: 'secret-token',
    };
    const report = g2FailedReport(progress);
    expect(report).toMatchObject({ result: 'FAILED', failedPhase: 'pause', maxHostLive: 6 });
    expect(report.builds).toEqual([{ status: 200, ms: 5 }]);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(g2FailedReport({ ...progress, samples: [] }).maxFreeLive).toBeNull();
  });

  it('every report lists what was not covered; PASSED needs the build counts', () => {
    const p = {
      instance: 'tbi-s8',
      phase: 'clean-up',
      seconds: 1,
      admitted: [],
      builds: [],
      promotedPositions: [],
      samples: [],
      metrics: {
        buildsSucceeded: 0,
        buildsRefused: 2,
        idleStreamEnded: 1,
        heldStreamOpenMs: 400_000,
        heldStreamOk: 1,
      },
      flags: ['dec32'],
    };
    const passed = g2Report(p, 'PASSED');
    expect(passed).toMatchObject({
      result: 'PASSED',
      metrics: { buildsSucceeded: 0, buildsRefused: 2, idleStreamEnded: 1 },
      flags: ['dec32'],
      queueFullAtMaxLength: 'not_run',
      notCovered: [G2_PAID_DRILL],
    });
    expect(g2FailedReport(p).notCovered).toEqual([G2_PAID_DRILL]);
    const covered = g2Report({ ...p, paidDrill: 'passed' }, 'PASSED');
    expect([covered.queueFullAtMaxLength, covered.notCovered]).toEqual(['passed', []]);
    expect(g2FailedReport({ ...p, paidDrill: 'started' })).toMatchObject({
      queueFullAtMaxLength: 'failed',
      notCovered: [G2_PAID_DRILL],
    });
    for (const heldStreamOk of [0, undefined])
      expect(() => g2Report({ ...p, metrics: { ...p.metrics, heldStreamOk } }, 'PASSED')).toThrow(
        'held event stream',
      );
    for (const o of [{ failures: ['leftovers'] }, { paidDrill: 'started' }])
      expect(() => g2Report({ ...p, ...o }, 'PASSED')).toThrow('recorded failure');
    expect(() => g2Report({ ...p, metrics: {} }, 'PASSED')).toThrow('build counts');
    for (const o of [
      { idleStreamEnded: 0 },
      { idleStreamEnded: undefined },
      { heldStreamOpenMs: NaN },
      { heldStreamOpenMs: Infinity },
      { heldStreamOpenMs: 0 },
      { heldStreamOpenMs: 302_000 }, // the idle limit plus its tolerance: not past it yet
    ])
      expect(() => g2Report({ ...p, metrics: { ...p.metrics, ...o } }, 'PASSED')).toThrow(
        'open event stream',
      );
    const codes = ['load_above_2x_cpus', 'sampler_blind'];
    expect(g2FailedReport({ ...p, failures: codes }).failures).toEqual(codes);
  });

  it('report keeps only allowlisted numbers and codes', () => {
    const report = g2FailedReport({
      instance: 'tbi-s8',
      phase: 'idle',
      seconds: 1,
      admitted: [],
      builds: [],
      promotedPositions: [],
      samples: [],
      autostop: 'mem',
      metrics: { minMemAvailableMiB: 250, idleEndMs: NaN, secretTicket: 1, journalBad: 'secret' },
      flags: ['dec32', 'secret-flag'],
      failures: ['mem_below_400', '/home/secret'],
    });
    expect(report).toMatchObject({
      reason: 'autostop:mem',
      metrics: { minMemAvailableMiB: 250 },
      flags: ['dec32'],
      failures: ['mem_below_400'],
    });
    expect(Object.keys(report.metrics)).toEqual(['minMemAvailableMiB']);
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});
