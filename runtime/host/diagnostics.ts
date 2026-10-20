/**
 * Session termination diagnostics (Sprint 14). When a session becomes terminal (ended or failed),
 * the host writes ONE bounded JSON line for operators to its own log (stderr: the journal of the
 * tbi-session-host unit), e.g.
 *
 *   {"event":"session_end","v":1,"ref":"3f9a2c1e","who":"p_Ab3dE5gH","state":"failed",
 *    "reason":"stalled","category":"stall","severity":"warning","from":"running","ran":true,
 *    "lifeMs":12034,"runMs":11950,"simMs":30,"outcome":"stalled","exitCode":null,
 *    "signal":"SIGKILL"}
 *
 * Every value is derived from the authoritative lifecycle only: the state machine's terminal
 * state and reason, and the runtime harness's classified outcome. Nothing is inferred beyond
 * what those record. The schema, the field meanings and the reason -> category table with its
 * evidence are documented in docs/ops/SESSION-DIAGNOSTICS.md; `v` changes whenever a field's
 * meaning changes.
 *
 * Privacy: a SHORT session reference and a SHORT principal reference (the admission-event
 * precedent, runtime/policy/refusal.ts), closed-set codes and bounded integers. Never tokens,
 * the full session id, paths, messages, circuit or firmware content, or anything a client sent
 * as free text. Every string field is a closed set or checked against a token pattern.
 *
 * Diagnostics never affect a session: the line is built and written after the terminal
 * transition, and any failure (a throwing sink included) is swallowed here.
 */
import type { Principal } from '../identity/principal.js';
import type { Outcome } from '../harness/session.js';
import type { EndReason, FailReason, SessionState } from './protocol.js';

/** Schema version of the `session_end` line. */
export const SESSION_END_V = 1;
/** Hard upper bound of one line, newline excluded (asserted in tests). */
export const SESSION_END_MAX_LINE = 512;

export type EndCategory =
  | 'user_stop'
  | 'client_release'
  | 'timeout'
  | 'disconnect'
  | 'host_shutdown'
  | 'crash'
  | 'stall'
  | 'resource_exhaustion'
  | 'startup'
  | 'protocol'
  | 'runtime_exit'
  | 'internal'
  | 'user_content'
  | 'artifact_integrity'
  | 'unknown';

export type EndSeverity = 'info' | 'warning' | 'error';

/**
 * Every terminal reason the host can produce, with its category and severity. The evidence for
 * each row is in docs/ops/SESSION-DIAGNOSTICS.md. A reason missing here (a future one) is
 * reported as `unknown`/`warning`, never thrown.
 */
export const REASON_CLASS: Readonly<
  Record<EndReason | FailReason, { category: EndCategory; severity: EndSeverity }>
> = {
  // ended (orderly)
  stopped: { category: 'user_stop', severity: 'info' },
  terminated: { category: 'client_release', severity: 'info' },
  lease_expired: { category: 'disconnect', severity: 'info' },
  lifetime_exceeded: { category: 'timeout', severity: 'info' },
  host_shutdown: { category: 'host_shutdown', severity: 'info' },
  // failed: what the user's project or firmware asked for (not host faults)
  unsupported_feature: { category: 'user_content', severity: 'info' },
  invalid_attachment: { category: 'user_content', severity: 'info' },
  electrical_error: { category: 'user_content', severity: 'info' },
  mirror_failed: { category: 'user_content', severity: 'info' },
  // R4 (merged with RC4's diagnostics): firmware PWM the session cannot simulate honestly.
  pwm_unsupported: { category: 'user_content', severity: 'info' },
  // failed: the artifact store
  artifact_unknown: { category: 'artifact_integrity', severity: 'warning' },
  artifact_hash_mismatch: { category: 'artifact_integrity', severity: 'error' },
  artifact_missing: { category: 'artifact_integrity', severity: 'error' },
  // failed: the runtime
  start_failed: { category: 'startup', severity: 'error' },
  start_timeout: { category: 'startup', severity: 'error' },
  stalled: { category: 'stall', severity: 'warning' },
  runtime_crashed: { category: 'crash', severity: 'error' },
  runtime_protocol_error: { category: 'protocol', severity: 'error' },
  host_protocol_error: { category: 'protocol', severity: 'error' },
  bridge_lost: { category: 'protocol', severity: 'error' },
  guest_reset: { category: 'runtime_exit', severity: 'warning' },
  storage_limit: { category: 'resource_exhaustion', severity: 'warning' },
  internal: { category: 'internal', severity: 'error' },
};

