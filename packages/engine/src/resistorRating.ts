/**
 * Sprint 19B (Component Failure Framework, owner decision F2): resistor power ratings from a
 * verified datasheet series, with its temperature derating. KOA Speer CF carbon film leaded
 * resistors, catalog p.142–143 (koaspeer.com/pdfs/CF.pdf, sheet dated 10/28/30), "applications
 * and ratings" table and derating curve:
 * - CF1/4: 0.25 W at 70 °C; absolute maximum working voltage 300 V; absolute maximum overload
 *   voltage 600 V; E-24 J (±5 %) range 2.2 Ω – 5.1 MΩ;
 * - CFS1/2: 0.50 W at 70 °C; 350 V working; 700 V overload; J range 1.0 Ω – 5.1 MΩ;
 * - derating (both): 100 % from −55 °C to 70 °C, linearly to 0 % at 155 °C; operating
 *   temperature −55 °C to +155 °C.
 *
 * What the ratings MEAN (no damage is inferred):
 * - dissipation above the derated power is outside the specified operating conditions, and the
 *   series publishes no continuous damage threshold: an `unrated` excess (risk unknown, never
 *   shown as safe), not a failure;
 * - the absolute-maximum working voltage is a published absolute maximum: `absolute`;
 * - the series' short-time overload test (2.5 × rated voltage or the overload voltage, 5 s,
 *   ΔR ≤ ±1 %) is a survival test, not a failure threshold: no irreversible failure is ever
 *   claimed from a rating excess.
 * The engine's results are at 25 °C (DC models), so the rating applies at a 25 °C ambient.
 */

export interface ResistorSeries {
  readonly partPrefix: string;
  readonly ratedPowerW: number;
  readonly maxWorkingV: number;
  readonly maxOverloadV: number;
  /** E-24 (J ±5 %) resistance range the series is made in, Ω. */
  readonly rangeOhm: readonly [number, number];
  readonly source: string;
}

const KOA_CF =
  'KOA Speer CF carbon film leaded resistors, catalog p.143 (koaspeer.com/pdfs/CF.pdf), applications and ratings table and derating curve';

export const RESISTOR_SERIES: Readonly<Record<string, ResistorSeries>> = {
  'model.resistor.koa_cf_1_4': {
    partPrefix: 'CF1/4',
    ratedPowerW: 0.25,
    maxWorkingV: 300,
    maxOverloadV: 600,
    rangeOhm: [2.2, 5.1e6],
    source: KOA_CF,
  },
  'model.resistor.koa_cfs_1_2': {
    partPrefix: 'CFS1/2',
    ratedPowerW: 0.5,
    maxWorkingV: 350,
    maxOverloadV: 700,
    rangeOhm: [1.0, 5.1e6],
    source: KOA_CF,
  },
};

/** F2: the ¼ W series is the default (a resistor with no `powerRating` parameter). */
export const DEFAULT_RESISTOR_SERIES = 'model.resistor.koa_cf_1_4';

/** The ambient the engine's DC results hold at (°C). */
export const RATING_AMBIENT_C = 25;

/**
 * The derated power at an ambient temperature (W): the full rating up to 70 °C, linearly to 0 at
 * 155 °C; outside the −55 … 155 °C operating range, no rating (0).
 */
export function deratedPowerW(series: ResistorSeries, ambientC: number): number {
  if (ambientC < -55 || ambientC > 155) return 0;
  if (ambientC <= 70) return series.ratedPowerW;
  return (series.ratedPowerW * (155 - ambientC)) / (155 - 70);
}

/**
 * The rating that applies to a resistor's parameters, or null when the selected series is not
 * made in that value (no rating is borrowed from a part that does not exist).
 */
export function resistorRating(params: Readonly<Record<string, unknown>>): {
  series: string;
  card: ResistorSeries;
  ratedW: number;
} | null {
  const series =
    typeof params.powerRating === 'string' ? params.powerRating : DEFAULT_RESISTOR_SERIES;
  const card = RESISTOR_SERIES[series];
  const r = params.resistance as { value?: unknown } | undefined;
  const ohms = typeof r?.value === 'number' ? r.value : NaN;
  if (!card || !(ohms >= card.rangeOhm[0] && ohms <= card.rangeOhm[1])) return null;
  return { series, card, ratedW: deratedPowerW(card, RATING_AMBIENT_C) };
}
