/**
 * Sprint 13 P2 (UI): a warning whose value is an extrapolation of the pad-driver model (a pad beyond
 * its characterized point, e.g. an output wired straight to GND) states the condition but never
 * shows the extrapolated number as a physical value, in every locale.
 */
import { describe, expect, it } from 'vitest';
import { LOCALES, translate } from '../src/i18n/i18n.js';
import { ratingRow } from '../src/sim/format.js';

const short = {
  component: 'U1',
  kind: 'unrated' as const,
  code: 'gpio_short_ground' as const,
  value: 0.2,
  limit: 0.04,
  gpio: 5,
};

describe('P2: unreliable pad values are not presented as measurements', () => {
  for (const locale of LOCALES) {
    it(`${locale.code}: the short-to-GND row names the condition and says the current is not known`, () => {
      const row = ratingRow(locale, { ...short, unreliable: true });
      expect(row).toContain('IO5');
      expect(row).toContain(translate(locale, 'rating.value.uncharacterized'));
      // The extrapolated 200 mA appears nowhere; the typical drive (the limit) still does.
      expect(row).not.toMatch(/200|0[.,]2\b/);
      expect(row).toMatch(/40/);
    });
    it(`${locale.code}: a value inside the characterized region is shown as before`, () => {
      const row = ratingRow(locale, { ...short, code: 'gpio_source_current', value: 0.0398 });
      expect(row).toMatch(/39[.,]8/);
      expect(row).not.toContain(translate(locale, 'rating.value.uncharacterized'));
    });
  }
});
