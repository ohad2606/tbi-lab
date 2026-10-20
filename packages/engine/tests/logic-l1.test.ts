/**
 * Sprint 19B, Exploration Foundation L1: single logic gates (TI SN74LVC1G08 / 00 / 32 / 04) as
 * electrical parts with real supply pins. Every expected number is computed by hand from the
 * device card (logic/lvc1g.ts, SCES217AA et al.), not read back from the engine.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  gateOutput,
  inputRowAt,
  interpretDigitalInput,
  LVC1G_CARDS,
  outputStageAt,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench, boardBench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code} ${JSON.stringify(o.error)}`);
  return o;
};
const fails = (o: SolveOutcome) => {
  if (o.ok) throw new Error('expected a refusal');
  return o.error;
};
const AND = LVC1G_CARDS['model.logic.sn74lvc1g08']!;

describe('device cards (datasheet figures, EF-D3 A / EF-D4 A)', () => {
  it('input rows: ranged where the sheet states a range, proportional only where it states one; gaps refused', () => {
    expect(inputRowAt(AND, 3.0)).toEqual({ vih: 2.0, vil: 0.8 });
    expect(inputRowAt(AND, 3.3)).toEqual({ vih: 2.0, vil: 0.8 });
    expect(inputRowAt(AND, 3.6)).toEqual({ vih: 2.0, vil: 0.8 });
    const r5 = inputRowAt(AND, 5.0)!;
    expect(r5.vih).toBeCloseTo(3.5, 12);
    expect(r5.vil).toBeCloseTo(1.5, 12);
    expect(inputRowAt(AND, 1.8)!.vih).toBeCloseTo(0.65 * 1.8, 12);
    expect(inputRowAt(AND, 2.5)).toEqual({ vih: 1.7, vil: 0.7 });
    // Between rows: no figure (refused by the part).
    for (const v of [2.0, 2.8, 2.99, 3.61, 4.0, 4.49]) expect(inputRowAt(AND, v)).toBeUndefined();
  });

  it('the guaranteed output stage meets EVERY guaranteed point of its row, the highest exactly', () => {
    for (const card of Object.values(LVC1G_CARDS))
      for (const row of card.outputRows) {
        const st = outputStageAt(card, row.vcc);
        expect(st.tabulated).toBe(true);
        for (const p of row.high)
          expect(row.vcc - p.amps * st.rHigh).toBeGreaterThanOrEqual(p.volts - 1e-12);
        for (const p of row.low) expect(p.amps * st.rLow).toBeLessThanOrEqual(p.volts + 1e-12);
        const hi = row.high.reduce((a, b) => (b.amps > a.amps ? b : a));
        expect(row.vcc - hi.amps * st.rHigh).toBeCloseTo(hi.volts, 12);
        // And the ranged ±100 µA row (V_CC − 0.1 V, 0.1 V) at that supply.
        expect(row.vcc - 100e-6 * st.rHigh).toBeGreaterThanOrEqual(row.vcc - 0.1);
        expect(100e-6 * st.rLow).toBeLessThanOrEqual(0.1);
      }
    // V_CC = 3 V: (3 − 2.3) / 24 mA and 0.55 / 24 mA.
    const s3 = outputStageAt(AND, 3.0);
    expect(s3.rHigh).toBeCloseTo(0.7 / 0.024, 12);
    expect(s3.rLow).toBeCloseTo(0.55 / 0.024, 12);
    expect(s3.validA).toBe(0.024);
    // 3.3 V is not a tabulated output point: only the ranged row, 0.1 V / 100 µA.
    const s33 = outputStageAt(AND, 3.3);
    expect(s33).toMatchObject({ tabulated: false, validA: 100e-6 });
    expect(s33.rHigh).toBeCloseTo(1000, 9);
  });

  it('static CMOS evaluation: a controlling input decides; otherwise X', () => {
    expect(gateOutput(AND, ['low', 'x'])).toBe('low');
    expect(gateOutput(AND, ['high', 'x'])).toBe('x');
    const or = LVC1G_CARDS['model.logic.sn74lvc1g32']!;
    expect(gateOutput(or, ['high', 'x'])).toBe('high');
    expect(gateOutput(or, ['low', 'x'])).toBe('x');
    const nand = LVC1G_CARDS['model.logic.sn74lvc1g00']!;
    expect(gateOutput(nand, ['low', 'x'])).toBe('high');
    expect(gateOutput(LVC1G_CARDS['model.logic.sn74lvc1g04']!, ['x'])).toBe('x');
  });
});

/**
 * PSU1 at `vcc` powers U (a gate) from its own pins; inputs tied to V_CC or GND (or `ins` as
 * built by the caller); the output drives `load` Ω to GND when given.
 */
