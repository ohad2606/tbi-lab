/** TBI-022: the Apps Script signer (deploy/signup/apps-script/Code.gs) verifies with runtime hmac.ts. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { NonceCache, sign, verifyRequest } from '../signup/hmac.js';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const NONCE = 'abcdefghijklmnop0123';
const TS = 1_795_000_000;
const BODY = '{"name":"Dana כהן","email":"a@example.com","role":"x","lang":"he","consent":true}';

/** Loads Code.gs with Node stand-ins for the Apps Script services it uses. */
function load(): { signRequest_: (s: string, t: number, n: string, b: string) => string } {
  const src = readFileSync(
    new URL('../../../deploy/signup/apps-script/Code.gs', import.meta.url),
    'utf8',
  );
  const Utilities = {
    newBlob: (s: string) => ({
      getBytes: () => [...Buffer.from(s, 'utf8')].map((b) => (b > 127 ? b - 256 : b)),
    }),
    computeHmacSha256Signature: (m: number[], k: number[]) =>
      [
        ...createHmac('sha256', Buffer.from(k.map((b) => b & 255)))
          .update(Buffer.from(m.map((b) => b & 255)))
          .digest(),
      ].map((b) => (b > 127 ? b - 256 : b)),
  };
  const ctx: Record<string, unknown> = { Utilities, console };
  runInNewContext(src, ctx);
  return ctx as never;
}

describe('Apps Script signer parity', () => {
  it('produces the same signature as runtime sign()', () => {
    const gs = load();
    expect(gs.signRequest_(SECRET, TS, NONCE, BODY)).toBe(
      sign(Buffer.from(SECRET), TS, NONCE, Buffer.from(BODY, 'utf8')),
    );
  });

  it('verifies with verifyRequest, and a changed body fails', () => {
    const gs = load();
    const headers = {
      'x-tbi-timestamp': String(TS),
      'x-tbi-nonce': NONCE,
      'x-tbi-signature': gs.signRequest_(SECRET, TS, NONCE, BODY),
    };
    const base = { secret: Buffer.from(SECRET), headers, now: TS * 1000, nonces: new NonceCache() };
    expect(verifyRequest({ ...base, body: Buffer.from(BODY, 'utf8') })).toEqual({ ok: true });
    expect(
      verifyRequest({ ...base, body: Buffer.from(BODY + ' ', 'utf8'), nonces: new NonceCache() }),
    ).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
