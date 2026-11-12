/**
 * The Vite proxies' identity handling (scripts/vite-identity-gate.ts, used by the Lab's and the
 * admin app's vite.config.ts): browser-sent identity headers are always dropped; a test identity
 * is asserted only in explicit test mode.
 */
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  identityGate,
  isIdentityHeader,
  testGateEnabled,
} from '../../scripts/vite-identity-gate.js';

/** Runs the hook against a request carrying `headers` and the browser's `cookie`. */
function proxied(testMode: boolean, headers: Record<string, string>, cookie?: string) {
  const out = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const proxyReq = {
    getHeaderNames: () => [...out.keys()],
    removeHeader: (n: string) => void out.delete(n),
    setHeader: (n: string, v: string) => void out.set(n, v),
  };
  let handler: ((p: typeof proxyReq, r: IncomingMessage) => void) | undefined;
  const proxy = { on: (_e: string, h: typeof handler) => (handler = h) };
  identityGate(testMode)(proxy as never);
  handler!(proxyReq, { headers: cookie ? { cookie } : {} } as IncomingMessage);
  return Object.fromEntries(out);
}

const FORGED = {
  'X-Forwarded-User': 'owner-sub',
  'X-Forwarded-Email': 'owner@example.invalid',
  'X-Forwarded-Preferred-Username': 'owner',
  'X-Auth-Request-Email': 'owner@example.invalid',
  'X-TBI-Principal': 'p_forged',
  'Gap-Auth': 'owner',
  accept: 'application/json',
};

describe('vite proxy identity gate', () => {
  it('outside test mode strips every identity header and asserts none', () => {
    expect(proxied(false, FORGED, 'tbi_test_user=someone')).toEqual({
      accept: 'application/json',
    });
  });

  it('in test mode strips the forged headers and asserts the cookie identity', () => {
    expect(proxied(true, FORGED)).toEqual({
      accept: 'application/json',
      'x-forwarded-user': 'e2e-user',
    });
    expect(
      proxied(true, FORGED, 'a=1; tbi_test_user=t-2; tbi_test_email=t2@example.invalid'),
    ).toEqual({
      accept: 'application/json',
      'x-forwarded-user': 't-2',
      'x-forwarded-email': 't2@example.invalid',
    });
  });

  it('test mode is exactly TBI_TEST_GATE=1', () => {
    expect(testGateEnabled({ TBI_TEST_GATE: '1' })).toBe(true);
    for (const v of [undefined, '', '0', 'true', 'yes'])
      expect(testGateEnabled({ TBI_TEST_GATE: v })).toBe(false);
    expect(isIdentityHeader('content-type')).toBe(false);
    expect(isIdentityHeader('X-Forwarded-For')).toBe(false);
  });
});
