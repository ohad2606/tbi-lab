/**
 * Sprint 21 Phase 3 (logic power and input modelling): guarantee bounds (logic/bounds.ts).
 * Every expected number is hand-computed from the cited datasheet rows:
 * - SN74LVC1G08 SCES217AA §5.3 (V_IH/V_IL), §5.5 (I_I ±5 µA "V_I = 5.5V or GND", V_CC 0–5.5 V;
 *   I_CC 10 µA "V_I = 5.5V or GND, I_O = 0", 1.65–5.5 V; V_OH ≥ V_CC − 0.1 V at −100 µA);
 * - SN74LVC08A SCAS283W §5.7 (I_I ±5 µA only at V_CC = 3.6 V; I_CC only at 3.6 V);
 * - ESP32 Series Datasheet v5.3 Table 5-3 (V_OH ≥ 0.8 × VDD = 2.64 V, V_OL ≤ 0.1 × VDD).
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  LVC08A_CARD,
  LVC1G_CARDS,
  outputGuaranteeAt,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench, boardBench } from './build.js';

const solve = (b: Bench) => new EngineSession(b.snapshot()).solve();
const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};
const fails = (o: SolveOutcome) => {
  if (o.ok) throw new Error('expected a refusal');
  return o.error;
};
const G08 = LVC1G_CARDS['model.logic.sn74lvc1g08']!;

/** SN74LVC1G08 with its V_CC through `rSeries` Ω (0 = straight to PSU+); inputs wired by `wire`. */
function gate(
  vcc: number,
  rSeries: number,
  wire: (b: Bench, g: string, rail: string) => void,
): { b: Bench; g: string; rail: string } {
  const b = new Bench();
  const g = b.add('logic.gate_and');
  b.psu(vcc, 0.1).wire('PSU1.negative', 'GND1.ref');
  let rail = 'PSU1.positive';
  if (rSeries > 0) {
    const r = b.add('component.resistor');
    b.ohms(r, rSeries).wire('PSU1.positive', `${r}.a`);
    rail = `${r}.b`;
  }
  b.wire(rail, `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  wire(b, g, rail);
  return { b, g, rail };
}

describe('Task 1: supply current through a series resistance', () => {
  it('straight from the PSU (CV): I_CC cannot move V_CC; inputs at V_CC are fine (no series element)', () => {
    const { b, g } = gate(3.3, 0, (b, g) =>
      b.wire(`${g}.a`, 'PSU1.positive').wire(`${g}.b`, 'PSU1.positive'),
    );
    const o = ok(solve(b));
    expect(o.components[g]!.state).toMatchObject({ gateOutput: 'high', supplyV: 3.3 });
  });

  it('through 10 Ω with the inputs at V_CC: I_CC is not characterized there (V_I = 5.5 V or GND) → refused', () => {
    const { b, g } = gate(5, 10, (b, g, rail) => b.wire(`${g}.a`, rail).wire(`${g}.b`, rail));
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: [g],
      param: 'vcc',
      detail: { part: 'SN74LVC1G08', condition: 'notInputs' },
    });
  });

  it('through 10 Ω at 3.3 V with both inputs at GND: I_CC ≤ 10 µA (+2 × 5 µA I_I) moves V_CC by ≤ 0.2 mV: guaranteed', () => {
    const { b, g } = gate(3.3, 10, (b, g) =>
      b.wire(`${g}.a`, 'GND1.ref').wire(`${g}.b`, 'GND1.ref'),
    );
    const o = ok(solve(b));
    expect(o.components[g]!.state).toMatchObject({ gateOutput: 'low', iccMaxA: 10e-6 });
  });

  it('through 100 kΩ, inputs at GND: (10 + 10) µA × 100 kΩ = 2 V → V_CC can fall to 1.3 V, below the 3.0–3.6 V row → refused', () => {
    const { b, g } = gate(3.3, 100_000, (b, g) =>
      b.wire(`${g}.a`, 'GND1.ref').wire(`${g}.b`, 'GND1.ref'),
    );
    const e = fails(solve(b));
    expect(e).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      components: [g],
      param: 'vcc',
      detail: { part: 'SN74LVC1G08', vcc: 3.3, causes: ['supply_current'] },
    });
    expect((e.detail as { worst: number }).worst).toBeCloseTo(3.3 - 20e-6 * 100_000, 6);
  });

  it('exactly 3.0 V through 10 Ω: any supply current takes V_CC below the 3.0 V row → refused', () => {
    const { b, g } = gate(3.0, 10, (b, g) =>
      b.wire(`${g}.a`, 'GND1.ref').wire(`${g}.b`, 'GND1.ref'),
    );
    expect(fails(solve(b))).toMatchObject({ code: 'logic_supply_not_guaranteed', components: [g] });
  });

  it('the output load current flows through the series element in the solve (LOW sinking from a pull-up)', () => {
    // 3.6 V through 1 Ω; Y LOW sinks (3.6 − V_Y)/36 kΩ ≈ 100 µA from PSU+: V_CC unaffected (GND side).
    const { b, g } = gate(3.6, 1, (b, g) => {
      const r = b.add('component.resistor');
      b.ohms(r, 360_000).wire(`${g}.a`, 'GND1.ref').wire(`${g}.b`, 'GND1.ref');
      b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${g}.y`);
    });
    const o = ok(solve(b));
    expect(o.components[g]!.state).toMatchObject({ gateOutput: 'low' });
  });
});

