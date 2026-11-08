/**
 * Sprint 19B, Component Failure Framework F2 (owner decision: ¼ W default, configurable, from a
 * verified datasheet series with its derating). KOA Speer CF series (CF.pdf p.143): CF1/4 0.25 W
 * and CFS1/2 0.50 W at 70 °C, derated linearly to 0 at 155 °C; working voltage 300 V / 350 V.
 */
import { describe, expect, it } from 'vitest';
import {
  deratedPowerW,
  EngineSession,
  RESISTOR_SERIES,
  ratingWarnings,
  resistorRating,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { resistorLoop } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(o.error.code);
  return o;
};
const CF14 = RESISTOR_SERIES['model.resistor.koa_cf_1_4']!;

const at = (volts: number, ohms: number, powerRating?: string) => {
  const b = resistorLoop(volts, 1, ohms);
  if (powerRating) b.set('R1', 'powerRating', powerRating);
  return ratingWarnings(b.snapshot(), ok(new EngineSession(b.snapshot()).solve()));
};

describe('resistor power rating (F2)', () => {
  it('derating: full rating to 70 °C, linear to 0 at 155 °C, none outside −55 … 155 °C', () => {
    expect(deratedPowerW(CF14, -55)).toBe(0.25);
    expect(deratedPowerW(CF14, 25)).toBe(0.25);
    expect(deratedPowerW(CF14, 70)).toBe(0.25);
    expect(deratedPowerW(CF14, 112.5)).toBeCloseTo(0.125, 12);
    expect(deratedPowerW(CF14, 155)).toBe(0);
    expect(deratedPowerW(CF14, 156)).toBe(0);
    expect(deratedPowerW(CF14, -56)).toBe(0);
  });

  it('the default is ¼ W (no parameter); the ½ W series is selectable; values outside a series are unrated', () => {
    const r = (ohms: number, extra: Record<string, unknown> = {}) =>
      resistorRating({ resistance: { value: ohms, unit: 'ohm' }, ...extra });
    expect(r(100)).toMatchObject({ series: 'model.resistor.koa_cf_1_4', ratedW: 0.25 });
    expect(r(100, { powerRating: 'model.resistor.koa_cfs_1_2' })).toMatchObject({ ratedW: 0.5 });
    // CF1/4 is made from 2.2 Ω (J): no rating is borrowed for 1 Ω.
    expect(r(1)).toBeNull();
    expect(r(1, { powerRating: 'model.resistor.koa_cfs_1_2' })).toMatchObject({ ratedW: 0.5 });
  });

  it('100 Ω: 4.99 V (249 mW) within the ¼ W rating; 6 V (360 mW): unrated excess', () => {
    expect(at(4.99, 100)).toEqual([]);
    const w = at(6, 100);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      kind: 'unrated',
      code: 'power',
      model: 'model.resistor.koa_cf_1_4',
      limit: 0.25,
    });
    expect(w[0]!.value).toBeCloseTo(0.36, 12);
    // Never `absolute`: the series publishes no continuous damage threshold for power.
    expect(w.some((x) => x.kind === 'absolute')).toBe(false);
  });

  it('above the absolute-maximum working voltage (300 V): an absolute excess (classification)', () => {
    // The bench supply cannot reach 300 V; the classification is checked on a solved outcome
    // whose resistor voltage is set to 310 V (19 mW in 5 MΩ: within the power rating).
    const b = resistorLoop(5, 1, 5_000_000);
    const o = ok(new EngineSession(b.snapshot()).solve());
    const r = o.components.R1!;
    const forced = {
      ...o,
      components: { ...o.components, R1: { ...r, voltage: 310, current: 310 / 5e6 } },
    };
    const w = ratingWarnings(b.snapshot(), forced);
    expect(w.map((x) => [x.kind, x.code, x.limit])).toEqual([['absolute', 'voltage', 300]]);
  });

  it('the ½ W series: 7 V on 100 Ω (490 mW) within; 7.1 V (504 mW) unrated; 350 V its working limit', () => {
    const half = 'model.resistor.koa_cfs_1_2';
    expect(at(7, 100, half)).toEqual([]);
    const w = at(7.1, 100, half);
    expect(w.map((x) => [x.kind, x.code, x.model, x.limit])).toEqual([
      ['unrated', 'power', half, 0.5],
    ]);
    expect(w[0]!.value).toBeCloseTo(0.5041, 12);
    const b = resistorLoop(5, 1, 5_000_000);
    b.set('R1', 'powerRating', half);
    const o = ok(new EngineSession(b.snapshot()).solve());
    const force = (v: number) =>
      ratingWarnings(b.snapshot(), {
        ...o,
        components: { ...o.components, R1: { ...o.components.R1!, voltage: v, current: v / 5e6 } },
      });
    expect(force(340)).toEqual([]);
    expect(force(360).map((x) => [x.kind, x.code, x.limit])).toEqual([
      ['absolute', 'voltage', 350],
    ]);
  });

  it('a value the series is not made in is said by name (no rating), at any dissipation', () => {
    // CF1/4 is made from 2.2 Ω to 5.1 MΩ (J): 1 Ω and 5.2 MΩ have no rating; 5.1 MΩ has.
    for (const [ohms, bound] of [
      [1, 2.2],
      [5.2e6, 5.1e6],
    ] as const) {
      const w = at(0.5, ohms);
      expect(
        w.map((x) => [x.kind, x.code, x.value, x.limit]),
        String(ohms),
      ).toEqual([['unrated', 'resistance_outside_series', ohms, bound]]);
    }
    expect(at(5, 5.1e6)).toEqual([]);
    // 1 Ω carrying 1 A: still the out-of-series row, never a borrowed power rating.
    expect(at(1, 1).map((x) => x.code)).toEqual(['resistance_outside_series']);
    // The ½ W series is made from 1.0 Ω: rated there.
    expect(at(0.5, 1, 'model.resistor.koa_cfs_1_2')).toEqual([]);
  });
});
