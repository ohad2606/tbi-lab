/**
 * Time-kernel PROTOTYPE (Sprint 19B, Exploration Foundation EF-1, Milestone T). Isolated: nothing
 * in the product uses it until its gates pass and the owner approves exposing it.
 *
 * A variable-step transient driver over the engine's own time-stepped solve (EngineSession.advance:
 * backward Euler, L-stable, the companion models of devices.ts). What it adds, and how it stays
 * truthful:
 *
 * - **Step control by measured error, never by a fixed guess.** Each step of length h is solved
 *   once (h) and as two half steps (h/2 + h/2) from the same checkpoint; the difference (with the
 *   Richardson factor of the method's order: trapezoidal 1/3, backward Euler 1) estimates the
 *   local error of the half-step solution. A step is accepted only when every node voltage is
 *   within `absTolV + relTol·|v|` AND every component current within `absTolA + relTol·|i|`
 *   (currents catch trapezoidal ringing, which leaves node voltages unchanged: a capacitor held
 *   by an ideal source); the half-step state is the one kept. A rejected trapezoidal step is
 *   retried at the same length with backward Euler (L-stable), then at half length. A step below
 *   `dtMin` is REFUSED (`transient_step_floor`): the kernel never accepts an error it cannot
 *   bound. Every state the kernel returns, including the steps up to and across an event, passed
 *   this check.
 * - **Deterministic event ordering.** Breakpoints (known discontinuities: a stimulus edge, the end
 *   of a window) are kept sorted by (time, insertion order) and are always step boundaries,
 *   exactly. Step control is a pure function of the circuit's state: no wall clock, so the same
 *   circuit and breakpoints give the same steps, bit for bit.
 * - **Event localization.** When a trial step changes a part's discrete state (a relay armature,
 *   a threshold, a supply's CV/CC mode), in either solution or at the half-step midpoint, the
 *   change is bracketed by bisection within `eventTolS`; the kernel then steps (error-checked) to
 *   the bracket's start and crosses it with one backward-Euler step, where the state changes.
 *   `eventTolS` bounds the bracket on the COMPUTED trajectory; the event time's error against the
 *   true circuit is the trajectory's own voltage error divided by the slope at the threshold.
 *   No state change is ever smeared across a step.
 * - **Bounded resources.** At most `budgetSolvesPerSimS` solves per simulated second of each window,
 *   at least `minBudgetSolves` per window (`transient_budget_exceeded`, by name: never a larger
 *   step to save time). Checked before each trial; one trial (3 solves, plus at most
 *   log2(dtMax / eventTolS) + 1 for a bisection) may complete past it.
 * - **Inputs may change between windows** (a button, a setpoint, a pin mode): a window after any
 *   input change (EngineSession.inputRevision) starts with backward Euler, as after a breakpoint.
 * - **Timing-sensitive logic is refused.** Logic parts (Sprint 19B L1) have no delay model here,
 *   and the datasheet's input transition-rate limit (Δt/Δv) would be violated by RC edges:
 *   `transient_logic_unsupported` until both are modelled.
 */
import type { EngineSession, SessionCheckpoint, SolveOutcome, SolveSuccess } from '../session.js';

export interface KernelOptions {
  /** Absolute and relative local error tolerance on node voltages and component currents. */
  absTolV: number;
  absTolA: number;
  relTol: number;
  /** Smallest step the kernel will take (s); below it, refused. */
  dtMin: number;
  /** Largest step (s). */
  dtMax: number;
  /** First step (s). */
  dtInitial: number;
  /** Event localization tolerance on the computed trajectory (s). */
  eventTolS: number;
  /** Solve budget per simulated second of a window, and the least budget of any window. */
  budgetSolvesPerSimS: number;
  minBudgetSolves: number;
  /** Trapezoidal between discontinuities (true) or backward Euler throughout (false). */
  secondOrder: boolean;
}

