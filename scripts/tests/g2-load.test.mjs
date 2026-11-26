/** Offline unit tests of the BETA-G2 load harness logic (runtime/tests/g2-load.ts). Fake clock, no host. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../runtime/plans/config.ts';
import { encodeLine } from '../../runtime/plans/store.ts';
import * as L from '../../runtime/tests/g2-load.ts';

const MiB = 1024;
const good = {
  availMiB: 2000,
  load1: 1,
  nproc: 4,
  units: [
    { current: 100, max: 1000, peak: 200, oomKill: 0 },
    { current: 100, max: 1000, peak: null, oomKill: 0 },
  ],
  kernelOom: 0,
  qemuUnits: 0,
};
const unit = (o) => [{ ...good.units[0], ...o }, good.units[1]];
/** feeds samples 5 s apart; returns the breach of each */
const feed = (list, state = L.g2WatchState()) =>
  list.map((s, i) => L.g2Evaluate(state, s && { ...good, ...s }, i * 5000));

describe('auto-stop thresholds', () => {
  it('memory: two consecutive samples below 300 MiB abort; one does not', () => {
    expect(feed([{ availMiB: 299 }, {}, { availMiB: 299 }])).toEqual([null, null, null]);
    expect(feed([{ availMiB: 299 }, { availMiB: 100 }])).toEqual([null, 'mem']);
  });
  it('memory below 400 MiB is recorded (fail criterion) without abort', () => {
    const s = L.g2WatchState();
    expect(feed([{ availMiB: 399 }, { availMiB: 350 }, { availMiB: 900 }], s)).toEqual([
      null,
      null,
      null,
    ]);
    expect(s.minAvailMiB).toBe(350);
  });
  it('load above 2 x CPUs aborts only after 60 s in a row', () => {
    const high = Array(13).fill({ load1: 8.1 });
    expect(feed(high)).toEqual([...Array(12).fill(null), 'load']);
    expect(feed([...high.slice(0, 11), { load1: 8 }, ...high.slice(0, 5)]).every((b) => !b)).toBe(
      true,
    );
  });
  it('unit memory at 90 % of MemoryMax aborts', () => {
    expect(feed([{ units: unit({ current: 899 }) }])).toEqual([null]);
    expect(feed([{ units: unit({ current: 900 }) }])).toEqual(['unit_mem']);
  });
  it('a NEW oom_kill (against the first sample) or a kernel OOM line aborts', () => {
    expect(feed([{ units: unit({ oomKill: 3 }) }, { units: unit({ oomKill: 3 }) }])).toEqual([
      null,
      null,
    ]);
    expect(feed([{}, { units: unit({ oomKill: 1 }) }])).toEqual([null, 'oom_kill']);
    expect(feed([{ kernelOom: 1 }])).toEqual(['oom_kernel']);
  });
  it('fails closed after consecutive sampler failures; a good sample resets the count', () => {
    expect(feed([null, null, {}, null, null])).toEqual([null, null, null, null, null]);
    expect(feed([null, null, null])).toEqual([null, null, 'sampler']);
  });
});

describe('sampling commands', () => {
  const out = {
    meminfo: `MemTotal: 8000000 kB\nMemAvailable: ${500 * MiB} kB\n`,
    loadavg: '1.50 1.00 0.50 1/100 5\n',
    nproc: '4\n',
    show: 'MemoryCurrent=100\nMemoryPeak=[not set]\nMemoryMax=536870912\n',
    events: 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 2\n',
    kernel: 'usb 1-1: new device\nOut of memory: Killed process 5 (qemu)\n',
    list: `tbi-s8-qemu@${'a'.repeat(32)}.service loaded active running x\n`,
  };
  const answer = (argv) => {
    const j = argv.join(' ');
    const key = j.includes('meminfo')
      ? 'meminfo'
      : j.includes('loadavg')
        ? 'loadavg'
        : j === 'nproc'
          ? 'nproc'
          : j.includes('memory.events')
            ? 'events'
            : argv[0] === 'journalctl'
              ? 'kernel'
              : argv[1] === 'show'
                ? 'show'
                : 'list';
    return { status: 0, stdout: out[key] };
  };
  it('runs only the read-only allowlist and parses it', () => {
    const seen = [];
    const r = L.g2TakeSample((argv) => (seen.push(argv), answer(argv)), 1700000000);
    expect(r.exit).toBe(0);
    expect(r.sample).toMatchObject({
      availMiB: 500,
      load1: 1.5,
      nproc: 4,
      kernelOom: 1,
      qemuUnits: 1,
    });
    expect(r.sample.units[0]).toEqual({ current: 100, max: 536870912, peak: null, oomKill: 2 });
    for (const a of seen) {
      expect(['cat', 'nproc', 'systemctl', 'journalctl']).toContain(a[0]);
      if (a[0] === 'systemctl') expect(['show', 'list-units']).toContain(a[1]);
    }
  });
  it('a failed or unparsable command gives no sample, only an exit code', () => {
    expect(L.g2TakeSample(() => ({ status: 1, stdout: '' }), 1)).toEqual({ sample: null, exit: 1 });
    expect(L.g2TakeSample(() => ({ status: null, stdout: '' }), 1).exit).toBe(-1);
    const noMax = (a) =>
      a[1] === 'show' ? { status: 0, stdout: 'MemoryCurrent=[not set]\n' } : answer(a);
    expect(L.g2TakeSample(noMax, 1).sample).toBeNull();
  });
});

