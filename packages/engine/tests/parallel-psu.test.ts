/**
 * Product Alpha maintenance: laboratory supplies in parallel.
 *
 * The lab-PSU model is an ideal CV source that becomes an ideal CC source at its limit. Two such
 * outputs connected directly across the same pair of nodes have no unique operating point in CV
 * (equal setpoints: any current split satisfies the equations; unequal: contradiction), and with
 * equal setpoints it is ambiguous which one limits. The engine therefore refuses the direct-
 * parallel configuration as `psu_parallel`, naming the supplies, instead of failing as a
 * singular matrix or inventing a current split. Supplies that merely coexist, sit on different
 * nets, or whose output is off are solved normally.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';
import { Bench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};

type Wiring = 'parallel' | 'anti-parallel' | 'separate' | 'series' | 'via-resistor' | 'via-switch';

/** PSU1 and PSU2 (5 V / 3 V by default) with a load, in one of the wirings above. */
function bench(
  wiring: Wiring,
  o: { v1?: number; i1?: number; v2?: number; i2?: number; ohms?: number; en2?: boolean } = {},
) {
  const b = new Bench();
  const p2 = b.add('instrument.lab_psu');
  const r = b.add('component.resistor');
  switch (wiring) {
    case 'parallel':
      b.wire('PSU1.positive', `${p2}.positive`).wire(`${p2}.negative`, 'GND1.ref');
      b.wire(`${r}.a`, 'PSU1.positive');
      break;
    case 'anti-parallel':
      b.wire('PSU1.positive', `${p2}.negative`).wire(`${p2}.positive`, 'GND1.ref');
      b.wire(`${r}.a`, 'PSU1.positive');
      break;
    case 'separate': {
      const r2 = b.add('component.resistor');
      b.wire(`${r2}.a`, `${p2}.positive`).wire(`${r2}.b`, 'GND1.ref');
      b.wire(`${p2}.negative`, 'GND1.ref').wire(`${r}.a`, 'PSU1.positive');
      b.ohms(r2, 1000);
      break;
    }
    case 'series':
      // PSU2 stacked on PSU1: different node pairs, a well-defined 8 V source.
      b.wire('PSU1.positive', `${p2}.negative`).wire(`${r}.a`, `${p2}.positive`);
      break;
    case 'via-resistor': {
      // PSU2 feeds the same node through its own resistor: not a direct parallel.
      const r2 = b.add('component.resistor');
      b.wire(`${p2}.positive`, `${r2}.a`).wire(`${r2}.b`, 'PSU1.positive');
      b.wire(`${p2}.negative`, 'GND1.ref').wire(`${r}.a`, 'PSU1.positive');
      b.ohms(r2, 100);
      break;
    }
    case 'via-switch': {
      // A CLOSED switch is an ideal conductor: the outputs are still directly paralleled.
      const sw = b.add('component.toggle_switch');
      b.wire(`${p2}.positive`, `${sw}.a`).wire(`${sw}.b`, 'PSU1.positive');
      b.wire(`${p2}.negative`, 'GND1.ref').wire(`${r}.a`, 'PSU1.positive');
      b.set(sw, 'closed', true);
      break;
    }
  }
  b.wire(`${r}.b`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref');
  b.psu(o.v1 ?? 5, o.i1 ?? 0.1)
    .ohms(r, o.ohms ?? 1000)
    .set(p2, 'setpointVoltage', { value: o.v2 ?? 3, unit: 'volt' })
    .set(p2, 'currentLimit', { value: o.i2 ?? 0.1, unit: 'ampere' })
    .set(p2, 'outputEnabled', o.en2 ?? true);
  return b;
}

const solve = (b: Bench) => new EngineSession(b.snapshot()).solve();

describe('laboratory supplies in parallel', () => {
  it('two independent supplies on different nets solve normally', () => {
    const r = ok(solve(bench('separate')));
    expect(r.components.PSU1!.voltage).toBeCloseTo(5, 12);
    expect(r.components.PSU2!.voltage).toBeCloseTo(3, 12);
    expect(r.components.PSU1!.current).toBeCloseTo(5e-3, 12);
    expect(r.components.PSU2!.current).toBeCloseTo(3e-3, 12);
  });

  it('supplies in series and supplies joined through a resistor are not direct parallels', () => {
    expect(ok(solve(bench('series'))).components.R1!.voltage).toBeCloseTo(8, 9);
    // PSU2 sits at its own 3 V behind 100 ohm: it would have to SINK (5 − 3) / 100 = 20 mA. Sprint
    // 22 review 3: the bench-supply model cannot sink (devices.ts) — refused by name.
    expect(solve(bench('via-resistor', { v2: 3 }))).toMatchObject({
      ok: false,
      error: {
        code: 'psu_sinking',
        components: ['PSU2'],
        detail: { value: expect.closeTo(0.02, 9) },
      },
    });
  });

  it('a paralleled supply whose output is off is high impedance, not a parallel source', () => {
    const r = ok(solve(bench('parallel', { en2: false })));
    expect(r.components.PSU2!.mode).toBe('off');
    expect(r.components.PSU2!.current).toBe(0);
    expect(r.components.PSU1!.voltage).toBeCloseTo(5, 12);
  });

  const cases: [string, Parameters<typeof bench>[1]][] = [
    ['equal CV setpoints, light load', { v1: 5, v2: 5 }],
    ['unequal CV setpoints', { v1: 5, v2: 3 }],
    ['equal setpoints, load beyond one limit (CC would be involved)', { v1: 5, v2: 5, ohms: 40 }],
    [
      'unequal setpoints, load beyond both limits (both would be in CC)',
      { v1: 5, v2: 3, ohms: 10 },
    ],
  ];
  for (const [name, o] of cases) {
    it(`direct parallel, ${name}: refused as psu_parallel naming both supplies`, () => {
      const out = solve(bench('parallel', o));
      expect(out.ok).toBe(false);
      if (!out.ok)
        expect(out.error).toEqual({ code: 'psu_parallel', components: ['PSU1', 'PSU2'] });
    });
  }

  it('anti-parallel outputs and outputs joined by a closed switch are direct parallels too', () => {
    for (const w of ['anti-parallel', 'via-switch'] as const) {
      const out = solve(bench(w));
      expect(!out.ok && out.error.code, w).toBe('psu_parallel');
    }
  });

  it('turning the second output on while running is refused the same way', () => {
    const s = new EngineSession(bench('parallel', { en2: false }).snapshot());
    expect(s.solve().ok).toBe(true);
    expect(s.applyPsuControl('PSU2', { outputEnabled: true }, 2)).toBeNull();
    const out = s.solve();
    expect(!out.ok && out.error.code).toBe('psu_parallel');
  });
});
