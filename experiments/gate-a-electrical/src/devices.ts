/**
 * Device models and their MNA stamps.
 *
 * Sign conventions (fixed for the whole experiment, asserted by tests):
 *  - KCL rows are written as "sum of currents LEAVING the node through all devices = 0".
 *  - Two-terminal passive devices report current positive from their first to their
 *    second terminal.
 *  - Sources (voltage source, lab PSU, current source) report current positive when
 *    DELIVERED out of the "+" terminal into the external circuit.
 */

import { thermalVoltage, type DiodeModel } from './models.js';

export const GROUND_NAMES = new Set(['0', 'gnd', 'GND', 'ground']);

export interface Indexer {
  /** Row/column index of a node, or -1 for ground (which has no equation). */
  node(name: string): number;
  /** Row/column index of this device's branch-current unknown. */
  branch(deviceId: string): number;
}

export interface StampTarget {
  addA(row: number, col: number, value: number): void;
  addZ(row: number, value: number): void;
}

export interface StampOptions {
  /** Conductance added in parallel with every nonlinear junction, siemens. */
  readonly gmin: number;
}

export interface TerminalCurrent {
  nodeIndex: number;
  /** Current leaving that node through this device, amperes. */
  currentLeaving: number;
}

export interface Device {
  readonly id: string;
  readonly kind: string;
  /**
   * True when the device damped the last Newton step (junction-voltage limiting).
   * While any device is limiting, the linearisation point is NOT the solution vector, so
   * the solver must not declare convergence no matter how small the step in x looks.
   */
  readonly limitingActive: boolean;
  /** All node names this device connects to, including internal nodes it creates. */
  nodeNames(): string[];
  /** True if the device introduces a branch-current unknown. */
  readonly hasBranch: boolean;
  /** Resolve node/branch indices. Called once per solve, before any stamping. */
  prepare(idx: Indexer): void;
  /** Reset any iteration state so a solve is reproducible from a cold start. */
  resetState(): void;
  /** Stamp into A and z, linearised about x (x is null on the first iteration). */
  stamp(t: StampTarget, x: readonly number[] | null, opts: StampOptions): void;
  /** Exact, non-linearised terminal currents at a candidate solution. */
  exactTerminalCurrents(x: readonly number[], opts: StampOptions): TerminalCurrent[];
  /** Exact residual of the device's own branch equation (volts or amperes), or null. */
  branchResidual(x: readonly number[]): { value: number; unit: 'V' | 'A' } | null;
  /** Reported device current, amperes, using the sign convention documented above. */
  current(x: readonly number[], opts: StampOptions): number;
}

/** Helper: stamp only if the node is not ground. */
function addA(t: StampTarget, r: number, c: number, v: number): void {
  if (r >= 0 && c >= 0) t.addA(r, c, v);
}
function addZ(t: StampTarget, r: number, v: number): void {
  if (r >= 0) t.addZ(r, v);
}
function nodeVoltage(x: readonly number[], index: number): number {
  return index < 0 ? 0 : x[index]!;
}

abstract class TwoTerminal implements Device {
  abstract readonly kind: string;
  readonly hasBranch: boolean = false;
  readonly limitingActive = false;
  protected ia = -1;
  protected ib = -1;

  constructor(
    readonly id: string,
    protected readonly nodeA: string,
    protected readonly nodeB: string,
  ) {}

  nodeNames(): string[] {
    return [this.nodeA, this.nodeB];
  }
  prepare(idx: Indexer): void {
    this.ia = idx.node(this.nodeA);
    this.ib = idx.node(this.nodeB);
  }
  resetState(): void {}
  branchResidual(): { value: number; unit: 'V' | 'A' } | null {
    return null;
  }
  abstract stamp(t: StampTarget, x: readonly number[] | null, opts: StampOptions): void;
  abstract exactTerminalCurrents(x: readonly number[], opts: StampOptions): TerminalCurrent[];
  abstract current(x: readonly number[], opts: StampOptions): number;
}

