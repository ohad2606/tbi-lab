/**
 * TBI-017 slice 1: the remembered AI consent (app/src/assist/consent.ts): per account + version,
 * a version bump asks again, withdraw clears every version of that account only, storage
 * failures are never fatal, keys never hold an email. Without an account reference the consent
 * is never written to the long-lived storage (only to the session's).
 */
import { describe, expect, it } from 'vitest';
import {
  CONSENT_PREFIX,
  ConsentStore,
  consentKey,
  type ConsentStorage,
} from '../src/assist/consent.js';

function memory(): ConsentStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('consent store', () => {
  it('remembers per account and version; a new version asks again', () => {
    const s = memory();
    const c = new ConsentStore(s, null, memory());
    expect(c.has('acc_1', 'v1')).toBe(false);
    expect(c.grant('acc_1', 'v1', () => new Date('2026-11-22T00:00:00Z'))).toBe(true);
    expect(c.has('acc_1', 'v1')).toBe(true);
    expect(c.has('acc_1', 'v2')).toBe(false);
    expect(c.has('acc_2', 'v1')).toBe(false);
    expect(c.has(undefined, 'v1')).toBe(false);
    expect(s.map.get(`${CONSENT_PREFIX}/acct:acc_1/v1`)).toBe(
      JSON.stringify({ accepted: true, at: '2026-11-22T00:00:00.000Z' }),
    );
  });
  it('without an account reference: session storage only, never the long-lived one', () => {
    const local = memory();
    const session = memory();
    const c = new ConsentStore(local, null, session);
    expect(c.grant(undefined, 'v1')).toBe(true);
    expect(c.has(undefined, 'v1')).toBe(true);
    expect(local.map.size).toBe(0);
    expect([...session.map.keys()]).toEqual([`${CONSENT_PREFIX}/session/v1`]);
    // A new browser session (new session storage) asks again.
    expect(new ConsentStore(local, null, memory()).has(undefined, 'v1')).toBe(false);
    // An account-less copy never counts for an account, nor the other way round.
    expect(c.has('acc_1', 'v1')).toBe(false);
    c.grant('acc_1', 'v2');
    expect(c.has(undefined, 'v2')).toBe(false);
    c.withdraw(undefined);
    expect(session.map.size).toBe(0);
    expect(c.has('acc_1', 'v2')).toBe(true);
    // No session storage at all: kept in memory for this store (the panel session).
    const m = new ConsentStore(local, null, null);
    expect(m.grant(undefined, 'v1')).toBe(true);
    expect(m.has(undefined, 'v1')).toBe(true);
    expect(local.map.has(`${CONSENT_PREFIX}/session/v1`)).toBe(false);
  });
  it('withdraw removes every version of that account and nothing else', () => {
    const s = memory();
    s.setItem('unrelated', 'x');
    const c = new ConsentStore(s, null, memory());
    c.grant('acc_1', 'v1');
    c.grant('acc_1', 'v2');
    c.grant('acc_2', 'v2');
    c.withdraw('acc_1');
    expect(c.has('acc_1', 'v1')).toBe(false);
    expect(c.has('acc_1', 'v2')).toBe(false);
    expect(c.has('acc_2', 'v2')).toBe(true);
    expect(s.getItem('unrelated')).toBe('x');
  });
  it('keys use the deployment namespace and never an email or an unsafe version', () => {
    expect(consentKey('acc_1', 'v1', 'preview-9')).toBe(
      `preview-9/${CONSENT_PREFIX}/acct:acc_1/v1`,
    );
    const mail = ['someone', 'example.com'].join('@');
    expect(consentKey(mail, 'v1', null)).toBe(`${CONSENT_PREFIX}/session/v1`);
    // An account literally named like the fallback cannot collide with it.
    expect(consentKey('session', 'v1', null)).toBe(`${CONSENT_PREFIX}/acct:session/v1`);
    expect(consentKey('acc_1', '../x', null)).toBeNull();
    const c = new ConsentStore(memory(), null);
    expect(c.grant('acc_1', '../x')).toBe(false);
  });
  it('a tampered or broken value is not consent; failing storage is never fatal', () => {
    const s = memory();
    const c = new ConsentStore(memory(), null, s);
    s.setItem(`${CONSENT_PREFIX}/session/v1`, '{"accepted":"yes"}');
    expect(c.has(undefined, 'v1')).toBe(false);
    s.setItem(`${CONSENT_PREFIX}/session/v1`, 'not json');
    expect(c.has(undefined, 'v1')).toBe(false);
    const broken: ConsentStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
      key: () => null,
      get length(): number {
        throw new Error('denied');
      },
    };
    const b = new ConsentStore(broken, null, broken);
    for (const acc of [undefined, 'acc_1']) {
      expect(b.has(acc, 'v1')).toBe(false);
      expect(b.grant(acc, 'v1')).toBe(false);
      expect(() => b.withdraw(acc)).not.toThrow();
    }
    expect(new ConsentStore(null, null, memory()).has('acc_1', 'v1')).toBe(false);
    expect(new ConsentStore(null, null, memory()).grant('acc_1', 'v1')).toBe(false);
  });
});
