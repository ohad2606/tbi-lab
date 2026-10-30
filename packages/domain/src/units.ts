/**
 * Unit-aware value input. Locale-independent by design: the same text parses to the same
 * SI number under every UI locale, and `.` is the only decimal separator (`,` is refused as
 * ambiguous rather than guessed).
 *
 * Accepted forms (for a quantity whose canonical unit is U):
 *   220 · 1k · 1.5k · 4k7 (RKM) · 4R7 (RKM, ohm only) · 10 k · 1kΩ · 1k ohm · 3.3V · 100mA
 * SI prefixes: p n u µ m k M G (case-sensitive: `m` is milli, `M` is mega).
 */

import type { UnitId } from './schema.js';

const PREFIX_EXPONENT: Record<string, number> = {
  p: -12,
  n: -9,
  u: -6,
  µ: -6,
  μ: -6,
  m: -3,
  k: 3,
  K: 3,
  M: 6,
  G: 9,
};

/** Accepted unit spellings per canonical unit (matched case-insensitively). */
const UNIT_SUFFIXES: Record<UnitId, string[]> = {
  ohm: ['ω', 'Ω', 'ohms', 'ohm'],
  volt: ['v', 'volts', 'volt'],
  ampere: ['a', 'amps', 'amp', 'amperes', 'ampere'],
  lux: ['lx', 'lux'],
  farad: ['f', 'farads', 'farad'],
  metre: ['m', 'metres', 'metre', 'meters', 'meter'],
  celsius: ['°c', '℃', 'degc', 'celsius'],
  percent_rh: ['%rh', '%', 'rh'],
  percent: ['%'],
};

export type ParseError = 'empty' | 'invalid' | 'decimal_comma' | 'wrong_unit';

export type ParseResult = { ok: true; value: number } | { ok: false; error: ParseError };

function stripUnit(text: string, unit: UnitId): { rest: string; wrongUnit: boolean } {
  const lower = text.toLowerCase();
  const own = [...UNIT_SUFFIXES[unit]].sort((a, b) => b.length - a.length);
  for (const suffix of own) {
    if (lower.endsWith(suffix.toLowerCase())) {
      return { rest: text.slice(0, text.length - suffix.length).trimEnd(), wrongUnit: false };
    }
  }
  for (const other of Object.keys(UNIT_SUFFIXES) as UnitId[]) {
    if (other === unit) continue;
    for (const suffix of UNIT_SUFFIXES[other]) {
      // `m` is milli before it is metre: a one-letter prefix never names another unit.
      if (PREFIX_EXPONENT[suffix] !== undefined) continue;
      // A bare `m`/`M` prefix is never mistaken for a unit: only letters that cannot be a
      // prefix are checked here.
      if (lower.endsWith(suffix.toLowerCase()) && /[a-zωΩ]$/i.test(text)) {
        return { rest: text, wrongUnit: true };
      }
    }
  }
  return { rest: text, wrongUnit: false };
}

/** Combine a decimal digit string and a power of ten without binary rounding drift. */
export function exact(intPart: string, fracPart: string, exponent: number): number {
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  return Number(`${digits || '0'}e${exponent - fracPart.length}`);
}

export function parseQuantity(input: string, unit: UnitId): ParseResult {
  const text = input.trim();
  if (text === '') return { ok: false, error: 'empty' };
  if (/\d,\d/.test(text)) return { ok: false, error: 'decimal_comma' };

  const { rest, wrongUnit } = stripUnit(text, unit);
  if (wrongUnit) return { ok: false, error: 'wrong_unit' };
  const body = rest.replace(/\s+/g, '');

  // Plain or prefixed decimal: 220, 1.5k, .5, 2e3
  const plain = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?([pnuµμmkKMG])?$/.exec(body);
  if (plain && (plain[1] || plain[2])) {
    const exponent = Number(plain[3] ?? 0) + (plain[4] ? PREFIX_EXPONENT[plain[4]]! : 0);
    return { ok: true, value: exact(plain[1] ?? '', plain[2] ?? '', exponent) };
  }

  // RKM notation: the multiplier letter stands in for the decimal point (4k7, 2M2, 4R7).
  const rkm = /^(\d+)([pnuµμmkKMGR])(\d+)$/.exec(body);
  if (rkm) {
    const letter = rkm[2]!;
    if (letter === 'R' && unit !== 'ohm') return { ok: false, error: 'invalid' };
    const exponent = letter === 'R' ? 0 : PREFIX_EXPONENT[letter]!;
    return { ok: true, value: exact(rkm[1]!, rkm[3]!, exponent) };
  }

  return { ok: false, error: 'invalid' };
}

