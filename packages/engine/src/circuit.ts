/*
 * PROMOTED (Sprint 3) from experiments/gate-a-electrical/src/circuit.ts at tag sprint-1-complete.
 * The numerical logic is unchanged; production edits are limited to those listed in
 * packages/engine/PROVENANCE.md. experiments/ keeps the original as frozen Gate A evidence.
 */
/**
 * Modified Nodal Analysis DC solver.
 *
 * Structure:
 *   outer loop  - active set over lab-PSU CV/CC modes (a linear complementarity problem)
 *   inner loop  - Newton-Raphson over nonlinear junctions
 *   verification - exact (non-linearised) KCL and branch-equation residuals at the solution
 *
 * The solver is deterministic: same netlist in, same numbers out. There is no randomness,
 * no time dependence, and no iteration-order dependence on hash ordering (node indices are
 * assigned in device insertion order).
 */

import { solveLinearSystem, zeroMatrix } from './linalg.js';
import {
  GROUND_NAMES,
  LabPsu,
  type Device,
  type Indexer,
  type PsuMode,
  type StampOptions,
  type StampTarget,
  type TimeStep,
} from './devices.js';

/** Upper bound on the steps of one transient run (bounded numerical work). */
export const MAX_TRANSIENT_STEPS = 100_000;

export interface TransientOptions extends SolveOptions {
  /** Step length, seconds. */
  dt: number;
  /** Number of steps after time zero. */
  steps: number;
  /** Integration rule (default trapezoidal). */
  method?: TimeStep['method'];
  /** Time zero: the DC operating point (default) or the all-zero (discharged) state. */
  initial?: 'op' | 'zero';
  /**
   * Deterministic stimulus: called before step k (1-based) is solved, with the time it solves
   * for (k * dt). It may change device values (a source's voltage, a switch's resistance); the
   * change applies from that step on. This is how time-varying inputs enter a run.
   * Return `true` when it made a step change (a discontinuity): that one step is then integrated
   * with backward Euler, as SPICE does at a breakpoint, because the trapezoidal rule integrates
   * straight across a jump and leaves an error proportional to the step (and can ring).
   */
  beforeStep?: (k: number, t: number) => boolean | void;
}

export interface TransientResult {
  /** Sample times, seconds: 0, dt, 2 dt, ... */
  time: Float64Array;
  /** Node name -> voltage at each sample. */
  nodeVoltages: Map<string, Float64Array>;
  /** Device id -> current at each sample (device sign conventions). */
  deviceCurrents: Map<string, Float64Array>;
  /** Newton iterations over all steps. */
  newtonIterations: number;
}

export interface SolveOptions {
  /** Max Newton iterations per active-set pass. */
  maxNewtonIterations?: number;
  /** Max active-set passes over PSU modes. */
  maxActiveSetIterations?: number;
  /** Newton convergence: |dx_i| <= absTol + relTol * |x_i| for every unknown. */
  newtonAbsTol?: number;
  newtonRelTol?: number;
  /** Conductance in parallel with nonlinear junctions, siemens. */
  gmin?: number;
  /** Dead-band used when testing PSU complementarity conditions. */
  psuCurrentToleranceA?: number;
  psuVoltageToleranceV?: number;
  /**
   * Post-solve verification thresholds. The solver REFUSES to return a solution whose
   * exact (non-linearised) residuals exceed these, because reporting a wrong operating
   * point is worse than reporting failure. Thresholds are
   *   current: residualCurrentAbsTolA + residualRelTol * max|device current|
   *   voltage: residualVoltageAbsTolV + residualRelTol * max|node voltage|
   */
  residualCurrentAbsTolA?: number;
  residualVoltageAbsTolV?: number;
  residualRelTol?: number;
}

