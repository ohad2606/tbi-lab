/**
 * Mode A (browser-local) Worker protocol. Deliberately narrow: this is the local host for
 * the one electrical engine, not a general distributed protocol. The future server Session
 * Host runs the same engine behind its own transport (architecture §6).
 *
 * Every payload is language-neutral data: snapshots in, typed outcomes and error codes out.
 */

import type { SimulationSnapshot } from '@tbi-lab/domain';
import type { LiveControl, SolveOutcome } from '@tbi-lab/engine';

export type ToWorker =
  | { type: 'load'; requestId: number; snapshot: SimulationSnapshot; sentAt: number }
  | {
      type: 'control';
      requestId: number;
      component: string;
      control: LiveControl;
      /** The project revision at which the browser already persisted this value. */
      projectRevision: number;
      sentAt: number;
    }
  | {
      /** TRANSIENT runtime input (push button). Carries no revision: nothing was persisted. */
      type: 'momentary';
      requestId: number;
      component: string;
      pressed: boolean;
      sentAt: number;
    }
  | { type: 'stop'; requestId: number };

export interface WorkerTiming {
  /** Main-thread timestamp when the request was posted. */
  sentAt: number;
  /** Worker timestamps (same time origin as the page for a dedicated worker). */
  receivedAt: number;
  solveStart: number;
  solveEnd: number;
}

export type FromWorker =
  | { type: 'ready' }
  | { type: 'outcome'; requestId: number; outcome: SolveOutcome; timing: WorkerTiming }
  | { type: 'stopped'; requestId: number }
  /**
   * Sprint 10, time-stepped sessions: the latest state, posted as simulated time advances (no
   * request). `behindS`: how far simulated time trails real time (a heavy circuit).
   */
  | { type: 'tick'; outcome: SolveOutcome; behindS: number }
  | { type: 'failure'; requestId: number; message: string };
