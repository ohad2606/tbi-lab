/**
 * TBI-018 s3d-1: opt-in construction of the sim-minutes adapter for the Session Host (design
 * docs/plans/S3D-HOST-WIRING-DESIGN.md §9, state directory rules §7). NOT wired: `runtime/host/main.ts`
 * still refuses to start while any flag is set (hostflags.ts); this module exists so the checks are
 * in place and tested before any wiring slice.
 *
 *   TBI_HOST_SIM_PLANS_CONFIG     plans config file (strict parseConfig). Unset: no adapter, nothing read.
 *   TBI_HOST_SIM_PLANS_STATE      journal directory, required (no default under another service's state)
 *   TBI_HOST_SIM_PLAN_MAP         `preview=legacy,system=legacy`: host policy plan name -> PlanId
 *   TBI_HOST_SIM_BEAT_MS          beat interval, default floor(leaseMs / 3); 1 <= v < leaseMs
 *   TBI_HOST_SIM_HOUSEKEEPING_MS  adapter housekeeping, default 5000; >= host housekeepingMs
 *   TBI_HOST_SIM_POLL_S           pollAfterS for a 202, default 15; v * 1000 < queue.vanishMs
 *
 * Every refusal throws HostSimBootError (fail closed). Messages carry flag names only: never file
 * content, paths, values or principals.
 */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseConfig, PLAN_IDS, type PlanId, type PlansConfig } from './config.js';
import { HOST_SIM_FLAGS } from './hostflags.js';
import type { SimEvent } from './simminutes.js';
import { SimHostAdapter } from './simhost.js';
import { JournalStore } from './store.js';
import type { Clock } from './time.js';

export class HostSimBootError extends Error {}

export const SIM_JOURNAL_FILE = 'sim-journal.log';
export const SIM_LOCK_FILE = 'host.lock';
export const DEFAULT_SIM_HOUSEKEEPING_MS = 5000;
export const DEFAULT_SIM_POLL_S = 15;

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

/**
 * Exclusive lock on the state directory: `host.lock` created with O_EXCL holding this pid.
 * An existing lock refuses, unless its pid is provably gone (stale after a crash): then it is
 * removed and taken once. Unreadable or malformed lock content refuses (an operator removes it).
 */
