/**
 * Sprint 5 pre-push: over-stress warnings come only from documented datasheet absolute maximum
 * ratings, never change a solved number, and are never produced without a documented rating.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, MODEL_RATINGS, ratingWarnings, type SolveSuccess } from '../src/index.js';
import { Bench } from './build.js';

function loop(
  part: 'component.led' | 'component.diode',
  volts: number,
  ohms: number,
  limit = 1,
  reversed = false,
) {
  const b = new Bench();
  const r = b.add('component.resistor');
  const d = b.add(part);
  const [toR, toGnd] = reversed ? ['cathode', 'anode'] : ['anode', 'cathode'];
  b.wire('PSU1.positive', `${r}.a`)
    .wire(`${r}.b`, `${d}.${toR}`)
    .wire(`${d}.${toGnd}`, 'GND1.ref')
    .wire('PSU1.negative', 'GND1.ref')
    .psu(volts, limit)
    .ohms(r, ohms);
  const snapshot = b.snapshot();
  const o = new EngineSession(snapshot).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return { snapshot, outcome: o as SolveSuccess, d };
}

describe('datasheet ratings', () => {
  it('are the documented Vishay values, with their source', () => {
    expect(MODEL_RATINGS['model.led.vishay_tlhr5400']).toMatchObject({
      forwardCurrentA: 0.03,
      reverseVoltageV: 6,
      powerW: 0.1,
    });
    expect(MODEL_RATINGS['model.led.vishay_tlhr5400']!.source).toMatch(/83012, Rev\. 2\.7/);
    expect(MODEL_RATINGS['model.diode.vishay_1n4148']).toMatchObject({
      forwardCurrentA: 0.3,
      reverseVoltageV: 75,
      powerW: 0.5,
    });
    expect(MODEL_RATINGS['model.diode.vishay_1n4148']!.source).toMatch(/81857, Rev\. 1\.6/);
  });
});

describe('ratingWarnings', () => {
  it('a normal LED circuit (5 V, 220 Ω, ~13.7 mA) has no warning', () => {
    const { snapshot, outcome } = loop('component.led', 5, 220);
    expect(ratingWarnings(snapshot, outcome)).toEqual([]);
  });

  it('an LED driven past 30 mA and 100 mW is flagged with the solved values', () => {
    const { snapshot, outcome, d } = loop('component.led', 5, 47);
    const r = outcome.components[d]!;
    const w = ratingWarnings(snapshot, outcome);
    expect(w).toContainEqual({
      component: d,
      kind: 'absolute',
      model: 'model.led.vishay_tlhr5400',
      code: 'forward_current',
      value: r.current,
      limit: 0.03,
    });
    expect(w).toContainEqual({
      component: d,
      kind: 'absolute',
      model: 'model.led.vishay_tlhr5400',
      code: 'power',
      value: Math.abs(r.current! * r.voltage!),
      limit: 0.1,
    });
  });

  it('an LED reversed across 9 V exceeds its 6 V reverse rating', () => {
    const { snapshot, outcome, d } = loop('component.led', 9, 1000, 1, true);
    const w = ratingWarnings(snapshot, outcome);
    expect(w.map((x) => x.code)).toEqual(['reverse_voltage']);
    expect(w[0]!.value).toBeCloseTo(-outcome.components[d]!.voltage!, 12);
    expect(w[0]!.limit).toBe(6);
  });

  it('a 1N4148 past 300 mA is flagged; at 30 V reverse it is within its 75 V rating', () => {
    const hot = loop('component.diode', 5, 10);
    expect(ratingWarnings(hot.snapshot, hot.outcome).map((x) => x.code)).toContain(
      'forward_current',
    );
    const rev = loop('component.diode', 30, 1000, 1, true);
    expect(ratingWarnings(rev.snapshot, rev.outcome)).toEqual([]);
  });

  it('Sprint 19B (F2): a resistor driven beyond its ¼ W series rating is flagged `unrated` (no damage claimed)', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref');
    b.psu(30, 5).ohms(r, 10); // 3 A, 90 W, far above KOA CF1/4's 0.25 W
    const snapshot = b.snapshot();
    const o = new EngineSession(snapshot).solve() as SolveSuccess;
    expect(o.components[r]!.current).toBeCloseTo(3, 12);
    const w = ratingWarnings(snapshot, o);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ component: r, kind: 'unrated', code: 'power', limit: 0.25 });
    expect(w[0]!.value).toBeCloseTo(90, 9);
  });

  it('is a pure check: the solved outcome is unchanged', () => {
    const { snapshot, outcome } = loop('component.led', 5, 47);
    const before = structuredClone(outcome);
    ratingWarnings(snapshot, outcome);
    expect(outcome).toEqual(before);
  });
});