export interface SolveResult {
  /** Node name -> voltage in volts. Ground is present and always exactly 0. */
  nodeVoltages: ReadonlyMap<string, number>;
  /** Device id -> current in amperes, using each device's documented sign convention. */
  deviceCurrents: ReadonlyMap<string, number>;
  /** Lab PSU id -> the mode the electrical solution settled in. */
  supplyModes: ReadonlyMap<string, PsuMode>;
  /** Largest |sum of currents leaving a node|, amperes, from the EXACT device equations. */
  maxKclResidualA: number;
  /** Largest |branch equation error| in volts (CV sources) at the solution. */
  maxBranchResidualV: number;
  /** Largest |branch equation error| in amperes (CC sources) at the solution. */
  maxBranchResidualA: number;
  newtonIterations: number;
  activeSetIterations: number;
  /** Raw unknown vector, for debugging only. */
  x: readonly number[];
}

export class ConvergenceError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConvergenceError';
  }
}

const DEFAULTS = {
  maxNewtonIterations: 200,
  maxActiveSetIterations: 32,
  newtonAbsTol: 1e-12,
  newtonRelTol: 1e-12,
  gmin: 1e-12,
  psuCurrentToleranceA: 1e-12,
  psuVoltageToleranceV: 1e-12,
  residualCurrentAbsTolA: 1e-12,
  residualVoltageAbsTolV: 1e-12,
  residualRelTol: 1e-9,
} as const;

export class Circuit {
  private readonly devices: Device[] = [];
  private nodeIndices = new Map<string, number>();
  private branchIndices = new Map<string, number>();
  private size = 0;

  add<T extends Device>(device: T): T {
    if (this.devices.some((d) => d.id === device.id)) {
      throw new Error(`Duplicate device id: ${device.id}`);
    }
    this.devices.push(device);
    return device;
  }

  getDevice(id: string): Device {
    const d = this.devices.find((x) => x.id === id);
    if (!d) throw new Error(`Unknown device: ${id}`);
    return d;
  }

  /** All non-ground node names, in index order. */
  nodes(): string[] {
    this.buildIndex();
    return [...this.nodeIndices.keys()];
  }

  private buildIndex(): void {
    this.nodeIndices = new Map();
    this.branchIndices = new Map();
    let n = 0;
    for (const d of this.devices) {
      for (const name of d.nodeNames()) {
        if (GROUND_NAMES.has(name)) continue;
        if (!this.nodeIndices.has(name)) this.nodeIndices.set(name, n++);
      }
    }
    let b = n;
    for (const d of this.devices) {
      if (d.hasBranch) this.branchIndices.set(d.id, b++);
    }
    this.size = b;

    const idx: Indexer = {
      node: (name) => (GROUND_NAMES.has(name) ? -1 : this.nodeIndices.get(name)!),
      branch: (id) => this.branchIndices.get(id)!,
    };
    for (const d of this.devices) d.prepare(idx);
  }

  private assemble(
    x: readonly number[] | null,
    opts: StampOptions,
  ): { A: number[][]; z: number[] } {
    const A = zeroMatrix(this.size);
    const z = new Array<number>(this.size).fill(0);
    const target: StampTarget = {
      addA: (r, c, v) => {
        A[r]![c] = A[r]![c]! + v;
      },
      addZ: (r, v) => {
        z[r] = z[r]! + v;
      },
    };
    for (const d of this.devices) d.stamp(target, x, opts);
    return { A, z };
  }

  solve(options: SolveOptions = {}): SolveResult {
    return this.solveAt(options, undefined);
  }