export interface EngineeringParts {
  /** Mantissa in [1, 1000) (or 0), as a number to be formatted by the locale. */
  mantissa: number;
  /** SI prefix symbol, '' for none. Prefix symbols are international, not localized. */
  prefix: string;
}

const DISPLAY_PREFIXES: [number, string][] = [
  [9, 'G'],
  [6, 'M'],
  [3, 'k'],
  [0, ''],
  [-3, 'm'],
  [-6, 'µ'],
  [-9, 'n'],
  [-12, 'p'],
];

/** Split an SI value into an engineering mantissa and prefix for display. */
export function toEngineering(value: number): EngineeringParts {
  if (value === 0 || !Number.isFinite(value)) return { mantissa: value, prefix: '' };
  const abs = Math.abs(value);
  for (const [exp, prefix] of DISPLAY_PREFIXES) {
    const scale = 10 ** exp;
    if (abs >= scale * (1 - 1e-12)) {
      return { mantissa: Number((value / scale).toPrecision(12)), prefix };
    }
  }
  return { mantissa: Number((value / 1e-12).toPrecision(12)), prefix: 'p' };
}

// ---------------------------------------------------------------------------------------------
// Display units (Sprint POT-UNITS, Phase 1): the editor shows a plain number and a unit chosen
// from a short list, instead of asking the user to type SI prefixes. Data, not UI code: the app
// renders the symbol (`prefix` + the locale's unit symbol). The stored value is always the
// canonical SI number; the display unit is UI state, re-derived from the stored value.
// ---------------------------------------------------------------------------------------------

/** One choice in a quantity's unit list: the value shown is `SI value / 10^exponent`. */
export interface DisplayUnit {
  exponent: number;
  /** The prefix symbol written before the unit symbol ('' for the base unit). */
  prefix: string;
}

const BASE: readonly DisplayUnit[] = [{ exponent: 0, prefix: '' }];

/** The display units offered per canonical unit, smallest first. One entry: a fixed symbol. */
export const DISPLAY_UNITS: Readonly<Record<UnitId, readonly DisplayUnit[]>> = {
  ohm: [
    { exponent: 0, prefix: '' },
    { exponent: 3, prefix: 'k' },
    { exponent: 6, prefix: 'M' },
  ],
  farad: [
    { exponent: -12, prefix: 'p' },
    { exponent: -9, prefix: 'n' },
    { exponent: -6, prefix: 'µ' },
    { exponent: -3, prefix: 'm' },
  ],
  ampere: [
    { exponent: -3, prefix: 'm' },
    { exponent: 0, prefix: '' },
  ],
  metre: [
    { exponent: -3, prefix: 'm' },
    { exponent: -2, prefix: 'c' },
    { exponent: 0, prefix: '' },
  ],
  volt: BASE,
  lux: BASE,
  celsius: BASE,
  percent_rh: BASE,
  percent: BASE,
};

/**
 * The units offered for a parameter with the range [min, max]: a unit is hidden only when no
 * value it naturally shows is in range. Unit i naturally shows [10^e_i, 10^e_{i+1}] (the
 * smallest from 0, the largest without an upper bound); a capacitor's 1 nF minimum keeps pF
 * because 1000 pF is in range.
 */
