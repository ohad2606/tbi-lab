/**
 * ESP32 simulation through the R2 Session Host (Sprint 6).
 *
 * Implements the same `SimulationHost` contract as the local Worker controller, so the store,
 * the single Run/Stop control and the edit rules are shared:
 *
 *   stopped --run--> starting --first operating point--> running --stop--> stopping --> stopped
 *      \                 \______________________________________________________/
 *       \-- project cannot start a session / session fails / session lost --> failed
 *
 * Sessions are ONE-SHOT. Run always creates a fresh session (fresh flash copy, fresh QEMU,
 * fresh runtime state); Stop ends it for good. There is no resume and no reset.
 *
 * Browser authority: the session starts from an explicit snapshot of the persisted project
 * (runtime/snapshot.ts). Live persistent controls (PSU, toggle) are committed to the project
 * FIRST by the store, then mirrored here with their project revision (R2 `mirror`); push buttons
 * are R2 `transient` input and never touch the project. Nothing received from the server is ever
 * written into the project: runtime state lives only in `RuntimeView`, in memory.
 */
import { sha256Utf8, type ProjectDocument } from '@tbi-lab/domain';
import type { LiveControl, SolveOutcome } from '@tbi-lab/engine';
import type { FailReason, SessionEvent } from '../../../runtime/host/protocol.js';
import type {
  PwmFailCode,
  RunOptions,
  SimFailure,
  SimState,
  SimulationHost,
} from '../sim/controller.js';
import {
  RuntimeTransportError,
  type RuntimeClient,
  type RuntimeSession,
  type StreamStatus,
} from './client.js';
import {
  buildSessionRequest,
  resolveFirmware,
  type McuPlanError,
  type ResolvedFirmware,
} from './snapshot.js';
import type { ComponentInstance } from '@tbi-lab/domain';
import {
  SERIAL_MAX_CHARS,
  TRACE_CHECKPOINTS_MAX,
  WARNINGS_MAX,
  emptyView,
  type RuntimeFailCode,
  type RuntimeView,
} from './view.js';

export interface McuDeps {
  client: RuntimeClient;
  /**
   * What the board runs (Sprint 7): the current build of its program from the browser's build
   * state. Without it (tests), only reference images and Advanced prebuilt images resolve.
   */
  resolve?: (
    doc: ProjectDocument,
    board: ComponentInstance,
    options: RunOptions,
  ) => ResolvedFirmware | McuPlanError;
  /**
   * Pin the artifact against eviction until the Session Host has copied it (D-S7-8) and obtain
   * its run ticket (Sprint 8), which the session request carries. Null when the artifact no
   * longer exists (evicted) or is not this user's: the program needs a new Build.
   */
  lease?: (firmware: ResolvedFirmware, board: ComponentInstance) => Promise<string | null>;
  now?: () => number;
  /** After Stop, how long to wait for the orderly end before terminating. */
  stopTimeoutMs?: number;
}

/**
 * Alpha (Phase D): warn this long before a running session reaches its maximum lifetime (the
 * host's `lifetimeMs`, 30 minutes under the Alpha policy). The session is never extended: at the
 * end the host ends it (`lifetime_exceeded` -> `session_expired`) and the next Run is a new one.
 */
export const EXPIRY_WARNING_MS = 60_000;

/** Host failure reasons -> product error codes. */
const FAIL: Record<FailReason, RuntimeFailCode> = {
  artifact_unknown: 'firmware_unavailable',
  artifact_hash_mismatch: 'firmware_unavailable',
  artifact_missing: 'firmware_unavailable',
  unsupported_feature: 'unsupported_feature',
  invalid_attachment: 'invalid_attachment',
  electrical_error: 'runtime_crashed', // replaced by the engine error itself (see below)
  mirror_failed: 'mirror_failed',
  start_failed: 'startup_failed',
  start_timeout: 'startup_failed',
  stalled: 'stalled',
  runtime_crashed: 'runtime_crashed',
  runtime_protocol_error: 'runtime_crashed',
  host_protocol_error: 'runtime_crashed',
  bridge_lost: 'runtime_crashed',
  guest_reset: 'guest_reset',
  storage_limit: 'session_lost',
  pwm_unsupported: 'pwm_unsupported',
  internal: 'runtime_crashed',
};

