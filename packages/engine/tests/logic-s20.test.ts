/**
 * Sprint 20 (logic): independent validation of the L1 single gates (SN74LVC1G08/00/32/04, TI
 * SCES217AA/SCES212AC/SCES219W/SCES214AF) and the L3 package (SN74LVC08A, TI SCAS283W) against
 * the datasheets, and the owner-approved policies:
 * - an undriven gate input never silently becomes a valid LOW (the ESP32 input pad's leakage
 *   model; open switches; supplies switched off; unpowered drivers);
 * - mixed 3.3 V / 5 V operation decided strictly by V_IH at the gate's own supply;
 * - cascades inside one package and between packages;
 * - the quiescent current only under the datasheet's own I_CC test conditions.
 * Expected numbers are computed by hand from the datasheet figures, not read back.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  LVC08A_CARD,
  LVC1G_CARDS,
  quiescentAt,
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
const solve = (b: Bench) => new EngineSession(b.snapshot()).solve();
const AND = LVC1G_CARDS['model.logic.sn74lvc1g08']!;

/**
 * PSU1 at `vcc` → an SN74LVC1G08 (U1) with B tied HIGH and Y into 10 kΩ; A left to `build`.
 * Sprint 22 Q1 strict: HIGH is 5.5 V from a second supply (`hi`), the I_CC test voltage
 * "V_I = 5.5V or GND" (SCES217AA §5.5), so PSU1's current-limit check has a bounded I_CC.
 */
function andGate(vcc: number, build: (b: Bench, g: string, hi: string) => void) {
  const b = new Bench();
  const g = b.add('logic.gate_and');
  const r = b.add('component.resistor');
  b.psu(vcc, 0.5).ohms(r, 10_000).wire('PSU1.negative', 'GND1.ref');
  const hi = b.rail(5.5);
  b.wire('PSU1.positive', `${g}.vcc`)
    .wire(`${g}.gnd`, 'GND1.ref')
    .wire(`${g}.b`, `${hi}.positive`)
    .wire(`${g}.y`, `${r}.a`)
    .wire(`${r}.b`, 'GND1.ref');
  build(b, g, hi);
  return { b, g };
}
/** Sprint 22 Q1 strict: the deferred refusal — every level/output check held, I_CC unbounded. */
const limitOnly = { code: 'logic_supply_current_uncharacterized', detail: { check: 'limit' } };

/** PSU1 at `vcc` → SN74LVC08A U1, every input tied to GND except those `build` wires. */
function quad(vcc: number, free: string[], build: (b: Bench, u: string) => void, extra?: string) {
  const b = new Bench();
  const u = b.add('logic.quad_and');
  b.psu(vcc, 0.5)
    .wire('PSU1.negative', 'GND1.ref')
    .wire('PSU1.positive', `${u}.vcc`)
    .wire(`${u}.gnd`, 'GND1.ref');
  for (const t of LVC08A_CARD.inputs) if (!free.includes(t)) b.wire(`${u}.${t}`, 'GND1.ref');
  void extra;
  build(b, u);
  return { b, u };
}

