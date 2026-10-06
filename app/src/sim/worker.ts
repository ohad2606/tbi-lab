/**
 * The browser Web Worker host for the electrical engine (Mode A). All solving happens here,
 * off the UI thread. The worker holds a runtime session only; it never persists anything and
 * is never authoritative for any project value.
 *
 * Sprint 10: a circuit with a time-dependent part (a capacitor) runs TIME-STEPPED. Every Run
 * starts at t = 0 with every capacitor discharged; the session advances fixed backward-Euler
 * steps of STEP_S, paced to wall-clock time (simulated time follows real time) under a CPU budget
 * per tick (when the budget is reached, simulated time runs slower than real time: it never skips
 * steps). Live controls and button presses apply from the next step. Each tick posts the latest
 * outcome. A circuit without one is solved exactly as before: one DC solve per request.
 */

/// <reference lib="webworker" />

import { EngineSession } from '@tbi-lab/engine';
import type { FromWorker, ToWorker } from './protocol.js';

declare const self: DedicatedWorkerGlobalScope;

/** Time step of time-stepped sessions, seconds. */
export const STEP_S = 1e-3;
/** How often a time-stepped session advances and reports, milliseconds. */
const TICK_MS = 50;
/** CPU budget per tick, milliseconds. */
const BUDGET_MS = 25;

let session: EngineSession | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let wallStart = 0;

/** Absolute milliseconds: a dedicated worker has its own time origin, so raw now() differs. */
const clock = () => performance.timeOrigin + performance.now();

const post = (m: FromWorker) => self.postMessage(m);

function stopTicking() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Advance toward real time within the budget; post the latest state. */
function tick() {
  const s = session;
  if (!s) return stopTicking();
  const target = (clock() - wallStart) / 1000;
  const begin = clock();
  let outcome = null;
  while (s.simulatedTime + STEP_S <= target + 1e-12 && clock() - begin < BUDGET_MS) {
    outcome = s.advance(STEP_S);
    if (!outcome.ok) break;
  }
  if (!outcome) return;
  post({ type: 'tick', outcome, behindS: Math.max(0, target - s.simulatedTime) });
  if (!outcome.ok) stopTicking();
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const receivedAt = clock();
  const msg = event.data;
  try {
    if (msg.type === 'stop') {
      stopTicking();
      session = null;
      post({ type: 'stopped', requestId: msg.requestId });
      return;
    }
    if (msg.type === 'load') {
      stopTicking();
      session = new EngineSession(msg.snapshot);
    } else {
      if (!session) throw new Error(`${msg.type} received with no loaded snapshot`);
      const refused =
        msg.type === 'control'
          ? session.applyControl(msg.component, msg.control, msg.projectRevision)
          : session.setMomentary(msg.component, msg.pressed);
      if (refused) throw new Error(`${msg.type} refused: ${refused.code}`);
    }
    const solveStart = clock();
    // A time-stepped session answers with its next step (the change applies from it).
    const timed = session.timeDependent;
    const outcome = timed ? session.advance(STEP_S) : session.solve();
    const solveEnd = clock();
    post({
      type: 'outcome',
      requestId: msg.requestId,
      outcome,
      timing: { sentAt: msg.sentAt, receivedAt, solveStart, solveEnd },
    });
    if (timed && msg.type === 'load' && outcome.ok) {
      wallStart = clock() - STEP_S * 1000;
      timer = setInterval(tick, TICK_MS);
    }
  } catch (e) {
    post({
      type: 'failure',
      requestId: msg.requestId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};

post({ type: 'ready' });
