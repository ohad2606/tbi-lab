/**
 * Gate A required electrical reference cases.
 *
 * TOLERANCES - every one is stated explicitly, with its kind (absolute/relative) and unit:
 *
 *   REL_TOL_ANALYTIC         1e-9   relative, dimensionless. Used where a closed-form
 *                                   analytic answer exists (linear networks, and CC-mode
 *                                   operation where the branch equation fixes the current).
 *   ABS_TOL_ZERO_CURRENT_A   1e-12  absolute, amperes. Used for the open-circuit case,
 *                                   where the expected value is exactly zero and a relative
 *                                   tolerance is undefined.
 *   REL_TOL_NONLINEAR        1e-9   relative, dimensionless. Used for the LED case against
 *                                   an independent bisection solution of the same model
 *                                   equation (see solveLedOperatingPoint below).
 *   ABS_TOL_KCL_A            1e-12  absolute, amperes. Max |sum of currents leaving a node|
 *                                   evaluated with the EXACT nonlinear device equations.
 *   ABS_TOL_BRANCH_V         1e-12  absolute, volts. Max |V(+) - V(-) - setpoint| for
 *                                   voltage-defined branches.
 *   ABS_TOL_BRANCH_A         1e-12  absolute, amperes. Max |j - limit| for current-defined
 *                                   branches.
 */

import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/circuit.js';
import { Diode, LabPsu, Resistor, VoltageSource } from '../src/devices.js';
import { LED_TLHR5400, thermalVoltage } from '../src/models.js';
import { SimulationSession } from '../src/api.js';

const REL_TOL_ANALYTIC = 1e-9;
const ABS_TOL_ZERO_CURRENT_A = 1e-12;
const REL_TOL_NONLINEAR = 1e-9;
const ABS_TOL_KCL_A = 1e-12;
const ABS_TOL_BRANCH_V = 1e-12;
const ABS_TOL_BRANCH_A = 1e-12;

function expectRelative(actual: number, expected: number, relTol: number, label: string): void {
  const err = Math.abs(actual - expected) / Math.abs(expected);
  expect(err, `${label}: got ${actual}, expected ${expected}, relative error ${err}`).toBeLessThanOrEqual(relTol);
}

function expectResiduals(r: {
  maxKclResidualA: number;
  maxBranchResidualV: number;
  maxBranchResidualA: number;
}): void {
  expect(r.maxKclResidualA, 'max KCL residual (A)').toBeLessThanOrEqual(ABS_TOL_KCL_A);
  expect(r.maxBranchResidualV, 'max branch residual (V)').toBeLessThanOrEqual(ABS_TOL_BRANCH_V);
  expect(r.maxBranchResidualA, 'max branch residual (A)').toBeLessThanOrEqual(ABS_TOL_BRANCH_A);
}

describe('Gate A reference case 1: 5 V source + 1 kOhm', () => {
  it('draws exactly 5 mA', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'n1', '0', 5));
    c.add(new Resistor('R1', 'n1', '0', 1000));

    const r = c.solve();
    expectRelative(r.deviceCurrents.get('R1')!, 5e-3, REL_TOL_ANALYTIC, 'I(R1)');
    // The source delivers the same current out of its + terminal.
    expectRelative(r.deviceCurrents.get('V1')!, 5e-3, REL_TOL_ANALYTIC, 'I(V1) delivered');
    expectRelative(r.nodeVoltages.get('n1')!, 5, REL_TOL_ANALYTIC, 'V(n1)');
    expectResiduals(r);
  });
});

describe('Gate A reference case 2: 12 V, 10 k / 10 k divider', () => {
  it('has a 6 V midpoint', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'top', '0', 12));
    c.add(new Resistor('R1', 'top', 'mid', 10_000));
    c.add(new Resistor('R2', 'mid', '0', 10_000));

    const r = c.solve();
    expectRelative(r.nodeVoltages.get('mid')!, 6, REL_TOL_ANALYTIC, 'V(mid)');
    expectRelative(r.deviceCurrents.get('R1')!, 0.6e-3, REL_TOL_ANALYTIC, 'I(R1)');
    expectResiduals(r);
  });
});

