/**
 * Time-kernel PROTOTYPE (Sprint 19B, Exploration Foundation EF-1, Milestone T). Isolated: nothing
 * in the product uses it until its gates pass and the owner approves exposing it.
 *
 * A variable-step transient driver over the engine's own time-stepped solve (EngineSession.advance:
 * backward Euler, L-stable, the companion models of devices.ts). What it adds, and how it stays
 * truthful:
 *
 * - **Step control by measured error, never by a fixed guess.** Each step of length h is solved
 *   once (h) and as two half steps (h/2 + h/2) from the same checkpoint; the difference of the node
 *   voltages estimates the local error of backward Euler. A step is accepted only when every node
 *   is within `absTolV + relTol·|v|`; the more accurate half-step state is the one kept. Otherwise
 *   the step is retried at half length. A step below `dtMin` is REFUSED (`transient_step_floor`):
 *   the kernel never accepts an error it cannot bound.
 * - **Deterministic event ordering.** Breakpoints (known discontinuities: a stimulus edge, the end
 *   of a window) are kept sorted by (time, insertion order) and are always step boundaries,
 *   exactly. Step control is a pure function of the circuit's state: no wall clock, so the same
 *   circuit and breakpoints give the same steps, bit for bit.
 * - **Event localization.** When a step changes a part's discrete state (a relay armature, a
 *   threshold), the step is bisected until the change is bracketed within `eventTolS`; the state
 *   changes at that instant, which is reported. No state change is ever smeared across a step.
 * - **Bounded resources.** At most `budgetSolvesPerSimS` solves per simulated second of each window
 *   (`transient_budget_exceeded`, by name: never a larger step to save time).
 * - **Timing-sensitive logic is refused.** Logic parts (Sprint 19B L1) have no delay model here,
 *   and the datasheet's input transition-rate limit (Δt/Δv) would be violated by RC edges:
 *   `transient_logic_unsupported` until both are modelled.
 */
import type { EngineSession, SessionCheckpoint, SolveOutcome, SolveSuccess } from '../session.js';

export interface KernelOptions {
  /** Absolute and relative local error tolerance on node voltages. */
  absTolV: number;
  relTol: number;
  /** Smallest step the kernel will take (s); below it, refused. */
  dtMin: number;
  /** Largest step (s). */
  dtMax: number;
  /** First step (s). */
  dtInitial: number;
  /** Event localization tolerance (s). */
  eventTolS: number;
  /** Solve budget per simulated second of a window. */
  budgetSolvesPerSimS: number;
}

export const DEFAULT_KERNEL_OPTIONS: KernelOptions = {
  absTolV: 1e-3,
  relTol: 1e-3,
  dtMin: 1e-9,
  dtMax: 1e-2,
  dtInitial: 1e-6,
  eventTolS: 1e-8,
  budgetSolvesPerSimS: 200_000,
};

export type KernelRefusal =
  | 'transient_step_floor'
  | 'transient_budget_exceeded'
  | 'transient_logic_unsupported'
  | 'transient_solve_failed';

export interface KernelEvent {
  /** Simulated time the discrete change happened at (s), within ± eventTolS. */
  time: number;
  /** Parts whose discrete state changed, sorted. */
  parts: string[];
}

export type KernelResult =
  | {
      ok: true;
      outcome: SolveSuccess;
      time: number;
      steps: number;
      solves: number;
      events: KernelEvent[];
    }
  | { ok: false; code: KernelRefusal; time: number; detail?: Record<string, unknown> };

export class TransientKernel {
  readonly opts: KernelOptions;
  private dt: number;
  private readonly breakpoints: { t: number; seq: number }[] = [];
  private seq = 0;
  /** Totals over the kernel's life (measurements). */
  steps = 0;
  solves = 0;
  rejected = 0;

