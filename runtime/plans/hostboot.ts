/**
 * TBI-018 s3d-1: opt-in construction of the sim-minutes adapter for the Session Host (design
 * docs/plans/S3D-HOST-WIRING-DESIGN.md §9, state directory rules §7). s3d-6: `runtime/host/main.ts`
 * calls it at boot (the s3d-1 "not wired" refusal is gone); unset flags = no adapter, today's host.
 * After the journal is opened: recovery (every open meter session closed with 'host') and, past a
 * threshold, compaction with a `.pre-compact` copy first. A torn or corrupt journal refuses; it is
 * never repaired here (operator tool: runtime/plans/repairjournal.ts).
 *
 *   TBI_HOST_SIM_PLANS_CONFIG     plans config file (strict parseConfig). Unset: no adapter, nothing read.
 *   TBI_HOST_SIM_PLANS_STATE      journal directory, required (no default under another service's state)
 *   TBI_HOST_SIM_PLAN_MAP         `preview=legacy,system=legacy`: host policy plan name -> PlanId
 *   TBI_HOST_SIM_BEAT_MS          beat interval, default floor(leaseMs / 3); 1 <= v < leaseMs
 *   TBI_HOST_SIM_HOUSEKEEPING_MS  adapter housekeeping, default 5000; >= host housekeepingMs
 *   TBI_HOST_SIM_POLL_S           pollAfterS for a 202, default 15; v * 1000 < queue.vanishMs
 *
 * BETA-G2 kill switch: while `${TBI_HOST_SIM_PLANS_STATE}/free-admission.paused` exists, new Free
 * admissions are refused with free_paused (SimHostAdapter `freePaused`), checked on every admission, so an
 * operator switches it on (`touch`) and off (`rm`) without a restart. A path that cannot be checked
 * counts as paused (fail closed). No file = off (the default).
 *
 * Every refusal throws HostSimBootError (fail closed). Messages carry flag names only: never file
 * content, paths, values or principals.
 */
import {
  closeSync,
  copyFileSync,
  constants as fsc,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ConfigError, parseConfig, PLAN_IDS, type PlanId, type PlansConfig } from './config.js';
import { HOST_SIM_FLAGS } from './hostflags.js';
import type { SimEvent } from './simminutes.js';
import { SimHostAdapter } from './simhost.js';
import { JournalStore } from './store.js';
import type { Clock } from './time.js';

export class HostSimBootError extends Error {}

export const SIM_JOURNAL_FILE = 'sim-journal.log';
export const SIM_LOCK_FILE = 'host.lock';
/** BETA-G2: operator kill switch for new Free admissions (in the state directory; content ignored) */
export const FREE_PAUSE_FILE = 'free-admission.paused';

/**
 * BETA-G2: is the Free kill switch on? Any entry at `path` (file, directory, symlink, even dangling)
 * = paused; ENOENT = not paused; any other error (EACCES, ENOTDIR, ...) = paused (fail closed).
 */