  /**
   * Fixed-step transient analysis (Sprint 10, INTERNAL: no product feature uses it yet; see
   * docs/sprints/SPRINT-10-ARCHITECTURE.md). Deterministic: the same circuit and options give
   * the same numbers. Time zero is the DC operating point (capacitors open), or the all-zero
   * state ('zero': every capacitor discharged). Each step is solved by the same Newton, PSU
   * active-set and exact-verification machinery as a DC solve, with stateful devices replaced by
   * their companion models; the work is bounded by `steps`.
   */
  transient(options: TransientOptions): TransientResult {
    const {
      dt,
      steps,
      method = 'trapezoidal',
      initial = 'op',
      beforeStep,
      ...solveOptions
    } = options;
    if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('transient: dt must be > 0');
    if (!Number.isInteger(steps) || steps < 1 || steps > MAX_TRANSIENT_STEPS)
      throw new Error(`transient: steps must be an integer in 1..${MAX_TRANSIENT_STEPS}`);
    const gmin = solveOptions.gmin ?? DEFAULTS.gmin;
    const step: TimeStep = { dt, method };
    const record = (r: SolveResult, k: number) => {
      out.time[k] = k * dt;
      for (const [n, v] of r.nodeVoltages)
        (out.nodeVoltages.get(n) ?? set(out.nodeVoltages, n))[k] = v;
      for (const [d, i] of r.deviceCurrents)
        (out.deviceCurrents.get(d) ?? set(out.deviceCurrents, d))[k] = i;
    };
    const set = (m: Map<string, Float64Array>, key: string) => {
      const a = new Float64Array(steps + 1);
      m.set(key, a);
      return a;
    };
    const out: TransientResult = {
      time: new Float64Array(steps + 1),
      nodeVoltages: new Map(),
      deviceCurrents: new Map(),
      newtonIterations: 0,
    };
    if (initial === 'op') {
      const op = this.solveAt(solveOptions, undefined);
      for (const d of this.devices) d.initializeState?.(op.x, { gmin });
      record(op, 0);
    } else {
      // Time zero of a discharged circuit: every capacitor held at 0 V. Solved as one backward-
      // Euler step of negligible length (dt * 1e-9) from the discharged state, so a capacitor is
      // a 0 V short there; the solution is the true t = 0+ state, including the current that
      // starts flowing into each capacitor (which the trapezoidal rule needs as its history).
      this.buildIndex();
      for (const d of this.devices) d.initializeState?.(null, { gmin });
      const start: TimeStep = { dt: dt * 1e-9, method: 'backward-euler' };
      const r0 = this.solveAt(solveOptions, start);
      for (const d of this.devices) d.acceptStep?.(r0.x, { gmin, step: start });
      out.newtonIterations += r0.newtonIterations;
      record(r0, 0);
    }
    for (let k = 1; k <= steps; k++) {
      const jump = beforeStep?.(k, k * dt) === true;
      const thisStep: TimeStep = jump ? { dt, method: 'backward-euler' } : step;
      const r = this.solveAt(solveOptions, thisStep);
      for (const d of this.devices) d.acceptStep?.(r.x, { gmin, step: thisStep });
      out.newtonIterations += r.newtonIterations;
      record(r, k);
    }
    return out;
  }

