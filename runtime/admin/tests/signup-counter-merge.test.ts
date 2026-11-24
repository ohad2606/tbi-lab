// QA scratch (uncommitted): proves signup_submitted counts once per NEW record via both routes.
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { NonceCache, sign } from '../signup/hmac.js';
import { SlidingWindowLimiter } from '../signup/limits.js';
import { SignupIntake } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';
import { deriveWebKey, issueToken } from '../signup/web.js';

const SECRET = Buffer.from('test-secret-not-real-0123456789abcdef');
const KEY = deriveWebKey(SECRET);
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
it('counts new records once; not honeypot/too_fast/replay/duplicate/invalid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-'));
  chmodSync(root, 0o700);
  let t = T0;
  const now = () => t;
  const lim = () => new SlidingWindowLimiter({ count: 1000, windowMs: 60_000 }, now);
  const events: string[] = [];
  const store = new PendingStore(join(root, 'p'), { now, maxRecords: 100, maxWebRecords: 50 });
  await store.init();
  const intake = new SignupIntake({
    secret: SECRET,
    store,
    notifier: null,
    now,
    sourceRate: lim(),
    globalRate: lim(),
    nonces: new NonceCache(),
    counters: { increment: (e: string) => (events.push(e), true) } as never,
    web: {
      webKey: KEY,
      tokenRate: lim(),
      sourceRate: lim(),
      globalRate: lim(),
      nonces: new NonceCache({ windowMs: 31 * 60_000 }),
    },
  });
  const f = (n: number) => ({
    name: `T ${n}`,
    email: `t${n}@example.com`,
    role: 'T',
    lang: 'en',
    consent: true,
  });
  const web = (o: Record<string, unknown>, tok: string) =>
    intake.submitWeb(
      's',
      Buffer.from(
        JSON.stringify({
          ...o,
          token: tok,
          website: '',
          ...(o.__h !== undefined ? { website: o.__h } : {}),
        }),
      ),
    );
  const tok = () => issueToken(KEY, t);
  t += 10_000;
  // too_fast
  expect((await web(f(1), issueToken(KEY, t - 1))).status).toBe(400);
  // honeypot
  const h = tok();
  t += 10_000;
  expect(
    (await intake.submitWeb('s', Buffer.from(JSON.stringify({ ...f(1), token: h, website: 'x' }))))
      .status,
  ).toBe(400);
  // invalid
  expect((await web({ ...f(1), email: 'bad' }, h)).status).toBe(400);
  expect(events).toEqual([]);
  // new
  expect((await web(f(1), h)).status).toBe(200);
  expect(events).toEqual(['signup_submitted']);
  // replay
  expect((await web(f(2), h)).status).toBe(401);
  // duplicate with fresh token
  const h2 = ((t -= 0), issueToken(KEY, t - 10_000));
  expect((await web(f(1), h2)).status).toBe(200);
  expect(events).toEqual(['signup_submitted']);
  // signed route new + duplicate
  const signed = async (n: number, nonce: string) => {
    const b = Buffer.from(JSON.stringify(f(n)));
    const ts = Math.floor(t / 1000);
    return intake.submit(
      's',
      {
        'x-tbi-timestamp': String(ts),
        'x-tbi-nonce': nonce,
        'x-tbi-signature': sign(SECRET, ts, nonce, b),
      },
      b,
    );
  };
  expect((await signed(3, 'n1n1n1n1n1n1n1n1')).status).toBe(202);
  expect((await signed(3, 'n2n2n2n2n2n2n2n2')).status).toBe(202);
  expect(events).toEqual(['signup_submitted', 'signup_submitted']);
  expect(await store.list()).toHaveLength(2);
  rmSync(root, { recursive: true, force: true });
});
