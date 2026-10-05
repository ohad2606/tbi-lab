/**
 * Sprint 10: the approved classic-ESP32 pad model (esp32Gpio.ts) in the invalid and edge cases a
 * student can wire, solved exactly as drawn. The engine neither hides nor "fixes" them:
 * - two outputs fighting on one node (one HIGH, one LOW): the contention current through both
 *   drivers' datasheet-derived resistances, and the node between them;
 * - an output wired straight to GND (HIGH) or to the supply (LOW): the short-circuit current the
 *   driver model gives;
 * - an input with nothing driving it: its datasheet leakage holds it at 0 V, so it reads LOW,
 *   deterministically (no random floating input).
 * The numbers are the closed-form solutions of the documented driver model (Thevenin 3.3 V
 * behind 16.5 Ω high / 17.679 Ω low; input leakage 50 nA at 3.3 V).
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  G_INPUT_LEAKAGE_S,
  R_DRIVE_HIGH_OHM,
  R_DRIVE_LOW_OHM,
  VDD_V,
  interpretDigitalInput,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};
const close = (a: number, b: number, rel = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1e-12, Math.abs(b)));

/** A tiny resistor joins two pads' nodes (a wire is not a device; 1 mΩ is far below the drivers). */
function twoPads(link: number) {
  const b = new Bench();
  const r = b.add('component.resistor');
  b.ohms(r, link).wire('PSU1.negative', 'GND1.ref').psu(5, 0.1, false);
  return { b, r };
}

describe('ESP32 pads: contention and edge cases, solved as drawn', () => {
  it('two outputs fighting (HIGH vs LOW) carry the contention current of the driver model', () => {
    const link = 1e-3;
    const { b, r } = twoPads(link);
    const s = new EngineSession(b.snapshot(), {
      pins: [
        { gpio: 2, component: r, terminal: 'a' },
        { gpio: 4, component: r, terminal: 'b' },
      ],
    });
    expect(s.setPinMode(2, 'output-high')).toBeNull();
    expect(s.setPinMode(4, 'output-low')).toBeNull();
    const out = ok(s.solve());
    const i = VDD_V / (R_DRIVE_HIGH_OHM + link + R_DRIVE_LOW_OHM);
    const high = out.pins!.find((p) => p.gpio === 2)!;
    const low = out.pins!.find((p) => p.gpio === 4)!;
    close(high.current, i);
    close(low.current, -i);
    close(high.voltage, VDD_V - i * R_DRIVE_HIGH_OHM);
    // About 97 mA: far beyond what a pad should carry; the solved value is shown, never hidden.
    expect(i).toBeGreaterThan(0.09);
    expect(i).toBeLessThan(0.1);
    // Both pads together: same mode -> no current between them.
    expect(s.setPinMode(4, 'output-high')).toBeNull();
    const same = ok(s.solve());
    expect(Math.abs(same.pins!.find((p) => p.gpio === 2)!.current)).toBeLessThan(1e-12);
  });

  it('an output HIGH wired straight to GND delivers the driver-limited short-circuit current', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    b.ohms(r, 1e-3).wire(`${r}.b`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref').psu(5, 0.1, false);
    const s = new EngineSession(b.snapshot(), { pins: [{ gpio: 2, component: r, terminal: 'a' }] });
    expect(s.setPinMode(2, 'output-high')).toBeNull();
    const pin = ok(s.solve()).pins![0]!;
    close(pin.current, VDD_V / (R_DRIVE_HIGH_OHM + 1e-3));
    expect(pin.current).toBeCloseTo(0.2, 2); // 3.3 V / 16.5 Ω
  });

  it('an output LOW wired to a 3.3 V supply sinks the driver-limited current', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    b.ohms(r, 1e-3)
      .wire('PSU1.positive', `${r}.b`)
      .wire('PSU1.negative', 'GND1.ref')
      .psu(3.3, 1, true);
    const s = new EngineSession(b.snapshot(), { pins: [{ gpio: 4, component: r, terminal: 'a' }] });
    expect(s.setPinMode(4, 'output-low')).toBeNull();
    const pin = ok(s.solve()).pins![0]!;
    close(pin.current, -3.3 / (R_DRIVE_LOW_OHM + 1e-3), 1e-6);
  });

  it('an input with nothing driving it sits at 0 V through its leakage and reads LOW, every time', () => {
    const { b, r } = twoPads(1000);
    const s = new EngineSession(b.snapshot(), { pins: [{ gpio: 5, component: r, terminal: 'a' }] });
    expect(s.setPinMode(5, 'input')).toBeNull();
    for (let k = 0; k < 3; k++) {
      const pin = ok(s.solve()).pins![0]!;
      expect(Math.abs(pin.voltage)).toBeLessThan(1e-9);
      expect(Math.abs(pin.current)).toBeLessThan(1e-15);
      expect(interpretDigitalInput(pin.voltage, 0)).toBe(0);
    }
    expect(G_INPUT_LEAKAGE_S).toBeCloseTo(50e-9 / 3.3, 20);
  });
});
