/**
 * Pure logic of the BETA-G2 load harness (g2-deployed.runtime.test.ts): thresholds, phase budgets,
 * read-only sampling commands and their parsing, auto-stop, drill verdicts and clean-up counts. No
 * process, file or network access here, so it is unit-tested offline (scripts/tests/g2-load.test.mjs).
 */
import { DEFAULT_CONFIG, type PlansConfig } from '../plans/config.js';
import { SIM_JOURNAL_FILE } from '../plans/hostboot.js';
import {
  G2_FREE_LIVE,
  G2_IDLE_MS,
  G2_IDLE_TOLERANCE_MS,
  G2_PAUSE_PROBE,
  G2_PREVIEW,
  G2_STAGING,
} from './g2-guard.js';

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
  /** load1 above loadFailPerCpu x CPUs for loadForMs fails the run; it does not stop it */
  loadFailPerCpu: 2,
  /** load1 above max(loadAbortPerCpu x CPUs, loadAbortMin) for loadForMs stops the run */
  loadAbortPerCpu: 4,
  loadAbortMin: 12,
  loadForMs: 60_000,
  unitMemoryRatio: 0.9,
  samplerFailures: 3,
  /** one whole sampler tick (lock check and all reads) */
  tickDeadlineMs: 15_000,
  lockUnknownInRow: 3,
  /** a run with more than this share of failed samples (of at least blindMinSamples) fails */
  blindRatio: 0.1,
  blindMinSamples: 20,
};
/**
 * A run with a longer gap between two good samples fails. With every tick within its deadline the
 * gap is at most sampleMs + tickDeadlineMs, so only missed samples can exceed this.
 */
export const G2_MAX_GAP_MS = 3 * G2_LIMITS.sampleMs + G2_LIMITS.tickDeadlineMs;
/** a waiter not polled for this long is polled again; far below queue.vanishMs (30 s) */
export const G2_KEEP_MS = 10_000;
export { G2_IDLE_MS, G2_IDLE_TOLERANCE_MS };
/** the host's event stream keepalive interval (KEEPALIVE_MS in runtime/host/http.ts) */
export const G2_KEEPALIVE_MS = 15_000;
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
  /** MemoryCurrent: includes reclaimable page cache, reported only */
  current: number;
  /** memory.stat anon + kernel + shmem: what the cgroup cannot give back without swap */
  workingSet: number;
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
export type G2Run = (
  argv: string[],
  signal?: AbortSignal,
) => Promise<{ status: number | null; stdout: string }>;

const OOM_LINE = /out of memory|oom-kill|oom_reaper|invoked oom-killer/i;
const num = (re: RegExp, text: string): number => Number(re.exec(text)?.[1] ?? NaN);