function gate(
  type: 'logic.gate_and' | 'logic.gate_nand' | 'logic.gate_or' | 'logic.gate_not',
  vcc: number,
  ins: ('h' | 'l' | 'open')[],
  build?: (b: Bench, g: string) => void,
) {
  const b = new Bench();
  const g = b.add(type);
  b.psu(vcc, 0.5)
    .wire('PSU1.negative', 'GND1.ref')
    .wire('PSU1.positive', `${g}.vcc`)
    .wire(`${g}.gnd`, 'GND1.ref');
  ['a', 'b'].slice(0, ins.length).forEach((t, i) => {
    if (ins[i] === 'h') b.wire(`${g}.${t}`, 'PSU1.positive');
    if (ins[i] === 'l') b.wire(`${g}.${t}`, 'GND1.ref');
  });
  build?.(b, g);
  return { b, g };
}
const solve = (b: Bench) => new EngineSession(b.snapshot()).solve();
const load = (ohms: number) => (b: Bench, g: string) => {
  const r = b.add('component.resistor');
  b.ohms(r, ohms).wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
};

describe('SN74LVC1G gates in the solve', () => {
  it('truth tables at V_CC = 3.0 V into 10 kΩ: HIGH = 3 V·10k/(10k + R_OH), LOW = 0 V', () => {
    const rh = 0.7 / 0.024;
    const high = (3.0 * 10_000) / (10_000 + rh);
    const tables = {
      'logic.gate_and': [0, 0, 0, 1],
      'logic.gate_nand': [1, 1, 1, 0],
      'logic.gate_or': [0, 1, 1, 1],
    } as const;
    for (const [type, outs] of Object.entries(tables))
      for (let m = 0; m < 4; m++) {
        const ins: ('h' | 'l')[] = [m & 2 ? 'h' : 'l', m & 1 ? 'h' : 'l'];
        const { b, g } = gate(type as keyof typeof tables, 3.0, ins, load(10_000));
        const r = ok(solve(b)).components[g]!;
        expect(r.state!.gateOutput, `${type} ${ins}`).toBe(outs[m] ? 'high' : 'low');
        expect(r.terminals.y!).toBeCloseTo(outs[m] ? high : 0, 9);
      }
    for (const [i, o] of [
      ['h', 'low'],
      ['l', 'high'],
    ] as const) {
      const { b, g } = gate('logic.gate_not', 3.0, [i], load(10_000));
      expect(ok(solve(b)).components[g]!.state!.gateOutput).toBe(o);
    }
  });

  it('output current flows through the supply pins: an LED load, the PSU current equals it', () => {
    const { b, g } = gate('logic.gate_and', 3.0, ['h', 'h'], (bb, gg) => {
      const r = bb.add('component.resistor');
      const d = bb.add('component.led');
      bb.ohms(r, 220)
        .wire(`${gg}.y`, `${r}.a`)
        .wire(`${r}.b`, `${d}.anode`)
        .wire(`${d}.cathode`, 'GND1.ref');
    });
    const o = ok(solve(b));
    const u = o.components[g]!;
    const led = o.components.D1!.current!;
    expect(led).toBeGreaterThan(1e-3);
    expect(u.currents!.y).toBeCloseTo(led, 12);
    expect(u.currents!.vcc).toBeCloseTo(led, 12);
    expect(o.components.PSU1!.current!).toBeCloseTo(led, 12);
    // V_Y = 3 − I·R_OH exactly.
    expect(u.terminals.y!).toBeCloseTo(3.0 - led * (0.7 / 0.024), 9);
    expect(ratingWarnings(b.snapshot(), o)).toEqual([]);
    expect(u.outsideModelRange).toBeUndefined();
  });

  it('fan-out: gate inputs draw no current, so 4 more inputs on Y change nothing; overload is rated', () => {
    const one = gate('logic.gate_and', 3.0, ['h', 'h'], load(1000));
    const base = ok(solve(one.b)).components[one.g]!.terminals.y!;
    const many = gate('logic.gate_and', 3.0, ['h', 'h'], (bb, gg) => {
      load(1000)(bb, gg);
      for (let k = 0; k < 4; k++) {
        const n = bb.add('logic.gate_and');
        bb.wire(`${n}.vcc`, 'PSU1.positive').wire(`${n}.gnd`, 'GND1.ref');
        bb.wire(`${gg}.y`, `${n}.a`).wire(`${n}.b`, 'PSU1.positive');
      }
    });
    const o = ok(solve(many.b));
    expect(o.components[many.g]!.terminals.y!).toBeCloseTo(base, 12);
    // 47 Ω: I = 3 / (47 + 29.17) ≈ 39 mA > 24 mA recommended (operating), < 50 mA (absolute).
    const heavy = gate('logic.gate_and', 3.0, ['h', 'h'], load(47));
    const h = ok(solve(heavy.b));
    expect(h.components[heavy.g]!.outsideModelRange).toBe(true);
    const w = ratingWarnings(heavy.b.snapshot(), h).filter((x) => x.component === heavy.g);
    expect(w.map((x) => [x.code, x.kind ?? 'absolute'])).toEqual([['current', 'operating']]);
    // 10 Ω: ≈ 77 mA > 50 mA output absolute maximum.
    const short = gate('logic.gate_and', 3.0, ['h', 'h'], load(10));
    const sw = ratingWarnings(short.b.snapshot(), ok(solve(short.b))).filter(
      (x) => x.component === short.g,
    );
    expect(sw.map((x) => x.kind ?? 'absolute')).toContain('absolute');
  });

  it('V_CC = 3.3 V (no tabulated output points): light loads by the ±100 µA row; an LED load is refused', () => {
    const light = gate('logic.gate_and', 3.3, ['h', 'h'], load(1_000_000));
    const y = ok(solve(light.b)).components[light.g]!;
    expect(y.state).toMatchObject({ gateOutput: 'high', outputModel: 'ranged' });
    expect(y.terminals.y!).toBeCloseTo((3.3 * 1e6) / (1e6 + 1000), 9);
    expect(y.terminals.y!).toBeGreaterThanOrEqual(3.3 - 0.1);
    const led = gate('logic.gate_and', 3.3, ['h', 'h'], load(220));
    expect(fails(solve(led.b))).toMatchObject({
      code: 'logic_output_uncharacterized',
      components: [led.g],
    });
  });

  it('supplies outside every datasheet row are refused; V_CC = 0 is unpowered (outputs off)', () => {
    for (const v of [2.0, 2.8, 4.0, 6.0, 1.2])
      expect(
        fails(solve(gate('logic.gate_and', v, ['h', 'h'], load(10_000)).b)).code,
        `${v} V`,
      ).toBe('logic_supply_uncharacterized');
    const off = gate('logic.gate_and', 0, ['l', 'l'], load(10_000));
    expect(ok(solve(off.b)).components[off.g]!.state).toMatchObject({ gateOutput: 'off' });
    // 5.0 V: in the proportional row; output stage only from the ranged row (4.5 V is the point).
    const five = gate('logic.gate_and', 5.0, ['h', 'h'], load(1_000_000));
    expect(ok(solve(five.b)).components[five.g]!.state).toMatchObject({ gateOutput: 'high' });
  });

  it('a floating input is refused, naming the pin (never assumed LOW or HIGH)', () => {
    const { b, g } = gate('logic.gate_and', 3.0, ['h', 'open'], load(10_000));
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_floating',
      components: [g],
      param: 'b',
    });
  });

  it('an input in the undefined band is X; X propagates; results it reaches are unknown, not numbers', () => {
    // A: divider 3.0 V -> 10k -> A -> 10k -> GND = 1.5 V, between V_IL 0.8 and V_IH 2.0.
    const { b, g } = gate('logic.gate_and', 3.0, ['open', 'h'], (bb, gg) => {
      const r1 = bb.add('component.resistor');
      const r2 = bb.add('component.resistor');
      bb.ohms(r1, 10_000).ohms(r2, 10_000);
      bb.wire('PSU1.positive', `${r1}.a`)
        .wire(`${r1}.b`, `${gg}.a`)
        .wire(`${gg}.a`, `${r2}.a`)
        .wire(`${r2}.b`, 'GND1.ref');
      // Y -> a second gate (NOT) -> 220 Ω + LED.
      const n = bb.add('logic.gate_not');
      bb.wire(`${n}.vcc`, 'PSU1.positive').wire(`${n}.gnd`, 'GND1.ref').wire(`${gg}.y`, `${n}.a`);
      const r = bb.add('component.resistor');
      const d = bb.add('component.led');
      bb.ohms(r, 220)
        .wire(`${n}.y`, `${r}.a`)
        .wire(`${r}.b`, `${d}.anode`)
        .wire(`${d}.cathode`, 'GND1.ref');
    });
    const o = ok(solve(b));
    expect(o.components[g]!.state).toMatchObject({
      input_a: 'x',
      input_b: 'high',
      gateOutput: 'x',
      firstUnknownInput: 'a',
    });
    expect(o.components.U2!.state).toMatchObject({ input_a: 'x', gateOutput: 'x' });
    expect(o.components.D1).toMatchObject({ unknown: true, current: null });
    expect(o.components.R3).toMatchObject({ unknown: true, current: null });
    // The PSU feeds two gates whose currents are unknown: its current is unknown.
    expect(o.components.PSU1).toMatchObject({ unknown: true, current: null });
    expect(o.unknownNets!.length).toBeGreaterThanOrEqual(2);
    // The divider itself is known: its voltage is a number.
    expect(o.components.R1!.unknown).toBeUndefined();
    expect(o.components[g]!.terminals.a!).toBeCloseTo(1.5, 9);
  });

  it('a controlling LOW input defines the output even with an X input (static CMOS)', () => {
    const { b, g } = gate('logic.gate_and', 3.0, ['open', 'l'], (bb, gg) => {
      const r1 = bb.add('component.resistor');
      const r2 = bb.add('component.resistor');
      bb.ohms(r1, 10_000).ohms(r2, 10_000);
      bb.wire('PSU1.positive', `${r1}.a`)
        .wire(`${r1}.b`, `${gg}.a`)
        .wire(`${gg}.a`, `${r2}.a`)
        .wire(`${r2}.b`, 'GND1.ref');
      load(10_000)(bb, gg);
    });
    const o = ok(solve(b));
    expect(o.components[g]!.state).toMatchObject({ input_a: 'x', gateOutput: 'low' });
    expect(o.unknownNets).toBeUndefined();
  });

  it('combinational feedback is refused (latches and oscillators need propagation delay)', () => {
    const self = gate('logic.gate_nand', 3.0, ['open', 'h'], (bb, gg) =>
      bb.wire(`${gg}.y`, `${gg}.a`),
    );
    expect(fails(solve(self.b))).toMatchObject({
      code: 'logic_feedback_unsupported',
      components: [self.g],
    });
    // Two NANDs cross-coupled (an SR latch) through resistors.
    const latch = gate('logic.gate_nand', 3.0, ['open', 'h'], (bb, gg) => {
      const n = bb.add('logic.gate_nand');
      const r = bb.add('component.resistor');
      bb.ohms(r, 1000);
      bb.wire(`${n}.vcc`, 'PSU1.positive')
        .wire(`${n}.gnd`, 'GND1.ref')
        .wire(`${n}.b`, 'PSU1.positive');
      bb.wire(`${gg}.y`, `${r}.a`).wire(`${r}.b`, `${n}.a`).wire(`${n}.y`, `${gg}.a`);
    });
    expect(fails(solve(latch.b))).toMatchObject({
      code: 'logic_feedback_unsupported',
      components: ['U1', 'U2'],
    });
  });

  it('a 20-inverter chain settles exactly and deterministically', () => {
    const b = new Bench();
    b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref');
    let prev = '';
    for (let k = 0; k < 20; k++) {
      const n = b.add('logic.gate_not');
      b.wire(`${n}.vcc`, 'PSU1.positive').wire(`${n}.gnd`, 'GND1.ref');
      if (prev) b.wire(`${prev}.y`, `${n}.a`);
      else b.wire(`${n}.a`, 'GND1.ref');
      prev = n;
    }
    load(10_000)(b, prev);
    const a = ok(solve(b));
    const c = ok(solve(b));
    // Input LOW, 20 inversions: LOW.
    expect(a.components[prev]!.state!.gateOutput).toBe('low');
    expect(a.components.U1!.state!.gateOutput).toBe('high');
    expect(JSON.stringify(a.components)).toBe(JSON.stringify(c.components));
  });
});

