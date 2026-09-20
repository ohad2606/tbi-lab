/**
 * Gate C pin-model tests.
 *
 * These check that the electrical pin model reproduces the ESP32 datasheet's own
 * DC characteristics, rather than an invented 3.3 V ideal source.
 *
 * TOLERANCES: relative 1e-9 (dimensionless) against closed-form values derived from
 * datasheet Table 5-3; absolute 1e-12 A for KCL residuals.
 */

import { describe, expect, it } from 'vitest';
import { Circuit } from '../../gate-a-electrical/src/circuit.js';
import { Resistor, VoltageSource } from '../../gate-a-electrical/src/devices.js';
import {
  GpioPin,
  interpretDigitalInput,
  R_DRIVE_HIGH_OHM,
  R_DRIVE_LOW_OHM,
  R_PULL_OHM,
  VDD_V,
  V_IH_V,
  V_IL_V,
} from '../src/pinModel.js';

const REL = 1e-9;
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);

describe('datasheet-derived constants', () => {
  it('derives driver resistance from the datasheet drive-current points', () => {
    // High side: (3.3 - 2.64) / 40 mA
    expect(rel(R_DRIVE_HIGH_OHM, 16.5)).toBeLessThanOrEqual(1e-12);
    // Low side: 0.495 / 28 mA
    expect(rel(R_DRIVE_LOW_OHM, 0.495 / 0.028)).toBeLessThanOrEqual(1e-12);
  });

  it('uses the datasheet logic thresholds', () => {
    expect(V_IH_V).toBeCloseTo(2.475, 12); // 0.75 x 3.3
    expect(V_IL_V).toBeCloseTo(0.825, 12); // 0.25 x 3.3
  });

  it('reproduces the datasheet V_OH guarantee at its rated source current', () => {
    // Load that draws exactly I_OH = 40 mA at V_OH = 2.64 V is 66 ohm.
    const c = new Circuit();
    const pin = c.add(new GpioPin('IO2', 'pin', 'output-high'));
    c.add(new Resistor('RL', 'pin', '0', 66));
    const r = c.solve();
    expect(rel(r.nodeVoltages.get('pin')!, 2.64)).toBeLessThanOrEqual(REL);
    expect(rel(pin.current(r.x), 0.04)).toBeLessThanOrEqual(REL);
  });

  it('reproduces the datasheet V_OL guarantee at its rated sink current', () => {
    // Sinking 28 mA should put the pin at 0.495 V, so an external 3.3 V source through
    // (3.3 - 0.495)/0.028 = 100.179 ohm is the matching test condition.
    const c = new Circuit();
    c.add(new GpioPin('IO2', 'pin', 'output-low'));
    c.add(new VoltageSource('VEXT', 'src', '0', VDD_V));
    c.add(new Resistor('RL', 'src', 'pin', (VDD_V - 0.495) / 0.028));
    const r = c.solve();
    expect(rel(r.nodeVoltages.get('pin')!, 0.495)).toBeLessThanOrEqual(REL);
  });
});

describe('pin as a circuit element', () => {
  it('drives an unloaded output to the rail', () => {
    const c = new Circuit();
    c.add(new GpioPin('IO2', 'pin', 'output-high'));
    c.add(new Resistor('Rhuge', 'pin', '0', 1e9)); // effectively unloaded
    const r = c.solve();
    expect(r.nodeVoltages.get('pin')!).toBeGreaterThan(3.29);
    expect(r.nodeVoltages.get('pin')!).toBeLessThanOrEqual(VDD_V);
  });

  it('sags under load exactly as a Thevenin source should', () => {
    // 100 ohm load: V = VDD * RL / (RL + Rdrive)
    const RL = 100;
    const c = new Circuit();
    c.add(new GpioPin('IO2', 'pin', 'output-high'));
    c.add(new Resistor('RL', 'pin', '0', RL));
    const r = c.solve();
    const expected = (VDD_V * RL) / (RL + R_DRIVE_HIGH_OHM);
    expect(rel(r.nodeVoltages.get('pin')!, expected)).toBeLessThanOrEqual(REL);
    expect(r.maxKclResidualA).toBeLessThanOrEqual(1e-12);
  });

  it('presents the datasheet pull-up when enabled', () => {
    // Pull-up into a 45k external pull-down gives half the rail.
    const c = new Circuit();
    c.add(new GpioPin('IO5', 'pin', 'input-pullup'));
    c.add(new Resistor('RPD', 'pin', '0', R_PULL_OHM));
    const r = c.solve();
    expect(r.nodeVoltages.get('pin')!).toBeGreaterThan(1.6);
    expect(r.nodeVoltages.get('pin')!).toBeLessThan(1.7);
  });

  it('is high impedance as a plain input', () => {
    const c = new Circuit();
    const pin = c.add(new GpioPin('IO5', 'pin', 'input'));
    c.add(new VoltageSource('VEXT', 'pin', '0', 3.3));
    const r = c.solve();
    // Leakage bounded by the datasheet's 50 nA at 3.3 V.
    expect(Math.abs(pin.current(r.x))).toBeLessThanOrEqual(50e-9);
  });

  it('reports a Thevenin equivalent matching the drive mode', () => {
    const high = new GpioPin('IO2', 'pin', 'output-high').thevenin();
    expect(rel(high.voltageV, VDD_V)).toBeLessThanOrEqual(REL);
    expect(rel(high.resistanceOhm, R_DRIVE_HIGH_OHM)).toBeLessThanOrEqual(REL);

    const low = new GpioPin('IO2', 'pin', 'output-low').thevenin();
    expect(Math.abs(low.voltageV)).toBeLessThanOrEqual(1e-12);
    expect(rel(low.resistanceOhm, R_DRIVE_LOW_OHM)).toBeLessThanOrEqual(REL);
  });
});

describe('digital input interpretation', () => {
  it('reads HIGH at or above V_IH and LOW at or below V_IL', () => {
    expect(interpretDigitalInput(3.3, 0)).toBe(1);
    expect(interpretDigitalInput(V_IH_V, 0)).toBe(1);
    expect(interpretDigitalInput(0, 1)).toBe(0);
    expect(interpretDigitalInput(V_IL_V, 1)).toBe(0);
  });

  it('holds the previous level in the undefined band between V_IL and V_IH', () => {
    const mid = (V_IH_V + V_IL_V) / 2;
    expect(interpretDigitalInput(mid, 0)).toBe(0);
    expect(interpretDigitalInput(mid, 1)).toBe(1);
  });
});