/** One sample, or null with the exit code of the failed command (-1 = no exit code, 0 = unparsable). */
export async function g2TakeSample(
  run: G2Run,
  sinceEpochS: number,
): Promise<{ sample: G2Sample | null; exit: number }> {
  let exit = 0;
  const read = async (...argv: string[]): Promise<string> => {
    const r = await run(argv);
    if (r.status !== 0) {
      exit = r.status ?? -1;
      throw new Error('sample command failed');
    }
    return r.stdout;
  };
  try {
    const meminfo = await read('cat', '/proc/meminfo');
    const availMiB = num(/^MemAvailable:\s+(\d+) kB/m, meminfo) / 1024;
    const load1 = num(/^([\d.]+) /, await read('cat', '/proc/loadavg'));
    const nproc = num(/^(\d+)\s*$/, await read('nproc'));
    const units: G2UnitMemory[] = [];
    for (const u of G2_WATCHED_UNITS) {
      const show = await read('systemctl', 'show', '-p', 'MemoryCurrent,MemoryPeak,MemoryMax', u);
      const cgroup = `/sys/fs/cgroup/system.slice/${u}.service`;
      const stat = await read('cat', `${cgroup}/memory.stat`);
      const events = await read('cat', `${cgroup}/memory.events`);
      const peak = num(/^MemoryPeak=(\d+)$/m, show);
      units.push({
        current: num(/^MemoryCurrent=(\d+)$/m, show),
        workingSet:
          num(/^anon (\d+)$/m, stat) + num(/^kernel (\d+)$/m, stat) + num(/^shmem (\d+)$/m, stat),
        max: num(/^MemoryMax=(\d+)$/m, show),
        peak: Number.isNaN(peak) ? null : peak,
        oomKill: num(/^oom_kill (\d+)$/m, events),
      });
    }
    const since = `@${sinceEpochS}`;
    const kernel = await read('journalctl', '-k', '--since', since, '--no-pager', '-o', 'cat');
    const qemuUnits = (await read(...G2_QEMU_LIST))
      .split('\n')
      .filter((l) => l.includes('-qemu@')).length;
    const kernelOom = kernel.split('\n').filter((l) => OOM_LINE.test(l)).length;
    // an unreadable value must never pass as a harmless one
    const needed = [
      availMiB,
      load1,
      nproc,
      ...units.flatMap((u) => [u.current, u.workingSet, u.max, u.oomKill]),
    ];
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
  'lock',
] as const;
export type G2Autostop = (typeof G2_AUTOSTOPS)[number];

export const g2WatchState = () => ({
  samples: 0,
  failures: 0,
  failuresInRow: 0,
  lockUnknown: 0,
  lockUnknownInRow: 0,
  lastGoodMs: null as number | null,
  maxGapMs: 0,
  lowMemInRow: 0,
  loadSince: null as number | null,
  loadAbortSince: null as number | null,
  loadFail: false,
  oomBase: null as number[] | null,
  minAvailMiB: Infinity,
  maxLoad1: 0,
  nproc: 0,
  maxUnitRatio: 0,
  maxUnitCurrentRatio: 0,
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
  s.maxGapMs = Math.max(s.maxGapMs, nowMs - (s.lastGoodMs ?? nowMs));
  s.lastGoodMs = nowMs;
  s.nproc = x.nproc;
  s.minAvailMiB = Math.min(s.minAvailMiB, x.availMiB);
  s.maxLoad1 = Math.max(s.maxLoad1, x.load1);
  s.maxQemuUnits = Math.max(s.maxQemuUnits, x.qemuUnits);
  s.kernelOom = Math.max(s.kernelOom, x.kernelOom);
  const ratios = x.units.map((u) => u.workingSet / u.max);
  s.maxUnitRatio = Math.max(s.maxUnitRatio, ...ratios);
  s.maxUnitCurrentRatio = Math.max(s.maxUnitCurrentRatio, ...x.units.map((u) => u.current / u.max));
  x.units.forEach((u, i) => {
    s.unitPeakBytes[i] = Math.max(s.unitPeakBytes[i] ?? 0, u.peak ?? u.current);
  });
  s.oomBase ??= x.units.map((u) => u.oomKill);
  const kills = x.units.reduce((n, u, i) => n + Math.max(0, u.oomKill - s.oomBase![i]!), 0);
  s.oomKills = Math.max(s.oomKills, kills);
  s.lowMemInRow = x.availMiB < G2_LIMITS.abortAvailMiB ? s.lowMemInRow + 1 : 0;
  const since = (over: number, from: number | null) => (x.load1 > over ? (from ?? nowMs) : null);
  const held = (from: number | null) => from !== null && nowMs - from >= G2_LIMITS.loadForMs;
  const abortLoad = Math.max(G2_LIMITS.loadAbortPerCpu * x.nproc, G2_LIMITS.loadAbortMin);
  s.loadSince = since(G2_LIMITS.loadFailPerCpu * x.nproc, s.loadSince);
  s.loadAbortSince = since(abortLoad, s.loadAbortSince);
  if (held(s.loadSince)) s.loadFail = true;
  if (kills > 0) return 'oom_kill';
  if (x.kernelOom > 0) return 'oom_kernel';
  if (s.lowMemInRow >= G2_LIMITS.abortAvailSamples) return 'mem';
  if (ratios.some((r) => r >= G2_LIMITS.unitMemoryRatio)) return 'unit_mem';
  if (held(s.loadAbortSince)) return 'load';
  return null;
}

/** Too many samples failed for the run to count as watched. */
export const g2SamplerBlind = (s: Pick<G2WatchState, 'samples' | 'failures'>): boolean => {
  const total = s.samples + s.failures;
  return total >= G2_LIMITS.blindMinSamples && s.failures > total * G2_LIMITS.blindRatio;
};

/** Exit code of `pipeline-lock.mjs check`; null = no answer. */
export const g2LockState = (status: number | null): 'held' | 'lost' | 'unknown' =>
  status === 0 ? 'held' : status === null ? 'unknown' : 'lost';

/** Feed the lock state of one tick: lost stops at once, unknown after 3 in a row. */
export function g2LockBreach(
  s: Pick<G2WatchState, 'lockUnknown' | 'lockUnknownInRow'>,
  lock: ReturnType<typeof g2LockState>,
): 'lock' | null {
  if (lock !== 'unknown') {
    s.lockUnknownInRow = 0;
    return lock === 'lost' ? 'lock' : null;
  }
  s.lockUnknown++;
  return ++s.lockUnknownInRow >= G2_LIMITS.lockUnknownInRow ? 'lock' : null;
}

/**
 * One sampler tick under one deadline: the lock check and the reads run side by side; what has not
 * answered in time is an unknown lock or a failed sample. At the deadline the running command is
 * aborted and no further one starts; until the older tick has ended, a new one starts nothing.
 */
export function g2Ticker(lockStatus: () => Promise<number | null>, run: G2Run) {
  let busy = false;
  return async (sinceEpochS: number) => {
    const out = {
      lock: 'unknown' as ReturnType<typeof g2LockState>,
      sample: null as G2Sample | null,
      exit: -1,
    };
    if (busy) return out;
    busy = true;
    const late = new AbortController();
    const guarded: G2Run = async (argv) =>
      late.signal.aborted ? { status: null, stdout: '' } : run(argv, late.signal);
    // allSettled: a rejection, early or late, is handled here
    const work = Promise.allSettled([
      Promise.resolve()
        .then(lockStatus)
        .then((code) => void (out.lock = g2LockState(code))),
      g2TakeSample(guarded, sinceEpochS).then((r) => void Object.assign(out, r)),
    ]).then(() => void (busy = false));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((r) => (timer = setTimeout(r, G2_LIMITS.tickDeadlineMs))),
    ]);
    clearTimeout(timer);
    const result = { ...out }; // a late answer must not change it
    late.abort();
    return result;
  };
}