  constructor(
    private readonly session: EngineSession,
    opts: Partial<KernelOptions> = {},
    componentTypes: readonly string[] = [],
  ) {
    this.opts = { ...DEFAULT_KERNEL_OPTIONS, ...opts };
    this.dt = this.opts.dtInitial;
    this.logic = componentTypes.some((t) => t.startsWith('logic.'));
  }
  private readonly logic: boolean;

  /** A known discontinuity at simulated time t (s): always a step boundary. */
  addBreakpoint(t: number): void {
    this.breakpoints.push({ t, seq: this.seq++ });
    this.breakpoints.sort((a, b) => a.t - b.t || a.seq - b.seq);
  }

  get time(): number {
    return this.session.simulatedTime;
  }

  /** Advance to exactly tEnd (s). */
  advanceTo(tEnd: number): KernelResult {
    const start = this.time;
    if (this.logic) return { ok: false, code: 'transient_logic_unsupported', time: start };
    const budget = Math.ceil(this.opts.budgetSolvesPerSimS * Math.max(tEnd - start, 0));
    const solvesAtStart = this.solves;
    const events: KernelEvent[] = [];
    let last: SolveSuccess | null = null;
    let steps = 0;
    while (this.time < tEnd - timeEps(tEnd)) {
      if (this.solves - solvesAtStart > budget)
        return {
          ok: false,
          code: 'transient_budget_exceeded',
          time: this.time,
          detail: { budget },
        };
      const t = this.time;
      const next = this.breakpoints.find((b) => b.t > t + timeEps(b.t));
      const target = Math.min(tEnd, next ? next.t : Infinity);
      // Land exactly on the target when the step would reach it (no sliver step after it).
      let h = Math.min(this.dt, this.opts.dtMax, target - t);
      if (target - t - h < this.opts.dtMin) h = target - t;
      const r = this.trial(h);
      // Steps sum in floating point: a boundary reached within rounding IS reached (never a
      // sliver step of ~1e-17 s, whose C/dt would be numerically singular). Exact time label.
      if (
        (r.kind === 'accept' || r.kind === 'event') &&
        Math.abs(target - this.time) <= timeEps(target)
      )
        this.session.restore({ ...this.session.checkpoint(), time: target });
      if (r.kind === 'failed')
        return { ok: false, code: 'transient_solve_failed', time: t, detail: { error: r.error } };
      if (r.kind === 'reject') {
        this.rejected++;
        this.dt = h / 2;
        if (this.dt < this.opts.dtMin)
          return { ok: false, code: 'transient_step_floor', time: t, detail: { dt: this.dt } };
        continue;
      }
      if (r.kind === 'event') {
        events.push(r.event);
        this.method = 'backward-euler';
        last = r.outcome;
        steps += r.steps;
        this.dt = Math.max(this.opts.dtInitial, this.opts.dtMin);
        continue;
      }
      last = r.outcome;
      steps++;
      // The next step: backward Euler right after a breakpoint (a discontinuity), else trapezoidal.
      const atBreakpoint = this.breakpoints.some(
        (bp) => Math.abs(bp.t - this.time) <= timeEps(bp.t),
      );
      this.method = atBreakpoint ? 'backward-euler' : 'trapezoidal';
      // Grow (at most ×2) by the measured error (err ≤ 1 accepted).
      const grow = r.err > 0 ? Math.min(2, 0.9 / Math.sqrt(r.err)) : 2;
      this.dt = Math.min(this.opts.dtMax, Math.max(this.opts.dtMin, h * Math.max(grow, 0.5)));
    }
    this.steps += steps;
    return {
      ok: true,
      outcome: last!,
      time: this.time,
      steps,
      solves: this.solves - solvesAtStart,
      events,
    };
  }

  private advance(h: number): SolveOutcome {
    this.solves++;
    return this.session.advance(h, this.method);
  }

  /**
   * Trapezoidal (2nd order) between discontinuities; backward Euler (L-stable, no ringing) for the
   * first step after the start, a breakpoint or an event, where trapezoidal would ring.
   */
  private method: 'backward-euler' | 'trapezoidal' = 'backward-euler';