/** Ideal linear resistor. I = (Va - Vb) / R. */
export class Resistor extends TwoTerminal {
  readonly kind = 'resistor';
  /** Mutable: a user editing a circuit changes component values between solves. */
  constructor(id: string, nodeA: string, nodeB: string, public resistanceOhm: number) {
    super(id, nodeA, nodeB);
    if (!(resistanceOhm > 0)) throw new Error(`Resistor ${id}: resistance must be > 0`);
  }
  stamp(t: StampTarget): void {
    const g = 1 / this.resistanceOhm;
    addA(t, this.ia, this.ia, g);
    addA(t, this.ia, this.ib, -g);
    addA(t, this.ib, this.ib, g);
    addA(t, this.ib, this.ia, -g);
  }
  current(x: readonly number[]): number {
    return (nodeVoltage(x, this.ia) - nodeVoltage(x, this.ib)) / this.resistanceOhm;
  }
  exactTerminalCurrents(x: readonly number[]): TerminalCurrent[] {
    const i = this.current(x);
    return [
      { nodeIndex: this.ia, currentLeaving: i },
      { nodeIndex: this.ib, currentLeaving: -i },
    ];
  }
}

/** Ideal independent current source. Delivers `currentA` out of the + terminal. */
export class CurrentSource extends TwoTerminal {
  readonly kind = 'current-source';
  constructor(id: string, plus: string, minus: string, public currentA: number) {
    super(id, plus, minus);
  }
  stamp(t: StampTarget): void {
    addZ(t, this.ia, this.currentA);
    addZ(t, this.ib, -this.currentA);
  }
  current(): number {
    return this.currentA;
  }
  exactTerminalCurrents(): TerminalCurrent[] {
    return [
      { nodeIndex: this.ia, currentLeaving: -this.currentA },
      { nodeIndex: this.ib, currentLeaving: this.currentA },
    ];
  }
}

/** Base for devices carrying a branch-current unknown (j = current out of + terminal). */
abstract class BranchSource implements Device {
  abstract readonly kind: string;
  readonly hasBranch = true;
  readonly limitingActive = false;
  protected ia = -1;
  protected ib = -1;
  protected br = -1;

  constructor(readonly id: string, protected readonly plus: string, protected readonly minus: string) {}

  nodeNames(): string[] {
    return [this.plus, this.minus];
  }
  prepare(idx: Indexer): void {
    this.ia = idx.node(this.plus);
    this.ib = idx.node(this.minus);
    this.br = idx.branch(this.id);
  }
  resetState(): void {}

  /** Node-side stamps: the branch current leaves node "-" and enters node "+". */
  protected stampTerminals(t: StampTarget): void {
    addA(t, this.ia, this.br, -1);
    addA(t, this.ib, this.br, +1);
  }
  current(x: readonly number[]): number {
    return x[this.br]!;
  }
  exactTerminalCurrents(x: readonly number[]): TerminalCurrent[] {
    const j = x[this.br]!;
    return [
      { nodeIndex: this.ia, currentLeaving: -j },
      { nodeIndex: this.ib, currentLeaving: +j },
    ];
  }
  protected terminalVoltage(x: readonly number[]): number {
    return nodeVoltage(x, this.ia) - nodeVoltage(x, this.ib);
  }
  abstract stamp(t: StampTarget, x: readonly number[] | null, opts: StampOptions): void;
  abstract branchResidual(x: readonly number[]): { value: number; unit: 'V' | 'A' } | null;
}

/** Ideal independent voltage source: V(+) - V(-) = voltageV, unlimited current. */
export class VoltageSource extends BranchSource {
  readonly kind = 'voltage-source';
  constructor(id: string, plus: string, minus: string, public voltageV: number) {
    super(id, plus, minus);
  }
  stamp(t: StampTarget): void {
    this.stampTerminals(t);
    addA(t, this.br, this.ia, +1);
    addA(t, this.br, this.ib, -1);
    t.addZ(this.br, this.voltageV);
  }
  branchResidual(x: readonly number[]): { value: number; unit: 'V' | 'A' } {
    return { value: this.terminalVoltage(x) - this.voltageV, unit: 'V' };
  }
}

