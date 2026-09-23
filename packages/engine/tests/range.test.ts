/**
 * A15: the resistance input range (1 mΩ .. 1 GΩ, packages/domain catalog) is backed by
 * numerical evidence on the production solver, not by a UI choice. Every case must solve,
 * pass the solver's own exact-equation verification gate, and agree with an independent
 * analytic (or bisection) answer to 1e-9 relative, the Gate A tolerance.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG } from '@tbi-lab/domain';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';
import { LED_TLHR5400, thermalVoltage } from '../src/models.js';
import { Bench, ledLoop, resistorLoop } from './build.js';

const REL = 1e-9;
const resistance = CATALOG['component.resistor'].params[0]!;
const MIN = resistance.kind === 'quantity' ? resistance.min : NaN;
const MAX = resistance.kind === 'quantity' ? resistance.max : NaN;
const DECADES = [1e-3, 1e-2, 1e-1, 1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
};
const relErr = (a: number, e: number) => Math.abs(a - e) / Math.abs(e);

describe('supported resistance range', () => {
  it('covers exactly the catalog input range 1 mΩ .. 1 GΩ', () => {
    expect([MIN, MAX]).toEqual([DECADES[0], DECADES.at(-1)]);
  });

  it('single load, every decade, CV and CC, extreme setpoints and limits', () => {
    for (const R of DECADES) {
      for (const [V, I] of [
        [5, 5],
        [30, 0.001],
        [0.001, 5],
        [30, 5],
      ] as const) {
        const r = ok(new EngineSession(resistorLoop(V, I, R).snapshot()).solve());
        const expected = Math.min(V / R, I);
        expect(
          relErr(r.components.R1!.current, expected),
          `R=${R} V=${V} I=${I}`,
        ).toBeLessThanOrEqual(REL);
        expect(r.components.PSU1!.mode).toBe(V / R > I ? 'cc' : 'cv');
      }
    }
  });

  it('every pair of decades as a divider (169 combinations, ratio up to 1e12)', () => {
    for (const R1 of DECADES) {
      for (const R2 of DECADES) {
        const b = new Bench();
        const a = b.add('component.resistor');
        const c = b.add('component.resistor');
        b.wire('PSU1.positive', `${a}.a`)
          .wire(`${a}.b`, `${c}.a`)
          .wire(`${c}.b`, 'GND1.ref')
          .wire('PSU1.negative', 'GND1.ref');
        b.psu(5, 5).ohms(a, R1).ohms(c, R2);
        const r = ok(new EngineSession(b.snapshot()).solve());
        const i = Math.min(5 / (R1 + R2), 5);
        expect(relErr(r.components[c]!.terminals.a!, i * R2), `${R1}/${R2}`).toBeLessThanOrEqual(
          REL,
        );
        expect(r.stats.maxKclResidualA).toBeLessThanOrEqual(1e-12 + 1e-9 * i);
      }
    }
  });

  it('LED + series resistor at every decade matches an independent bisection', () => {
    const nVt = LED_TLHR5400.emissionCoefficient * thermalVoltage(LED_TLHR5400.temperatureK);
    const gmin = 1e-12; // the solver's documented junction gmin, part of the model
    const iLed = (vj: number) =>
      LED_TLHR5400.saturationCurrentA * (Math.exp(vj / nVt) - 1) + gmin * vj;
    for (const R of DECADES) {
      for (const V of [2.5, 5, 30]) {
        const r = ok(new EngineSession(ledLoop(V, 5, R).snapshot()).solve());
        if (r.components.PSU1!.mode === 'cc') {
          expect(relErr(r.components.D1!.current, 5), `CC R=${R} V=${V}`).toBeLessThanOrEqual(REL);
          continue;
        }
        let lo = 0;
        let hi = V;
        for (let k = 0; k < 200; k++) {
          const mid = 0.5 * (lo + hi);
          if (V - mid - R * iLed(mid) > 0) lo = mid;
          else hi = mid;
        }
        const vj = 0.5 * (lo + hi);
        expect(relErr(r.components.D1!.voltage!, vj), `Vf R=${R} V=${V}`).toBeLessThanOrEqual(REL);
        expect(relErr(r.components.D1!.current, iLed(vj)), `I R=${R} V=${V}`).toBeLessThanOrEqual(
          1e-6,
        );
      }
    }
  });

  it('seeded random 4-resistor ladders across the full range', () => {
    let s = 20260923;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let n = 0; n < 200; n++) {
      const R = [0, 1, 2, 3].map(() => 10 ** (-3 + rnd() * 12));
      // PSU -> Ra -> m -> Rb -> GND, with Rc and Rd in series from m to GND as well.
      const b = new Bench();
      const [a, bb, c, d] = [0, 1, 2, 3].map(() => b.add('component.resistor')) as [
        string,
        string,
        string,
        string,
      ];
      b.wire('PSU1.positive', `${a}.a`).wire(`${a}.b`, `${bb}.a`).wire(`${bb}.b`, 'GND1.ref');
      b.wire(`${bb}.a`, `${c}.a`)
        .wire(`${c}.b`, `${d}.a`)
        .wire(`${d}.b`, 'GND1.ref')
        .wire('PSU1.negative', 'GND1.ref');
      b.psu(12, 5).ohms(a, R[0]!).ohms(bb, R[1]!).ohms(c, R[2]!).ohms(d, R[3]!);
      const r = ok(new EngineSession(b.snapshot()).solve());
      const low = 1 / (1 / R[1]! + 1 / (R[2]! + R[3]!));
      const i = 12 / (R[0]! + low);
      // In CC the supply delivers exactly its 5 A limit into the same network.
      const vm = i > 5 ? 5 * low : i * low;
      expect(
        relErr(r.components[bb]!.terminals.a!, vm),
        `ladder ${R.join(',')}`,
      ).toBeLessThanOrEqual(REL);
    }
  });
});