describe('Gate A reference case 3: 9 V, 1 k + 2 k in series', () => {
  it('draws exactly 3 mA', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'a', '0', 9));
    c.add(new Resistor('R1', 'a', 'b', 1000));
    c.add(new Resistor('R2', 'b', '0', 2000));

    const r = c.solve();
    expectRelative(r.deviceCurrents.get('R1')!, 3e-3, REL_TOL_ANALYTIC, 'I(R1)');
    expectRelative(r.deviceCurrents.get('R2')!, 3e-3, REL_TOL_ANALYTIC, 'I(R2)');
    expectRelative(r.nodeVoltages.get('b')!, 6, REL_TOL_ANALYTIC, 'V(b) = 9 V * 2k/3k');
    expectResiduals(r);
  });
});

describe('Gate A reference case 4: open circuit', () => {
  it('carries zero current', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'a', '0', 5));
    // R1 terminates on a node with no other connection: an open circuit.
    c.add(new Resistor('R1', 'a', 'dangling', 1000));

    const r = c.solve();
    expect(Math.abs(r.deviceCurrents.get('R1')!), 'I(R1)').toBeLessThanOrEqual(ABS_TOL_ZERO_CURRENT_A);
    expect(Math.abs(r.deviceCurrents.get('V1')!), 'I(V1)').toBeLessThanOrEqual(ABS_TOL_ZERO_CURRENT_A);
    // With no current, the open end sits at the source potential.
    expectRelative(r.nodeVoltages.get('dangling')!, 5, REL_TOL_ANALYTIC, 'V(dangling)');
    expectResiduals(r);
  });
});

describe('Gate A reference case 5: lab PSU 5 V / 100 mA limit into 10 Ohm', () => {
  it('enters current limit and delivers 100 mA at 1 V', () => {
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RL', 'out', '0', 10));

    const r = c.solve();

    // The mode is an outcome of the electrical solution, not a test-side decision.
    expect(r.supplyModes.get('PSU1'), 'PSU mode').toBe('CC');
    expectRelative(r.deviceCurrents.get('PSU1')!, 0.1, REL_TOL_ANALYTIC, 'I(PSU1)');
    expectRelative(r.deviceCurrents.get('RL')!, 0.1, REL_TOL_ANALYTIC, 'I(RL)');
    expectRelative(r.nodeVoltages.get('out')!, 1, REL_TOL_ANALYTIC, 'V(load) = 100 mA * 10 Ohm');
    expectResiduals(r);
  });

  it('stays in constant-voltage mode when the load does not reach the limit', () => {
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RL', 'out', '0', 1000)); // 5 mA << 100 mA limit

    const r = c.solve();
    expect(r.supplyModes.get('PSU1'), 'PSU mode').toBe('CV');
    expectRelative(r.nodeVoltages.get('out')!, 5, REL_TOL_ANALYTIC, 'V(load)');
    expectRelative(r.deviceCurrents.get('PSU1')!, 5e-3, REL_TOL_ANALYTIC, 'I(PSU1)');
    expectResiduals(r);
  });

  it('crosses over at exactly the load that reaches the limit', () => {
    // 5 V / 100 mA => crossover at 50 Ohm. Just above: CV. Just below: CC.
    const justAbove = new Circuit();
    justAbove.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    justAbove.add(new Resistor('RL', 'out', '0', 50.0001));
    expect(justAbove.solve().supplyModes.get('PSU1')).toBe('CV');

    const justBelow = new Circuit();
    justBelow.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    justBelow.add(new Resistor('RL', 'out', '0', 49.9999));
    expect(justBelow.solve().supplyModes.get('PSU1')).toBe('CC');
  });
});

describe('Gate A reference case 6: short circuit on a current-limited PSU', () => {
  it('limits at the current setting instead of diverging', () => {
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    // A "short" is not a zero-resistance ideal wire: it is the finite resistance of the
    // shorting conductor. 1 mOhm is a realistic lead/wire resistance.
    c.add(new Resistor('RSHORT', 'out', '0', 1e-3));

    const r = c.solve();
    expect(r.supplyModes.get('PSU1'), 'PSU mode').toBe('CC');
    expectRelative(r.deviceCurrents.get('PSU1')!, 0.1, REL_TOL_ANALYTIC, 'I(PSU1)');
    expectRelative(r.nodeVoltages.get('out')!, 1e-4, REL_TOL_ANALYTIC, 'V(out) = 100 mA * 1 mOhm');
    expectResiduals(r);
  });
});

/**
 * Independent reference for the LED case: solve the same physical equation
 *   Vsupply = Vj + R * Is * (exp(Vj / (N*Vt)) - 1)
 * by bisection, which shares no code path with the MNA solver (no matrices, no Newton,
 * no stamps). Bisection is run to the limit of double precision.
 */
