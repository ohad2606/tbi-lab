/** TBI-019 G2: the panel's entry-point data and its own UI strings (EN and HE). */
import { describe, expect, it } from 'vitest';
import { getLocale, messageParts } from '../i18n/i18n.js';
import { en as messagesEn } from '../i18n/messages.en.js';
import { he as messagesHe } from '../i18n/messages.he.js';
import { GUIDES, guidesForPart } from './catalog.js';

describe('Inspector link lookup', () => {
  it('the LED has the LED and resistor guide; parts without a guide have none', () => {
    expect(guidesForPart('component.led').map((g) => g.id)).toEqual(['led-resistor']);
    expect(guidesForPart('component.resistor')).toEqual([]);
    expect(guidesForPart('nonsense')).toEqual([]);
  });
});

describe('panel strings', () => {
  const keys = Object.keys(messagesEn).filter((k) =>
    /^guidepanel\.(home|inspector|panel)\./.test(k),
  );
  it('exist in both languages with the same placeholders', () => {
    expect(keys.length).toBeGreaterThanOrEqual(11);
    for (const k of keys) {
      const params = (loc: 'en' | 'he') =>
        messageParts(getLocale(loc), k as never)
          .flatMap((p) => ('param' in p ? [p.param] : []))
          .sort();
      expect(k in messagesHe, k).toBe(true);
      expect(params('he'), k).toEqual(params('en'));
    }
  });
  it('every guide shows its minutes through the shared placeholder', () => {
    for (const g of GUIDES) expect(g.minutes).toBeGreaterThanOrEqual(2);
    expect(messagesEn['guidepanel.panel.minutes']).toContain('{n}');
    expect(messagesHe['guidepanel.panel.minutes']).toContain('{n}');
  });
});
