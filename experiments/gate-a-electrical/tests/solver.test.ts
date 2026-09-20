/**
 * Solver-level unit tests: linear algebra, sign conventions, and the refusal behaviour
 * that keeps a wrong operating point from ever being reported as a result.
 */

import { describe, expect, it } from 'vitest';
import { solveLinearSystem, SingularMatrixError } from '../src/linalg.js';
import { Circuit, ConvergenceError } from '../src/circuit.js';
import { CurrentSource, Diode, LabPsu, Resistor, VoltageSource } from '../src/devices.js';
import { LED_TLHR5400 } from '../src/models.js';

describe('dense linear solver', () => {
  it('solves a known system exactly', () => {
    // 2x + y = 5 ; x - 3y = -8  =>  x = 1, y = 3
    const x = solveLinearSystem(
      [
        [2, 1],
        [1, -3],
      ],
      [5, -8],
    );
    expect(x[0]!).toBeCloseTo(1, 12);
    expect(x[1]!).toBeCloseTo(3, 12);
  });

  it('uses partial pivoting so a zero leading pivot is not fatal', () => {
    const x = solveLinearSystem(
      [
        [0, 2],
        [1, 1],
      ],
      [4, 3],
    );
    expect(x[0]!).toBeCloseTo(1, 12);
    expect(x[1]!).toBeCloseTo(2, 12);
  });

  it('rejects a singular system instead of returning nonsense', () => {
    expect(() =>
      solveLinearSystem(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toThrow(SingularMatrixError);
  });
});

describe('sign conventions', () => {
  it('reports source current positive when delivered out of the + terminal', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'n1', '0', 10));
    c.add(new Resistor('R1', 'n1', '0', 100));
    const r = c.solve();
    expect(r.deviceCurrents.get('V1')!).toBeGreaterThan(0);
    expect(r.deviceCurrents.get('V1')!).toBeCloseTo(0.1, 12);
  });

  it('reports resistor current positive from its first to its second terminal', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'n1', '0', 10));
    c.add(new Resistor('Rfwd', 'n1', '0', 100));
    c.add(new Resistor('Rrev', '0', 'n1', 100));
    const r = c.solve();
    expect(r.deviceCurrents.get('Rfwd')!).toBeCloseTo(0.1, 12);
    expect(r.deviceCurrents.get('Rrev')!).toBeCloseTo(-0.1, 12);
  });

  it('drives current into the node from an independent current source', () => {
    const c = new Circuit();
    c.add(new CurrentSource('I1', 'n1', '0', 2e-3));
    c.add(new Resistor('R1', 'n1', '0', 1000));
    const r = c.solve();
    expect(r.nodeVoltages.get('n1')!).toBeCloseTo(2, 12);
  });
});

describe('refusal behaviour', () => {
  it('rejects a solution that fails exact-equation verification', () => {
    // Force the verification gate to be unsatisfiable by demanding a residual far below
    // what double precision can deliver. The solver must refuse rather than report.
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'vcc', '0', 5));
    c.add(new Resistor('R1', 'vcc', 'anode', 220));
    c.add(new Diode('D1', 'anode', '0', LED_TLHR5400));

    expect(() => c.solve({ residualCurrentAbsTolA: 0, residualRelTol: 0 })).toThrow(ConvergenceError);
  });

  it('reports non-convergence instead of returning a partial result', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'vcc', '0', 5));
    c.add(new Resistor('R1', 'vcc', 'anode', 220));
    c.add(new Diode('D1', 'anode', '0', LED_TLHR5400));
    // The LED case needs ~16 Newton iterations; 3 is not enough.
    expect(() => c.solve({ maxNewtonIterations: 3 })).toThrow(ConvergenceError);
  });

  it('rejects duplicate device ids', () => {
    const c = new Circuit();
    c.add(new Resistor('R1', 'a', '0', 100));
    expect(() => c.add(new Resistor('R1', 'a', '0', 100))).toThrow(/Duplicate device id/);
  });
});

describe('PSU active set', () => {
  it('reaches the same solution regardless of the mode it starts from', () => {
    const build = (): Circuit => {
      const c = new Circuit();
      c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
      c.add(new Resistor('RL', 'out', '0', 10));
      return c;
    };
    const fromCv = build();
    const a = fromCv.solve();

    const fromCc = build();
    (fromCc.getDevice('PSU1') as LabPsu).setMode('CC');
    const b = fromCc.solve();

    expect(b.supplyModes.get('PSU1')).toBe(a.supplyModes.get('PSU1'));
    expect(b.nodeVoltages.get('out')).toBe(a.nodeVoltages.get('out'));
  });

  it('puts a current-limited supply into CC when feeding an LED branch', () => {
    // Nonlinear load plus an active set: both mechanisms must cooperate.
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'vcc', '0', 5, 5e-3));
    c.add(new Resistor('R1', 'vcc', 'anode', 220));
    c.add(new Diode('D1', 'anode', '0', LED_TLHR5400));
    const r = c.solve();
    expect(r.supplyModes.get('PSU1')).toBe('CC');
    expect(r.deviceCurrents.get('D1')!).toBeCloseTo(5e-3, 9);
    expect(r.maxKclResidualA).toBeLessThanOrEqual(1e-12);
  });
});
