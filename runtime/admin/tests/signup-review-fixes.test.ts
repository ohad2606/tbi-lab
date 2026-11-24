/**
 * BETA-G1 s10 Fable review of PR #94: finding 2 (honeypot hits must not fill the web nonce cache)
 * and finding 7 (the token answer carries the server's fixed minimum fill time in whole seconds).
 * Real temp store, injected clock, no network.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NonceCache } from '../signup/hmac.js';
import { SlidingWindowLimiter } from '../signup/limits.js';
import { SignupIntake } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';
import { deriveWebKey, WEB_MIN_FILL_MS, WEB_TOKEN_TTL_MS } from '../signup/web.js';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const KEY = deriveWebKey(Buffer.from(SECRET));
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
const person = (i: number) => ({
  name: `Tester ${i}`,
  email: `tester${i}@example.com`,
  role: 'T',
  lang: 'en' as const,
  consent: true as const,
});
const body = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o));

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function unit(o: { nonceMax?: number; postCount?: number; minFillMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tbi-web-review-'));
  roots.push(root);
  chmodSync(root, 0o700);
  let t = T0;
  const now = () => t;
  const store = new PendingStore(join(root, 'p'), { now, maxRecords: 100, maxWebRecords: 50 });
  const logs: string[] = [];
  const lim = (count = 1000) => new SlidingWindowLimiter({ count, windowMs: 600_000 }, now);
  const nonces = new NonceCache({ windowMs: WEB_TOKEN_TTL_MS, max: o.nonceMax ?? 10_000 });
  const intake = new SignupIntake({
    secret: Buffer.from(SECRET),
    store,
    notifier: null,
    now,
    sourceRate: lim(),
    globalRate: lim(),
    nonces: new NonceCache(),
    log: (l) => logs.push(l),
    web: {
      webKey: KEY,
      tokenRate: lim(),
      sourceRate: lim(o.postCount),
      globalRate: lim(),
      nonces,
      ...(o.minFillMs === undefined ? {} : { minFillMs: o.minFillMs }),
    },
  });
  return {
    store,
    intake,
    nonces,
    logs,
    advance: (ms: number) => (t += ms),
    token: (src = 'src') => {
      const r = intake.issueWebToken(src);
      if (r.status !== 200) throw new Error('token');
      return r.token;
    },
  };
}

describe('finding 2: honeypot hits are not recorded in the nonce cache', () => {
  it('many sources posting honeypot hits leave a small cache empty; a real post still gets 200', async () => {
    const u = unit({ nonceMax: 5 });
    await u.store.init();
    const toks: [string, string][] = [];
    for (let s = 0; s < 40; s++) toks.push([`2001:db8:${s}::/64`, u.token(`2001:db8:${s}::/64`)]);
    const real = u.token();
    u.advance(WEB_MIN_FILL_MS);
    for (const [src, tok] of toks)
      expect(
        await u.intake.submitWeb(src, body({ ...person(1), token: tok, website: 'http://x' })),
      ).toEqual({ status: 400, error: 'invalid' });
    expect(u.nonces.size).toBe(0);
    expect(await u.intake.submitWeb('src', body({ ...person(2), token: real, website: '' }))).toEqual(
      { status: 200 },
    );
    expect(await u.store.list()).toHaveLength(1);
    // Logs carry the fixed class code only (no address, token or nonce).
    expect(u.logs.filter((l) => l === 'signup: web refused (honeypot)')).toHaveLength(40);
    expect(u.logs.join('\n')).not.toMatch(/2001:db8|tester|w1\./);
  });

  it('a honeypot hit answers exactly like a typo; the same token may be resent, bounded by the per-source limit', async () => {
    const u = unit({ postCount: 3 });
    await u.store.init();
    const tok = u.token();
    u.advance(WEB_MIN_FILL_MS);
    const hp = body({ ...person(1), token: tok, website: 'spam' });
    expect(await u.intake.submitWeb('bot', hp)).toEqual({ status: 400, error: 'invalid' });
    expect(await u.intake.submitWeb('bot', hp)).toEqual({ status: 400, error: 'invalid' });
    expect(await u.intake.submitWeb('bot', hp)).toEqual({ status: 400, error: 'invalid' });
    expect(await u.intake.submitWeb('bot', hp)).toMatchObject({ status: 429 });
    expect(u.nonces.size).toBe(0);
    expect(await u.store.list()).toHaveLength(0);
  });

  it('when the cache is truly full of used tokens, a new post is refused with 401 and nothing is stored', async () => {
    const u = unit({ nonceMax: 2 });
    await u.store.init();
    const a = u.token();
    const b = u.token();
    const c = u.token();
    u.advance(WEB_MIN_FILL_MS);
    expect(await u.intake.submitWeb('s', body({ ...person(1), token: a, website: '' }))).toEqual({
      status: 200,
    });
    expect(await u.intake.submitWeb('s', body({ ...person(2), token: b, website: '' }))).toEqual({
      status: 200,
    });
    expect(u.nonces.size).toBe(2);
    expect(await u.intake.submitWeb('s', body({ ...person(3), token: c, website: '' }))).toEqual({
      status: 401,
      error: 'unauthorized',
    });
    expect(await u.store.list()).toHaveLength(2);
    expect(u.nonces.size).toBe(2);
  });
});

describe('finding 7: the token answer carries the fixed minimum fill time', () => {
  it('minFill is the server constant in whole seconds, the same for every source', () => {
    const u = unit();
    const a = u.intake.issueWebToken('a');
    const b = u.intake.issueWebToken('b');
    expect(a).toMatchObject({ status: 200, minFill: WEB_MIN_FILL_MS / 1000 });
    expect(b).toMatchObject({ status: 200, minFill: WEB_MIN_FILL_MS / 1000 });
    expect(Number.isInteger(WEB_MIN_FILL_MS / 1000)).toBe(true);
  });

  it('a configured fill time that is not whole seconds is rounded up (never tells the page to wait too little)', () => {
    const u = unit({ minFillMs: 2_500 });
    expect(u.intake.issueWebToken('a')).toMatchObject({ status: 200, minFill: 3 });
  });
});
