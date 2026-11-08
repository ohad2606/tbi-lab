/**
 * Sprint 11 (R1), slice 3: the PIR sensor (HC-SR501) feeding an ESP32 input pad. Its output is a
 * 3.3 V regulated source behind R14 = 1 kΩ when powered (VCC >= 4.5 V) and seeing motion; the pad
 * is its datasheet leakage (66 MΩ). Reference: the closed-form divider of those two.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  G_INPUT_LEAKAGE_S,
  V_IH_V,
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

function pirOnPad(vcc: number) {
  return boardBench((b, u) => {
    const pir = b.add('sensor.pir_hc_sr501');
    b.psu(vcc, 0.1).wire('PSU1.positive', `${pir}.vcc`).wire(`${pir}.gnd`, 'GND1.ref');
    b.wire(`${pir}.out`, `${u}.gpio34`);
  });
}

describe('PIR into GPIO34 (slice 3)', () => {
  it('powered from 5 V: motion -> 3.3 V behind 1 kΩ -> HIGH; no motion -> 0 V -> LOW; motion is a live control', () => {
    const bb = pirOnPad(5);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    const idle = ok(s.solve());
    expect(idle.pins![0]!.voltage).toBeCloseTo(0, 12);
    expect(interpretDigitalInput(idle.pins![0]!.voltage, 1)).toBe(0);
    expect(s.applyControl('U2', { params: { motion: true } }, 2)).toBeNull();
    const seen = ok(s.solve());
    const v = seen.pins![0]!.voltage;
    expect(v).toBeCloseTo((3.3 * R_LEAK) / (R_LEAK + 1000), 9);
    expect(v).toBeGreaterThanOrEqual(V_IH_V);
    expect(interpretDigitalInput(v, 0)).toBe(1);
    expect(seen.components.U2!.state).toEqual({ powered: true, output: 'high' });
    expect(ratingWarnings(bb.full, seen)).toEqual([]); // 3.3 V: within the pad's range
    expect(s.applyControl('U2', { params: { motion: false } }, 3)).toBeNull();
    expect(interpretDigitalInput(ok(s.solve()).pins![0]!.voltage, 1)).toBe(0);
  });

  it('under-powered (VCC 3.3 V < 4.5 V): the sensor is off and the pad reads LOW even with motion', () => {
    const bb = pirOnPad(3.3);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.applyControl('U2', { params: { motion: true } }, 2);
    const out = ok(s.solve());
    expect(out.components.U2!.state).toEqual({ powered: false, output: 'low' });
    expect(interpretDigitalInput(out.pins![0]!.voltage, 1)).toBe(0);
  });
});
