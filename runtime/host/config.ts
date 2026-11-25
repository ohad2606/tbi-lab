/**
 * Session Host configuration (runtime R2). Every limit is an explicit engineering control with a
 * conservative default; none of them is a capacity claim. A client may only make a limit
 * stricter (protocol.ts `limits`), never looser.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RuntimeLauncher } from '../harness/launcher.js';
import type { Policy } from '../policy/policy.js';
import type { RateLimiter } from '../policy/rate.js';
import type { ResourceProbe } from '../policy/resources.js';
import type { PlanId } from '../plans/config.js';
import type { SimHostAdapter } from '../plans/simhost.js';
import type { TicketRegistry } from './queueTickets.js';
import type { DiagnosticsSink } from './diagnostics.js';
import { COMMAND_QUANTUM_US } from './protocol.js';

export interface HostConfig {
  /** Absolute path of the runtime executable. Fixed by the operator; never from a client. */
  qemu: string;
  /** Directory of immutable, content-addressed firmware artifacts (`<sha256>.bin`). */
  artifactsDir: string;
  /** Key shared with the build service: run tickets are verified with it (Sprint 8). */
  ticketKey: Buffer;
  /**
   * Sprint 8 containment: a fixed, disk-backed directory owned by this host that holds the
   * session directories (the sandboxed runtime unit binds `<sessionRoot>/s-<id>`). Unset: a
   * private per-process root under `tmpParent` (tests, development).
   */
  sessionRoot?: string;
  /** How QEMU is started (default: a direct child). The sandboxed unit in deployment. */
  launch?: RuntimeLauncher;
  /** Phase 4: plans and global limits; without it only `maxSessions` applies (tests). */
  policy?: Policy;
  /**
   * TBI-018 s3c: sim-minute metering and the fair queue (runtime/plans/simhost.ts). Absent or disabled
   * (metering.enabled=false) = the host behaves exactly as without it. s3d-3a: the queue surface
   * (`hasWaiting` peek, `cancel` behind `DELETE /sessions/queue`). s3d-3b: an ENABLED adapter admits
   * `POST /sessions` (SessionHost.admitCreate) and needs `policy` and `simAdmission` (the constructor
   * refuses it otherwise). s3d-4: run lifecycle. s3d-6: `main.ts` builds it from TBI_HOST_SIM_*
   * (runtime/host/simboot.ts); unset = absent. Enabling in a deployment is an owner decision.
   */
  simPlans?: Pick<
    SimHostAdapter,
    'enabled' | 'hasWaiting' | 'cancel' | 'admit' | 'ended' | 'heartbeat' | 'housekeeping'
  > &
    /** BETA-G2 slice 2: the Free kill switch state (pre-rate refusal, /health); optional */
    Partial<Pick<SimHostAdapter, 'freePaused'>>;
  /** TBI-018 s3d-3b: what the metered admission needs besides the adapter (unused flag-off). */
  simAdmission?: SimAdmissionConfig;
  /** Persistent per-principal rate windows (session creation). */
  rates?: RateLimiter;
  /** Host resources (disk, memory); tests substitute. */
  probe?: ResourceProbe;
  /** Parent directory for the host's private (0700) temporary root. */
  tmpParent: string;
  /** Environment given to the runtime process. Minimal by default. */
  runtimeEnv: NodeJS.ProcessEnv;

  maxSessions: number;
  /** Wall time a session may live, whatever it is doing. */
  maxLifetimeMs: number;
  /** Wall time from `run` to the bridge handshake. */
  startupTimeoutMs: number;
  /** Wall window in which less than 1 ms of simulation progress fails the session. */
  stallTimeoutMs: number;
  maxQueuedCommands: number;
  /**
   * Sprint 11 (ADR-010): commands a session accepts per wall-clock second (mirrors and transient
   * input together), on top of the per-principal request rate. Beyond it: `rate_limited`.
   */
  maxCommandsPerSecond: number;
  /** Events retained per session for ordered delivery and reconnect replay. */
  eventLogCapacity: number;
  /**
   * Sprint 30 (M3 POC, co-simulation timing): entries of the per-session timing trace kept in
   * memory (0, the default: off). Host-internal — never set by a client, never sent on the wire;
   * it records what already happens (virtual-time stamps) and changes nothing that is simulated.
   */
  timingTraceCapacity?: number;
  /** Serial bytes buffered per publish window; the excess is counted as dropped. */
  serialWindowMaxBytes: number;
  /** Bytes a session's private directory may occupy (the flash copy included). */
  maxSessionStorageBytes: number;
  /** After an orderly quit request, time before the runtime is killed. */
  quitGraceMs: number;
  /** SIGTERM -> SIGKILL grace on terminate. */
  killGraceMs: number;
  /** A session with no attached event stream and no request for this long is terminated. */
  leaseMs: number;
  /**
   * K3-1: a session whose user has not interacted for this long (wall ms) is ended `idle_timeout`,
   * even with its event stream attached. Interaction = `run`, an ACCEPTED command (202), or
   * `POST /sessions/:id/presence`; status reads, the event stream and lease refreshes never count.
   * Absent or 0: off (the host answers exactly as without it). On, it must be a safe integer above
   * `housekeepingMs` (`checkIdleBounds`, enforced at construction = boot). It is expected to be far
   * above `leaseMs` (5 min vs 30 s): the lease ends a session whose client is GONE, the idle limit
   * one whose client is connected but unattended, so idleMs >= leaseMs is the normal configuration.
   */
  idleMs?: number;
  /** A terminal session's status and final events stay readable for this long. */
  retainEndedMs: number;
  /** Runtime events are coalesced and published at this simulation-time interval. */
  publishIntervalUs: number;
  /** Largest accepted HTTP request body. */
  maxRequestBytes: number;
  /** Interval of the host's housekeeping (leases, storage, retention). */
  housekeepingMs: number;
  /**
   * Sprint 12 (D-10, V1-ARCHITECTURE §7.8): pacing cap, simulation time per wall time (1 = real
   * time, for interactive sessions). Null: unpaced (tests and benchmarks of raw speed).
   */
  paceRate: number | null;
  /**
   * Sprint 14: where the one `session_end` line per terminal session goes (diagnostics.ts).
   * Default: the service's stderr (journald). Tests substitute.
   */
  diagnostics?: DiagnosticsSink;
}

