/**
 * Sprint 12 (R2): the DC electrical models of the HC-SR04 and DHT22 behind an ESP32 pad, solved
 * for each output state the runtime host sets (EngineSession.setPartRuntime). References are the
 * closed-form dividers of the documented elements; the pad is its datasheet leakage (66 MΩ).
 */
import { describe, expect, it } from 'vitest';
import {
  DHT22_DC,
  EngineSession,
  G_INPUT_LEAKAGE_S,
  HC_SR04_DC,
  V_IH_V,
  V_IL_V,
  hcsr04TrigLevel,
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
const par = (a: number, b: number) => (a * b) / (a + b);
const padV = (o: SolveSuccess, gpio: number) => o.pins!.find((p) => p.gpio === gpio)!.voltage;

/** PSU -> VCC; TRIG <- GPIO5; ECHO -> 1 kΩ -> GPIO18 -> 2 kΩ -> GND (the curated wiring). */
function ultrasonic(vcc: number, divider = true) {
  return boardBench((b, u) => {
    const s = b.add('sensor.hc_sr04');
    b.psu(vcc, 0.2).wire('PSU1.positive', `${s}.vcc`).wire(`${s}.gnd`, 'GND1.ref');
    b.wire(`${s}.trig`, `${u}.gpio5`);
    if (divider) {
      const r1 = b.add('component.resistor');
      const r2 = b.add('component.resistor');
      b.ohms(r1, 1000).ohms(r2, 2000);
      b.wire(`${s}.echo`, `${r1}.a`).wire(`${r1}.b`, `${u}.gpio18`);
      b.wire(`${r1}.b`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    } else b.wire(`${s}.echo`, `${u}.gpio18`);
  });
}

describe('HC-SR04 (sensor.hc_sr04) DC model', () => {
  it('5 V, divider: ECHO low reads LOW, ECHO high reads HIGH within the pad range', () => {
    const bb = ultrasonic(5);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(5, 'output-low');
    const low = ok(s.solve());
    expect(low.components.U2!.state).toEqual({ powered: true, output: 'low' });
    expect(padV(low, 18)).toBeCloseTo(0, 12);
    expect(s.setPartRuntime('U2', 'echo', 'high')).toBeNull();
    const high = ok(s.solve());
    // 5 V behind R_out + 1 kΩ, into 2 kΩ || leakage.
    const lower = par(2000, R_LEAK);
    const want = (5 * lower) / (HC_SR04_DC.outputOhm + 1000 + lower);
    expect(padV(high, 18)).toBeCloseTo(want, 9);
    expect(interpretDigitalInput(padV(high, 18), 0)).toBe(1);
    expect(high.components.U2!.state).toEqual({ powered: true, output: 'high' });
    expect(high.components.U2!.currents!.supply).toBeCloseTo(
      HC_SR04_DC.workingA + 5 / (HC_SR04_DC.outputOhm + 1000 + lower),
      9,
    );
    expect(ratingWarnings(bb.full, high)).toEqual([]);
  });

  it('A-R2-6: the level read is insensitive to the assumed output impedance (10 Ω - 1 kΩ)', () => {
    for (const rOut of [10, 50, 100, 300, 1000]) {
      const v = (5 * 2000) / (rOut + 3000);
      expect(interpretDigitalInput(v, 0), `${rOut} Ω`).toBe(1);
    }
  });

  it('ECHO straight into the pad: 5 V exceeds the pad maximum and is reported', () => {
    const bb = ultrasonic(5, false);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPartRuntime('U2', 'echo', 'high');
    const out = ok(s.solve());
    expect(padV(out, 18)).toBeGreaterThan(4.9);
    expect(ratingWarnings(bb.full, out).some((w) => w.gpio === 18)).toBe(true);
  });

  it('under-powered (3.3 V < 4.5 V): off, ECHO not driven, pad LOW even when asked high', () => {
    const bb = ultrasonic(3.3);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPartRuntime('U2', 'echo', 'high');
    const out = ok(s.solve());
    expect(out.components.U2!.state).toEqual({ powered: false, output: 'off' });
    expect(interpretDigitalInput(padV(out, 18), 1)).toBe(0);
    expect(out.components.U2!.currents!.supply).toBe(0);
  });

  it('TRIG uses TTL thresholds: a 3.3 V ESP32 output triggers', () => {
    expect(hcsr04TrigLevel(3.3, 0)).toBe(1);
    expect(hcsr04TrigLevel(0, 1)).toBe(0);
    expect(hcsr04TrigLevel(1.4, 1)).toBe(1); // inside the band: held
    expect(hcsr04TrigLevel(1.4, 0)).toBe(0);
    expect(hcsr04TrigLevel(null, 1)).toBe(0);
    const bb = ultrasonic(5);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(5, 'output-high');
    const t = ok(s.solve()).components.U2!.terminals.trig!;
    expect(hcsr04TrigLevel(t, 0)).toBe(1);
  });

  it('refuses runtime inputs it does not declare', () => {
    const bb = ultrasonic(5);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    expect(s.setPartRuntime('U2', 'echo', 'tristate')).not.toBeNull();
    expect(s.setPartRuntime('U2', 'data', 'low')).not.toBeNull();
    expect(s.setPartRuntime('R1', 'echo', 'high')).not.toBeNull();
  });

  it('over-voltage supply (6 V > 5.5 V) is a rating warning', () => {
    const bb = ultrasonic(6);
    const out = ok(new EngineSession(bb.projected, { pins: bb.pins }).solve());
    expect(ratingWarnings(bb.full, out).some((w) => w.component === 'U2')).toBe(true);
  });
});

/** PSU -> VDD; DATA <-> GPIO4 with an optional pull-up to the PSU. */
function dht(vdd: number, pullUp: number | null) {
  return boardBench((b, u) => {
    const s = b.add('sensor.dht22');
    b.psu(vdd, 0.1).wire('PSU1.positive', `${s}.vdd`).wire(`${s}.gnd`, 'GND1.ref');
    b.wire(`${s}.data`, `${u}.gpio4`);
    if (pullUp !== null) {
      const r = b.add('component.resistor');
      b.ohms(r, pullUp).wire(`${r}.a`, 'PSU1.positive').wire(`${r}.b`, `${s}.data`);
    }
  });
}

describe('DHT22 (sensor.dht22) DC model', () => {
  it('3.3 V with a 10 kΩ pull-up: released reads HIGH, low reads LOW', () => {
    const bb = dht(3.3, 10_000);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    const rel = ok(s.solve());
    expect(rel.components.U2!.state).toEqual({ powered: true, output: 'released' });
    expect(padV(rel, 4)).toBeCloseTo((3.3 * R_LEAK) / (R_LEAK + 10_000), 9);
    expect(interpretDigitalInput(padV(rel, 4), 0)).toBe(1);
    expect(s.setPartRuntime('U2', 'data', 'low')).toBeNull();
    const low = ok(s.solve());
    const lower = par(DHT22_DC.outputLowOhm, R_LEAK);
    expect(padV(low, 4)).toBeCloseTo((3.3 * lower) / (lower + 10_000), 9);
    expect(interpretDigitalInput(padV(low, 4), 1)).toBe(0);
    expect(low.components.U2!.currents!.supply).toBe(DHT22_DC.standbyA);
  });

  it('A-R2-7: with the datasheet 1 kΩ pull-up the low level stays below V_IL', () => {
    const bb = dht(5, 1000);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPartRuntime('U2', 'data', 'low');
    const v = padV(ok(s.solve()), 4);
    expect(v).toBeLessThan(V_IL_V);
    // 5 V released through 1 kΩ is 5 V at the pad: over the pad maximum, reported.
    s.setPartRuntime('U2', 'data', 'released');
    const rel = ok(s.solve());
    expect(padV(rel, 4)).toBeGreaterThan(V_IH_V);
    expect(ratingWarnings(bb.full, rel).some((w) => w.gpio === 4)).toBe(true);
  });

  it('no pull-up: the released line is not high (no internal pull-up exists)', () => {
    const bb = dht(3.3, null);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    expect(interpretDigitalInput(padV(ok(s.solve()), 4), 1)).toBe(0);
  });

  it('under-powered (3.0 V < 3.3 V): off, never drives DATA', () => {
    const bb = dht(3.0, 10_000);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPartRuntime('U2', 'data', 'low');
    const out = ok(s.solve());
    expect(out.components.U2!.state).toEqual({ powered: false, output: 'off' });
    expect(interpretDigitalInput(padV(out, 4), 0)).toBe(1); // only the pull-up acts
  });
});