export type PsuMode = 'CV' | 'CC';

/**
 * Ideal laboratory bench PSU with constant-voltage / constant-current crossover.
 *
 * The supply is a device INSIDE the electrical model. Its operating mode is an active-set
 * variable of the electrical solution, not a post-processing clamp: the branch equation is
 *   CV:  V(+) - V(-) = setpoint        (current is whatever the network draws)
 *   CC:  j          = current limit    (terminal voltage is whatever the network imposes)
 * and the solver selects the mode that satisfies the complementarity conditions
 *   j <= I_limit  and  V_terminal <= V_setpoint.
 * The matrix structure is identical in both modes; only the branch row changes.
 *
 * Documented idealisations: no output impedance, no control-loop dynamics, instantaneous
 * mode transition, and no current sinking (a source cannot absorb current). These are
 * valid for DC steady-state operating points, which is all Sprint 0 claims.
 */
export class LabPsu extends BranchSource {
  readonly kind = 'lab-psu';
  private modeState: PsuMode = 'CV';

  constructor(
    id: string,
    plus: string,
    minus: string,
    public setpointV: number,
    public currentLimitA: number,
  ) {
    super(id, plus, minus);
    if (!(currentLimitA > 0)) throw new Error(`LabPsu ${id}: current limit must be > 0`);
  }

  get mode(): PsuMode {
    return this.modeState;
  }
  setMode(mode: PsuMode): void {
    this.modeState = mode;
  }
  override resetState(): void {
    this.modeState = 'CV';
  }

  stamp(t: StampTarget): void {
    this.stampTerminals(t);
    if (this.modeState === 'CV') {
      addA(t, this.br, this.ia, +1);
      addA(t, this.br, this.ib, -1);
      t.addZ(this.br, this.setpointV);
    } else {
      t.addA(this.br, this.br, 1);
      t.addZ(this.br, this.currentLimitA);
    }
  }

  branchResidual(x: readonly number[]): { value: number; unit: 'V' | 'A' } {
    return this.modeState === 'CV'
      ? { value: this.terminalVoltage(x) - this.setpointV, unit: 'V' }
      : { value: x[this.br]! - this.currentLimitA, unit: 'A' };
  }

  /**
   * Active-set check. Returns the mode implied by the current solution, which the solver
   * compares against the assumed mode.
   */
  impliedMode(x: readonly number[], toleranceA: number, toleranceV: number): PsuMode {
    if (this.modeState === 'CV') {
      return x[this.br]! > this.currentLimitA + toleranceA ? 'CC' : 'CV';
    }
    return this.terminalVoltage(x) > this.setpointV + toleranceV ? 'CV' : 'CC';
  }
}

/**
 * Shockley junction diode / LED.
 *
 *   I_j = I_S * (exp(V_j / (N * Vt)) - 1) + gmin * V_j
 *
 * with Vt = kT/q. gmin is the standard SPICE convergence conductance placed in parallel
 * with the junction; it is included in the exact residual computation too, so it is part
 * of the model being verified rather than a hidden fudge. Its contribution is bounded by
 * gmin * V, i.e. <= 5e-12 A at 5 V with the default gmin = 1e-12 S.
 *
 * Junction voltage limiting follows the standard SPICE pnjlim scheme, which damps Newton
 * steps in the exponential region. It affects only the ITERATION PATH, never the converged
 * solution: convergence is asserted against the exact equations above.
 */
export class Diode implements Device {
  readonly kind = 'diode';
  readonly hasBranch = false;
  private ia = -1; // anode
  private ic = -1; // cathode
  private iInt = -1; // internal node between Rs and the junction (only if Rs > 0)
  private vPrev: number | null = null;
  private limiting = false;
  private readonly internalNode: string | null;

  constructor(
    readonly id: string,
    private readonly anode: string,
    private readonly cathode: string,
    readonly model: DiodeModel,
  ) {
    this.internalNode = model.seriesResistanceOhm > 0 ? `${id}#int` : null;
  }