/** TBI-018 s3d-3b: host side of the metered admission (design sections 4 and 6). */
export interface SimAdmissionConfig {
  /** host policy plan name (`Policy.planName`) -> sim PlanId; an unmapped name is refused (503) */
  planMap: ReadonlyMap<string, PlanId>;
  /** `pollAfterS` and `Retry-After` of a 202 (boot: v * 1000 < queue.vanishMs) */
  pollAfterS: number;
  /** the queue ticket registry of this host process (memory only) */
  tickets: TicketRegistry;
  /** TBI-018 s3d-4: beat interval of a metered run (default floor(leaseMs / 3); boot: 1 <= v < leaseMs) */
  beatMs?: number;
  /** TBI-018 s3d-4: adapter housekeeping interval (default 5000) */
  housekeepingMs?: number;
  /** TBI-018 s3d-4: how long shutdown waits for pending `ended` calls (default 8000, below the unit's TimeoutStopSec=20) */
  endWaitMs?: number;
}

export function defaultConfig(
  overrides: Partial<HostConfig> & Pick<HostConfig, 'qemu' | 'artifactsDir' | 'ticketKey'>,
): HostConfig {
  const base: Omit<HostConfig, 'qemu' | 'artifactsDir' | 'ticketKey'> = {
    tmpParent: tmpdir(),
    runtimeEnv: { LANG: 'C' },
    maxSessions: 4,
    maxLifetimeMs: 30 * 60_000,
    startupTimeoutMs: 20_000,
    stallTimeoutMs: 10_000,
    maxQueuedCommands: 256,
    maxCommandsPerSecond: 50,
    eventLogCapacity: 4096,
    serialWindowMaxBytes: 16 * 1024,
    maxSessionStorageBytes: 16 * 1024 * 1024,
    quitGraceMs: 3_000,
    killGraceMs: 2_000,
    leaseMs: 30_000,
    retainEndedMs: 60_000,
    publishIntervalUs: 10 * COMMAND_QUANTUM_US,
    maxRequestBytes: 1024 * 1024,
    housekeepingMs: 250,
    paceRate: null,
  };
  return { ...base, ...overrides };
}

