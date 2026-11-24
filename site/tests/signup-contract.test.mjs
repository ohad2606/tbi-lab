/**
 * BETA-G1 s10, Fable review finding 7: contract of the REAL page client (site/signup.mjs) against the REAL intake
 * (runtime/admin/signup: startIntake -> http.ts -> SignupIntake -> checkToken / submitWeb) over loopback HTTP with
 * Node's own fetch. Only the clocks are injected: the server clock and the page clock are separate, and the page's
 * `sleep` advances both (time passing). Fake Telegram, temp store, no real secret, no network beyond 127.0.0.1.
 * The bounded retry rules (clamp, too_fast once, no loop) are checked at the end with a scripted fetch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubmitter, createTokenStore, MSG } from '../signup.mjs';
import { intakeConfigFromEnv, startIntake } from '../../runtime/admin/signup/intake-server.ts';
import { WEB_MIN_FILL_MS, WEB_TOKEN_TTL_MS } from '../../runtime/admin/signup/web.ts';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const TG_TOKEN = '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test';
const SITE = 'https://signup.example.com';
const payload = {
  name: 'Dana Levi',
  email: 'dana@example.com',
  role: 'Student',
  lang: 'en',
  consent: true,
  heardFrom: '',
  website: '',
};

const cleanup = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'tbi-su-contract-'));
  chmodSync(root, 0o700);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'hmac'), `${SECRET}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'tg'), `${TG_TOKEN}\n`, { mode: 0o600 });
  const cfg = intakeConfigFromEnv({
    TBI_SIGNUP_INTAKE: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_HMAC_FILE: join(root, 'hmac'),
    TBI_SIGNUP_TELEGRAM_TOKEN_FILE: join(root, 'tg'),
    TBI_SIGNUP_TELEGRAM_CHAT_ID: '42',
    TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.invalid/signups',
    TBI_SIGNUP_LISTEN: '127.0.0.1:0',
    TBI_SIGNUP_SOURCE_HEADER: 'x-forwarded-for',
    TBI_SIGNUP_QUIET: 'off',
    TBI_SIGNUP_WEB: '1',
    TBI_SIGNUP_WEB_ORIGINS: SITE,
  });
  if (!cfg.enabled) throw new Error(`config: ${cfg.reason}`);
  const clock = { server: Date.UTC(2026, 10, 24, 12, 0, 0), page: 1_000_000 };
  const logs = [];
  const r = await startIntake(cfg.config, {
    fetch: async () => ({ ok: true, status: 200 }),
    log: (l) => logs.push(l),
    now: () => clock.server,
  });
  cleanup.push(async () => {
    await r.intake.settled();
    await r.close();
  });
  const calls = [];
  // Node's real fetch to the real server; adds what the browser and the proxy would (Origin, client address).
  const fetchFn = (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    return fetch(url, {
      ...init,
      headers: { ...init.headers, origin: SITE, 'x-forwarded-for': '198.51.100.7' },
    });
  };
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
    clock.server += ms;
    clock.page += ms;
  };
  const base = `http://127.0.0.1:${r.port}/signup`;
  const tokens = createTokenStore({ fetchFn, base, now: () => clock.page });
  const sub = createSubmitter({ fetchFn, base, tokens, sleep });
  const records = () => readdirSync(join(root, 'p')).filter((f) => /^[0-9A-Z]{26}\.json$/.test(f));
  return { clock, calls, waits, tokens, sub, records, logs };
}

describe('page client <-> real intake (finding 7)', () => {
  it('submit right after the token arrives: the page waits the server minFill, then 200', async () => {
    const h = await harness();
    expect(await h.sub.submit(payload)).toEqual({ ok: true });
    expect(h.waits).toEqual([WEB_MIN_FILL_MS]);
    expect(h.calls).toEqual(['GET /signup/form-token', 'POST /signup/web']);
    expect(h.records()).toHaveLength(1);
  });

  it('token warmed on page load and a person who takes longer than minFill: no wait at all', async () => {
    const h = await harness();
    await h.tokens.get();
    h.clock.server += 20_000;
    h.clock.page += 20_000;
    expect(await h.sub.submit(payload)).toEqual({ ok: true });
    expect(h.waits).toEqual([]);
    expect(h.records()).toHaveLength(1);
  });

  it('401 the page could not foresee (expired on the server clock): new token, wait, one more post, 200', async () => {
    const h = await harness();
    await h.tokens.get();
    h.clock.page += 5_000; // the person types for 5 s ...
    h.clock.server += WEB_TOKEN_TTL_MS + 1; // ... but the token is already expired on the server (e.g. sleep)
    expect(await h.sub.submit(payload)).toEqual({ ok: true });
    expect(h.calls).toEqual([
      'GET /signup/form-token',
      'POST /signup/web',
      'GET /signup/form-token',
      'POST /signup/web',
    ]);
    expect(h.waits).toEqual([WEB_MIN_FILL_MS]);
    expect(h.records()).toHaveLength(1);
    expect(h.logs).toContain('signup: web refused (expired)');
    expect(h.logs).not.toContain('signup: web refused (too_fast)');
  });
});

/* ---- bounded retries, scripted answers (the server cannot be made to send these on demand) ---- */
const res = (status, body = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
function scripted(tokenBodies, postAnswers) {
  const calls = [];
  let t = 0;
  const waits = [];
  const fetchFn = async (url, init) => {
    calls.push(init.method === 'GET' ? 'GET' : `POST ${JSON.parse(init.body).token}`);
    if (init.method === 'GET') return res(200, tokenBodies.shift());
    return postAnswers.shift() ?? res(200, { ok: true });
  };
  const tokens = createTokenStore({ fetchFn, base: '/signup', now: () => t });
  const sub = createSubmitter({
    fetchFn,
    base: '/signup',
    tokens,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
  });
  return { calls, waits, sub };
}
const tooFast = () => res(400, { error: 'too_fast' });

describe('client retry bounds (finding 7)', () => {
  it.each([
    [60, 10_000],
    [10, 10_000],
    [3, 3_000],
    [0, 0],
    [-5, 0],
    ['3', 3_000],
    [undefined, 3_000],
    [Number.NaN, 3_000],
  ])('minFill %s from the server -> waits %i ms (clamped 0-10 s)', async (minFill, ms) => {
    const s = scripted([{ token: 'a', ttl: 1800, minFill }], []);
    expect(await s.sub.submit(payload)).toEqual({ ok: true });
    expect(s.waits).toEqual(ms ? [ms] : []);
  });

  it('too_fast after waiting: waits once more, posts once more with the SAME token, then stops', async () => {
    const s = scripted([{ token: 'a', ttl: 1800, minFill: 3 }], [tooFast(), tooFast(), tooFast()]);
    expect(await s.sub.submit(payload)).toEqual({ ok: false, msg: MSG.tooFast });
    expect(s.calls).toEqual(['GET', 'POST a', 'POST a']);
    expect(s.waits).toEqual([3_000, 3_000]);
  });

  it('too_fast then success on the second post', async () => {
    const s = scripted([{ token: 'a', ttl: 1800, minFill: 3 }], [tooFast()]);
    expect(await s.sub.submit(payload)).toEqual({ ok: true });
    expect(s.calls).toEqual(['GET', 'POST a', 'POST a']);
  });

  it('401 then too_fast: one new token, at most three posts, never a loop', async () => {
    const s = scripted(
      [
        { token: 'a', ttl: 1800, minFill: 3 },
        { token: 'b', ttl: 1800, minFill: 3 },
      ],
      [res(401, { error: 'expired' }), tooFast(), tooFast(), tooFast()],
    );
    expect(await s.sub.submit(payload)).toEqual({ ok: false, msg: MSG.tooFast });
    expect(s.calls).toEqual(['GET', 'POST a', 'GET', 'POST b', 'POST b']);
  });

  it('too_fast then 401: the new token is fetched only after the 401; no second too_fast wait', async () => {
    const s = scripted(
      [
        { token: 'a', ttl: 1800, minFill: 3 },
        { token: 'b', ttl: 1800, minFill: 3 },
      ],
      [tooFast(), res(401, { error: 'unauthorized' }), tooFast(), tooFast()],
    );
    expect(await s.sub.submit(payload)).toEqual({ ok: false, msg: MSG.tooFast });
    expect(s.calls).toEqual(['GET', 'POST a', 'POST a', 'GET', 'POST b']);
    expect(s.waits).toEqual([3_000, 3_000, 3_000]);
  });
});
