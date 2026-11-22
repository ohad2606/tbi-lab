/**
 * TBI-017 slice 1 follow-ups: sign-out forgets the session-only consent (without importing the
 * assist modules into routine builds), and the Hebrew wording of withdraw / wait messages.
 */
import { describe, expect, it } from 'vitest';
import { CONSENT_PREFIX, ConsentStore, memoryStorage } from '../src/assist/consent.js';
import { he } from '../src/i18n/messages.he.js';
import { SESSION_CONSENT_MARK, forgetSessionConsents } from '../src/ui/signOut.js';

describe('sign-out forgets session consents', () => {
  it('the repeated key prefix matches the consent store', () => {
    expect(SESSION_CONSENT_MARK).toBe(`${CONSENT_PREFIX}/session/`);
  });
  it('removes every version of the session consent (also namespaced) and nothing else', () => {
    const s = memoryStorage();
    const c = new ConsentStore(null, 'ns', s);
    c.grant(undefined, 'v1');
    c.grant(undefined, 'v2');
    s.setItem('other', '1');
    s.setItem(`${CONSENT_PREFIX}/acct:a1/v1`, '{}');
    forgetSessionConsents(s as unknown as Storage);
    expect(c.has(undefined, 'v1')).toBe(false);
    expect(c.has(undefined, 'v2')).toBe(false);
    expect(s.getItem('other')).toBe('1');
    expect(s.getItem(`${CONSENT_PREFIX}/acct:a1/v1`)).toBe('{}');
  });
  it('never throws when storage fails', () => {
    const bad = {
      get length(): number {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(() => forgetSessionConsents(bad)).not.toThrow();
    expect(() => forgetSessionConsents(null)).not.toThrow();
  });
});

describe('Hebrew wording', () => {
  it('withdrawal says the consent was withdrawn (נמשכה), waits spell out seconds', () => {
    expect(he['assist.ai.consent.withdrawn']).toContain('ההסכמה נמשכה');
    expect(he['assist.ai.consent.withdrawn']).not.toContain('בוטלה');
    for (const k of ['assist.ai.error.rate_limited', 'assist.ai.error.busy'] as const) {
      expect(he[k]).toContain('{seconds} שניות');
      expect(he[k]).not.toContain('שנ׳');
    }
  });
});