  nodeNames(): string[] {
    return this.internalNode ? [this.anode, this.internalNode, this.cathode] : [this.anode, this.cathode];
  }
  prepare(idx: Indexer): void {
    this.ia = idx.node(this.anode);
    this.ic = idx.node(this.cathode);
    this.iInt = this.internalNode ? idx.node(this.internalNode) : this.ia;
  }
  resetState(): void {
    this.vPrev = null;
    this.limiting = false;
  }
  get limitingActive(): boolean {
    return this.limiting;
  }
  branchResidual(): null {
    return null;
  }

  private get nVt(): number {
    return this.model.emissionCoefficient * thermalVoltage(this.model.temperatureK, this.model.constants);
  }

  /** Exact junction current for a junction voltage, amperes. */
  junctionCurrent(vj: number, gmin: number): number {
    return this.model.saturationCurrentA * (Math.exp(vj / this.nVt) - 1) + gmin * vj;
  }

  private junctionConductance(vj: number, gmin: number): number {
    return (this.model.saturationCurrentA / this.nVt) * Math.exp(vj / this.nVt) + gmin;
  }

  /** Standard SPICE pnjlim junction-voltage limiting. */
  private limit(vNew: number, vOld: number): number {
    const vt = this.nVt;
    const vcrit = vt * Math.log(vt / (Math.SQRT2 * this.model.saturationCurrentA));
    if (vNew > vcrit && Math.abs(vNew - vOld) > 2 * vt) {
      if (vOld > 0) {
        const arg = 1 + (vNew - vOld) / vt;
        return arg > 0 ? vOld + vt * Math.log(arg) : vcrit;
      }
      return vt * Math.log(vNew / vt);
    }
    return vNew;
  }

  private junctionVoltage(x: readonly number[] | null): number {
    if (x === null) return 0;
    return nodeVoltage(x, this.iInt) - nodeVoltage(x, this.ic);
  }

  stamp(t: StampTarget, x: readonly number[] | null, opts: StampOptions): void {
    // Series resistance, if modelled, as a plain conductance between anode and internal node.
    if (this.internalNode) {
      const g = 1 / this.model.seriesResistanceOhm;
      addA(t, this.ia, this.ia, g);
      addA(t, this.ia, this.iInt, -g);
      addA(t, this.iInt, this.iInt, g);
      addA(t, this.iInt, this.ia, -g);
    }

    const vRaw = this.junctionVoltage(x);
    const vj = this.vPrev === null ? vRaw : this.limit(vRaw, this.vPrev);
    this.limiting = vj !== vRaw;
    this.vPrev = vj;

    const id = this.junctionCurrent(vj, opts.gmin);
    const gd = this.junctionConductance(vj, opts.gmin);
    const ieq = id - gd * vj;

    addA(t, this.iInt, this.iInt, gd);
    addA(t, this.iInt, this.ic, -gd);
    addA(t, this.ic, this.ic, gd);
    addA(t, this.ic, this.iInt, -gd);
    addZ(t, this.iInt, -ieq);
    addZ(t, this.ic, ieq);
  }

  current(x: readonly number[], opts: StampOptions): number {
    return this.junctionCurrent(this.junctionVoltage(x), opts.gmin);
  }

  exactTerminalCurrents(x: readonly number[], opts: StampOptions): TerminalCurrent[] {
    const ij = this.current(x, opts);
    const out: TerminalCurrent[] = [
      { nodeIndex: this.iInt, currentLeaving: ij },
      { nodeIndex: this.ic, currentLeaving: -ij },
    ];
    if (this.internalNode) {
      const irs = (nodeVoltage(x, this.ia) - nodeVoltage(x, this.iInt)) / this.model.seriesResistanceOhm;
      out.push({ nodeIndex: this.ia, currentLeaving: irs });
      out.push({ nodeIndex: this.iInt, currentLeaving: -irs });
    }
    return out;
  }
}
