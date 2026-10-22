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
 * exactly (and 1.65, 2.3, 4.5 V). At other supplies the guaranteed output points are the ranged
 * ±100 µA row (V_OH ≥ V_CC − 0.1 V, V_OL ≤ 0.1 V over 1.65–5.5 V) and, owner decision PM-1
 * (2026-10-22: "only where the manufacturer's specifications or justified conservative bounds
 * support it"), over the 3.3 V ± 0.3 V class the 3 V points as a CONSERVATIVE BOUND (`classVcc`).
 * Proof, identical in each of the four sheets (SCES212AC, SCES214AF, SCES217AA, SCES219W):
 *   - Features: "±24-mA output drive at 3.3 V" (the manufacturer's own drive claim at 3.3 V);
 *   - the 3 V rows are that class's: V_IH/V_IL are specified for "V_CC = 3 V to 3.6 V" and Δt/Δv
 *     for "V_CC = 3.3 V ± 0.3 V"; the output rows are stated at its lowest supply, 3 V;
 *   - drive never decreases with supply (the rows' own trend: I_OH −4 / −8 / −24 / −32 mA at
 *     1.65 / 2.3 / 3 / 4.5 V, with the same or higher V_OH at higher V_CC).
 * The bound keeps the ABSOLUTE guaranteed V_OH minima (2.4 V at 16 mA, 2.3 V at 24 mA) and V_OL
 * maxima (0.4 V, 0.55 V) for any V_CC in 3.0–3.6 V: never better than at 3 V (the most
 * conservative reading; a real part at 3.3 V drives at least this well). Beyond 24 mA: refused.
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
  /**
   * PM-1: the supply class over which these points hold as a conservative bound (absolute V_OH
   * minima, V_OL maxima), when the sheet states the class (see the module comment).
   */
  classVcc?: readonly [number, number];
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
  /**
   * Input leakage I_I bound (A); power-off leakage I_off (A); quiescent I_CC max (A). `ioffA` is
   * absent when the datasheet gives no power-off specification (SN74LVC08A): an unpowered device
   * is then refused, never assumed off.
   */
  readonly inputLeakageA: number;
  readonly ioffA?: number;
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
      classVcc: [3.0, 3.6],
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

/**
 * The input row that covers this supply, or undefined (a gap between rows: EF-D3 A). Where two
 * rows share a boundary supply (SN74LVC08A: 2.3–2.7 V and 2.7–3.6 V both include 2.7 V), the
 * stricter of the two applies: the higher V_IH and the lower V_IL (the narrower defined bands).
 */
export function inputRowAt(card: LogicCard, vcc: number): { vih: number; vil: number } | undefined {
  const rows = card.inputRows.filter((r) => vcc >= r.vcc[0] - 1e-9 && vcc <= r.vcc[1] + 1e-9);
  if (!rows.length) return undefined;
  return {
    vih: Math.max(...rows.map((r) => level(r.vih, vcc))),
    vil: Math.min(...rows.map((r) => level(r.vil, vcc))),
  };
}

/**
 * "At a tabulated supply point" (V): the solved supply equals the row's V_CC up to numerical
 * resolution (an ideal supply set to that value), never "near" it (EF-D3 A).
 */
export const TABULATED_VCC_TOLERANCE_V = 1e-6;

/**
 * The guaranteed output stage at this supply (EF-D4 A), as I(V) points through (0, 0) for a
 * piecewise-linear element: for HIGH, V is the drop from the part's own V_CC pin to Y; for LOW,
 * the rise from its own GND pin to Y. Each point is a guaranteed test point (V_CC − V_OH min, or
 * V_OL max, at its current), so the element passes EXACTLY through every guaranteed point: the
 * worst-case characteristic, never better than the datasheet guarantees.
 * - at a tabulated supply: the ranged ±100 µA point and every point of that row;
 * - elsewhere in the operating range: only the ranged point (valid up to 100 µA).
 * `validA`: the largest guaranteed current; beyond it there is no characteristic (refused).
 */
export function outputStageAt(
  card: LogicCard,
  vcc: number,
): {
  high: (readonly [number, number])[];
  low: (readonly [number, number])[];
  validA: number;
  tabulated: boolean;
  /** Which guarantee applies: the tabulated points, the class bound (PM-1), or the ranged row. */
  model: 'tabulated' | 'class' | 'ranged';
} {
  const r = card.rangedOutput;
  const ranged = [r.amps, r.drop, r.low] as const;
  const exact = card.outputRows.find((x) => Math.abs(x.vcc - vcc) <= TABULATED_VCC_TOLERANCE_V);
  const classRow = exact
    ? undefined
    : card.outputRows.find(
        (x) =>
          x.classVcc &&
          vcc >= x.classVcc[0] - TABULATED_VCC_TOLERANCE_V &&
          vcc <= x.classVcc[1] + TABULATED_VCC_TOLERANCE_V,
      );
  const row = exact ?? classRow;
  const sorted = (pts: (readonly [number, number])[]) => pts.sort((a, b) => a[1] - b[1]);
  if (!row)
    return {
      high: [[ranged[1], ranged[0]]],
      low: [[ranged[2], ranged[0]]],
      validA: r.amps,
      tabulated: false,
      model: 'ranged',
    };
  // HIGH as a drop from THIS supply to the guaranteed V_OH minimum (absolute volts: for the class
  // bound, the 3 V minimum applies unchanged at every supply of the class).
  const high = sorted([
    [ranged[1], ranged[0]],
    ...row.high.map((p) => [vcc - p.volts, p.amps] as const),
  ]);
  const low = sorted([[ranged[2], ranged[0]], ...row.low.map((p) => [p.volts, p.amps] as const)]);
  const validA = Math.min(
    Math.max(...row.high.map((p) => p.amps)),
    Math.max(...row.low.map((p) => p.amps)),
  );
  return { high, low, validA, tabulated: !!exact, model: exact ? 'tabulated' : 'class' };
}
