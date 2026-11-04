/**
 * Sprint 30 M1: an ESP32 output driving a logic input (owner decisions S30-L1, S30-A4).
 *
 * - S30-L1: the pad's Table 5-3 band (V_OH ≥ 0.8 × VDD, V_OL ≤ 0.1 × VDD) is relied on up to
 *   100 µA of pad current; above it the session is refused by name (logic_mcu_output_uncharacterized).
 * - S30-A4: for a 1G part whose I_CC is tested at 5.5 V, an input between V_CC and 5.5 V is in the
 *   bounded 'high' zone (the ESP32 HIGH up to 3.3 V into a gate at 3.0 V); the 1G86 ("V_CC or GND")
 *   keeps S29-D3.
 * The boot state (pad an input) needs the pull-down: with I_I ±5 µA + 50 nA it holds the input
 * within 0.6 V of GND only up to ≈ 119 kΩ; driven HIGH the pad sources 3.3 V / R, ≤ 100 µA only
 * from 33 kΩ. So 47 kΩ and 100 kΩ work; 22 kΩ and 200 kΩ are refused, each by name.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentTypeId } from '@tbi-lab/domain';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';
import { boardBench } from './build.js';

const err = (o: SolveOutcome) => (o.ok ? null : o.error);
const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
};

type Mode = 'input' | 'output-high' | 'output-low';

/** GPIO18 → AND input A (pull-down R), B at the gate's V_CC, Y → GPIO19 (an input). */
function drive(r: number, vcc = 3.0, gate: ComponentTypeId = 'logic.gate_and') {
  let g = '';
  const bb = boardBench((b, u) => {
    g = b.add(gate);
    const rp = b.add('component.resistor');
    b.psu(vcc, 0.05).wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
    b.wire(`${g}.a`, `${u}.gpio18`).wire(`${g}.b`, 'PSU1.positive');
    b.ohms(rp, r).wire(`${g}.a`, `${rp}.a`).wire(`${rp}.b`, 'GND1.ref');
    b.wire(`${g}.y`, `${u}.gpio19`);
  });
  const at = (mode: Mode) => {
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(19, 'input');
    s.setPinMode(18, mode);
    return s.solve();
  };
  return { at, g: () => g };
}

const gateOut = (o: SolveSuccess, g: string) => o.components[g]!.logic!.gates[0]!.output.level;
const pad = (o: SolveSuccess, gpio: number) => o.pins!.find((p) => p.gpio === gpio)!.voltage;

describe('S30-L1 + A4: ESP32 GPIO18 drives a 1G08 at 3.0 V; the gate output is read on GPIO19', () => {
  for (const r of [47_000, 100_000])
    it(`${r / 1000} kΩ pull-down: boot LOW, HIGH and LOW driven — each guaranteed, GPIO19 reads the gate`, () => {
      const c = drive(r);
      const boot = ok(c.at('input'));
      expect(gateOut(boot, c.g())).toBe('low');
      const hi = ok(c.at('output-high'));
      expect(gateOut(hi, c.g())).toBe('high');
      // The gate's guaranteed V_OH (≥ V_CC − 0.1 V at 100 µA) clears the ESP32 V_IH 2.475 V.
      expect(pad(hi, 19)).toBeGreaterThan(2.475);
      // The pad sources the pull-down: 3.3 V / R at most, within the 100 µA envelope.
      const lo = ok(c.at('output-low'));
      expect(gateOut(lo, c.g())).toBe('low');
      expect(pad(lo, 19)).toBeLessThan(0.825);
    });

  it('22 kΩ: HIGH would source up to 3.3 V / 22 kΩ = 150 µA > 100 µA → refused by name (S30-L1)', () => {
    const c = drive(22_000);
    expect(err(c.at('output-high'))).toMatchObject({
      code: 'logic_mcu_output_uncharacterized',
      param: 'gpio18',
      detail: { level: 'high', limit: 100e-6 },
    });
    // ≈ 3.3 V / 22 kΩ at the failing corner (the gate's I_I shifts it by at most 5 µA).
    const v = (err(c.at('output-high'))!.detail as { value: number }).value;
    expect(v).toBeGreaterThan(144e-6);
    expect(v).toBeLessThan(156e-6);
  });

  it('200 kΩ: at boot the input leakage (5.05 µA) lifts A to ≈ 1 V, outside 0.6 V of GND → refused (not characterized)', () => {
    expect(err(drive(200_000).at('input'))).toMatchObject({
      code: expect.stringMatching(/^logic_/),
    });
  });

  it('gate at 3.3 V: the ESP32 HIGH band starts at 2.64 V, 60 mV below V_CC − 0.6 V → still refused (no new assumption covers it)', () => {
    expect(err(drive(100_000, 3.3).at('output-high'))).not.toBeNull();
  });

  it('S29-D3 kept for the 1G86 (I_CC at "V_CC or GND"): the ESP32 HIGH up to 3.3 V into the XOR at 3.0 V is refused', () => {
    expect(err(drive(100_000, 3.0, 'logic.gate_xor').at('output-high'))).not.toBeNull();
  });
});