  private solveAt(options: SolveOptions, step: TimeStep | undefined): SolveResult {
    const o = { ...DEFAULTS, ...options };
    const stampOpts: StampOptions = step ? { gmin: o.gmin, step } : { gmin: o.gmin };

    this.buildIndex();
    for (const d of this.devices) d.resetState();
    if (this.size === 0) throw new Error('Circuit has no unknowns');

    const psus = this.devices.filter((d): d is LabPsu => d instanceof LabPsu);

    // eslint-disable-next-line no-useless-assignment -- promoted verbatim from Gate A
    let x: number[] | null = null;
    let newtonTotal = 0;
    let activeSetPasses = 0;
    const visitedModeSets = new Set<string>();

    for (;;) {
      activeSetPasses++;
      if (activeSetPasses > o.maxActiveSetIterations) {
        throw new ConvergenceError('Active-set iteration limit reached (PSU mode cycling)', {
          activeSetPasses,
          modes: psus.map((p) => `${p.id}:${p.mode}`),
        });
      }

      // ---- Newton-Raphson on the current active set ----
      let converged = false;
      let iterations = 0;
      x = null;
      for (let it = 0; it < o.maxNewtonIterations; it++) {
        const { A, z } = this.assemble(x, stampOpts);
        const xNew = solveLinearSystem(A, z);
        iterations++;
        if (x !== null) {
          // A small step in x is meaningless while a device is still damping its junction
          // voltage: the linearisation point is not the solution vector yet.
          let ok = !this.devices.some((d) => d.limitingActive);
          for (let i = 0; ok && i < xNew.length; i++) {
            const dx = Math.abs(xNew[i]! - x[i]!);
            if (dx > o.newtonAbsTol + o.newtonRelTol * Math.abs(xNew[i]!)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            x = xNew;
            converged = true;
            break;
          }
        }
        x = xNew;
      }
      newtonTotal += iterations;
      if (!converged || x === null) {
        throw new ConvergenceError('Newton-Raphson did not converge', {
          iterations,
          limitingDevices: this.devices.filter((d) => d.limitingActive).map((d) => d.id),
          modes: psus.map((p) => `${p.id}:${p.mode}`),
        });
      }

      // ---- Active-set update: does the solution satisfy the PSU complementarity conditions? ----
      let changed = false;
      for (const psu of psus) {
        const implied = psu.impliedMode(x, o.psuCurrentToleranceA, o.psuVoltageToleranceV);
        if (implied !== psu.mode) {
          psu.setMode(implied);
          changed = true;
        }
      }
      if (!changed) break;

      const key = psus.map((p) => `${p.id}:${p.mode}`).join('|');
      if (visitedModeSets.has(key)) {
        throw new ConvergenceError('PSU active set cycled without reaching a consistent solution', {
          key,
        });
      }
      visitedModeSets.add(key);
    }

    return this.report(x, stampOpts, newtonTotal, activeSetPasses, o);
  }

  /** Build the result and verify it against the exact, non-linearised device equations. */
  private report(
    x: readonly number[],
    stampOpts: StampOptions,
    newtonIterations: number,
    activeSetIterations: number,
    o: Required<SolveOptions>,
  ): SolveResult {
    const nodeVoltages = new Map<string, number>([['0', 0]]);
    for (const [name, i] of this.nodeIndices) nodeVoltages.set(name, x[i]!);

    const deviceCurrents = new Map<string, number>();
    const supplyModes = new Map<string, PsuMode>();
    for (const d of this.devices) {
      deviceCurrents.set(d.id, d.current(x, stampOpts));
      if (d instanceof LabPsu) supplyModes.set(d.id, d.mode);
    }

    // Exact KCL residual per node.
    const residualByNode = new Array<number>(this.nodeIndices.size).fill(0);
    for (const d of this.devices) {
      for (const tc of d.exactTerminalCurrents(x, stampOpts)) {
        if (tc.nodeIndex >= 0)
          residualByNode[tc.nodeIndex] = residualByNode[tc.nodeIndex]! + tc.currentLeaving;
      }
    }
    const maxKclResidualA = residualByNode.reduce((m, r) => Math.max(m, Math.abs(r)), 0);

    let maxBranchResidualV = 0;
    let maxBranchResidualA = 0;
    for (const d of this.devices) {
      const r = d.branchResidual(x);
      if (!r) continue;
      if (r.unit === 'V') maxBranchResidualV = Math.max(maxBranchResidualV, Math.abs(r.value));
      else maxBranchResidualA = Math.max(maxBranchResidualA, Math.abs(r.value));
    }

    // Verification gate: a converged-looking Newton step is not evidence of a correct
    // operating point. The solution must satisfy the exact device equations.
    const maxCurrentMagnitude = [...deviceCurrents.values()].reduce(
      (m, i) => Math.max(m, Math.abs(i)),
      0,
    );
    const maxVoltageMagnitude = [...nodeVoltages.values()].reduce(
      (m, v) => Math.max(m, Math.abs(v)),
      0,
    );
    const currentThreshold = o.residualCurrentAbsTolA + o.residualRelTol * maxCurrentMagnitude;
    const voltageThreshold = o.residualVoltageAbsTolV + o.residualRelTol * maxVoltageMagnitude;
    if (
      !Number.isFinite(maxKclResidualA) ||
      maxKclResidualA > currentThreshold ||
      maxBranchResidualA > currentThreshold ||
      maxBranchResidualV > voltageThreshold
    ) {
      throw new ConvergenceError('Solution failed exact-equation verification and was rejected', {
        maxKclResidualA,
        maxBranchResidualA,
        maxBranchResidualV,
        currentThreshold,
        voltageThreshold,
        newtonIterations,
        activeSetIterations,
      });
    }

    return {
      nodeVoltages,
      deviceCurrents,
      supplyModes,
      maxKclResidualA,
      maxBranchResidualV,
      maxBranchResidualA,
      newtonIterations,
      activeSetIterations,
      x,
    };
  }
}
