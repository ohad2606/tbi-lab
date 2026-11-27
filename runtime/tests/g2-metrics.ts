/**
 * Capacity A1: CPU and RAM per run for the BETA-G2 load harness (opt-in TBI_G2_A1=1). Parsing and
 * aggregation only; the file reader is injected, so this is unit-tested offline
 * (scripts/tests/g2-metrics.test.mjs). It only reads /sys/fs/cgroup and /proc/stat, unprivileged.
 * A value that cannot be read is `null` ("unavailable"), never zero, and never stops the run.
 */
import { G2_STAGING } from './g2-guard.js';

export const G2_A1_SAMPLE_MS = 1000;
/** the steady window starts this long after `run` was answered; before it is start-up */
export const G2_A1_STEADY_AFTER_MS = 25_000;
/** a shorter steady window says nothing */
export const G2_A1_MIN_STEADY_MS = 10_000;
/** no further A1 build starts after this long (one build itself may take G2_BUILD_CAP_MS) */
export const G2_A1_BUILD_START_MS = 600_000;
/** extra test time of A1: builds up to 600 + 610 s, then three rounds of about 4 min at most */
export const G2_A1_BUDGET_S = 2000;

export type G2A1Type = 'gpio_proof' | 'delay' | 'busy';
export type G2A1Round = 'drills' | 'solo' | 'mix6';

/** Both blink pad 2 every 500 ms; only the way they wait differs. */
const blink = (body: string) =>
  `void setup() { pinMode(2, OUTPUT); }\nbool on = false;\nvoid toggle() { on = !on; digitalWrite(2, on ? HIGH : LOW); }\n${body}\n`;
export const G2_A1_SKETCHES = {
  delay: blink('void loop() { toggle(); delay(500); }'),
  busy: blink(
    'unsigned long last = 0;\nvoid loop() { if (millis() - last >= 500) { last = millis(); toggle(); } }',
  ),
};

/** The measurement rounds: which identity (index into 4 Free + 2 preview) runs which type. */
export const G2_A1_ROUNDS: { round: G2A1Round; runs: [number, 'delay' | 'busy'][] }[] = [
  { round: 'solo', runs: [[0, 'delay']] },
  { round: 'solo', runs: [[1, 'busy']] },
  {
    round: 'mix6',
    runs: [
      [0, 'delay'],
      [1, 'busy'],
      [2, 'delay'],
      [3, 'busy'],
      [4, 'delay'],
      [5, 'busy'],
    ],
  },
];

// ---- cgroup v2 paths (deploy/dev-lab/s8/*.service.in set no Slice=: templates get their own slice)
const SYSTEM = '/sys/fs/cgroup/system.slice';
const templateSlice = (name: string) => `${SYSTEM}/system-${name.replaceAll('-', '\\x2d')}.slice`;
export const G2_A1_QEMU_SLICE = templateSlice(`${G2_STAGING}-qemu`);
export const G2_A1_UNITS = {
  host: `${SYSTEM}/${G2_STAGING}-session-host.service`,
  build: `${SYSTEM}/${G2_STAGING}-build.service`,
  /** the slice counter keeps the CPU of build jobs that have already exited */
  buildJobs: templateSlice(`${G2_STAGING}-build-job`),
};
export type G2A1Unit = keyof typeof G2_A1_UNITS;
const UNIT_NAMES = Object.keys(G2_A1_UNITS) as G2A1Unit[];

export interface G2A1Fs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

export interface G2A1Reading {
  atMs: number;
  usageUsec: number | null;
  nrThrottled: number | null;
  current: number | null;
  anon: number | null;
  file: number | null;
  shmem: number | null;
  kernel: number | null;
  peak: number | null;
}

const field = (text: string | null, name: string): number | null => {
  const m = text === null ? null : new RegExp(`^${name} (\\d+)$`, 'm').exec(text);
  return m ? Number(m[1]) : null;
};
const scalar = (text: string | null): number | null =>
  text !== null && /^\d+\s*$/.test(text) ? Number(text) : null;

