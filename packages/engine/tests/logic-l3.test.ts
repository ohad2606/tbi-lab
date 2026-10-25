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

describe('SN74LVC08A in the solve: four gates, one shared supply', () => {
  // Sprint 22 Q1 strict: the SN74LVC08A's I_CC is bounded only at V_CC = 3.6 V with every input
  // at V_CC or GND (SCAS283W §5.7), and the supply's current-limit check needs it: the solve
  // tests run there. At 3.6 V only the ±100 µA point is guaranteed (§5.7: V_OH ≥ V_CC − 0.2 V,
  // V_OL ≤ 0.2 V), so the loads are 100 kΩ: drop = 0.2 V / 100 µA × I = 2 kΩ × I.
  it('each gate its own truth-table row at once (LL, LH, HL, HH) into 100 kΩ at 3.6 V', () => {
    const { b, u } = quad(3.6, ['b2', 'a3', 'a4', 'b4'], ['a1', 'b1', 'a2', 'b3']);
    for (const y of ['y1', 'y2', 'y3', 'y4']) load(b, `${u}.${y}`, 100_000);
    const r = ok(solve(b)).components[u]!;
    // V = 3.6 × 100k / 102k, I = 3.6 / 102 kΩ ≈ 35.3 µA (≤ 100 µA).
    const h = { I: 3.6 / 102_000, V: (3.6 * 100_000) / 102_000 };
    expect(r.logic!.gates.map((g) => g.output.level)).toEqual(['low', 'low', 'low', 'high']);
    expect(r.terminals['y4']!).toBeCloseTo(h.V, 9);
    for (const y of ['y1', 'y2', 'y3']) expect(r.terminals[y]!).toBeCloseTo(0, 9);
    // The shared V_CC pin carries exactly gate 4's source current; PSU1 delivers it.
    expect(r.currents!['y4']).toBeCloseTo(h.I, 12);
    expect(r.currents!.vcc).toBeCloseTo(h.I, 12);
    expect(ok(solve(b)).components.PSU1!.current!).toBeCloseTo(h.I, 12);
  });

  it('all four HIGH into 100 kΩ at 3.6 V: the supply pin carries the SUM (4 × I), out of the solve', () => {
    const ins = ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'];
    const { b, u } = quad(3.6, ins, []);
    for (const y of ['y1', 'y2', 'y3', 'y4']) load(b, `${u}.${y}`, 100_000);
    const o = ok(solve(b));
    const r = o.components[u]!;
    // Sprint 22 Q1 strict (see above): I = 3.6 / 102 kΩ each, V = 3.6 × 100k / 102k.
    const h = { I: 3.6 / 102_000, V: (3.6 * 100_000) / 102_000 };
    for (const y of ['y1', 'y2', 'y3', 'y4']) expect(r.terminals[y]!).toBeCloseTo(h.V, 9);
    expect(r.currents!.vcc).toBeCloseTo(4 * h.I, 12);
    expect(r.currents!.gnd).toBe(0);
    expect(o.components.PSU1!.current!).toBeCloseTo(4 * h.I, 12);
  });

  it('a LOW output sinks through the shared GND pin: V_OL on the (0, 0)–(0.2 V, 100 µA) point at 3.6 V', () => {
    // Sprint 22 Q1 strict: at 3.6 V (the only I_CC row) only the ±100 µA point is guaranteed.
    // 3.6 V → 100 kΩ → 1Y (LOW: 1A tied low): V = 2 kΩ × I, I = 3.6 / 102 kΩ ≈ 35.3 µA.
    // (The 3.0 V segments are checked on the card: outputStageAt above.)
    const { b, u } = quad(3.6, ['a2', 'b2', 'a3', 'b3', 'a4', 'b4'], ['a1', 'b1']);
    const r = b.add('component.resistor');
    b.ohms(r, 100_000).wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${u}.y1`);
    const I = 3.6 / 102_000;
    const res = ok(solve(b)).components[u]!;
    expect(res.terminals['y1']!).toBeCloseTo(2000 * I, 9);
    expect(res.currents!['y1']).toBeCloseTo(-I, 12);
    expect(res.currents!.gnd).toBeCloseTo(I, 12);
  });

  it('the other rows (2.7 V, 1.65 V, 1.8 V): I_CC has no bound off 3.6 V → refused by the current limit (Q1)', () => {
    // Sprint 22 Q1 strict: SCAS283W §5.7 tabulates I_CC only at 3.6 V, so off it PSU1's
    // current-limit check is refused by name (condition notSupply). The refusal is deferred
    // until every level and output check held (here 1Y's guarantee into its load); the output
    // segments of these rows are checked on the card (outputStageAt above).
    const ins = ['a1', 'b1'];
    const rest = ['a2', 'b2', 'a3', 'b3', 'a4', 'b4'];
    for (const [vcc, ohms] of [
      [2.7, 10_000],
      [1.65, 10_000],
      [1.8, 100_000],
    ] as const) {
      const { b, u } = quad(vcc, ins, rest);
      load(b, `${u}.y1`, ohms);
      expect(fails(solve(b)), String(vcc)).toMatchObject({
        code: 'logic_supply_current_uncharacterized',
        components: ['U1', 'PSU1'],
        detail: { part: 'SN74LVC08A', condition: 'notSupply', check: 'limit' },
      });
    }
  });

  it('a chain between gates of the SAME package settles (not feedback): 1Y → 2A', () => {
    // Sprint 21: 2A is held by gate 1's output stage (a non-zero resistance), so its level needs
    // the input leakage bound, which SCAS283W §5.7 gives only at V_CC = 3.6 V (S21-Q2).
    const at30 = quad(3.0, ['a1', 'b1', 'b2', 'a3', 'b3', 'a4', 'b4'], []);
    at30.b.wire(`${at30.u}.y1`, `${at30.u}.a2`);
    load(at30.b, `${at30.u}.y2`, 10_000);
    expect(fails(solve(at30.b))).toMatchObject({
      code: 'logic_input_leakage_uncharacterized',
      param: 'a2',
    });
    // At 3.6 V (±100 µA row only: a 100 kΩ load) the chain settles. Sprint 22 Q1 strict: 2A sits
    // at 1Y, guaranteed only ≥ V_CC − 0.2 V = 3.4 V — not within 1 mV of V_CC — so the package's
    // I_CC leaves its §5.7 test condition and PSU1's current limit is refused by that name, with
    // 2A named (the settle and the level checks ran first: a feedback would be refused before).
    const { b, u } = quad(3.6, ['a1', 'b1', 'b2', 'a3', 'b3', 'a4', 'b4'], []);
    b.wire(`${u}.y1`, `${u}.a2`);
    load(b, `${u}.y2`, 100_000);
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: [u, 'PSU1'],
      param: 'a2',
      detail: { part: 'SN74LVC08A', condition: 'notInputs', check: 'limit' },
    });
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
    // A light load there (100 kΩ: ≤ 33 µA) is inside the ranged row: the output check holds.
    // Sprint 22 Q1 strict: at 3.3 V the I_CC row (3.6 V only) is not met, so PSU1's current
    // limit is refused by name — deferred, i.e. after the output check held.
    const light = quad(3.3, ['a4', 'b4'], ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
    load(light.b, `${light.u}.y4`, 100_000);
    expect(fails(solve(light.b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      detail: { condition: 'notSupply', check: 'limit' },
    });
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

  it('an undefined single-gate input upstream of the package: the ROOT cause is named (Sprint 20)', () => {
    // An L1 AND gate with A at 1.5 V drives the package's 1A. Since Sprint 20 the single gate
    // refuses its own undefined input (no controlling-input inference), and the session names
    // that root cause rather than the package's consequential logic_unknown_state.
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
      code: 'logic_input_undefined',
      components: [g],
      param: 'a',
      detail: { part: 'SN74LVC1G08', vcc: 3, vih: 2, vil: 0.8, value: expect.closeTo(1.5, 9) },
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

  it('I_CC only under its §5.7 test conditions (V_CC = 3.6 V, every input at V_CC or GND); else not characterized', () => {
    // §5.7: "I_CC | V_I = V_CC or GND, I_O = 0 | 3.6V | 10 µA" — tabulated at 3.6 V only.
    const at36 = quad(3.6, ['a1', 'b1'], ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
    expect(ok(solve(at36.b)).components.U1!.state).toMatchObject({ iccMaxA: 10e-6 });
    // At 3.0 V with every input at a rail: the row's supply is not met. Sprint 22 Q1 strict: the
    // unbounded I_CC refuses PSU1's current limit by name (never ΔI_CC as a bound).
    const rails = quad(3.0, ['a1', 'b1'], ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
    expect(fails(solve(rails.b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: ['U1', 'PSU1'],
      detail: { condition: 'notSupply', check: 'limit' },
    });
    // 1A at 3.0 · 20k/30k = 2.0 V from a divider: Sprint 21, held through a resistance at 3.0 V
    // where the input leakage has no bound: refused before anything is reported.
    const mid = divider(10_000, 20_000, 'hi');
    expect(fails(solve(mid.b)).code).toBe('logic_input_leakage_uncharacterized');
    // At 1.8 V (rows 1.65–1.95 V): no I_CC either → refused likewise (Sprint 22 Q1 strict).
    const low = quad(1.8, ['a1', 'b1'], ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
    expect(fails(solve(low.b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      detail: { condition: 'notSupply', check: 'limit' },
    });
  });

  it('just inside the thresholds: 2.0 V is HIGH, 0.8 V is LOW (inclusive, as the sheet states)', () => {
    // Sprint 21: from a second supply wired straight to 1A (no resistance, so no leakage error:
    // exactly 2.0 V / 0.8 V). A divider would put a resistance there, and at exactly the
    // threshold the ±5 µA leakage bound would make the level not guaranteed.
    for (const [v, level] of [
      [2.0, 'high'],
      [0.8, 'low'],
    ] as const) {
      const { b, u } = quad(3.0, ['b1'], ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
      const p2 = b.add('instrument.lab_psu');
      b.set(p2, 'setpointVoltage', { value: v, unit: 'volt' })
        .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
        .set(p2, 'outputEnabled', true)
        .wire(`${p2}.negative`, 'GND1.ref')
        .wire(`${p2}.positive`, `${u}.a1`);
      // Sprint 22 Q1 strict: 1A at 2.0 V / 0.8 V (not V_CC or GND) and V_CC = 3.0 V leave the I_CC
      // test condition, so PSU1's current limit is refused by name. That refusal is deferred
      // until every level check held: 1A's level at the threshold itself held (inclusive) —
      // otherwise logic_input_undefined / not_guaranteed would come first.
      expect(fails(solve(b)), level).toMatchObject({
        code: 'logic_supply_current_uncharacterized',
        detail: { check: 'limit' },
      });
    }
  });

  it('single gates (L1) report the same inspection', () => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    b.psu(3.0, 0.5)
      .wire('PSU1.negative', 'GND1.ref')
      .wire('PSU1.positive', `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      // Sprint 22 Q1 strict: A HIGH at 5.5 V (PSU2), the 1G's I_CC test voltage (§5.5).
      .wire(`${g}.a`, `${b.rail(5.5)}.positive`)
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
            { pin: 'a', level: 'high', volts: 5.5 },
            { pin: 'b', level: 'low', volts: 0 },
          ],
          // Sprint 21: the datasheet guarantee at its (zero) current: V_OL ≤ 0.1 V up to 100 µA.
          output: { pin: 'y', level: 'low', volts: 0, guarantee: { volts: 0.1, atA: 100e-6 } },
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