export function freePausedAt(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
/** O_EXCL mutex serialising a stale-lock takeover and release (never removed by a non-holder) */
export const SIM_LOCK_TAKEOVER_FILE = 'host.lock.takeover';
/** the plans config is a small JSON file; anything larger is refused unread */
export const MAX_SIM_CONFIG_BYTES = 1024 * 1024;
export const DEFAULT_SIM_HOUSEKEEPING_MS = 5000;
export const DEFAULT_SIM_POLL_S = 15;
/**
 * s3d-6: boot compaction runs when the journal holds more than this many events (since it began or was
 * last compacted) and no session is open after recovery. Compile-time default; tests override it.
 */
export const DEFAULT_SIM_COMPACT_EVENTS = 20_000;
/** s3d-6: suffix of the copy written before a compaction (never deleted or overwritten automatically) */
export const PRE_COMPACT_SUFFIX = '.pre-compact';

/** Host facts the checks need (design §9: policy required, housekeeping floor). */
export interface HostSimBootHost {
  /** plan names of the host `config.policy`; undefined = the host has no policy (refused) */
  policyPlanNames: readonly string[] | undefined;
  /** host `config.housekeepingMs` (the adapter housekeeping may not run faster) */
  housekeepingMs: number;
}

export interface HostSimBootDeps {
  clock?: Clock;
  /** process liveness probe for stale-lock detection (tests); default `process.kill(pid, 0)` */
  alive?: (pid: number) => boolean;
  /** effective uid the state directory must belong to; default `process.getuid()` */
  uid?: number;
  /** test hooks into the lock protocol (interleaving simulation) */
  lockHooks?: StateLockHooks;
  /** s3d-6: boot compaction threshold (events); default DEFAULT_SIM_COMPACT_EVENTS */
  compactAfterEvents?: number;
  /** s3d-6 test hook: replaces the pre-compaction copy (to simulate a failing copy) */
  copyJournal?: (from: string, to: string) => void;
}

export interface StateLockHooks {
  /** runs after a dead-pid lock was read and before the takeover mutex is taken */
  beforeTakeover?: () => void;
}

export interface HostSimLock {
  readonly path: string;
  /** removes the lock file if it is still this process's lock; idempotent */
  release(): void;
}

export interface HostSimPlans {
  adapter: SimHostAdapter;
  config: PlansConfig;
  /** policy plan name -> PlanId (every policy plan name is mapped; checked at boot) */
  planMap: ReadonlyMap<string, PlanId>;
  beatMs: number;
  housekeepingMs: number;
  pollAfterS: number;
  lock: HostSimLock;
  /** s3d-6: what boot recovery did (counts and a file name only; logged by main.ts) */
  boot: HostSimBootReport;
}

export interface HostSimBootReport {
  /** meter sessions of a previous process closed with reason 'host' */
  recovered: number;
  /**
   * compaction at boot: 'no' (below the threshold or sessions open), 'done' (with the copy's file
   * name, inside the state dir), or 'copy_failed' (the copy could not be written: no compaction)
   */
  compaction: { kind: 'no' } | { kind: 'done'; copy: string } | { kind: 'copy_failed' };
}

/** `sim-journal.log.<UTC time>.pre-compact`; the time has no ':' or '.' (safe file name). */
export function preCompactName(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return `${SIM_JOURNAL_FILE}.${stamp}${PRE_COMPACT_SUFFIX}`;
}

/** Copy `from` to `to` without ever overwriting (COPYFILE_EXCL), then fsync the copy and its directory. */
export function durableCopy(from: string, to: string): void {
  copyFileSync(from, to, fsc.COPYFILE_EXCL);
  for (const [p, flags] of [
    [to, 'r'],
    [join(to, '..'), 'r'],
  ] as const) {
    const fd = openSync(p, flags);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

const POLICY_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Strict plan-map parser: `name=planId` pairs separated by commas, optional spaces around tokens.
 * Refuses empty input, empty pairs, duplicate names, malformed names and unknown PlanIds.
 */
export function parsePlanMap(raw: string): Map<string, PlanId> {
  const out = new Map<string, PlanId>();
  if (raw.trim() === '') throw new HostSimBootError('TBI_HOST_SIM_PLAN_MAP: empty');
  for (const pair of raw.split(',')) {
    const m = /^\s*([^=\s]+)\s*=\s*([^=\s]+)\s*$/.exec(pair);
    if (!m) throw new HostSimBootError('TBI_HOST_SIM_PLAN_MAP: malformed pair (want name=plan)');
    const [, name, plan] = m as unknown as [string, string, string];
    if (!POLICY_NAME.test(name))
      throw new HostSimBootError('TBI_HOST_SIM_PLAN_MAP: malformed policy plan name');
    if (!(PLAN_IDS as readonly string[]).includes(plan))
      throw new HostSimBootError('TBI_HOST_SIM_PLAN_MAP: unknown plan id');
    if (out.has(name)) throw new HostSimBootError('TBI_HOST_SIM_PLAN_MAP: duplicate policy plan');
    out.set(name, plan as PlanId);
  }
  return out;
}

function intFlag(env: Record<string, string | undefined>, name: string, dflt: number): number {
  const v = env[name];
  if (v === undefined) return dflt;
  if (!/^\d{1,15}$/.test(v)) throw new HostSimBootError(`${name}: must be a whole number`);
  return Number(v);
}

const isPid = (s: string) => /^[1-9]\d{0,9}$/.test(s);

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists (another user). Only ESRCH proves it is gone.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** O_EXCL-creates `path` holding `content`; false on EEXIST, HostSimBootError on anything else. */
function createExclusive(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new HostSimBootError('sim state lock unusable; refusing to start');
  }
  try {
    writeSync(fd, content);
  } catch {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      /* best effort; an empty file reads as malformed and refuses */
    }
    throw new HostSimBootError('sim state lock unusable; refusing to start');
  }
  closeSync(fd);
  return true;
}

/** lock file content, or null when it does not exist; HostSimBootError when unreadable */
function readLock(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new HostSimBootError('sim state lock unreadable; refusing to start');
  }
}

