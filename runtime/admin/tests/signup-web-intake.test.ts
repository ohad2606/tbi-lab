/**
 * BETA-G1 s8: the browser sign-up route (`GET /signup/form-token`, `POST /signup/web`).
 * docs/plans/BETA-G1-WEB-INTAKE.md. Real temp store, real loopback http, injected clock, fake
 * Telegram; no network, no real secret.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NonceCache, sign } from '../signup/hmac.js';
import {
  intakeConfigFromEnv,
  startIntake,
  WEB_GLOBAL_LIMIT,
  WEB_POST_SOURCE_LIMIT,
  WEB_TOKEN_SOURCE_LIMIT,
  type RunningIntake,
} from '../signup/intake-server.js';
import { SlidingWindowLimiter } from '../signup/limits.js';
import type { FetchLike } from '../signup/notify.js';
import { SignupIntake } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';
import { HEARD_FROM_MAX, validateSignup } from '../signup/validate.js';
import {
  allowedOrigin,
  checkToken,
  deriveWebKey,
  issueToken,
  parseOrigins,
  WEB_MIN_FILL_MS,
  WEB_TOKEN_TTL_MS,
} from '../signup/web.js';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const TG_TOKEN = '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test';
const SITE = 'https://signup.example.com';
const FIELDS = {
  name: 'Dana Levi',
  email: 'dana@example.com',
  role: 'T',
  lang: 'he',
  consent: true,
};
const KEY = deriveWebKey(Buffer.from(SECRET));
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);

const roots: string[] = [];
const running: RunningIntake[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.intake.settled();
    await r.close();
  }
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'tbi-web-intake-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

// ------------------------------------------------------------------ token, origins, validation

describe('form token (web.ts)', () => {
  it('round-trips and carries no secret; derived key differs from the secret', () => {
    const t = issueToken(KEY, T0);
    expect(t).toMatch(/^w1\.\d{13}\.[A-Za-z0-9_-]{22}\.[0-9a-f]{64}$/);
    expect(t).not.toContain(SECRET);
    expect(KEY.equals(Buffer.from(SECRET))).toBe(false);
    expect(checkToken(KEY, t, T0 + WEB_MIN_FILL_MS)).toMatchObject({ ok: true, issuedAt: T0 });
  });
  it('refuses missing, malformed, forged, other-key, future, expired and too-fast tokens', () => {
    const t = issueToken(KEY, T0);
    const at = T0 + 10_000;
    for (const m of [undefined, null, ''])
      expect(checkToken(KEY, m, at)).toEqual({ ok: false, reason: 'missing_token' });
    for (const m of [42, {}, 'x', `${t}0`, t.replace(/^w1/, 'w2'), 'a'.repeat(200)])
      expect(checkToken(KEY, m, at)).toEqual({ ok: false, reason: 'bad_token' });
    const [, iat, nonce, mac] = t.split('.');
    // Tampered time, nonce or mac.
    expect(checkToken(KEY, `w1.${Number(iat) - 5000}.${nonce}.${mac}`, at).ok).toBe(false);
    expect(checkToken(KEY, `w1.${iat}.${'A'.repeat(22)}.${mac}`, at).ok).toBe(false);
    expect(checkToken(KEY, `w1.${iat}.${nonce}.${'0'.repeat(64)}`, at).ok).toBe(false);
    // A token of another key (another intake / the raw secret as key) is not accepted.
    expect(checkToken(Buffer.from(SECRET), t, at)).toEqual({ ok: false, reason: 'bad_token' });
    expect(checkToken(KEY, issueToken(KEY, T0 + 60_000), T0)).toEqual({
      ok: false,
      reason: 'bad_token',
    });
    expect(checkToken(KEY, t, T0 + WEB_TOKEN_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(checkToken(KEY, t, T0 + WEB_TOKEN_TTL_MS).ok).toBe(true);
    expect(checkToken(KEY, t, T0 + WEB_MIN_FILL_MS - 1)).toEqual({
      ok: false,
      reason: 'too_fast',
    });
    expect(WEB_MIN_FILL_MS).toBe(3_000);
    expect(WEB_TOKEN_TTL_MS).toBe(30 * 60_000);
  });
  it('is domain-separated from the /signup signature (neither is valid as the other)', () => {
    const t = issueToken(KEY, T0);
    const [, iat, nonce, mac] = t.split('.');
    // The token MAC is not the /signup signature of anything natural built from it...
    const asSig = sign(
      Buffer.from(SECRET),
      Math.floor(Number(iat) / 1000),
      nonce!,
      Buffer.from(''),
    );
    expect(asSig).not.toBe(mac);
    // ...and a /signup signature is not a token MAC.
    const sig = sign(Buffer.from(SECRET), Number(iat), nonce!, Buffer.from(''));
    expect(checkToken(KEY, `w1.${iat}.${nonce}.${sig}`, T0 + 10_000).ok).toBe(false);
  });
});

describe('origin allow-list', () => {
  it('parses exact https origins only; no default', () => {
    expect(parseOrigins(undefined)).toBeNull();
    expect(parseOrigins('')).toBeNull();
    expect(parseOrigins(`${SITE}, https://b.example.com:8443`)).toEqual([
      SITE,
      'https://b.example.com:8443',
    ]);
    for (const bad of [
      'http://a.example.com',
      'https://a.example.com/',
      'https://a.example.com/signup',
      'https://*.example.com',
      'https://user@a.example.com',
      'https://A.example.com',
      'https://a.example.com:443',
      `${SITE},`,
      '*',
      'null',
    ])
      expect(parseOrigins(bad)).toBeNull();
  });
  it('Origin decides when present; Referer only without Origin; null never matches', () => {
    const a = [SITE];
    expect(allowedOrigin({ origin: SITE }, a)).toBe(SITE);
    expect(allowedOrigin({ origin: 'https://evil.example.net' }, a)).toBeNull();
    expect(allowedOrigin({ origin: 'null' }, a)).toBeNull();
    expect(allowedOrigin({ origin: `${SITE}.evil.example.net` }, a)).toBeNull();
    expect(
      allowedOrigin({ origin: 'https://evil.example.net', referer: `${SITE}/he/` }, a),
    ).toBeNull();
    expect(allowedOrigin({ referer: `${SITE}/he/signup?x=1` }, a)).toBe(SITE);
    expect(
      allowedOrigin({ referer: 'https://evil.example.net/?u=https://signup.example.com' }, a),
    ).toBeNull();
    expect(allowedOrigin({ referer: 'not a url' }, a)).toBeNull();
    expect(allowedOrigin({}, a)).toBeNull();
  });
});

describe('heardFrom (validation)', () => {
  it('is refused on the signed route (unchanged) and optional, bounded, cleaned on the web route', () => {
    expect(validateSignup({ ...FIELDS, heardFrom: 'x' })).toEqual({ ok: false, field: 'body' });
    const ok = validateSignup(FIELDS, { heardFrom: true });
    expect(ok.ok && 'heardFrom' in ok.value).toBe(false);
    for (const blank of ['', '   ', '‏'])
      expect(validateSignup({ ...FIELDS, heardFrom: blank }, { heardFrom: true })).toMatchObject({
        ok: true,
        value: { name: 'Dana Levi' },
      });
    const v = validateSignup({ ...FIELDS, heardFrom: '  קבוצת‮  פייסבוק ' }, { heardFrom: true });
    expect(v.ok && v.value.heardFrom).toBe('קבוצת פייסבוק');
    expect(
      validateSignup({ ...FIELDS, heardFrom: 'x'.repeat(HEARD_FROM_MAX) }, { heardFrom: true }).ok,
    ).toBe(true);
    for (const bad of ['x'.repeat(HEARD_FROM_MAX + 1), 7, ['a'], null])
      expect(validateSignup({ ...FIELDS, heardFrom: bad }, { heardFrom: true })).toEqual({
        ok: false,
        field: 'heardFrom',
      });
  });
});

// ------------------------------------------------------------------ the intake (unit, injected clock)

function unitIntake(root: string, over: { postCount?: number; globalCount?: number } = {}) {
  let t = T0;
  const now = () => t;
  const store = new PendingStore(join(root, 'p'), { now });
  const alerts: { name: string; role: string }[] = [];
  const logs: string[] = [];
  const intake = new SignupIntake({
    secret: Buffer.from(SECRET),
    store,
    notifier: { notify: async (m) => void alerts.push(m) },
    now,
    sourceRate: new SlidingWindowLimiter({ count: 1000, windowMs: 60_000 }, now),
    globalRate: new SlidingWindowLimiter({ count: 1000, windowMs: 60_000 }, now),
    nonces: new NonceCache(),
    log: (l) => logs.push(l),
    web: {
      webKey: KEY,
      tokenRate: new SlidingWindowLimiter({ count: 1000, windowMs: 60_000 }, now),
      sourceRate: new SlidingWindowLimiter(
        { count: over.postCount ?? 1000, windowMs: 60_000 },
        now,
      ),
      globalRate: new SlidingWindowLimiter(
        { count: over.globalCount ?? 1000, windowMs: 60_000 },
        now,
      ),
      nonces: new NonceCache({ windowMs: WEB_TOKEN_TTL_MS }),
    },
  });
  return {
    init: () => store.init(),
    intake,
    store,
    alerts,
    logs,
    advance: (ms: number) => (t += ms),
    token: () => {
      const r = intake.issueWebToken('src');
      if (r.status !== 200) throw new Error('token');
      return r.token;
    },
  };
}
const body = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o));

describe('SignupIntake.submitWeb', () => {
  it('stores through the same path as /signup and alerts (name and role only)', async () => {
    const u = unitIntake(tmp());
    await u.init();
    const tok = u.token();
    u.advance(WEB_MIN_FILL_MS);
    const r = await u.intake.submitWeb(
      'src',
      body({ ...FIELDS, heardFrom: 'friend', token: tok, website: '' }),
    );
    expect(r).toEqual({ status: 200 });
    await u.intake.settled();
    const recs = await u.store.list();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      v: 1,
      status: 'pending',
      email: 'dana@example.com',
      heardFrom: 'friend',
    });
    expect(recs[0]!.notified).toBe(true);
    expect(u.alerts).toEqual([{ name: 'Dana Levi', role: 'T' }]);
  });

  it('single use: the same token again is refused (replay), also with another body', async () => {
    const u = unitIntake(tmp());
    await u.init();
    const tok = u.token();
    u.advance(5_000);
    expect(
      (await u.intake.submitWeb('src', body({ ...FIELDS, token: tok, website: '' }))).status,
    ).toBe(200);
    const again = await u.intake.submitWeb(
      'src',
      body({ ...FIELDS, email: 'other@example.com', token: tok, website: '' }),
    );
    expect(again).toEqual({ status: 401, error: 'unauthorized' });
    expect(await u.store.list()).toHaveLength(1);
    expect(u.logs).toContain('signup: web refused (replayed)');
  });

  it('too fast (< 3 s) is refused without consuming the token; the same token works later', async () => {
    const u = unitIntake(tmp());
    await u.init();
    const tok = u.token();
    u.advance(WEB_MIN_FILL_MS - 1);
    const b = body({ ...FIELDS, token: tok, website: '' });
    expect(await u.intake.submitWeb('src', b)).toEqual({ status: 400, error: 'too_fast' });
    u.advance(1);
    expect(await u.intake.submitWeb('src', b)).toEqual({ status: 200 });
  });

  it('expired token: 401 expired (the page fetches a new one)', async () => {
    const u = unitIntake(tmp());
    await u.init();
    const tok = u.token();
    u.advance(WEB_TOKEN_TTL_MS + 1);
    expect(await u.intake.submitWeb('src', body({ ...FIELDS, token: tok, website: '' }))).toEqual({
      status: 401,
      error: 'expired',
    });
    expect(await u.store.list()).toHaveLength(0);
  });

  it('missing / forged token, honeypot filled or absent, bad fields, bad JSON: refused, nothing stored', async () => {
    const u = unitIntake(tmp());
    await u.init();
    const tok = u.token();
    u.advance(5_000);
    const cases: [Record<string, unknown> | string, number, string][] = [
      [{ ...FIELDS, website: '' }, 401, 'unauthorized'],
      [{ ...FIELDS, token: issueToken(Buffer.alloc(32, 1), T0), website: '' }, 401, 'unauthorized'],
      [{ ...FIELDS, token: tok, website: 'http://spam.example' }, 400, 'invalid'],
      [{ ...FIELDS, token: tok }, 400, 'invalid'], // honeypot must be present and empty
      [{ ...FIELDS, token: tok, website: 0 }, 400, 'invalid'],
      [{ ...FIELDS, consent: false, token: tok, website: '' }, 400, 'invalid'],
      [{ ...FIELDS, email: 'nope', token: tok, website: '' }, 400, 'invalid'],
      [{ ...FIELDS, extra: 1, token: tok, website: '' }, 400, 'invalid'],
      ['{not json', 400, 'invalid'],
      ['[1]', 400, 'invalid'],
    ];
    for (const [b, status, error] of cases)
      expect(
        await u.intake.submitWeb('src', typeof b === 'string' ? Buffer.from(b) : body(b)),
      ).toEqual({ status, error });
    expect(await u.store.list()).toHaveLength(0);
    // Invalid answers did not consume the token: the corrected form goes through with it.
    expect(await u.intake.submitWeb('src', body({ ...FIELDS, token: tok, website: '' }))).toEqual({
      status: 200,
    });
    expect(u.logs).toContain('signup: web refused (honeypot)');
    expect(u.logs).toContain('signup: web refused (missing_token)');
  });

  it('per-source limit is checked before the token, the global limit only after it', async () => {
    const u = unitIntake(tmp(), { postCount: 2, globalCount: 1 });
    await u.init();
    // Junk without a token spends the per-source budget, never the global one.
    expect((await u.intake.submitWeb('a', body({}))).status).toBe(401);
    expect((await u.intake.submitWeb('a', body({}))).status).toBe(401);
    expect(await u.intake.submitWeb('a', body({}))).toMatchObject({
      status: 429,
      error: 'rate_limited',
    });
    // Another source with a valid token still gets the (single) global slot.
    const tok = u.token();
    u.advance(5_000);
    expect(await u.intake.submitWeb('b', body({ ...FIELDS, token: tok, website: '' }))).toEqual({
      status: 200,
    });
    const tok2 = u.token();
    u.advance(5_000);
    const r = await u.intake.submitWeb(
      'c',
      body({ ...FIELDS, email: 'x@example.com', token: tok2, website: '' }),
    );
    expect(r).toMatchObject({ status: 429, error: 'rate_limited' });
    expect(u.logs).toContain('signup: web refused (global_limit)');
  });

  it('duplicate address: the same 200 answer, stored and alerted once (no enumeration)', async () => {
    const u = unitIntake(tmp());
    await u.init();
    const send = async (email: string) => {
      const tok = u.token();
      u.advance(4_000);
      return u.intake.submitWeb('src', body({ ...FIELDS, email, token: tok, website: '' }));
    };
    const first = await send('dana@example.com');
    const dup = await send('Dana@Example.com');
    const fresh = await send('new@example.com');
    expect(first).toEqual(dup);
    expect(fresh).toEqual(dup);
    await u.intake.settled();
    expect(await u.store.list()).toHaveLength(2);
    expect(u.alerts).toHaveLength(2);
  });

  it('a new address does not wait for the owner alert (no timing difference from a duplicate)', async () => {
    const root = tmp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let notified = 0;
    let t = T0;
    const now = () => t;
    const store = new PendingStore(join(root, 'p'), { now });
    await store.init();
    const lim = () => new SlidingWindowLimiter({ count: 100, windowMs: 60_000 }, now);
    const intake = new SignupIntake({
      secret: Buffer.from(SECRET),
      store,
      notifier: { notify: async () => (await gate, void notified++) },
      now,
      sourceRate: lim(),
      globalRate: lim(),
      nonces: new NonceCache(),
      web: {
        webKey: KEY,
        tokenRate: lim(),
        sourceRate: lim(),
        globalRate: lim(),
        nonces: new NonceCache({ windowMs: WEB_TOKEN_TTL_MS }),
      },
    });
    const r = intake.issueWebToken('s');
    t += 5_000;
    const tok = r.status === 200 ? r.token : '';
    // Resolves while the alert is still blocked.
    expect(await intake.submitWeb('s', body({ ...FIELDS, token: tok, website: '' }))).toEqual({
      status: 200,
    });
    expect(notified).toBe(0);
    release();
    await intake.settled();
    expect(notified).toBe(1);
    expect((await store.list())[0]!.notified).toBe(true);
  });

  it('logs class codes only: never an address, a name or the token', async () => {
    const u = unitIntake(tmp());
    await u.init();
    const tok = u.token();
    await u.intake.submitWeb('src', body({ ...FIELDS, token: tok, website: 'bot' }));
    u.advance(5_000);
    await u.intake.submitWeb('src', body({ ...FIELDS, email: 'bad', token: tok, website: '' }));
    await u.intake.submitWeb('src', body({ ...FIELDS, token: tok, website: '' }));
    await u.intake.submitWeb('src', body({ ...FIELDS, token: tok, website: '' }));
    const all = u.logs.join('\n');
    for (const s of ['dana', 'Dana', 'Levi', tok, SECRET]) expect(all).not.toContain(s);
    for (const l of u.logs) expect(l).toMatch(/^signup: [a-z ]+(\([a-z_]+\))?$/);
  });

  it('without web deps the route does not exist', async () => {
    const root = tmp();
    const store = new PendingStore(join(root, 'p'));
    const intake = new SignupIntake({
      secret: Buffer.from(SECRET),
      store,
      notifier: null,
      sourceRate: new SlidingWindowLimiter({ count: 10, windowMs: 1000 }),
      globalRate: new SlidingWindowLimiter({ count: 10, windowMs: 1000 }),
      nonces: new NonceCache(),
    });
    expect(intake.issueWebToken('s')).toMatchObject({ status: 404 });
    expect(await intake.submitWeb('s', body(FIELDS))).toMatchObject({ status: 404 });
  });
});

// ------------------------------------------------------------------ real http through startIntake

function envFor(root: string, extra: Record<string, string> = {}) {
  const hmac = join(root, 'hmac');
  const tg = join(root, 'tg');
  writeFileSync(hmac, `${SECRET}\n`, { mode: 0o600 });
  writeFileSync(tg, `${TG_TOKEN}\n`, { mode: 0o600 });
  return {
    TBI_SIGNUP_INTAKE: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_HMAC_FILE: hmac,
    TBI_SIGNUP_TELEGRAM_TOKEN_FILE: tg,
    TBI_SIGNUP_TELEGRAM_CHAT_ID: '42',
    TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.invalid/signups',
    TBI_SIGNUP_LISTEN: '127.0.0.1:0',
    TBI_SIGNUP_SOURCE_HEADER: 'x-forwarded-for',
    TBI_SIGNUP_QUIET: 'off',
    ...extra,
  };
}
const WEB_ON = { TBI_SIGNUP_WEB: '1', TBI_SIGNUP_WEB_ORIGINS: SITE };

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: Record<string, unknown> | null;
}
function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  data?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const h =
      data === undefined
        ? headers
        : { 'content-length': String(Buffer.byteLength(data)), ...headers };
    const req = request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> | null;
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

async function up(extra: Record<string, string> = WEB_ON) {
  const root = tmp();
  const cfg = intakeConfigFromEnv(envFor(root, extra));
  if (!cfg.enabled) throw new Error(`config: ${cfg.reason}`);
  let t = Date.now();
  const sent: string[] = [];
  const logs: string[] = [];
  const fetch: FetchLike = async (_u, init) => (sent.push(init.body), { ok: true, status: 200 });
  const r = await startIntake(cfg.config, { fetch, log: (l) => logs.push(l), now: () => t });
  running.push(r);
  const ip = (n: number) => ({ 'x-forwarded-for': `198.51.100.${n}` });
  return {
    r,
    root,
    sent,
    logs,
    advance: (ms: number) => (t += ms),
    now: () => t,
    async token(src = 1, h: Record<string, string> = { origin: SITE }) {
      const res = await raw(r.port, 'GET', '/signup/form-token', { ...ip(src), ...h });
      return res;
    },
    post(b: unknown, h: Record<string, string> = {}, src = 1) {
      return raw(
        r.port,
        'POST',
        '/signup/web',
        { 'content-type': 'application/json', origin: SITE, ...ip(src), ...h },
        typeof b === 'string' ? b : JSON.stringify(b),
      );
    },
    records: () =>
      readdirSync(join(root, 'p'))
        .filter((f) => /^[0-9A-Z]{26}\.json$/.test(f))
        .map(
          (f) => JSON.parse(readFileSync(join(root, 'p', f), 'utf8')) as Record<string, unknown>,
        ),
  };
}

describe('web route config', () => {
  it('off by default and with 0; any other value or missing/invalid origins refuses to start', () => {
    const root = tmp();
    for (const v of [undefined, '', '0']) {
      const c = intakeConfigFromEnv(envFor(root, v === undefined ? {} : { TBI_SIGNUP_WEB: v }));
      expect(c.enabled && c.config.web).toBeNull();
    }
    // Origins without the flag do not switch anything on.
    const c = intakeConfigFromEnv(envFor(root, { TBI_SIGNUP_WEB_ORIGINS: SITE }));
    expect(c.enabled && c.config.web).toBeNull();
    for (const bad of <Record<string, string>[]>[
      { TBI_SIGNUP_WEB: 'yes' },
      { TBI_SIGNUP_WEB: 'true', TBI_SIGNUP_WEB_ORIGINS: SITE },
      { TBI_SIGNUP_WEB: '1' },
      { TBI_SIGNUP_WEB: '1', TBI_SIGNUP_WEB_ORIGINS: '*' },
      { TBI_SIGNUP_WEB: '1', TBI_SIGNUP_WEB_ORIGINS: 'http://signup.example.com' },
    ])
      expect(intakeConfigFromEnv(envFor(root, bad))).toMatchObject({ enabled: false, error: true });
    const on = intakeConfigFromEnv(envFor(root, WEB_ON));
    expect(on.enabled && on.config.web).toEqual({ origins: [SITE] });
  });
  it('documented limits', () => {
    expect(WEB_TOKEN_SOURCE_LIMIT).toEqual({ count: 20, windowMs: 600_000 });
    expect(WEB_POST_SOURCE_LIMIT).toEqual({ count: 10, windowMs: 600_000 });
    expect(WEB_GLOBAL_LIMIT).toEqual({ count: 200, windowMs: 3_600_000 });
  });
});

describe('web route over http', () => {
  it('flag off: both paths are 404 (every method), /signup unchanged', async () => {
    const s = await up({});
    for (const [m, p] of [
      ['GET', '/signup/form-token'],
      ['POST', '/signup/web'],
      ['OPTIONS', '/signup/web'],
      ['OPTIONS', '/signup/form-token'],
    ] as const)
      expect((await raw(s.r.port, m, p, { origin: SITE })).status).toBe(404);
    expect((await raw(s.r.port, 'GET', '/signup')).status).toBe(405);
  });

  it('token -> wait -> post: 200 received; CORS for the listed origin only, no credentials', async () => {
    const s = await up();
    const t = await s.token();
    expect(t.status).toBe(200);
    expect(t.json).toMatchObject({ ttl: WEB_TOKEN_TTL_MS / 1000 });
    expect(t.headers['access-control-allow-origin']).toBe(SITE);
    expect(t.headers['access-control-allow-credentials']).toBeUndefined();
    expect(t.headers['cache-control']).toBe('no-store');
    expect(t.headers.vary).toBe('Origin');
    s.advance(WEB_MIN_FILL_MS);
    const p = await s.post({ ...FIELDS, heardFrom: 'LinkedIn', token: t.json!.token, website: '' });
    expect(p.status).toBe(200);
    expect(p.json).toEqual({ ok: true, status: 'received' });
    expect(p.headers['access-control-allow-origin']).toBe(SITE);
    expect(p.headers['access-control-allow-credentials']).toBeUndefined();
    await s.r.intake.settled();
    expect(s.records()).toHaveLength(1);
    expect(s.records()[0]).toMatchObject({ heardFrom: 'LinkedIn', status: 'pending', v: 1 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).not.toContain('dana@example.com');
    expect(s.logs.join('\n')).toContain('web route on (1 origin(s))');
    expect(s.logs.join('\n')).not.toContain(SITE);
  });

  it('a same-origin token request (no Origin header) works without CORS headers', async () => {
    const s = await up();
    const t = await s.token(1, {});
    expect(t.status).toBe(200);
    expect(t.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('origin: foreign or missing Origin/Referer refused (403), Referer-only accepted', async () => {
    const s = await up();
    expect((await s.token(1, { origin: 'https://evil.example.net' })).status).toBe(403);
    const t = await s.token();
    s.advance(5_000);
    const b = { ...FIELDS, token: t.json!.token, website: '' };
    const evil = await s.post(b, { origin: 'https://evil.example.net' });
    expect(evil.status).toBe(403);
    expect(evil.json).toEqual({ error: 'forbidden' });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect((await s.post(b, { origin: 'null' })).status).toBe(403);
    // Without Origin, a missing or foreign Referer is refused; a listed one counts.
    const noOrigin = (h: Record<string, string>) =>
      raw(
        s.r.port,
        'POST',
        '/signup/web',
        { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1', ...h },
        JSON.stringify(b),
      );
    expect((await noOrigin({})).status).toBe(403);
    expect((await noOrigin({ referer: 'https://evil.example.net/' })).status).toBe(403);
    expect((await noOrigin({ referer: `${SITE}/he/` })).status).toBe(200);
    expect(s.records()).toHaveLength(1);
  });

  it('CORS preflight: listed origin and the right method only', async () => {
    const s = await up();
    const pre = (h: Record<string, string>, p = '/signup/web') => raw(s.r.port, 'OPTIONS', p, h);
    const ok = await pre({ origin: SITE, 'access-control-request-method': 'POST' });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(SITE);
    expect(ok.headers['access-control-allow-methods']).toBe('POST');
    expect(ok.headers['access-control-allow-headers']).toBe('content-type');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const g = await pre(
      { origin: SITE, 'access-control-request-method': 'GET' },
      '/signup/form-token',
    );
    expect(g.status).toBe(204);
    expect(g.headers['access-control-allow-methods']).toBe('GET');
    expect(
      (await pre({ origin: 'https://evil.example.net', 'access-control-request-method': 'POST' }))
        .status,
    ).toBe(403);
    expect((await pre({ origin: SITE, 'access-control-request-method': 'PUT' })).status).toBe(403);
    expect((await pre({ 'access-control-request-method': 'POST' })).status).toBe(403);
  });

  it('strict content type (415): form posts and text/plain (simple CORS requests) are refused', async () => {
    const s = await up();
    const t = await s.token();
    s.advance(5_000);
    const b = { ...FIELDS, token: t.json!.token, website: '' };
    for (const ct of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      'application/json; charset=latin1',
      'application/jsonx',
      '',
    ]) {
      const r = await s.post(b, { 'content-type': ct });
      expect(r.status).toBe(415);
      expect(r.json).toEqual({ error: 'unsupported_media_type' });
    }
    expect((await s.post(b, { 'content-type': 'application/json; charset=UTF-8' })).status).toBe(
      200,
    );
  });

  it('body cap 4 KiB (413), wrong method (405)', async () => {
    const s = await up();
    const r = await s.post('x'.repeat(4097));
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: 'body_too_large' });
    expect((await raw(s.r.port, 'GET', '/signup/web', { origin: SITE })).status).toBe(405);
    expect((await raw(s.r.port, 'POST', '/signup/form-token', { origin: SITE })).status).toBe(405);
  });

  it('replay over http: the second use of a token is 401', async () => {
    const s = await up();
    const t = await s.token();
    s.advance(5_000);
    const b = { ...FIELDS, token: t.json!.token, website: '' };
    expect((await s.post(b)).status).toBe(200);
    const again = await s.post(b);
    expect(again.status).toBe(401);
    expect(again.json).toEqual({ error: 'unauthorized' });
  });

  it('expiry, too fast and honeypot over http: generic bodies with a machine code', async () => {
    const s = await up();
    const t = await s.token();
    const b = { ...FIELDS, token: t.json!.token, website: '' };
    expect((await s.post(b)).json).toEqual({ error: 'too_fast' });
    s.advance(5_000);
    expect((await s.post({ ...b, website: 'x' })).json).toEqual({ error: 'invalid' });
    s.advance(WEB_TOKEN_TTL_MS);
    const late = await s.post(b);
    expect(late.status).toBe(401);
    expect(late.json).toEqual({ error: 'expired' });
    expect(s.records()).toHaveLength(0);
  });

  it('rate limits: token issue and post per source (429 + retry-after), sources separate', async () => {
    const s = await up();
    const codes: number[] = [];
    for (let i = 0; i < WEB_TOKEN_SOURCE_LIMIT.count + 1; i++)
      codes.push((await s.token(7)).status);
    expect(codes.slice(0, -1).every((c) => c === 200)).toBe(true);
    const last = await s.token(7);
    expect(last.status).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect((await s.token(8)).status).toBe(200);
    const posts: number[] = [];
    for (let i = 0; i < WEB_POST_SOURCE_LIMIT.count + 1; i++)
      posts.push((await s.post({}, {}, 9)).status);
    expect(posts.slice(0, -1).every((c) => c === 401)).toBe(true);
    expect(posts.at(-1)).toBe(429);
  });

  it('duplicate over http: identical status and body for a known and a new address', async () => {
    const s = await up();
    const once = async (email: string, src: number) => {
      const t = await s.token(src);
      s.advance(4_000);
      const r = await s.post({ ...FIELDS, email, token: t.json!.token, website: '' }, {}, src);
      return { status: r.status, json: r.json };
    };
    const a = await once('dana@example.com', 1);
    const b = await once('dana@example.com', 2);
    const c = await once('fresh@example.com', 3);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    await s.r.intake.settled();
    expect(s.records()).toHaveLength(2);
    expect(s.sent).toHaveLength(2);
  });

  it('the signed /signup route behaves identically with the web route on', async () => {
    const s = await up();
    const signed = (b: unknown, over: Record<string, string> = {}) => {
      const text = JSON.stringify(b);
      const ts = Math.floor(s.now() / 1000);
      const nonce = Math.random().toString(36).slice(2).padEnd(20, 'x');
      return raw(
        s.r.port,
        'POST',
        '/signup',
        {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.50',
          'x-tbi-timestamp': String(ts),
          'x-tbi-nonce': nonce,
          'x-tbi-signature': sign(Buffer.from(SECRET), ts, nonce, Buffer.from(text)),
          ...over,
        },
        text,
      );
    };
    const ok = await signed(FIELDS);
    expect(ok.status).toBe(202);
    expect(ok.json).toEqual({ ok: true });
    // heardFrom is still refused on the signed route (its allow-list is unchanged).
    expect((await signed({ ...FIELDS, email: 'b@example.com', heardFrom: 'x' })).json).toEqual({
      error: 'invalid',
    });
    // A web token is not a /signup signature.
    const t = (await s.token()).json!.token as string;
    const [, , n, mac] = t.split('.');
    expect(
      (
        await signed(
          { ...FIELDS, email: 'c@example.com' },
          { 'x-tbi-nonce': n!, 'x-tbi-signature': mac! },
        )
      ).status,
    ).toBe(401);
    // The stored record has exactly the pre-s8 keys (no heardFrom key).
    const [rec] = s.records();
    expect(Object.keys(rec!).sort()).toEqual(
      [
        'v',
        'id',
        'status',
        'createdAt',
        'updatedAt',
        'accountAdded',
        'emailAttemptedAt',
        'emailAttempts',
        'emailSendAfter',
        'lastError',
        'notified',
        'notifyPending',
        'name',
        'email',
        'role',
        'lang',
        'consent',
      ].sort(),
    );
    // A signed duplicate submitted on the web route is answered like a new one.
    const wt = await s.token();
    s.advance(5_000);
    expect((await s.post({ ...FIELDS, token: wt.json!.token, website: '' })).json).toEqual({
      ok: true,
      status: 'received',
    });
    expect(s.records()).toHaveLength(1);
  });
});