export const PWM_CODES: readonly PwmFailCode[] = [
  'pwm_duty_zero_unverified',
  'pwm_unsupported_mode',
  'pwm_load_unsupported',
  'pwm_input_unsupported',
  'pwm_outputs_interact',
  'pwm_supply_limited',
  'pwm_rate_exceeded',
];

/** R4 (review M8): the host refused an attached pad because the GPIO matrix inverts it. */
function invertedRouting(detail: unknown): boolean {
  const f = (detail as { function?: unknown } | null)?.function;
  return typeof f === 'string' && f.startsWith('inverted:');
}

/** R4: the host's `pwm_unsupported` detail as a named product failure (unknown shapes: generic). */
export function pwmFailure(detail: unknown): SimFailure {
  const d = (detail ?? {}) as Record<string, unknown>;
  const code = d.code as PwmFailCode;
  if (!PWM_CODES.includes(code)) return { kind: 'runtime', code: 'pwm_unsupported' };
  const nums = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : undefined;
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const gpios = nums(d.gpios) ?? (Number.isInteger(d.gpio) ? [d.gpio as number] : []);
  const components = strs(d.components);
  const inputs = nums(d.inputs);
  return {
    kind: 'pwm',
    code,
    gpios,
    ...(components?.length ? { components } : {}),
    ...(inputs?.length ? { inputs } : {}),
    ...(typeof d.why === 'string' ? { why: d.why } : {}),
  };
}

export class McuSimulation implements SimulationHost {
  private stateValue: SimState = { status: 'stopped' };
  private listeners = new Set<() => void>();
  private session: RuntimeSession | null = null;
  /** Increments on every Run and Stop: a stale async step of an older run must not act. */
  private runId = 0;
  private view: RuntimeView | null = null;
  private outcome: SolveOutcome | null = null;
  private solves = 0;
  private pressed = new Set<string>();
  /**
   * Sprint 11 (ADR-010): live mirrors are coalesced per component while one is in flight; the
   * next one carries the latest values at the latest revision (the protocol allows revision
   * gaps), so ordinary use never approaches the host's command limits.
   */
  private mirrorsInFlight = new Set<string>();
  private pendingMirrors = new Map<string, { control: LiveControl; projectRevision: number }>();
  private stopRequested = false;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private readonly now: () => number;

