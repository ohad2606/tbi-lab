/**
 * BETA-G5: the stop message for `U gpio-interrupt`. Runtime v5 delivers edge interrupts and reports
 * only level-triggered, NMI, SDIO and wake-up ones (patch 0012); Runtime v4 reports every enabled
 * GPIO interrupt (patch 0011). The message must be true for both.
 */
import { describe, expect, it } from 'vitest';
import { LOCALES } from '../src/i18n/i18n.js';
import { simFailureMessage } from '../src/sim/format.js';

const message = (code: 'en' | 'he', facility: string) =>
  simFailureMessage(
    LOCALES.find((l) => l.code === code)!,
    { kind: 'unmodelled', code: 'unmodelled', facility },
    null,
  );
/** A left-to-right isolate (i18n isolateLtr). */
const EDGES = '⁦RISING, FALLING, CHANGE⁩';

describe('unmodelled GPIO interrupt message', () => {
  for (const code of ['en', 'he'] as const)
    it(`${code}: names what stops the run, not every interrupt`, () => {
      const text = message(code, 'interrupt');
      for (const word of ['NMI', 'SDIO', 'Runtime', EDGES]) expect(text).toContain(word);
      expect(text).toContain(code === 'en' ? 'level-triggered' : 'רמה');
      expect(text).toContain(code === 'en' ? 'wake-up' : 'התעוררות');
      expect(text).not.toContain('attachInterrupt');
      expect(text).not.toMatch(/[{}]/);
    });

  it('keeps the general message for the other facilities', () => {
    expect(message('en', 'adc')).toContain('which the simulator does not model');
    expect(message('en', 'adc')).not.toContain('SDIO');
  });
});
