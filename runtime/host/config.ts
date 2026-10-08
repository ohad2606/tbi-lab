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
  /** A terminal session's status and final events stay readable for this long. */
  retainEndedMs: number;
  /** Runtime events are coalesced and published at this simulation-time interval. */
  publishIntervalUs: number;
  /** Largest accepted HTTP request body. */
  maxRequestBytes: number;
  /** Interval of the host's housekeeping (leases, storage, retention). */
  housekeepingMs: number;
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
  };
  return { ...base, ...overrides };
}

/** The per-session directory for a session id (ids are host-generated hex, never client text). */
export const sessionDir = (tmpRoot: string, sessionId: string) => join(tmpRoot, `s-${sessionId}`);
