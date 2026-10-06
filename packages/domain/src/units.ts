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
function exact(intPart: string, fracPart: string, exponent: number): number {
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
