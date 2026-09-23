/**
 * Mode A (browser-local) Worker protocol. Deliberately narrow: this is the local host for
 * the one electrical engine, not a general distributed protocol. The future server Session
 * Host runs the same engine behind its own transport (architecture §6).
 *
 * Every payload is language-neutral data: snapshots in, typed outcomes and error codes out.
 */

import type { SimulationSnapshot } from '@tbi-lab/domain';
import type { PsuControl, SolveOutcome } from '@tbi-lab/engine';

export type ToWorker =
  | { type: 'load'; requestId: number; snapshot: SimulationSnapshot; sentAt: number }
  | {
      type: 'control';
      requestId: number;
      component: string;
      control: PsuControl;
      /** The project revision at which the browser already persisted this value. */
      projectRevision: number;
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
  | { type: 'failure'; requestId: number; message: string };
