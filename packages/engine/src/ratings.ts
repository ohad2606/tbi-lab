/**
 * Datasheet ABSOLUTE MAXIMUM RATINGS and the over-stress check (Sprint 5).
 *
 * These are not physics: the solver never uses them and never changes a number because of
 * them. They let the product say, honestly, "the solved operating point exceeds what the
 * manufacturer allows for this part; a real part would likely be damaged". Only parts whose
 * model card has a documented rating table are checked. Resistors carry no power rating in V1,
 * so no resistor warning is produced (that would need an invented limit).
 *
 * Every value is copied from the datasheet the model card already cites, at T_amb = 25 degC.
 */

import type { SimulationSnapshot } from '@tbi-lab/domain';
import type { SolveSuccess } from './session.js';

export interface AbsoluteMaximumRatings {
  /** Maximum DC forward current, amperes. */
  forwardCurrentA: number;
  /** Maximum reverse voltage (cathode above anode), volts. */
  reverseVoltageV: number;
  /** Maximum power dissipation, watts. */
  powerW: number;
  source: string;
}

export const MODEL_RATINGS: Readonly<Record<string, AbsoluteMaximumRatings>> = {
  'model.led.vishay_tlhr5400': {
    forwardCurrentA: 0.03,
    reverseVoltageV: 6,
    powerW: 0.1,
    source:
      'Vishay TLHR540./TLHY540. datasheet, Document 83012, Rev. 2.7 (25-Jan-2024), Absolute ' +
      'Maximum Ratings: V_R 6 V; DC forward current I_F 30 mA (T_amb <= 65 degC); power ' +
      'dissipation P_V 100 mW (T_amb <= 65 degC).',
  },
  'model.diode.vishay_1n4148': {
    forwardCurrentA: 0.3,
    reverseVoltageV: 75,
    powerW: 0.5,
    source:
      'Vishay 1N4148 datasheet, Document 81857, Rev. 1.6 (07-Nov-2024), Absolute Maximum ' +
      'Ratings: forward continuous current I_F 300 mA; reverse voltage V_R 75 V; power ' +
      'dissipation P_tot 500 mW (l = 4 mm, T_L <= 25 degC).',
  },
};

export type RatingCode = 'forward_current' | 'reverse_voltage' | 'power';

export interface RatingWarning {
  component: string;
  model: string;
  code: RatingCode;
  /** The solved value (A, V or W; reverse voltage as a positive number). */
  value: number;
  /** The datasheet limit in the same unit. */
  limit: number;
}

/** Parts whose solved operating point exceeds their datasheet absolute maximum ratings. */
export function ratingWarnings(
  snapshot: SimulationSnapshot,
  outcome: SolveSuccess,
): RatingWarning[] {
  const out: RatingWarning[] = [];
  for (const c of snapshot.components) {
    const model = c.params.model;
    if (typeof model !== 'string') continue;
    const rating = MODEL_RATINGS[model];
    const r = outcome.components[c.id];
    if (!rating || !r || r.current === null || r.voltage === null) continue;
    const add = (code: RatingCode, value: number, limit: number) =>
      out.push({ component: c.id, model, code, value, limit });
    if (r.current > rating.forwardCurrentA)
      add('forward_current', r.current, rating.forwardCurrentA);
    if (-r.voltage > rating.reverseVoltageV)
      add('reverse_voltage', -r.voltage, rating.reverseVoltageV);
    const power = Math.abs(r.voltage * r.current);
    if (power > rating.powerW) add('power', power, rating.powerW);
  }
  return out;
}