describe('ESP32 GPIO interop (pads in the same solve)', () => {
  /** GPIO18 (output) -> AND.a; AND.b tied high; AND.y -> GPIO4 (input) and 220 Ω + LED. */
  let G = '';
  const x1 = (vcc = 3.0) =>
    boardBench((b, u) => {
      const g = b.add('logic.gate_and');
      G = g;
      const r = b.add('component.resistor');
      const d = b.add('component.led');
      b.psu(vcc, 0.5).ohms(r, 220);
      b.wire('PSU1.positive', `${g}.vcc`)
        .wire(`${g}.gnd`, 'GND1.ref')
        .wire(`${g}.b`, 'PSU1.positive');
      b.wire(`${u}.gpio18`, `${g}.a`).wire(`${g}.y`, `${u}.gpio4`);
      b.wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
    });

  it('the pad drives the gate; the gate drives the LED and another pad; the pad reads the gate', () => {
    const bb = x1();
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'input');
    s.setPinMode(18, 'output-high');
    const on = ok(s.solve());
    const pad4 = on.pins!.find((p) => p.gpio === 4)!;
    expect(on.components[G]!.state).toMatchObject({ input_a: 'high', gateOutput: 'high' });
    expect(interpretDigitalInput(pad4.voltage, null)).toBe(1);
    expect(on.components.D1!.current!).toBeGreaterThan(1e-3);
    s.setPinMode(18, 'output-low');
    const off = ok(s.solve());
    expect(off.components[G]!.state).toMatchObject({ input_a: 'low', gateOutput: 'low' });
    expect(interpretDigitalInput(off.pins!.find((p) => p.gpio === 4)!.voltage, null)).toBe(0);
  });

  it('a pad switched to input under a gate input: the pad model holds the node (leakage), a defined LOW', () => {
    const bb = x1();
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'input');
    s.setPinMode(18, 'input');
    // An attached pad is a DC path through the MCU (the approved pin model, esp32Gpio.ts): the
    // gate input is not floating; the pad model puts it at its own (low) level.
    const o = ok(s.solve());
    expect(o.components[G]!.state).toMatchObject({ input_a: 'low', gateOutput: 'low' });
  });

  it('an unknown level reaching an ESP32 input is refused (logic_unknown_state)', () => {
    const bb = boardBench((b, u) => {
      const g = b.add('logic.gate_and');
      const r1 = b.add('component.resistor');
      const r2 = b.add('component.resistor');
      b.psu(3.0, 0.5).ohms(r1, 10_000).ohms(r2, 10_000);
      b.wire('PSU1.positive', `${g}.vcc`)
        .wire(`${g}.gnd`, 'GND1.ref')
        .wire(`${g}.b`, 'PSU1.positive');
      b.wire('PSU1.positive', `${r1}.a`)
        .wire(`${r1}.b`, `${g}.a`)
        .wire(`${g}.a`, `${r2}.a`)
        .wire(`${r2}.b`, 'GND1.ref');
      b.wire(`${g}.y`, `${u}.gpio4`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'input');
    expect(fails(s.solve())).toMatchObject({ code: 'logic_unknown_state', param: 'gpio4' });
  });
});
