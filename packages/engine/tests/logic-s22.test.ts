/**
 * Sprint 22 P1 (Q5): a gate output is modelled on its guaranteed (weakest) characteristic; a real
 * output can be stronger, bounded only by its own rail (1G sheets §8.2.1.3: the HIGH level is
 * produced from V_CC, the LOW level from GND; §5.3 V_O 0 to V_CC). The output-current check and the
 * supply current-limit check now take that stronger side into account.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';
import { Bench, boardBench } from './build.js';

const err = (o: SolveOutcome) => (o.ok ? null : o.error);
const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};
/** The state of the (single) gate of `type` in a solved bench. */
const gateState = (o: SolveOutcome, type = 'logic.gate_and') =>
  Object.values(ok(o).components).find((c) => c.type === type)!.state;
/** S29-D1: the ΔI_CC bound — I_CC 10 µA + ΔI_CC 500 µA for each of `n` inputs in a 0.6 V band. */
const deltaIcc = (n: number) => ({
  iccBasis: 'deltaIcc',
  deltaIccA: 500e-6,
  deltaIccInputs: n,
  iccMaxA: expect.closeTo(10e-6 + n * 500e-6, 12),
});
/**
 * Sprint 22 review 3: a 5.5 V input rail feeding only gate inputs could have to SINK their leakage
 * (±5 µA each, either sign); the bench-supply model cannot sink. A 10 kΩ bleeder (550 µA) keeps it
 * delivering; it does not change any current through PSU1.
 */
const bledRail = (b: Bench) => {
  const id = b.rail(5.5);
  b.bleed(id);
  return id;
};

/**
 * PSU1 at 3.0 V / `limit` → SN74LVC1G08 (A, B HIGH) → Y → R → GND (probe vprobe/psulim). Sprint 22
 * (Q1 strict): A and B at 5.5 V from a second supply, the I_CC test condition (SCES217AA §5.5), so
 * PSU1 carries the load plus a BOUNDED I_CC ≤ 10 µA + 2 × 5 µA.
 */
const psulim = (limit: number, r: number) => {
  const b = new Bench();
  const g = b.add('logic.gate_and');
  const res = b.add('component.resistor');
  b.psu(3.0, limit).wire('PSU1.negative', 'GND1.ref');
  const hi = bledRail(b);
  b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  b.wire(`${g}.a`, `${hi}.positive`).wire(`${g}.b`, `${hi}.positive`);
  b.ohms(res, r).wire(`${g}.y`, `${res}.a`).wire(`${res}.b`, 'GND1.ref');
  return new EngineSession(b.snapshot()).solve();
};

describe('Q5: the stronger side of an output (probe psulim)', () => {
  for (const limit of [0.02, 0.022])
    it(`130 Ω, limit ${limit * 1e3} mA: nominal 18.25 mA, but with Y at V_CC 23.08 mA → the supply is not guaranteed in CV → refused`, () => {
      const e = err(psulim(limit, 130));
      expect(e).toMatchObject({
        code: 'logic_supply_not_guaranteed',
        components: ['PSU1'],
        param: 'limit',
        detail: { limit, causes: expect.arrayContaining(['output_guarantee']) },
      });
    });
  it('150 Ω, limit 20.1 mA: at most 3.0 V / 150 Ω + 20 µA = 20.02 mA ≤ 20.1 mA → runs', () => {
    expect(err(psulim(0.0201, 150))).toBeNull();
  });
  it('150 Ω, limit 20.015 mA: 20.0 mA + the I_CC bound 20 µA = 20.02 mA > 20.015 mA → refused', () => {
    expect(err(psulim(0.020015, 150))).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      param: 'limit',
      detail: { causes: expect.arrayContaining(['supply_current']) },
    });
  });
  it('130 Ω with a 0.5 A limit: 23.08 mA at the rail ≤ the 24 mA point → runs', () => {
    expect(err(psulim(0.5, 130))).toBeNull();
  });
  it('100 Ω with a 0.5 A limit: 30 mA at the rail > 24 mA (nominal 22.4 mA) → output refused', () => {
    expect(err(psulim(0.5, 100))).toMatchObject({
      code: 'logic_output_uncharacterized',
      param: 'y',
      detail: { limit: 0.024, value: expect.closeTo(0.03, 9) },
    });
  });
});

