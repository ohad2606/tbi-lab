/**
 * Main-thread side of Mode A simulation: owns the Worker, the Run/Stop state machine and the
 * runtime results. It never solves anything itself, and it never writes project data.
 *
 *   stopped --run--> starting --outcome--> running --stop--> stopped
 *                        |                    |  live PSU control -> re-solve (stays running)
 *                        +--engine refusal / worker crash / timeout--> failed --run/stop-->
 *
 * Runtime results live only here, in memory. Reopening the page always starts stopped.
 */

import { createSnapshot, type ProjectDocument } from '@tbi-lab/domain';
import type { EngineError, LiveControl, SolveOutcome } from '@tbi-lab/engine';
import type { FromWorker, ToWorker, WorkerTiming } from './protocol.js';
import type { McuPlanError } from '../runtime/snapshot.js';
import type { RuntimeFailCode, RuntimeView } from '../runtime/view.js';

export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export type SimFailure =
  | { kind: 'engine'; error: EngineError }
  | { kind: 'worker'; code: 'worker_crashed' | 'timeout'; detail?: string }
  /** The project cannot start an ESP32 session as drawn (Sprint 6). */
  | {
      kind: 'mcu';
      code: McuPlanError['code'];
      components: string[];
      pins?: number[];
      /** Unmodelled features a build uses (mcu_unsupported_features). */
      features?: string[];
    }
  /** An ESP32 session could not start, or ended abnormally (Sprint 6). */
  | { kind: 'runtime'; code: RuntimeFailCode; detail?: string }
  /**
   * R4: a PWM output the session cannot simulate honestly (host `pwm_unsupported`), named: the
   * pad(s), the affected parts or inputs, and for an unrepresentable LEDC mode which one.
   */
  | {
      kind: 'pwm';
      code: PwmFailCode;
      gpios: number[];
      components?: string[];
      inputs?: number[];
      why?: string;
    };

export type PwmFailCode =
  | 'pwm_duty_zero_unverified'
  | 'pwm_unsupported_mode'
  | 'pwm_load_unsupported'
  | 'pwm_input_unsupported'
  | 'pwm_outputs_interact'
  /** Sprint 17C (M6): a bench supply current-limits during only part of each PWM cycle. */
  | 'pwm_supply_limited';

export interface RunTimings {
  /** Worker construction to its first message; null when an existing worker was reused. */
  workerStartMs: number | null;
  /** postMessage on the main thread to receipt in the worker (structured clone included). */
  requestTransferMs: number;
  solveMs: number;
  /** End of the solve in the worker to receipt on the main thread. */
  resultTransferMs: number;
  /** Run pressed (or control sent) to outcome received, including any worker start. */
  totalMs: number;
}

/**
 * `runtime` is present only for an ESP32 session (Sprint 6): the ephemeral runtime view. A
 * local DC simulation never has it. `stopping` exists only for ESP32 sessions: the session is
 * ending and its resources are being released.
 */
export type SimState =
  | { status: 'stopped' }
  | { status: 'starting'; runtime?: RuntimeView }
  | {
      status: 'running';
      outcome: SolveOutcome;
      timings: RunTimings;
      solves: number;
      /** Push buttons held right now: transient runtime input, never project data. */
      pressed: string[];
      runtime?: RuntimeView;
      /** Time-stepped sessions: how far simulated time trails real time, seconds. */
      behindS?: number;
    }
  | { status: 'stopping'; runtime?: RuntimeView }
  | { status: 'failed'; failure: SimFailure; runtime?: RuntimeView };

/** What the application store needs from a simulation host (local Worker or ESP32 session). */
export interface RunOptions {
  prebuilt?: { sha256: string; bytes: number; origin: 'build' | 'prebuilt' };
}

export interface SimulationHost {
  readonly state: SimState;
  readonly active: boolean;
  subscribe(listener: () => void): () => void;
  /** `options.prebuilt`: an Advanced prebuilt image for this Run (ESP32 host only). */
  run(doc: ProjectDocument, options?: RunOptions): Promise<void>;
  control(component: string, control: LiveControl, projectRevision: number): boolean;
  momentary(component: string, pressed: boolean): boolean;
  stop(): void;
  dispose(): void;
}

export interface ControllerDeps {
  createWorker: () => WorkerLike;
  now?: () => number;
  timeoutMs?: number;
}

interface Pending {
  requestId: number;
  startedAt: number;
  workerStartMs: number | null;
  timer: ReturnType<typeof setTimeout>;
}

