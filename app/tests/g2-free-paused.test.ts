/**
 * BETA-G2: the host's `free_paused` limit (Free kill switch, runtime/plans/limits.ts) is a known app
 * limit with its own HE + EN text, so a refused start never shows a wrong reason. UI: later slice.
 */
import { describe, expect, it } from 'vitest';
import { LOCALES, translate } from '../src/i18n/i18n.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { isSimLimitCode, simLimitKeys, simLimitText } from '../src/runtime/limits.js';

describe('BETA-G2 free_paused in the app', () => {
  it('is a known sim limit code with a key in EN and HE', () => {
    expect(isSimLimitCode('free_paused')).toBe(true);
    expect(simLimitKeys()).toContain('sim.limit.free_paused');
    expect(en['sim.limit.free_paused']).toBeTruthy();
    expect(he['sim.limit.free_paused']).toBeTruthy();
    expect(he['sim.limit.free_paused']).not.toBe(en['sim.limit.free_paused']);
  });

  it('renders its own sentence in every locale, ignoring params', () => {
    for (const locale of LOCALES)
      expect(simLimitText(locale, { code: 'free_paused', params: { n: 3 } })).toBe(
        translate(locale, 'sim.limit.free_paused'),
      );
  });
});
