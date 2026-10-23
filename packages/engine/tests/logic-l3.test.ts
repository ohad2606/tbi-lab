/**
 * Exploration Foundation L3 (packaged logic) and L2 (logic state inspection).
 *
 * The SN74LVC08A card is checked figure by figure against Texas Instruments SCAS283W (January
 * 1993, revised July 2024; pinned PDF sha256 5edd5cd6…cc2ba4), −40 °C to +85 °C column. Every
 * expected solve number is computed by hand from those figures, not read back from the engine.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  evaluate,
  inputRowAt,
  LVC08A_CARD,
  outputStageAt,
  packageRatings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code} ${JSON.stringify(o.error)}`);
  return o;
};
const fails = (o: SolveOutcome) => {
  if (o.ok) throw new Error('expected a refusal');
  return o.error;
};
const C = LVC08A_CARD;
const solve = (b: Bench) => new EngineSession(b.snapshot()).solve();

describe('SN74LVC08A card = SCAS283W figures', () => {
  it('§4 Table 4-1: the 14-pin map (SOIC, SSOP, SOP, CDIP, TSSOP, VQFN, WQFN column)', () => {
    expect(C.pins).toEqual({
      a1: 1,
      b1: 2,
      y1: 3,
      a2: 4,
      b2: 5,
      y2: 6,
      gnd: 7,
      y3: 8,
      a3: 9,
      b3: 10,
      y4: 11,
      a4: 12,
      b4: 13,
      vcc: 14,
    });
    // Four gates, one shared supply: every gate's pins are distinct; V_CC/GND belong to none.
    const gatePins = C.units.flatMap((u) => [...u.inputs, u.output]);
    expect(new Set(gatePins).size).toBe(12);
    expect(gatePins).not.toContain('vcc');
    expect(gatePins).not.toContain('gnd');
    expect(C.function).toBe('and');
  });

  it('§7.4 Table 7-1 truth table (L L→L, L H→L, H L→L, H H→H)', () => {
    expect(evaluate('and', [false, false])).toBe(false);
    expect(evaluate('and', [false, true])).toBe(false);
    expect(evaluate('and', [true, false])).toBe(false);
    expect(evaluate('and', [true, true])).toBe(true);
  });

  it('§5.1 absolute maximum ratings', () => {
    expect(C.vccAbsMax).toBe(6.5); // V_CC −0.5 to 6.5 V
    expect(C.inputAbsolute).toEqual([-0.5, 6.5]); // V_I
    expect(C.outputAbsAboveVcc).toBe(0.5); // V_O to V_CC + 0.5 V
    expect(C.outputAbsA).toBe(50e-3); // I_O ±50 mA
    expect(C.supplyPinAbsA).toBe(100e-3); // continuous current through V_CC or GND ±100 mA
  });

  it('§5.4 recommended operating conditions (SN74LVC08A)', () => {
    expect(C.vccOperating).toEqual([1.65, 3.6]);
    expect(C.inputRecommended).toEqual([0, 5.5]);
    expect(C.inputRows).toEqual([
      { vcc: [1.65, 1.95], vih: { k: 0.65 }, vil: { k: 0.35 } },
      { vcc: [2.3, 2.7], vih: { v: 1.7 }, vil: { v: 0.7 } },
      { vcc: [2.7, 3.6], vih: { v: 2.0 }, vil: { v: 0.8 } },
    ]);
    // I_OH / I_OL maxima per supply = the largest test point at that supply (§5.4 = §5.7).
    expect(C.outputRows.map((r) => [r.vcc, Math.max(...r.high.map((p) => p.amps))])).toEqual([
      [1.65, 4e-3],
      [2.3, 8e-3],
      [2.7, 12e-3],
      [3.0, 24e-3],
    ]);
  });

  it('§5.7 electrical characteristics, −40 °C to +85 °C', () => {
    expect(C.rangedOutput).toEqual({ vcc: [1.65, 3.6], amps: 100e-6, drop: 0.2, low: 0.2 });
    expect(C.outputRows).toEqual([
      { vcc: 1.65, high: [{ amps: 4e-3, volts: 1.2 }], low: [{ amps: 4e-3, volts: 0.45 }] },
      { vcc: 2.3, high: [{ amps: 8e-3, volts: 1.7 }], low: [{ amps: 8e-3, volts: 0.7 }] },
      { vcc: 2.7, high: [{ amps: 12e-3, volts: 2.2 }], low: [{ amps: 12e-3, volts: 0.4 }] },
      {
        vcc: 3.0,
        high: [
          { amps: 12e-3, volts: 2.4 },
          { amps: 24e-3, volts: 2.2 },
        ],
        low: [{ amps: 24e-3, volts: 0.55 }],
      },
    ]);
    // No PM-1 class bound: this sheet makes no 3.3 V drive claim.
    expect(C.outputRows.some((r) => r.classVcc)).toBe(false);
    expect(C.inputLeakageA).toBe(5e-6); // I_I ±5 µA
    expect(C.iccMaxA).toBe(10e-6); // I_CC 10 µA
    expect(C.deltaIccA).toBe(500e-6); // ΔI_CC 500 µA
    expect(C.ciF).toBe(5e-12); // C_i 5 pF typ
    expect(C.ioffA).toBeUndefined(); // no I_off row in this sheet
    expect(C.tpd33).toEqual([1e-9, 4.1e-9]); // §5.9 t_pd 3.3 V ± 0.3 V
    expect(C.unusedInputs).toBe(
      'All unused inputs of the device must be held at VCC or GND to ensure proper device operation.',
    );
  });

  it('input rows: each as stated; at the shared 2.7 V boundary the stricter of the two rows', () => {
    expect(inputRowAt(C, 3.0)).toEqual({ vih: 2.0, vil: 0.8 });
    expect(inputRowAt(C, 3.3)).toEqual({ vih: 2.0, vil: 0.8 });
    expect(inputRowAt(C, 2.5)).toEqual({ vih: 1.7, vil: 0.7 });
    expect(inputRowAt(C, 2.7)).toEqual({ vih: 2.0, vil: 0.7 });
    expect(inputRowAt(C, 1.8)!.vih).toBeCloseTo(0.65 * 1.8, 12);
    expect(inputRowAt(C, 1.8)!.vil).toBeCloseTo(0.35 * 1.8, 12);
    for (const v of [1.5, 2.0, 2.2, 3.61, 4.0, 5.0]) expect(inputRowAt(C, v)).toBeUndefined();
  });

  it('output stage: exactly through the guaranteed points; 3.3 V only the ±100 µA row', () => {
    expect(outputStageAt(C, 3.0)).toMatchObject({
      tabulated: true,
      model: 'tabulated',
      validA: 24e-3,
    });
    const s3 = outputStageAt(C, 3.0);
    expect(s3.high.map(([v, a]) => [Number(v.toFixed(12)), a])).toEqual([
      [0.2, 100e-6],
      [0.6, 12e-3],
      [0.8, 24e-3],
    ]);
    expect(s3.low).toEqual([
      [0.2, 100e-6],
      [0.55, 24e-3],
    ]);
    const s27 = outputStageAt(C, 2.7);
    expect(s27.high.map(([v, a]) => [Number(v.toFixed(12)), a])).toEqual([
      [0.2, 100e-6],
      [0.5, 12e-3],
    ]);
    expect(s27.low).toEqual([
      [0.2, 100e-6],
      [0.4, 12e-3],
    ]);
    expect(outputStageAt(C, 3.3)).toMatchObject({ model: 'ranged', validA: 100e-6 });
  });
});

/** PSU1 at `vcc` → U1 (V_CC pin 14, GND pin 7); `hi`/`lo` inputs tied to V_CC/GND. */
function quad(vcc: number, hi: string[], lo: string[], amps = 0.5) {
  const b = new Bench();
  const u = b.add('logic.quad_and');
  b.psu(vcc, amps)
    .wire('PSU1.negative', 'GND1.ref')
    .wire('PSU1.positive', `${u}.vcc`)
    .wire(`${u}.gnd`, 'GND1.ref');
  for (const t of hi) b.wire(`${u}.${t}`, 'PSU1.positive');
  for (const t of lo) b.wire(`${u}.${t}`, 'GND1.ref');
  return { b, u };
}
const load = (b: Bench, from: string, ohms: number) => {
  const r = b.add('component.resistor');
  b.ohms(r, ohms).wire(from, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
  return r;
};
/** HIGH at 3.0 V into R: on the segment (0.2 V, 100 µA)–(0.6 V, 12 mA) of the envelope. */
const highInto = (R: number) => {
  const k = 0.4 / 11.9e-3;
  const I = (3.0 - 0.2 + 100e-6 * k) / (R + k);
  return { I, V: 3.0 - (0.2 + (I - 100e-6) * k) };
};

describe('SN74LVC08A in the solve: four gates, one shared supply', () => {
  it('each gate its own truth-table row at once (LL, LH, HL, HH) into 10 kΩ', () => {
    const { b, u } = quad(3.0, ['b2', 'a3', 'a4', 'b4'], ['a1', 'b1', 'a2', 'b3']);
    for (const y of ['y1', 'y2', 'y3', 'y4']) load(b, `${u}.${y}`, 10_000);
    const r = ok(solve(b)).components[u]!;
    const h = highInto(10_000);
    expect(r.logic!.gates.map((g) => g.output.level)).toEqual(['low', 'low', 'low', 'high']);
    expect(r.terminals['y4']!).toBeCloseTo(h.V, 9);
    for (const y of ['y1', 'y2', 'y3']) expect(r.terminals[y]!).toBeCloseTo(0, 9);
    // The shared V_CC pin carries exactly gate 4's source current; PSU1 delivers it.
    expect(r.currents!['y4']).toBeCloseTo(h.I, 12);
    expect(r.currents!.vcc).toBeCloseTo(h.I, 12);
    expect(ok(solve(b)).components.PSU1!.current!).toBeCloseTo(h.I, 12);
  });

  it('all four HIGH into 1 kΩ: the supply pin carries the SUM (4 × I), out of the solve', () => {
    const ins = ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'];
    const { b, u } = quad(3.0, ins, []);
    for (const y of ['y1', 'y2', 'y3', 'y4']) load(b, `${u}.${y}`, 1000);
    const o = ok(solve(b));
    const r = o.components[u]!;
    const h = highInto(1000);
    for (const y of ['y1', 'y2', 'y3', 'y4']) expect(r.terminals[y]!).toBeCloseTo(h.V, 9);
    expect(r.currents!.vcc).toBeCloseTo(4 * h.I, 12);
    expect(r.currents!.gnd).toBe(0);
    expect(o.components.PSU1!.current!).toBeCloseTo(4 * h.I, 12);
  });

  it('a LOW output sinks through the shared GND pin: V_OL on the (0.2 V, 100 µA)–(0.55 V, 24 mA) segment', () => {
    // 3.0 V → 1 kΩ → 1Y (LOW: 1A tied low).
    const { b, u } = quad(3.0, ['a2', 'b2', 'a3', 'b3', 'a4', 'b4'], ['a1', 'b1']);
    const r = b.add('component.resistor');
    b.ohms(r, 1000).wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${u}.y1`);
    const k = 0.35 / 23.9e-3;
    // V = 0.2 + (I − 100 µA)·k and I = (3 − V)/1000.
    const I = (3.0 - 0.2 + 100e-6 * k) / (1000 + k);
    const res = ok(solve(b)).components[u]!;
    expect(res.terminals['y1']!).toBeCloseTo(0.2 + (I - 100e-6) * k, 9);
    expect(res.currents!['y1']).toBeCloseTo(-I, 12);
    expect(res.currents!.gnd).toBeCloseTo(I, 12);
  });

  it('the other tabulated rows in the solve: 2.7 V and 1.65 V into 10 kΩ; 1.8 V (ranged only) into 100 kΩ', () => {
    const ins = ['a1', 'b1'];
    const rest = ['a2', 'b2', 'a3', 'b3', 'a4', 'b4'];
    // 2.7 V: (0.2 V, 100 µA)–(0.5 V, 12 mA); 1.65 V: (0.2 V, 100 µA)–(0.45 V, 4 mA).
    for (const [vcc, drop2, i2] of [
      [2.7, 0.5, 12e-3],
      [1.65, 0.45, 4e-3],
    ] as const) {
      const { b, u } = quad(vcc, ins, rest);
      load(b, `${u}.y1`, 10_000);
      const k = (drop2 - 0.2) / (i2 - 100e-6);
      const I = (vcc - 0.2 + 100e-6 * k) / (10_000 + k);
      const r = ok(solve(b)).components[u]!;
      expect(r.state!.outputModel, String(vcc)).toBe('tabulated');
      expect(r.terminals.y1!, String(vcc)).toBeCloseTo(vcc - (0.2 + (I - 100e-6) * k), 9);
    }
    // 1.8 V (0.65/0.35 × V_CC row; no output test point): only the ±100 µA point, through 0.
    const { b, u } = quad(1.8, ins, rest);
    load(b, `${u}.y1`, 100_000);
    const r = ok(solve(b)).components[u]!;
    expect(r.state!.outputModel).toBe('ranged');
    // Drop = 0.2 V / 100 µA × I = 2 kΩ × I: V = 1.8 × 100k / 102k.
    expect(r.terminals.y1!).toBeCloseTo((1.8 * 100_000) / 102_000, 9);
    expect(r.logic).toMatchObject({ vih: expect.closeTo(1.17, 12), vil: expect.closeTo(0.63, 12) });
  });

  it('a chain between gates of the SAME package settles (not feedback): 1Y → 2A', () => {
    const { b, u } = quad(3.0, ['a1', 'b1', 'b2', 'a3', 'b3', 'a4', 'b4'], []);
    b.wire(`${u}.y1`, `${u}.a2`);
    load(b, `${u}.y2`, 10_000);
    const r = ok(solve(b)).components[u]!;
    expect(r.logic!.gates[1]!.inputs[0]).toMatchObject({ pin: 'a2', level: 'high' });
    expect(r.logic!.gates[1]!.output.level).toBe('high');
    expect(r.terminals['y2']!).toBeCloseTo(highInto(10_000).V, 9);
  });
});

describe('SN74LVC08A refusals, by name', () => {
  it('logic_input_floating: an UNUSED gate left open (datasheet: unused inputs at V_CC or GND)', () => {
    const { b } = quad(3.0, ['a1', 'b1', 'a2', 'b2', 'a4', 'b4'], []);
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_floating',
      components: ['U1'],
      param: 'a3',
      detail: { part: 'SN74LVC08A' },
    });
  });

  it('logic_unpowered_uncharacterized: V_CC = 0 V (no I_off in this sheet), never "off"', () => {
    const { b } = quad(0, [], ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_unpowered_uncharacterized',
      components: ['U1'],
    });
  });

  it('logic_supply_uncharacterized: between rows (2.0 V) and above 3.6 V (5.0 V: a 1G supply)', () => {
    for (const v of [1.5, 2.0, 2.2, 3.7, 5.0]) {
      const { b } = quad(v, [], ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
      expect(fails(solve(b)), String(v)).toMatchObject({
        code: 'logic_supply_uncharacterized',
        detail: { part: 'SN74LVC08A', vcc: expect.closeTo(v, 9) },
      });
    }
  });

  it('logic_output_uncharacterized: 1 kΩ at 3.3 V (only ±100 µA guaranteed there), naming the pin', () => {
    const { b, u } = quad(3.3, ['a4', 'b4'], ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
    load(b, `${u}.y4`, 1000);
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_output_uncharacterized',
      param: 'y4',
      detail: { part: 'SN74LVC08A', limit: 100e-6 },
    });
    // A light load there (100 kΩ: ≤ 33 µA) is inside the ranged row: solved.
    const light = quad(3.3, ['a4', 'b4'], ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
    load(light.b, `${light.u}.y4`, 100_000);
    expect(ok(solve(light.b)).components.U1!.state).toMatchObject({ outputModel: 'ranged' });
  });

  it('logic_output_uncharacterized: beyond 24 mA at 3.0 V (47 Ω)', () => {
    const { b, u } = quad(3.0, ['a1', 'b1'], ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
    load(b, `${u}.y1`, 47);
    expect(fails(solve(b))).toMatchObject({ code: 'logic_output_uncharacterized', param: 'y1' });
  });

  it('logic_feedback_unsupported: a gate into itself, and a loop across two gates of one package', () => {
    const self = quad(3.0, ['b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'], []);
    self.b.wire(`${self.u}.y1`, `${self.u}.a1`);
    expect(fails(solve(self.b))).toMatchObject({
      code: 'logic_feedback_unsupported',
      components: ['U1'],
      detail: { units: ['U1#1'] },
    });
    const loop = quad(3.0, ['b1', 'b2', 'a3', 'b3', 'a4', 'b4'], []);
    loop.b.wire(`${loop.u}.y1`, `${loop.u}.a2`).wire(`${loop.u}.y2`, `${loop.u}.a1`);
    expect(fails(solve(loop.b))).toMatchObject({
      code: 'logic_feedback_unsupported',
      components: ['U1'],
      detail: { units: ['U1#1', 'U1#2'] },
    });
  });

  it('logic_supply_missing: GND pin unconnected', () => {
    const b = new Bench();
    const u = b.add('logic.quad_and');
    b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${u}.vcc`);
    for (const t of ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'])
      b.wire(`${u}.${t}`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject({ code: 'logic_supply_missing', components: ['U1'] });
  });

  it('logic_supply_missing for an L1 single gate too (was re-named logic_unknown_state)', () => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    b.psu(3.0, 0.5)
      .wire('PSU1.negative', 'GND1.ref')
      .wire('PSU1.positive', `${g}.vcc`)
      .wire(`${g}.a`, 'GND1.ref')
      .wire(`${g}.b`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject({ code: 'logic_supply_missing', components: [g] });
  });
});

describe('L2 inspection and the input contract (levels, measured voltages, refusals)', () => {
  /** 1A from a divider 3.0 V · R2/(R1 + R2); 1B tied to `b1`; 1Y into 10 kΩ. */
  function divider(r1: number, r2: number, b1: 'hi' | 'lo') {
    const rest = ['a2', 'b2', 'a3', 'b3', 'a4', 'b4'];
    const { b, u } = quad(3.0, b1 === 'hi' ? ['b1'] : [], b1 === 'lo' ? ['b1', ...rest] : rest);
    if (b1 === 'hi') for (const t of rest) b.wire(`${u}.${t}`, 'GND1.ref');
    const a = b.add('component.resistor');
    const c = b.add('component.resistor');
    b.ohms(a, r1).ohms(c, r2);
    b.wire('PSU1.positive', `${a}.a`).wire(`${a}.b`, `${u}.a1`).wire(`${u}.a1`, `${c}.a`);
    b.wire(`${c}.b`, 'GND1.ref');
    load(b, `${u}.y1`, 10_000);
    return { b, u };
  }

  it('logic_input_undefined: 1.5 V on 1A (between 0.8 V and 2.0 V) is refused by name, never a level', () => {
    // The sheet gives no level and no supply current there (I_CC only with inputs at the rails).
    for (const b1 of ['hi', 'lo'] as const) {
      const { b } = divider(10_000, 10_000, b1);
      expect(fails(solve(b)), b1).toMatchObject({
        code: 'logic_input_undefined',
        components: ['U1'],
        param: 'a1',
        detail: { part: 'SN74LVC08A', value: expect.closeTo(1.5, 9) },
      });
    }
  });

  it('logic_unknown_state: a package input driven from an undetermined (X) single-gate output', () => {
    // An L1 AND gate with A at 1.5 V and B HIGH has an X output; it drives the package's 1A.
    const { b, u } = quad(3.0, ['b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'], []);
    const g = b.add('logic.gate_and');
    const top = b.add('component.resistor');
    const bot = b.add('component.resistor');
    b.ohms(top, 10_000).ohms(bot, 10_000);
    b.wire('PSU1.positive', `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.b`, 'PSU1.positive');
    b.wire('PSU1.positive', `${top}.a`).wire(`${top}.b`, `${g}.a`).wire(`${g}.a`, `${bot}.a`);
    b.wire(`${bot}.b`, 'GND1.ref').wire(`${g}.y`, `${u}.a1`);
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_unknown_state',
      components: [u],
      param: 'a1',
    });
  });

  it('logic_input_out_of_range: an input above the recommended 5.5 V (from a 6 V supply)', () => {
    const { b, u } = quad(3.0, ['a2', 'b2', 'a3', 'b3', 'a4', 'b4', 'b1'], []);
    const p2 = b.add('instrument.lab_psu');
    b.set(p2, 'setpointVoltage', { value: 6, unit: 'volt' })
      .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
      .set(p2, 'outputEnabled', true)
      .wire(`${p2}.negative`, 'GND1.ref')
      .wire(`${p2}.positive`, `${u}.a1`);
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_out_of_range',
      param: 'a1',
      detail: { value: expect.closeTo(6, 9) },
    });
  });

  it('logic_output_uncharacterized: a HIGH output forced above its own V_CC (wrong way)', () => {
    const { b, u } = quad(3.0, ['a1', 'b1'], ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
    const p2 = b.add('instrument.lab_psu');
    const r = b.add('component.resistor');
    b.set(p2, 'setpointVoltage', { value: 3.6, unit: 'volt' })
      .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
      .set(p2, 'outputEnabled', true)
      .wire(`${p2}.negative`, 'GND1.ref')
      .ohms(r, 1000)
      .wire(`${p2}.positive`, `${r}.a`)
      .wire(`${r}.b`, `${u}.y1`);
    expect(fails(solve(b))).toMatchObject({ code: 'logic_output_uncharacterized', param: 'y1' });
  });

  it('I_CC is reported only with every input at a rail; otherwise "not characterized" with ΔI_CC', () => {
    const rails = quad(3.0, ['a1', 'b1'], ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
    expect(ok(solve(rails.b)).components.U1!.state).toMatchObject({ iccMaxA: 10e-6 });
    // 1A at 3.0 · 20k/30k = 2.0 V: a defined HIGH, but not at a rail.
    const mid = divider(10_000, 20_000, 'hi');
    const st = ok(solve(mid.b)).components.U1!.state!;
    expect(st).toMatchObject({ iccCondition: 'notRails', deltaIccA: 500e-6 });
    expect(st.iccMaxA).toBeUndefined();
  });

  it('just inside the thresholds: 2.0 V is HIGH, 0.8 V is LOW (inclusive, as the sheet states)', () => {
    // 3.0 · 20k/(10k + 20k) = 2.0 V; 3.0 · 4k/(11k + 4k) = 0.8 V.
    const hi = divider(10_000, 20_000, 'hi');
    expect(ok(solve(hi.b)).components.U1!.logic!.gates[0]!.inputs[0]!.level).toBe('high');
    const lo = divider(11_000, 4_000, 'hi');
    expect(ok(solve(lo.b)).components.U1!.logic!.gates[0]!.inputs[0]!.level).toBe('low');
  });

  it('single gates (L1) report the same inspection', () => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    b.psu(3.0, 0.5)
      .wire('PSU1.negative', 'GND1.ref')
      .wire('PSU1.positive', `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.a`, 'PSU1.positive')
      .wire(`${g}.b`, 'GND1.ref');
    const r = ok(solve(b)).components[g]!;
    expect(r.logic).toEqual({
      partNumber: 'SN74LVC1G08',
      function: 'and',
      supplyV: 3,
      vih: 2,
      vil: 0.8,
      gates: [
        {
          unit: '',
          inputs: [
            { pin: 'a', level: 'high', volts: 3 },
            { pin: 'b', level: 'low', volts: 0 },
          ],
          output: { pin: 'y', level: 'low', volts: 0 },
        },
      ],
    });
  });
});

