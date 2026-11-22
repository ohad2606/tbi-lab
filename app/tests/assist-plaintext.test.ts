import { describe, expect, it } from 'vitest';
import { stripControls } from '../src/assist/plainText.js';

/** Characters by code point, so the test file itself holds no invisible characters. */
const ch = (...cp: number[]) => String.fromCodePoint(...cp);
const RLO = ch(0x202e);
const PDF = ch(0x202c);
const RLI = ch(0x2067);
const PDI = ch(0x2069);

describe('stripControls (model/service text is plain text)', () => {
  it('drops bidi overrides, embeddings, isolates, marks and the Arabic letter mark', () => {
    const all = [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f,
      0x061c,
    ];
    for (const cp of all) expect(stripControls(`a${ch(cp)}b`)).toBe('ab');
    expect(stripControls(`${RLO}abc${PDF}`)).toBe('abc');
    expect(stripControls(`${RLI}שלום${PDI} R1`)).toBe('שלום R1');
    expect(stripControls(`${ch(0x2066)}1${PDI}${ch(0x2068)}x${PDI}`)).toBe('1x');
  });
  it('drops zero-width characters and C0/C1 controls, keeps newline and tab', () => {
    expect(stripControls(`a${ch(0x200b)}b${ch(0x200c)}c${ch(0x200d)}d`)).toBe('abcd');
    expect(stripControls(`a${ch(0, 7)}b${ch(0x1b)}c${ch(0x85)}d${ch(0x9f)}e`)).toBe('abcde');
    expect(stripControls('line1\nline2\tx')).toBe('line1\nline2\tx');
  });
  it('keeps ordinary Hebrew, Latin, digits and punctuation', () => {
    expect(stripControls('נגד R1 = 220 Ω (±5%)')).toBe('נגד R1 = 220 Ω (±5%)');
  });
});
