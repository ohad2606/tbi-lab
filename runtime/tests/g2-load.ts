/**
 * Pure logic of the BETA-G2 load harness (g2-deployed.runtime.test.ts): thresholds, phase budgets,
 * read-only sampling commands and their parsing, auto-stop, drill verdicts and clean-up counts. No
 * process, file or network access here, so it is unit-tested offline (scripts/tests/g2-load.test.mjs).
 */
import { DEFAULT_CONFIG, type PlansConfig } from '../plans/config.js';
import { SIM_JOURNAL_FILE } from '../plans/hostboot.js';
import { G2_FREE_LIVE, G2_PAUSE_PROBE, G2_PREVIEW, G2_STAGING } from './g2-guard.js';

// ---- paths and units of the staging instance (deploy/dev-lab/s8/*.service.in)
export const G2_STATE_DIR = `/var/lib/${G2_STAGING}-runtime/state/sim`;
export const G2_JOURNAL = `${G2_STATE_DIR}/${SIM_JOURNAL_FILE}`;
export const G2_SESSION_ROOT = `/var/lib/${G2_STAGING}-runtime/sessions`;
export const G2_HOST_UNIT = `${G2_STAGING}-session-host`;
/** units whose cgroup memory is watched, in report order */
export const G2_WATCHED_UNITS = [G2_HOST_UNIT, `${G2_STAGING}-build`] as const;
export const G2_QEMU_LIST = [
  'systemctl',
  'list-units',
  `${G2_STAGING}-qemu@*`,
  '--no-legend',
  '--no-pager',
  '--plain',
];
/** manual stop: this file under $TBI_RUNTIME_HOME, checked with every sample */
export const G2_STOP_FILE = 'g2-stop';

// ---- thresholds and budgets
export const G2_LIMITS = {
  sampleMs: 5000,
  abortAvailMiB: 300,
  abortAvailSamples: 2,
  failAvailMiB: 400,
  loadPerCpu: 2,
  loadForMs: 60_000,
  unitMemoryRatio: 0.9,
  samplerFailures: 3,
};
/** DEC-31: the idle limit the instance must report, and the allowed error of its end */
export const G2_IDLE_MS = 300_000;
export const G2_IDLE_TOLERANCE_MS = 2000;
export const G2_PRESENCE_MS = 60_000;
/** DEC-32: builds are held up to 10 min (policy maxQueueWaitMs); +10 s for pump and poll latency */
export const G2_BUILD_CAP_MS = 600_000 + 10_000;
export const G2_BUILD_FLAG_MS = 120_000;
export const G2_DRAIN_CHECK_MS = 30_000;
export const G2_IDENTITY_BUDGET = 30;
/** per-user session-create rate of the beta policy (free and preview) */
export const G2_START_RATE = { count: 20, windowMs: 600_000 };
/** lifetime of the sessions held through the idle, queue and build drills (plan maximum 30 min) */
export const G2_HOLD_LIFETIME_MS = 1_500_000;
/** seconds per phase, without the drain (TBI_G2_SECONDS) */
export const G2_BUDGET_S = {
  preflight: 120,
  builds: 2700,
  admissionCancelPause: 240,
  cooldown: 120,
  idle: 420,
  queueFull: 90,
  abandon: 60,
  /** queue_timeout: 600 s + 2 x pollAfterS (15) + 30 s; the two builds run inside it */
  hold: 700,
  cleanUp: 180,
};
export const g2TimeoutMs = (drainS: number): number =>
  (Object.values(G2_BUDGET_S).reduce((a, b) => a + b, drainS) + 300) * 1000;

// ---- sampling (read-only commands, fixed argv, run as `sudo -n`, no shell)
export interface G2UnitMemory {
  current: number;
  max: number;
  peak: number | null;
  oomKill: number;
}
export interface G2Sample {
  availMiB: number;
  load1: number;
  nproc: number;
  units: G2UnitMemory[];
  kernelOom: number;
  qemuUnits: number;
}
export type G2Run = (argv: string[]) => { status: number | null; stdout: string };

const OOM_LINE = /out of memory|oom-kill|oom_reaper|invoked oom-killer/i;
const num = (re: RegExp, text: string): number => Number(re.exec(text)?.[1] ?? NaN);