const LOCK_HELD = 'sim state directory is locked by another host; refusing to start';
const LOCK_MALFORMED = 'sim state lock malformed; remove it by hand; refusing to start';

/** How an existing lock's content is judged (shared by acquireStateLock and inspectStateLock). */
function classifyLock(
  held: string,
  mine: string,
  alive: (pid: number) => boolean,
): 'malformed' | 'held' | 'stale' {
  if (!isPid(held)) return 'malformed';
  if (held === mine || alive(Number(held))) return 'held';
  return 'stale';
}

/**
 * s3d-8 (offline validator): what acquireStateLock would decide about the existing lock, READ ONLY
 * (nothing created, removed or locked). A problem is returned only where acquireStateLock would refuse:
 * a malformed or unreadable lock, a lock of a live process, a stale lock with a takeover mutex left
 * behind. No lock, or a stale one without a mutex (taken over at boot), is not a problem.
 */
export function inspectStateLock(
  dir: string,
  alive: (pid: number) => boolean = defaultAlive,
): SimProblem[] {
  let held: string | null;
  try {
    held = readLock(join(dir, SIM_LOCK_FILE));
  } catch (e) {
    return [{ code: 'state_lock', message: (e as Error).message }];
  }
  if (held === null) return [];
  const kind = classifyLock(held, String(process.pid), alive);
  if (kind === 'malformed') return [{ code: 'state_lock', message: LOCK_MALFORMED }];
  if (kind === 'held')
    return [{ code: 'state_locked', message: LOCK_HELD, detail: 'a live process holds host.lock' }];
  let mutex: string | null;
  try {
    mutex = readLock(join(dir, SIM_LOCK_TAKEOVER_FILE));
  } catch {
    mutex = '';
  }
  if (mutex !== null)
    return [
      {
        code: 'state_lock',
        message: `sim state lock takeover mutex is stale or malformed; remove ${SIM_LOCK_TAKEOVER_FILE} by hand; refusing to start`,
        detail: `stale host.lock and a leftover ${SIM_LOCK_TAKEOVER_FILE}`,
      },
    ];
  return [];
}

/**
 * Exclusive lock on the state directory: `host.lock` created with O_EXCL holding this pid.
 * An existing lock refuses, unless its pid is provably gone (stale after a crash). The takeover
 * (re-read, unlink, create) runs under a second O_EXCL mutex `host.lock.takeover`, so two hosts
 * that both saw the same dead pid cannot both own the lock: the second one re-reads under the
 * mutex, finds the first one's pid and refuses. The mutex is only ever removed by its holder; a
 * mutex left by a crashed holder refuses with an operator message (never taken over automatically).
 * Unreadable or malformed lock content refuses (an operator removes it).
 */
