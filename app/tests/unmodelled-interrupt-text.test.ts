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
/** Left-to-right isolates (i18n isolateLtr). */
const EDGES = '⁦RISING, FALLING, CHANGE⁩';
const MPY = '⁦IRQ_RISING, IRQ_FALLING⁩';

describe('unmodelled GPIO interrupt message', () => {
  for (const code of ['en', 'he'] as const)
    it(`${code}: names what stops the run, not every interrupt`, () => {
      const text = message(code, 'interrupt');
      for (const word of ['NMI', 'SDIO', 'Runtime', EDGES, MPY]) expect(text).toContain(word);
      expect(text).toContain(code === 'en' ? 'Level-triggered' : 'פסיקות רמה');
      expect(text).toContain(code === 'en' ? 'wake-up' : 'התעוררות');
      expect(text).not.toContain('attachInterrupt');
      expect(text).not.toMatch(/[{}]/);
      // True when an edge interrupt reached an older Runtime too: no sentence blames only the
      // level / NMI / SDIO / wake-up types.
      expect(text).toContain(
        code === 'en' ? 'some older Runtime versions' : 'בחלק מגרסאות ה־Runtime הישנות',
      );
      expect(text).toContain(code === 'en' ? 'read the pin in a loop' : 'קראו את הפין בלולאה');
      expect(text).not.toMatch(/does not deliver: a|אינו מוסר: פסיקת/);
    });

  it('keeps the general message for the other facilities', () => {
    expect(message('en', 'adc')).toContain('which the simulator does not model');
    expect(message('en', 'adc')).not.toContain('SDIO');
  });
});
