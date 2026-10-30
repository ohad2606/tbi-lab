import { describe, expect, it } from 'vitest';
import {
  DISPLAY_UNITS,
  chooseDisplayUnit,
  displayUnitsFor,
  parseEntry,
  parseQuantity,
  shiftDecimal,
  toEngineering,
  type DisplayUnit,
} from '../src/index.js';

describe('parseQuantity — exact, locale-independent', () => {
  const ok: [string, 'ohm' | 'volt' | 'ampere', number][] = [
    ['220', 'ohm', 220],
    ['1k', 'ohm', 1000],
    ['4k7', 'ohm', 4700],
    ['1.5k', 'ohm', 1500],
    ['4.7k', 'ohm', 4700],
    ['4R7', 'ohm', 4.7],
    ['2M2', 'ohm', 2_200_000],
    ['10 k', 'ohm', 10_000],
    ['1kΩ', 'ohm', 1000],
    ['1k ohm', 'ohm', 1000],
    ['  330  ', 'ohm', 330],
    ['.5', 'volt', 0.5],
    ['3.3V', 'volt', 3.3],
    ['3.3 v', 'volt', 3.3],
    ['100mA', 'ampere', 0.1],
    ['100m', 'ampere', 0.1],
    ['0.001', 'ampere', 0.001],
    ['1e3', 'ohm', 1000],
    ['1M', 'ohm', 1e6],
    ['250u', 'ampere', 0.00025],
  ];
  for (const [text, unit, value] of ok) {
    it(`${JSON.stringify(text)} -> ${value} ${unit}`, () => {
      expect(parseQuantity(text, unit)).toEqual({ ok: true, value });
    });
  }

  it('is exact where binary arithmetic would drift', () => {
    // 4.7 * 1000 === 4700.000000000001 in IEEE-754; the parser must not produce that.
    expect(parseQuantity('4.7k', 'ohm')).toEqual({ ok: true, value: 4700 });
    expect(parseQuantity('0.1k', 'ohm')).toEqual({ ok: true, value: 100 });
  });

  const bad: [string, 'ohm' | 'volt' | 'ampere', string][] = [
    ['', 'ohm', 'empty'],
    ['   ', 'ohm', 'empty'],
    ['abc', 'ohm', 'invalid'],
    ['k', 'ohm', 'invalid'],
    ['1..2', 'ohm', 'invalid'],
    ['-5', 'volt', 'invalid'],
    ['1,5k', 'ohm', 'decimal_comma'],
    ['5V', 'ohm', 'wrong_unit'],
    ['2A', 'volt', 'wrong_unit'],
    ['4R7', 'volt', 'invalid'],
    ['1x', 'ohm', 'invalid'],
  ];
  for (const [text, unit, error] of bad) {
    it(`refuses ${JSON.stringify(text)} as ${error}`, () => {
      expect(parseQuantity(text, unit)).toEqual({ ok: false, error });
    });
  }
});

describe('toEngineering', () => {
  it.each([
    [4700, 4.7, 'k'],
    [220, 220, ''],
    [0.1, 100, 'm'],
    [2_200_000, 2.2, 'M'],
    [0.00025, 250, 'µ'],
    [0, 0, ''],
    [1000, 1, 'k'],
    [999, 999, ''],
  ])('%d -> %d %s', (value, mantissa, prefix) => {
    expect(toEngineering(value)).toEqual({ mantissa, prefix });
  });
});

