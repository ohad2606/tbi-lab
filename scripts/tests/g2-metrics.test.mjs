/** Offline unit tests of the Capacity A1 measurements (runtime/tests/g2-metrics.ts). Fake files and clock. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { g2Decision, g2Report } from '../../runtime/tests/g2-guard.ts';
import * as M from '../../runtime/tests/g2-metrics.ts';

const files = (dir, { usec = 1000, throttled = 0, anon = 100 } = {}) => ({
  [`${dir}/cpu.stat`]: `usage_usec ${usec}\nuser_usec 1\nnr_periods 9\nnr_throttled ${throttled}\n`,
  [`${dir}/memory.current`]: '5000\n',
  [`${dir}/memory.stat`]: `anon ${anon}\nfile 70\nkernel_stack 9\nkernel 30\nfile_mapped 1\nshmem 20\n`,
  [`${dir}/memory.peak`]: '6000\n',
});
const fsOf = (map, dirs = {}) => ({
  readFile: async (p) => {
    if (!(p in map)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return map[p];
  },
  readdir: async (p) => {
    if (!(p in dirs)) throw new Error('ENOENT');
    return dirs[p];
  },
});
/** a reading every second; `coresAt(second)` is the load of the second ending there */
const series = (seconds, coresAt, over = {}) => {
  let usec = 0;
  return Array.from({ length: seconds }, (_, i) => {
    const s = i + 1;
    usec += coresAt(s) * 1e6;
    return {
      atMs: s * 1000,
      usageUsec: usec,
      nrThrottled: s,
      current: 1000 + s,
      anon: 100,
      file: 7,
      shmem: 20,
      kernel: 30,
      peak: 2000,
      ...over,
    };
  });
};

describe('cgroup and /proc parsing', () => {
  it('reads the exact fields (kernel, not kernel_stack; file, not file_mapped)', async () => {
    const r = await M.g2A1ReadCgroup(fsOf(files('/c', { usec: 42, throttled: 3 })), '/c', 5);
    expect(r).toEqual({
      atMs: 5,
      usageUsec: 42,
      nrThrottled: 3,
      current: 5000,
      anon: 100,
      file: 70,
      shmem: 20,
      kernel: 30,
      peak: 6000,
    });
  });
  it('an unreadable or unparsable file is null and reported, never zero', async () => {
    const map = files('/c');
    delete map['/c/cpu.stat'];
    map['/c/memory.current'] = 'max\n';
    delete map['/c/memory.peak'];
    const missing = [];
    const r = await M.g2A1ReadCgroup(fsOf(map), '/c', 0, (f) => missing.push(f));
    expect([r.usageUsec, r.nrThrottled, r.current, r.peak, r.anon]).toEqual([
      null,
      null,
      null,
      null,
      100,
    ]);
    expect(missing.sort()).toEqual(['cpu.stat', 'memory.peak']);
  });
  it('/proc/stat: busy excludes idle, iowait and steal; guest is not counted twice', () => {
    const stat = 'cpu  10 1 5 100 4 2 3 7 9 0\ncpu0 1 1 1 1\ncpu1 1 1 1 1\nintr 5\n';
    expect(M.g2A1ProcStat(stat)).toEqual({ cpus: 2, total: 132, busy: 21, steal: 7 });
    expect(M.g2A1ProcStat('intr 5\n')).toBeNull();
  });
  it('host settings from the unit environment; unset is null', () => {
    const env = 'Environment=TBI_HOST_PACE=1 X=/a "TBI_HOST_IDLE_MS=300000" Y=2\n';
    expect(M.g2A1HostConfig(env)).toEqual({ pace: 1, idleMs: 300000, maxSessions: null });
    expect(M.g2A1HostConfig('Environment=TBI_HOST_MAX_SESSIONS=6').maxSessions).toBe(6);
  });
  it('staging paths of the template slices', () => {
    expect(M.G2_A1_QEMU_SLICE).toBe('/sys/fs/cgroup/system.slice/system-tbi\\x2ds8\\x2dqemu.slice');
    expect(M.G2_A1_UNITS.buildJobs).toContain('system-tbi\\x2ds8\\x2dbuild\\x2djob.slice');
  });
});