describe('drill verdicts', () => {
  it('identity plan: queue_full needs live + promoted + maxFree + 1 Free, within the budget', () => {
    expect(L.g2IdentityPlan(16)).toEqual({ free: 22, queueFull: true });
    expect(L.g2IdentityPlan(23)).toEqual({ free: 15, queueFull: false });
    expect(L.g2IdentityPlan(22)).toEqual({ free: 28, queueFull: true });
  });
  it('start rate matches the beta policy and refuses the 21st start in 10 min', () => {
    const p = JSON.parse(
      readFileSync(new URL('../../deploy/dev-lab/s8/policy.beta.json', import.meta.url)),
    );
    for (const id of ['free', 'preview'])
      expect(p.plans[id].runtime.creations).toEqual(L.G2_START_RATE);
    const h = Array(19).fill(0);
    expect(L.g2MayStart(h, 1)).toBe(true);
    expect(L.g2MayStart([...h, 0], 1)).toBe(false);
    expect(L.g2MayStart([...h, 0], 600_000)).toBe(true);
  });
  it('queue config must fit the phase budgets', () => {
    expect(L.g2QueueProblem(DEFAULT_CONFIG.queue)).toBeNull();
    for (const o of [{ maxWaitMs: 600_001 }, { vanishMs: 30_001 }, { freeSlotCap: 6 }])
      expect(L.g2QueueProblem({ ...DEFAULT_CONFIG.queue, ...o })).toBeTruthy();
  });
  it('baseline refuses anything not clean', () => {
    const h = { live: 0, max: 6, waiting: 0, metered: 0, freePaused: false };
    expect(L.g2Baseline(h, false, false)).toEqual([]);
    for (const o of [
      { live: 1 },
      { waiting: 1 },
      { waiting: undefined },
      { metered: 1 },
      { freePaused: true },
      { freePaused: undefined },
      { max: 4 },
    ])
      expect(L.g2Baseline({ ...h, ...o }, false, false)).toHaveLength(1);
    expect(L.g2Baseline(h, true, false)).toHaveLength(1);
    expect(L.g2Baseline(h, false, true)).toHaveLength(1);
  });
  it('idle end within idleMs +/- 2 s', () => {
    expect([297_999, 298_000, 302_000, 302_001].map(L.g2IdleOnTime)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
  it('queue_timeout: only a real timeout inside the window counts (not an early vanish)', () => {
    const r = (ms, error = 'queue_timeout', status = 429) =>
      L.g2TimeoutOk({ status, error, ms }, 600_000, 15);
    expect([r(599_000), r(660_000)]).toEqual([true, true]);
    expect([r(40_000), r(660_001), r(600_000, 'queue_full'), r(600_000, undefined, 201)]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
  it('build outcome: success or explicit refusal within the cap, otherwise lost or failed', () => {
    const o = (x) => L.g2BuildOutcome({ http: 202, ms: 1000, ...x });
    expect(o({ state: 'succeeded' })).toBe('succeeded');
    expect(o({ state: 'failed', failure: 'capacity_timeout', ms: 601_000 })).toBe('refused');
    expect(o({ http: 429, error: 'builder_busy' })).toBe('refused');
    expect(o({ http: 500, error: 'x' })).toBe('failed');
    expect(o({ state: 'failed', failure: 'internal' })).toBe('failed');
    expect(o({ state: 'queued' })).toBe('lost');
    expect(o({ state: 'succeeded', ms: L.G2_BUILD_CAP_MS + 1 })).toBe('lost');
  });
});

describe('G7 counts', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(32));
  const ev = (t, sessionId) => encodeLine({ t, sessionId });
  it('wants exactly one sim_open and one sim_close per own id; others are ignored', () => {
    const text = [ev('sim_open', a), ev('sim_close', a), ev('sim_open', c)].join('');
    expect(L.g2JournalCount(text, [a])).toEqual({ own: 1, bad: 0, unparsable: 0 });
    const twice = text + ev('sim_close', a) + ev('sim_open', b) + 'garbage\n';
    expect(L.g2JournalCount(twice, [a, b])).toEqual({ own: 2, bad: 2, unparsable: 1 });
  });
  it('splits own and foreign leftover units and directories', () => {
    expect(
      L.g2Leftovers(
        `tbi-s8-qemu@${a}.service loaded\ntbi-s8-qemu@${b}.service loaded\n`,
        `s-${b}\ns-${c}\n`,
        [a],
      ),
    ).toEqual({ units: 1, otherUnits: 1, dirs: 0, otherDirs: 2 });
  });
  it('counts leaked secrets without returning them', () => {
    expect(L.g2Leaks(['x tok1 y', 'z'], ['tok1', 'tok2', ''])).toBe(1);
  });
  it('the test timeout covers every phase budget', () => {
    const sum = Object.values(L.G2_BUDGET_S).reduce((x, y) => x + y, 0);
    expect(L.g2TimeoutMs(1500)).toBeGreaterThan((sum + 1500) * 1000);
    expect(L.G2_HOLD_LIFETIME_MS).toBeGreaterThan(
      (L.G2_BUDGET_S.idle + L.G2_BUDGET_S.queueFull + L.G2_BUDGET_S.abandon + L.G2_BUDGET_S.hold) *
        1000,
    );
    expect(L.G2_HOLD_LIFETIME_MS).toBeLessThanOrEqual(1_800_000);
  });
});
