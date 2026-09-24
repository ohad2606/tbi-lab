/**
 * Session lifecycle (runtime R2). Pure: no timers, no I/O.
 *
 *   creating --prepared--> ready --run--> running --stop/terminate--> stopping --exited--> ended
 *      |                     |               |                            |
 *      +--> failed           +--> ended      +--> failed                  +--> failed
 *      +--> ended                                                              (forced kill)
 *
 * - `creating`: artifact verified, private copy made, circuit compiled. No QEMU yet.
 * - `ready`: everything prepared; QEMU is NOT running. `run` starts it (a fresh boot).
 * - `running`: QEMU executing, bridge and engine live.
 * - `stopping`: an orderly quit was requested; child resources are being released.
 * - `ended` / `failed`: TERMINAL. All child resources are released before a session is reported
 *   terminal. There is no way back: full-chip reset is unsupported, so a clean reset is a new
 *   session. A failed child never restarts.
 */
import type { EndReason, FailReason, SessionState } from './protocol.js';

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  creating: ['ready', 'ended', 'failed'],
  ready: ['running', 'ended', 'failed'],
  running: ['stopping', 'failed'],
  stopping: ['ended', 'failed'],
  ended: [],
  failed: [],
};

export class IllegalTransition extends Error {
  constructor(from: SessionState, to: SessionState) {
    super(`illegal session transition ${from} -> ${to}`);
    this.name = 'IllegalTransition';
  }
}

export const isTerminal = (s: SessionState) => s === 'ended' || s === 'failed';

export class SessionStateMachine {
  private current: SessionState = 'creating';
  private terminalReason: EndReason | FailReason | null = null;
  private terminalDetail: unknown = undefined;
  readonly history: { state: SessionState; reason?: EndReason | FailReason }[] = [
    { state: 'creating' },
  ];

  get state(): SessionState {
    return this.current;
  }
  get reason(): EndReason | FailReason | null {
    return this.terminalReason;
  }
  get detail(): unknown {
    return this.terminalDetail;
  }

  can(to: SessionState): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  /** Move to `to`. Terminal states need a reason. Illegal moves throw (a host bug, not input). */
  to(to: SessionState, reason?: EndReason | FailReason, detail?: unknown): void {
    if (!this.can(to)) throw new IllegalTransition(this.current, to);
    if (isTerminal(to)) {
      if (!reason) throw new Error(`terminal state ${to} needs a reason`);
      this.terminalReason = reason;
      this.terminalDetail = detail;
    }
    this.current = to;
    this.history.push(reason ? { state: to, reason } : { state: to });
  }
}