describe('per run and per type', () => {
  it('the steady window excludes start-up', () => {
    // 1 core for the first 25 s, then 0.25
    const r = M.g2A1Run(
      'delay',
      'solo',
      0,
      series(100, (s) => (s <= 25 ? 1 : 0.25)),
    );
    expect(r.steadyCores).toBe(0.25);
    expect(r.steadySeconds).toBe(75);
    expect(r.startupCores).toBe(1);
    expect(r.startupCpuSeconds).toBe(25);
    expect([r.steadyThrottled, r.throttledTotal]).toEqual([75, 100]);
    expect([r.memoryPeakBytes, r.memoryCurrentMaxBytes, r.workingSetMaxBytes]).toEqual([
      2000, 1100, 150,
    ]);
  });
  it('no steady value for a run that ended early, or without a readable counter', () => {
    const short = M.g2A1Run(
      'busy',
      'solo',
      0,
      series(30, () => 1),
    );
    expect([short.steadyCores, short.steadySeconds, short.steadyThrottled]).toEqual([
      null,
      null,
      null,
    ]);
    expect(short.startupCores).toBe(1);
    const blind = M.g2A1Run(
      'busy',
      'solo',
      0,
      series(100, () => 1, { usageUsec: null, anon: null, peak: null }),
    );
    expect([
      blind.steadyCores,
      blind.startupCores,
      blind.startupCpuSeconds,
      blind.workingSetMaxBytes,
    ]).toEqual([null, null, null, null]);
    expect(blind.memoryPeakBytes).toBeNull();
    expect(M.g2A1Run('busy', 'solo', 0, []).memoryCurrentMaxBytes).toBeNull();
  });
  it('readings after the unit is gone are ignored; a counter going backwards gives no value', () => {
    const gone = { ...series(1, () => 0)[0], atMs: 200_000 };
    for (const k of Object.keys(gone)) if (k !== 'atMs') gone[k] = null;
    expect(M.g2A1Run('busy', 'solo', 0, [...series(60, () => 1), gone]).samples).toBe(60);
    const back = [...series(60, () => 1), { ...series(1, () => 1)[0], atMs: 61_000 }];
    expect(M.g2A1Run('busy', 'solo', 0, back).steadyCores).toBeNull();
  });
  it('groups by round and type and keeps unknown runs out of the statistics', () => {
    const run = (type, c) =>
      M.g2A1Run(
        type,
        'mix6',
        0,
        series(100, () => c),
      );
    const by = M.g2A1ByType([
      run('delay', 0.2),
      run('busy', 1),
      run('delay', 0.4),
      M.g2A1Run('delay', 'mix6', 0, []),
    ]);
    expect(by.map((g) => [g.type, g.runs, g.runsWithSteady])).toEqual([
      ['delay', 3, 2],
      ['busy', 1, 1],
    ]);
    expect(by[0].steadyCores).toEqual({ min: 0.2, median: 0.3, max: 0.4 });
    expect(by[0].simPerWall).toBeNull();
  });
});

