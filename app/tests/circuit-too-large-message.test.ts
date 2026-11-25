/** The circuit-size cap refusal carries the limit and the circuit's size, in EN and HE. */
import { describe, expect, it } from 'vitest';
import { getLocale } from '../src/i18n/i18n.js';
import { engineErrorMessage } from '../src/sim/format.js';

const error: Parameters<typeof engineErrorMessage>[1] = {
  code: 'circuit_too_large',
  detail: { limit: 400, actual: 402 },
};

describe('circuit_too_large message', () => {
  it('en: names the limit and the actual number of unknowns', () => {
    expect(engineErrorMessage(getLocale('en'), error, null)).toBe(
      'This circuit is too large to simulate (limit: 400 unknowns, this one has 402). Simplify it and try again.',
    );
  });

  it('he: names the limit and the actual number of unknowns', () => {
    expect(engineErrorMessage(getLocale('he'), error, null)).toBe(
      'המעגל גדול מדי לסימולציה (מגבלה: 400 נעלמים, במעגל הזה יש 402). פשטו אותו ונסו שוב.',
    );
  });
});