describe('Task 2: input leakage and pull resistors (I_I ±5 µA)', () => {
  /** Input A pulled down (or up) by `r`, input B tied HIGH, at 3.3 V straight from the PSU. */
  const pull = (r: number, up: boolean) =>
    gate(3.3, 0, (b, g) => {
      const p = b.add('component.resistor');
      b.ohms(p, r)
        .wire(`${g}.a`, `${p}.a`)
        .wire(`${p}.b`, up ? 'PSU1.positive' : 'GND1.ref')
        .wire(`${g}.b`, 'PSU1.positive');
    });

  it('10 kΩ pull-down: 5 µA × 10 kΩ = 50 mV ≤ V_IL 0.8 V: LOW is guaranteed', () => {
    const { b, g } = pull(10_000, false);
    expect(ok(solve(b)).components[g]!.state).toMatchObject({ input_a: 'low' });
  });

  it('150 kΩ pull-down: 0.75 V ≤ 0.8 V: guaranteed; 170 kΩ: 0.85 V > 0.8 V: refused (the solve alone says 0 V LOW)', () => {
    expect(ok(solve(pull(150_000, false).b)).ok).toBe(true);
    const { b, g } = pull(170_000, false);
    const e = fails(solve(b));
    expect(e).toMatchObject({
      code: 'logic_input_not_guaranteed',
      components: [g],
      param: 'a',
      detail: { part: 'SN74LVC1G08', level: 'low', vil: 0.8, causes: ['leakage'] },
    });
    expect((e.detail as { worst: number }).worst).toBeCloseTo(5e-6 * 170_000, 6);
    expect((e.detail as { value: number }).value).toBeCloseTo(0, 12);
  });

  it('pull-up to 3.3 V: 250 kΩ → 3.3 − 1.25 = 2.05 V ≥ V_IH 2.0 V; 300 kΩ → 1.8 V: refused', () => {
    expect(ok(solve(pull(250_000, true).b)).ok).toBe(true);
    const e = fails(solve(pull(300_000, true).b));
    expect(e).toMatchObject({ code: 'logic_input_not_guaranteed', detail: { level: 'high' } });
    expect((e.detail as { worst: number }).worst).toBeCloseTo(3.3 - 1.5, 6);
  });

  it('a 10 MΩ pull-down (the review case): refused, never a valid LOW', () => {
    expect(fails(solve(pull(10e6, false).b)).code).toBe('logic_input_not_guaranteed');
  });

  /** SN74LVC08A at `vcc`: 1A through 10 kΩ to GND, every other input tied to GND. */
  const quad = (vcc: number, viaR: boolean) => {
    const b = new Bench();
    const u = b.add('logic.quad_and');
    b.psu(vcc, 0.1).wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${u}.vcc`);
    b.wire(`${u}.gnd`, 'GND1.ref');
    for (const t of LVC08A_CARD.inputs) if (t !== 'a1') b.wire(`${u}.${t}`, 'GND1.ref');
    if (viaR) {
      const r = b.add('component.resistor');
      b.ohms(r, 10_000).wire(`${u}.a1`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    } else b.wire(`${u}.a1`, 'GND1.ref');
    return { b, u };
  };

  it('SN74LVC08A: I_I is tabulated only at V_CC = 3.6 V: at 3.0 V an input held through 10 kΩ is refused', () => {
    expect(LVC08A_CARD.iiVcc).toEqual([3.6, 3.6]);
    const { b, u } = quad(3.0, true);
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_leakage_uncharacterized',
      components: [u],
      param: 'a1',
      detail: { part: 'SN74LVC08A', vcc: 3, iiVcc: [3.6, 3.6] },
    });
  });

  it('SN74LVC08A at 3.0 V with every input tied straight to GND: no resistance, nothing to bound: runs', () => {
    expect(ok(solve(quad(3.0, false).b)).ok).toBe(true);
  });

  it('SN74LVC08A at 3.6 V (the I_I row): the 10 kΩ pull-down is bounded (50 mV) and runs', () => {
    expect(ok(solve(quad(3.6, true).b)).ok).toBe(true);
  });
});

describe('Task 4: ESP32 output into a gate: guaranteed V_OH 2.64 V / V_OL 0.33 V', () => {
  const esp = (vcc: number) => {
    let G = '';
    const bb = boardBench((b, u) => {
      G = b.add('logic.gate_and');
      const r = b.add('component.resistor');
      b.psu(vcc, 0.5)
        .ohms(r, 100_000)
        .wire('PSU1.positive', `${G}.vcc`)
        .wire(`${G}.gnd`, 'GND1.ref')
        .wire(`${G}.b`, 'PSU1.positive')
        .wire(`${u}.gpio18`, `${G}.a`)
        .wire(`${G}.y`, `${r}.a`)
        .wire(`${r}.b`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(18, 'output-high');
    return { s, G };
  };

  it('gate at 3.3 V: V_IH 2.0 V ≤ 2.64 V: HIGH is guaranteed; LOW too (0.33 ≤ 0.8)', () => {
    const { s, G } = esp(3.3);
    expect(ok(s.solve()).components[G]!.state).toMatchObject({ input_a: 'high' });
    s.setPinMode(18, 'output-low');
    expect(ok(s.solve()).components[G]!.state).toMatchObject({ input_a: 'low' });
  });

  it('gate at 4.5 V: the model 3.3 V passes V_IH 3.15 V but the guaranteed 2.64 V does not → refused, naming the pad', () => {
    const { s, G } = esp(4.5);
    const e = fails(s.solve());
    expect(e).toMatchObject({
      code: 'logic_input_not_guaranteed',
      components: [G],
      param: 'a',
      detail: { level: 'high', causes: expect.arrayContaining(['esp32_voh']), pads: [18] },
    });
    expect((e.detail as { worst: number }).worst).toBeLessThanOrEqual(2.64 + 1e-9);
    expect((e.detail as { vih: number }).vih).toBeCloseTo(3.15, 12);
    // LOW stays guaranteed (V_OL 0.33 V ≤ V_IL 1.35 V).
    s.setPinMode(18, 'output-low');
    expect(ok(s.solve()).components[G]!.state).toMatchObject({ input_a: 'low' });
  });

  it('gate at 5.0 V: undefined already in the model (3.3 V < 3.5 V); the refusal names the pad and 2.64 V', () => {
    const { s, G } = esp(5.0);
    expect(fails(s.solve())).toMatchObject({
      code: 'logic_input_undefined',
      components: [G],
      param: 'a',
      detail: { pads: [18], padVoh: expect.closeTo(2.64, 12) },
    });
  });

  it('gate at 1.8 V: V_IH 0.65 × 1.8 = 1.17 V, V_IL 0.63 V: both guaranteed', () => {
    const { s, G } = esp(1.8);
    expect(ok(s.solve()).components[G]!.state).toMatchObject({ input_a: 'high' });
    s.setPinMode(18, 'output-low');
    expect(ok(s.solve()).components[G]!.state).toMatchObject({ input_a: 'low' });
  });
});

describe('Task 3: SN74LVC08A guaranteed operating limits only', () => {
  it('no PM-1 class bound: at 3.3 V only the ±100 µA row (1 mA load refused, limit 100 µA)', () => {
    expect(LVC08A_CARD.outputRows.some((r) => r.classVcc)).toBe(false);
    const b = new Bench();
    const u = b.add('logic.quad_and');
    const r = b.add('component.resistor');
    b.psu(3.3, 0.1).wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${u}.vcc`);
    b.wire(`${u}.gnd`, 'GND1.ref').ohms(r, 3300);
    for (const t of LVC08A_CARD.inputs)
      b.wire(`${u}.${t}`, t === 'a1' || t === 'b1' ? 'PSU1.positive' : 'GND1.ref');
    b.wire(`${u}.y1`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_output_uncharacterized',
      param: 'y1',
      detail: { limit: 100e-6 },
    });
  });

  it('at 5 V: outside the 1.65–3.6 V operating range → refused (abs. max 6.5 V is never an operating limit)', () => {
    const b = new Bench();
    const u = b.add('logic.quad_and');
    b.psu(5, 0.1).wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${u}.vcc`);
    b.wire(`${u}.gnd`, 'GND1.ref');
    for (const t of LVC08A_CARD.inputs) b.wire(`${u}.${t}`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject({ code: 'logic_supply_uncharacterized' });
  });

  it('output guarantees at 3.0 V are exactly §5.7: V_OH ≥ 2.4 V up to 12 mA, 2.2 V up to 24 mA; V_OL ≤ 0.55 V up to 24 mA', () => {
    expect(outputGuaranteeAt(LVC08A_CARD, 3.0, 'high', 5e-3)).toEqual({ volts: 2.4, atA: 12e-3 });
    expect(outputGuaranteeAt(LVC08A_CARD, 3.0, 'high', 20e-3)).toEqual({
      volts: expect.closeTo(2.2, 12),
      atA: 24e-3,
    });
    expect(outputGuaranteeAt(LVC08A_CARD, 3.0, 'low', 5e-3)).toEqual({ volts: 0.55, atA: 24e-3 });
    expect(outputGuaranteeAt(LVC08A_CARD, 3.0, 'high', 25e-3)).toBeNull();
  });
});

describe("the owner's circuit (screenshot d855acf4): PSU1 5 V / 100 mA, U1 SN74LVC1G08", () => {
  /** V_CC, A and B on PSU+; GND to `gndTo`; output unconnected. */
  const owner = (gndTo: 'PSU1.positive' | 'PSU1.negative', groundOnNegative: boolean) => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    b.psu(5, 0.1);
    if (groundOnNegative) b.wire('PSU1.negative', 'GND1.ref');
    b.wire(`${g}.vcc`, 'PSU1.positive')
      .wire(`${g}.a`, 'PSU1.positive')
      .wire(`${g}.b`, 'PSU1.positive')
      .wire(`${g}.gnd`, gndTo);
    return { b, g };
  };

  it('as drawn, no ground reference (PSU− and GND1 unconnected): refused, no powered gate', () => {
    const e = fails(solve(owner('PSU1.positive', false).b));
    expect(e.code).toBe('no_ground');
  });

  it('as drawn, GND1 on PSU−: V_CC − GND = 0 V: unpowered (I_off), output off, inputs off — never a valid level', () => {
    const { b, g } = owner('PSU1.positive', true);
    const r = ok(solve(b)).components[g]!;
    expect(r.state).toMatchObject({ gateOutput: 'off', supplyV: 0 });
    expect(r.logic!.gates[0]!.output).toMatchObject({ level: 'off' });
    expect(r.logic!.gates[0]!.output.guarantee).toBeUndefined();
    expect(r.logic!.gates[0]!.inputs.map((p) => p.level)).toEqual(['off', 'off']);
  });

  it('corrected (GND → PSU−): Y HIGH; guarantee exactly §5.5 at 5 V: V_OH ≥ V_CC − 0.1 = 4.9 V (|I_OH| ≤ 100 µA)', () => {
    const { b, g } = owner('PSU1.negative', true);
    const r = ok(solve(b)).components[g]!;
    expect(r.state).toMatchObject({
      gateOutput: 'high',
      input_a: 'high',
      input_b: 'high',
      supplyV: 5,
      outputModel: 'ranged',
      outputValidA: 100e-6,
      // I_CC is tabulated with V_I = 5.5 V or GND: inputs at 5.0 V are not that condition.
      iccCondition: 'notInputs',
      deltaIccA: 500e-6,
    });
    expect(r.logic).toMatchObject({ supplyV: 5, vih: 3.5, vil: 1.5 });
    expect(r.logic!.vih!).toBeCloseTo(0.7 * 5, 12);
    expect(r.logic!.gates[0]!.output.guarantee).toEqual({
      volts: expect.closeTo(4.9, 12),
      atA: 100e-6,
    });
    expect(outputGuaranteeAt(G08, 5, 'high', 0)).toEqual({
      volts: expect.closeTo(4.9, 12),
      atA: 100e-6,
    });
  });
});