describe('recorder', () => {
  const id = 'a'.repeat(32);
  const unit = `${M.G2_A1_QEMU_SLICE}/tbi-s8-qemu@${id}.service`;
  const other = `tbi-s8-qemu@${'b'.repeat(32)}.service`;

  it('samples only own runs and shared units, per phase, without session ids in the report', async () => {
    let now = 0;
    let phase = 'a1';
    const map = {};
    const rec = M.g2A1Recorder(
      fsOf(map, { [M.G2_A1_QEMU_SLICE]: [`tbi-s8-qemu@${id}.service`, other, 'cpu.stat'] }),
      () => now,
      () => phase,
    );
    rec.addRun(id, 'busy', 'solo');
    for (let s = 1; s <= 40; s++) {
      now = s * 1000;
      Object.assign(map, files(unit, { usec: s * 1e6 }));
      Object.assign(map, files(M.G2_A1_UNITS.host, { usec: s * 1e5 }));
      map['/proc/stat'] =
        `cpu  ${s * 100} 0 0 ${s * 300} 0 0 0 0\ncpu0 1\ncpu1 1\ncpu2 1\ncpu3 1\n`;
      await rec.tick();
    }
    phase = 'clean-up';
    rec.pace(id, { simPerWall: 0.99, tickGapP99Ms: 4, endReason: 'lifetime' });
    const report = rec.report();
    expect(report.runs).toHaveLength(1);
    expect(report.byType[0]).toMatchObject({ type: 'busy', round: 'solo', runs: 1 });
    expect(report.runs[0]).toMatchObject({ steadyCores: 1, simPerWall: 0.99 });
    expect(report.phases[0].host).toMatchObject({ meanCores: 0.1, maxCores: 0.1 });
    expect(report.phases[0].machine).toEqual({ busyCores: 1, stealCores: 0 });
    // the build unit was never readable
    expect(report.phases[0].build).toBeNull();
    expect(report.unavailable['build cpu.stat']).toBe(40);
    expect(report.unavailable['qemu cpu.stat']).toBeUndefined();
    expect(JSON.stringify(report)).not.toMatch(/[0-9a-f]{32}/);
  });
  it('nothing readable, or a failing reader: no throw, nulls, counted', async () => {
    for (const fs of [
      fsOf({}),
      {
        readFile: () => {
          throw new Error('sync');
        },
        readdir: () => {
          throw new Error('sync');
        },
      },
    ]) {
      const rec = M.g2A1Recorder(
        fs,
        () => 0,
        () => 'a1',
      );
      rec.addRun(id, 'delay', 'solo');
      await expect(rec.tick()).resolves.toBeUndefined();
      const report = rec.report();
      expect(report.runs[0].steadyCores).toBeNull();
      expect(report.runs[0].memoryPeakBytes).toBeNull();
      expect(Object.keys(report.unavailable).length).toBeGreaterThan(0);
      expect(report.status).toBe('not_reached');
    }
  });
});

describe('A1 follow-ups', () => {
  const tickTimes = async (rec, n, set) => {
    for (let i = 1; i <= n; i++) {
      set(i);
      await rec.tick();
    }
  };
  it.each([
    ['never listed', {}],
    [
      'listed, every file unreadable',
      { [M.G2_A1_QEMU_SLICE]: [`tbi-s8-qemu@${'a'.repeat(32)}.service`] },
    ],
  ])('a run without any reading (%s) is counted and the report is not complete', async (_, d) => {
    let at = 0;
    const rec = M.g2A1Recorder(
      fsOf({}, d),
      () => at,
      () => 'a1-mix6',
    );
    rec.addRun('a'.repeat(32), 'delay', 'mix6');
    await tickTimes(rec, 2, (i) => (at = i * 1000));
    rec.state.status = 'complete';
    const report = rec.report();
    expect(report.unavailable['qemu run without readings']).toBe(1);
    expect(report.status).toBe('incomplete');
    expect(rec.report().unavailable['qemu run without readings']).toBe(1);
  });
  it('a blind drill run is counted but does not spoil measured rounds', async () => {
    const id = 'b'.repeat(32);
    const unit = `tbi-s8-qemu@${id}.service`;
    const map = {};
    let at = 0;
    const rec = M.g2A1Recorder(
      fsOf(map, { [M.G2_A1_QEMU_SLICE]: [unit] }),
      () => at,
      () => 'a1-mix6',
    );
    rec.addRun(id, 'delay', 'mix6');
    rec.addRun('c'.repeat(32), 'gpio_proof', 'drills');
    await tickTimes(rec, 40, (s) => {
      at = s * 1000;
      Object.assign(map, files(`${M.G2_A1_QEMU_SLICE}/${unit}`, { usec: s * 1e6 }));
    });
    rec.state.status = 'complete';
    const report = rec.report();
    expect(report.unavailable['qemu run without readings']).toBe(1);
    expect(report.status).toBe('complete');
  });
  it('TBI_HOST_PACE=off is not the same as unset', () => {
    expect(M.g2A1HostConfig('Environment=TBI_HOST_PACE=off A=1\n').pace).toBe('off');
    expect(M.g2A1HostConfig('Environment=A=1 "TBI_HOST_PACE=off"\n').pace).toBe('off');
    expect(M.g2A1HostConfig('Environment=A=1\n').pace).toBeNull();
    expect(M.g2A1HostConfig('Environment=TBI_HOST_IDLE_MS=off\n').idleMs).toBeNull();
  });
  it('a counter reset in the middle of a series gives no figure, even if it ends higher', () => {
    // reset at second 40, then fast enough to end above the first value of the window
    const readings = series(100, () => 1).map((r) =>
      r.atMs < 40_000
        ? r
        : { ...r, usageUsec: r.usageUsec - 39e6, nrThrottled: r.nrThrottled - 39 },
    );
    const run = M.g2A1Run('busy', 'solo', 0, readings);
    expect(run.steadyCores).toBeNull();
    expect(run.steadySeconds).toBeNull();
    expect(run.steadyThrottled).toBeNull();
    const early = series(100, () => 1).map((r) =>
      r.atMs < 10_000 ? r : { ...r, usageUsec: r.usageUsec - 9e6 },
    );
    const second = M.g2A1Run('busy', 'solo', 0, early);
    expect(second.startupCores).toBeNull();
    expect(second.startupCpuSeconds).toBeNull();
    expect(second.steadyCores).toBe(1);
  });
});

