/**
 * Run guard of the BETA-G2 queue load harness (g2-deployed.runtime.test.ts). Pure decision logic, so
 * the refusal is unit-tested offline (scripts/tests/g2-deployed-guard.test.mjs, normal vitest suite).
 *
 * The harness creates and removes `free-admission.paused` and drives 17 identities (15 Free, 2
 * preview) against one instance. It may therefore run ONLY against the staging instance, and only with the opt-in naming it
 * in the mutation gate (TBI_ALLOW_SERVICE_MUTATION=tbi-s8) while the pipeline lock is held. Anything
 * else is a refusal, never a skip: a green run that silently did nothing would be a false result.
 *
 *   off      TBI_G2_DEPLOYED is not set: the file is excluded from the run, like the other deployed tests.
 *   refused  the opt-in is set but the run is not allowed or not configured: the test FAILS with `reason`.
 *   run      all conditions hold.
 */
import { allowedTargets, holdsPipelineLock, MUTATION_ENV } from './mutation-gate.js';

/** The only instance this harness may target. Never the production instance and never DEV-Lab. */
export const G2_STAGING = 'tbi-s8';
export const G2_ENV = 'TBI_G2_DEPLOYED';
export const G2_PREVIEW_ENV = 'TBI_G2_PREVIEW_USERS';
/** Free users 4 (plan cap) + preview 2 = 6 live; 10 more Free queue. */
export const G2_FREE_LIVE = 4;
export const G2_PREVIEW = 2;
export const G2_QUEUED = 10;
/** Index of the extra Free identity the pause drill uses: neither live nor queued. */
export const G2_PAUSE_PROBE = G2_FREE_LIVE + G2_QUEUED;
export const g2FreeUsers = (run: string): string[] =>
  Array.from({ length: G2_PAUSE_PROBE + 1 }, (_, i) => `g2d-${run}-f${i}`);
/**
 * Deadline for `waiting` = 0 after the pause file is created. Waiters leave only on an admit that
 * reaches the adapter or on its housekeeping pass (docs/plans/BETA-G2-FREE-LIMITS.md section 2:
 * default 5 s, driven by the 250 ms host timer); the rest is slack for the pass and the health read.
 */
export const G2_PAUSE_REMOVAL_MS = 10_000;

const realClock = {
  now: () => performance.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

/** Poll until `done(value)` is read no later than `deadlineAt` (clock ms), else ok = false. */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  deadlineAt: number,
  clock = realClock,
  intervalMs = 500,
): Promise<{ ok: boolean; value: T; atMs: number }> {
  for (;;) {
    const value = await read();
    const atMs = clock.now();
    const ok = done(value) && atMs <= deadlineAt;
    if (ok || atMs >= deadlineAt) return { ok, value, atMs };
    await clock.sleep(Math.min(intervalMs, deadlineAt - atMs));
  }
}

export interface G2Progress {
  instance: string;
  phase: string;
  seconds: number;
  admitted: number[];
  builds: { status: number; ms: number }[];
  promotedPositions: number[];
  samples: { freeLive: number; hostLive: number }[];
}

/** Partial report of a failed run: listed fields only, so no principal, token or ticket gets in. */
export function g2FailedReport(p: G2Progress) {
  const max = (k: 'freeLive' | 'hostLive') =>
    p.samples.length ? Math.max(...p.samples.map((s) => s[k])) : null;
  return {
    result: 'FAILED',
    instance: p.instance,
    failedPhase: p.phase,
    seconds: p.seconds,
    admitted: [...p.admitted],
    builds: p.builds.map(({ status, ms }) => ({ status, ms })),
    promotedPositions: [...p.promotedPositions],
    maxFreeLive: max('freeLive'),
    maxHostLive: max('hostLive'),
  };
}

export type G2Decision =
  | { kind: 'off' }
  | { kind: 'refused'; reason: string }
  | { kind: 'run'; instance: string; previewUsers: string[] };

export function g2Decision(
  env: NodeJS.ProcessEnv = process.env,
  holdsLock: () => boolean = holdsPipelineLock,
): G2Decision {
  const instance = (env[G2_ENV] ?? '').trim();
  if (instance === '') return { kind: 'off' };
  if (instance !== G2_STAGING)
    return {
      kind: 'refused',
      reason: `${G2_ENV}=${instance}: this harness runs only against ${G2_STAGING} (never production or DEV-Lab)`,
    };
  if (!allowedTargets(env).includes(instance))
    return { kind: 'refused', reason: `${MUTATION_ENV} must name ${instance} (mutation gate)` };
  if (!holdsLock())
    return {
      kind: 'refused',
      reason: 'the pipeline lock is not held (deploy/ops/pipeline-lock.mjs check)',
    };
  const previewUsers = (env[G2_PREVIEW_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (previewUsers.length !== G2_PREVIEW)
    return {
      kind: 'refused',
      reason: `${G2_PREVIEW_ENV} must list exactly ${G2_PREVIEW} identities mapped to the preview plan on ${instance} (got ${previewUsers.length})`,
    };
  if (env.TBI_C5_WORKLOAD !== undefined && env.TBI_C5_WORKLOAD !== 'gpio')
    return { kind: 'refused', reason: 'TBI_C5_WORKLOAD must be gpio (light workload) or unset' };
  return { kind: 'run', instance, previewUsers };
}