/** Operator-tunable engineering controls (never client-controlled): env name -> HostConfig key. */
export const HOST_TUNABLE_ENV: Readonly<Record<string, keyof HostConfig>> = {
  TBI_HOST_LEASE_MS: 'leaseMs',
  TBI_HOST_MAX_SESSIONS: 'maxSessions',
  TBI_HOST_STARTUP_TIMEOUT_MS: 'startupTimeoutMs',
  TBI_HOST_STALL_TIMEOUT_MS: 'stallTimeoutMs',
  TBI_HOST_RETAIN_ENDED_MS: 'retainEndedMs',
  TBI_HOST_MAX_LIFETIME_MS: 'maxLifetimeMs',
  // K3-1: unset, empty or 0 = off; any other non-digit value is refused
  TBI_HOST_IDLE_MS: 'idleMs',
};

/** The smallest idle limit an operator may set: the app's prompt shows 60 s before the end. */
export const MIN_IDLE_ENV_MS = 120_000;

/**
 * The tunable overrides `main.ts` applies (s3d-8: shared with the offline sim config validator so both
 * read TBI_HOST_LEASE_MS identically). A value that is not all digits is ignored (default kept),
 * except TBI_HOST_IDLE_MS: K3 throws on a set, non-empty value that is not all digits (idle would
 * otherwise stay silently off), is non-zero below `MIN_IDLE_ENV_MS` (the host would otherwise keep the
 * "Still there?" prompt on screen) or is beyond the safe integers (`checkIdleBounds` could only refuse
 * it later, after boot side effects). The message names the variable and the rule, no value.
 */
export function hostTunablesFromEnv(env: Record<string, string | undefined>): Partial<HostConfig> {
  const overrides: Partial<HostConfig> = {};
  for (const [name, key] of Object.entries(HOST_TUNABLE_ENV)) {
    const v = env[name];
    if (v !== undefined && /^\d+$/.test(v)) (overrides as Record<string, number>)[key] = Number(v);
  }
  // from the raw value: a non-digit one is NaN here (never in `overrides`) and refused
  const raw = env.TBI_HOST_IDLE_MS;
  const idle = raw ? (overrides.idleMs ?? NaN) : 0;
  if (idle !== 0 && !(Number.isSafeInteger(idle) && idle >= MIN_IDLE_ENV_MS))
    throw new Error(
      `TBI_HOST_IDLE_MS must be 0 (off) or a whole number of ms, at least ${MIN_IDLE_ENV_MS} (a safe integer)`,
    );
  return overrides;
}

/** K3-1: is the idle limit on (a positive `idleMs`)? */
export const idleOn = (config: Pick<HostConfig, 'idleMs'>): boolean =>
  typeof config.idleMs === 'number' && config.idleMs > 0;

/**
 * K3-1: fail closed on an idle limit housekeeping cannot enforce: when on, `idleMs` must be a safe
 * integer above `housekeepingMs`. Off (absent or 0): nothing is checked.
 */
export function checkIdleBounds(config: Pick<HostConfig, 'idleMs' | 'housekeepingMs'>): void {
  const v = config.idleMs;
  if (v === undefined || v === 0) return;
  if (!Number.isSafeInteger(v) || v <= config.housekeepingMs)
    throw new Error('idleMs must be 0 (off) or a whole number of ms above housekeepingMs');
}

/** The per-session directory for a session id (ids are host-generated hex, never client text). */
export const sessionDir = (tmpRoot: string, sessionId: string) => join(tmpRoot, `s-${sessionId}`);