export async function g2A1ReadCgroup(
  fs: G2A1Fs,
  dir: string,
  atMs: number,
  /** called with the name of every file that could not be read */
  missing: (file: string) => void = () => undefined,
): Promise<G2A1Reading> {
  const read = (name: string) =>
    fs.readFile(`${dir}/${name}`).catch(() => (missing(name), null as string | null));
  const [cpu, current, stat, peak] = await Promise.all(
    ['cpu.stat', 'memory.current', 'memory.stat', 'memory.peak'].map(read),
  );
  return {
    atMs,
    usageUsec: field(cpu!, 'usage_usec'),
    nrThrottled: field(cpu!, 'nr_throttled'),
    current: scalar(current!),
    anon: field(stat!, 'anon'),
    file: field(stat!, 'file'),
    shmem: field(stat!, 'shmem'),
    kernel: field(stat!, 'kernel'),
    peak: scalar(peak!),
  };
}

export interface G2A1Machine {
  cpus: number;
  /** clock ticks summed over all CPUs */
  total: number;
  busy: number;
  steal: number;
}
/** /proc/stat first line: user nice system idle iowait irq softirq steal (guest is inside user). */
export function g2A1ProcStat(text: string): G2A1Machine | null {
  const m = /^cpu +((?:\d+ +){7}\d+)/m.exec(text);
  const cpus = text.match(/^cpu\d+ /gm)?.length ?? 0;
  if (!m || !cpus) return null;
  const v = m[1]!.split(/ +/).map(Number);
  const total = v.reduce((a, b) => a + b, 0);
  return { cpus, total, busy: total - v[3]! - v[4]! - v[7]!, steal: v[7]! };
}

/** The host unit's settings from `systemctl show -p Environment`; null = not set there. */
export function g2A1HostConfig(environment: string) {
  const value = (name: string) => {
    const m = new RegExp(`(?:^Environment=| )"?${name}=([\\d.]+)(?=["\\s]|$)`, 'm').exec(
      environment,
    );
    return m ? Number(m[1]) : null;
  };
  return {
    pace: value('TBI_HOST_PACE'),
    idleMs: value('TBI_HOST_IDLE_MS'),
    maxSessions: value('TBI_HOST_MAX_SESSIONS'),
  };
}

// ---- aggregation
const present = (values: (number | null)[]) => values.filter((v): v is number => v !== null);
const maxOf = (values: (number | null)[]) => {
  const v = present(values);
  return v.length ? Math.max(...v) : null;
};
const sumOf = (values: (number | null)[]) => {
  const v = present(values);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};
export function g2A1Spread(values: (number | null)[]) {
  const v = present(values).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid]! : round3((v[mid - 1]! + v[mid]!) / 2);
  return { min: v[0]!, median, max: v.at(-1)! };
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Growth of a counter between its first and last readable value; null if fewer than two. */
function growth(readings: G2A1Reading[], key: 'usageUsec' | 'nrThrottled') {
  const known = readings.filter((r) => r[key] !== null);
  if (known.length < 2) return null;
  const delta = known.at(-1)![key]! - known[0]![key]!;
  // a counter that went backwards is not the same cgroup: no value
  if (delta < 0) return null;
  return { delta, ms: known.at(-1)!.atMs - known[0]!.atMs };
}
const cores = (g: { delta: number; ms: number } | null, minMs = 1) =>
  g && g.ms >= minMs ? round3(g.delta / 1000 / g.ms) : null;

export interface G2A1Pace {
  simPerWall: number | null;
  tickGapP99Ms: number | null;
  endReason: string | null;
}

