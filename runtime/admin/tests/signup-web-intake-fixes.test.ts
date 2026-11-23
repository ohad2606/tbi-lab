/**
 * BETA-G1 s8 fix round (ops review H1, M1-M3, L2; QA minor): the web sub-cap of the shared store,
 * the order of the global slot / token consumption in submitWeb, the web source key (IPv6 /64,
 * IPv4-mapped), and the refusal without a source header. Real temp store; fake clock.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NonceCache, sign } from '../signup/hmac.js';
import { webBucket } from '../signup/http.js';
import {
  intakeConfigFromEnv,
  INTAKE_MAX_RECORDS,
  startIntake,
  WEB_MAX_RECORDS,
  WEB_TOKEN_SOURCE_LIMIT,
  type RunningIntake,
} from '../signup/intake-server.js';
import { SlidingWindowLimiter } from '../signup/limits.js';
import type { FetchLike } from '../signup/notify.js';
import { SignupIntake } from '../signup/service.js';
import { PendingStore, StoreError } from '../signup/store.js';
import { deriveWebKey, WEB_MIN_FILL_MS, WEB_TOKEN_TTL_MS } from '../signup/web.js';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const TG_TOKEN = '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test';
const SITE = 'https://signup.example.com';
const KEY = deriveWebKey(Buffer.from(SECRET));
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
const person = (i: number) => ({
  name: `Tester ${i}`,
  email: `tester${i}@example.com`,
  role: 'T',
  lang: 'en' as const,
  consent: true as const,
});
const FIELDS = { ...person(0) };

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
  const root = mkdtempSync(join(tmpdir(), 'tbi-web-fix-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}
const body = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o));

// ------------------------------------------------------------------ H1: web sub-cap (store)

describe('H1 store: web-origin records have their own sub-cap', () => {
  it('web records are marked origin=web (no schema bump); signed ones carry no origin', async () => {
    const store = new PendingStore(join(tmp(), 'p'), { maxRecords: 10, maxWebRecords: 5 });
    await store.init();
    const w = await store.createIfNew(person(1), { origin: 'web' });
    const s = await store.createIfNew(person(2));
    expect(w.record).toMatchObject({ v: 1, origin: 'web' });
    expect(s.record.v).toBe(1);
    expect('origin' in s.record).toBe(false);
    expect((await store.get(w.record.id)).origin).toBe('web');
    expect((await store.get(s.record.id)).origin).toBeUndefined();
  });

  it('at the web sub-cap a new web record is refused (full); the signed route still stores', async () => {
    const store = new PendingStore(join(tmp(), 'p'), { maxRecords: 5, maxWebRecords: 2 });
    await store.init();
    await store.createIfNew(person(1), { origin: 'web' });
    await store.createIfNew(person(2), { origin: 'web' });
    await expect(store.createIfNew(person(3), { origin: 'web' })).rejects.toEqual(
      new StoreError('full'),
    );
    for (const i of [4, 5, 6]) expect((await store.createIfNew(person(i))).created).toBe(true);
    // The shared cap still binds everyone.
    await expect(store.createIfNew(person(7))).rejects.toEqual(new StoreError('full'));
    expect((await store.list()).length).toBe(5);
  });

  it('at the web sub-cap a web repeat of a live address is refused too (no address oracle)', async () => {
    const store = new PendingStore(join(tmp(), 'p'), { maxRecords: 10, maxWebRecords: 1 });
    await store.init();
    await store.createIfNew(person(1), { origin: 'web' });
    await expect(store.createIfNew(person(1), { origin: 'web' })).rejects.toEqual(
      new StoreError('full'),
    );
    // The signed route keeps its documented dedupe-first answer.
    expect((await store.createIfNew(person(1))).created).toBe(false);
  });

  it('purge frees web slots (marker removed); an orphan marker is not counted', async () => {
    let t = T0;
    const dir = join(tmp(), 'p');
    const store = new PendingStore(dir, { now: () => t, maxRecords: 10, maxWebRecords: 1 });
    await store.init();
    writeFileSync(join(dir, '01JZZZZZZZZZZZZZZZZZZZZZZZ.web'), '', { mode: 0o600 }); // no record
    await store.createIfNew(person(1), { origin: 'web' });
    await expect(store.createIfNew(person(2), { origin: 'web' })).rejects.toEqual(
      new StoreError('full'),
    );
    t += 91 * 86_400_000;
    expect(await store.purge()).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.web'))).toEqual([]);
    expect((await store.createIfNew(person(2), { origin: 'web' })).created).toBe(true);
  });

  it('documented values: web sub-cap well below the shared cap', () => {
    expect(INTAKE_MAX_RECORDS).toBe(5_000);
    expect(WEB_MAX_RECORDS).toBe(1_500);
  });
});

// ------------------------------------------------------------------ service

function unit(
  root: string,
  o: { globalCount?: number; maxWebRecords?: number; maxRecords?: number } = {},
) {
  let t = T0;
  const now = () => t;
  const store = new PendingStore(join(root, 'p'), {
    now,
    maxRecords: o.maxRecords ?? 100,
    maxWebRecords: o.maxWebRecords ?? 50,
  });
  const logs: string[] = [];
  const lim = (count = 1000) => new SlidingWindowLimiter({ count, windowMs: 60_000 }, now);
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
      sourceRate: lim(),
      globalRate: lim(o.globalCount),
      nonces: new NonceCache({ windowMs: WEB_TOKEN_TTL_MS }),
    },
  });
  return {
    store,
    intake,
    logs,
    advance: (ms: number) => (t += ms),
    now,
    token: () => {
      const r = intake.issueWebToken('src');
      if (r.status !== 200) throw new Error('token');
      return r.token;
    },
    signed: (fields: Record<string, unknown>, n: number) => {
      const text = JSON.stringify(fields);
      const ts = Math.floor(t / 1000);
      const nonce = `nonce-${n}-abcdefghijklmnop`;
      return intake.submit(
        'gas',
        {
          'x-tbi-timestamp': String(ts),
          'x-tbi-nonce': nonce,
          'x-tbi-signature': sign(Buffer.from(SECRET), ts, nonce, Buffer.from(text)),
        },
        Buffer.from(text),
      );
    },
  };
}

describe('H1 service: web cap answers 503 unavailable for web only', () => {
  it('web records past the sub-cap get 503; /signup (signed) keeps storing', async () => {
    const u = unit(tmp(), { maxWebRecords: 2 });
    await u.store.init();
    const web = async (i: number) => {
      const tok = u.token();
      u.advance(WEB_MIN_FILL_MS);
      return u.intake.submitWeb('src', body({ ...person(i), token: tok, website: '' }));
    };
    expect(await web(1)).toEqual({ status: 200 });
    expect(await web(2)).toEqual({ status: 200 });
    expect(await web(3)).toEqual({ status: 503, error: 'unavailable' });
    expect(await u.signed(person(4), 1)).toEqual({ status: 202 });
    const recs = await u.store.list();
    expect(recs.filter((r) => r.origin === 'web')).toHaveLength(2);
    expect(recs).toHaveLength(3);
    expect(u.logs).toContain('signup: store failed (full)');
  });
});

describe('M1: global slot only after honeypot + validation; honeypot consumes the token', () => {
  it('honeypot and invalid posts do not spend the global slot', async () => {
    const u = unit(tmp(), { globalCount: 1 });
    await u.store.init();
    const t1 = u.token();
    const t2 = u.token();
    u.advance(WEB_MIN_FILL_MS);
    expect(
      await u.intake.submitWeb('src', body({ ...FIELDS, token: t1, website: 'spam' })),
    ).toEqual({ status: 400, error: 'invalid' });
    expect(
      await u.intake.submitWeb('src', body({ ...FIELDS, email: 'nope', token: t2, website: '' })),
    ).toEqual({ status: 400, error: 'invalid' });
    // The single global slot is still free for a real request.
    expect(await u.intake.submitWeb('src', body({ ...FIELDS, token: t2, website: '' }))).toEqual({
      status: 200,
    });
    expect(u.logs).not.toContain('signup: web refused (global_limit)');
  });

  it('a honeypot hit burns the token: the same token is refused afterwards', async () => {
    const u = unit(tmp());
    await u.store.init();
    const tok = u.token();
    u.advance(WEB_MIN_FILL_MS);
    expect((await u.intake.submitWeb('src', body({ ...FIELDS, token: tok }))).status).toBe(400);
    expect(await u.intake.submitWeb('src', body({ ...FIELDS, token: tok, website: '' }))).toEqual({
      status: 401,
      error: 'unauthorized',
    });
    expect(await u.store.list()).toHaveLength(0);
  });

  it('a replayed token is refused before it can spend the global slot', async () => {
    const u = unit(tmp(), { globalCount: 2 });
    await u.store.init();
    const a = u.token();
    const b = u.token();
    u.advance(WEB_MIN_FILL_MS);
    const ab = body({ ...FIELDS, token: a, website: '' });
    expect(await u.intake.submitWeb('src', ab)).toEqual({ status: 200 });
    expect(await u.intake.submitWeb('src', ab)).toEqual({ status: 401, error: 'unauthorized' });
    expect(await u.intake.submitWeb('src', body({ ...person(1), token: b, website: '' }))).toEqual({
      status: 200,
    });
  });

  it('global limit refusal does not consume the token (retry later with it)', async () => {
    const u = unit(tmp(), { globalCount: 1 });
    await u.store.init();
    const a = u.token();
    const b = u.token();
    u.advance(WEB_MIN_FILL_MS);
    expect(
      (await u.intake.submitWeb('src', body({ ...FIELDS, token: a, website: '' }))).status,
    ).toBe(200);
    const bb = body({ ...person(1), token: b, website: '' });
    expect(await u.intake.submitWeb('src', bb)).toMatchObject({ status: 429 });
    u.advance(60_000);
    expect(await u.intake.submitWeb('src', bb)).toEqual({ status: 200 });
  });
});

describe('QA minor: a store failure (503) does not burn the token, without double use', () => {
  it('after a 503 the same token works once; never twice', async () => {
    const u = unit(tmp());
    await u.store.init();
    const real = u.store.createIfNew.bind(u.store);
    let fail = 1;
    u.store.createIfNew = (async (...a: Parameters<typeof real>) => {
      if (fail-- > 0) throw new StoreError('corrupt');
      return real(...a);
    }) as typeof real;
    const tok = u.token();
    u.advance(WEB_MIN_FILL_MS);
    const b = body({ ...FIELDS, token: tok, website: '' });
    expect(await u.intake.submitWeb('src', b)).toEqual({ status: 503, error: 'unavailable' });
    expect(await u.intake.submitWeb('src', b)).toEqual({ status: 200 });
    expect(
      await u.intake.submitWeb('src', body({ ...person(1), token: tok, website: '' })),
    ).toEqual({ status: 401, error: 'unauthorized' });
    expect(await u.store.list()).toHaveLength(1);
  });

  it('two concurrent posts with one token: exactly one is accepted', async () => {
    const u = unit(tmp());
    await u.store.init();
    const tok = u.token();
    u.advance(WEB_MIN_FILL_MS);
    const out = await Promise.all([
      u.intake.submitWeb('src', body({ ...person(1), token: tok, website: '' })),
      u.intake.submitWeb('src', body({ ...person(2), token: tok, website: '' })),
    ]);
    expect(out.map((o) => o.status).sort()).toEqual([200, 401]);
    expect(await u.store.list()).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ M2/M3: web source key

describe('M2/M3: web source bucket', () => {
  it('IPv4 as is; IPv4-mapped IPv6 (dotted or hex) normalised to IPv4', () => {
    expect(webBucket('198.51.100.7')).toBe('198.51.100.7');
    expect(webBucket('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(webBucket('::FFFF:198.51.100.7')).toBe('198.51.100.7');
    expect(webBucket('::ffff:c633:6407')).toBe('198.51.100.7');
    expect(webBucket('0:0:0:0:0:ffff:c633:6407')).toBe('198.51.100.7');
  });
  it('IPv6 is bucketed per /64 (canonical form)', () => {
    const k = '2001:db8:1:2::/64';
    expect(webBucket('2001:db8:1:2:3:4:5:6')).toBe(k);
    expect(webBucket('2001:0DB8:0001:0002:ffff::1')).toBe(k);
    expect(webBucket('2001:db8:1:2::')).toBe(k);
    expect(webBucket('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(webBucket('::1')).toBe('0:0:0:0::/64');
    expect(webBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(webBucket('64:ff9b::198.51.100.7')).toBe('64:ff9b:0:0::/64');
  });
  it('anything that is not an IP is null', () => {
    for (const v of ['', 'unknown', '198.51.100.7:443', '[::1]', '1.2.3', 'x'.repeat(80)])
      expect(webBucket(v)).toBeNull();
  });
});

// ------------------------------------------------------------------ over http

interface Res {
  status: number;
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
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

async function up() {
  const root = tmp();
  const hmac = join(root, 'hmac');
  const tg = join(root, 'tg');
  writeFileSync(hmac, `${SECRET}\n`, { mode: 0o600 });
  writeFileSync(tg, `${TG_TOKEN}\n`, { mode: 0o600 });
  const cfg = intakeConfigFromEnv({
    TBI_SIGNUP_INTAKE: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_HMAC_FILE: hmac,
    TBI_SIGNUP_TELEGRAM_TOKEN_FILE: tg,
    TBI_SIGNUP_TELEGRAM_CHAT_ID: '42',
    TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.invalid/signups',
    TBI_SIGNUP_LISTEN: '127.0.0.1:0',
    TBI_SIGNUP_SOURCE_HEADER: 'x-forwarded-for',
    TBI_SIGNUP_QUIET: 'off',
    TBI_SIGNUP_WEB: '1',
    TBI_SIGNUP_WEB_ORIGINS: SITE,
  });
  if (!cfg.enabled) throw new Error(`config: ${cfg.reason}`);
  const logs: string[] = [];
  const fetch: FetchLike = async () => ({ ok: true, status: 200 });
  const r = await startIntake(cfg.config, { fetch, log: (l) => logs.push(l) });
  running.push(r);
  return { r, logs };
}

describe('M2/M3 + L2 over http', () => {
  it('addresses inside one IPv6 /64 share the token budget; another /64 does not', async () => {
    const { r } = await up();
    const get = (ip: string) =>
      raw(r.port, 'GET', '/signup/form-token', { origin: SITE, 'x-forwarded-for': ip });
    for (let i = 1; i <= WEB_TOKEN_SOURCE_LIMIT.count; i++)
      expect((await get(`2001:db8:1:2::${i.toString(16)}`)).status).toBe(200);
    expect((await get('2001:db8:1:2:ffff:ffff:ffff:fffe')).status).toBe(429);
    expect((await get('2001:db8:1:3::1')).status).toBe(200);
  });

  it('an IPv4-mapped address shares the bucket of the plain IPv4 address', async () => {
    const { r } = await up();
    const get = (ip: string) =>
      raw(r.port, 'GET', '/signup/form-token', { origin: SITE, 'x-forwarded-for': ip });
    for (let i = 1; i <= WEB_TOKEN_SOURCE_LIMIT.count; i++)
      expect((await get(i % 2 ? '198.51.100.9' : '::ffff:198.51.100.9')).status).toBe(200);
    expect((await get('::ffff:c633:6409')).status).toBe(429);
  });

  it('without a valid source header the web route answers 503 unavailable (logged once)', async () => {
    const { r, logs } = await up();
    const t = await raw(r.port, 'GET', '/signup/form-token', { origin: SITE });
    expect(t).toEqual({ status: 503, json: { error: 'unavailable' } });
    const p = await raw(
      r.port,
      'POST',
      '/signup/web',
      { 'content-type': 'application/json', origin: SITE, 'x-forwarded-for': 'junk' },
      JSON.stringify({ ...FIELDS, website: '' }),
    );
    expect(p).toEqual({ status: 503, json: { error: 'unavailable' } });
    expect(logs.filter((l) => l.includes('source_header_missing'))).toHaveLength(1);
    // /signup keeps its documented fallback (bucketed with the peer; unsigned -> 401).
    const s = await raw(
      r.port,
      'POST',
      '/signup',
      { 'content-type': 'application/json' },
      JSON.stringify(FIELDS),
    );
    expect(s.status).toBe(401);
  });
});
