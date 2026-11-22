/** TBI-021 slice 2: the language picker model is registry-driven; beta locales are marked. */
import { describe, expect, it } from 'vitest';
import { LOCALES, buildLocale } from '../src/i18n/i18n.js';
import { languageOptions } from '../src/i18n/picker.js';
import { LOCALE_REGISTRY } from '../src/i18n/locales.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';

describe('language picker model', () => {
  it('lists exactly the offered locales, in registry order, with lang and dir', () => {
    const opts = languageOptions(LOCALES, 'beta');
    expect(opts.map((o) => o.code)).toEqual(['en', 'he']);
    expect(opts.map((o) => [o.lang, o.dir, o.label])).toEqual([
      ['en', 'ltr', 'English'],
      ['he', 'rtl', 'עברית'],
    ]);
  });
  it('no shipped locale is beta or disabled-but-listed', () => {
    expect(LOCALES.some((l) => l.beta)).toBe(false);
    const enabled = LOCALE_REGISTRY.filter((l) => l.enabled).map((l) => l.code);
    expect(LOCALES.map((l) => l.code)).toEqual(enabled);
  });
  it('a fake beta locale gets the localized marker; others do not', () => {
    const fake = buildLocale(
      { code: 'zz', dir: 'rtl', autonym: 'Zed', beta: true, enabled: true },
      {},
    );
    const opts = languageOptions([...LOCALES, fake], 'beta');
    const z = opts.find((o) => o.code === 'zz')!;
    expect(z).toMatchObject({ label: 'Zed (beta)', lang: 'zz', dir: 'rtl', beta: true });
    expect(opts.find((o) => o.code === 'en')!.label).toBe('English');
  });
  it('the beta marker key exists in HE and EN', () => {
    expect(en['topbar.language.beta']).toBe('beta');
    expect(he['topbar.language.beta']).toBe('בטא');
  });
});