describe('SN74LVC08A ratings (§5.1 / §5.4)', () => {
  const base = { vcc: 3, gnd: 0, a1: 0, b1: 0, a2: 0, b2: 0, a3: 0, b3: 0 };
  const term = (extra: Record<string, number>) => ({
    ...base,
    a4: 0,
    b4: 0,
    y1: 0,
    y2: 0,
    y3: 0,
    y4: 0,
    ...extra,
  });
  it('per-output: > 24 mA operating (at 3.0 V), > 50 mA absolute; supply pins > 100 mA absolute', () => {
    expect(packageRatings(C, { terminals: term({}), currents: { y1: 30e-3 } })).toEqual([
      { code: 'current', value: 30e-3, limit: 24e-3, channel: 'y1', kind: 'operating' },
    ]);
    expect(packageRatings(C, { terminals: term({}), currents: { y2: 60e-3 } })).toEqual([
      { code: 'current', value: 60e-3, limit: 50e-3, channel: 'y2' },
    ]);
    expect(packageRatings(C, { terminals: term({}), currents: { vcc: 0.11, gnd: 0.02 } })).toEqual([
      { code: 'current', value: 0.11, limit: 0.1, channel: 'vcc' },
    ]);
  });
  it('inputs: above 5.5 V operating, above 6.5 V absolute; V_CC above 6.5 V; output above V_CC + 0.5 V', () => {
    expect(packageRatings(C, { terminals: term({ b3: 6.0 }) })).toEqual([
      { code: 'voltage', value: 6.0, limit: 5.5, channel: 'b3', kind: 'operating' },
    ]);
    expect(packageRatings(C, { terminals: term({ b3: 7.0 }) })).toEqual([
      { code: 'voltage', value: 7.0, limit: 6.5, channel: 'b3' },
    ]);
    expect(packageRatings(C, { terminals: term({ y4: 3.6 }) })).toEqual([
      { code: 'voltage', value: 3.6, limit: 3.5, channel: 'y4' },
    ]);
    expect(packageRatings(C, { terminals: term({ vcc: 7 }) })[0]).toEqual({
      code: 'voltage',
      value: 7,
      limit: 6.5,
      channel: 'vcc',
    });
  });
});