export function acquireStateLock(
  dir: string,
  alive: (pid: number) => boolean = defaultAlive,
  hooks: StateLockHooks = {},
): HostSimLock {
  const path = join(dir, SIM_LOCK_FILE);
  const mutex = join(dir, SIM_LOCK_TAKEOVER_FILE);
  const mine = String(process.pid);
  const locked = () => new HostSimBootError(LOCK_HELD);

  /** runs fn holding the takeover mutex; HostSimBootError when another holder has it */
  const withMutex = <T>(fn: () => T): T => {
    if (!createExclusive(mutex, `${mine}\n`)) {
      const holder = readLock(mutex);
      // gone again or still empty: its holder is between create/write and unlink right now
      if (
        holder === null ||
        holder === '' ||
        (isPid(holder) && holder !== mine && alive(Number(holder)))
      )
        throw new HostSimBootError(
          `sim state lock takeover in progress by another host (if it persists, remove ${SIM_LOCK_TAKEOVER_FILE} by hand); refusing`,
        );
      throw new HostSimBootError(
        `sim state lock takeover mutex is stale or malformed; remove ${SIM_LOCK_TAKEOVER_FILE} by hand; refusing to start`,
      );
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(mutex);
      } catch {
        /* gone already: nothing else removes a mutex it does not hold */
      }
    }
  };

  if (!createExclusive(path, `${mine}\n`)) {
    const held = readLock(path);
    if (held !== null) {
      const kind = classifyLock(held, mine, alive);
      if (kind === 'malformed') throw new HostSimBootError(LOCK_MALFORMED);
      if (kind === 'held') throw locked();
    }
    hooks.beforeTakeover?.();
    withMutex(() => {
      const now = readLock(path);
      if (now !== null) {
        // someone else took over (or locked) since we looked: never remove their lock
        if (now !== held) throw locked();
        try {
          unlinkSync(path);
        } catch {
          throw new HostSimBootError('sim state lock stale but not removable; refusing to start');
        }
      }
      if (!createExclusive(path, `${mine}\n`)) throw locked();
    });
  }
  let released = false;
  return {
    path,
    /**
     * Removes the lock under the takeover mutex if it still holds our pid. When the mutex is held
     * by someone else the lock is left in place: our pid is gone after exit, so it is a stale lock
     * the next host takes over. Idempotent; never throws.
     */
    release() {
      if (released) return;
      released = true;
      try {
        withMutex(() => {
          if (readLock(path) === mine) unlinkSync(path);
        });
      } catch {
        /* mutex busy, or already gone */
      }
    },
  };
}

/** The state directory must exist (created 0700 if absent), be a real directory, ours, mode 0700. */
export function checkStateDir(dir: string, uid: number | undefined): void {
  const first = stateDirProblems(dir, uid, { create: true })[0];
  if (first) throw new HostSimBootError(first.message);
}

/**
 * The state-directory rules of checkStateDir as a list (s3d-8: the offline validator reports them all
 * at once; checkStateDir throws the first, so host and validator share one rule set). `create: false`
 * never creates anything: a missing directory is the problem `state_dir_missing` (the host would
 * create it 0700). Order is the host's refusal order.
 */
export function stateDirProblems(
  dir: string,
  uid: number | undefined,
  opts: { create: boolean },
): SimProblem[] {
  // `link/` and `link/.` make lstat follow a symlink: only the exact absolute normalised path is taken.
  if (!isAbsolute(dir) || resolve(dir) !== dir)
    return [
      {
        code: 'state_dir_path',
        message: 'TBI_HOST_SIM_PLANS_STATE must be an absolute normalised path; refusing to start',
      },
    ];
  const unusable: SimProblem = {
    code: 'state_dir_unusable',
    message: 'TBI_HOST_SIM_PLANS_STATE unusable; refusing to start',
  };
  let st: ReturnType<typeof lstatSync>;
  try {
    if (opts.create) mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
  } catch (e) {
    if (!opts.create && (e as NodeJS.ErrnoException).code === 'ENOENT')
      return [
        {
          code: 'state_dir_missing',
          message:
            'TBI_HOST_SIM_PLANS_STATE does not exist (the host would create it 0700; create it beforehand)',
        },
      ];
    return [unusable];
  }
  if (!st.isDirectory())
    return [
      {
        code: 'state_dir_not_dir',
        message: 'TBI_HOST_SIM_PLANS_STATE is not a directory; refusing to start',
      },
    ];
  const out: SimProblem[] = [];
  if (uid !== undefined && st.uid !== uid)
    out.push({
      code: 'state_dir_owner',
      message: 'TBI_HOST_SIM_PLANS_STATE not owned by the host user; refusing',
    });
  if ((st.mode & 0o777) !== 0o700)
    out.push({
      code: 'state_dir_mode',
      message: 'TBI_HOST_SIM_PLANS_STATE mode must be 0700; refusing to start',
      detail: (st.mode & 0o077) !== 0 ? 'group/world can access it' : 'owner bits are not rwx',
    });
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return [...out, unusable];
  }
  if (real !== dir)
    out.push({
      code: 'state_dir_symlink',
      message: 'TBI_HOST_SIM_PLANS_STATE has a symlinked parent; refusing to start',
    });
  return out;
}

