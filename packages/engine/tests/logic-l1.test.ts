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

  it('the guaranteed output stage passes EXACTLY through every guaranteed point (never better)', () => {
    for (const card of Object.values(LVC1G_CARDS))
      for (const row of card.outputRows) {
        const st = outputStageAt(card, row.vcc);
        expect(st.tabulated).toBe(true);
        // [drop or V_OL, current] points: the ranged ±100 µA point, then each test point.
        expect(st.high).toEqual(
          [[0.1, 100e-6], ...row.high.map((p) => [row.vcc - p.volts, p.amps])].sort(
            (a, b) => a[1]! - b[1]!,
          ),
        );
        expect(st.low).toEqual(
          [[0.1, 100e-6], ...row.low.map((p) => [p.volts, p.amps])].sort((a, b) => a[1]! - b[1]!),
        );
        expect(st.validA).toBe(Math.max(...row.high.map((p) => p.amps)));
      }
    // 3.3 V is not a tabulated output point; PM-1: the 3 V points bound it (absolute V_OH minima,
    // so the drops grow with the supply: never better than at 3 V).
    const c33 = outputStageAt(AND, 3.3);
    expect(c33).toMatchObject({ tabulated: false, model: 'class', validA: 24e-3 });
    expect(c33.high.map(([v, a]) => [Number(v.toFixed(12)), a])).toEqual([
      [0.1, 100e-6],
      [0.9, 16e-3],
      [1.0, 24e-3],
    ]);
    expect(c33.low).toEqual([
      [0.1, 100e-6],
      [0.4, 16e-3],
      [0.55, 24e-3],
    ]);
    // The tolerance is numerical only: 3.001 V is not "at 3 V" (it is in the class).
    expect(outputStageAt(AND, 3.001)).toMatchObject({ tabulated: false, model: 'class' });
    // Outside every row and class (5 V): only the ranged row.
    expect(outputStageAt(AND, 5.0)).toMatchObject({ model: 'ranged', validA: 100e-6 });
  });

  it('function table for defined inputs only; any undefined input gives X (no controlling-input inference)', () => {
    // Sprint 20 (review #6): the sheets' function tables give outputs for VALID input levels
    // ("X" there means either valid level); the static-CMOS inference is not used.
    expect(gateOutput(AND, ['low', 'x'])).toBe('x');
    expect(gateOutput(AND, ['high', 'x'])).toBe('x');
    expect(gateOutput(AND, ['low', 'high'])).toBe('low');
    const or = LVC1G_CARDS['model.logic.sn74lvc1g32']!;
    expect(gateOutput(or, ['high', 'x'])).toBe('x');
    expect(gateOutput(or, ['high', 'low'])).toBe('high');
    const nand = LVC1G_CARDS['model.logic.sn74lvc1g00']!;
    expect(gateOutput(nand, ['low', 'x'])).toBe('x');
    expect(gateOutput(LVC1G_CARDS['model.logic.sn74lvc1g04']!, ['x'])).toBe('x');
  });
});

/**
 * PSU1 at `vcc` powers U (a gate) from its own pins; inputs tied to GND or HIGH (or `ins` as
 * built by the caller); the output drives `load` Ω to GND when given. Sprint 22 Q1 strict: a HIGH
 * input is at 5.5 V from a second supply (PSU2), the I_CC test condition "V_I = 5.5V or GND"
 * (SCES217AA §5.5), so PSU1's current-limit check has a bounded I_CC (≤ 10 µA + n × 5 µA).
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
  const hi = ins.includes('h') ? b.rail(5.5) : '';
  ['a', 'b'].slice(0, ins.length).forEach((t, i) => {
    if (ins[i] === 'h') b.wire(`${g}.${t}`, `${hi}.positive`);
    if (ins[i] === 'l') b.wire(`${g}.${t}`, 'GND1.ref');
  });
  build?.(b, g);
  return { b, g };
}
/**
 * Sprint 22 review 3: the bench-supply model cannot SINK current, and input leakage (±I_I, either
 * return pin) may flow back into a lightly loaded supply. Every ENABLED supply of these benches
 * gets a 10 kΩ bleeder (+ → GND, Bench.bleed) so it always delivers; the subjects are unchanged
 * (a supply's current then includes V/10 kΩ).
 */
