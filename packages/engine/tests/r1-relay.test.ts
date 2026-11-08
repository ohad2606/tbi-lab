/**
 * Sprint 11 (R1), slice 4: the 2N3904 as a pad-driven switch, and the relay (SRD-05VDC-SL-C)
 * driven through it from 5 V; the relay contact and a transistor inverter read by input pads.
 * Coil 70 Ω; pull-in 3.75 V, drop-out 0.5 V (hysteresis, a discrete state kept across solves).
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
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

import { SRD_05VDC_SL_C } from '../src/parts/relay.js';

/** GPIO4 -> 1 kΩ -> Q1 base; Q1 emitter -> GND; 5 V -> K1 coil1; K1 coil2 -> Q1 collector. */
function relayDriver(
  extra?: (b: Parameters<Parameters<typeof boardBench>[0]>[0], u: string) => void,
) {
  return boardBench((b, u) => {
    const k = b.add('component.relay');
    const q = b.add('component.bjt_npn');
    const rb = b.add('component.resistor');
    b.psu(5, 0.5).ohms(rb, 1000);
    b.wire(`${u}.gpio4`, `${rb}.a`).wire(`${rb}.b`, `${q}.base`).wire(`${q}.emitter`, 'GND1.ref');
    b.wire('PSU1.positive', `${k}.coil1`).wire(`${k}.coil2`, `${q}.collector`);
    // The contact side is its own circuit; COM must be wired (catalog: only NO/NC are optional).
    if (!extra) b.wire(`${k}.com`, 'GND1.ref');
    extra?.(b, u);
  });
}

describe('2N3904 and relay on ESP32 pads (slice 4)', () => {
  it('pad HIGH: Q1 saturates, the coil sees ≈4.8 V and pulls in; LOW: cutoff, released; state persists across events', () => {
    const bb = relayDriver();
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'output-high');
    const on = ok(s.solve());
    expect(on.components.Q1!.state).toMatchObject({ region: 'saturation' });
    const coil = on.components.K1!.currents!.coil!;
    expect(coil * SRD_05VDC_SL_C.coilOhm).toBeGreaterThan(4.7);
    expect(on.components.K1!.state).toMatchObject({ energized: true });
    expect(ratingWarnings(bb.full, on)).toEqual([]);
    // The armature stays pulled in while driven (no chatter across repeated solves).
    for (let k = 0; k < 3; k++)
      expect(ok(s.solve()).components.K1!.state).toMatchObject({ energized: true });
    s.setPinMode(4, 'output-low');
    const off = ok(s.solve());
    expect(off.components.Q1!.state).toMatchObject({ region: 'cutoff' });
    expect(off.components.K1!.state).toMatchObject({ energized: false });
    // A high-impedance pad (input) leaves the base floating at its leakage: released, not random.
    s.setPinMode(4, 'input');
    expect(ok(s.solve()).components.K1!.state).toMatchObject({ energized: false });
  });

  it('the coil straight on a pad: 3.3 V behind 16.5 Ω into 70 Ω gives ≈2.67 V — below pull-in, so it stays at rest', () => {
    const bb = boardBench((b, u) => {
      const k = b.add('component.relay');
      b.psu(3.3, 0.1).wire(`${u}.gpio4`, `${k}.coil1`).wire(`${k}.coil2`, 'GND1.ref');
      b.wire(`${k}.com`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'output-high');
    const out = ok(s.solve());
    const i = out.components.K1!.currents!.coil!;
    expect(i).toBeCloseTo(3.3 / (16.5 + 70), 6);
    expect(i * 70).toBeLessThan(SRD_05VDC_SL_C.pullInV);
    expect(out.components.K1!.state).toMatchObject({ energized: false });
    expect(ratingWarnings(bb.full, out)).toEqual([]); // 38 mA: under the 40 mA drive rating
  });

  it('the NO contact into GPIO35 with a 10 kΩ pull-up to 3.3 V reads the relay; a 5 V pull-up is flagged', () => {
    for (const pullUp of [3.3, 5]) {
      const bb = relayDriver((b, u) => {
        const p2 = b.add('instrument.lab_psu');
        const rp = b.add('component.resistor');
        b.set(p2, 'setpointVoltage', { value: pullUp, unit: 'volt' })
          .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
          .set(p2, 'outputEnabled', true)
          .ohms(rp, 10_000);
        b.wire(`${p2}.negative`, 'GND1.ref').wire(`${p2}.positive`, `${rp}.a`);
        b.wire(`${rp}.b`, `${u}.gpio35`).wire(`${rp}.b`, 'K1.no').wire('K1.com', 'GND1.ref');
      });
      const s = new EngineSession(bb.projected, { pins: bb.pins });
      const pin35 = (o: SolveSuccess) => o.pins!.find((p) => p.gpio === 35)!.voltage;
      s.setPinMode(4, 'output-low');
      const open = ok(s.solve());
      expect(interpretDigitalInput(pin35(open), 0), `${pullUp} V open`).toBe(1);
      const warned = ratingWarnings(bb.full, open).map((w) => w.code);
      if (pullUp === 5) expect(warned).toContain('gpio_input_overvoltage');
      else expect(warned).toEqual([]);
      s.setPinMode(4, 'output-high');
      const closed = ok(s.solve());
      expect(interpretDigitalInput(pin35(closed), 1), `${pullUp} V closed`).toBe(0);
    }
  });

  it('a transistor inverter into GPIO35 (3.3 V pull-up on the collector): pad HIGH -> input LOW', () => {
    const bb = boardBench((b, u) => {
      const q = b.add('component.bjt_npn');
      const rb = b.add('component.resistor');
      const rc = b.add('component.resistor');
      b.psu(3.3, 0.1).ohms(rb, 4700).ohms(rc, 10_000);
      b.wire(`${u}.gpio4`, `${rb}.a`).wire(`${rb}.b`, `${q}.base`).wire(`${q}.emitter`, 'GND1.ref');
      b.wire('PSU1.positive', `${rc}.a`)
        .wire(`${rc}.b`, `${q}.collector`)
        .wire(`${q}.collector`, `${u}.gpio35`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'output-high');
    const v = (o: SolveSuccess) => o.pins!.find((p) => p.gpio === 35)!.voltage;
    expect(interpretDigitalInput(v(ok(s.solve())), 1)).toBe(0);
    s.setPinMode(4, 'output-low');
    expect(interpretDigitalInput(v(ok(s.solve())), 0)).toBe(1);
  });

  it('a self-interrupting coil (through its own NC contact) has no steady state: an explicit error, never a value', () => {
    const bb = boardBench((b, u) => {
      const k = b.add('component.relay');
      const q = b.add('component.bjt_npn');
      const rb = b.add('component.resistor');
      b.psu(5, 0.5).ohms(rb, 1000);
      b.wire(`${u}.gpio4`, `${rb}.a`).wire(`${rb}.b`, `${q}.base`).wire(`${q}.emitter`, 'GND1.ref');
      b.wire('PSU1.positive', `${k}.com`)
        .wire(`${k}.nc`, `${k}.coil1`)
        .wire(`${k}.coil2`, `${q}.collector`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'output-high');
    const out = s.solve();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatchObject({ code: 'no_steady_state', components: ['K1'] });
  });
});
