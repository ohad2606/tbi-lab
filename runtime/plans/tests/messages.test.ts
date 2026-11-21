import { describe, expect, it } from 'vitest';
import { MESSAGE_KEY, limitError } from '../limits.js';
import { MESSAGES, placeholders, renderLimit } from '../messages.js';

describe('messages', () => {
  const heKeys = Object.keys(MESSAGES.he).sort();
  const enKeys = Object.keys(MESSAGES.en).sort();
  it('he and en define the same key set', () => expect(heKeys).toEqual(enKeys));
  it('same placeholder set per key in he and en', () => {
    for (const k of heKeys)
      expect(placeholders(MESSAGES.he[k] as string), k).toEqual(
        placeholders(MESSAGES.en[k] as string),
      );
  });
  it('no digit except through placeholders', () => {
    for (const lang of ['he', 'en'] as const)
      for (const [k, t] of Object.entries(MESSAGES[lang]))
        expect(t.replace(/\{[A-Za-z_]+\}/g, ''), `${lang} ${k}`).not.toMatch(/[0-9]/);
  });
  it('every user-facing code resolves in both languages', () => {
    for (const [code, key] of Object.entries(MESSAGE_KEY)) {
      if (key === null) continue;
      expect(MESSAGES.he[key], code).toBeTruthy();
      expect(MESSAGES.en[key], code).toBeTruthy();
    }
    expect(
      Object.values(MESSAGE_KEY)
        .filter((k): k is string => k !== null)
        .sort(),
    ).toEqual(heKeys);
  });
  it('renders params; missing param or code without message is an error', () => {
    expect(renderLimit('en', limitError('rate', { n: 50 }))).toContain('50 seconds');
    expect(renderLimit('he', limitError('credits_out', { date: '01.12.2026' }))).toContain(
      '01.12.2026',
    );
    expect(() => renderLimit('en', limitError('rate'))).toThrow(/missing param/);
    expect(() => renderLimit('en', limitError('invalid_state'))).toThrow(/no user message/);
  });
});