/**
 * Sprint 22 Q1 (owner decision, strict — the rule before S29-D1): I_CC was bounded only under its
 * datasheet test condition (SN74LVC1G: every input at 5.5 V or GND, V_CC 1.65–5.5 V, SCES217AA
 * §5.5; SN74LVC08A: V_CC = 3.6 V, every input at V_CC or GND, SCAS283W §5.7). A supply's
 * current-limit check depends on the gate's I_CC, so it is never left out (fail-open).
 * Owner decision S29-D1: off those test voltages but with every input within 0.6 V of GND or of
 * V_CC (and V_CC in both the I_CC and the ΔI_CC rows; 1G: 3.0–5.5 V), I_CC is bounded by
 * I_CC + ΔI_CC (500 µA) × the inputs in such a band; an input between the bands stays
 * uncharacterized → refused by name. Hand values: probe s22q1/probe-q1.ts.
 */
type In = 'vcc' | 'gnd' | 'hi';
const q1gate = (limit: number, a: In, bIn: In, load?: number, bleed = false) => {
  const b = new Bench();
  b.psu(3.0, limit).wire('PSU1.negative', 'GND1.ref');
  // Review 3: with Y LOW or unloaded PSU1 could have to sink the inputs' leakage — a bleeder
  // (3.0 V / 10 kΩ = 300 µA) where the test is not about that.
  if (bleed) b.bleed('PSU1');
  const hi = bledRail(b);
  const g = b.add('logic.gate_and');
  b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  const to = (x: In) =>
    x === 'vcc' ? 'PSU1.positive' : x === 'gnd' ? 'GND1.ref' : `${hi}.positive`;
  b.wire(`${g}.a`, to(a)).wire(`${g}.b`, to(bIn));
  if (load) {
    const r = b.add('component.resistor');
    b.ohms(r, load).wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
  }
  return new EngineSession(b.snapshot()).solve();
};
const pulled = (ohms: number) => {
  const b = new Bench();
  b.psu(3.0, 0.1).wire('PSU1.negative', 'GND1.ref');
  b.bleed('PSU1'); // Y LOW unloaded: keep PSU1 delivering (review 3)
  const hi = bledRail(b);
  const g = b.add('logic.gate_and');
  const r = b.add('component.resistor');
  b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref').wire(`${g}.a`, `${hi}.positive`);
  b.ohms(r, ohms).wire(`${g}.b`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
  return new EngineSession(b.snapshot()).solve();
};

describe('a supply current limit needs a bounded I_CC (Q1 strict test condition, or ΔI_CC since S29-D1)', () => {
  it('inputs at V_CC = 3.0 V (not 5.5 V, within 0.6 V of V_CC): bounded by ΔI_CC (S29-D1) → runs, I_CC ≤ 10 µA + 2 × 500 µA = 1.01 mA', () => {
    expect(gateState(q1gate(0.1, 'vcc', 'vcc'))).toMatchObject({
      gateOutput: 'high',
      input_a: 'high',
      input_b: 'high',
      supplyV: 3,
      ...deltaIcc(2),
    });
  });
  it('the ΔI_CC bound is used, not dropped (S29-D1): inputs at V_CC, 1 kΩ at the rail 3.000 mA + 1.01 mA + 2 × I_I 5 µA = 4.020 mA', () => {
    for (const limit of [0.003025, 0.004015])
      expect(err(q1gate(limit, 'vcc', 'vcc', 1000)), String(limit)).toMatchObject({
        code: 'logic_supply_not_guaranteed',
        param: 'limit',
        detail: { limit, causes: expect.arrayContaining(['supply_current']) },
      });
    expect(gateState(q1gate(0.004025, 'vcc', 'vcc', 1000))).toMatchObject({
      gateOutput: 'high',
      ...deltaIcc(2),
    });
  });
  it('an input between the bands (S29-D1: 0.6 V < V_I < V_CC − 0.6 V) stays uncharacterized: 0.7 V (a valid LOW, V_IL 0.8 V) and 2.2 V (a valid HIGH, V_IH 2.0 V) at V_CC = 3.0 V → refused by name', () => {
    for (const volts of [0.7, 2.2]) {
      const b = new Bench();
      b.psu(3.0, 0.1).wire('PSU1.negative', 'GND1.ref');
      b.bleed('PSU1');
      const hi = bledRail(b);
      const mid = b.rail(volts);
      b.bleed(mid);
      const g = b.add('logic.gate_and');
      b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
      b.wire(`${g}.a`, `${mid}.positive`).wire(`${g}.b`, `${hi}.positive`);
      expect(err(new EngineSession(b.snapshot()).solve()), String(volts)).toEqual({
        code: 'logic_supply_current_uncharacterized',
        components: [g, 'PSU1'],
        param: 'vcc',
        detail: {
          part: 'SN74LVC1G08',
          vcc: 3,
          condition: 'notInputs',
          check: 'limit',
          psu: 'PSU1',
        },
      });
    }
  });
  it('inputs at GND, or at 5.5 V from a second supply: bounded → runs', () => {
    expect(err(q1gate(0.1, 'gnd', 'gnd', undefined, true))).toBeNull();
    expect(err(q1gate(0.1, 'hi', 'gnd', undefined, true))).toBeNull();
    // Y HIGH into 10 kΩ: ≈ 300 µA delivered, more than any leakage returning (no bleeder needed).
    expect(err(q1gate(0.1, 'hi', 'hi', 10_000))).toBeNull();
  });
  it('the bound is used, not dropped: 1 kΩ at the rail 3.000 mA + I_CC 10 µA + 2 × I_I 5 µA = 3.020 mA', () => {
    expect(err(q1gate(0.003015, 'hi', 'hi', 1000))).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      param: 'limit',
      detail: { causes: expect.arrayContaining(['supply_current']) },
    });
    expect(err(q1gate(0.003025, 'hi', 'hi', 1000))).toBeNull();
  });
  it('an input held at GND through R: within 1 mV of GND (199 Ω) the strict I_CC 10 µA; beyond it (201 Ω, 1 kΩ, 119 kΩ: ≤ 0.6 V) bounded by ΔI_CC (S29-D1) → runs, I_CC ≤ 510 µA; 121 kΩ (0.605 V) refused', () => {
    const strict = gateState(pulled(199));
    expect(strict).toMatchObject({ gateOutput: 'low', input_b: 'low', iccMaxA: 10e-6 });
    expect(strict).not.toHaveProperty('iccBasis');
    for (const ohms of [201, 1000, 119_000])
      expect(gateState(pulled(ohms)), String(ohms)).toMatchObject({
        gateOutput: 'low',
        input_b: 'low',
        ...deltaIcc(1),
      });
    // 5 µA × 121 kΩ = 0.605 V: still a valid LOW (V_IL 0.8 V), but between the bands.
    expect(err(pulled(121_000))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      param: 'b',
      detail: { condition: 'notInputs', check: 'limit', worst: expect.closeTo(0.605, 9) },
    });
  });
  it('a cascade (U1.Y → U2.A): a gate output is never within 1 mV of 5.5 V or GND, but its HIGH is within 0.6 V of V_CC → U2 bounded by ΔI_CC (S29-D1), runs: U1 I_CC ≤ 10 µA, U2 ≤ 510 µA', () => {
    const b = new Bench();
    b.psu(3.0, 0.1).wire('PSU1.negative', 'GND1.ref');
    const hi = bledRail(b);
    const u1 = b.add('logic.gate_and');
    const u2 = b.add('logic.gate_and');
    for (const u of [u1, u2]) b.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref');
    b.wire(`${u1}.a`, `${hi}.positive`).wire(`${u1}.b`, `${hi}.positive`);
    b.wire(`${u2}.a`, `${u1}.y`).wire(`${u2}.b`, `${hi}.positive`);
    const o = ok(new EngineSession(b.snapshot()).solve());
    expect(o.components[u1]!.state).toMatchObject({ gateOutput: 'high', iccMaxA: 10e-6 });
    expect(o.components[u1]!.state).not.toHaveProperty('iccBasis');
    expect(o.components[u2]!.state).toMatchObject({
      gateOutput: 'high',
      input_a: 'high',
      input_b: 'high',
      ...deltaIcc(1),
    });
  });
  it('SN74LVC08A: at 3.6 V with every input at V_CC or GND runs; at 3.3 V refused (notSupply)', () => {
    const q = (v: number) => {
      const b = new Bench();
      b.psu(v, 0.1).wire('PSU1.negative', 'GND1.ref');
      b.bleed('PSU1'); // outputs unloaded: keep PSU1 delivering (review 3)
      const u = b.add('logic.quad_and');
      b.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref');
      for (const p of ['a1', 'b1', 'a2']) b.wire(`${u}.${p}`, 'PSU1.positive');
      for (const p of ['b2', 'a3', 'b3', 'a4', 'b4']) b.wire(`${u}.${p}`, 'GND1.ref');
      return new EngineSession(b.snapshot()).solve();
    };
    expect(err(q(3.6))).toBeNull();
    expect(err(q(3.3))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      detail: { part: 'SN74LVC08A', condition: 'notSupply', check: 'limit', psu: 'PSU1' },
    });
  });
});