  constructor(private readonly deps: McuDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  get state(): SimState {
    return this.stateValue;
  }

  get active(): boolean {
    const s = this.stateValue.status;
    return s === 'starting' || s === 'running' || s === 'stopping';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: SimState): void {
    this.stateValue = state;
    for (const l of this.listeners) l();
  }

  /** Re-publish the current status with the latest runtime view. */
  private publish(): void {
    const s = this.stateValue;
    const runtime = this.view ? { ...this.view } : undefined;
    if (s.status === 'running') this.set({ ...s, pressed: [...this.pressed], runtime });
    else if (s.status === 'starting' || s.status === 'stopping' || s.status === 'failed')
      this.set({ ...s, runtime });
  }

  async run(doc: ProjectDocument, options: RunOptions = {}): Promise<void> {
    this.release();
    const runId = ++this.runId;
    this.outcome = null;
    this.solves = 0;
    this.pressed.clear();
    this.mirrorsInFlight.clear();
    this.pendingMirrors.clear();
    this.stopRequested = false;
    this.startedAt = this.now();
    const planned = buildSessionRequest(doc, (board) =>
      this.deps.resolve
        ? this.deps.resolve(doc, board, options)
        : resolveFirmware(doc, board, {
            build: null,
            ...(options.prebuilt ? { prebuilt: options.prebuilt } : {}),
          }),
    );
    if (!planned.ok) {
      this.view = null;
      this.failPlan(planned.error);
      return;
    }
    const { plan } = planned;
    this.view = emptyView(plan.board.id, plan.firmware.sha256); // serial and GPIO start empty
    this.set({ status: 'starting', runtime: { ...this.view } });
    let ticket = ''; // without a lease step (tests with a fake client) there is no ticket
    if (this.deps.lease) {
      let leased: string | null;
      try {
        leased = await this.deps.lease(plan.firmware, plan.board);
      } catch (e) {
        if (runId === this.runId) this.fail(transportFailure(e));
        return;
      }
      if (runId !== this.runId) return;
      if (leased === null) {
        this.view = null;
        this.failPlan({ code: 'mcu_build_required', components: [plan.board.id] });
        return;
      }
      ticket = leased;
    }
    let session: RuntimeSession;
    try {
      session = await this.deps.client.create({ ...plan.request, ticket });
    } catch (e) {
      if (runId === this.runId) this.fail(transportFailure(e));
      return;
    }
    if (runId !== this.runId) {
      // Stopped (or re-run) while the session was being created: release it at once.
      void session.terminate().catch(() => undefined);
      return;
    }
    this.session = session;
    if (this.view) this.view.sessionId = session.id;
    session.stream(
      (e) => runId === this.runId && this.onEvent(e),
      (s) => runId === this.runId && this.onStream(s),
    );
    if (session.created.state === 'failed') return; // the stream reports why
    try {
      await session.run();
    } catch (e) {
      if (runId === this.runId && !this.stopRequested) this.failAndRelease(transportFailure(e));
    }
  }

  private failPlan(e: McuPlanError): void {
    this.set({
      status: 'failed',
      failure: {
        kind: 'mcu',
        code: e.code,
        components: e.components,
        ...('pins' in e ? { pins: e.pins } : {}),
        ...('features' in e ? { features: e.features } : {}),
      },
    });
  }

  /**
   * Mirror a live persistent change the store has ALREADY committed at `projectRevision`.
   * A mirror the session cannot take means it no longer represents the project: it is failed
   * and released, never left running with divergent state. The project keeps its value.
   */
  control(component: string, control: LiveControl, projectRevision: number): boolean {
    const session = this.session;
    if (this.stateValue.status !== 'running' || !session) return false;
    if (this.mirrorsInFlight.has(component)) {
      const prev = this.pendingMirrors.get(component);
      this.pendingMirrors.set(component, {
        control: mergeControls(prev?.control, control),
        projectRevision: Math.max(prev?.projectRevision ?? 0, projectRevision),
      });
      return true;
    }
    this.mirrorsInFlight.add(component);
    const runId = this.runId;
    const next = () => {
      if (runId !== this.runId) return;
      this.mirrorsInFlight.delete(component);
      const pending = this.pendingMirrors.get(component);
      this.pendingMirrors.delete(component);
      if (pending) this.control(component, pending.control, pending.projectRevision);
    };
    void session
      .command({ category: 'mirror', projectRevision, component, control })
      .then((r) => {
        if (runId !== this.runId) return;
        if (!r.accepted) return this.failAndRelease(commandRejection(r.reason));
        next();
      })
      .catch((e) => runId === this.runId && this.failAndRelease(commandFailure(e)));
    return true;
  }

  /** TRANSIENT input (push button): never a project value, never a revision. */
  momentary(component: string, pressed: boolean): boolean {
    const session = this.session;
    if (this.stateValue.status !== 'running' || !session) return false;
    if (this.pressed.has(component) === pressed) return true;
    if (pressed) this.pressed.add(component);
    else this.pressed.delete(component);
    this.publish();
    const runId = this.runId;
    void session
      .command({ category: 'transient', action: pressed ? 'press' : 'release', component })
      .then((r) => {
        if (runId !== this.runId || r.accepted) return;
        if (pressed) this.pressed.delete(component);
        if (r.reason === 'rate_limited')
          return this.failAndRelease({ kind: 'runtime', code: 'commands_rate_limited' });
        this.warn('transient_rejected', { component, reason: r.reason });
      })
      .catch((e) => runId === this.runId && this.failAndRelease(commandFailure(e)));
    return true;
  }

  /** Stop: end the session for good. The next Run creates a fresh one. */
  stop(): void {
    const session = this.session;
    const s = this.stateValue.status;
    this.pressed.clear();
    this.mirrorsInFlight.clear();
    this.pendingMirrors.clear();
    if (s === 'stopped' || s === 'failed') {
      if (s === 'failed') this.set({ status: 'stopped' });
      return;
    }
    if (!session) {
      // Still creating: invalidate the run; a session created after this is terminated.
      this.runId++;
      this.set({ status: 'stopped' });
      return;
    }
    if (s === 'stopping') return;
    this.stopRequested = true;
    this.set({ status: 'stopping', ...(this.view ? { runtime: { ...this.view } } : {}) });
    const runId = this.runId;
    void session.stop().catch(() => session.terminate().catch(() => undefined));
    this.stopTimer = setTimeout(() => {
      if (runId !== this.runId) return;
      void session.terminate().catch(() => undefined);
      this.finishStopped();
    }, this.deps.stopTimeoutMs ?? 10_000);
  }

  dispose(): void {
    this.runId++;
    const session = this.session;
    this.release();
    if (session) void session.terminate(true).catch(() => undefined);
    this.set({ status: 'stopped' });
  }

  // ---------------------------------------------------------------------------------------

  private release(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.session?.close();
    this.session = null;
  }

  private finishStopped(): void {
    this.release();
    this.runId++;
    this.set({ status: 'stopped' });
  }

  private fail(failure: SimFailure): void {
    this.release();
    this.runId++;
    this.set({ status: 'failed', failure, ...(this.view ? { runtime: { ...this.view } } : {}) });
  }

  private failAndRelease(failure: SimFailure): void {
    const session = this.session;
    this.fail(failure);
    if (session) void session.terminate().catch(() => undefined);
  }

  /**
   * From the moment the session runs (when the host starts its lifetime clock), warn
   * EXPIRY_WARNING_MS before the host's enforced lifetime; at once if the lifetime is shorter.
   * Without a lifetime from the host (an older host, or unbounded) there is no warning.
   */
  private scheduleExpiryWarning(): void {
    const lifetimeMs = this.session?.created.lifetimeMs;
    if (this.expiryTimer || typeof lifetimeMs !== 'number' || lifetimeMs <= 0) return;
    const runId = this.runId;
    this.expiryTimer = setTimeout(
      () => {
        if (runId !== this.runId || !this.view || this.stateValue.status === 'stopping') return;
        this.view.expiresSoon = { lifetimeMs };
        this.publish();
      },
      Math.max(0, lifetimeMs - EXPIRY_WARNING_MS),
    );
  }

  private warn(code: string, detail?: unknown): void {
    if (!this.view) return;
    this.view.warnings = [...this.view.warnings, { code, ...(detail ? { detail } : {}) }].slice(
      -WARNINGS_MAX,
    );
    this.publish();
  }

  private onStream(s: StreamStatus): void {
    if (!this.view) return;
    if (s.kind === 'lost') {
      if (this.stopRequested) return this.finishStopped();
      const code = s.error.code === 'protocol' ? 'protocol_error' : 'session_lost';
      return this.failAndRelease({ kind: 'runtime', code });
    }
    this.view.connection = s.kind === 'connected' ? 'connected' : 'reconnecting';
    this.publish();
  }

  private trace(e: SessionEvent): void {
    const v = this.view!;
    if (e.type === 'state' || e.type === 'resync' || e.type === 'command') return;
    const t = e.simNs === null ? 0 : Number(BigInt(e.simNs) / 1_000_000_000n);
    // Every event before second t is in the current hash: checkpoint the seconds just passed.
    const last = v.trace.checkpoints.at(-1)?.[0] ?? 0;
    const cps = [...v.trace.checkpoints];
    for (let sec = last + 1; sec <= t; sec++) cps.push([sec, v.trace.hash]);
    const { seq: _seq, ...body } = e;
    v.trace = {
      events: v.trace.events + 1,
      hash: sha256Utf8(v.trace.hash + JSON.stringify(body)).slice(0, 32),
      checkpoints: cps.slice(-TRACE_CHECKPOINTS_MAX),
    };
  }

  private onEvent(e: SessionEvent): void {
    const v = this.view;
    if (!v) return;
    if (e.simNs !== null) v.simNs = e.simNs;
    this.trace(e);
    switch (e.type) {
      case 'state': {
        v.sessionState = e.state;
        if (e.state === 'ended') {
          if (this.stopRequested) return this.finishStopped();
          const code = e.reason === 'lifetime_exceeded' ? 'session_expired' : 'session_lost';
          return this.fail({ kind: 'runtime', code, detail: e.reason });
        }
        if (e.state === 'running') this.scheduleExpiryWarning();
        if (e.state === 'failed') {
          const reason = e.reason as FailReason;
          if (reason === 'electrical_error' && isEngineError(e.detail))
            return this.fail({ kind: 'engine', error: e.detail });
          if (reason === 'pwm_unsupported') return this.fail(pwmFailure(e.detail));
          if (reason === 'unsupported_feature' && invertedRouting(e.detail))
            return this.fail({ kind: 'runtime', code: 'inverted_output', detail: reason });
          return this.fail({
            kind: 'runtime',
            code: FAIL[reason] ?? 'runtime_crashed',
            detail: reason,
          });
        }
        return this.publish();
      }
      case 'electrical': {
        this.outcome = e.outcome as SolveOutcome;
        this.solves++;
        v.stale = false;
        if (this.stateValue.status === 'starting' || this.stateValue.status === 'running') {
          const totalMs = this.now() - this.startedAt;
          this.set({
            status: 'running',
            outcome: this.outcome,
            timings: {
              workerStartMs: null,
              requestTransferMs: 0,
              solveMs: 0,
              resultTransferMs: 0,
              totalMs,
            },
            solves: this.solves,
            pressed: [...this.pressed],
            runtime: { ...v },
          });
        } else this.publish();
        return;
      }
      case 'gpio': {
        const gpio = { ...v.gpio };
        for (const c of e.changes)
          gpio[c.gpio] = {
            drive: c.drive,
            level: c.level,
            transitions: c.transitions,
            ...(c.pwm ? { pwm: c.pwm } : {}),
          };
        v.gpio = gpio;
        return this.publish();
      }
      case 'serial': {
        const text = v.serial + decodeBase64(e.data);
        const over = Math.max(0, text.length - SERIAL_MAX_CHARS);
        v.serial = over ? text.slice(over) : text;
        v.serialDropped += over + (e.dropped ?? 0);
        return this.publish();
      }
      case 'diagnostic':
        return this.warn(e.code, e.detail);
      case 'command':
        // Receipt-time results are handled where the command was sent; a tick-time rejection
        // of a transient is shown as a warning (a mirror rejection fails the session itself).
        if (e.result === 'rejected' && e.projectRevision === undefined)
          this.warn('transient_rejected', { reason: e.reason });
        return;
      case 'resync': {
        // The host evicted events before this client read them: say so, and refresh what the
        // protocol offers (status). Values stay marked stale until the next update arrives.
        v.missedEvents += e.missed;
        v.stale = true;
        this.publish();
        const session = this.session;
        const runId = this.runId;
        void session
          ?.status()
          .then((st) => {
            if (runId !== this.runId || !this.view) return;
            this.view.simNs = st.simNs;
            this.view.sessionState = st.state;
            this.publish();
          })
          .catch(() => undefined);
        return;
      }
    }
  }
}

/** Several persisted edits of one component in one mirror: later values win. */
function mergeControls(a: LiveControl | undefined, b: LiveControl): LiveControl {
  if (!a) return b;
  const params = a.params || b.params ? { ...a.params, ...b.params } : undefined;
  return { ...a, ...b, ...(params ? { params } : {}) };
}

/** A command the host answered with a rejection (409): its reason, as a product failure. */
function commandRejection(reason: string | undefined): SimFailure {
  if (reason === 'rate_limited') return { kind: 'runtime', code: 'commands_rate_limited' };
  return { kind: 'runtime', code: 'mirror_failed', ...(reason ? { detail: reason } : {}) };
}

/**
 * A command that failed at the transport (Sprint 11): a refusal by the host's validator (400, e.g.
 * an older runtime without live part parameters) or the request rate is about the COMMAND, never
 * "the runtime service is not reachable".
 */
function commandFailure(e: unknown): SimFailure {
  if (e instanceof RuntimeTransportError) {
    if (e.code === 'refused') return { kind: 'runtime', code: 'command_refused' };
    if (e.code === 'rate_limited') return { kind: 'runtime', code: 'commands_rate_limited' };
  }
  return transportFailure(e);
}

function transportFailure(e: unknown): SimFailure {
  if (e instanceof RuntimeTransportError) {
    if (e.code === 'busy' || e.code === 'shutting_down')
      return { kind: 'runtime', code: 'runtime_busy' };
    if (e.code === 'session_quota') return { kind: 'runtime', code: 'session_quota' };
    if (e.code === 'rate_limited') return { kind: 'runtime', code: 'rate_limited' };
    if (e.code === 'not_found') return { kind: 'runtime', code: 'session_lost' };
    if (e.code === 'protocol') return { kind: 'runtime', code: 'protocol_error' };
    return { kind: 'runtime', code: 'session_create_failed', detail: e.code };
  }
  return { kind: 'runtime', code: 'session_create_failed' };
}

function isEngineError(d: unknown): d is Extract<SimFailure, { kind: 'engine' }>['error'] {
  return typeof d === 'object' && d !== null && typeof (d as { code?: unknown }).code === 'string';
}

function decodeBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
