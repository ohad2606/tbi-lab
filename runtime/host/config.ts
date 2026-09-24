/**
 * Session Host configuration (runtime R2). Every limit is an explicit engineering control with a
 * conservative default; none of them is a capacity claim. A client may only make a limit
 * stricter (protocol.ts `limits`), never looser.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COMMAND_QUANTUM_US } from './protocol.js';

export interface HostConfig {
  /** Absolute path of the runtime executable. Fixed by the operator; never from a client. */
  qemu: string;
  /** Directory of immutable, content-addressed firmware artifacts (`<sha256>.bin`). */
  artifactsDir: string;
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
  overrides: Partial<HostConfig> & Pick<HostConfig, 'qemu' | 'artifactsDir'>,
): HostConfig {
  const base: Omit<HostConfig, 'qemu' | 'artifactsDir'> = {
    tmpParent: tmpdir(),
    runtimeEnv: { LANG: 'C' },
    maxSessions: 4,
    maxLifetimeMs: 30 * 60_000,
    startupTimeoutMs: 20_000,
    stallTimeoutMs: 10_000,
    maxQueuedCommands: 256,
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
