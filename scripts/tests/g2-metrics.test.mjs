/** Offline unit tests of the Capacity A1 measurements (runtime/tests/g2-metrics.ts). Fake files and clock. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
  it('each round has its own phase label, and the harness sets one per step', () => {
    expect(M.G2_A1_ROUNDS.map((r) => r.phase)).toEqual([
      'a1-delay-solo',
      'a1-busy-solo',
      'a1-mix6',
    ]);
    const src = readFileSync('runtime/tests/g2-deployed.runtime.test.ts', 'utf8');
    for (const set of ["'a1-builds'", "'a1-cooldown'", 'phase'])
      expect(src).toContain(`progress.phase = ${set};`);
    expect(src).not.toContain("progress.phase = 'a1';");
  });
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
    const rec = M.g2A1Recorder(
      fsOf(files(`${M.G2_A1_QEMU_SLICE}/${unit}`), { [M.G2_A1_QEMU_SLICE]: [unit] }),
      () => 0,
      () => 'a1-mix6',
    );
    rec.addRun(id, 'delay', 'mix6');
    rec.addRun('c'.repeat(32), 'gpio_proof', 'drills');
    await rec.tick();
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
