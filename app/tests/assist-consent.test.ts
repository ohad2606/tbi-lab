/**
 * TBI-017 slice 1: the remembered AI consent (app/src/assist/consent.ts): per account + version,
 * a version bump asks again, withdraw clears every version of that account only, storage
 * failures are never fatal, keys never hold an email.
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
    const c = new ConsentStore(s, null);
    expect(c.has(undefined, 'v1')).toBe(false);
    expect(c.grant(undefined, 'v1', () => new Date('2026-11-22T00:00:00Z'))).toBe(true);
    expect(c.has(undefined, 'v1')).toBe(true);
    expect(c.has(undefined, 'v2')).toBe(false);
    expect(c.has('acc_1', 'v1')).toBe(false);
    expect(s.map.get(`${CONSENT_PREFIX}/browser/v1`)).toBe(
      JSON.stringify({ accepted: true, at: '2026-11-22T00:00:00.000Z' }),
    );
  });
  it('withdraw removes every version of that account and nothing else', () => {
    const s = memory();
    s.setItem('unrelated', 'x');
    const c = new ConsentStore(s, null);
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
    expect(consentKey('acc_1', 'v1', 'preview-9')).toBe(`preview-9/${CONSENT_PREFIX}/acc_1/v1`);
    const mail = ['someone', 'example.com'].join('@');
    expect(consentKey(mail, 'v1', null)).toBe(`${CONSENT_PREFIX}/browser/v1`);
    expect(consentKey('acc_1', '../x', null)).toBeNull();
    const c = new ConsentStore(memory(), null);
    expect(c.grant('acc_1', '../x')).toBe(false);
  });
  it('a tampered or broken value is not consent; failing storage is never fatal', () => {
    const s = memory();
    const c = new ConsentStore(s, null);
    s.setItem(`${CONSENT_PREFIX}/browser/v1`, '{"accepted":"yes"}');
    expect(c.has(undefined, 'v1')).toBe(false);
    s.setItem(`${CONSENT_PREFIX}/browser/v1`, 'not json');
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
    const b = new ConsentStore(broken, null);
    expect(b.has(undefined, 'v1')).toBe(false);
    expect(b.grant(undefined, 'v1')).toBe(false);
    expect(() => b.withdraw(undefined)).not.toThrow();
    expect(new ConsentStore(null, null).has(undefined, 'v1')).toBe(false);
  });
});
