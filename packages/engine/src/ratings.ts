/**
 * Datasheet ABSOLUTE MAXIMUM RATINGS and the over-stress check (Sprint 5).
 *
 * These are not physics: the solver never uses them and never changes a number because of
 * them. They let the product say, honestly, "the solved operating point exceeds what the
 * manufacturer allows for this part; a real part would likely be damaged". Only parts whose
 * model card has a documented rating table are checked. Sprint 19B (F2): resistors carry the
 * rating of a verified datasheet series (resistorRating.ts), ¼ W by default.
 *
 * Every value is copied from the datasheet the model card already cites, at T_amb = 25 degC.
 */

import type { SimulationSnapshot } from '@tbi-lab/domain';
import {
  I_OL_A,
  I_OUTPUT_CUMULATIVE_MAX_A,
  V_PIN_MAX_V,
  V_PIN_MIN_V,
  typicalSourceA,
} from './esp32Gpio.js';
import { partModel } from './parts.js';
import { resistorRating, resistorSeriesRange } from './resistorRating.js';
import type { SolveSuccess } from './session.js';
import type { LimitKind } from './parts.js';

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
  'model.led.vishay_tlhy5400': {
    forwardCurrentA: 0.03,
    reverseVoltageV: 6,
    powerW: 0.1,
    source:
      'Vishay TLHR540./TLHY540. datasheet, Document 83012, Rev. 2.7 (25-Jan-2024), Absolute ' +
      'Maximum Ratings (TLHR540., TLHY540.): V_R 6 V; DC forward current I_F 30 mA ' +
      '(T_amb <= 65 degC); power dissipation P_V 100 mW (T_amb <= 65 degC).',
  },
  'model.led.vishay_tlhg4900': {
    forwardCurrentA: 0.03,
    reverseVoltageV: 6,
    powerW: 0.1,
    source:
      'Vishay TLHR4900, TLHG4900 datasheet, Document 83009, Rev. 2.7 (21-Jul-2022), Absolute ' +
      'Maximum Ratings: V_R 6 V; DC forward current I_F 30 mA (T_amb <= 60 degC); power ' +
      'dissipation P_V 100 mW (T_amb <= 60 degC).',
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

export type RatingCode =
  | 'forward_current'
  | 'reverse_voltage'
  | 'power'
  /** Sprint 10 parts: a voltage or current beyond a documented maximum (a relay coil, a buzzer). */
  | 'voltage'
  | 'current'
  // Sprint 10: ESP32 pads (the board's datasheet drive specification, esp32Gpio.ts).
  /** An output-HIGH pad sources more than I_OH. */
  | 'gpio_source_current'
  /** An output-LOW pad sinks more than I_OL. */
  | 'gpio_sink_current'
  /** Two pads on one net drive opposite levels: the drivers fight. */
  | 'gpio_contention'
  /** An output-HIGH pad is wired straight to GND. */
  | 'gpio_short_ground'
  /** An output-LOW pad is wired straight to a supply's + terminal. */
  | 'gpio_short_supply'
  // Sprint 11 (R1): the pad's specified voltage range (datasheet Table 5-3, esp32Gpio.ts).
  /** An input pad's solved voltage is above VDD + 0.3 V or below -0.3 V (not 5 V tolerant). */
  | 'gpio_input_overvoltage'
  /** An output pad is forced beyond that range by the external circuit (current into the driver). */
  | 'gpio_output_overvoltage'
  /** Sprint 13 H2: the pads' total output current is above the Table 5-1 absolute maximum. */
  | 'gpio_cumulative_current'
  /**
   * Sprint 19B (F2 review): a resistor value the selected series is not made in: NO power or
   * voltage rating applies (value: the resistance; limit: the series bound it is beyond).
   */
  | 'resistance_outside_series';

/** The unit each warning's `value` and `limit` are in. */
export const RATING_UNIT: Readonly<Record<RatingCode, 'ampere' | 'volt' | 'watt' | 'ohm'>> = {
  forward_current: 'ampere',
  reverse_voltage: 'volt',
  power: 'watt',
  voltage: 'volt',
  current: 'ampere',
  gpio_source_current: 'ampere',
  gpio_sink_current: 'ampere',
  gpio_contention: 'ampere',
  gpio_short_ground: 'ampere',
  gpio_short_supply: 'ampere',
  gpio_input_overvoltage: 'volt',
  gpio_output_overvoltage: 'volt',
  gpio_cumulative_current: 'ampere',
  resistance_outside_series: 'ohm',
};

export interface RatingWarning {
  component: string;
  /** Sprint 13 H2: damage risk (`absolute`) or outside the specified operating range only. */
  kind: LimitKind;
  /** The model card, or for a board pad the board type. */
  model: string;
  code: RatingCode;
  /** The solved value (A, V or W; reverse voltage and sink current as positive numbers). */
  value: number;
  /** The datasheet limit in the same unit. */
  limit: number;
  /** Board pads only: the GPIO the row is about. */
  gpio?: number;
  /** Contention only: the other GPIO driving the same net. */
  otherGpio?: number;
  /** Sprint 10 parts: the element of the part the row is about (an RGB channel, a relay coil). */
  channel?: string;
  /**
   * Sprint 13 P2: present (true) when `value` comes from a pad operating beyond its characterized
   * point (PinResult.outsideModelRange): the condition is real, the number is an extrapolation of
   * the linear driver model and must not be presented as the physical value.
   */
  unreliable?: true;
}

/** Parts whose solved operating point exceeds their datasheet absolute maximum ratings. */
export function ratingWarnings(
  snapshot: SimulationSnapshot,
  outcome: SolveSuccess,
): RatingWarning[] {
  const out: RatingWarning[] = [];
  for (const c of snapshot.components) {
    const part = partModel(c.type);
    if (part) {
      // Sprint 10 parts: their own datasheet checks.
      const r = outcome.components[c.id];
      if (r && part.ratings)
        for (const x of part.ratings(c.params, r))
          out.push({
            component: c.id,
            model: String(c.params.model),
            kind: x.kind ?? 'absolute',
            code: x.code,
            value: x.value,
            limit: x.limit,
            ...(x.channel ? { channel: x.channel } : {}),
          });
      continue;
    }
    if (c.type === 'component.resistor') {
      // Sprint 19B (F2): power above the derated series rating is `unrated` (no damage threshold
      // is published); above the absolute-maximum working voltage, `absolute`.
      const rating = resistorRating(c.params);
      const r = outcome.components[c.id];
      if (!rating) {
        // A value the series is not made in: said by name (no rating borrowed, none silently
        // dropped), whatever the dissipation.
        const range = resistorSeriesRange(c.params);
        if (range)
          out.push({
            component: c.id,
            kind: 'unrated',
            model: range.series,
            code: 'resistance_outside_series',
            value: range.ohms,
            limit: range.ohms < range.rangeOhm[0] ? range.rangeOhm[0] : range.rangeOhm[1],
          });
        continue;
      }
      if (!r || r.current === null || r.voltage === null) continue;
      const power = Math.abs(r.voltage * r.current);
      if (power > rating.ratedW)
        out.push({
          component: c.id,
          kind: 'unrated',
          model: rating.series,
          code: 'power',
          value: power,
          limit: rating.ratedW,
        });
      if (Math.abs(r.voltage) > rating.card.maxWorkingV)
        out.push({
          component: c.id,
          kind: 'absolute',
          model: rating.series,
          code: 'voltage',
          value: Math.abs(r.voltage),
          limit: rating.card.maxWorkingV,
        });
      continue;
    }
    const model = c.params.model;
    if (typeof model !== 'string') continue;
    const rating = MODEL_RATINGS[model];
    const r = outcome.components[c.id];
    if (!rating || !r || r.current === null || r.voltage === null) continue;
    const add = (code: RatingCode, value: number, limit: number) =>
      out.push({ component: c.id, kind: 'absolute', model, code, value, limit });
    if (r.current > rating.forwardCurrentA)
      add('forward_current', r.current, rating.forwardCurrentA);
    if (-r.voltage > rating.reverseVoltageV)
      add('reverse_voltage', -r.voltage, rating.reverseVoltageV);
    const power = Math.abs(r.voltage * r.current);
    if (power > rating.powerW) add('power', power, rating.powerW);
  }
  return [...out, ...gpioWarnings(snapshot, outcome)];
}

/**
 * ESP32 pads in an electrically unsafe configuration (Sprint 10). The solved values are the
 * engine's, unchanged; this only classifies them against the datasheet drive specification the
 * pad model is built from (I_OH 40 mA source, I_OL 28 mA sink: esp32Gpio.ts). One row per pad,
 * the most specific that applies:
 * - two pads on one net driving opposite levels (contention);
 * - an output-HIGH pad on the GND net, or an output-LOW pad on a supply's + net (a short);
 * - an output pad forced beyond the specified pad voltage range by the external circuit (Sprint 11);
 * - otherwise a pad sourcing more than I_OH or sinking more than I_OL;
 * - an INPUT pad outside the specified voltage range (Sprint 11: e.g. a 5 V divider into a pin).
 * The range is the datasheet's (V_PIN_MIN_V ... V_PIN_MAX_V, esp32Gpio.ts). These are electrical
 * RISK warnings on an operating point that was solved; they never alter a value, and they are not
 * unsupported-simulation states (those refuse or stop the run instead).
 * Experimentation is not prevented: the circuit keeps running and showing what it solves.
 */
function gpioWarnings(snapshot: SimulationSnapshot, outcome: SolveSuccess): RatingWarning[] {
  if (!outcome.pins?.length) return [];
  const board = snapshot.components.find((c) => c.type.startsWith('board.'));
  // Server sessions solve a projection without the board; the browser's snapshot has it.
  if (!board) return [];
  const netOfGpio = new Map<number, string>();
  for (const conn of snapshot.connections) {
    const m = conn.component === board.id ? /^gpio(\d+)$/.exec(conn.terminal) : null;
    if (m) netOfGpio.set(Number(m[1]), conn.net);
  }
  const ground = new Set(snapshot.nets.filter((n) => n.role === 'ground').map((n) => n.id));
  const supplyPlus = new Set(
    snapshot.connections
      .filter((conn) => {
        const c = snapshot.components.find((x) => x.id === conn.component);
        return c?.type === 'instrument.lab_psu' && conn.terminal === 'positive';
      })
      .map((conn) => conn.net),
  );
  const out: RatingWarning[] = [];
  // Sprint 13 H2: Table 5-3 values are characteristics with no per-pin absolute maximum
  // (Table 5-1): every per-pin row is `unrated` (damage threshold unknown, not safe).
  const unreliableGpio = new Set(
    outcome.pins.filter((p) => p.outsideModelRange).map((p) => p.gpio),
  );
  const add = (code: RatingCode, gpio: number, value: number, limit: number, other?: number) =>
    out.push({
      component: board.id,
      kind: 'unrated',
      model: board.type,
      code,
      value,
      limit,
      gpio,
      ...(other === undefined ? {} : { otherGpio: other }),
      ...(unreliableGpio.has(gpio) || (other !== undefined && unreliableGpio.has(other))
        ? { unreliable: true as const }
        : {}),
    });
  const outside = (v: number) => v > V_PIN_MAX_V || v < V_PIN_MIN_V;
  const limitFor = (v: number) => (v > V_PIN_MAX_V ? V_PIN_MAX_V : V_PIN_MIN_V);
  for (const pin of outcome.pins) {
    if (pin.mode === 'input') {
      if (outside(pin.voltage))
        add('gpio_input_overvoltage', pin.gpio, pin.voltage, limitFor(pin.voltage));
      continue;
    }
    const high = pin.mode === 'output-high';
    const net = netOfGpio.get(pin.gpio);
    const limit = high ? typicalSourceA(pin.gpio) : I_OL_A;
    const magnitude = Math.abs(pin.current);
    const rival = outcome.pins.find(
      (q) =>
        q.gpio !== pin.gpio &&
        net !== undefined &&
        netOfGpio.get(q.gpio) === net &&
        q.mode === (high ? 'output-low' : 'output-high'),
    );
    if (rival) add('gpio_contention', pin.gpio, magnitude, limit, rival.gpio);
    else if (high && net !== undefined && ground.has(net))
      add('gpio_short_ground', pin.gpio, magnitude, limit);
    else if (!high && net !== undefined && supplyPlus.has(net))
      add('gpio_short_supply', pin.gpio, magnitude, limit);
    else if (outside(pin.voltage))
      add('gpio_output_overvoltage', pin.gpio, pin.voltage, limitFor(pin.voltage));
    else if (high && pin.current > limit) add('gpio_source_current', pin.gpio, pin.current, limit);
    else if (!high && -pin.current > I_OL_A)
      add('gpio_sink_current', pin.gpio, -pin.current, limit);
  }
  // Table 5-1 (absolute maximum): the cumulative IO output current, 1200 mA.
  const driven = outcome.pins.filter((p) => p.mode !== 'input');
  const total = driven.reduce((a, p) => a + Math.abs(p.current), 0);
  if (total > I_OUTPUT_CUMULATIVE_MAX_A)
    out.push({
      component: board.id,
      kind: 'absolute',
      model: board.type,
      code: 'gpio_cumulative_current',
      value: total,
      limit: I_OUTPUT_CUMULATIVE_MAX_A,
      // A sum including an extrapolated pad current is not a physical total either (P2).
      ...(driven.some((p) => p.outsideModelRange) ? { unreliable: true as const } : {}),
    });
  return out;
}
