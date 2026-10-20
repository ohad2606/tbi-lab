/**
 * Ephemeral runtime state of an ESP32 session, as the browser sees it (Sprint 6).
 *
 * Presentation state only. It lives in memory next to the simulation state, is rebuilt from the
 * Session Host's ordered events, is cleared when a new session starts, and is NEVER written to
 * the project document: no session id or token, no serial output, no GPIO levels, no event ids.
 */
import type { PwmPadState, SessionState } from '../../../runtime/host/protocol.js';

/** Bounds: the view never grows with session length. */
export const SERIAL_MAX_CHARS = 16 * 1024;
export const WARNINGS_MAX = 20;
export const TRACE_CHECKPOINTS_MAX = 120;

export interface GpioLevel {
  drive: 0 | 1;
  /** With `pwm`: the static level, or 0 while the pad switches. */
  level: 0 | 1;
  transitions: number;
  /** Sprint 15 (R4): the pad is an LEDC (PWM) output with this waveform, as the host reports it. */
  pwm?: PwmPadState;
}

export interface RuntimeWarning {
  code: string;
  detail?: unknown;
}

export interface RuntimeView {
  board: string;
  firmware: string;
  sessionState: SessionState | 'creating-request';
  /** Simulation time of the latest runtime event (decimal ns). */
  simNs: string;
  gpio: Record<number, GpioLevel>;
  /** Most recent serial output, bounded to SERIAL_MAX_CHARS (older text is dropped). */
  serial: string;
  /** Characters dropped by the bound or by the host's per-window limit. */
  serialDropped: number;
  warnings: RuntimeWarning[];
  /** Transport: the event stream is attached, or reconnecting after a drop. */
  connection: 'connected' | 'reconnecting';
  /** Events the host evicted before this client could read them (explicit resync). */
  missedEvents: number;
  /** Values shown may be older than the session (after a resync, until the next update). */
  stale: boolean;
  /**
   * Canonical observable sequence (determinism evidence): a running hash of the runtime events
   * (serial, gpio, electrical, diagnostics) with their simulation times, and checkpoints of it at
   * every whole simulated second. Transport timing and event ids are excluded.
   */
  trace: { events: number; hash: string; checkpoints: [number, string][] };
  /**
   * Set about a minute before the session reaches its maximum lifetime (the host's value): the
   * session will end then; nothing extends it. Null otherwise.
   */
  expiresSoon: { lifetimeMs: number } | null;
  /**
   * Sprint 14: the host's id of this session, once created. Only a problem report sends it; the
   * host associates it only with the same user's own session.
   */
  sessionId?: string;
}

export function emptyView(board: string, firmware: string): RuntimeView {
  return {
    board,
    firmware,
    sessionState: 'creating-request',
    simNs: '0',
    gpio: {},
    serial: '',
    serialDropped: 0,
    warnings: [],
    connection: 'connected',
    missedEvents: 0,
    stale: false,
    trace: { events: 0, hash: '', checkpoints: [] },
    expiresSoon: null,
  };
}

/** Failures of an ESP32 session, mapped to product error codes (never raw host internals). */
export type RuntimeFailCode =
  | 'session_create_failed'
  | 'runtime_busy'
  | 'session_quota'
  | 'rate_limited'
  | 'firmware_unavailable'
  | 'unsupported_feature'
  | 'invalid_attachment'
  | 'startup_failed'
  | 'runtime_crashed'
  | 'guest_reset'
  | 'stalled'
  | 'session_lost'
  | 'session_expired'
  | 'mirror_failed'
  /** R4: a PWM output that cannot be simulated honestly (details: SimFailure kind 'pwm'). */
  | 'pwm_unsupported'
  /** R4 (review M8): the GPIO matrix inverts an attached pin's output, which is not modelled. */
  | 'inverted_output'
  /** Sprint 11: the host's validator refused a live command (e.g. an older runtime). */
  | 'command_refused'
  /** Sprint 11: live commands exceeded the host's per-session rate. */
  | 'commands_rate_limited'
  | 'protocol_error';
