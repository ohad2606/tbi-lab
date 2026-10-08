/**
 * Sprint 11 (R1), slice 5: the photoresistor (GL5528) in a divider read by an ESP32 input pad as a
 * DIGITAL level (no ADC: analogRead stays refused). 3.3 V -> LDR -> [GPIO35] -> 10 kΩ -> GND: the
 * pad reads HIGH at or above V_IH, LOW at or below V_IL, and holds its previous level in between.
 * Reference: the closed-form divider with R(E) = R10 (E/10)^-0.6 and the pad leakage.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  G_INPUT_LEAKAGE_S,
  V_IH_V,
  V_IL_V,
  interpretDigitalInput,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { boardBench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};
const R_LEAK = 1 / G_INPUT_LEAKAGE_S;
const parallel = (a: number, b: number) => (a * b) / (a + b);

import { ldrResistance } from '../src/parts/photoresistor.js';

function ldrDivider(lux: number) {
  return boardBench((b, u) => {
    const ldr = b.add('component.photoresistor');
    const r = b.add('component.resistor');
    b.psu(3.3, 0.1).ohms(r, 10_000).set(ldr, 'illuminance', { value: lux, unit: 'lux' });
    b.wire('PSU1.positive', `${ldr}.a`).wire(`${ldr}.b`, `${u}.gpio35`);
    b.wire(`${ldr}.b`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
  });
}
const expected = (lux: number) => {
  const low = parallel(10_000, R_LEAK);
  return (3.3 * low) / (low + ldrResistance(lux));
};

describe('photoresistor divider into GPIO35, digital threshold (slice 5)', () => {
  it('bright, dark and in between: the solved voltage and the level the pad reports', () => {
    const bb = ldrDivider(200);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    let rev = 1;
    const at = (lux: number) => {
      expect(s.applyControl('LDR1', { params: { illuminance: lux } }, ++rev)).toBeNull();
      const v = ok(s.solve()).pins![0]!.voltage;
      expect(v).toBeCloseTo(expected(lux), 9);
      return v;
    };
    // Bright (200 lx): above V_IH -> HIGH whatever the previous level.
    const bright = at(200);
    expect(bright).toBeGreaterThanOrEqual(V_IH_V);
    expect(interpretDigitalInput(bright, 0)).toBe(1);
    // Dark (1 lx): below V_IL -> LOW.
    const dark = at(1);
    expect(dark).toBeLessThanOrEqual(V_IL_V);
    expect(interpretDigitalInput(dark, 1)).toBe(0);
    // In between (20 lx): the pad HOLDS its previous level (the datasheet's undefined band).
    const mid = at(20);
    expect(mid).toBeGreaterThan(V_IL_V);
    expect(mid).toBeLessThan(V_IH_V);
    expect(interpretDigitalInput(mid, 0)).toBe(0);
    expect(interpretDigitalInput(mid, 1)).toBe(1);
  });

  it('the thresholds of this divider: about 111 lx (HIGH) and 2.9 lx (LOW), from the law itself', () => {
    // Solve R(E) for V = V_IH and V = V_IL (bisection on the closed form).
    const luxAt = (v: number) => {
      let lo = 1;
      let hi = 10_000;
      for (let k = 0; k < 200; k++) {
        const mid = Math.sqrt(lo * hi);
        if (expected(mid) < v) lo = mid;
        else hi = mid;
      }
      return Math.sqrt(lo * hi);
    };
    expect(luxAt(V_IH_V)).toBeGreaterThan(100);
    expect(luxAt(V_IH_V)).toBeLessThan(125);
    expect(luxAt(V_IL_V)).toBeGreaterThan(2.5);
    expect(luxAt(V_IL_V)).toBeLessThan(3.3);
  });

  it('a 5 V divider can lift the pad above 3.6 V: the over-voltage warning, values unchanged', () => {
    const bb = boardBench((b, u) => {
      const ldr = b.add('component.photoresistor');
      const r = b.add('component.resistor');
      b.psu(5, 0.1).ohms(r, 10_000).set(ldr, 'illuminance', { value: 1000, unit: 'lux' });
      b.wire('PSU1.positive', `${ldr}.a`).wire(`${ldr}.b`, `${u}.gpio35`);
      b.wire(`${ldr}.b`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    });
    const out = ok(new EngineSession(bb.projected, { pins: bb.pins }).solve());
    expect(ratingWarnings(bb.full, out).map((w) => w.code)).toEqual(['gpio_input_overvoltage']);
  });
});
