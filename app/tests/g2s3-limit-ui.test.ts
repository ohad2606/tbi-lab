/**
 * BETA-G2 slice 3: every public limit code has calm HE + EN text (key parity), none mentions prices or
 * plans, and the UI class of each code (status vs alert, with or without "Try again") is fixed.
 */
import { describe, expect, it } from 'vitest';
import { LOCALES, translate } from '../src/i18n/i18n.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import {
  simLimitKeys,
  simLimitText,
  simLimitUi,
  type SimLimitCode,
} from '../src/runtime/limits.js';

const CODES: SimLimitCode[] = [
  'queue',
  'queue_timeout',
  'queue_full',
  'queue_replaced',
  'sim_cooldown',
  'sim_concurrent',
  'minutes_out',
  'minutes_out_free',
  'sim_daily',
  'system_unavailable',
  'free_paused',
];

describe('BETA-G2 s3 limit texts', () => {
  it('every limit key exists in EN and HE with the same placeholders', () => {
    for (const k of [...simLimitKeys(), 'sim.limit.retry' as const]) {
      expect(en[k], k).toBeTruthy();
      expect(he[k], k).toBeTruthy();
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph(he[k]), k).toBe(ph(en[k]));
    }
  });

  it('every code renders text in both locales, never a key, never a price or plan word', () => {
    for (const locale of LOCALES)
      for (const code of CODES) {
        const text = simLimitText(locale, { code, params: { n: 7, date: '01.12.2026' } });
        expect(text, code).toBeTruthy();
        expect(text, code).not.toMatch(/sim\.limit/);
        expect(text, code).not.toMatch(
          /₪|\$|€|price|plan|upgrade|pay|subscri|מחיר|תוכנית|שדרג|תשלום|מנוי/i,
        );
      }
    expect(translate(LOCALES[0]!, 'sim.limit.retry')).toBeTruthy();
  });

  it('classifies codes: waiting/transient = status with retry where a new start can help', () => {
    expect(simLimitUi('free_paused')).toEqual({ role: 'status', retry: true });
    expect(simLimitUi('queue_full')).toEqual({ role: 'status', retry: true });
    expect(simLimitUi('queue_timeout')).toEqual({ role: 'status', retry: true });
    expect(simLimitUi('system_unavailable')).toEqual({ role: 'status', retry: true });
    expect(simLimitUi('sim_cooldown')).toEqual({ role: 'status', retry: true });
    expect(simLimitUi('queue')).toEqual({ role: 'status', retry: false });
    // hard refusals: alert, and a retry cannot help (or would take over another tab)
    for (const c of [
      'minutes_out',
      'minutes_out_free',
      'sim_daily',
      'sim_concurrent',
      'queue_replaced',
    ])
      expect(simLimitUi(c as SimLimitCode)).toEqual({ role: 'alert', retry: false });
    expect(simLimitUi('nope')).toBeNull();
  });
});