  /** One step of h: accepted (half-step state kept), rejected (restored), or an event (localized). */
  private trial(
    h: number,
  ):
    | { kind: 'accept'; outcome: SolveSuccess; err: number }
    | { kind: 'reject' }
    | { kind: 'event'; outcome: SolveSuccess; event: KernelEvent; steps: number }
    | { kind: 'failed'; error: unknown } {
    const cp = this.session.checkpoint();
    const full = this.advance(h);
    if (!full.ok) {
      this.session.restore(cp);
      return { kind: 'failed', error: full.error };
    }
    const afterFull = this.session.checkpoint();
    this.session.restore(cp);
    const a = this.advance(h / 2);
    const b = a.ok ? this.advance(h / 2) : a;
    if (!b.ok) {
      this.session.restore(cp);
      return { kind: 'failed', error: b.error };
    }
    // A discrete change inside the step (in either solution): localize it.
    const changed = changedParts(cp, this.session.checkpoint()).concat(changedParts(cp, afterFull));
    if (changed.length) return this.localize(cp, h);
    let err = 0;
    for (const [net, v] of Object.entries(b.netVoltages)) {
      const vf = full.netVoltages[net];
      if (vf === undefined) continue;
      // Richardson: the half-step solution's local error ≈ (full − half) / (2^p − 1), p the order.
      const k = this.method === 'trapezoidal' ? 1 / 3 : 1;
      err = Math.max(
        err,
        (k * Math.abs(vf - v)) / (this.opts.absTolV + this.opts.relTol * Math.abs(v)),
      );
    }
    if (err > 1) {
      this.session.restore(cp);
      return { kind: 'reject' };
    }
    return { kind: 'accept', outcome: b, err };
  }

  /**
   * A discrete state changes within (t, t + h]: bisect for the latest step length that does NOT
   * change it (lo) and the earliest that does (hi), until hi − lo ≤ eventTolS; then take lo and the
   * step to hi, where the change happens.
   */
  private localize(cp: SessionCheckpoint, h: number) {
    let lo = 0;
    let hi = h;
    while (hi - lo > this.opts.eventTolS) {
      const mid = (lo + hi) / 2;
      this.session.restore(cp);
      const o = this.advance(mid);
      if (!o.ok) {
        this.session.restore(cp);
        return { kind: 'failed' as const, error: o.error };
      }
      if (changedParts(cp, this.session.checkpoint()).length) hi = mid;
      else lo = mid;
    }
    this.session.restore(cp);
    let steps = 0;
    if (lo > 0) {
      const o = this.advance(lo);
      if (!o.ok) return { kind: 'failed' as const, error: o.error };
      steps++;
    }
    const before = this.session.checkpoint();
    const o = this.advance(hi - lo);
    if (!o.ok) return { kind: 'failed' as const, error: o.error };
    steps++;
    const parts = changedParts(before, this.session.checkpoint());
    return {
      kind: 'event' as const,
      outcome: o,
      steps,
      event: { time: this.session.simulatedTime, parts },
    };
  }
}

/**
 * Parts whose settled discrete state differs between two checkpoints. A part with no state yet in
 * `a` (the very first solve establishes it) has not CHANGED: only states present in both count.
 */
function changedParts(a: SessionCheckpoint, b: SessionCheckpoint): string[] {
  const ids = [...a.discrete.keys()].filter((id) => b.discrete.has(id));
  return ids
    .filter(
      (id) =>
        JSON.stringify(a.discrete.get(id) ?? null) !== JSON.stringify(b.discrete.get(id) ?? null),
    )
    .sort();
}

/** Rounding tolerance for simulated times (s): relative 1e-12, at least 1e-18. */
function timeEps(t: number): number {
  return Math.max(1e-18, Math.abs(t) * 1e-12);
}