/** Runs `tick` every `intervalMs` (from start to start), never two at once. */
export function g2Loop(
  tick: () => Promise<void>,
  intervalMs: number,
  onError: (e: unknown) => void,
) {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (ms: number) => {
    timer = setTimeout(() => {
      const t0 = performance.now();
      running = tick()
        .catch(onError)
        .finally(() => {
          if (!stopped) schedule(Math.max(0, intervalMs - (performance.now() - t0)));
        });
    }, ms);
  };
  schedule(intervalMs);
  return {
    /** no further tick; resolves when the one in flight has ended */
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

/**
 * Queue waiters that must not vanish while the harness is busy: `keep(ageMs)` polls, oldest first,
 * every waiter not heard from for that long. `poll` returns the HTTP status; only 202 is a waiter.
 */
export function g2WaitingLine<T>(poll: (w: T) => Promise<number>, now: () => number) {
  const seen = new Map<T, number>();
  return {
    add: (w: T) => void seen.set(w, now()),
    remove: (w: T) => void seen.delete(w),
    clear: () => seen.clear(),
    oldestSeenAt: () => Math.min(...seen.values()),
    async keep(ageMs = G2_KEEP_MS) {
      const due = [...seen].filter(([, at]) => now() - at >= ageMs).sort((a, b) => a[1] - b[1]);
      for (const [w] of due) {
        const status = await poll(w);
        if (status !== 202) throw new Error(`g2-deployed: a queued waiter answered ${status}`);
        seen.set(w, now());
      }
    },
  };
}

// ---- root relays
/**
 * Source of a TCP -> unix socket relay (`node -e`, run as root). It exits when its stdin ends, so
 * it cannot outlive the harness that holds the other end of the pipe.
 */
export const g2RelayCode = (socket: string, port: number): string =>
  [
    "const net=require('node:net');",
    "for(const e of ['end','close','error'])process.stdin.on(e,()=>process.exit(0));",
    'process.stdin.resume();',
    'net.createServer((c)=>{',
    `const u=net.connect(${JSON.stringify(socket)});`,
    "c.pipe(u).pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())",
    `}).listen(${port},'127.0.0.1',()=>console.log('ready'));`,
  ].join('');
/** false once the process has exited: its PID may belong to another process by now */
export const g2Running = (p: { exitCode: number | null; signalCode: string | null }): boolean =>
  p.exitCode === null && p.signalCode === null;

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

/**
 * The paid queue_full drill. `queue.maxLength` counts every waiter, a paying one is refused only there,
 * and Free stops at maxFree: so with maxFree Free waiters it needs maxLength - maxFree paying waiters
 * plus one refused, none of them holding a seat. `reason` null = run it, with `needed` of those given.
 */
export function g2PaidPlan(
  queue: Pick<PlansConfig['queue'], 'maxLength' | 'maxFree'>,
  given: number,
): { needed: number; reason: string | null } {
  const needed = queue.maxLength - queue.maxFree + 1;
  const free = g2IdentityPlan(queue.maxFree);
  let reason: string | null = null;
  if (!free.queueFull) reason = 'the Free share cannot be filled within the identity budget';
  else if (free.free + G2_PREVIEW + needed > G2_IDENTITY_BUDGET)
    reason = `needs ${needed} extra paying identities, beyond the budget of ${G2_IDENTITY_BUDGET}`;
  else if (given < needed) reason = `needs ${needed} extra paying identities, ${given} given`;
  return { needed, reason };
}

/**
 * Join the queue with one identity after another until an answer is not 202. `waiting` is called for
 * every accepted waiter (to keep it polled). No refusal at all leaves `refused` undefined.
 */
export async function g2FillQueue(
  users: readonly string[],
  join: (user: string) => Promise<{ status: number; error?: string; ticket?: string }>,
  waiting: (w: { user: string; ticket: string }) => Promise<void>,
) {
  const accepted: { user: string; ticket: string }[] = [];
  for (const user of users) {
    const r = await join(user);
    if (r.status !== 202)
      return { accepted, refused: { status: r.status, error: r.error } as const };
    const w = { user, ticket: r.ticket! };
    accepted.push(w);
    await waiting(w);
  }
  return { accepted, refused: undefined };
}

/** May an identity with these earlier new admissions (ms) start one more at `nowMs`? */
export const g2MayStart = (history: number[], nowMs: number): boolean =>
  history.filter((t) => nowMs - t < G2_START_RATE.windowMs).length < G2_START_RATE.count;

export const g2IdleOnTime = (ms: number): boolean =>
  Math.abs(ms - G2_IDLE_MS) <= G2_IDLE_TOLERANCE_MS;

/**
 * Follows a session's event stream the way a left-open tab holds it: consumes it, and records the
 * terminal state it delivered, when it last received anything (keepalives included) and when it
 * closed (a cut or aborted stream is closed too).
 */
export function g2FollowStream(body: ReadableStream<Uint8Array>, now: () => number) {
  const state: { endReason?: string; lastChunkAtMs?: number; closedAtMs?: number } = {};
  const done = (async () => {
    const decoder = new TextDecoder();
    let tail = '';
    try {
      for await (const chunk of body) {
        state.lastChunkAtMs = now();
        const lines = (tail + decoder.decode(chunk, { stream: true })).split('\n');
        tail = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const e = JSON.parse(line.slice(6)) as { type: string; state: string; reason?: string };
          if (e.type === 'state' && (e.state === 'ended' || e.state === 'failed'))
            state.endReason = e.reason ?? 'none';
        }
      }
    } catch {
      // cut, aborted or unreadable: no terminal state beyond what already arrived
    }
    state.closedAtMs = now();
  })();
  return { state, done };
}
export type G2Stream = ReturnType<typeof g2FollowStream>['state'];

/** The silent tab: only a stream that was still attached receives the idle end itself. */
export const g2IdleStreamOk = (s: G2Stream): boolean => s.endReason === 'idle_timeout';

/**
 * The present tab: its stream is still open after longer than the idle limit, and still alive: it
 * received something within two keepalive intervals (a dead connection need not close).
 */
export const g2HeldStreamOk = (s: G2Stream, openMs: number, nowMs: number): boolean =>
  s.lastChunkAtMs !== undefined &&
  nowMs - s.lastChunkAtMs <= 2 * G2_KEEPALIVE_MS &&
  s.closedAtMs === undefined &&
  s.endReason === undefined &&
  openMs > G2_IDLE_MS + G2_IDLE_TOLERANCE_MS;

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

/** the builder's refusals that mean "no capacity now" (runtime/policy/refusal.ts, all 503) */
export const G2_CAPACITY_REFUSALS = ['builder_busy', 'memory_pressure', 'storage_pressure'];
export type G2BuildOutcome = 'succeeded' | 'refused' | 'failed' | 'lost';
/**
 * `lost`: neither success nor an explicit refusal within the cap. Only a capacity refusal counts as
 * refused: a 429 (rate_limited, quota, cooldown) says the run did not test capacity and is `failed`.
 */
export function g2BuildOutcome(r: {
  http: number;
  error?: string;
  state?: string;
  failure?: string;
  ms: number;
}): G2BuildOutcome {
  if (r.ms > G2_BUILD_CAP_MS) return 'lost';
  if (r.state === 'succeeded') return 'succeeded';
  if (r.http === 503 && G2_CAPACITY_REFUSALS.includes(r.error ?? '')) return 'refused';
  if (r.state === 'failed') return r.failure === 'capacity_timeout' ? 'refused' : 'failed';
  return r.http === 200 || r.http === 202 ? 'lost' : 'failed';
}

/** G4 over the two builds under load. */
export function g2BuildSummary(done: { outcome: G2BuildOutcome; ms: number }[]) {
  const count = (o: G2BuildOutcome) => done.filter((b) => b.outcome === o).length;
  const succeeded = count('succeeded');
  return {
    metrics: {
      build1WaitMs: done[0]!.ms,
      build2WaitMs: done[1]!.ms,
      buildsSucceeded: succeeded,
      buildsRefused: count('refused'),
      buildsFailed: count('failed'),
      buildsLost: count('lost'),
    },
    /** a long wait, or no success at all: DEC-32 must be looked at */
    dec32: succeeded === 0 || done.some((b) => b.ms > G2_BUILD_FLAG_MS),
    failed: count('failed') + count('lost') > 0,
  };
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