/**
 * Sprint 22 independent review (acdd587), fail-open paths F1, F2, F5, F6 — hand-computed. Probes:
 * scratchpad s22rev1/p1, p4, p5, p6.
 */
describe('review F1: a supply in current limit (CC) — the output band is explored per volt of its source', () => {
  it('PSU1 3.3 V / 9 mA (CC) → 1G08, inputs 5.5 V, Y → 300 Ω: Y at its rail gives V_CC = (9 mA − I_CC 10 µA − 2 × I_I 5 µA) × 300 Ω = 2.694 V < 3.0 V → refused', () => {
    const b = new Bench();
    b.psu(3.3, 0.009).wire('PSU1.negative', 'GND1.ref');
    const hi = bledRail(b);
    const g = b.add('logic.gate_and');
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
    b.wire(`${g}.a`, `${hi}.positive`).wire(`${g}.b`, `${hi}.positive`);
    b.ohms(r, 300).wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    const o = new EngineSession(b.snapshot()).solve();
    expect(err(o)).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      param: 'vcc',
      detail: {
        worst: expect.closeTo(2.694, 9),
        causes: expect.arrayContaining(['output_guarantee']),
      },
    });
  });
  it('the limit is checked with the supply held at its setpoint: the worst DEMANDED current is reported (3.3 V / 300 Ω + 20 µA = 11.02 mA > 10 mA)', () => {
    const b = new Bench();
    b.psu(3.3, 0.01).wire('PSU1.negative', 'GND1.ref');
    const hi = bledRail(b);
    const g = b.add('logic.gate_and');
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
    b.wire(`${g}.a`, `${hi}.positive`).wire(`${g}.b`, `${hi}.positive`);
    b.ohms(r, 300).wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    expect(err(new EngineSession(b.snapshot()).solve())).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      components: ['PSU1'],
      param: 'limit',
      detail: { limit: 0.01, value: expect.closeTo(0.01102, 9) },
    });
  });
});

