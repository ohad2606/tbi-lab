/**
 * Run guard of the BETA-G2 queue load harness (g2-deployed.runtime.test.ts). Pure decision logic, so
 * the refusal is unit-tested offline (scripts/tests/g2-deployed-guard.test.mjs, normal vitest suite).
 *
 * The harness creates and removes `free-admission.paused` and drives at most 30 identities (Free and
 * 2 preview) against one instance. It may therefore run ONLY against the staging instance, and only with the opt-in naming it
 * in the mutation gate (TBI_ALLOW_SERVICE_MUTATION=tbi-s8) while the pipeline lock is held. Anything
 * else (also any run with CI set) is a refusal, never a skip: a green run that silently did nothing would be a false result.
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
/**
 * Optional: further existing identities mapped to a paying plan (preview) on staging, comma separated.
 * Only the queue_full-at-maxLength drill uses them; without enough of them it is reported `not_run`.
 */
export const G2_PAYING_ENV = 'TBI_G2_EXTRA_PAYING_USERS';
/** Free users 4 (plan cap) + preview 2 = 6 live; 10 more Free queue. */
export const G2_FREE_LIVE = 4;
export const G2_PREVIEW = 2;
/** DEC-31: the idle limit the instance must report, and the allowed error of its end */
export const G2_IDLE_MS = 300_000;
export const G2_IDLE_TOLERANCE_MS = 2000;
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
  /** what stopped the run (auto-stop, manual stop file or signal) */
  autostop?: string;
  metrics?: Record<string, number>;
  flags?: string[];
  failures?: string[];
  /** the paid queue_full drill: `started` in a report means it did not pass; absent = not run */
  paidDrill?: 'started' | 'passed';
}

/** The only measured values a report may carry: numbers under these names. */
export const G2_METRICS = [
  'headPromotionGapS', 'idleMs', 'idleEndMs', 'idlePromotionMs', 'queueFullAccepted',
  'queueFullStatus', 'abandonMs', 'queueTimeoutMs', 'queueTimeoutStatus', 'build1WaitMs',
  'build2WaitMs', 'buildsSucceeded', 'buildsRefused', 'buildsFailed', 'buildsLost',
  'minLiveDuringBuilds', 'heldEndedEarly', 'sampleCount', 'sampleFailures', 'lastSamplerExit',
  'minMemAvailableMiB', 'maxLoad1', 'nproc', 'maxUnitMemoryRatio', 'hostPeakBytes',
  'buildPeakBytes', 'oomKills', 'kernelOomLines', 'maxQemuUnits', 'journalSessions',
  'journalBad', 'journalUnparsable', 'secretLeaks', 'leftoverLive', 'leftoverWaiting',
  'leftoverMetered', 'leftoverUnits', 'leftoverDirs', 'otherUnits', 'otherDirs',
  'unconfirmedCreates', 'unresolvedBuilds', 'deleteFailures', 'maxUnitCurrentRatio',
  'maxSampleGapMs', 'lockUnknown', 'idleStreamEnded', 'heldStreamOpenMs', 'heldStreamOk',
  'queueFullPaidNeeded', 'queueFullPaidGiven', 'queueFullPaidAccepted', 'queueFullPaidStatus',
] as const; // prettier-ignore
export const G2_FLAGS = ['dec32'] as const;
export const G2_FAILURES = [
  'mem_below_400',
  'queue_full_refused',
  'build_lost_or_failed',
  'builds_not_under_6_live',
  'held_session_ended',
  'leftovers',
  'leftover_check_failed',
  'delete_failed',
  'pause_file_not_removed',
  'journal_counts',
  'journal_unreadable',
  'secret_in_journal',
  'load_above_2x_cpus',
  'sampler_blind',
  'sample_gap',
] as const;
export type G2Failure = (typeof G2_FAILURES)[number];

/**
 * The drill only a run with enough extra paying identities covers: Free stops at maxFree < maxLength,
 * and the two preview identities hold seats. Listed as `notCovered` unless the run passed it.
 */
export const G2_PAID_DRILL = 'queue_full at maxLength with paid waiters';