const bled = new WeakMap<Bench, Set<string>>();
const bleedAll = (b: Bench) => {
  const done = bled.get(b) ?? new Set<string>();
  bled.set(b, done);
  for (const c of b.doc.components)
    if (c.type === 'instrument.lab_psu' && c.params.outputEnabled === true && !done.has(c.id)) {
      done.add(c.id);
      b.bleed(c.id);
    }
  return b;
};
const boardB = (build: (b: Bench, u: string) => void) =>
  boardBench((b, u) => {
    build(b, u);
    bleedAll(b);
  });
const solve = (b: Bench) => new EngineSession(bleedAll(b).snapshot()).solve();
const load = (ohms: number) => (b: Bench, g: string) => {
  const r = b.add('component.resistor');
  b.ohms(r, ohms).wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
};

describe('SN74LVC1G gates in the solve', () => {
  it('truth tables at V_CC = 3.0 V into 10 kΩ: HIGH = 3 V·10k/(10k + R_OH), LOW = 0 V', () => {
    // HIGH into 10 kΩ: I ≈ 0.29 mA, on the segment (0.1 V, 100 µA) – (0.6 V, 16 mA) of the
    // guaranteed envelope: drop = 0.1 + (I − 100 µA)·k, k = 0.5 V / 15.9 mA; I = (3 − drop) / 10k.
    const k = 0.5 / 15.9e-3;
    const I = (3.0 - 0.1 + 100e-6 * k) / (10_000 + k);
    const high = 3.0 - (0.1 + (I - 100e-6) * k);
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
    // PSU1 delivers the LED current plus its 10 kΩ bleeder's 3.0 V / 10 kΩ = 300 µA.
    expect(o.components.PSU1!.current!).toBeCloseTo(led + 3.0 / 10_000, 12);
    // V_Y on the guaranteed envelope at that current (a few mA: the (100 µA, 16 mA) segment).
    expect(led).toBeLessThan(16e-3);
    expect(u.terminals.y!).toBeCloseTo(3.0 - (0.1 + (led - 100e-6) * (0.5 / 15.9e-3)), 9);
    expect(ratingWarnings(b.snapshot(), o)).toEqual([]);
    expect(u.outsideModelRange).toBeUndefined();
  });

  it('fan-out: 4 more gate inputs on Y are guaranteed levels, but their I_CC is unbounded (Q1); overload is rated', () => {
    const one = gate('logic.gate_and', 3.0, ['h', 'h'], load(1000));
    ok(solve(one.b));
    let fan: string[] = [];
    const many = gate('logic.gate_and', 3.0, ['h', 'h'], (bb, gg) => {
      load(1000)(bb, gg);
      const hi = bb.rail(5.5);
      fan = [];
      for (let k = 0; k < 4; k++) {
        const n = bb.add('logic.gate_and');
        fan.push(n);
        bb.wire(`${n}.vcc`, 'PSU1.positive').wire(`${n}.gnd`, 'GND1.ref');
        bb.wire(`${gg}.y`, `${n}.a`).wire(`${n}.b`, `${hi}.positive`);
      }
    });
    // Sprint 22 Q1 strict: each fan-out input sits at Y, guaranteed only within V_OH's band (never
    // within 1 mV of 5.5 V or GND), so its I_CC has no datasheet bound and PSU1's current limit
    // depends on it. The deferred refusal is returned only after every level and output check
    // held (Y's own guarantee with the 4 inputs' leakage included): refused by that name.
    expect(fails(solve(many.b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: [fan[0], 'PSU1'],
      detail: { condition: 'notInputs', check: 'limit', psu: 'PSU1' },
    });
    // 47 Ω draws more than 24 mA, the largest guaranteed current at 3 V: no characteristic
    // there, so refused (never an extrapolated number); 10 Ω likewise.
    for (const ohms of [47, 10]) {
      const heavy = gate('logic.gate_and', 3.0, ['h', 'h'], load(ohms));
      expect(fails(solve(heavy.b))).toMatchObject({
        code: 'logic_output_uncharacterized',
        components: [heavy.g],
      });
    }
  });

  it('PM-1: over the 3.3 V ± 0.3 V class the 3 V points bound the output (each part, each load condition)', () => {
    // Bound (logic/lvc1g.ts): V_OH >= V_CC - 0.1 at 100 uA; >= 2.4 V at 16 mA; >= 2.3 V at 24 mA;
    // V_OL <= 0.1 / 0.4 / 0.55 V at 100 uA / 16 / 24 mA; above 24 mA refused. Expected values by
    // hand: a resistor sized to land exactly on a test point gives exactly that point's voltage.
    const highIn = {
      'logic.gate_and': ['h', 'h'],
      'logic.gate_nand': ['l', 'h'],
      'logic.gate_or': ['h', 'l'],
      'logic.gate_not': ['l'],
    } as const;
    const lowIn = {
      'logic.gate_and': ['l', 'h'],
      'logic.gate_nand': ['h', 'h'],
      'logic.gate_or': ['l', 'l'],
      'logic.gate_not': ['h'],
    } as const;
    for (const type of [
      'logic.gate_and',
      'logic.gate_nand',
      'logic.gate_or',
      'logic.gate_not',
    ] as const)
      for (const vcc of [3.3, 3.6]) {
        const at = `${type} at ${vcc} V`;
        // HIGH sourcing exactly 16 mA (R = V_OH / I): V_Y is the guaranteed minimum. Sprint 22
        // (Q5): a real output can be stronger, up to its rail; into that resistor it then draws
        // V_CC / R: 22 mA (3.3 V) / 24 mA (3.6 V) ≤ 24 mA — runs. Sized for exactly 24 mA at
        // 2.3 V (R = 95.8 Ω), the rail gives 34 / 38 mA > 24 mA: refused (not guaranteed).
        {
          const t = gate(type, vcc, [...highIn[type]], load(2.4 / 16e-3));
          const u = ok(solve(t.b)).components[t.g]!;
          expect(u.state, at).toMatchObject({ gateOutput: 'high', outputModel: 'class' });
          expect(u.terminals.y!, `${at} 16 mA`).toBeCloseTo(2.4, 9);
          expect(u.currents!.y!, `${at} 16 mA`).toBeCloseTo(16e-3, 12);
          const t24 = gate(type, vcc, [...highIn[type]], load(2.3 / 24e-3));
          expect(fails(solve(t24.b)), `${at} 24 mA`).toMatchObject({
            code: 'logic_output_uncharacterized',
            param: 'y',
          });
        }
        // An LED-class load (220 ohm) lands on the (100 uA, 16 mA) segment of the bound:
        // drop = 0.1 + (I - 100 uA) k, k = (V_CC - 2.4 - 0.1) / 15.9 mA; I = (V_CC - drop) / 220.
        const k = (vcc - 2.4 - 0.1) / 15.9e-3;
        const I = (vcc - 0.1 + 100e-6 * k) / (220 + k);
        const led = gate(type, vcc, [...highIn[type]], load(220));
        expect(ok(solve(led.b)).components[led.g]!.terminals.y!, at).toBeCloseTo(I * 220, 9);
        // Above 24 mA: no guaranteed characteristic, refused (never extrapolated).
        const over = gate(type, vcc, [...highIn[type]], load(80));
        expect(fails(solve(over.b)), at).toMatchObject({ code: 'logic_output_uncharacterized' });
        // LOW sinking exactly 16 mA from a resistor to V_CC: V_Y is the guaranteed maximum
        // (with Y at GND the resistor draws V_CC / R ≤ 24 mA). At exactly 24 mA (0.55 V) the GND
        // side draws more than 24 mA: refused (Sprint 22, Q5).
        for (const [amps, vol, runs] of [
          [16e-3, 0.4, true],
          [24e-3, 0.55, false],
        ] as const) {
          const t = gate(type, vcc, [...lowIn[type]], (bb, gg) => {
            const r = bb.add('component.resistor');
            bb.ohms(r, (vcc - vol) / amps)
              .wire('PSU1.positive', `${r}.a`)
              .wire(`${r}.b`, `${gg}.y`);
          });
          if (!runs) {
            expect(fails(solve(t.b)), `${at} low ${amps}`).toMatchObject({
              code: 'logic_output_uncharacterized',
            });
            continue;
          }
          const u = ok(solve(t.b)).components[t.g]!;
          expect(u.state, at).toMatchObject({ gateOutput: 'low', outputModel: 'class' });
          expect(u.terminals.y!, `${at} low ${amps}`).toBeCloseTo(vol, 9);
        }
      }
    // At exactly 3.0 V the tabulated row itself applies; above the class (3.7 V) the sheets give
    // no input row: refused, as before.
    const at3 = gate('logic.gate_and', 3.0, ['h', 'h'], load(220));
    expect(ok(solve(at3.b)).components[at3.g]!.state).toMatchObject({ outputModel: 'tabulated' });
    const above = gate('logic.gate_and', 3.7, ['h', 'h'], load(220));
    expect(fails(solve(above.b))).toMatchObject({ code: 'logic_supply_uncharacterized' });
  });

  it('outside the class and the rows (e.g. 2.0 V) only the ±100 µA row holds: light loads only', () => {
    const light = gate('logic.gate_and', 5.0, ['h', 'h'], load(1_000_000));
    const y = ok(solve(light.b)).components[light.g]!;
    expect(y.state).toMatchObject({ gateOutput: 'high', outputModel: 'ranged' });
    expect(y.terminals.y!).toBeCloseTo((5.0 * 1e6) / (1e6 + 1000), 9);
    const heavy = gate('logic.gate_and', 5.0, ['h', 'h'], load(220));
    expect(fails(solve(heavy.b))).toMatchObject({ code: 'logic_output_uncharacterized' });
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

  it('an input in the undefined band is REFUSED by name (Sprint 20), naming the root cause, not a downstream part', () => {
    // A: divider 3.0 V -> 10k -> A -> 10k -> GND = 1.5 V, between V_IL 0.8 and V_IH 2.0.
    // Y -> a second gate (NOT) -> 220 Ω + LED: the root cause (U1's A) is named.
    const { b, g } = gate('logic.gate_and', 3.0, ['open', 'h'], (bb, gg) => {
      const r1 = bb.add('component.resistor');
      const r2 = bb.add('component.resistor');
      bb.ohms(r1, 10_000).ohms(r2, 10_000);
      bb.wire('PSU1.positive', `${r1}.a`)
        .wire(`${r1}.b`, `${gg}.a`)
        .wire(`${gg}.a`, `${r2}.a`)
        .wire(`${r2}.b`, 'GND1.ref');
      const n = bb.add('logic.gate_not');
      bb.wire(`${n}.vcc`, 'PSU1.positive').wire(`${n}.gnd`, 'GND1.ref').wire(`${gg}.y`, `${n}.a`);
      const r = bb.add('component.resistor');
      const d = bb.add('component.led');
      bb.ohms(r, 220)
        .wire(`${n}.y`, `${r}.a`)
        .wire(`${r}.b`, `${d}.anode`)
        .wire(`${d}.cathode`, 'GND1.ref');
    });
    expect(fails(solve(b))).toEqual({
      code: 'logic_input_undefined',
      components: [g],
      param: 'a',
      detail: { part: 'SN74LVC1G08', value: expect.closeTo(1.5, 9), vcc: 3, vih: 2, vil: 0.8 },
    });
  });

  it('a LOW input does NOT decide the output when the other input is undefined: refused (review #6)', () => {
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
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_undefined',
      components: [g],
      param: 'a',
    });
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
    // Sprint 22 Q1 strict: every inner input is a gate output (never within 1 mV of 5.5 V or GND),
    // so the chain cannot run under PSU1's current-limit check. The guarantee bounds run only
    // AFTER the settle loop converged, so a bounds refusal (never no_steady_state / unknown state /
    // feedback) shows the chain settled, and it is the same refusal on every solve.
    const a = fails(solve(b));
    const c = fails(solve(b));
    expect(['no_steady_state', 'logic_unknown_state', 'logic_feedback_unsupported']).not.toContain(
      a.code,
    );
    // U3.a sits at U2's LOW output, guaranteed only ≤ V_OL 0.1 V (±100 µA): worst 0.1 V.
    expect(a).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: ['U3', 'PSU1'],
      param: 'a',
      detail: {
        condition: 'notInputs',
        check: 'limit',
        worst: expect.closeTo(0.1, 9),
        causes: expect.arrayContaining(['output_guarantee']),
      },
    });
    expect(c).toEqual(a);
  });
});

