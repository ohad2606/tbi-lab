/**
 * Sprint 11 (R1) pad safety and live controls in the engine:
 * - the ESP32 pad voltage range (datasheet v5.3 Table 5-3: -0.3 V ... VDD + 0.3 V = 3.6 V) is
 *   checked as an electrical RISK warning on every trigger that changes the operating point: Run
 *   (the first solve), a firmware GPIO change, and a live parameter change;
 * - warnings are computed from an already solved outcome: they never alter or mutate it;
 * - the engine applies the domain's live-control rule (kinds and ranges) when a mirror applies;
 * - the time-dependent parts of a circuit are named (the Session Host's backstop uses them).
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_ORDER, liveParamKeys } from '@tbi-lab/domain';
import {
  EngineSession,
  R_DRIVE_HIGH_OHM,
  V_PIN_MAX_V,
  V_PIN_MIN_V,
  VDD_V,
  partModel,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench, boardBench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};
const codes = (full: ReturnType<typeof boardBench>['full'], out: SolveSuccess) =>
  ratingWarnings(full, out).map((w) => [w.code, w.gpio]);

describe('ESP32 pad voltage range: the datasheet values', () => {
  it('VDD + 0.3 V and -0.3 V (ESP32 Series Datasheet v5.3, Table 5-3)', () => {
    expect(V_PIN_MAX_V).toBeCloseTo(3.6, 12);
    expect(V_PIN_MIN_V).toBe(-0.3);
    expect(VDD_V).toBe(3.3);
  });
});

describe('pad over-voltage warnings, on every trigger', () => {
  it('Run (first solve): a 5 V supply through 1 kΩ into an input pad → gpio_input_overvoltage', () => {
    const bb = boardBench((b, u) => {
      const r = b.add('component.resistor');
      const pd = b.add('component.resistor');
      b.ohms(r, 1000).ohms(pd, 1e6).psu(5, 0.1);
      b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${u}.gpio35`);
      b.wire(`${r}.b`, `${pd}.a`).wire(`${pd}.b`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    const out = ok(s.solve());
    const pin = out.pins!.find((p) => p.gpio === 35)!;
    expect(pin.voltage).toBeGreaterThan(4.9);
    const w = ratingWarnings(bb.full, out);
    expect(w.map((x) => [x.code, x.gpio, x.limit])).toEqual([
      ['gpio_input_overvoltage', 35, V_PIN_MAX_V],
    ]);
    expect(w[0]!.value).toBe(pin.voltage);
  });

  it('a negative supply into an input pad → gpio_input_overvoltage at the -0.3 V limit', () => {
    const bb = boardBench((b, u) => {
      const p2 = b.add('instrument.lab_psu');
      const r = b.add('component.resistor');
      const pd = b.add('component.resistor');
      b.set(p2, 'setpointVoltage', { value: 5, unit: 'volt' })
        .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
        .set(p2, 'outputEnabled', true);
      b.ohms(r, 1000).ohms(pd, 1e6).psu(3.3, 0.1);
      b.wire(`${p2}.positive`, 'GND1.ref').wire(`${p2}.negative`, `${r}.a`);
      b.wire(`${r}.b`, `${u}.gpio34`).wire(`${r}.b`, `${pd}.a`).wire(`${pd}.b`, 'GND1.ref');
    });
    const out = ok(new EngineSession(bb.projected, { pins: bb.pins }).solve());
    expect(out.pins!.find((p) => p.gpio === 34)!.voltage).toBeLessThan(-4.9);
    expect(ratingWarnings(bb.full, out).map((x) => [x.code, x.gpio, x.limit])).toEqual([
      ['gpio_input_overvoltage', 34, V_PIN_MIN_V],
    ]);
  });

  it('firmware GPIO changes: a 5 V pull-up through 47 Ω on GPIO4 — input, HIGH, LOW', () => {
    const bb = boardBench((b, u) => {
      const r = b.add('component.resistor');
      b.ohms(r, 47).psu(5, 1);
      b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${u}.gpio4`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    // Input: the pad sits at 5 V.
    expect(codes(bb.full, ok(s.solve()))).toEqual([['gpio_input_overvoltage', 4]]);
    // Output HIGH: the 5 V rail pushes the pad above 3.6 V through its driver.
    s.setPinMode(4, 'output-high');
    const high = ok(s.solve());
    const vHigh = VDD_V + ((5 - VDD_V) * R_DRIVE_HIGH_OHM) / (R_DRIVE_HIGH_OHM + 47);
    expect(high.pins![0]!.voltage).toBeCloseTo(vHigh, 6);
    expect(high.pins![0]!.current).toBeLessThan(0); // current INTO the pad
    expect(codes(bb.full, high)).toEqual([['gpio_output_overvoltage', 4]]);
    // Output LOW: an over-current sink (the existing rule), the pad itself in range.
    s.setPinMode(4, 'output-low');
    // Sprint 19B (F2): the pull-up itself dissipates ≈ 5 V² / 47 Ω ≈ 0.5 W, above its ¼ W rating.
    expect(codes(bb.full, ok(s.solve()))).toEqual([
      ['power', undefined],
      ['gpio_sink_current', 4],
    ]);
  });

  it('live parameter changes: a photoresistor divider from 5 V into GPIO35 crosses 3.6 V with the light', () => {
    const bb = boardBench((b, u) => {
      const ldr = b.add('component.photoresistor');
      const r = b.add('component.resistor');
      b.ohms(r, 10_000).psu(5, 0.1).set(ldr, 'illuminance', { value: 1, unit: 'lux' });
      b.wire('PSU1.positive', `${ldr}.a`).wire(`${ldr}.b`, `${u}.gpio35`);
      b.wire(`${ldr}.b`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    const dark = ok(s.solve());
    expect(dark.pins![0]!.voltage).toBeLessThan(1);
    expect(codes(bb.full, dark)).toEqual([]);
    expect(s.applyControl('LDR1', { params: { illuminance: 1000 } }, 2)).toBeNull();
    const bright = ok(s.solve());
    expect(bright.pins![0]!.voltage).toBeGreaterThan(4);
    expect(codes(bb.full, bright)).toEqual([['gpio_input_overvoltage', 35]]);
    expect(s.applyControl('LDR1', { params: { illuminance: 1 } }, 3)).toBeNull();
    expect(codes(bb.full, ok(s.solve()))).toEqual([]);
  });

  it('a normal output driving an LED through 220 Ω: no pad warning', () => {
    const bb = boardBench((b, u) => {
      const r = b.add('component.resistor');
      const d = b.add('component.led');
      b.ohms(r, 220).psu(3.3, 0.1);
      b.wire(`${u}.gpio2`, `${r}.a`).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(2, 'output-high');
    expect(codes(bb.full, ok(s.solve()))).toEqual([]);
  });
});

describe('warnings never alter solver results', () => {
  it('the outcome is not mutated, and equals a solve that never ran the warning pass', () => {
    const build = (b: Bench, u: string) => {
      const r = b.add('component.resistor');
      b.ohms(r, 47).psu(5, 1);
      b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${u}.gpio4`);
    };
    const a = boardBench(build);
    const b = boardBench(build);
    const sa = new EngineSession(a.projected, { pins: a.pins });
    const sb = new EngineSession(b.projected, { pins: b.pins });
    sa.setPinMode(4, 'output-high');
    sb.setPinMode(4, 'output-high');
    const withWarnings = ok(sa.solve());
    const before = structuredClone(withWarnings);
    const w = ratingWarnings(a.full, withWarnings);
    expect(w.length).toBe(1);
    expect(withWarnings).toEqual(before); // not mutated
    expect(ok(sb.solve())).toEqual(before); // identical to a solve with no warning pass at all
  });
});

describe('live controls in the engine: the domain rule when a mirror applies', () => {
  function sensors() {
    const b = new Bench();
    const ldr = b.add('component.photoresistor');
    const r = b.add('component.resistor');
    const pir = b.add('sensor.pir_hc_sr501');
    const rp = b.add('component.resistor');
    b.ohms(r, 10_000).ohms(rp, 10_000).psu(5, 0.1);
    b.wire('PSU1.positive', `${ldr}.a`).wire(`${ldr}.b`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    b.wire('PSU1.positive', `${pir}.vcc`).wire(`${pir}.gnd`, 'GND1.ref');
    b.wire(`${pir}.out`, `${rp}.a`).wire(`${rp}.b`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref');
    return { s: new EngineSession(b.snapshot()), ldr, pir };
  }

  it('declared live parameters of the right kind and range apply', () => {
    const { s, ldr, pir } = sensors();
    expect(s.applyControl(ldr, { params: { illuminance: 250 } }, 2)).toBeNull();
    expect(s.applyControl(pir, { params: { motion: true } }, 3)).toBeNull();
    const out = ok(s.solve());
    expect(out.components[pir]!.state).toMatchObject({ powered: true, output: 'high' });
  });

  it('wrong kind or out of range → invalid_parameter (naming it); undeclared → unsupported_component', () => {
    const { s, ldr, pir } = sensors();
    expect(s.applyControl(ldr, { params: { illuminance: 0.5 } }, 2)).toMatchObject({
      code: 'invalid_parameter',
      param: 'illuminance',
    });
    expect(s.applyControl(ldr, { params: { illuminance: 1e5 } }, 2)).toMatchObject({
      code: 'invalid_parameter',
      param: 'illuminance',
    });
    expect(s.applyControl(pir, { params: { motion: 'yes' } }, 2)).toMatchObject({
      code: 'invalid_parameter',
      param: 'motion',
    });
    expect(s.applyControl(ldr, { params: { model: 'x' } }, 2)).toMatchObject({
      code: 'unsupported_component',
    });
  });

  it('every part model declares exactly the catalog live parameters (one rule, two places)', () => {
    for (const t of CATALOG_ORDER) {
      const m = partModel(t);
      if (m) expect([...(m.liveParams ?? [])].sort(), t).toEqual(liveParamKeys(t).sort());
    }
  });
});

describe('time-dependent parts are named (the Session Host backstop)', () => {
  it('a capacitor makes the circuit time-dependent; other parts do not', () => {
    const b = new Bench();
    const c = b.add('component.capacitor');
    const r = b.add('component.resistor');
    b.psu(5, 0.1).wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${c}.a`);
    b.wire(`${c}.b`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref');
    const s = new EngineSession(b.snapshot());
    expect(s.timeDependent).toBe(true);
    expect(s.timeDependentParts).toEqual([c]);
    const plain = new Bench();
    const r2 = plain.add('component.resistor');
    plain.psu(5, 0.1).wire('PSU1.positive', `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    plain.wire('PSU1.negative', 'GND1.ref');
    expect(new EngineSession(plain.snapshot()).timeDependentParts).toEqual([]);
  });
});