/** Report of a run: listed fields only, so no principal, token, ticket or session id gets in. */
export function g2Report(p: G2Progress, result: 'PASSED' | 'FAILED') {
  const max = (k: 'freeLive' | 'hostLive') =>
    p.samples.length ? Math.max(...p.samples.map((s) => s[k])) : null;
  if (
    result === 'PASSED' &&
    ![p.metrics?.buildsSucceeded, p.metrics?.buildsRefused].every(Number.isFinite)
  )
    throw new Error('g2 report: PASSED needs the build counts');
  if (
    result === 'PASSED' &&
    !(
      p.metrics?.idleStreamEnded === 1 &&
      Number.isFinite(p.metrics.heldStreamOpenMs) &&
      p.metrics.heldStreamOpenMs! > G2_IDLE_MS + G2_IDLE_TOLERANCE_MS
    )
  )
    throw new Error('g2 report: PASSED needs the open event stream idle drill');
  // the duration alone says nothing: the stream must also have been found open and alive
  if (result === 'PASSED' && p.metrics?.heldStreamOk !== 1)
    throw new Error('g2 report: PASSED needs the held event stream verdict');
  if (result === 'PASSED' && (p.failures?.length || p.paidDrill === 'started'))
    throw new Error('g2 report: PASSED with a recorded failure or an unfinished drill');
  const paid = p.paidDrill === 'started' ? 'failed' : (p.paidDrill ?? 'not_run');
  return {
    result,
    instance: p.instance,
    ...(result === 'FAILED' ? { failedPhase: p.phase } : {}),
    ...(p.autostop ? { reason: `autostop:${p.autostop}` } : {}),
    metrics: Object.fromEntries(
      G2_METRICS.filter((k) => Number.isFinite(p.metrics?.[k])).map((k) => [k, p.metrics![k]]),
    ),
    flags: G2_FLAGS.filter((f) => p.flags?.includes(f)),
    failures: G2_FAILURES.filter((f) => p.failures?.includes(f)),
    queueFullAtMaxLength: paid,
    notCovered: paid === 'passed' ? [] : [G2_PAID_DRILL],
    seconds: p.seconds,
    admitted: [...p.admitted],
    builds: p.builds.map(({ status, ms }) => ({ status, ms })),
    promotedPositions: [...p.promotedPositions],
    maxFreeLive: max('freeLive'),
    maxHostLive: max('hostLive'),
  };
}
export const g2FailedReport = (p: G2Progress) => g2Report(p, 'FAILED');

export type G2Decision =
  | { kind: 'off' }
  | { kind: 'refused'; reason: string }
  | { kind: 'run'; instance: string; previewUsers: string[]; payingUsers: string[] };

export function g2Decision(
  env: NodeJS.ProcessEnv = process.env,
  holdsLock: () => boolean = () => holdsPipelineLock(),
): G2Decision {
  const instance = (env[G2_ENV] ?? '').trim();
  if (instance === '') return { kind: 'off' };
  if (env.CI !== undefined)
    return { kind: 'refused', reason: 'CI is set: this harness never runs unattended' };
  const drain = env.TBI_G2_SECONDS;
  if (drain !== undefined && !(/^\d+$/.test(drain) && Number(drain) > 0 && Number(drain) <= 3600))
    return { kind: 'refused', reason: 'TBI_G2_SECONDS must be 1..3600 or unset' };
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
  const list = (name: string) =>
    (env[name] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const previewUsers = list(G2_PREVIEW_ENV);
  if (previewUsers.length !== G2_PREVIEW)
    return {
      kind: 'refused',
      reason: `${G2_PREVIEW_ENV} must list exactly ${G2_PREVIEW} identities mapped to the preview plan on ${instance} (got ${previewUsers.length})`,
    };
  if (env.TBI_C5_WORKLOAD !== undefined && env.TBI_C5_WORKLOAD !== 'gpio')
    return { kind: 'refused', reason: 'TBI_C5_WORKLOAD must be gpio (light workload) or unset' };
  const payingUsers = list(G2_PAYING_ENV);
  // a repeated identity cannot wait twice, and a preview one already holds a seat
  if (new Set([...previewUsers, ...payingUsers]).size !== previewUsers.length + payingUsers.length)
    return {
      kind: 'refused',
      reason: `${G2_PREVIEW_ENV} and ${G2_PAYING_ENV} must not repeat an identity`,
    };
  return { kind: 'run', instance, previewUsers, payingUsers };
}
