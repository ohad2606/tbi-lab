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

/**
 * M2/M4 topology (the same class as the shipped logic-feedback example, read back on GPIO19 here
 * with the LED on the relay's COM side; app/tests/s30-examples.test.ts tests the shipped recipe): GPIO18 → U1 (1G08) A with a 100 kΩ pull-down; B from a
 * toggle switch to the 3.0 V logic rail with a 10 kΩ pull-down; U1.Y → GPIO19 (the firmware's
 * feedback) and → U2 (1G08 as a driver, its B at V_CC); U2.Y → 1 kΩ → 2N3904 → SRD-05 relay on a
 * separate 5 V supply (1N4148 across the coil); the relay's NO contact lights an LED (330 Ω).
 * U1.Y carries only U2's input leakage and GPIO19's 50 nA, so its light-load row (V_OH ≥ V_CC −
 * 0.1 V at −100 µA) holds: GPIO19 reads ≥ 2.9 V > V_IH 2.475 V. U2 sources the base current.
 */
export function feedbackBench(sw: boolean) {
  let ids = { u1: '', u2: '', k: '', led: '', q: '' };
  const bb = boardBench((b, u) => {
    b.psu(3.0, 0.05);
    const p5 = b.rail(5.0, 0.5);
    const u1 = b.add('logic.gate_and');
    const u2 = b.add('logic.gate_and');
    for (const g of [u1, u2]) b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
    const pa = b.add('component.resistor');
    b.ohms(pa, 100_000).wire(`${u}.gpio18`, `${u1}.a`).wire(`${u1}.a`, `${pa}.a`);
    b.wire(`${pa}.b`, 'GND1.ref');
    const s1 = b.add('component.toggle_switch');
    const pb = b.add('component.resistor');
    b.set(s1, 'closed', sw).wire('PSU1.positive', `${s1}.a`).wire(`${s1}.b`, `${u1}.b`);
    b.ohms(pb, 10_000).wire(`${u1}.b`, `${pb}.a`).wire(`${pb}.b`, 'GND1.ref');
    b.wire(`${u1}.y`, `${u}.gpio19`).wire(`${u1}.y`, `${u2}.a`).wire(`${u2}.b`, 'PSU1.positive');
    const rb = b.add('component.resistor');
    const q = b.add('component.bjt_npn');
    const k = b.add('component.relay');
    const d = b.add('component.diode');
    b.ohms(rb, 1000).wire(`${u2}.y`, `${rb}.a`).wire(`${rb}.b`, `${q}.base`);
    b.wire(`${q}.emitter`, 'GND1.ref');
    b.wire(`${p5}.positive`, `${k}.coil1`).wire(`${k}.coil2`, `${q}.collector`);
    b.wire(`${d}.cathode`, `${k}.coil1`).wire(`${d}.anode`, `${k}.coil2`);
    const rl = b.add('component.resistor');
    const led = b.add('component.led');
    b.wire(`${p5}.positive`, `${k}.com`).wire(`${k}.no`, `${rl}.a`);
    b.ohms(rl, 330).wire(`${rl}.b`, `${led}.anode`).wire(`${led}.cathode`, 'GND1.ref');
    ids = { u1, u2, k, led, q };
  });
  return { bb, ids };
}

describe('M2/M4: ESP32 → logic → ESP32 feedback, logic → transistor → relay → LED', () => {
  for (const sw of [false, true])
    it(`switch ${sw ? 'closed' : 'open'}: every GPIO18 mode — the relay and LED follow A·B, GPIO19 reads U1.Y`, () => {
      for (const mode of ['input', 'output-low', 'output-high'] as Mode[]) {
        const { bb, ids } = feedbackBench(sw);
        const s = new EngineSession(bb.projected, { pins: bb.pins });
        s.setPinMode(19, 'input');
        s.setPinMode(18, mode);
        const o = ok(s.solve());
        const y = mode === 'output-high' && sw;
        const at = `GPIO18 ${mode}, switch ${sw}`;
        expect(gateOut(o, ids.u1), at).toBe(y ? 'high' : 'low');
        expect(gateOut(o, ids.u2), at).toBe(y ? 'high' : 'low');
        if (y) expect(pad(o, 19), at).toBeGreaterThan(2.9 - 1e-9);
        else expect(pad(o, 19), at).toBeLessThan(0.1 + 1e-9);
        expect(o.components[ids.k]!.state, at).toMatchObject({ energized: y });
        if (y) expect(o.components[ids.led]!.current!, at).toBeGreaterThan(5e-3);
        else expect(Math.abs(o.components[ids.led]!.current!), at).toBeLessThan(1e-9);
      }
    });
});

describe('Sprint 30 review B1: the pad check is one-sided in both directions (no |I| kink at zero current)', () => {
  /** GPIO18 HIGH into A, which also has R to a separate 3.3 V supply (nominal pad current 0). */
  const sinking = (r: number) => {
    const bb = boardBench((b, u) => {
      const g = b.add('logic.gate_and');
      b.psu(3.0, 0.05).wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
      b.wire(`${g}.b`, 'PSU1.positive').wire(`${g}.a`, `${u}.gpio18`);
      const p2 = b.rail(3.3, 0.1);
      b.bleed(p2, 1000);
      const rr = b.add('component.resistor');
      b.ohms(rr, r).wire(`${p2}.positive`, `${rr}.a`).wire(`${rr}.b`, `${g}.a`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(18, 'output-high');
    return s.solve();
  };
  for (const r of [220, 470, 1000, 1500, 3300, 5000, 6000])
    it(`${r} Ω to 3.3 V: at V_OH min (2.64 V) the pad SINKS (3.3 − 2.64) / R + I_I > 100 µA → refused by name (was accepted: zero nominal current)`, () => {
      const o = sinking(r);
      expect(o.ok ? null : o.error).toMatchObject({
        code: 'logic_mcu_output_uncharacterized',
        param: 'gpio18',
        detail: { level: 'high', limit: 100e-6 },
      });
      expect((o.ok ? 0 : (o.error.detail as { value: number }).value) > 100e-6).toBe(true);
    });
  it('7 kΩ (0.66 V / 7 kΩ + 5 µA = 99.3 µA) and 10 kΩ (71 µA) to 3.3 V: within 100 µA either way → run', () => {
    expect(sinking(7000).ok).toBe(true);
    expect(sinking(10_000).ok).toBe(true);
  });
});