describe('missing data cannot look complete', () => {
  const id = 'd'.repeat(32);
  const name = `tbi-s8-qemu@${id}.service`;
  const measured = async (drop, round = 'mix6') => {
    const map = {};
    let at = 0;
    const rec = M.g2A1Recorder(
      fsOf(map, { [M.G2_A1_QEMU_SLICE]: [name] }),
      () => at,
      () => 'a1-mix6',
    );
    rec.addRun(id, 'delay', round);
    for (let s = 1; s <= 40; s++) {
      at = s * 1000;
      const dir = `${M.G2_A1_QEMU_SLICE}/${name}`;
      Object.assign(map, files(dir, { usec: s * 1e6 }));
      for (const f of drop) delete map[`${dir}/${f}`];
      await rec.tick();
    }
    rec.state.status = 'complete';
    return rec.report();
  };
  it('everything readable is complete', async () => {
    const r = await measured([]);
    expect(r.status).toBe('complete');
    expect(r.unavailable['qemu run without cpu figure']).toBeUndefined();
    expect(r.unavailable['qemu run without memory figure']).toBeUndefined();
  });
  it('cpu.stat never readable: incomplete, null CPU, counted', async () => {
    const r = await measured(['cpu.stat']);
    expect(r.runs[0].steadyCores).toBeNull();
    expect(r.status).toBe('incomplete');
    expect(r.unavailable['qemu run without cpu figure']).toBe(1);
    expect(r.unavailable['qemu run without memory figure']).toBeUndefined();
  });
  it.each([[['memory.stat']], [['memory.peak']], [['memory.current']]])(
    '%s never readable: incomplete, counted',
    async (drop) => {
      const r = await measured(drop);
      expect(r.status).toBe('incomplete');
      expect(r.unavailable['qemu run without memory figure']).toBe(1);
      expect(r.unavailable['qemu run without cpu figure']).toBeUndefined();
    },
  );
  it('a drill run without figures does not judge the measured rounds', async () => {
    expect((await measured(['cpu.stat'], 'drills')).status).toBe('complete');
  });
});

