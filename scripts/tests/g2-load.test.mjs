/** Offline unit tests of the BETA-G2 load harness logic (runtime/tests/g2-load.ts). Fake clock, no host. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../runtime/plans/config.ts';
import { encodeLine } from '../../runtime/plans/store.ts';
import * as L from '../../runtime/tests/g2-load.ts';

const MiB = 1024;
const good = {
  availMiB: 2000,
  load1: 1,
  nproc: 4,
  units: [
    { current: 100, workingSet: 100, max: 1000, peak: 200, oomKill: 0 },
    { current: 100, workingSet: 100, max: 1000, peak: null, oomKill: 0 },
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
  it('load1 above 2 x CPUs for 60 s is a recorded FAIL criterion and never aborts by itself', () => {
    const s = L.g2WatchState();
    expect(feed(Array(12).fill({ load1: 8.1 }), s).every((b) => !b)).toBe(true);
    expect(s.loadFail).toBe(false); // 55 s
    expect(feed(Array(13).fill({ load1: 8.1 }), s).every((b) => !b)).toBe(true);
    expect(s.loadFail).toBe(true);
    const long = L.g2WatchState();
    expect(feed(Array(40).fill({ load1: 16 }), long).every((b) => !b)).toBe(true);
    const broken = L.g2WatchState();
    feed(
      [...Array(11).fill({ load1: 8.1 }), { load1: 8 }, ...Array(5).fill({ load1: 8.1 })],
      broken,
    );
    expect(broken.loadFail).toBe(false);
  });
  it('load aborts only above max(4 x CPUs, 12) for 60 s in a row', () => {
    for (const [nproc, limit] of [
      [1, 12],
      [4, 16],
    ]) {
      const at = Array(20).fill({ nproc, load1: limit });
      expect(feed(at).every((b) => !b)).toBe(true);
      const over = Array(13).fill({ nproc, load1: limit + 0.1 });
      expect(feed(over)).toEqual([...Array(12).fill(null), 'load']);
      expect(feed([...over.slice(0, 11), at[0], ...over.slice(0, 5)]).every((b) => !b)).toBe(true);
    }
  });
  it('unit memory at 90 % of MemoryMax aborts on the working set; page cache does not', () => {
    const s = L.g2WatchState();
    expect(feed([{ units: unit({ current: 999, workingSet: 899 }) }], s)).toEqual([null]);
    expect(s).toMatchObject({ maxUnitRatio: 0.899, maxUnitCurrentRatio: 0.999 });
    expect(feed([{ units: unit({ workingSet: 900 }) }])).toEqual(['unit_mem']);
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
  it('a run is blind when more than 10 % of at least 20 samples failed', () => {
    const blind = (samples, failures) => L.g2SamplerBlind({ samples, failures });
    expect([blind(18, 2), blind(17, 3), blind(90, 10), blind(89, 11)]).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(blind(10, 9)).toBe(false); // below the minimum count: 3 in a row still aborts
  });
  it('only exit 0 holds the lock; a refusal is lost, no exit code is unknown', () => {
    expect([0, 75, 70, 64, 1, null].map(L.g2LockState)).toEqual([
      'held',
      'lost',
      'lost',
      'lost',
      'lost',
      'unknown',
    ]);
    expect(L.G2_AUTOSTOPS).toContain('lock');
  });
  it('an unknown lock is counted apart from samples; 3 in a row stop the run, lost at once', () => {
    const s = L.g2WatchState();
    const run = ['unknown', 'unknown', 'held', 'unknown', 'unknown', 'unknown'];
    expect(run.map((l) => L.g2LockBreach(s, l))).toEqual([null, null, null, null, null, 'lock']);
    expect([s.lockUnknown, s.failures, L.g2LockBreach(s, 'lost')]).toEqual([5, 0, 'lock']);
  });
  it('the largest gap between good samples is bounded by 3 intervals plus the tick deadline', () => {
    const s = L.g2WatchState();
    for (const [x, at] of [
      [good, 0],
      [null, 20_000],
      [good, 30_000],
      [good, 35_000],
    ])
      L.g2Evaluate(s, x, at);
    expect([s.maxGapMs, L.G2_LIMITS.tickDeadlineMs, L.G2_MAX_GAP_MS]).toEqual([
      30_000, 15_000, 30_000,
    ]);
    expect(L.G2_MAX_GAP_MS).toBeGreaterThan(L.G2_LIMITS.sampleMs + L.G2_LIMITS.tickDeadlineMs);
  });
  it('the sampler loop never overlaps and stop() waits for the sample in flight', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let started = 0;
      let release;
      const loop = L.g2Loop(
        async () => {
          expect(++active).toBe(1);
          started++;
          await new Promise((r) => (release = r));
          active--;
        },
        5000,
        () => {},
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(started).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toBe(2); // overdue: the next one starts at once, still alone
      let stopped = false;
      const done = loop.stop().then(() => (stopped = true));
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(false);
      release();
      await done;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(started).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sampling commands', () => {
  const out = {
    meminfo: `MemTotal: 8000000 kB\nMemAvailable: ${500 * MiB} kB\n`,
    loadavg: '1.50 1.00 0.50 1/100 5\n',
    nproc: '4\n',
    show: 'MemoryCurrent=100\nMemoryPeak=[not set]\nMemoryMax=536870912\n',
    stat: 'anon 40\nfile 900\nkernel 5\nshmem 3\ninactive_file 800\n',
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
          : j.includes('memory.stat')
            ? 'stat'
            : j.includes('memory.events')
              ? 'events'
              : argv[0] === 'journalctl'
                ? 'kernel'
                : argv[1] === 'show'
                  ? 'show'
                  : 'list';
    return { status: 0, stdout: out[key] };
  };
  it('runs only the read-only allowlist and parses it', async () => {
    const seen = [];
    const run = async (argv) => (seen.push(argv), answer(argv));
    const r = await L.g2TakeSample(run, 1700000000);
    expect(r.exit).toBe(0);
    expect(r.sample).toMatchObject({
      availMiB: 500,
      load1: 1.5,
      nproc: 4,
      kernelOom: 1,
      qemuUnits: 1,
    });
    expect(r.sample.units[0]).toEqual({
      current: 100,
      workingSet: 48,
      max: 536870912,
      peak: null,
      oomKill: 2,
    });
    expect(seen).toContainEqual([
      'cat',
      '/sys/fs/cgroup/system.slice/tbi-s8-build.service/memory.stat',
    ]);
    expect(seen.find((a) => a[0] === 'journalctl')).toContain('@1700000000');
    for (const a of seen) {
      expect(['cat', 'nproc', 'systemctl', 'journalctl']).toContain(a[0]);
      if (a[0] === 'systemctl') expect(['show', 'list-units']).toContain(a[1]);
    }
  });
  it('a failed or unparsable command gives no sample, only an exit code', async () => {
    const dead = (status) => async () => ({ status, stdout: '' });
    expect(await L.g2TakeSample(dead(1), 1)).toEqual({ sample: null, exit: 1 });
    expect((await L.g2TakeSample(dead(null), 1)).exit).toBe(-1);
    const noMax = async (a) =>
      a[1] === 'show' ? { status: 0, stdout: 'MemoryCurrent=[not set]\n' } : answer(a);
    expect((await L.g2TakeSample(noMax, 1)).sample).toBeNull();
  });
  it('one deadline per tick: a miss is a failed sample, aborted, never overlapped or leaked', async () => {
    vi.useFakeTimers();
    try {
      const calls = [];
      let fail;
      const tick = L.g2Ticker(
        async () => 0,
        (argv, signal) => (calls.push(signal), new Promise((_, reject) => (fail = reject))),
      );
      let got;
      void tick(1).then((r) => (got = r));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(got).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(got).toEqual({ lock: 'held', sample: null, exit: -1 });
      expect(calls[0].aborted).toBe(true);
      // the older command has not ended: nothing new is started
      expect(await tick(1)).toEqual({ lock: 'unknown', sample: null, exit: -1 });
      expect(calls).toHaveLength(1);
      fail(new Error('late')); // handled: vitest fails the run on an unhandled rejection
      await vi.advanceTimersByTimeAsync(1);
      void tick(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('a lock check that fails or hangs does not discard a good resource sample', async () => {
    vi.useFakeTimers();
    try {
      for (const lock of [() => Promise.reject(new Error('x')), () => new Promise(() => {})]) {
        const p = L.g2Ticker(lock, async (a) => answer(a))(1);
        await vi.advanceTimersByTimeAsync(15_000);
        const r = await p;
        expect([r.lock, r.sample?.nproc]).toEqual(['unknown', 4]);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it('an unreadable or incomplete memory.stat is a failed sample', async () => {
    for (const stat of [
      { status: 1, stdout: '' },
      { status: 0, stdout: 'anon 4\nfile 9\n' },
    ]) {
      const run = async (a) => (a[1]?.endsWith('memory.stat') ? stat : answer(a));
      expect((await L.g2TakeSample(run, 1)).sample).toBeNull();
    }
  });
});

describe('drill verdicts', () => {
  it('identity plan: queue_full needs live + promoted + maxFree + 1 Free, within the budget', () => {
    expect(L.g2IdentityPlan(16)).toEqual({ free: 22, queueFull: true });
    expect(L.g2IdentityPlan(23)).toEqual({ free: 15, queueFull: false });
    expect(L.g2IdentityPlan(22)).toEqual({ free: 28, queueFull: true });
  });
  it('paid queue_full: maxLength - maxFree + 1 extra payers, else not run with the number needed', () => {
    const q = DEFAULT_CONFIG.queue; // 20 and 16
    expect(L.g2PaidPlan(q, 5)).toEqual({ needed: 5, reason: null });
    for (const given of [0, 4])
      expect(L.g2PaidPlan(q, given)).toEqual({
        needed: 5,
        reason: `needs 5 extra paying identities, ${given} given`,
      });
    expect(L.g2PaidPlan({ maxLength: 22, maxFree: 16 }, 9).reason).toMatch(/needs 7 .*budget/);
    expect(L.g2PaidPlan({ maxLength: 30, maxFree: 23 }, 9).reason).toMatch(/Free share/);
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
    for (const error of ['builder_busy', 'memory_pressure', 'storage_pressure'])
      expect(o({ http: 503, error })).toBe('refused');
    for (const error of ['rate_limited', 'build_quota', 'build_cooldown'])
      expect(o({ http: 429, error })).toBe('failed');
    expect(o({ http: 500, error: 'x' })).toBe('failed');
    expect(o({ state: 'failed', failure: 'internal' })).toBe('failed');
    expect(o({ state: 'queued' })).toBe('lost');
    expect(o({ state: 'succeeded', ms: L.G2_BUILD_CAP_MS + 1 })).toBe('lost');
  });
});

describe('idle with an open event stream', () => {
  /** an SSE body the test writes to, split at arbitrary points like a network would */
  const tab = () => {
    let c;
    const body = new ReadableStream({ start: (x) => void (c = x) });
    const enc = new TextEncoder();
    const clock = { ms: 42 };
    return {
      ...L.g2FollowStream(body, () => clock.ms),
      clock,
      send: (text) => c.enqueue(enc.encode(text)),
      end: () => c.close(),
      cut: () => c.error(new Error('cut')),
    };
  };
  const frame = (e) => `id: 1\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  const ended = frame({ type: 'state', state: 'ended', reason: 'idle_timeout' });
  const past = L.G2_IDLE_MS + L.G2_IDLE_TOLERANCE_MS + 1;

  it('the silent tab passes only when its stream delivers idle_timeout, across chunk borders', async () => {
    const t = tab();
    t.send(`: keepalive\n\n${frame({ type: 'state', state: 'running' })}${ended.slice(0, 40)}`);
    t.send(ended.slice(40));
    t.end();
    await t.done;
    expect(t.state).toEqual({ endReason: 'idle_timeout', lastChunkAtMs: 42, closedAtMs: 42 });
    expect(L.g2IdleStreamOk(t.state)).toBe(true);
  });
  it('a stream closed or cut before the end, or another end reason, fails', async () => {
    for (const finish of ['end', 'cut']) {
      const t = tab();
      t.send(frame({ type: 'state', state: 'running' }));
      t[finish]();
      await t.done;
      expect(L.g2IdleStreamOk(t.state)).toBe(false);
      expect(L.g2HeldStreamOk(t.state, past, 42)).toBe(false);
    }
    const t = tab();
    t.send(frame({ type: 'state', state: 'ended', reason: 'lease_expired' }));
    t.end();
    await t.done;
    expect(L.g2IdleStreamOk(t.state)).toBe(false);
  });
  it('the present tab passes only while still open, longer than the idle limit', async () => {
    const t = tab();
    t.send(frame({ type: 'state', state: 'running' }));
    await vi.waitFor(() => expect(t.state.lastChunkAtMs).toBe(42));
    expect(L.g2HeldStreamOk(t.state, past, 42)).toBe(true);
    expect(L.g2HeldStreamOk(t.state, past - 1, 42)).toBe(false);
    t.send(ended);
    await vi.waitFor(() => expect(t.state.endReason).toBe('idle_timeout'));
    expect(L.g2HeldStreamOk(t.state, past, 42)).toBe(false);
    t.end();
    await t.done;
  });
  it('a stream that goes quiet without closing fails; a keepalive counts as a sign of life', async () => {
    const quiet = 2 * L.G2_KEEPALIVE_MS;
    const t = tab();
    expect(L.g2HeldStreamOk(t.state, past, 42)).toBe(false); // nothing was ever received
    t.send(frame({ type: 'state', state: 'running' }));
    await vi.waitFor(() => expect(t.state.lastChunkAtMs).toBe(42));
    expect(L.g2HeldStreamOk(t.state, past, 42 + quiet)).toBe(true);
    expect(L.g2HeldStreamOk(t.state, past, 42 + quiet + 1)).toBe(false);
    expect(t.state.closedAtMs).toBeUndefined();
    t.clock.ms = 100_000;
    t.send(': keepalive\n\n');
    await vi.waitFor(() => expect(t.state.lastChunkAtMs).toBe(100_000));
    expect(L.g2HeldStreamOk(t.state, past, 100_000 + quiet)).toBe(true);
    t.end();
    await t.done;
  });
  it('the keepalive interval is the one of the host', () => {
    const http = readFileSync(new URL('../../runtime/host/http.ts', import.meta.url), 'utf8');
    const ms = /^const KEEPALIVE_MS = ([\d_]+);$/m.exec(http)?.[1];
    expect(Number(ms?.replaceAll('_', ''))).toBe(L.G2_KEEPALIVE_MS);
  });
});

describe('G4 summary', () => {
  const sum = (...x) => L.g2BuildSummary(x.map(([outcome, ms]) => ({ outcome, ms })));
  it('counts outcomes; failed or lost builds fail the criterion', () => {
    expect(sum(['succeeded', 5], ['refused', 6])).toEqual({
      metrics: {
        build1WaitMs: 5,
        build2WaitMs: 6,
        buildsSucceeded: 1,
        buildsRefused: 1,
        buildsFailed: 0,
        buildsLost: 0,
      },
      dec32: false,
      failed: false,
    });
    expect(sum(['succeeded', 5], ['failed', 6]).failed).toBe(true);
    expect(sum(['succeeded', 5], ['lost', 6]).failed).toBe(true);
  });
  it('flags dec32 on a long wait or when no build succeeded', () => {
    expect(sum(['succeeded', 120_001], ['succeeded', 1]).dec32).toBe(true);
    expect(sum(['refused', 5], ['refused', 6])).toMatchObject({
      metrics: { buildsSucceeded: 0 },
      dec32: true,
      failed: false,
    });
  });
});

describe('waiting line keep-alive', () => {
  const setup = () => {
    let now = 0;
    const polled = [];
    const line = L.g2WaitingLine(
      async (w) => (polled.push(w), w === 'gone' ? 429 : 202),
      () => now,
    );
    return { line, polled, at: (t) => (now = t) };
  };
  it('polls only due waiters, oldest first, and never a removed one', async () => {
    const { line, polled, at } = setup();
    line.add('a');
    at(4000);
    line.add('b');
    at(8000);
    line.add('c');
    await line.keep(10_000);
    expect(polled).toEqual([]);
    at(14_000);
    await line.keep(10_000);
    expect(polled).toEqual(['a', 'b']);
    expect(line.oldestSeenAt()).toBe(8000);
    line.remove('c');
    await line.keep(0);
    expect(polled).toEqual(['a', 'b', 'a', 'b']);
  });
  it('a waiter that is no longer queued is an explicit failure', async () => {
    const { line } = setup();
    line.add('gone');
    await expect(line.keep(0)).rejects.toThrow('429');
  });
  it('the keep interval leaves room before a waiter vanishes', () => {
    expect(L.G2_KEEP_MS).toBeLessThanOrEqual(DEFAULT_CONFIG.queue.vanishMs / 3);
  });
});

describe('root relay', () => {
  it('forwards to the socket and exits when its stdin closes (parent gone)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g2-relay-'));
    const socket = join(dir, 's');
    const server = createServer((c) => c.end('hi'));
    await new Promise((r) => server.listen(socket, r));
    const probe = createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address();
    await new Promise((r) => probe.close(r));
    const child = spawn(process.execPath, ['-e', L.g2RelayCode(socket, port)], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      await new Promise((r) => child.stdout.once('data', r));
      expect(L.g2Running(child)).toBe(true);
      const exit = new Promise((r) => child.once('exit', r));
      child.stdin.end();
      expect(await exit).toBe(0);
      expect(L.g2Running(child)).toBe(false);
      expect(L.g2Running({ exitCode: null, signalCode: 'SIGTERM' })).toBe(false);
    } finally {
      child.kill();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
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