/** What the session knows when it becomes terminal (no derived or free-text values). */
export interface SessionEndFacts {
  sessionId: string;
  owner: Principal;
  state: SessionState;
  reason: string | null;
  /** The non-terminal state the session left for its terminal one. */
  from: SessionState | undefined;
  ran: boolean;
  lifeMs: number;
  runMs: number | null;
  simNs: bigint;
  /** The runtime's classified end, when the runtime ran and returned. */
  runtime: { outcome: Outcome; exitCode: number | null; signal: string | null } | null;
  /** The terminal detail (only an electrical_error's `code` is ever read from it). */
  detail: unknown;
}

export type DiagnosticsSink = (line: string) => void;

/** Default sink: the service's stderr (journald), like the admission events. */
export const stderrSink: DiagnosticsSink = (line) => void process.stderr.write(line);

const TOKEN = /^[a-z][a-z0-9_]{0,39}$/;
const CODE = /^[a-z_]{1,40}$/;
const SIGNAL = /^SIG[A-Z0-9]{1,10}$/;
const STATES: readonly string[] = ['creating', 'ready', 'running', 'stopping', 'ended', 'failed'];
const MS_CAP = 2 ** 31 - 1; // ~24.8 days: far beyond any session, keeps every value bounded

const ms = (n: number) => (Number.isFinite(n) ? Math.min(MS_CAP, Math.max(0, Math.round(n))) : 0);
const state = (s: unknown) => (typeof s === 'string' && STATES.includes(s) ? s : 'unknown');

/** The `session_end` record for `f`. Pure; every field bounded. */
export function sessionEndRecord(f: SessionEndFacts): Record<string, unknown> {
  const known =
    f.reason !== null && Object.hasOwn(REASON_CLASS, f.reason)
      ? REASON_CLASS[f.reason as keyof typeof REASON_CLASS]
      : null;
  const cls = known ?? { category: 'unknown' as const, severity: 'warning' as const };
  const code =
    f.reason === 'electrical_error' && typeof f.detail === 'object' && f.detail !== null
      ? (f.detail as { code?: unknown }).code
      : undefined;
  const simMs = f.simNs > 0n ? Number(f.simNs / 1_000_000n) : 0;
  const rt = f.runtime;
  return {
    event: 'session_end',
    v: SESSION_END_V,
    ref: /^[0-9a-f]{32}$/.test(f.sessionId) ? f.sessionId.slice(0, 8) : 'unknown',
    who: f.owner.slice(0, 10),
    state: state(f.state),
    reason: typeof f.reason === 'string' && TOKEN.test(f.reason) ? f.reason : 'unknown',
    category: cls.category,
    severity: cls.severity,
    from: state(f.from),
    ran: f.ran,
    lifeMs: ms(f.lifeMs),
    ...(f.runMs !== null ? { runMs: ms(f.runMs) } : {}),
    simMs: Math.min(MS_CAP, simMs),
    ...(rt
      ? {
          outcome: TOKEN.test(rt.outcome) ? rt.outcome : 'unknown',
          exitCode:
            Number.isInteger(rt.exitCode) && Math.abs(rt.exitCode!) <= 0xffff ? rt.exitCode : null,
          signal: rt.signal !== null && SIGNAL.test(rt.signal) ? rt.signal : null,
        }
      : {}),
    ...(typeof code === 'string' && CODE.test(code) ? { code } : {}),
  };
}

/**
 * Write the session's `session_end` line to `sink`. Never throws: diagnostics must not change a
 * session's state, events or cleanup.
 */
export function emitSessionEnd(sink: DiagnosticsSink, facts: () => SessionEndFacts): void {
  try {
    let line = JSON.stringify(sessionEndRecord(facts()));
    // Unreachable with the bounded fields above; kept so the bound holds whatever changes later.
    if (line.length > SESSION_END_MAX_LINE)
      line = JSON.stringify({ event: 'session_end', v: SESSION_END_V, truncated: true });
    sink(`${line}\n`);
  } catch {
    // Diagnostics are best effort and never reach the session.
  }
}
