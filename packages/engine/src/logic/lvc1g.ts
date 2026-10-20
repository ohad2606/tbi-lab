/**
 * Logic family cards (Sprint 19B, Exploration Foundation L1): Texas Instruments SN74LVC1G
 * single-gate devices, SOT-23-5 (DBV) package. Every number below is a datasheet figure, from the
 * −40 °C to 85 °C column, cited per device (document, revision, table). Owner decisions applied:
 * - EF-D2 B: the 3.3 V-capable LVC1G family first;
 * - EF-D3 A: a figure is used only at the supply where the datasheet tabulates it. A row stated
 *   over a supply RANGE (e.g. V_IH = 2 V for V_CC = 3 V to 3.6 V) holds over that range; a
 *   proportional form (0.7 × V_CC) only where the datasheet states it. Between rows: refused;
 * - EF-D4 A: GUARANTEED (worst-case) output characteristics, never typical values.
 *
 * The output test points (V_OH at −16/−24 mA, V_OL at 16/24 mA) are tabulated at V_CC = 3 V
 * exactly (and 1.65, 2.3, 4.5 V). At other supplies the only guaranteed output point is the ranged
 * ±100 µA row (V_OH ≥ V_CC − 0.1 V, V_OL ≤ 0.1 V over 1.65–5.5 V). Applying the 3 V points across
 * the 3.3 V ± 0.3 V class is an owner decision (Sprint 19B report); it is NOT done here.
 */

/** A threshold as the datasheet states it: absolute volts, or a fraction of V_CC. */
export type Threshold = { v: number } | { k: number };

export interface InputRow {
  /** Supply range the row holds over, inclusive (V). */
  vcc: readonly [number, number];
  vih: Threshold;
  vil: Threshold;
}

/** One guaranteed output test point at a tabulated supply. */
export interface OutputPoint {
  /** |I_OH| or I_OL (A). */
  amps: number;
  /** V_OH min (high) or V_OL max (low), volts. */
  volts: number;
}

export interface OutputRow {
  /** The supply the points are tabulated at (V). */
  vcc: number;
  high: readonly OutputPoint[];
  low: readonly OutputPoint[];
}

export type LogicFunction = 'and' | 'nand' | 'or' | 'nor' | 'xor' | 'not';

export interface LogicCard {
  readonly partNumber: string;
  readonly function: LogicFunction;
  /** Manufacturer document, revision, and the tables the figures come from. */
  readonly source: string;
  /** Package and its pin numbers (DBV, SOT-23-5). */
  readonly pkg: string;
  readonly pins: Readonly<Record<string, number>>;
  /** Input terminals in function order. */
  readonly inputs: readonly string[];
  /** Recommended operating supply (V). */
  readonly vccOperating: readonly [number, number];
  /** Absolute maximum supply (V). */
  readonly vccAbsMax: number;
  readonly inputRows: readonly InputRow[];
  readonly outputRows: readonly OutputRow[];
  /** The ranged row: over this supply range, |I| ≤ amps gives V_OH ≥ V_CC − drop, V_OL ≤ low. */
  readonly rangedOutput: {
    vcc: readonly [number, number];
    amps: number;
    drop: number;
    low: number;
  };
  /** Recommended input voltage range and absolute maximum input range (V). */
  readonly inputRecommended: readonly [number, number];
  readonly inputAbsolute: readonly [number, number];
  /** Output voltage absolute maximum in the high or low state: V_CC + this (V). */
  readonly outputAbsAboveVcc: number;
  /** Absolute maximum continuous output current, and through V_CC or GND (A). */
  readonly outputAbsA: number;
  readonly supplyPinAbsA: number;
  /** Input leakage I_I bound (A); power-off leakage I_off (A); quiescent I_CC max (A). */
  readonly inputLeakageA: number;
  readonly ioffA: number;
  readonly iccMaxA: number;
  /** Input capacitance, typical (F): carried for the time kernel, not used at DC. */
  readonly ciF: number;
  /** Propagation delay at V_CC = 3.3 V ± 0.3 V, C_L = 15 pF: [min, max] (s). Not simulated in L1. */
  readonly tpd33: readonly [number, number];
}

/** The figures every SN74LVC1G push-pull gate of this set shares (identical in each sheet). */
const LVC1G_COMMON = {
  vccOperating: [1.65, 5.5] as const,
  vccAbsMax: 6.5,
  inputRows: [
    { vcc: [1.65, 1.95], vih: { k: 0.65 }, vil: { k: 0.35 } },
    { vcc: [2.3, 2.7], vih: { v: 1.7 }, vil: { v: 0.7 } },
    { vcc: [3.0, 3.6], vih: { v: 2.0 }, vil: { v: 0.8 } },
    { vcc: [4.5, 5.5], vih: { k: 0.7 }, vil: { k: 0.3 } },
  ] as readonly InputRow[],
  outputRows: [
    { vcc: 1.65, high: [{ amps: 4e-3, volts: 1.2 }], low: [{ amps: 4e-3, volts: 0.45 }] },
    { vcc: 2.3, high: [{ amps: 8e-3, volts: 1.9 }], low: [{ amps: 8e-3, volts: 0.3 }] },
    {
      vcc: 3.0,
      high: [
        { amps: 16e-3, volts: 2.4 },
        { amps: 24e-3, volts: 2.3 },
      ],
      low: [
        { amps: 16e-3, volts: 0.4 },
        { amps: 24e-3, volts: 0.55 },
      ],
    },
    { vcc: 4.5, high: [{ amps: 32e-3, volts: 3.8 }], low: [{ amps: 32e-3, volts: 0.55 }] },
  ] as readonly OutputRow[],
  rangedOutput: { vcc: [1.65, 5.5] as const, amps: 100e-6, drop: 0.1, low: 0.1 },
  inputRecommended: [0, 5.5] as const,
  inputAbsolute: [-0.5, 6.5] as const,
  outputAbsAboveVcc: 0.5,
  outputAbsA: 50e-3,
  supplyPinAbsA: 100e-3,
  inputLeakageA: 5e-6,
  ioffA: 10e-6,
  iccMaxA: 10e-6,
};