describe('review fixes (Sprint 19B independent review)', () => {
  it('a gate fed through a resistor works (no self-inflicted unknown supply)', () => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    const r = b.add('component.resistor');
    // Sprint 21: the supply now has to be guaranteed within the I_CC bound through the 1 Ω (inputs
    // at GND: the I_CC test condition). At exactly 3.0 V any drop leaves the tabulated point (and
    // the 3.0 V row), so 3.3 V (the PM-1 class): (10 + 2 × 5) µA × 1 Ω = 20 µV.
    b.psu(3.3, 0.5).ohms(r, 1).wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${r}.a`);
    b.wire(`${r}.b`, `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.a`, 'GND1.ref')
      .wire(`${g}.b`, 'GND1.ref');
    load(10_000)(b, g);
    expect(ok(solve(b)).components[g]!.state).toMatchObject({
      gateOutput: 'low',
      outputModel: 'class',
    });
  });

  it('a relay coil behind a gate with an undefined input: the gate input is named (root cause)', () => {
    const { b, g } = gate('logic.gate_not', 3.0, ['open'], (bb, gg) => {
      const r1 = bb.add('component.resistor');
      const r2 = bb.add('component.resistor');
      bb.ohms(r1, 10_000).ohms(r2, 10_000);
      bb.wire('PSU1.positive', `${r1}.a`)
        .wire(`${r1}.b`, `${gg}.a`)
        .wire(`${gg}.a`, `${r2}.a`)
        .wire(`${r2}.b`, 'GND1.ref');
      const k = bb.add('component.relay');
      bb.wire(`${gg}.y`, `${k}.coil1`).wire(`${k}.coil2`, 'GND1.ref').wire(`${k}.com`, 'GND1.ref');
    });
    expect(fails(solve(b))).toMatchObject({ code: 'logic_input_undefined', components: [g] });
  });

  it('a HIGH output forced above its own V_CC is outside every test point: refused', () => {
    const { b, g } = gate('logic.gate_and', 3.0, ['h', 'h'], (bb, gg) => {
      const p2 = bb.add('instrument.lab_psu');
      const r = bb.add('component.resistor');
      bb.set(p2, 'setpointVoltage', { value: 5, unit: 'volt' })
        .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
        .set(p2, 'outputEnabled', true)
        .ohms(r, 100_000);
      bb.wire(`${p2}.negative`, 'GND1.ref')
        .wire(`${p2}.positive`, `${r}.a`)
        .wire(`${r}.b`, `${gg}.y`);
    });
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_output_uncharacterized',
      components: [g],
    });
  });

  it('a supply in current limit pulling the gate out of its rows is named, not "no steady state"', () => {
    const { b, g } = gate('logic.gate_and', 3.0, ['h', 'h'], load(1000));
    b.set('PSU1', 'currentLimit', { value: 1e-3, unit: 'ampere' });
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_supply_uncharacterized',
      components: [g],
    });
  });

  it('a 40-inverter chain settles (one pass per level, the cap grows with the logic)', () => {
    const b = new Bench();
    b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref');
    let prev = '';
    for (let k = 0; k < 40; k++) {
      const n = b.add('logic.gate_not');
      b.wire(`${n}.vcc`, 'PSU1.positive').wire(`${n}.gnd`, 'GND1.ref');
      if (prev) b.wire(`${prev}.y`, `${n}.a`);
      else b.wire(`${n}.a`, 'GND1.ref');
      prev = n;
    }
    // Sprint 22 Q1 strict: refused by a guarantee bound (see the 20-inverter chain), which runs
    // only after the settle loop converged — never no_steady_state.
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      param: 'a',
      detail: { condition: 'notInputs', check: 'limit' },
    });
  });

  it('pull-ups to the same rail are not feedback, even with that rail switched off', () => {
    const { b } = gate('logic.gate_and', 3.0, ['open', 'h'], (bb, gg) => {
      const r1 = bb.add('component.resistor');
      const r2 = bb.add('component.resistor');
      bb.ohms(r1, 10_000).ohms(r2, 10_000);
      bb.wire('PSU1.positive', `${r1}.a`).wire(`${r1}.b`, `${gg}.a`);
      bb.wire('PSU1.positive', `${r2}.a`).wire(`${r2}.b`, `${gg}.y`);
    });
    // Sprint 22 Q1 strict: A pulled up to 3.0 V (not 5.5 V): I_CC unbounded, and PSU1's current
    // limit depends on it — refused by that name only after the levels held (not as feedback).
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      detail: { condition: 'notInputs', check: 'limit' },
    });
    b.set('PSU1', 'outputEnabled', false);
    const off = solve(b);
    expect(off.ok ? 'ok' : off.error.code).not.toBe('logic_feedback_unsupported');
  });

  it('no bound is claimed for an unknown output current (review #1): no gate type declares one', async () => {
    // Before Sprint 20 the ±50 mA I_O absolute maximum was used as the most an X output could
    // draw from a CV supply; it is a stress rating, not a bound (§5.1 note 1, §7.3.1).
    const { partModel } = await import('../src/parts.js');
    for (const type of ['logic.gate_and', 'logic.gate_nand', 'logic.gate_or', 'logic.gate_not'])
      expect(partModel(type as never)!.unknownCurrentMaxA, type).toBeUndefined();
    expect(partModel('logic.quad_and')!.unknownCurrentMaxA).toBeUndefined();
  });

  it('Y pulled above V_CC + 0.5 V while powered is an absolute-maximum excess', () => {
    // An unpowered gate (V_CC = 0): outputs off; Y held at 5 V by a second supply: within the
    // power-off range (6.5 V), no excess; a powered gate cannot be checked this way (refused).
    const { b, g } = gate('logic.gate_and', 0, ['l', 'l'], (bb, gg) => {
      const p2 = bb.add('instrument.lab_psu');
      const r = bb.add('component.resistor');
      bb.set(p2, 'setpointVoltage', { value: 5, unit: 'volt' })
        .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
        .set(p2, 'outputEnabled', true)
        .ohms(r, 1000);
      bb.wire(`${p2}.negative`, 'GND1.ref')
        .wire(`${p2}.positive`, `${r}.a`)
        .wire(`${r}.b`, `${gg}.y`);
      load(10_000)(bb, gg);
    });
    const o = ok(solve(b));
    expect(o.components[g]!.state!.gateOutput).toBe('off');
    expect(ratingWarnings(b.snapshot(), o).filter((w) => w.component === g)).toEqual([]);
  });
});

describe('ESP32 GPIO interop (pads in the same solve)', () => {
  /** GPIO18 (output) -> AND.a; AND.b tied high; AND.y -> GPIO4 (input) and 220 Ω + LED. */
  let G = '';
  const x1 = (vcc = 3.0) =>
    boardB((b, u) => {
      const g = b.add('logic.gate_and');
      G = g;
      const r = b.add('component.resistor');
      const d = b.add('component.led');
      b.psu(vcc, 0.5).ohms(r, 220);
      // Sprint 22 Q1 strict: B at 5.5 V (PSU2), its I_CC test voltage (SCES217AA §5.5).
      const hi = b.rail(5.5);
      b.wire('PSU1.positive', `${g}.vcc`)
        .wire(`${g}.gnd`, 'GND1.ref')
        .wire(`${g}.b`, `${hi}.positive`);
      b.wire(`${u}.gpio18`, `${g}.a`).wire(`${g}.y`, `${u}.gpio4`);
      b.wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
    });

  it('the pad drives the gate; the gate drives the LED and another pad; the pad reads the gate', () => {
    const bb = x1();
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'input');
    s.setPinMode(18, 'output-high');
    // Sprint 21 review (item 3): Y HIGH sources the LED (> 100 µA), so at 3.0 V only V_OH ≥ 2.4 V
    // (16 mA test point) is guaranteed — below the ESP32's V_IH 0.75 × 3.3 = 2.475 V: GPIO4 would
    // read a HIGH that is not guaranteed. Refused by name (the model alone says 2.78 V → HIGH).
    expect(fails(s.solve())).toMatchObject({
      code: 'logic_mcu_input_not_guaranteed',
      param: 'gpio4',
      detail: {
        gpio: 4,
        level: 'high',
        worst: expect.closeTo(2.4, 9),
        causes: expect.arrayContaining(['output_guarantee']),
      },
    });
    // Sprint 22 Q1 strict: GPIO18 LOW is guaranteed only ≤ 0.1 × VDD = 0.33 V (ESP32 Table 5-3),
    // not within 1 mV of GND: A leaves the I_CC test condition, and PSU1's current limit depends
    // on I_CC → refused by name, after every level check held (the I_CC conditions are checked
    // last). The worst A is 0.33 V + the leakage drop.
    s.setPinMode(18, 'output-low');
    expect(fails(s.solve())).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: [G, 'PSU1'],
      param: 'a',
      detail: {
        condition: 'notInputs',
        check: 'limit',
        causes: expect.arrayContaining(['esp32_vol']),
      },
    });
  });

  it("a pad switched to input under a gate input: FLOATING (Sprint 20), never the leakage model's 0 V LOW", () => {
    const bb = x1();
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'input');
    s.setPinMode(18, 'input');
    // The pad's input leakage (esp32Gpio.ts) is a numerical reference to GND, not a driver: the
    // gate input has nothing driving it ("Do not leave standard CMOS inputs floating", §7.3.3).
    expect(fails(s.solve())).toEqual({
      code: 'logic_input_floating',
      components: [G],
      param: 'a',
      detail: { part: 'SN74LVC1G08', vcc: 3, pads: [18] },
    });
    // Driven by the pad: defined again (no longer floating). Sprint 22 Q1 strict: a pad LOW is
    // not exactly GND (≤ 0.33 V guaranteed), so the I_CC condition fails → refused by that name.
    s.setPinMode(18, 'output-low');
    expect(fails(s.solve())).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      param: 'a',
      detail: { check: 'limit' },
    });
  });

  it('an undefined gate input upstream of an ESP32 input: the gate input is named (root cause)', () => {
    const bb = boardB((b, u) => {
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
    expect(fails(s.solve())).toMatchObject({ code: 'logic_input_undefined', param: 'a' });
  });
});
