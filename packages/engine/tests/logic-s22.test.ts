/**
 * Sprint 22 P1 (Q5): a gate output is modelled on its guaranteed (weakest) characteristic; a real
 * output can be stronger, bounded only by its own rail (1G sheets §8.2.1.3: the HIGH level is
 * produced from V_CC, the LOW level from GND; §5.3 V_O 0 to V_CC). The output-current check and the
 * supply current-limit check now take that stronger side into account.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveOutcome } from '../src/index.js';
import { Bench } from './build.js';

const err = (o: SolveOutcome) => (o.ok ? null : o.error);

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
  const hi = b.rail(5.5);
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
 * Sprint 22 Q1 (owner decision, strict): I_CC is bounded only under its datasheet test condition
 * (SN74LVC1G: every input at 5.5 V or GND, V_CC 1.65–5.5 V, SCES217AA §5.5; SN74LVC08A: V_CC =
 * 3.6 V, every input at V_CC or GND, SCAS283W §5.7). A supply's current-limit check depends on
 * the gate's I_CC, so outside that condition it is refused by name — never left out (fail-open),
 * never bounded by ΔI_CC or the §8.2.1.1 guideline. Hand values: probe s22q1/probe-q1.ts.
 */
type In = 'vcc' | 'gnd' | 'hi';
const q1gate = (limit: number, a: In, bIn: In, load?: number) => {
  const b = new Bench();
  b.psu(3.0, limit).wire('PSU1.negative', 'GND1.ref');
  const hi = b.rail(5.5);
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
  const hi = b.rail(5.5);
  const g = b.add('logic.gate_and');
  const r = b.add('component.resistor');
  b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref').wire(`${g}.a`, `${hi}.positive`);
  b.ohms(r, ohms).wire(`${g}.b`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
  return new EngineSession(b.snapshot()).solve();
};

describe('Q1 strict: a supply current limit needs a bounded I_CC', () => {
  it('inputs at V_CC = 3.0 V (not 5.5 V): I_CC unbounded → refused by name, naming the gate and the supply', () => {
    expect(err(q1gate(0.1, 'vcc', 'vcc'))).toEqual({
      code: 'logic_supply_current_uncharacterized',
      components: [expect.any(String), 'PSU1'],
      param: 'vcc',
      detail: {
        part: 'SN74LVC1G08',
        vcc: 3,
        condition: 'notInputs',
        check: 'limit',
        psu: 'PSU1',
      },
    });
  });
  it('inputs at GND, or at 5.5 V from a second supply: bounded → runs', () => {
    expect(err(q1gate(0.1, 'gnd', 'gnd'))).toBeNull();
    expect(err(q1gate(0.1, 'hi', 'gnd'))).toBeNull();
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
  it('an input held at GND through R: I_I 5 µA × R must stay within 1 mV of GND (199 Ω runs, 201 Ω / 1 kΩ refused)', () => {
    expect(err(pulled(199))).toBeNull();
    for (const [ohms, worst] of [
      [201, 0.001005],
      [1000, 0.005],
    ] as const)
      expect(err(pulled(ohms))).toMatchObject({
        code: 'logic_supply_current_uncharacterized',
        param: 'b',
        detail: { condition: 'notInputs', check: 'limit', worst: expect.closeTo(worst, 9) },
      });
  });
  it('a cascade (U1.Y → U2.A): a gate output is never within 1 mV of 5.5 V or GND → refused', () => {
    const b = new Bench();
    b.psu(3.0, 0.1).wire('PSU1.negative', 'GND1.ref');
    const hi = b.rail(5.5);
    const u1 = b.add('logic.gate_and');
    const u2 = b.add('logic.gate_and');
    for (const u of [u1, u2]) b.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref');
    b.wire(`${u1}.a`, `${hi}.positive`).wire(`${u1}.b`, `${hi}.positive`);
    b.wire(`${u2}.a`, `${u1}.y`).wire(`${u2}.b`, `${hi}.positive`);
    expect(err(new EngineSession(b.snapshot()).solve())).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: [u2, 'PSU1'],
      detail: { check: 'limit', condition: 'notInputs' },
    });
  });
  it('SN74LVC08A: at 3.6 V with every input at V_CC or GND runs; at 3.3 V refused (notSupply)', () => {
    const q = (v: number) => {
      const b = new Bench();
      b.psu(v, 0.1).wire('PSU1.negative', 'GND1.ref');
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