/**
 * Reads the plans config: must be a regular file (checked on the open fd, so no FIFO/device read
 * and no swap after the check) of at most MAX_SIM_CONFIG_BYTES. O_NONBLOCK keeps a FIFO from
 * blocking the open.
 */
function readConfigFile(file: string): string {
  const fd = openSync(file, fsc.O_RDONLY | fsc.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new HostSimBootError('sim plans config is not a regular file');
    if (st.size > MAX_SIM_CONFIG_BYTES) throw new HostSimBootError('sim plans config too large');
    const buf = Buffer.alloc(MAX_SIM_CONFIG_BYTES + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > MAX_SIM_CONFIG_BYTES) throw new HostSimBootError('sim plans config too large');
    }
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const hasMinuteCaps = (cfg: PlansConfig) =>
  PLAN_IDS.some(
    (p) => cfg.sim.plans[p].monthlyMinutes !== null || cfg.sim.plans[p].dailyMinutes !== null,
  );

/** s3d-8: problem classes shared by the host boot and the offline validator (validateconfig.ts). */
export type SimProblemCode =
  | 'flags_partial'
  | 'flag_not_integer'
  | 'config_missing'
  | 'config_unusable'
  | 'metering_disabled'
  | 'host_lease_invalid'
  | 'lease_mismatch'
  | 'lift_until_first_paid'
  | 'max_concurrent'
  | 'no_policy'
  | 'policy_unusable'
  | 'plan_map_invalid'
  | 'plan_map_unmapped'
  | 'plan_map_unknown_policy_plan'
  | 'bound_beat'
  | 'bound_housekeeping'
  | 'bound_poll'
  | 'sim_bounds'
  | 'state_dir_path'
  | 'state_dir_missing'
  | 'state_dir_unusable'
  | 'state_dir_not_dir'
  | 'state_dir_owner'
  | 'state_dir_mode'
  | 'state_dir_symlink'
  | 'state_dir_not_writable'
  | 'state_lock'
  | 'state_locked'
  | 'journal_torn'
  | 'journal_corrupt';

/**
 * One problem. `message` is the host's refusal text (flag names only, never a value or path);
 * `detail` is an optional validator-only hint under the same rule (never file content or a value).
 */
export interface SimProblem {
  code: SimProblemCode;
  message: string;
  detail?: string;
}

export interface SimFlagCheck {
  /** every problem found, in the host's refusal order (the host refuses with the first) */
  problems: SimProblem[];
  /** the checked values, present only when there is no problem */
  ok?: {
    cfg: PlansConfig;
    planMap: Map<string, PlanId>;
    beatMs: number;
    housekeepingMs: number;
    pollAfterS: number;
    dir: string;
  };
}

/** A safe hint for a config read/parse failure: an errno code, "not valid JSON", or a key path. */
function configDetail(e: unknown): string | undefined {
  if (e instanceof HostSimBootError) return undefined;
  if (e instanceof SyntaxError) return 'not valid JSON';
  if (e instanceof ConfigError)
    // the key path is built from known keys, except an unknown key (file content): name none
    return / unknown config key$/.test(e.message) ? 'an unknown config key' : e.message;
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : undefined;
}

/**
 * s3d-8: the flag and config checks of bootSimPlans, collected instead of thrown (bootSimPlans throws
 * the first, in the same order and with the same text as before; the offline validator reports all).
 * Reads only the config file; never touches the state directory. Undefined = no sim flag set.
 * A check that depends on an earlier failed value (e.g. the config) is skipped, never guessed.
 */
export function checkSimFlags(
  env: Record<string, string | undefined>,
  hostLeaseMs: number,
  host: HostSimBootHost,
): SimFlagCheck | undefined {
  const problems: SimProblem[] = [];
  const add = (code: SimProblemCode, message: string, detail?: string) =>
    problems.push(detail === undefined ? { code, message } : { code, message, detail });
  const file = env.TBI_HOST_SIM_PLANS_CONFIG;
  if (file === undefined) {
    const stray = HOST_SIM_FLAGS.filter((f) => env[f] !== undefined);
    if (stray.length === 0) return undefined;
    add(
      'flags_partial',
      `${stray.join(', ')} set without TBI_HOST_SIM_PLANS_CONFIG; refusing to start`,
    );
    return { problems };
  }
  let cfg: PlansConfig | undefined;
  try {
    cfg = parseConfig(JSON.parse(readConfigFile(file)));
  } catch (e) {
    const why =
      e instanceof HostSimBootError
        ? e.message.replace(/^sim plans config /, '')
        : e instanceof Error
          ? e.constructor.name
          : 'error';
    const missing = (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    add(
      missing ? 'config_missing' : 'config_unusable',
      `sim plans config unusable (${why}); refusing to start`,
      configDetail(e),
    );
  }
  if (cfg && !cfg.metering.enabled)
    add('metering_disabled', 'sim plans config opted in but metering.enabled is not true');
  const leaseOk = Number.isSafeInteger(hostLeaseMs) && hostLeaseMs >= 1;
  if (!leaseOk) add('host_lease_invalid', 'host leaseMs invalid; refusing to start');
  if (cfg) {
    if (leaseOk && cfg.sim.leaseMs !== hostLeaseMs)
      add('lease_mismatch', 'sim.leaseMs must equal the host lease (TBI_HOST_LEASE_MS)');
    if (cfg.queue.freeCapMode !== 'fixed')
      add(
        'lift_until_first_paid',
        'queue.freeCapMode must be fixed on the host (liftUntilFirstPaid)',
      );
    if (cfg.sim.maxConcurrentPerPrincipal !== 1 && hasMinuteCaps(cfg))
      add('max_concurrent', 'sim.maxConcurrentPerPrincipal must be 1 while minute caps apply');
  }
  const names = host.policyPlanNames;
  const hasNames = !!names && names.length > 0;
  if (!hasNames) add('no_policy', 'sim metering needs a host policy; refusing to start');

  const rawMap = env.TBI_HOST_SIM_PLAN_MAP;
  let planMap: Map<string, PlanId> | undefined;
  if (rawMap === undefined) add('flags_partial', 'TBI_HOST_SIM_PLAN_MAP is required');
  else {
    try {
      planMap = parsePlanMap(rawMap);
    } catch (e) {
      add('plan_map_invalid', (e as Error).message);
    }
  }
  if (planMap && hasNames) {
    if (names.some((n) => !planMap.has(n)))
      add('plan_map_unmapped', 'TBI_HOST_SIM_PLAN_MAP: a policy plan is not mapped');
    if ([...planMap.keys()].some((n) => !names.includes(n)))
      add(
        'plan_map_unknown_policy_plan',
        'TBI_HOST_SIM_PLAN_MAP: names a plan the policy does not have',
      );
  }

  const int = (name: string, dflt: number): number | undefined => {
    try {
      return intFlag(env, name, dflt);
    } catch (e) {
      add('flag_not_integer', (e as Error).message);
      return undefined;
    }
  };
  const beatMs = int('TBI_HOST_SIM_BEAT_MS', Math.floor(hostLeaseMs / 3));
  if (leaseOk && beatMs !== undefined && (beatMs < 1 || beatMs >= hostLeaseMs))
    add('bound_beat', 'TBI_HOST_SIM_BEAT_MS: must be >= 1 and < the host lease');
  const housekeepingMs = int('TBI_HOST_SIM_HOUSEKEEPING_MS', DEFAULT_SIM_HOUSEKEEPING_MS);
  if (housekeepingMs !== undefined && (housekeepingMs < 1 || housekeepingMs < host.housekeepingMs))
    add('bound_housekeeping', 'TBI_HOST_SIM_HOUSEKEEPING_MS: below the host housekeeping');
  const pollAfterS = int('TBI_HOST_SIM_POLL_S', DEFAULT_SIM_POLL_S);
  if (
    pollAfterS !== undefined &&
    (pollAfterS < 1 || (cfg !== undefined && pollAfterS * 1000 >= cfg.queue.vanishMs))
  )
    add('bound_poll', 'TBI_HOST_SIM_POLL_S: must be >= 1 and below queue.vanishMs');

  const dir = env.TBI_HOST_SIM_PLANS_STATE;
  if (dir === undefined || dir === '') add('flags_partial', 'TBI_HOST_SIM_PLANS_STATE is required');
  if (problems.length > 0 || !cfg || !planMap || dir === undefined) return { problems };
  return {
    problems,
    ok: {
      cfg,
      planMap,
      beatMs: beatMs!,
      housekeepingMs: housekeepingMs!,
      pollAfterS: pollAfterS!,
      dir,
    },
  };
}

/**
 * Builds the host's sim adapter from the environment, or undefined when TBI_HOST_SIM_PLANS_CONFIG is
 * unset and no other sim flag is set (nothing read, nothing created). All config checks run before
 * the state directory is touched; the lock is taken before the journal is opened and released again
 * if opening fails.
 */
export async function bootSimPlans(
  env: Record<string, string | undefined>,
  hostLeaseMs: number,
  host: HostSimBootHost,
  deps: HostSimBootDeps = {},
): Promise<HostSimPlans | undefined> {
  const c = checkSimFlags(env, hostLeaseMs, host);
  if (!c) return undefined;
  const first = c.problems[0];
  if (first || !c.ok) throw new HostSimBootError(first?.message ?? 'sim plans flags invalid');
  const { cfg, planMap, beatMs, housekeepingMs, pollAfterS, dir } = c.ok;
  checkStateDir(dir, deps.uid ?? process.getuid?.());
  const lock = acquireStateLock(dir, deps.alive, deps.lockHooks);
  try {
    const adapter = await SimHostAdapter.open(
      new JournalStore<SimEvent>(join(dir, SIM_JOURNAL_FILE)),
      {
        config: cfg,
        clock: clockOf(deps),
        freePaused: () => freePausedAt(join(dir, FREE_PAUSE_FILE)),
      },
    );
    // A torn or corrupt journal: refuse (design §7, O-7); never repaired automatically.
    if (adapter.storeProblem) throw new Error('journal problem');
    // s3d-6 recovery: no run of a previous process survives (the caller stopped the old runtimes
    // before this point), so every meter session still open is closed with 'host'.
    const rec = await adapter.recoverAtBoot();
    if (!rec.metered || !rec.ok) throw new Error('recovery failed');
    const compaction = await compactAtBoot(adapter, dir, deps, clockOf(deps));
    if (adapter.storeProblem) throw new Error('journal problem after compaction');
    return {
      adapter,
      config: cfg,
      planMap,
      beatMs,
      housekeepingMs,
      pollAfterS,
      lock,
      boot: { recovered: rec.closed, compaction },
    };
  } catch {
    lock.release();
    throw new HostSimBootError('sim plans state unusable; refusing to start');
  }
}

const clockOf = (deps: HostSimBootDeps): Clock => deps.clock ?? { now: () => Date.now() };

/**
 * s3d-6 boot compaction (design §7, M5): only past the threshold and only when no session is open. The
 * journal is first copied to a timestamped `.pre-compact` file that is never overwritten or deleted
 * automatically (retention is an owner decision, m11). A failed copy skips the compaction (the journal
 * is untouched, boot continues). A failed compaction leaves the meter failed closed (storeProblem):
 * the caller refuses to start; the journal on disk is the old or the new one (atomic replace).
 */
async function compactAtBoot(
  adapter: SimHostAdapter,
  dir: string,
  deps: HostSimBootDeps,
  clock: Clock,
): Promise<HostSimBootReport['compaction']> {
  const limit = deps.compactAfterEvents ?? DEFAULT_SIM_COMPACT_EVENTS;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('bad compaction threshold');
  if (adapter.journalSeq <= limit || adapter.openMeterSessions > 0 || adapter.tracked > 0)
    return { kind: 'no' };
  const now = clock.now();
  if (!Number.isFinite(now)) return { kind: 'no' };
  const copy = preCompactName(now);
  try {
    (deps.copyJournal ?? durableCopy)(join(dir, SIM_JOURNAL_FILE), join(dir, copy));
  } catch {
    return { kind: 'copy_failed' };
  }
  const r = await adapter.compactAtBoot();
  if (!r.metered || !r.ok) throw new Error('compaction failed');
  return r.skipped ? { kind: 'no' } : { kind: 'done', copy };
}