describe('undriven inputs are floating, never a valid LOW (owner policy)', () => {
  it('ESP32 pad in INPUT mode alone on a gate input: refused, naming the pad (L1 and package)', () => {
    let G = '';
    const bb = boardBench((b, u) => {
      G = b.add('logic.gate_and');
      b.psu(3.0, 0.5);
      const hi = b.rail(5.5);
      b.wire('PSU1.positive', `${G}.vcc`)
        .wire(`${G}.gnd`, 'GND1.ref')
        .wire(`${G}.b`, `${hi}.positive`)
        .wire(`${u}.gpio18`, `${G}.a`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    // Before the firmware's setup() runs every pad is an input: the gate input floats.
    expect(fails(s.solve())).toMatchObject({
      code: 'logic_input_floating',
      param: 'a',
      detail: { pads: [18] },
    });
    // Driven, A is no longer floating. Sprint 22 Q1 strict: an ESP32 HIGH (≤ 3.3 V) is not 5.5 V,
    // its LOW (≤ 0.33 V guaranteed) not GND: I_CC is unbounded and PSU1's current limit is
    // refused by name — after the level checks held (HIGH: V_OH 2.64 V ≥ V_IH 2.0 V).
    s.setPinMode(18, 'output-high');
    expect(fails(s.solve())).toMatchObject({ ...limitOnly, components: [G, 'PSU1'] });
    s.setPinMode(18, 'output-low');
    expect(fails(s.solve())).toMatchObject({
      ...limitOnly,
      components: [G],
      param: 'a',
      detail: { check: 'limit', causes: expect.arrayContaining(['esp32_vol']) },
    });
  });

  it('two input-mode pads and a resistor between them and the gate: still floating (no driver anywhere)', () => {
    let Q = '';
    const bb = boardBench((b, u) => {
      const q = b.add('logic.quad_and');
      Q = q;
      const r = b.add('component.resistor');
      // Sprint 21: 3.6 V, where SCAS283W §5.7 specifies I_I (needed for the 1 kΩ + pad path).
      b.psu(3.6, 0.5).ohms(r, 1000).wire('PSU1.positive', `${q}.vcc`).wire(`${q}.gnd`, 'GND1.ref');
      for (const t of LVC08A_CARD.inputs.filter((t) => t !== 'a1')) b.wire(`${q}.${t}`, 'GND1.ref');
      b.wire(`${u}.gpio18`, `${r}.a`).wire(`${u}.gpio19`, `${r}.a`).wire(`${r}.b`, `${q}.a1`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    expect(fails(s.solve())).toMatchObject({
      code: 'logic_input_floating',
      components: [Q],
      param: 'a1',
      detail: { part: 'SN74LVC08A', pads: [18, 19] },
    });
    // One pad driving: the node is driven (no longer floating). Sprint 22 Q1 strict: 1A at the
    // pad's ≤ 3.3 V is not V_CC = 3.6 V, so the package's I_CC (§5.7) is unbounded: PSU1's
    // current limit is refused by name, after 1A's HIGH level held (V_OH 2.64 V ≥ V_IH 2.0 V).
    s.setPinMode(19, 'output-high');
    expect(fails(s.solve())).toMatchObject({ ...limitOnly, components: [Q, 'PSU1'] });
  });

  it('an input-mode pad WITH an external 10 kΩ pull-down (§7.3.3: "a 10kΩ resistor … is recommended"): a real LOW', () => {
    let G = '';
    const bb = boardBench((b, u) => {
      G = b.add('logic.gate_and');
      const pd = b.add('component.resistor');
      b.psu(3.0, 0.5).ohms(pd, 10_000);
      const hi = b.rail(5.5);
      b.wire('PSU1.positive', `${G}.vcc`)
        .wire(`${G}.gnd`, 'GND1.ref')
        .wire(`${G}.b`, `${hi}.positive`)
        .wire(`${u}.gpio18`, `${G}.a`)
        .wire(`${G}.a`, `${pd}.a`)
        .wire(`${pd}.b`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    // A real LOW (the input check held: 5 µA × 10 kΩ + the pad's leakage ≈ 50 mV ≤ V_IL 0.8 V).
    // Sprint 22 Q1 strict: ~50 mV is not within 1 mV of GND, so I_CC leaves its test condition
    // and PSU1's current limit is refused by name (naming A, worst ≈ 50.5 mV).
    expect(fails(s.solve())).toMatchObject({
      ...limitOnly,
      components: [G],
      param: 'a',
      detail: { check: 'limit', condition: 'notInputs', worst: expect.closeTo(0.0505, 3) },
    });
    // Driven HIGH, the pad also feeds the pull-down (≈ 330 µA). Sprint 21 review (item 5): the
    // ESP32's V_OH ≥ 0.8 × VDD is stated with no load current (Table 5-3; 40 mA is typical), so it
    // is relied on only at leakage-level current: refused by name, never a HIGH under that load.
    s.setPinMode(18, 'output-high');
    expect(fails(s.solve())).toMatchObject({
      code: 'logic_mcu_output_uncharacterized',
      param: 'gpio18',
      detail: { gpio: 18, level: 'high' },
    });
  });

  it('an open switch is not a driver: the input it would connect floats (refused, never LOW)', () => {
    const { b, g } = andGate(3.0, (bb, gg, hi) => {
      const sw = bb.add('component.toggle_switch');
      // Sprint 22 Q1 strict: the switch takes HIGH from the 5.5 V rail.
      bb.set(sw, 'closed', false).wire(`${hi}.positive`, `${sw}.a`).wire(`${sw}.b`, `${gg}.a`);
    });
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_floating',
      components: [g],
      param: 'a',
    });
    b.set('SW1', 'closed', true);
    expect(ok(solve(b)).components[g]!.state).toMatchObject({ input_a: 'high' });
  });

  it('a supply switched off is not a driver: the input on its output floats', () => {
    let P = '';
    const { b, g } = andGate(3.0, (bb, gg) => {
      const p2 = bb.add('instrument.lab_psu');
      P = p2;
      // Sprint 22 Q1 strict: 5.5 V when on (the I_CC test voltage).
      bb.set(p2, 'setpointVoltage', { value: 5.5, unit: 'volt' })
        .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
        .set(p2, 'outputEnabled', false)
        .wire(`${p2}.negative`, 'GND1.ref')
        .wire(`${p2}.positive`, `${gg}.a`);
    });
    expect(fails(solve(b))).toMatchObject({ code: 'logic_input_floating', param: 'a' });
    b.set(P, 'outputEnabled', true);
    expect(ok(solve(b)).components[g]!.state).toMatchObject({ input_a: 'high' });
  });

  it('an unpowered single gate (I_off: outputs disabled, §7.3.2) drives nothing: the input it feeds floats', () => {
    // U2 (inverter) on its own supply PSU2 at 0 V; its Y feeds U1's A.
    const { b, g } = andGate(3.0, (bb, gg) => {
      const n = bb.add('logic.gate_not');
      const p2 = bb.add('instrument.lab_psu');
      bb.set(p2, 'setpointVoltage', { value: 0, unit: 'volt' })
        .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
        .set(p2, 'outputEnabled', true)
        .wire(`${p2}.negative`, 'GND1.ref')
        .wire(`${p2}.positive`, `${n}.vcc`)
        .wire(`${n}.gnd`, 'GND1.ref')
        .wire(`${n}.a`, 'GND1.ref')
        .wire(`${n}.y`, `${gg}.a`);
    });
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_floating',
      components: [g],
      param: 'a',
    });
  });

  it('a gate input with nothing on its net but other gate inputs: floating', () => {
    const { b } = andGate(3.0, (bb, gg) => {
      const n = bb.add('logic.gate_not');
      bb.wire(`${n}.vcc`, 'PSU1.positive').wire(`${n}.gnd`, 'GND1.ref').wire(`${n}.a`, `${gg}.a`);
    });
    expect(fails(solve(b)).code).toBe('logic_input_floating');
  });
});

describe("mixed 3.3 V / 5 V: decided by V_IH at the gate's own supply (§5.3)", () => {
  /** ESP32 GPIO18 → SN74LVC1G08 A at `vcc` (B tied HIGH, Y into 10 kΩ). */
  const esp = (vcc: number) => {
    let G = '';
    const bb = boardBench((b, u) => {
      G = b.add('logic.gate_and');
      const r = b.add('component.resistor');
      b.psu(vcc, 0.5).ohms(r, 10_000);
      // Sprint 22 Q1 strict: B at 5.5 V, the I_CC test voltage (§5.5).
      const hi = b.rail(5.5);
      b.wire('PSU1.positive', `${G}.vcc`)
        .wire(`${G}.gnd`, 'GND1.ref')
        .wire(`${G}.b`, `${hi}.positive`)
        .wire(`${u}.gpio18`, `${G}.a`)
        .wire(`${G}.y`, `${r}.a`)
        .wire(`${r}.b`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(18, 'output-high');
    return { s, G };
  };

  it('3.3 V GPIO HIGH into the gate at 5.0 V: V_IH = 0.7 × 5.0 = 3.5 V > 3.3 V: refused as undefined', () => {
    const { s, G } = esp(5.0);
    expect(fails(s.solve())).toEqual({
      code: 'logic_input_undefined',
      components: [G],
      param: 'a',
      detail: {
        part: 'SN74LVC1G08',
        value: expect.closeTo(3.3, 9),
        vcc: 5,
        vih: expect.closeTo(3.5, 12),
        vil: expect.closeTo(1.5, 12),
        // Sprint 21: the ESP32 output that drives it, and its guaranteed V_OH (0.8 × VDD).
        pads: [18],
        padVoh: expect.closeTo(2.64, 12),
      },
    });
    // The pad's LOW (≤ 0.33 V) is a valid LOW at 5 V (V_IL = 1.5 V): not refused as undefined.
    // Sprint 22 Q1 strict: but not exactly GND, so I_CC is unbounded: refused by the limit.
    s.setPinMode(18, 'output-low');
    expect(fails(s.solve())).toMatchObject({ ...limitOnly, components: [G], param: 'a' });
  });

  it("at 4.5 V, V_IH = 3.15 V: the pad model's 3.3 V passes, but the ESP32 guarantees only V_OH ≥ 2.64 V: refused (Sprint 21)", () => {
    const { s, G } = esp(4.5);
    expect(fails(s.solve())).toMatchObject({
      code: 'logic_input_not_guaranteed',
      components: [G],
      param: 'a',
      detail: { level: 'high', pads: [18] },
    });
    expect(inputThreshold(4.5)).toBeCloseTo(3.15, 12);
  });

  it('the SN74LVC08A cannot run at 5 V at all (operating 1.65–3.6 V, §5.4): refused by its supply', () => {
    const { b } = quad(5.0, [], () => {});
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_supply_uncharacterized',
      detail: { vcc: 5 },
    });
  });

  it('5 V inputs into the SN74LVC08A at 3.0 V are within V_I 0–5.5 V (5.5 V tolerant, §5.4/§7.3.4): HIGH', () => {
    const { b, u } = quad(3.0, ['a1', 'b1'], (bb, uu) => {
      const p2 = bb.add('instrument.lab_psu');
      bb.set(p2, 'setpointVoltage', { value: 5, unit: 'volt' })
        .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
        .set(p2, 'outputEnabled', true)
        .wire(`${p2}.negative`, 'GND1.ref')
        .wire(`${p2}.positive`, `${uu}.a1`)
        .wire(`${uu}.b1`, `${p2}.positive`);
    });
    // 5 V is inside V_I 0–5.5 V (no logic_input_out_of_range) and a valid HIGH. Sprint 22 Q1
    // strict: at 3.0 V the package's I_CC (3.6 V only, §5.7) has no bound, so PSU1's current
    // limit is refused by name — deferred, i.e. after every level check held.
    expect(fails(solve(b))).toMatchObject({
      ...limitOnly,
      components: [u, 'PSU1'],
      detail: { check: 'limit', condition: 'notSupply' },
    });
  });

  it('a gate at 5 V driving an ESP32 input: the pad is over its specified range (warning, absolute)', () => {
    let G = '';
    const bb = boardBench((b, u) => {
      G = b.add('logic.gate_and');
      b.psu(5.0, 0.5);
      // Sprint 22 Q1 strict: A and B at 5.5 V (the I_CC test voltage, §5.5).
      const hi = b.rail(5.5);
      b.wire('PSU1.positive', `${G}.vcc`)
        .wire(`${G}.gnd`, 'GND1.ref')
        .wire(`${G}.a`, `${hi}.positive`)
        .wire(`${G}.b`, `${hi}.positive`)
        .wire(`${G}.y`, `${u}.gpio4`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    const o = ok(s.solve());
    expect(o.components[G]!.state).toMatchObject({ gateOutput: 'high' });
    const pad = o.pins!.find((p) => p.gpio === 4)!;
    expect(pad.voltage).toBeGreaterThan(3.6);
  });
});

const inputThreshold = (vcc: number) => {
  const row = AND.inputRows.find((r) => vcc >= r.vcc[0] && vcc <= r.vcc[1])!;
  return 'k' in row.vih ? row.vih.k * vcc : row.vih.v;
};

describe('cascades: inside a package and between packages', () => {
  it('SN74LVC08A gate 1 → a SECOND SN74LVC08A gate 1, and an SN74LVC1G08 → the package: truth tables through the solve', () => {
    for (let m = 0; m < 8; m++) {
      const [x, y, z] = [m & 4, m & 2, m & 1].map(Boolean) as [boolean, boolean, boolean];
      const b = new Bench();
      const u1 = b.add('logic.quad_and');
      const u2 = b.add('logic.quad_and');
      const g = b.add('logic.gate_and');
      // Sprint 21: 3.6 V, where SCAS283W §5.7 specifies I_I (each chained input is held by an
      // output stage, a non-zero resistance; at 3.0 V that is refused, owner question S21-Q2).
      b.psu(3.6, 0.5).wire('PSU1.negative', 'GND1.ref');
      for (const p of [u1, u2, g]) b.wire('PSU1.positive', `${p}.vcc`).wire(`${p}.gnd`, 'GND1.ref');
      const lv = (on: boolean) => (on ? 'PSU1.positive' : 'GND1.ref');
      // Y = (x·y) [U1 gate 1] · z [U2 gate 1]; U2 gate 2 = Y · (single gate: x·z).
      b.wire(`${u1}.a1`, lv(x)).wire(`${u1}.b1`, lv(y)).wire(`${u1}.y1`, `${u2}.a1`);
      b.wire(`${u2}.b1`, lv(z));
      b.wire(`${g}.a`, lv(x)).wire(`${g}.b`, lv(z)).wire(`${g}.y`, `${u2}.b2`);
      b.wire(`${u2}.y1`, `${u2}.a2`);
      for (const t of ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']) b.wire(`${u1}.${t}`, 'GND1.ref');
      for (const t of ['a3', 'b3', 'a4', 'b4']) b.wire(`${u2}.${t}`, 'GND1.ref');
      // Sprint 22 Q1 strict: each chained input sits at a gate output (guaranteed only within
      // V_OH/V_OL's band, never within 1 mV of V_CC or GND), and the single gate's inputs are at
      // 3.6 V, not 5.5 V: I_CC leaves its test conditions. Every combination settles and its
      // level checks hold, then PSU1's current limit is refused by name (never feedback).
      expect(fails(solve(b)), `x=${x} y=${y} z=${z}`).toMatchObject(limitOnly);
    }
  });

  it('a loop across two packages is feedback: refused', () => {
    const b = new Bench();
    const u1 = b.add('logic.quad_and');
    const u2 = b.add('logic.quad_and');
    b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref');
    for (const p of [u1, u2]) b.wire('PSU1.positive', `${p}.vcc`).wire(`${p}.gnd`, 'GND1.ref');
    b.wire(`${u1}.y1`, `${u2}.a1`).wire(`${u2}.y1`, `${u1}.a1`);
    b.wire(`${u1}.b1`, 'PSU1.positive').wire(`${u2}.b1`, 'PSU1.positive');
    for (const p of [u1, u2])
      for (const t of ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']) b.wire(`${p}.${t}`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_feedback_unsupported',
      components: [u1, u2],
    });
  });
});

describe('quiescent current: only under the datasheet I_CC test conditions', () => {
  it('SN74LVC1G: I_CC "V_I = 5.5V or GND, 1.65V to 5.5V" (§5.5); ΔI_CC only 3–5.5 V', () => {
    expect(quiescentAt(AND, 3.0, [0, 0])).toEqual({ iccMaxA: 10e-6 });
    expect(quiescentAt(AND, 5.5, [5.5, 0])).toEqual({ iccMaxA: 10e-6 });
    expect(quiescentAt(AND, 3.0, [5.5, 0])).toEqual({ iccMaxA: 10e-6 });
    // An input HIGH at V_CC = 3.0 V is not the test condition (5.5 V): not characterized.
    expect(quiescentAt(AND, 3.0, [3.0, 0])).toEqual({
      iccCondition: 'notInputs',
      deltaIccA: 500e-6,
    });
    // At 2.5 V: no ΔI_CC row either.
    expect(quiescentAt(AND, 2.5, [2.5, 0])).toEqual({ iccCondition: 'notInputs' });
    expect(quiescentAt(AND, null, [0, 0])).toEqual({ iccCondition: 'notSupply' });
  });

  it('in the solve: inputs at GND or 5.5 V → I_CC ≤ 10 µA reported; an input at V_CC → refused (Q1)', () => {
    // andGate ties B to 5.5 V (Sprint 22): the test condition holds.
    const lowIn = andGate(3.0, (bb, gg) => bb.wire(`${gg}.a`, 'GND1.ref'));
    expect(ok(solve(lowIn.b)).components[lowIn.g]!.state).toMatchObject({ iccMaxA: 10e-6 });
    // B at V_CC = 3.0 V instead: not the test condition; Sprint 22 Q1 strict: PSU1's current limit
    // depends on that unbounded I_CC → refused by name (never ΔI_CC as a bound).
    const atVcc = new Bench();
    const h = atVcc.add('logic.gate_and');
    atVcc
      .psu(3.0, 0.5)
      .wire('PSU1.negative', 'GND1.ref')
      .wire('PSU1.positive', `${h}.vcc`)
      .wire(`${h}.gnd`, 'GND1.ref')
      .wire(`${h}.a`, 'GND1.ref')
      .wire(`${h}.b`, 'PSU1.positive');
    expect(fails(solve(atVcc))).toMatchObject({
      ...limitOnly,
      components: [h, 'PSU1'],
      detail: { check: 'limit', condition: 'notInputs' },
    });
    const b = new Bench();
    const g = b.add('logic.gate_and');
    b.psu(3.0, 0.5)
      .wire('PSU1.negative', 'GND1.ref')
      .wire('PSU1.positive', `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.a`, 'GND1.ref')
      .wire(`${g}.b`, 'GND1.ref');
    expect(ok(solve(b)).components[g]!.state).toMatchObject({ iccMaxA: 10e-6 });
  });
});

describe('single gates: the input contract matches the package', () => {
  it('logic_input_out_of_range: an input above the recommended 5.5 V (§5.3 V_I 0–5.5 V)', () => {
    const { b, g } = andGate(3.0, (bb, gg) => {
      const p2 = bb.add('instrument.lab_psu');
      bb.set(p2, 'setpointVoltage', { value: 6, unit: 'volt' })
        .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
        .set(p2, 'outputEnabled', true)
        .wire(`${p2}.negative`, 'GND1.ref')
        .wire(`${p2}.positive`, `${gg}.a`);
    });
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_out_of_range',
      components: [g],
      param: 'a',
      detail: { value: expect.closeTo(6, 9), vcc: 3 },
    });
  });

  it('PM-1 class supply (3.3 V): an LED-class load inside the class bound raises no operating warning', () => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    const r = b.add('component.resistor');
    const d = b.add('component.led');
    b.psu(3.3, 0.5).ohms(r, 220).wire('PSU1.negative', 'GND1.ref');
    // Sprint 22 Q1 strict: A and B at 5.5 V (the I_CC test voltage, §5.5).
    const hi = b.rail(5.5);
    b.wire('PSU1.positive', `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.a`, `${hi}.positive`)
      .wire(`${g}.b`, `${hi}.positive`)
      .wire(`${g}.y`, `${r}.a`)
      .wire(`${r}.b`, `${d}.anode`)
      .wire(`${d}.cathode`, 'GND1.ref');
    const o = ok(solve(b));
    expect(o.components[g]!.state).toMatchObject({ outputModel: 'class' });
    expect(o.components[g]!.currents!.y!).toBeGreaterThan(1e-3);
    expect(ratingWarnings(b.snapshot(), o).filter((w) => w.component === g)).toEqual([]);
  });
});