export const DEFAULT_KERNEL_OPTIONS: KernelOptions = {
  absTolV: 1e-3,
  absTolA: 1e-6,
  relTol: 1e-3,
  dtMin: 1e-9,
  dtMax: 1e-2,
  dtInitial: 1e-6,
  eventTolS: 1e-8,
  budgetSolvesPerSimS: 200_000,
  minBudgetSolves: 1_000,
  secondOrder: true,
};

export type KernelRefusal =
  | 'transient_step_floor'
  | 'transient_budget_exceeded'
  | 'transient_logic_unsupported'
  | 'transient_solve_failed'
  | 'transient_time_not_ahead';

export interface KernelEvent {
  /** Simulated time the discrete change happened at (s): the end of the crossing step. */
  time: number;
  /** Parts whose discrete state (or supply mode) changed, sorted. */
  parts: string[];
  /**
   * Width of the crossing step (s): the change happened in (time − bracketS, time] on the computed
   * trajectory. eventTolS, or wider where a shorter step was numerically too stiff to solve.
   */
  bracketS?: number;
}

export type KernelResult =
  | {
      ok: true;
      outcome: SolveSuccess;
      time: number;
      steps: number;
      solves: number;
      events: KernelEvent[];
      /** The end time of every accepted step of this window, in order. */
      stepEnds: number[];
    }
  | { ok: false; code: KernelRefusal; time: number; detail?: Record<string, unknown> };

type Method = 'backward-euler' | 'trapezoidal';

type Trial =
  | { kind: 'accept'; outcome: SolveSuccess; err: number; changed: string[] }
  | { kind: 'reject' }
  | { kind: 'bracket'; lo: number; hi: number }
  | { kind: 'failed'; error: unknown };