export function g2A1Run(
  type: G2A1Type,
  roundName: G2A1Round,
  runAtMs: number,
  readings: G2A1Reading[],
  pace?: G2A1Pace,
) {
  // only readings that saw the cgroup: after the unit is gone every value is null
  const seen = readings.filter((r) => r.usageUsec !== null || r.current !== null);
  const from = runAtMs + G2_A1_STEADY_AFTER_MS;
  const steady = growth(
    seen.filter((r) => r.atMs >= from),
    'usageUsec',
  );
  const steadyOk = steady !== null && steady.ms >= G2_A1_MIN_STEADY_MS;
  // up to and including the first sample at or after the boundary
  const boundary = seen.find((r) => r.atMs >= from && r.usageUsec !== null);
  const startup = boundary ? seen.filter((r) => r.atMs <= boundary.atMs) : seen;
  const throttledSteady = growth(
    seen.filter((r) => r.atMs >= from),
    'nrThrottled',
  );
  const workingSet = seen.map((r) =>
    r.anon === null || r.kernel === null || r.shmem === null ? null : r.anon + r.kernel + r.shmem,
  );
  return {
    type,
    round: roundName,
    samples: seen.length,
    steadySeconds: steadyOk ? Math.round(steady.ms / 1000) : null,
    steadyCores: cores(steady, G2_A1_MIN_STEADY_MS),
    steadyThrottled: steadyOk ? (throttledSteady?.delta ?? null) : null,
    startupCores: cores(growth(startup, 'usageUsec')),
    /** CPU time since the unit started, at the first sample of the steady window */
    startupCpuSeconds: boundary ? round3(boundary.usageUsec! / 1e6) : null,
    throttledTotal: maxOf(seen.map((r) => r.nrThrottled)),
    memoryPeakBytes: maxOf(seen.map((r) => r.peak)),
    memoryCurrentMaxBytes: maxOf(seen.map((r) => r.current)),
    anonMaxBytes: maxOf(seen.map((r) => r.anon)),
    fileMaxBytes: maxOf(seen.map((r) => r.file)),
    shmemMaxBytes: maxOf(seen.map((r) => r.shmem)),
    kernelMaxBytes: maxOf(seen.map((r) => r.kernel)),
    workingSetMaxBytes: maxOf(workingSet),
    simPerWall: pace?.simPerWall ?? null,
    tickGapP99Ms: pace?.tickGapP99Ms ?? null,
    endReason: pace?.endReason ?? null,
  };
}
export type G2A1RunReport = ReturnType<typeof g2A1Run>;