export function acquireStateLock(
  dir: string,
  alive: (pid: number) => boolean = defaultAlive,
): HostSimLock {
  const path = join(dir, SIM_LOCK_FILE);
  const mine = String(process.pid);
  const create = (): boolean => {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw new HostSimBootError('sim state lock unusable; refusing to start');
    }
    try {
      writeSync(fd, `${mine}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  };
  if (!create()) {
    let held: string;
    try {
      held = readFileSync(path, 'utf8').trim();
    } catch {
      throw new HostSimBootError('sim state lock unreadable; refusing to start');
    }
    if (!isPid(held))
      throw new HostSimBootError('sim state lock malformed; remove it by hand; refusing to start');
    if (held === mine || alive(Number(held)))
      throw new HostSimBootError(
        'sim state directory is locked by another host; refusing to start',
      );
    try {
      unlinkSync(path);
    } catch {
      throw new HostSimBootError('sim state lock stale but not removable; refusing to start');
    }
    if (!create())
      throw new HostSimBootError(
        'sim state directory is locked by another host; refusing to start',
      );
  }
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        if (readFileSync(path, 'utf8').trim() === mine) unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}

/** The state directory must exist (created 0700 if absent), be a real directory, ours, mode 0700. */
function checkStateDir(dir: string, uid: number | undefined): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new HostSimBootError('TBI_HOST_SIM_PLANS_STATE unusable; refusing to start');
  }
  const st = lstatSync(dir);
  if (!st.isDirectory())
    throw new HostSimBootError('TBI_HOST_SIM_PLANS_STATE is not a directory; refusing to start');
  if (uid !== undefined && st.uid !== uid)
    throw new HostSimBootError('TBI_HOST_SIM_PLANS_STATE not owned by the host user; refusing');
  if ((st.mode & 0o777) !== 0o700)
    throw new HostSimBootError('TBI_HOST_SIM_PLANS_STATE mode must be 0700; refusing to start');
}

const hasMinuteCaps = (cfg: PlansConfig) =>
  PLAN_IDS.some(
    (p) => cfg.sim.plans[p].monthlyMinutes !== null || cfg.sim.plans[p].dailyMinutes !== null,
  );

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
  const file = env.TBI_HOST_SIM_PLANS_CONFIG;
  if (file === undefined) {
    const stray = HOST_SIM_FLAGS.filter((f) => env[f] !== undefined);
    if (stray.length > 0)
      throw new HostSimBootError(
        `${stray.join(', ')} set without TBI_HOST_SIM_PLANS_CONFIG; refusing to start`,
      );
    return undefined;
  }
  let cfg: PlansConfig;
  try {
    cfg = parseConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    const why = e instanceof Error ? e.constructor.name : 'error';
    throw new HostSimBootError(`sim plans config unusable (${why}); refusing to start`);
  }
  if (!cfg.metering.enabled)
    throw new HostSimBootError('sim plans config opted in but metering.enabled is not true');
  if (!Number.isSafeInteger(hostLeaseMs) || hostLeaseMs < 1)
    throw new HostSimBootError('host leaseMs invalid; refusing to start');
  if (cfg.sim.leaseMs !== hostLeaseMs)
    throw new HostSimBootError('sim.leaseMs must equal the host lease (TBI_HOST_LEASE_MS)');
  if (cfg.queue.freeCapMode !== 'fixed')
    throw new HostSimBootError('queue.freeCapMode must be fixed on the host (liftUntilFirstPaid)');
  if (cfg.sim.maxConcurrentPerPrincipal !== 1 && hasMinuteCaps(cfg))
    throw new HostSimBootError('sim.maxConcurrentPerPrincipal must be 1 while minute caps apply');
  const names = host.policyPlanNames;
  if (!names || names.length === 0)
    throw new HostSimBootError('sim metering needs a host policy; refusing to start');

  const rawMap = env.TBI_HOST_SIM_PLAN_MAP;
  if (rawMap === undefined) throw new HostSimBootError('TBI_HOST_SIM_PLAN_MAP is required');
  const planMap = parsePlanMap(rawMap);
  for (const n of names)
    if (!planMap.has(n))
      throw new HostSimBootError('TBI_HOST_SIM_PLAN_MAP: a policy plan is not mapped');
  for (const n of planMap.keys())
    if (!names.includes(n))
      throw new HostSimBootError('TBI_HOST_SIM_PLAN_MAP: names a plan the policy does not have');

  const beatMs = intFlag(env, 'TBI_HOST_SIM_BEAT_MS', Math.floor(hostLeaseMs / 3));
  if (beatMs < 1 || beatMs >= hostLeaseMs)
    throw new HostSimBootError('TBI_HOST_SIM_BEAT_MS: must be >= 1 and < the host lease');
  const housekeepingMs = intFlag(env, 'TBI_HOST_SIM_HOUSEKEEPING_MS', DEFAULT_SIM_HOUSEKEEPING_MS);
  if (housekeepingMs < 1 || housekeepingMs < host.housekeepingMs)
    throw new HostSimBootError('TBI_HOST_SIM_HOUSEKEEPING_MS: below the host housekeeping');
  const pollAfterS = intFlag(env, 'TBI_HOST_SIM_POLL_S', DEFAULT_SIM_POLL_S);
  if (pollAfterS < 1 || pollAfterS * 1000 >= cfg.queue.vanishMs)
    throw new HostSimBootError('TBI_HOST_SIM_POLL_S: must be >= 1 and below queue.vanishMs');

  const dir = env.TBI_HOST_SIM_PLANS_STATE;
  if (dir === undefined || dir === '')
    throw new HostSimBootError('TBI_HOST_SIM_PLANS_STATE is required');
  checkStateDir(dir, deps.uid ?? process.getuid?.());
  const lock = acquireStateLock(dir, deps.alive);
  try {
    const adapter = await SimHostAdapter.open(
      new JournalStore<SimEvent>(join(dir, SIM_JOURNAL_FILE)),
      {
        config: cfg,
        clock: deps.clock ?? { now: () => Date.now() },
      },
    );
    // A torn or corrupt journal: refuse (design §7, O-7); never repaired automatically.
    if (adapter.storeProblem) throw new Error('journal problem');
    return { adapter, config: cfg, planMap, beatMs, housekeepingMs, pollAfterS, lock };
  } catch {
    lock.release();
    throw new HostSimBootError('sim plans state unusable; refusing to start');
  }
}