function solveLedOperatingPoint(supplyV: number, resistanceOhm: number): { vj: number; current: number } {
  const nVt = LED_TLHR5400.emissionCoefficient * thermalVoltage(LED_TLHR5400.temperatureK);
  const diodeCurrent = (vj: number): number => LED_TLHR5400.saturationCurrentA * (Math.exp(vj / nVt) - 1);
  // f(vj) = supply - vj - R*I(vj) is monotonically decreasing in vj.
  const f = (vj: number): number => supplyV - vj - resistanceOhm * diodeCurrent(vj);
  let lo = 0;
  let hi = supplyV;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const vj = 0.5 * (lo + hi);
  return { vj, current: diodeCurrent(vj) };
}

describe('Gate A reference case 7: LED + series resistor', () => {
  const SUPPLY_V = 5;
  const SERIES_R = 220;

  it('matches an independent solution of the same Shockley model', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'vcc', '0', SUPPLY_V));
    c.add(new Resistor('R1', 'vcc', 'anode', SERIES_R));
    c.add(new Diode('D1', 'anode', '0', LED_TLHR5400));

    const r = c.solve();
    const ref = solveLedOperatingPoint(SUPPLY_V, SERIES_R);

    expectRelative(r.deviceCurrents.get('D1')!, ref.current, REL_TOL_NONLINEAR, 'I(D1)');
    expectRelative(r.nodeVoltages.get('anode')!, ref.vj, REL_TOL_NONLINEAR, 'V(LED)');
    // Kirchhoff's voltage law across the loop must hold at the solution.
    expectRelative(
      r.nodeVoltages.get('anode')! + SERIES_R * r.deviceCurrents.get('R1')!,
      SUPPLY_V,
      REL_TOL_NONLINEAR,
      'KVL around the loop',
    );
    expectResiduals(r);
  });

  it('produces a physically sensible operating point for a red indicator LED', () => {
    const ref = solveLedOperatingPoint(SUPPLY_V, SERIES_R);
    // Sanity band, not the numerical acceptance criterion: a 5 V / 220 Ohm red LED branch
    // should sit in the 10-20 mA indicator range at roughly 1.8-2.1 V.
    expect(ref.current).toBeGreaterThan(0.010);
    expect(ref.current).toBeLessThan(0.020);
    expect(ref.vj).toBeGreaterThan(1.8);
    expect(ref.vj).toBeLessThan(2.1);
  });

  it('is deterministic: repeated solves return bit-identical results', () => {
    const build = (): Circuit => {
      const c = new Circuit();
      c.add(new VoltageSource('V1', 'vcc', '0', SUPPLY_V));
      c.add(new Resistor('R1', 'vcc', 'anode', SERIES_R));
      c.add(new Diode('D1', 'anode', '0', LED_TLHR5400));
      return c;
    };
    const a = build().solve();
    const b = build().solve();
    expect(b.deviceCurrents.get('D1')).toBe(a.deviceCurrents.get('D1'));
    expect(b.nodeVoltages.get('anode')).toBe(a.nodeVoltages.get('anode'));
    expect(b.newtonIterations).toBe(a.newtonIterations);
  });
});

describe('Gate A candidate API surface', () => {
  it('exposes node voltage, branch current and supply control', () => {
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RL', 'out', '0', 10));
    const sim = new SimulationSession(c);

    sim.stepSimulation(0);
    expect(sim.getSupplyMode('PSU1')).toBe('CC');
    expectRelative(sim.getNodeVoltage('out'), 1, REL_TOL_ANALYTIC, 'V(out) in CC');

    // Raising the current limit moves the same circuit into constant-voltage operation.
    sim.setCurrentLimit('PSU1', 1.0);
    sim.stepSimulation(0);
    expect(sim.getSupplyMode('PSU1')).toBe('CV');
    expectRelative(sim.getNodeVoltage('out'), 5, REL_TOL_ANALYTIC, 'V(out) in CV');
    expectRelative(sim.getBranchCurrent('RL'), 0.5, REL_TOL_ANALYTIC, 'I(RL) = 5 V / 10 Ohm');

    // Lowering the setpoint scales the operating point accordingly.
    sim.setSupplyVoltage('PSU1', 3.3);
    sim.stepSimulation(0);
    expectRelative(sim.getNodeVoltage('out'), 3.3, REL_TOL_ANALYTIC, 'V(out) after setpoint change');
    expectRelative(sim.getBranchCurrent('RL'), 0.33, REL_TOL_ANALYTIC, 'I(RL) after setpoint change');
  });
});
