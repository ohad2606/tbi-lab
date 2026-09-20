/**
 * Candidate simulation-layer API surface (Gate A, "required API direction").
 *
 * This is a shape demonstration, not a committed interface. It exists to show that a
 * future simulation layer can expose per-node and per-component queries plus supply
 * control on top of the solver, without the caller knowing anything about MNA.
 */

import { Circuit, type SolveOptions, type SolveResult } from './circuit.js';
import { LabPsu, type PsuMode } from './devices.js';

export class SimulationSession {
  private result: SolveResult | null = null;

  constructor(private readonly circuit: Circuit, private readonly options: SolveOptions = {}) {}

  /**
   * Re-solve the operating point.
   *
   * Sprint 0 is DC-only, so this computes a quasi-static operating point and `dt` is
   * recorded but unused. The parameter exists so the later transient path (companion
   * models with a real timestep) is not designed out of the API.
   */
  stepSimulation(dt: number): SolveResult {
    if (!(dt >= 0)) throw new Error('stepSimulation: dt must be >= 0');
    this.result = this.circuit.solve(this.options);
    return this.result;
  }

  private current(): SolveResult {
    if (!this.result) throw new Error('No solution yet: call stepSimulation() first');
    return this.result;
  }

  /** Node voltage in volts, referenced to ground. */
  getNodeVoltage(nodeId: string): number {
    const v = this.current().nodeVoltages.get(nodeId);
    if (v === undefined) throw new Error(`Unknown node: ${nodeId}`);
    return v;
  }

  /** Device current in amperes, using the device's documented sign convention. */
  getBranchCurrent(componentId: string): number {
    const i = this.current().deviceCurrents.get(componentId);
    if (i === undefined) throw new Error(`Unknown component: ${componentId}`);
    return i;
  }

  setSupplyVoltage(supplyId: string, voltage: number): void {
    this.psu(supplyId).setpointV = voltage;
    this.result = null;
  }

  setCurrentLimit(supplyId: string, current: number): void {
    if (!(current > 0)) throw new Error('setCurrentLimit: limit must be > 0');
    this.psu(supplyId).currentLimitA = current;
    this.result = null;
  }

  /** Which mode the electrical solution put the supply in. */
  getSupplyMode(supplyId: string): PsuMode {
    const m = this.current().supplyModes.get(supplyId);
    if (!m) throw new Error(`Unknown supply: ${supplyId}`);
    return m;
  }

  private psu(id: string): LabPsu {
    const d = this.circuit.getDevice(id);
    if (!(d instanceof LabPsu)) throw new Error(`Device ${id} is not a lab PSU`);
    return d;
  }
}