/** One sample, or null with the exit code of the failed command (-1 = no exit code, 0 = unparsable). */
export function g2TakeSample(
  run: G2Run,
  sinceEpochS: number,
): { sample: G2Sample | null; exit: number } {
  let exit = 0;
  const read = (...argv: string[]): string => {
    const r = run(argv);
    if (r.status !== 0) {
      exit = r.status ?? -1;
      throw new Error('sample command failed');
    }
    return r.stdout;
  };
  try {
    const availMiB = num(/^MemAvailable:\s+(\d+) kB/m, read('cat', '/proc/meminfo')) / 1024;
    const load1 = num(/^([\d.]+) /, read('cat', '/proc/loadavg'));
    const nproc = num(/^(\d+)\s*$/, read('nproc'));
    const units = G2_WATCHED_UNITS.map((u) => {
      const show = read('systemctl', 'show', '-p', 'MemoryCurrent,MemoryPeak,MemoryMax', u);
      const events = read('cat', `/sys/fs/cgroup/system.slice/${u}.service/memory.events`);
      const peak = num(/^MemoryPeak=(\d+)$/m, show);
      return {
        current: num(/^MemoryCurrent=(\d+)$/m, show),
        max: num(/^MemoryMax=(\d+)$/m, show),
        peak: Number.isNaN(peak) ? null : peak,
        oomKill: num(/^oom_kill (\d+)$/m, events),
      };
    });
    const since = `@${sinceEpochS}`;
    const kernel = read('journalctl', '-k', '--since', since, '--no-pager', '-o', 'cat');
    const qemuUnits = read(...G2_QEMU_LIST)
      .split('\n')
      .filter((l) => l.includes('-qemu@')).length;
    const kernelOom = kernel.split('\n').filter((l) => OOM_LINE.test(l)).length;
    // an unreadable value must never pass as a harmless one
    const needed = [availMiB, load1, nproc, ...units.flatMap((u) => [u.current, u.max, u.oomKill])];
    if (!needed.every(Number.isFinite) || nproc < 1) return { sample: null, exit };
    return { sample: { availMiB, load1, nproc, units, kernelOom, qemuUnits }, exit };
  } catch {
    return { sample: null, exit };
  }
}

export const G2_AUTOSTOPS = [
  'mem',
  'load',
  'unit_mem',
  'oom_kill',
  'oom_kernel',
  'sampler',
  'manual',
  'signal',
] as const;
export type G2Autostop = (typeof G2_AUTOSTOPS)[number];

export const g2WatchState = () => ({
  samples: 0,
  failures: 0,
  failuresInRow: 0,
  lowMemInRow: 0,
  loadSince: null as number | null,
  oomBase: null as number[] | null,
  minAvailMiB: Infinity,
  maxLoad1: 0,
  nproc: 0,
  maxUnitRatio: 0,
  unitPeakBytes: [0, 0],
  oomKills: 0,
  kernelOom: 0,
  maxQemuUnits: 0,
});
export type G2WatchState = ReturnType<typeof g2WatchState>;

/** Feed one sample (null = the sample failed) at `nowMs`; returns the breach that must stop the run. */
export function g2Evaluate(s: G2WatchState, x: G2Sample | null, nowMs: number): G2Autostop | null {
  if (!x) {
    s.failures++;
    return ++s.failuresInRow >= G2_LIMITS.samplerFailures ? 'sampler' : null;
  }
  s.failuresInRow = 0;
  s.samples++;
  s.nproc = x.nproc;
  s.minAvailMiB = Math.min(s.minAvailMiB, x.availMiB);
  s.maxLoad1 = Math.max(s.maxLoad1, x.load1);
  s.maxQemuUnits = Math.max(s.maxQemuUnits, x.qemuUnits);
  s.kernelOom = Math.max(s.kernelOom, x.kernelOom);
  const ratios = x.units.map((u) => u.current / u.max);
  s.maxUnitRatio = Math.max(s.maxUnitRatio, ...ratios);
  x.units.forEach((u, i) => {
    s.unitPeakBytes[i] = Math.max(s.unitPeakBytes[i] ?? 0, u.peak ?? u.current);
  });
  s.oomBase ??= x.units.map((u) => u.oomKill);
  const kills = x.units.reduce((n, u, i) => n + Math.max(0, u.oomKill - s.oomBase![i]!), 0);
  s.oomKills = Math.max(s.oomKills, kills);
  s.lowMemInRow = x.availMiB < G2_LIMITS.abortAvailMiB ? s.lowMemInRow + 1 : 0;
  s.loadSince = x.load1 > G2_LIMITS.loadPerCpu * x.nproc ? (s.loadSince ?? nowMs) : null;
  if (kills > 0) return 'oom_kill';
  if (x.kernelOom > 0) return 'oom_kernel';
  if (s.lowMemInRow >= G2_LIMITS.abortAvailSamples) return 'mem';
  if (ratios.some((r) => r >= G2_LIMITS.unitMemoryRatio)) return 'unit_mem';
  if (s.loadSince !== null && nowMs - s.loadSince >= G2_LIMITS.loadForMs) return 'load';
  return null;
}