describe('tick deadline', () => {
  afterEach(() => vi.useRealTimers());
  it('a hanging read ends the tick at the deadline, is counted, and others are kept', async () => {
    vi.useFakeTimers();
    const hung = `${M.G2_A1_UNITS.host}/cpu.stat`;
    const id = 'e'.repeat(32);
    const name = `tbi-s8-qemu@${id}.service`;
    const base = fsOf(
      {
        ...files(M.G2_A1_UNITS.host),
        ...files(M.G2_A1_UNITS.build),
        ...files(`${M.G2_A1_QEMU_SLICE}/${name}`),
      },
      { [M.G2_A1_QEMU_SLICE]: [name] },
    );
    let hungReads = 0;
    let at = 0;
    const rec = M.g2A1Recorder(
      {
        ...base,
        readFile: (p) => (p === hung ? (hungReads++, new Promise(() => {})) : base.readFile(p)),
      },
      () => at,
      () => 'a1-mix6',
    );
    rec.addRun(id, 'delay', 'mix6');
    for (const start of [1000, 4000]) {
      at = start;
      let done = false;
      const t = rec.tick().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(M.G2_A1_TICK_DEADLINE_MS - 1);
      // the second tick does not start the stuck read again, so it need not wait for it
      if (start === 1000) expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await t;
    }
    expect(hungReads).toBe(1);
    const r = rec.report();
    expect(r.samples).toBe(2);
    expect(r.ticksTimedOut).toBe(1);
    // starts 3 s apart at 1 Hz: two slots without a sample
    expect(r.missedTicks).toBe(2);
    expect(r.unavailable['host cpu.stat']).toBe(2);
    expect(r.runs[0].samples).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a regular 1 Hz series misses nothing', async () => {
    let at = 0;
    const rec = M.g2A1Recorder(
      fsOf({}),
      () => at,
      () => 'a1',
    );
    for (const t of [1000, 2004, 3001]) {
      at = t;
      await rec.tick();
    }
    expect(rec.report()).toMatchObject({ ticksTimedOut: 0, missedTicks: 0 });
  });
});

describe('measure() offline, end to end over a fake cgroup tree on disk', () => {
  let root;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));
  const put = (map) => {
    for (const [p, text] of Object.entries(map)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
  };
  const simulate = async ({ unreadable = [] } = {}) => {
    root = mkdtempSync(join(tmpdir(), 'g2a1-'));
    let now = 0;
    let phase = 'clean';
    const live = new Map();
    const log = [];
    const rec = M.g2A1Recorder(
      {
        readFile: (p) => readFile(join(root, p), 'utf8'),
        readdir: (p) => readdir(join(root, p)),
      },
      () => now,
      () => phase,
    );
    // neither the QEMU slice nor the build-job slice exists before its first unit
    const second = async () => {
      now += 1000;
      const s = now / 1000;
      put({ '/proc/stat': `cpu  ${s * 100} 0 0 ${s * 300} 0 0 0 0\ncpu0 1\ncpu1 1\n` });
      put(files(M.G2_A1_UNITS.host, { usec: s * 1e5 }));
      put(files(M.G2_A1_UNITS.build, { usec: s * 1e4 }));
      if (existsBuild) put(files(M.G2_A1_UNITS.buildJobs, { usec: s * 2e5 }));
      for (const [id, startedMs] of live) {
        const dir = `${M.G2_A1_QEMU_SLICE}/tbi-s8-qemu@${id}.service`;
        if (now - startedMs >= 60_000) {
          live.delete(id);
          rmSync(join(root, dir), { recursive: true, force: true });
          continue;
        }
        put(files(dir, { usec: ((now - startedMs) / 1000) * 5e5 }));
        for (const f of unreadable) rmSync(join(root, dir, f));
      }
      await rec.tick();
    };
    let existsBuild = false;
    const sleep = async (ms) => {
      for (let t = 0; t < ms; t += 1000) await second();
    };
    let n = 0;
    await M.g2A1Measure(rec, {
      runId: 'r1',
      cooldownMs: 2000,
      waitMs: 90_000,
      now: () => now,
      sleep,
      setPhase: (p) => (log.push(p), (phase = p)),
      emptySeats: async () => {
        expect(phase).toBe('a1-cooldown');
        live.clear();
        await second();
      },
      build: async (user, text) => {
        expect(phase).toBe('a1-builds');
        expect(text).toContain('// g2-a1 r1');
        existsBuild = true;
        await sleep(3000);
        return `sha-${user}-${text.includes('delay(') ? 'delay' : 'busy'}`;
      },
      create: async (user, sha, [type, round]) => {
        expect(sha).toBe(`sha-${user}-${type}`);
        const id = String(++n).padStart(32, '0');
        live.set(id, now);
        rec.addRun(id, type, round);
        return { id };
      },
      status: async ({ id }) => ({
        ended: !live.has(id),
        reason: 'lifetime',
        pace: { simPerWall: 0.9, tickGapMs: { p99: 3 } },
      }),
    });
    rec.state.status = 'complete';
    return { report: rec.report(), log };
  };

  it('produces figures for every run and phase; late slices are neither fatal nor zero', async () => {
    const { report, log } = await simulate();
    expect(log).toEqual([
      'a1-cooldown',
      'a1-builds',
      'a1-cooldown',
      'a1-delay-solo',
      'a1-cooldown',
      'a1-busy-solo',
      'a1-cooldown',
      'a1-mix6',
    ]);
    expect(report.status).toBe('complete');
    expect(report.runs).toHaveLength(8);
    for (const r of report.runs)
      expect(r).toMatchObject({
        steadyCores: 0.5,
        memoryPeakBytes: 6000,
        workingSetMaxBytes: 150,
        simPerWall: 0.9,
        tickGapP99Ms: 3,
        endReason: 'lifetime',
      });
    const by = Object.fromEntries(report.phases.map((p) => [p.phase, p]));
    expect(by['a1-mix6'].host.meanCores).toBe(0.1);
    expect(by['a1-mix6'].machine).toEqual({ busyCores: 0.5, stealCores: 0 });
    // absent in the first cool-down: null there, a real figure once it exists
    expect(by['a1-mix6'].buildJobs.meanCores).toBe(0.2);
    expect(report.unavailable['buildJobs cpu.stat']).toBeGreaterThan(0);
    expect(report.unavailable['qemu slice']).toBeGreaterThan(0);
    expect(report.ticksTimedOut).toBe(0);
  });
  it('the same run without readable session cpu.stat is incomplete', async () => {
    const { report } = await simulate({ unreadable: ['cpu.stat'] });
    expect(report.status).toBe('incomplete');
    expect(report.unavailable['qemu run without cpu figure']).toBe(8);
    expect(report.runs.every((r) => r.steadyCores === null)).toBe(true);
  });
  it('a session that outlives its wait fails the measurement', async () => {
    await expect(
      M.g2A1Measure(
        M.g2A1Recorder(
          fsOf({}),
          () => 0,
          () => 'x',
        ),
        {
          runId: 'r',
          cooldownMs: 0,
          waitMs: 10_000,
          now: (() => {
            let t = 0;
            return () => (t += 5000);
          })(),
          sleep: async () => {},
          setPhase: () => {},
          emptySeats: async () => {},
          build: async () => 'sha',
          create: async () => ({ id: 'x' }),
          status: async () => ({ ended: false }),
        },
      ),
    ).rejects.toThrow(/still live/);
  });
});

