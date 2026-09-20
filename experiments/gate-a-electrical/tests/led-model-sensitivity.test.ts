/**
 * Quantifies the one documented approximation in the Gate A device models: the assumed
 * emission coefficient N of the red LED.
 *
 * The Vishay TLHR5400 datasheet gives a single typical forward operating point, so N cannot
 * be identified from it. N is assumed and I_S is fitted to the anchor. This test makes the
 * resulting uncertainty visible and bounded instead of leaving it implicit:
 *   - every fit reproduces the datasheet anchor exactly, by construction
 *   - the spread of the resulting 5 V / 220 Ohm operating point across the plausible
 *     N range 1.8 ... 2.5 is asserted against documented bounds
 */

import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/circuit.js';
import { Diode, Resistor, VoltageSource } from '../src/devices.js';
import {
  fitSaturationCurrent,
  TLHR5400_ANCHOR,
  T_AMBIENT_K,
  thermalVoltage,
  type DiodeModel,
} from '../src/models.js';

const N_RANGE = [1.8, 1.9, 2.0, 2.2, 2.5];
const SUPPLY_V = 5;
const SERIES_R = 220;

function modelFor(n: number): DiodeModel {
  return {
    name: `TLHR5400_N${n}`,
    saturationCurrentA: fitSaturationCurrent(
      TLHR5400_ANCHOR.forwardVoltageV,
      TLHR5400_ANCHOR.forwardCurrentA,
      n,
    ),
    emissionCoefficient: n,
    seriesResistanceOhm: 0,
    temperatureK: T_AMBIENT_K,
    provenance: 'sensitivity sweep',
  };
}

function operatingPoint(model: DiodeModel): { currentA: number; voltageV: number } {
  const c = new Circuit();
  c.add(new VoltageSource('V1', 'vcc', '0', SUPPLY_V));
  c.add(new Resistor('R1', 'vcc', 'anode', SERIES_R));
  c.add(new Diode('D1', 'anode', '0', model));
  const r = c.solve();
  return { currentA: r.deviceCurrents.get('D1')!, voltageV: r.nodeVoltages.get('anode')! };
}

describe('LED model parameter identification', () => {
  it('reproduces the datasheet anchor exactly for every assumed N', () => {
    for (const n of N_RANGE) {
      const m = modelFor(n);
      const nVt = n * thermalVoltage(T_AMBIENT_K);
      const iAtAnchor = m.saturationCurrentA * (Math.exp(TLHR5400_ANCHOR.forwardVoltageV / nVt) - 1);
      const relErr = Math.abs(iAtAnchor - TLHR5400_ANCHOR.forwardCurrentA) / TLHR5400_ANCHOR.forwardCurrentA;
      // Relative, dimensionless. The fit is exact up to floating-point round-off.
      expect(relErr, `anchor reproduction at N=${n}`).toBeLessThanOrEqual(1e-12);
    }
  });

  it('bounds the operating-point uncertainty caused by the assumed N', () => {
    const points = N_RANGE.map((n) => ({ n, ...operatingPoint(modelFor(n)) }));
    for (const p of points) {
      // Recorded in docs/sprints/SPRINT-0.md; printed so the numbers are reproducible.
      console.log(
        `N=${p.n.toFixed(1)}  I = ${(p.currentA * 1000).toFixed(4)} mA  V_LED = ${p.voltageV.toFixed(4)} V`,
      );
    }
    const currents = points.map((p) => p.currentA);
    const min = Math.min(...currents);
    const max = Math.max(...currents);
    const spreadRelative = (max - min) / ((max + min) / 2);

    // DOCUMENTED BOUND (measured 2026-09-20): across N = 1.8 ... 2.5 the predicted branch
    // current spans 13.7157 mA to 13.7458 mA, a spread of 0.22 % of the mean.
    //
    // The sensitivity is small because I_S is re-fitted to the 20 mA datasheet anchor for
    // each N, and the test operating point (~13.7 mA) sits close to that anchor. The
    // assumed N would matter far more at currents decades away from it. This bounds the
    // Gate A conclusion; it is NOT an accuracy claim about a physical TLHR5400.
    expect(min).toBeGreaterThan(0.0135);
    expect(max).toBeLessThan(0.0140);
    expect(spreadRelative).toBeLessThan(0.005);
  });
});