const TABLES =
  '§5.1 Absolute Maximum Ratings, §5.3 Recommended Operating Conditions, §5.5 Electrical Characteristics (−40 °C to 85 °C), §5.6 Switching Characteristics C_L = 15 pF';

/** Two-input gates: DBV pins A 1, B 2, GND 3, Y 4, V_CC 5 (each sheet's Pin Functions table). */
const TWO_INPUT = { a: 1, b: 2, gnd: 3, y: 4, vcc: 5 } as const;

export const LVC1G_CARDS: Readonly<Record<string, LogicCard>> = {
  'model.logic.sn74lvc1g08': {
    partNumber: 'SN74LVC1G08',
    function: 'and',
    source: `Texas Instruments SCES217AA (April 1999, revised August 2026), ${TABLES}`,
    pkg: 'SOT-23-5 (DBV)',
    pins: TWO_INPUT,
    inputs: ['a', 'b'],
    ...LVC1G_COMMON,
    ciF: 4e-12,
    tpd33: [0.8e-9, 3.6e-9],
  },
  'model.logic.sn74lvc1g00': {
    partNumber: 'SN74LVC1G00',
    function: 'nand',
    source: `Texas Instruments SCES212AC (revised August 2026), ${TABLES}`,
    pkg: 'SOT-23-5 (DBV)',
    pins: TWO_INPUT,
    inputs: ['a', 'b'],
    ...LVC1G_COMMON,
    ciF: 4e-12,
    tpd33: [0.8e-9, 3.8e-9],
  },
  'model.logic.sn74lvc1g32': {
    partNumber: 'SN74LVC1G32',
    function: 'or',
    source: `Texas Instruments SCES219W (revised August 2026), ${TABLES}`,
    pkg: 'SOT-23-5 (DBV)',
    pins: TWO_INPUT,
    inputs: ['a', 'b'],
    ...LVC1G_COMMON,
    ciF: 4e-12,
    tpd33: [0.9e-9, 3.6e-9],
  },
  'model.logic.sn74lvc1g04': {
    partNumber: 'SN74LVC1G04',
    function: 'not',
    source: `Texas Instruments SCES214AF (revised October 2025), ${TABLES}`,
    pkg: 'SOT-23-5 (DBV)',
    // DBV: NC 1, A 2, GND 3, Y 4, V_CC 5.
    pins: { a: 2, gnd: 3, y: 4, vcc: 5 },
    inputs: ['a'],
    ...LVC1G_COMMON,
    ciF: 3.5e-12,
    tpd33: [0.7e-9, 3.3e-9],
  },
};

/** The logic function's output for defined inputs. */
export function evaluate(fn: LogicFunction, ins: readonly boolean[]): boolean {
  switch (fn) {
    case 'and':
      return ins.every(Boolean);
    case 'nand':
      return !ins.every(Boolean);
    case 'or':
      return ins.some(Boolean);
    case 'nor':
      return !ins.some(Boolean);
    case 'xor':
      return ins.filter(Boolean).length % 2 === 1;
    case 'not':
      return !ins[0];
  }
}

const level = (t: Threshold, vcc: number) => ('v' in t ? t.v : t.k * vcc);

/** The input row that covers this supply, or undefined (a gap between rows: EF-D3 A). */
export function inputRowAt(card: LogicCard, vcc: number): { vih: number; vil: number } | undefined {
  const row = card.inputRows.find((r) => vcc >= r.vcc[0] - 1e-9 && vcc <= r.vcc[1] + 1e-9);
  return row ? { vih: level(row.vih, vcc), vil: level(row.vil, vcc) } : undefined;
}

/** Tolerance for "at a tabulated supply point" (V): a set-point equal to the row, not near it. */
export const TABULATED_VCC_TOLERANCE_V = 1e-3;

/**
 * The guaranteed output stage at this supply (EF-D4 A):
 * - at a tabulated point: a resistor from the part's own V_CC (high) or to its own GND (low)
 *   through the HIGHEST-current guaranteed point, valid up to that current;
 * - elsewhere in the operating range: the ranged ±100 µA row, valid up to 100 µA.
 * Returns the resistances and the current up to which each is the guaranteed characteristic.
 */
export function outputStageAt(
  card: LogicCard,
  vcc: number,
): { rHigh: number; rLow: number; validA: number; tabulated: boolean } {
  const row = card.outputRows.find((r) => Math.abs(r.vcc - vcc) <= TABULATED_VCC_TOLERANCE_V);
  if (row) {
    const hi = row.high.reduce((a, b) => (b.amps > a.amps ? b : a));
    const lo = row.low.reduce((a, b) => (b.amps > a.amps ? b : a));
    return {
      rHigh: (row.vcc - hi.volts) / hi.amps,
      rLow: lo.volts / lo.amps,
      validA: Math.min(hi.amps, lo.amps),
      tabulated: true,
    };
  }
  const r = card.rangedOutput;
  return { rHigh: r.drop / r.amps, rLow: r.low / r.amps, validA: r.amps, tabulated: false };
}