describe('review F2: an ESP32 output pad — its band an ideal-source interval, never the typical drive resistance', () => {
  const padCase = (
    mode: 'output-low' | 'output-high',
    wire: (b: Bench, u: string, g: string) => void,
  ) => {
    let g = '';
    const bb = boardBench((b, u) => {
      g = b.add('logic.gate_and');
      b.psu(3.0, 0.5).wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
      wire(b, u, g);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(18, mode);
    return { o: s.solve(), g };
  };
  it('GPIO18 output-low in parallel with a gate Y LOW (same level, nothing between): refused, two drivers on one net', () => {
    const { o, g } = padCase('output-low', (b, u, gg) => {
      b.wire(`${gg}.a`, 'GND1.ref').wire(`${gg}.b`, 'GND1.ref').wire(`${gg}.y`, `${u}.gpio18`);
    });
    expect(err(o)).toMatchObject({
      code: 'logic_bound_not_established',
      components: [g],
      detail: { reason: 'parallel_outputs', pads: [18] },
    });
  });
  it('GPIO18 into a gate input with a 10 kΩ pull-down: LOW (V_OL 0.33 V) the pad carries 0.33 V / 10 kΩ + I_I 5 µA = 38 µA — refused under Q7 until Sprint 29, within the 100 µA envelope since S30-L1 → runs; HIGH it sources 3.3 V / 10 kΩ ≈ 330 µA > 100 µA → refused by name', () => {
    const wire = (b: Bench, u: string, gg: string) => {
      const hi = bledRail(b);
      const r = b.add('component.resistor');
      b.wire(`${gg}.b`, `${hi}.positive`).wire(`${gg}.a`, `${u}.gpio18`);
      b.ohms(r, 10_000).wire(`${gg}.a`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    };
    expect(ok(padCase('output-low', wire).o).ok).toBe(true);
    const { o } = padCase('output-high', wire);
    expect(err(o)).toMatchObject({
      code: 'logic_mcu_output_uncharacterized',
      param: 'gpio18',
      detail: { level: 'high', limit: 100e-6 },
    });
    expect((err(o)!.detail as { value: number }).value).toBeGreaterThan(320e-6);
  });
});

describe('review F5/F6: one input leakage per input, returning through GND or V_CC (adverse)', () => {
  it('F5: V_CC 3.6 V through 1 kΩ, inputs at 5.5 V: 2 × 5 µA leaving through the V_CC pin raise V_CC to 3.610 V > 3.6 V → refused', () => {
    const b = new Bench();
    b.psu(3.6, 0.1).wire('PSU1.negative', 'GND1.ref');
    const hi = bledRail(b);
    const g = b.add('logic.gate_and');
    const r = b.add('component.resistor');
    b.ohms(r, 1000)
      .wire('PSU1.positive', `${r}.a`)
      .wire(`${r}.b`, `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref');
    b.wire(`${g}.a`, `${hi}.positive`).wire(`${g}.b`, `${hi}.positive`);
    expect(err(new EngineSession(b.snapshot()).solve())).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      param: 'vcc',
      detail: { worst: expect.closeTo(3.61, 9), causes: expect.arrayContaining(['leakage']) },
    });
  });
  // SN74LVC08A at 3.6 V, 1A/1B at V_CC, the other six inputs at GND, outputs unloaded (review 3:
  // a loaded 08A output leaves the I_CC test condition I_O = 0), a bleeder R across the supply,
  // limit 1 mA. Counted once: I_CC 10 + 8 × 5 = 50 µA (a double count of 1A/1B: 60 µA).
  const q = (bleed: number) => {
    const b = new Bench();
    const u = b.add('logic.quad_and');
    b.psu(3.6, 1e-3).wire('PSU1.negative', 'GND1.ref');
    b.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref');
    for (const t of ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'])
      b.wire(`${u}.${t}`, t.endsWith('1') ? 'PSU1.positive' : 'GND1.ref');
    b.bleed('PSU1', bleed);
    return new EngineSession(b.snapshot()).solve();
  };
  it('F6: bleeder 3780 Ω: 952.38 + 50 = 1002.38 µA > 1 mA → refused, the demand reported exactly', () => {
    expect(err(q(3780))).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      param: 'limit',
      detail: { value: expect.closeTo(3.6 / 3780 + 50e-6, 12) },
    });
  });
  it('F6: bleeder 3800 Ω: 947.37 + 50 = 997.37 µA ≤ 1 mA → runs (a double count, 60 µA, would refuse)', () => {
    expect(err(q(3800))).toBeNull();
  });
});

describe('review 3: the bench-supply model cannot sink; the SN74LVC08A I_CC only at I_O = 0', () => {
  it('(a) PSU1 3.0 V with a 5 V supply pushing (5 − 3) / 100 Ω = 20 mA into it, no logic → psu_sinking, 20 mA', () => {
    const b = new Bench();
    b.psu(3.0, 0.1).wire('PSU1.negative', 'GND1.ref');
    const p2 = b.rail(5.0, 0.1);
    const r = b.add('component.resistor');
    b.ohms(r, 100).wire(`${p2}.positive`, `${r}.a`).wire(`${r}.b`, 'PSU1.positive');
    expect(err(new EngineSession(b.snapshot()).solve())).toMatchObject({
      code: 'psu_sinking',
      components: ['PSU1'],
      detail: { value: expect.closeTo(0.02, 9) },
    });
  });
  const unloaded = (bleed: boolean) => {
    const b = new Bench();
    b.psu(3.0, 0.1).wire('PSU1.negative', 'GND1.ref');
    const hi = bledRail(b);
    const g = b.add('logic.gate_and');
    b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
    b.wire(`${g}.a`, `${hi}.positive`).wire(`${g}.b`, `${hi}.positive`);
    if (bleed) b.bleed('PSU1');
    return new EngineSession(b.snapshot()).solve();
  };
  it("(b) Y HIGH unloaded, A/B at 5.5 V: both inputs' leakage (2 × 5 µA) may return into V_CC — no more than the circuit's datasheet leakage → evaluated (S29-A3), runs; with a 10 kΩ bleeder (300 µA) it runs too", () => {
    for (const bleed of [false, true])
      expect(gateState(unloaded(bleed)), String(bleed)).toMatchObject({
        gateOutput: 'high',
        input_a: 'high',
        input_b: 'high',
        iccMaxA: 10e-6,
      });
    // A larger current into a supply (20 mA from another supply, (a) above) stays refused.
  });
  const pkg = (load: number | null) => {
    const b = new Bench();
    const u = b.add('logic.quad_and');
    b.psu(3.6, 0.1).wire('PSU1.negative', 'GND1.ref');
    b.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref');
    for (const t of ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'])
      b.wire(`${u}.${t}`, t.endsWith('1') ? 'PSU1.positive' : 'GND1.ref');
    if (load) {
      const r = b.add('component.resistor');
      b.ohms(r, load).wire(`${u}.y1`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    }
    b.bleed('PSU1');
    return { o: new EngineSession(b.snapshot()).solve(), u };
  };
  it('(c) SN74LVC08A at 3.6 V, inputs at V_CC/GND, 1Y → 100 kΩ (36 µA): I_CC is given only at I_O = 0 (SCAS283W §5.7) → refused by name (loaded); unloaded (with a bleeder) it runs', () => {
    const { o, u } = pkg(100_000);
    expect(err(o)).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: [u, 'PSU1'],
      param: 'y1',
      detail: { part: 'SN74LVC08A', condition: 'loaded' },
    });
    expect(err(pkg(null).o)).toBeNull();
  });
});

/**
 * Sprint 22 review 4 (R1): the no-sinking rule applies to the SETTLED operating point only, never
 * to an intermediate settle pass. Probe s22rev4/q1.ts S1.
 */
describe('review 4: psu_sinking only on the settled state', () => {
  const relay = (gate: boolean) => {
    const b = new Bench();
    b.psu(5.0, 0.5).wire('PSU1.negative', 'GND1.ref');
    const p2 = b.rail(3.0, 0.1);
    const k = b.add('component.relay');
    b.wire('PSU1.positive', `${k}.coil1`).wire(`${k}.coil2`, 'GND1.ref');
    b.wire('PSU1.positive', `${k}.com`);
    const rnc = b.add('component.resistor');
    b.ohms(rnc, 100).wire(`${k}.nc`, `${rnc}.a`).wire(`${rnc}.b`, `${p2}.positive`);
    const rl = b.add('component.resistor');
    b.ohms(rl, 1000).wire(`${p2}.positive`, `${rl}.a`).wire(`${rl}.b`, 'GND1.ref');
    if (gate) {
      // A gate on PSU2 too (inputs at GND, Y open): the bounds' sink check sees the settled state,
      // where PSU2 delivers 3 mA ≫ the 10 µA of input leakage that could return.
      const g = b.add('logic.gate_and');
      b.wire(`${p2}.positive`, `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
      b.wire(`${g}.a`, 'GND1.ref').wire(`${g}.b`, 'GND1.ref');
    }
    return { o: new EngineSession(b.snapshot()).solve(), p2, k };
  };
  it('relay operated by PSU1 (5 V): released, NC would push (5 − 3) V / 100 Ω − 3 mA = 17 mA into PSU2 — but the settled state has NC open and PSU2 sources 3.0 V / 1 kΩ = 3 mA → runs', () => {
    const { o, p2, k } = relay(false);
    if (!o.ok) throw new Error(JSON.stringify(o.error));
    expect(o.components[k]!.state).toMatchObject({ energized: true, contact: 'no' });
    expect(o.components[p2]!.current!).toBeCloseTo(3e-3, 12);
  });
  it('the same with a logic gate on PSU2: the bounds sink check also sees only the settled state → runs', () => {
    const { o, p2 } = relay(true);
    if (!o.ok) throw new Error(JSON.stringify(o.error));
    expect(o.components[p2]!.current!).toBeCloseTo(3e-3, 12);
  });
});