describe('display units (Sprint POT-UNITS Phase 1)', () => {
  const ohm = displayUnitsFor('ohm', 0.001, 1e9);
  const farad = displayUnitsFor('farad', 1e-9, 0.01);
  const sym = (u: DisplayUnit, base: string) => ({ unit: u, symbol: `${u.prefix}${base}` });
  const k = ohm.find((u) => u.prefix === 'k')!;
  const base = ohm.find((u) => u.prefix === '')!;

  it('offers the unit lists as data; single-choice units have one entry', () => {
    expect(ohm.map((u) => u.prefix)).toEqual(['', 'k', 'M']);
    expect(displayUnitsFor('ampere', 0.001, 5).map((u) => u.prefix)).toEqual(['m', '']);
    expect(displayUnitsFor('metre', 0.01, 5).map((u) => u.prefix)).toEqual(['m', 'c', '']);
    for (const u of ['volt', 'lux', 'celsius', 'percent_rh'] as const)
      expect(DISPLAY_UNITS[u]).toHaveLength(1);
  });

  it('hides a unit only when none of its values is in range (1 nF min keeps pF)', () => {
    expect(farad.map((u) => u.prefix)).toEqual(['p', 'n', 'µ', 'm']);
    expect(displayUnitsFor('farad', 1e-6, 0.01).map((u) => u.prefix)).toEqual(['n', 'µ', 'm']);
    expect(displayUnitsFor('ohm', 1000, 1e6).map((u) => u.prefix)).toEqual(['', 'k', 'M']);
    expect(displayUnitsFor('ohm', 1e4, 1e5).map((u) => u.prefix)).toEqual(['k']);
  });

  it.each([
    [220, ''],
    [4700, 'k'],
    [2_200_000, 'M'],
    [0, ''],
    [0.001, ''],
    [999, ''],
    [1000, 'k'],
  ])('ohm %d is shown in %sΩ', (v, prefix) => {
    expect(chooseDisplayUnit(v, ohm).prefix).toBe(prefix);
  });
  it.each([
    [1e-4, 'µ', 100],
    [1e-7, 'n', 100],
    [3.3e-9, 'n', 3.3],
    [1e-9, 'n', 1],
    [0.01, 'm', 10],
  ])('farad %d is shown as %s with number %d', (v, prefix, n) => {
    const du = chooseDisplayUnit(v, farad);
    expect(du.prefix).toBe(prefix);
    expect(shiftDecimal(v, -du.exponent)).toBe(n);
  });

  it('converts number x unit to SI exactly and round-trips', () => {
    const cases: [string, string, DisplayUnit[], number][] = [
      ['4.7', 'k', ohm, 4700],
      ['2.2', 'M', ohm, 2_200_000],
      ['0.1', 'µ', farad, 1e-7],
      ['3.3', 'n', farad, 3.3e-9],
      ['100', 'µ', farad, 1e-4],
      ['0.33', 'k', ohm, 330],
    ];
    for (const [text, prefix, units, si] of cases) {
      const du = units.find((u) => u.prefix === prefix)!;
      const r = parseEntry(text, units === ohm ? 'ohm' : 'farad', du, [], false);
      expect(r).toEqual({ ok: true, value: si });
      // Displayed back in its derived unit, the same number appears, and it re-parses to the same SI.
      const shown = chooseDisplayUnit(si, units);
      const n = String(shiftDecimal(si, -shown.exponent));
      expect(parseEntry(n, 'ohm', shown, [], false)).toEqual({ ok: true, value: si });
    }
  });

  it('reads a plain number in the selected unit, a prefixed form by its own prefix', () => {
    const offered = ohm.map((u) => sym(u, 'Ω'));
    expect(parseEntry('1', 'ohm', k, offered, false)).toEqual({ ok: true, value: 1000 });
    expect(parseEntry('4k7', 'ohm', k, offered, false)).toEqual({ ok: true, value: 4700 });
    expect(parseEntry('2M2', 'ohm', base, offered, false)).toEqual({ ok: true, value: 2.2e6 });
    expect(parseEntry('4.7 kΩ', 'ohm', base, offered, false)).toEqual({
      ok: true,
      value: 4700,
      unit: k,
    });
    expect(parseEntry('100u', 'farad', base, [], false)).toEqual({ ok: true, value: 1e-4 });
    const cm = displayUnitsFor('metre', 0.01, 5).find((u) => u.prefix === 'c')!;
    expect(parseEntry('50 cm', 'metre', base, [sym(cm, 'm')], false)).toMatchObject({
      ok: true,
      value: 0.5,
    });
    expect(parseEntry('-12.5', 'celsius', base, [], true)).toEqual({ ok: true, value: -12.5 });
    expect(parseEntry('-12.5', 'celsius', base, [], false)).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(parseEntry('abc', 'ohm', k, offered, false)).toEqual({ ok: false, error: 'invalid' });
    expect(parseEntry('1,5', 'ohm', k, offered, false)).toEqual({
      ok: false,
      error: 'decimal_comma',
    });
    expect(parseEntry('', 'ohm', k, offered, false)).toEqual({ ok: false, error: 'empty' });
  });
});
