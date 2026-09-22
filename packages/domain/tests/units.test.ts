import { describe, expect, it } from 'vitest';
import { parseQuantity, toEngineering } from '../src/index.js';

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
