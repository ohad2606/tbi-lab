/** An in-process stand-in for the engine Worker: same protocol, real EngineSession. */
import { EngineSession } from '@tbi-lab/engine';
import type { WorkerLike } from '../src/sim/controller.js';
import type { FromWorker, ToWorker } from '../src/sim/protocol.js';

export interface FakeOptions {
  /** 'hang': never answer; 'crash': raise a worker error on the first request. */
  behaviour?: 'normal' | 'hang' | 'crash';
}

export class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  received: ToWorker[] = [];
  terminated = false;
  private session: EngineSession | null = null;

  constructor(private readonly options: FakeOptions = {}) {
    queueMicrotask(() => this.emit({ type: 'ready' }));
  }

  private emit(data: FromWorker) {
    if (!this.terminated) this.onmessage?.({ data } as MessageEvent<FromWorker>);
  }

  postMessage(msg: ToWorker): void {
    this.received.push(msg);
    const behaviour = this.options.behaviour ?? 'normal';
    if (behaviour === 'hang') return;
    if (behaviour === 'crash') {
      queueMicrotask(() => this.onerror?.({ message: 'boom', preventDefault() {} } as ErrorEvent));
      return;
    }
    queueMicrotask(() => {
      if (msg.type === 'stop') {
        this.session = null;
        return this.emit({ type: 'stopped', requestId: msg.requestId });
      }
      if (msg.type === 'load') this.session = new EngineSession(msg.snapshot);
      else if (msg.type === 'control')
        this.session!.applyControl(msg.component, msg.control, msg.projectRevision);
      else this.session!.setMomentary(msg.component, msg.pressed);
      const t = Date.now();
      this.emit({
        type: 'outcome',
        requestId: msg.requestId,
        outcome: this.session!.solve(),
        timing: { sentAt: msg.sentAt, receivedAt: t, solveStart: t, solveEnd: t },
      });
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

export const settle = () => new Promise((r) => setTimeout(r, 5));
