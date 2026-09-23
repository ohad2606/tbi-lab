/**
 * Gate A's seven reference cases, re-run on the PROMOTED production engine.
 *
 * Tolerances are exactly those of experiments/gate-a-electrical/tests/reference-cases.test.ts
 * (none widened): 1e-9 relative for analytic and nonlinear cases, 1e-12 A / 1e-12 V absolute
 * for zero-current and residual checks. In addition, every value must be BIT-IDENTICAL to
 * the frozen feasibility engine's output, captured in gate-a-golden.json (so no test imports
 * experiments/).
 */
import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/circuit.js';
import { Diode, LabPsu, Resistor, VoltageSource } from '../src/devices.js';
import { LED_TLHR5400, thermalVoltage } from '../src/models.js';
import golden from './gate-a-golden.json';

const REL_TOL_ANALYTIC = 1e-9;
const ABS_TOL_ZERO_CURRENT_A = 1e-12;
const REL_TOL_NONLINEAR = 1e-9;
const ABS_TOL = 1e-12;

const g = golden as Record<string, Record<string, string | null>>;
const fromHex = (h: string) =>
  new Float64Array(Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16))).buffer)[0]!;
const bits = (x: number) =>
  [...new Uint8Array(new Float64Array([x]).buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

function rel(actual: number, expected: number, tol: number, label: string) {
  expect(
    Math.abs(actual - expected) / Math.abs(expected),
    `${label}: ${actual} vs ${expected}`,
  ).toBeLessThanOrEqual(tol);
}
function residuals(r: {
  maxKclResidualA: number;
  maxBranchResidualV: number;
  maxBranchResidualA: number;
}) {
  expect(r.maxKclResidualA).toBeLessThanOrEqual(ABS_TOL);
  expect(r.maxBranchResidualV).toBeLessThanOrEqual(ABS_TOL);
  expect(r.maxBranchResidualA).toBeLessThanOrEqual(ABS_TOL);
}
function identical(name: string, values: Record<string, number>) {
  for (const [k, v] of Object.entries(values))
    expect(bits(v), `${name}.${k} bit pattern`).toBe(g[name]![k]);
}

function ledReference(supplyV: number, r: number) {
  const nVt = LED_TLHR5400.emissionCoefficient * thermalVoltage(LED_TLHR5400.temperatureK);
  const i = (vj: number) => LED_TLHR5400.saturationCurrentA * (Math.exp(vj / nVt) - 1);
  let lo = 0;
  let hi = supplyV;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    if (supplyV - mid - r * i(mid) > 0) lo = mid;
    else hi = mid;
  }
  const vj = 0.5 * (lo + hi);
  return { vj, current: i(vj) };
}

describe('Gate A reference cases on the production engine', () => {
  it('1: 5 V + 1 kΩ draws 5 mA', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'n1', '0', 5));
    c.add(new Resistor('R1', 'n1', '0', 1000));
    const r = c.solve();
    rel(r.deviceCurrents.get('R1')!, 5e-3, REL_TOL_ANALYTIC, 'I(R1)');
    residuals(r);
    identical('case1', { iR1: r.deviceCurrents.get('R1')!, vN1: r.nodeVoltages.get('n1')! });
  });

  it('2: 12 V divider has a 6 V midpoint', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'top', '0', 12));
    c.add(new Resistor('R1', 'top', 'mid', 10_000));
    c.add(new Resistor('R2', 'mid', '0', 10_000));
    const r = c.solve();
    rel(r.nodeVoltages.get('mid')!, 6, REL_TOL_ANALYTIC, 'V(mid)');
    residuals(r);
    identical('case2', { vMid: r.nodeVoltages.get('mid')!, iR1: r.deviceCurrents.get('R1')! });
  });

  it('3: 9 V across 1 kΩ + 2 kΩ draws 3 mA', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'a', '0', 9));
    c.add(new Resistor('R1', 'a', 'b', 1000));
    c.add(new Resistor('R2', 'b', '0', 2000));
    const r = c.solve();
    rel(r.deviceCurrents.get('R1')!, 3e-3, REL_TOL_ANALYTIC, 'I(R1)');
    residuals(r);
    identical('case3', { iR1: r.deviceCurrents.get('R1')!, vB: r.nodeVoltages.get('b')! });
  });

  it('4: open circuit carries zero current', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'a', '0', 5));
    c.add(new Resistor('R1', 'a', 'dangling', 1000));
    const r = c.solve();
    expect(Math.abs(r.deviceCurrents.get('R1')!)).toBeLessThanOrEqual(ABS_TOL_ZERO_CURRENT_A);
    rel(r.nodeVoltages.get('dangling')!, 5, REL_TOL_ANALYTIC, 'V(dangling)');
    residuals(r);
    identical('case4', {
      iR1: r.deviceCurrents.get('R1')!,
      vDangling: r.nodeVoltages.get('dangling')!,
    });
  });

  it('5: 5 V / 100 mA PSU into 10 Ω enters CC at 100 mA, 1 V', () => {
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RL', 'out', '0', 10));
    const r = c.solve();
    expect(r.supplyModes.get('PSU1')).toBe('CC');
    rel(r.deviceCurrents.get('PSU1')!, 0.1, REL_TOL_ANALYTIC, 'I(PSU1)');
    rel(r.nodeVoltages.get('out')!, 1, REL_TOL_ANALYTIC, 'V(out)');
    residuals(r);
    identical('case5', { iPsu: r.deviceCurrents.get('PSU1')!, vOut: r.nodeVoltages.get('out')! });
  });

  it('6: current-limited short stays at the limit', () => {
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RSHORT', 'out', '0', 1e-3));
    const r = c.solve();
    expect(r.supplyModes.get('PSU1')).toBe('CC');
    rel(r.deviceCurrents.get('PSU1')!, 0.1, REL_TOL_ANALYTIC, 'I(PSU1)');
    rel(r.nodeVoltages.get('out')!, 1e-4, REL_TOL_ANALYTIC, 'V(out)');
    residuals(r);
    identical('case6', { iPsu: r.deviceCurrents.get('PSU1')!, vOut: r.nodeVoltages.get('out')! });
  });

  it('7: LED + 220 Ω matches an independent bisection of the same Shockley model', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'vcc', '0', 5));
    c.add(new Resistor('R1', 'vcc', 'anode', 220));
    c.add(new Diode('D1', 'anode', '0', LED_TLHR5400));
    const r = c.solve();
    const ref = ledReference(5, 220);
    rel(r.deviceCurrents.get('D1')!, ref.current, REL_TOL_NONLINEAR, 'I(D1)');
    rel(r.nodeVoltages.get('anode')!, ref.vj, REL_TOL_NONLINEAR, 'V(anode)');
    residuals(r);
    identical('case7', { iD1: r.deviceCurrents.get('D1')!, vAnode: r.nodeVoltages.get('anode')! });
  });

  it('is deterministic: repeated solves are bit-identical', () => {
    const build = () => {
      const c = new Circuit();
      c.add(new LabPsu('PSU1', 'vcc', '0', 5, 0.1));
      c.add(new Resistor('R1', 'vcc', 'anode', 220));
      c.add(new Diode('D1', 'anode', '0', LED_TLHR5400));
      return c.solve();
    };
    const a = build();
    const b = build();
    expect(bits(b.deviceCurrents.get('D1')!)).toBe(bits(a.deviceCurrents.get('D1')!));
    expect(b.newtonIterations).toBe(a.newtonIterations);
    identical('case7psu', {
      iD1: a.deviceCurrents.get('D1')!,
      vAnode: a.nodeVoltages.get('anode')!,
    });
  });

  it('golden fixture decodes to the documented values', () => {
    expect(fromHex(g.case1!.iR1!)).toBeCloseTo(5e-3, 15);
    expect(fromHex(g.case5!.vOut!)).toBeCloseTo(1, 12);
  });
});
