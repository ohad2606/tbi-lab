/** TBI-021 slice 1: locale registry invariants, per-key fallback to EN, dir/lang derivation. */
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages.en.js';
import { DEFAULT_LOCALE, LOCALE_REGISTRY } from '../src/i18n/locales.js';
import {
  LOCALES,
  buildLocale,
  getLocale,
  negotiateLocale,
  resolveMessages,
  translate,
} from '../src/i18n/i18n.js';

const RTL = ['he', 'ar'];

describe('locale registry', () => {
  it('codes are unique, lower-case language subtags', () => {
    const codes = LOCALE_REGISTRY.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[a-z]{2,3}$/);
  });
  it('dir is rtl exactly for he and ar', () => {
    for (const l of LOCALE_REGISTRY)
      expect(l.dir, l.code).toBe(RTL.includes(l.code) ? 'rtl' : 'ltr');
  });
  it('autonyms are non-empty and unique', () => {
    const names = LOCALE_REGISTRY.map((l) => l.autonym.trim());
    for (const n of names) expect(n).not.toBe('');
    expect(new Set(names).size).toBe(names.length);
  });
  it('the default locale is registered, enabled and not beta', () => {
    const d = LOCALE_REGISTRY.find((l) => l.code === DEFAULT_LOCALE)!;
    expect(d.enabled).toBe(true);
    expect(d.beta).toBe(false);
  });
  it('only en and he are enabled (CLAIMS.md: nothing else until live on Alpha)', () => {
    expect(
      LOCALE_REGISTRY.filter((l) => l.enabled)
        .map((l) => l.code)
        .sort(),
    ).toEqual(['en', 'he']);
    expect(LOCALES.map((l) => l.code).sort()).toEqual(['en', 'he']);
  });
  it('every not-yet-reviewed locale is flagged beta', () => {
    for (const c of ['es', 'fr', 'ar', 'ru']) {
      const l = LOCALE_REGISTRY.find((x) => x.code === c)!;
      expect(l.beta, c).toBe(true);
      expect(l.enabled, c).toBe(false);
    }
  });
  it('the picker list (LOCALES) is exactly the enabled registry entries with a bundle', () => {
    for (const l of LOCALES) {
      const def = LOCALE_REGISTRY.find((d) => d.code === l.code)!;
      expect(def.enabled).toBe(true);
      expect({ dir: l.dir, autonym: l.autonym, beta: l.beta }).toEqual({
        dir: def.dir,
        autonym: def.autonym,
        beta: def.beta,
      });
    }
  });
  it('dir/lang derive from the locale; unknown or disabled codes fall back to en', () => {
    expect(getLocale('he').dir).toBe('rtl');
    expect(getLocale('he').code).toBe('he');
    expect(getLocale('en').dir).toBe('ltr');
    expect(getLocale('ar').code).toBe('en');
    expect(getLocale('xx').code).toBe('en');
    expect(negotiateLocale(['ar-EG', 'es', 'he-IL'])).toBe('he');
    expect(negotiateLocale(['fr'])).toBe('en');
  });
});

describe('fallback to English', () => {
  const keys = Object.keys(en) as (keyof typeof en)[];
  const [k1, k2, k3] = keys;
  const fake = buildLocale(
    { code: 'zz', dir: 'rtl', autonym: 'Zed', beta: true, enabled: false },
    { [k1!]: 'own one', [k2!]: '   ' },
  );
  it('uses its own message where present', () => {
    expect(translate(fake, k1!)).toBe('own one');
  });
  it('falls back to English for a missing or blank key', () => {
    expect(fake.messages[k2!]).toBe(getLocale('en').messages[k2!]);
    expect(fake.messages[k3!]).toBe(getLocale('en').messages[k3!]);
  });
  it('is always complete: every key resolves to a non-empty string, never the raw key', () => {
    for (const k of keys) {
      expect(fake.messages[k].trim(), k).not.toBe('');
    }
    expect(Object.keys(fake.messages).sort()).toEqual([...keys].sort());
  });
  it('ignores keys that do not exist in English', () => {
    const r = resolveMessages({ 'no.such.key': 'x' } as never);
    expect(Object.keys(r).sort()).toEqual([...keys].sort());
  });
  it('an empty bundle equals English', () => {
    expect(resolveMessages({})).toEqual(getLocale('en').messages);
  });
  it('carries dir and beta from the definition', () => {
    expect(fake.dir).toBe('rtl');
    expect(fake.beta).toBe(true);
  });
});
