/**
 * The browser Web Worker host for the electrical engine (Mode A). All solving happens here,
 * off the UI thread. The worker holds a runtime session only; it never persists anything and
 * is never authoritative for any project value.
 */

/// <reference lib="webworker" />

import { EngineSession } from '@tbi-lab/engine';
import type { FromWorker, ToWorker } from './protocol.js';

declare const self: DedicatedWorkerGlobalScope;

let session: EngineSession | null = null;

/** Absolute milliseconds: a dedicated worker has its own time origin, so raw now() differs. */
const clock = () => performance.timeOrigin + performance.now();

const post = (m: FromWorker) => self.postMessage(m);

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const receivedAt = clock();
  const msg = event.data;
  try {
    if (msg.type === 'stop') {
      session = null;
      post({ type: 'stopped', requestId: msg.requestId });
      return;
    }
    if (msg.type === 'load') {
      session = new EngineSession(msg.snapshot);
    } else {
      if (!session) throw new Error('control received with no loaded snapshot');
      const refused = session.applyPsuControl(msg.component, msg.control, msg.projectRevision);
      if (refused) throw new Error(`control refused: ${refused.code}`);
    }
    const solveStart = clock();
    const outcome = session.solve();
    const solveEnd = clock();
    post({
      type: 'outcome',
      requestId: msg.requestId,
      outcome,
      timing: { sentAt: msg.sentAt, receivedAt, solveStart, solveEnd },
    });
  } catch (e) {
    post({
      type: 'failure',
      requestId: msg.requestId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};

post({ type: 'ready' });