export class SimulationController implements SimulationHost {
  private stateValue: SimState = { status: 'stopped' };
  private listeners = new Set<() => void>();
  private worker: WorkerLike | null = null;
  private workerReady: Promise<number> | null = null;
  private nextRequest = 1;
  /** Only the latest request of the current run may update the state. */
  private pending: Pending | null = null;
  private solves = 0;
  private pressed = new Set<string>();
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ControllerDeps) {
    // Absolute time, comparable with the worker's clock (each has its own time origin).
    this.now = deps.now ?? (() => performance.timeOrigin + performance.now());
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  get state(): SimState {
    return this.stateValue;
  }

  /** Starting or running: structural edits must not reach the loaded topology. */
  get active(): boolean {
    return this.stateValue.status === 'starting' || this.stateValue.status === 'running';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: SimState): void {
    this.stateValue = state;
    for (const l of this.listeners) l();
  }

  private ensureWorker(): Promise<number> {
    if (this.worker && this.workerReady) return this.workerReady.then(() => -1);
    const created = this.now();
    const worker = this.deps.createWorker();
    this.worker = worker;
    this.workerReady = new Promise<number>((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') {
          worker.onmessage = (ev) => this.onMessage(ev.data);
          resolve(this.now() - created);
        }
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        reject(new Error(e.message || 'worker error'));
        this.crash('worker_crashed', e.message);
      };
    });
    return this.workerReady;
  }

  private discardWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = null;
  }

  private crash(code: 'worker_crashed' | 'timeout', detail?: string): void {
    this.pressed.clear();
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.discardWorker();
    this.set({
      status: 'failed',
      failure: { kind: 'worker', code, ...(detail ? { detail } : {}) },
    });
  }

  private send(message: ToWorker, startedAt: number, workerStartMs: number | null): void {
    if (this.pending) clearTimeout(this.pending.timer);
    const timer = setTimeout(() => this.crash('timeout'), this.timeoutMs);
    this.pending = { requestId: message.requestId, startedAt, workerStartMs, timer };
    try {
      this.worker!.postMessage(message);
    } catch (e) {
      this.crash('worker_crashed', e instanceof Error ? e.message : String(e));
    }
  }

  /** Run: snapshot the browser-owned project and solve it in the Worker. */
  async run(doc: ProjectDocument): Promise<void> {
    const startedAt = this.now();
    const snapshot = createSnapshot(doc);
    this.solves = 0;
    this.pressed.clear(); // a new run always starts with every button released
    this.set({ status: 'starting' });
    let workerStartMs: number | null;
    try {
      const ms = await this.ensureWorker();
      workerStartMs = ms >= 0 ? ms : null;
    } catch {
      return; // crash() already reported it
    }
    if (this.stateValue.status !== 'starting') return; // stopped while the worker started
    const requestId = this.nextRequest++;
    this.send({ type: 'load', requestId, snapshot, sentAt: this.now() }, startedAt, workerStartMs);
  }

  /**
   * Mirror a live PSU change the browser has ALREADY persisted at `projectRevision`
   * (architecture §2.2, category 2). Ignored unless a simulation is running.
   */
  control(component: string, control: LiveControl, projectRevision: number): boolean {
    if (this.stateValue.status !== 'running' || !this.worker) return false;
    const requestId = this.nextRequest++;
    this.send(
      { type: 'control', requestId, component, control, projectRevision, sentAt: this.now() },
      this.now(),
      null,
    );
    return true;
  }

  /**
   * TRANSIENT runtime input: press or release a momentary push button. No project value is
   * involved: nothing is persisted and no revision is sent. Ignored unless running.
   */
  momentary(component: string, pressed: boolean): boolean {
    if (this.stateValue.status !== 'running' || !this.worker) return false;
    if (this.pressed.has(component) === pressed) return true; // already in that state
    if (pressed) this.pressed.add(component);
    else this.pressed.delete(component);
    const requestId = this.nextRequest++;
    this.send(
      { type: 'momentary', requestId, component, pressed, sentAt: this.now() },
      this.now(),
      null,
    );
    this.set({ ...this.stateValue, pressed: [...this.pressed] });
    return true;
  }

  /** Stop: drop all runtime state. The project is untouched. */
  stop(): void {
    this.pressed.clear();
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    if (this.worker && this.stateValue.status !== 'failed') {
      this.worker.postMessage({ type: 'stop', requestId: this.nextRequest++ });
    }
    this.set({ status: 'stopped' });
  }

  dispose(): void {
    this.stop();
    this.discardWorker();
  }

  private onMessage(msg: FromWorker): void {
    if (msg.type === 'ready' || msg.type === 'stopped') return;
    if (msg.type === 'tick') {
      // Time-stepped session: simulated time advanced. Only while running (a stop drops it).
      const s = this.stateValue;
      if (s.status !== 'running') return;
      this.solves++;
      this.set({ ...s, outcome: msg.outcome, solves: this.solves, behindS: msg.behindS });
      return;
    }
    const p = this.pending;
    if (!p || msg.requestId !== p.requestId) return; // stale: a newer request or a stop superseded it
    clearTimeout(p.timer);
    this.pending = null;
    if (msg.type === 'failure') {
      this.crash('worker_crashed', msg.message);
      return;
    }
    const receivedAt = this.now();
    const timings = computeTimings(msg.timing, receivedAt, p);
    const { outcome } = msg;
    if (this.stateValue.status === 'starting' && !outcome.ok) {
      // The engine refused the circuit: nothing is running; the user edits and runs again.
      this.worker?.postMessage({ type: 'stop', requestId: this.nextRequest++ });
      this.set({ status: 'failed', failure: { kind: 'engine', error: outcome.error } });
      return;
    }
    if (this.stateValue.status !== 'starting' && this.stateValue.status !== 'running') return;
    this.solves++;
    this.set({
      status: 'running',
      outcome,
      timings,
      solves: this.solves,
      pressed: [...this.pressed],
    });
  }
}

function computeTimings(t: WorkerTiming, receivedAt: number, p: Pending): RunTimings {
  return {
    workerStartMs: p.workerStartMs,
    requestTransferMs: t.receivedAt - t.sentAt,
    solveMs: t.solveEnd - t.solveStart,
    resultTransferMs: receivedAt - t.solveEnd,
    totalMs: receivedAt - p.startedAt,
  };
}