export function displayUnitsFor(unit: UnitId, min: number, max: number): DisplayUnit[] {
  const all = DISPLAY_UNITS[unit];
  if (all.length === 1) return [...all];
  const lo = Math.min(Math.abs(min), Math.abs(max));
  const hi = Math.max(Math.abs(min), Math.abs(max));
  const spanLo = min <= 0 && max >= 0 ? 0 : lo;
  return all.filter((u, i) => {
    const from = i === 0 ? 0 : 10 ** u.exponent;
    const to = i === all.length - 1 ? Infinity : 10 ** all[i + 1]!.exponent;
    return from <= hi && to >= spanLo;
  });
}

/**
 * The deterministic display unit for a stored value: the largest unit whose number is >= 1
 * (220 -> 220 Ω, 4700 -> 4.7 kΩ, 1e-4 F -> 100 µF); 0 (or a value below every unit) -> the
 * base unit if offered, else the smallest.
 */
export function chooseDisplayUnit(value: number, units: readonly DisplayUnit[]): DisplayUnit {
  const abs = Math.abs(value);
  const base = units.find((u) => u.exponent === 0) ?? units[0]!;
  if (abs === 0 || !Number.isFinite(abs)) return base;
  let best: DisplayUnit | null = null;
  for (const u of units) {
    if (shiftDecimal(abs, -u.exponent) >= 1 && (!best || u.exponent > best.exponent)) best = u;
  }
  return best ?? units[0]!;
}

/**
 * `value * 10^exponent`, exact in decimal: the shortest decimal digits of `value` are kept and
 * only the decimal point moves (4700 at -3 -> 4.7, never 4.699999999999999).
 */
export function shiftDecimal(value: number, exponent: number): number {
  if (value === 0 || !Number.isFinite(value) || exponent === 0) return value;
  const [mantissa, exp] = value.toExponential().split('e') as [string, string];
  return Number(`${mantissa}e${Number(exp) + exponent}`);
}

export type EntryResult =
  | {
      ok: true;
      value: number;
      /** The unit the text named, when it named one. */ unit?: DisplayUnit;
    }
  | { ok: false; error: ParseError };

/**
 * What the number field accepts (Phase 1): a plain decimal, read in the selected display unit,
 * exactly. As an explicit convenience, a value written with its unit or prefix (`4.7 kΩ`,
 * `100 µF`, `4k7`, `2M2`, `100u`) is converted by the exact parser into an SI value, and the
 * field then shows it as number + unit; it is never re-scaled by the selected unit. `symbols`
 * are the offered units' full symbols as displayed (`kΩ`), matched exactly.
 */
export function parseEntry(
  input: string,
  unit: UnitId,
  selected: DisplayUnit,
  offered: readonly { unit: DisplayUnit; symbol: string }[],
  allowNegative: boolean,
): EntryResult {
  let text = input.trim();
  if (text === '') return { ok: false, error: 'empty' };
  if (/\d,\d/.test(text)) return { ok: false, error: 'decimal_comma' };
  let sign = 1;
  if (allowNegative && /^[-−]/.test(text)) {
    sign = -1;
    text = text.slice(1).trimStart();
  }
  const plain = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (plain && (plain[1] || plain[2]))
    return { ok: true, value: sign * exact(plain[1] ?? '', plain[2] ?? '', selected.exponent) };
  // A number followed by one of the offered unit symbols (`50 cm`, `4.7 kΩ`).
  for (const o of [...offered].sort((a, b) => b.symbol.length - a.symbol.length)) {
    if (!text.endsWith(o.symbol)) continue;
    const num = /^(\d*)(?:\.(\d*))?$/.exec(text.slice(0, -o.symbol.length).trimEnd());
    if (num && (num[1] || num[2]))
      return {
        ok: true,
        value: sign * exact(num[1] ?? '', num[2] ?? '', o.unit.exponent),
        unit: o.unit,
      };
  }
  const r = parseQuantity(text, unit);
  return r.ok ? { ok: true, value: sign * r.value } : r;
}