// ---- preconditions and drill verdicts
export interface G2Capacity {
  live: number;
  max: number;
  waiting?: number;
  metered?: number;
  freePaused?: boolean;
}
/** Why the instance is not a clean baseline (empty = clean). */
export function g2Baseline(h: G2Capacity, pauseFile: boolean, stopFile: boolean): string[] {
  const out: string[] = [];
  if (h.max !== G2_FREE_LIVE + G2_PREVIEW) out.push('health max is not 6');
  if (h.live !== 0) out.push('live sessions');
  if (h.waiting !== 0) out.push('waiting is not 0 (or metering is off)');
  if (h.metered !== 0) out.push('metered is not 0 (or metering is off)');
  if (h.freePaused !== false) out.push('freePaused is not false');
  if (pauseFile) out.push('the pause file exists');
  if (stopFile) out.push('the manual stop file exists');
  return out;
}

export function g2QueueProblem(q: PlansConfig['queue']): string | null {
  if (q.freeSlotCap !== G2_FREE_LIVE) return `freeSlotCap is not ${G2_FREE_LIVE}`;
  if (q.maxWaitMs > DEFAULT_CONFIG.queue.maxWaitMs) return 'maxWaitMs exceeds the phase budget';
  if (q.vanishMs > DEFAULT_CONFIG.queue.vanishMs) return 'vanishMs exceeds the phase budget';
  return null;
}

/**
 * Free identities of a run. queue_full needs the live Free users, the one that idled out, maxFree
 * waiters and one refused; beyond the fixed budget that step is refused (never more identities).
 */
export function g2IdentityPlan(maxFree: number): { free: number; queueFull: boolean } {
  const base = G2_PAUSE_PROBE + 1;
  const need = G2_FREE_LIVE + 1 + maxFree + 1;
  return need + G2_PREVIEW <= G2_IDENTITY_BUDGET
    ? { free: Math.max(base, need), queueFull: true }
    : { free: base, queueFull: false };
}

/** May an identity with these earlier new admissions (ms) start one more at `nowMs`? */
export const g2MayStart = (history: number[], nowMs: number): boolean =>
  history.filter((t) => nowMs - t < G2_START_RATE.windowMs).length < G2_START_RATE.count;

export const g2IdleOnTime = (ms: number): boolean =>
  Math.abs(ms - G2_IDLE_MS) <= G2_IDLE_TOLERANCE_MS;

/** A vanished waiter also answers queue_timeout, so the answer must not come before maxWaitMs. */
export const g2TimeoutOk = (
  r: { status: number; error?: string; ms: number },
  maxWaitMs: number,
  pollAfterS: number,
): boolean =>
  r.status === 429 &&
  r.error === 'queue_timeout' &&
  r.ms >= maxWaitMs - 2000 &&
  r.ms <= maxWaitMs + 2 * pollAfterS * 1000 + 30_000;

export type G2BuildOutcome = 'succeeded' | 'refused' | 'failed' | 'lost';
/** `lost`: neither success nor an explicit refusal within the cap. */
export function g2BuildOutcome(r: {
  http: number;
  error?: string;
  state?: string;
  failure?: string;
  ms: number;
}): G2BuildOutcome {
  if (r.ms > G2_BUILD_CAP_MS) return 'lost';
  if (r.state === 'succeeded') return 'succeeded';
  if ((r.http === 429 || r.http === 503) && r.error) return 'refused';
  if (r.state === 'failed') return r.failure === 'capacity_timeout' ? 'refused' : 'failed';
  return r.http === 200 || r.http === 202 ? 'lost' : 'failed';
}

// ---- G7
/** Own session ids that do not have exactly one sim_open and one sim_close in the journal. */
export function g2JournalCount(text: string, ids: string[]) {
  const seen = new Map(ids.map((id) => [id, { sim_open: 0, sim_close: 0 }]));
  let unparsable = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line.slice(line.indexOf('\t') + 1)) as { t: string; sessionId: string };
      const own = seen.get(e.sessionId);
      if (own && (e.t === 'sim_open' || e.t === 'sim_close')) own[e.t]++;
    } catch {
      unparsable++;
    }
  }
  const bad = [...seen.values()].filter((c) => c.sim_open !== 1 || c.sim_close !== 1).length;
  return { own: seen.size, bad, unparsable };
}

/** Counts of runtime units and session directories, own against other (others are never touched). */
export function g2Leftovers(unitList: string, dirList: string, ids: string[]) {
  const own = new Set(ids);
  const units = [...unitList.matchAll(/-qemu@([0-9a-f]{32})\.service/g)].map((m) => m[1]!);
  const dirs = dirList.split('\n').filter(Boolean);
  const ownDirs = dirs.filter((d) => own.has(d.replace(/^s-/, ''))).length;
  const ownUnits = units.filter((u) => own.has(u)).length;
  return {
    units: ownUnits,
    otherUnits: units.length - ownUnits,
    dirs: ownDirs,
    otherDirs: dirs.length - ownDirs,
  };
}

/** How many secrets appear in any text (a count only: never which). */
export const g2Leaks = (texts: string[], secrets: string[]): number =>
  secrets.filter((s) => s !== '' && texts.some((t) => t.includes(s))).length;