describe('harness contract', () => {
  it('the mix has a delay-heavy and a spinning sketch, and uses six identities', () => {
    expect(M.G2_A1_SKETCHES.delay).toMatch(/delay\(500\)/);
    expect(M.G2_A1_SKETCHES.busy).toMatch(/millis\(\)/);
    expect(M.G2_A1_SKETCHES.busy).not.toMatch(/delay/);
    const mix = M.G2_A1_ROUNDS.at(-1).runs;
    expect(mix.map(([i]) => i)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(mix.filter(([, t]) => t === 'busy')).toHaveLength(3);
  });
  it('the report gains `a1` only when measured', () => {
    const p = {
      instance: 'tbi-s8',
      phase: 'a1',
      seconds: 1,
      admitted: [],
      builds: [],
      promotedPositions: [],
      samples: [],
    };
    expect(g2Report(p, 'FAILED')).not.toHaveProperty('a1');
    expect(g2Report({ ...p, a1: { status: 'incomplete' } }, 'FAILED').a1).toEqual({
      status: 'incomplete',
    });
  });
  it('a mistyped TBI_G2_A1 is refused; unset, 0 and 1 leave the other gates as they are', () => {
    const env = (v) => ({ TBI_G2_DEPLOYED: 'tbi', ...(v === undefined ? {} : { TBI_G2_A1: v }) });
    expect(g2Decision(env('true'), () => true).reason).toMatch(/TBI_G2_A1/);
    for (const v of [undefined, '', '0', '1'])
      expect(g2Decision(env(v), () => true).reason).toMatch(/only against tbi-s8/);
    expect(g2Decision({ TBI_G2_A1: '1' }, () => true)).toEqual({ kind: 'off' });
  });
});