export class TransientKernel {
  readonly opts: KernelOptions;
  private dt: number;
  private readonly breakpoints: { t: number; seq: number }[] = [];
  private seq = 0;
  private readonly logic: boolean;
  /** Backward Euler at the start and after a breakpoint or event; trapezoidal in between. */
  private method: Method = 'backward-euler';
  /** The last accepted state (the reference for supply-mode changes). */
  private last: SolveSuccess | null = null;
  /** A bracketed event ahead: step (checked) to `lo`, then cross to `hi` with backward Euler. */
  private pending: { lo: number; hi: number } | null = null;
  /** The session's input revision the kernel last integrated under. */
  private inputs: number;
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
    this.inputs = session.inputRevision;
  }

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
    if (tEnd < start - timeEps(start))
      return { ok: false, code: 'transient_time_not_ahead', time: start, detail: { tEnd } };
    const budget = Math.max(
      this.opts.minBudgetSolves,
      Math.ceil(this.opts.budgetSolvesPerSimS * Math.max(tEnd - start, 0)),
    );
    const solvesAtStart = this.solves;
    const events: KernelEvent[] = [];
    const stepEnds: number[] = [];
    let steps = 0;
    // An input changed since the last window (a step change): backward Euler first.
    if (this.session.inputRevision !== this.inputs) {
      this.inputs = this.session.inputRevision;
      this.method = 'backward-euler';
    }
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
      let target = Math.min(tEnd, next ? next.t : Infinity);
      const crossing =
        this.pending !== null && Math.abs(t - this.pending.lo) <= timeEps(this.pending.lo);
      let h: number;
      if (crossing) {
        target = this.pending!.hi;
        h = target - t;
        this.method = 'backward-euler';
      } else {
        if (this.pending && this.pending.lo > t) target = Math.min(target, this.pending.lo);
        else this.pending = null;
        // Land exactly on the target when the step would reach it (no sliver step after it).
        h = Math.min(this.dt, this.opts.dtMax, target - t);
        if (target - t - h < this.opts.dtMin) h = target - t;
      }
      const method = this.method;
      const r = this.trial(h, crossing);
      if (r.kind === 'failed') {
        this.rejected++;
        if (crossing) {
          // A very short crossing step can be numerically too stiff (C/h ≫ the other conductances:
          // the solver's exact-equation check rejects it). Widen the bracket (still a true one:
          // no change at lo) and cross again; refused only when it would exceed dtMax.
          const p = this.pending!;
          const wider = p.lo + 2 * (p.hi - p.lo);
          if (wider - p.lo > this.opts.dtMax)
            return {
              ok: false,
              code: 'transient_solve_failed',
              time: t,
              detail: { error: r.error },
            };
          this.pending = { lo: p.lo, hi: wider };
          continue;
        }
        // A solve that fails at this length (e.g. Newton at a large step): retry shorter.
        if (h / 2 < this.opts.dtMin)
          return { ok: false, code: 'transient_solve_failed', time: t, detail: { error: r.error } };
        this.dt = h / 2;
        continue;
      }
      if (r.kind === 'bracket') {
        this.pending = { lo: t + r.lo, hi: t + r.hi };
        continue;
      }
      if (r.kind === 'reject') {
        this.rejected++;
        if (method === 'trapezoidal') {
          // Ringing or a too-long step: the same length with the L-stable method first.
          this.method = 'backward-euler';
          this.dt = h;
          continue;
        }
        this.pending = null;
        this.dt = h / 2;
        if (this.dt < this.opts.dtMin)
          return { ok: false, code: 'transient_step_floor', time: t, detail: { dt: this.dt } };
        continue;
      }
      // Steps sum in floating point: a boundary reached within rounding IS reached (never a
      // sliver step of ~1e-17 s, whose C/dt would be numerically singular). Exact time label.
      if (Math.abs(target - this.time) <= timeEps(target)) {
        this.session.restore({ ...this.session.checkpoint(), time: target });
        r.outcome.time = target;
      }
      this.last = r.outcome;
      steps++;
      stepEnds.push(this.time);
      const bracketS = crossing ? h : undefined;
      if (crossing) this.pending = null;
      if (r.changed.length) {
        events.push({ time: this.time, parts: r.changed, ...(bracketS ? { bracketS } : {}) });
        this.method = 'backward-euler';
        this.dt = Math.max(this.opts.dtInitial, this.opts.dtMin);
        continue;
      }
      // The next step: backward Euler right after a breakpoint (a discontinuity), else trapezoidal.
      const atBreakpoint = this.breakpoints.some(
        (bp) => Math.abs(bp.t - this.time) <= timeEps(bp.t),
      );
      this.method = atBreakpoint || !this.opts.secondOrder ? 'backward-euler' : 'trapezoidal';
      if (crossing) continue; // keep the step length from before the bracket
      // Grow (at most ×2) by the measured error: local error ∝ h^(p+1), p the order of the step.
      const p = method === 'trapezoidal' ? 2 : 1;
      const grow = r.err > 0 ? Math.min(2, 0.9 * r.err ** (-1 / (p + 1))) : 2;
      this.dt = Math.min(this.opts.dtMax, Math.max(this.opts.dtMin, h * Math.max(grow, 0.5)));
    }
    this.steps += steps;
    if (!this.last)
      return { ok: false, code: 'transient_time_not_ahead', time: this.time, detail: { tEnd } };
    return {
      ok: true,
      outcome: this.last,
      time: this.time,
      steps,
      solves: this.solves - solvesAtStart,
      events,
      stepEnds,
    };
  }

  private advance(h: number): SolveOutcome {
    this.solves++;
    return this.session.advance(h, this.method);
  }

  /**
   * One step of h from the current state: accepted (half-step state kept), rejected (restored),
   * a discrete change bracketed (restored), or failed (restored). A crossing step (`crossing`)
   * may change state: it is accepted when its error is within tolerance, the change reported.
   */
  private trial(h: number, crossing: boolean): Trial {
    const cp = this.session.checkpoint();
    const prev = this.last;
    const full = this.advance(h);
    if (!full.ok) {
      this.session.restore(cp);
      return { kind: 'failed', error: full.error };
    }
    const afterFull = this.session.checkpoint();
    this.session.restore(cp);
    const a = this.advance(h / 2);
    const mid = this.session.checkpoint();
    const b = a.ok ? this.advance(h / 2) : a;
    if (!a.ok || !b.ok) {
      this.session.restore(cp);
      return { kind: 'failed', error: (b as { error: unknown }).error };
    }
    const end = this.session.checkpoint();
    const changedAnywhere = union(
      changedParts(cp, mid),
      changedParts(mid, end),
      changedParts(cp, afterFull),
      modeChanged(prev, a),
      modeChanged(a, b),
      modeChanged(prev, full),
    );
    if (changedAnywhere.length && !crossing) {
      this.session.restore(cp);
      const br = this.localize(cp, prev, h);
      this.session.restore(cp);
      // The single step of h does not show it (a change and its reversal, or only in the half
      // steps): a shorter step resolves it.
      return br ?? { kind: 'reject' };
    }
    const k = this.method === 'trapezoidal' ? 1 / 3 : 1;
    const { absTolV, absTolA, relTol } = this.opts;
    let err = 0;
    for (const [net, v] of Object.entries(b.netVoltages)) {
      const vf = full.netVoltages[net];
      if (vf === undefined) continue;
      err = Math.max(err, (k * Math.abs(vf - v)) / (absTolV + relTol * Math.abs(v)));
    }
    // Across a crossing step the state changes (a contact, a supply's CV/CC mode): currents may
    // jump there, so only the (continuous) node voltages are compared; every other step checks
    // currents too.
    for (const [id, c] of crossing ? [] : Object.entries(b.components)) {
      const i = c.current;
      const iF = full.components[id]?.current;
      if (i === null || iF === null || iF === undefined) continue;
      err = Math.max(err, (k * Math.abs(iF - i)) / (absTolA + relTol * Math.abs(i)));
    }
    if (err > 1) {
      this.session.restore(cp);
      return { kind: 'reject' };
    }
    return {
      kind: 'accept',
      outcome: b,
      err,
      changed: union(changedParts(cp, end), modeChanged(prev, b)),
    };
  }

  /**
   * A discrete change within (t, t + h] on a single step from `cp`: bisect for the longest step
   * that does NOT change it (lo) and the shortest that does (hi), until hi − lo ≤ eventTolS.
   * Null when a single step of h shows no change. The session is left anywhere: callers restore.
   */
  private localize(
    cp: SessionCheckpoint,
    prev: SolveSuccess | null,
    h: number,
  ): { kind: 'bracket'; lo: number; hi: number } | null {
    const changesAt = (dt: number): boolean | null => {
      this.session.restore(cp);
      const o = this.advance(dt);
      if (!o.ok) return null;
      return (
        changedParts(cp, this.session.checkpoint()).length > 0 || modeChanged(prev, o).length > 0
      );
    };
    if (changesAt(h) !== true) return null;
    let lo = 0;
    let hi = h;
    while (hi - lo > this.opts.eventTolS) {
      const mid = (lo + hi) / 2;
      const c = changesAt(mid);
      if (c === null) return null;
      if (c) hi = mid;
      else lo = mid;
    }
    return { kind: 'bracket', lo, hi };
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

/** Supplies whose operating mode (CV / CC / off) differs between two states (an active-set event). */
function modeChanged(a: SolveSuccess | null, b: SolveSuccess): string[] {
  if (!a) return [];
  return Object.values(b.components)
    .filter((c) => c.mode !== undefined && a.components[c.id]?.mode !== undefined)
    .filter((c) => a.components[c.id]!.mode !== c.mode)
    .map((c) => c.id)
    .sort();
}

const union = (...lists: string[][]): string[] => [...new Set(lists.flat())].sort();

/** Rounding tolerance for simulated times (s): relative 1e-12, at least 1e-18. */
function timeEps(t: number): number {
  return Math.max(1e-18, Math.abs(t) * 1e-12);
}