export function g2A1ByType(runs: G2A1RunReport[]) {
  const groups = new Map<string, G2A1RunReport[]>();
  for (const r of runs) {
    const key = `${r.round} ${r.type}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((g) => ({
    type: g[0]!.type,
    round: g[0]!.round,
    runs: g.length,
    runsWithSteady: g.filter((r) => r.steadyCores !== null).length,
    steadyCores: g2A1Spread(g.map((r) => r.steadyCores)),
    startupCores: g2A1Spread(g.map((r) => r.startupCores)),
    startupCpuSeconds: g2A1Spread(g.map((r) => r.startupCpuSeconds)),
    memoryPeakBytes: g2A1Spread(g.map((r) => r.memoryPeakBytes)),
    workingSetMaxBytes: g2A1Spread(g.map((r) => r.workingSetMaxBytes)),
    steadyThrottled: sumOf(g.map((r) => r.steadyThrottled)),
    simPerWall: g2A1Spread(g.map((r) => r.simPerWall)),
  }));
}

interface Tick {
  phase: string;
  atMs: number;
  units: Record<G2A1Unit, G2A1Reading>;
  machine: G2A1Machine | null;
}

/** CPU of the shared units and of the machine per harness phase, from consecutive samples. */
export function g2A1Phases(ticks: Tick[]) {
  const phases = [...new Set(ticks.map((t) => t.phase))];
  // a pair that spans two phases belongs to neither
  const pairs = ticks.slice(1).map((b, i) => [ticks[i]!, b] as const);
  return phases.map((phase) => {
    const own = pairs.filter(([a, b]) => a.phase === phase && b.phase === phase);
    const unit = (name: G2A1Unit) => {
      let usec = 0;
      let ms = 0;
      let max = 0;
      for (const [a, b] of own) {
        const g = growth([a.units[name], b.units[name]], 'usageUsec');
        if (!g || g.ms <= 0) continue;
        usec += g.delta;
        ms += g.ms;
        max = Math.max(max, cores(g)!);
      }
      return ms
        ? {
            meanCores: round3(usec / 1000 / ms),
            maxCores: max,
            seconds: Math.round(ms / 1000),
            memoryCurrentMaxBytes: maxOf(
              ticks.filter((t) => t.phase === phase).map((t) => t.units[name].current),
            ),
          }
        : null;
    };
    let total = 0;
    let busy = 0;
    let steal = 0;
    let cpus = 0;
    for (const [a, b] of own) {
      if (!a.machine || !b.machine || b.machine.total <= a.machine.total) continue;
      total += b.machine.total - a.machine.total;
      busy += b.machine.busy - a.machine.busy;
      steal += b.machine.steal - a.machine.steal;
      cpus = b.machine.cpus;
    }
    return {
      phase,
      host: unit('host'),
      build: unit('build'),
      buildJobs: unit('buildJobs'),
      machine: total
        ? { busyCores: round3((busy / total) * cpus), stealCores: round3((steal / total) * cpus) }
        : null,
    };
  });
}

export function g2A1Recorder(fs: G2A1Fs, now: () => number, phase: () => string) {
  const runs = new Map<
    string,
    {
      type: G2A1Type;
      round: G2A1Round;
      runAtMs: number;
      readings: G2A1Reading[];
      pace?: G2A1Pace;
    }
  >();
  const ticks: Tick[] = [];
  const unavailable: Record<string, number> = {};
  const miss = (what: string) => void (unavailable[what] = (unavailable[what] ?? 0) + 1);
  const out = {
    status: 'not_reached' as 'not_reached' | 'incomplete' | 'complete',
    /** run failure codes recorded before the measurement rounds began; null = never began */
    failuresBefore: null as string[] | null,
    config: null as (ReturnType<typeof g2A1HostConfig> & { cpus: number | null }) | null,
  };
  return {
    state: out,
    addRun(id: string, type: G2A1Type, roundName: G2A1Round) {
      runs.set(id, { type, round: roundName, runAtMs: now(), readings: [] });
    },
    pace(id: string, pace: G2A1Pace) {
      const r = runs.get(id);
      if (r) r.pace = pace;
    },
    /** One sample. Never throws. */
    async tick() {
      try {
        const units = {} as Tick['units'];
        await Promise.all(
          UNIT_NAMES.map(async (name) => {
            units[name] = await g2A1ReadCgroup(fs, G2_A1_UNITS[name], now(), (f) =>
              miss(`${name} ${f}`),
            );
          }),
        );
        const stat = await fs.readFile('/proc/stat').catch(() => null);
        const machine = stat === null ? null : g2A1ProcStat(stat);
        if (!machine) miss('proc stat');
        ticks.push({ phase: phase(), atMs: now(), units, machine });
        // only our own runs; a finished one has no directory any more
        const listed = await fs.readdir(G2_A1_QEMU_SLICE).catch(() => {
          miss('qemu slice');
          return [] as string[];
        });
        await Promise.all(
          listed.map(async (dir) => {
            const id = new RegExp(`^${G2_STAGING}-qemu@([0-9a-f]{32})\\.service$`).exec(dir)?.[1];
            const run = id === undefined ? undefined : runs.get(id);
            if (!run) return;
            const gone: string[] = [];
            const reading = await g2A1ReadCgroup(
              fs,
              `${G2_A1_QEMU_SLICE}/${dir}`,
              now(),
              (f) => void gone.push(f),
            );
            // all four missing: the unit ended between the listing and the reads
            if (gone.length < 4) for (const f of gone) miss(`qemu ${f}`);
            run.readings.push(reading);
          }),
        );
      } catch {
        miss('tick');
      }
    },
    report() {
      const perRun = [...runs.values()].map((r) =>
        g2A1Run(r.type, r.round, r.runAtMs, r.readings, r.pace),
      );
      return {
        ...out,
        steadyAfterSeconds: G2_A1_STEADY_AFTER_MS / 1000,
        samples: ticks.length,
        /** failed reads by source; the values concerned are null, not zero */
        unavailable: { ...unavailable },
        byType: g2A1ByType(perRun),
        runs: perRun,
        phases: g2A1Phases(ticks),
      };
    },
  };
}
export type G2A1Report = ReturnType<ReturnType<typeof g2A1Recorder>['report']>;
