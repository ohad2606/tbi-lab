/**
 * Sprint 10: the approved additional LED colour cards (product scope §6.1 LED row), built and
 * documented exactly like the red TLHR5400 card. Each must reproduce its datasheet anchor, solve
 * through the real session boundary to the same operating point as an independent bisection of
 * its Shockley equation, report the documented sensitivity to the assumed N, and carry its
 * datasheet absolute maximum ratings.
 */
import { describe, expect, it } from 'vitest';
import { createSnapshot } from '@tbi-lab/domain';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';
import {
  LED_TLHG4900,
  LED_TLHR5400,
  LED_TLHY5400,
  RED_LED_EMISSION_COEFFICIENT,
  TLHG4900_ANCHOR,
  TLHY5400_ANCHOR,
  fitSaturationCurrent,
  thermalVoltage,
  type DiodeModel,
} from '../src/models.js';
import { MODEL_CARDS, MODEL_VALID_CURRENT_A } from '../src/registry.js';
import { MODEL_RATINGS, ratingWarnings } from '../src/ratings.js';
import { Bench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
};
const shockley = (m: DiodeModel, v: number) =>
  m.saturationCurrentA *
  (Math.exp(v / (m.emissionCoefficient * thermalVoltage(m.temperatureK))) - 1);

/** Independent reference: bisection of V_s = V_j + R * I(V_j) for an ideal source (R_S = 0 cards). */
function reference(m: DiodeModel, supplyV: number, r: number) {
  let lo = 0;
  let hi = supplyV;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    if (supplyV - mid - r * shockley(m, mid) > 0) lo = mid;
    else hi = mid;
  }
  const vj = 0.5 * (lo + hi);
  return { vj, current: shockley(m, vj) };
}

/** PSU (CV, ample limit) → R → LED (given card) → GND, through the real session. */
function solve(model: string, volts: number, ohms: number) {
  const b = new Bench();
  const r = b.add('component.resistor');
  const d = b.add('component.led');
  b.wire('PSU1.positive', `${r}.a`)
    .wire(`${r}.b`, `${d}.anode`)
    .wire(`${d}.cathode`, 'GND1.ref')
    .wire('PSU1.negative', 'GND1.ref')
    .psu(volts, 1, true)
    .ohms(r, ohms)
    .set(d, 'model', model);
  const snapshot = createSnapshot(b.doc);
  return { snapshot, outcome: ok(new EngineSession(snapshot).solve()), d };
}

const CARDS = [
  { id: 'model.led.vishay_tlhy5400', card: LED_TLHY5400, anchor: TLHY5400_ANCHOR, doc: '83012' },
  { id: 'model.led.vishay_tlhg4900', card: LED_TLHG4900, anchor: TLHG4900_ANCHOR, doc: '83009' },
] as const;

describe('Sprint 10 LED colour cards', () => {
  it('each card reproduces its datasheet anchor exactly and is registered with its range', () => {
    for (const { id, card, anchor } of CARDS) {
      const i = shockley(card, anchor.forwardVoltageV);
      expect(Math.abs(i - anchor.forwardCurrentA) / anchor.forwardCurrentA).toBeLessThan(1e-12);
      expect(card.emissionCoefficient).toBe(RED_LED_EMISSION_COEFFICIENT);
      expect(card.seriesResistanceOhm).toBe(0);
      expect(card.provenance).toMatch(/Vishay/);
      expect(MODEL_CARDS[id]).toBe(card);
      expect(MODEL_VALID_CURRENT_A[id]).toEqual([1e-3, 20e-3]);
    }
  });

  it('solves through the session to the independent reference (1e-9 relative)', () => {
    for (const { id, card } of CARDS)
      for (const [v, r] of [
        [5, 150],
        [3.3, 68],
        [9, 470],
      ] as const) {
        const { outcome, d } = solve(id, v, r);
        const ref = reference(card, v, r);
        const got = outcome.components[d]!.current!;
        expect(Math.abs(got - ref.current) / ref.current, `${id} ${v} V ${r} ohm`).toBeLessThan(
          1e-9,
        );
      }
  });

  it('higher forward voltage than the red card: less current through the same resistor', () => {
    const red = solve('model.led.vishay_tlhr5400', 5, 150).outcome;
    for (const { id } of CARDS) {
      const { outcome, d } = solve(id, 5, 150);
      expect(outcome.components[d]!.current!).toBeLessThan(red.components.D1!.current!);
      // About (5 - 2.4) / 150 = 17.3 mA vs the red part's (5 - 2.0) / 150 = 20 mA.
      expect(outcome.components[d]!.current!).toBeGreaterThan(0.016);
      expect(outcome.components[d]!.current!).toBeLessThan(0.018);
    }
  });

  it('the assumed N moves the operating point by under 0.4 % across N = 1.8 .. 2.5 (reported, not hidden)', () => {
    for (const { card, anchor } of CARDS) {
      const at = (n: number) =>
        reference(
          {
            ...card,
            emissionCoefficient: n,
            saturationCurrentA: fitSaturationCurrent(
              anchor.forwardVoltageV,
              anchor.forwardCurrentA,
              n,
            ),
          },
          5,
          150,
        ).current;
      const base = at(RED_LED_EMISSION_COEFFICIENT);
      for (const n of [1.8, 2.0, 2.2, 2.5])
        expect(Math.abs(at(n) - base) / base).toBeLessThan(0.004);
    }
  });

  it('carries the datasheet absolute maximum ratings and flags an over-driven part', () => {
    for (const { id, doc } of CARDS) {
      expect(MODEL_RATINGS[id]).toMatchObject({
        forwardCurrentA: 0.03,
        reverseVoltageV: 6,
        powerW: 0.1,
      });
      expect(MODEL_RATINGS[id]!.source).toContain(doc);
      const { snapshot, outcome, d } = solve(id, 5, 47);
      const codes = ratingWarnings(snapshot, outcome)
        .filter((w) => w.component === d)
        .map((w) => w.code);
      expect(codes).toContain('forward_current');
    }
  });

  it('leaves the red card bit-for-bit unchanged', () => {
    expect(LED_TLHR5400.emissionCoefficient).toBe(RED_LED_EMISSION_COEFFICIENT);
    expect(shockley(LED_TLHR5400, 2.0)).toBeCloseTo(0.02, 15);
  });
});
