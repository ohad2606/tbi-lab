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

/** PSU1 at 3.0 V / `limit` → SN74LVC1G08 (A, B HIGH) → Y → R → GND (probe vprobe/psulim). */
const psulim = (limit: number, r: number) => {
  const b = new Bench();
  const g = b.add('logic.gate_and');
  const res = b.add('component.resistor');
  b.psu(3.0, limit).wire('PSU1.negative', 'GND1.ref');
  b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  b.wire(`${g}.a`, 'PSU1.positive').wire(`${g}.b`, 'PSU1.positive');
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
  it('150 Ω, limit 20.1 mA: at most 3.0 V / 150 Ω = 20.0 mA ≤ 20.1 mA → runs', () => {
    expect(err(psulim(0.0201, 150))).toBeNull();
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
