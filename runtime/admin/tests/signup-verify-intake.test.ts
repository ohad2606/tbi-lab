/**
 * G1-AUTO-VERIFY slice 2: intake `POST /signup/verify` and `/signup/resend`, `.vq` / `.rq`
 * markers, duplicate web sign-up -> `.rq` (design/G1-AUTO-VERIFY.md sections 3, 4, 7). Real temp
 * store, real loopback http, injected clock; no network, no real secret. Test IPs are from the
 * documentation ranges only.
 */
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NonceCache } from '../signup/hmac.js';
import { intakeConfigFromEnv, startIntake, type RunningIntake } from '../signup/intake-server.js';
import { SlidingWindowLimiter } from '../signup/limits.js';
import type { FetchLike } from '../signup/notify.js';
import { SignupIntake } from '../signup/service.js';
import type { PendingStore } from '../signup/store.js';
import { deriveWebKey, issueToken } from '../signup/web.js';

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
const UNKNOWN_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const N22 = 'A'.repeat(22);
const M43 = 'B'.repeat(43);
const WEB_ON = { TBI_SIGNUP_WEB: '1', TBI_SIGNUP_WEB_ORIGINS: SITE };
const ALL_ON = { ...WEB_ON, TBI_SIGNUP_VERIFY: '1' };

const roots: string[] = [];
const running: RunningIntake[] = [];
const allLogs: string[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.intake.settled();
    await r.close();
  }
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  // Class codes and counts only on every line: no id, token, hash, address, IP, path.
  for (const l of allLogs.splice(0))
    expect(l).not.toMatch(
      /@|example|Dana|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{12}|v1\.|198\.51|2001:db8|\/tmp/i,
    );
});

function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'tbi-verify-intake-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function envFor(root: string, extra: Record<string, string>) {
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

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}
function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  data?: string,
) {
  return new Promise<Res>((resolve, reject) => {
    const h =
      data === undefined
        ? headers
        : { 'content-length': String(Buffer.byteLength(data)), ...headers };
    const req = request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
/** What a client can observe: status, body bytes, content-length. */
const seen = (r: Res) => ({ s: r.status, b: r.text, l: r.headers['content-length'] });

async function up(extra: Record<string, string>) {
  const root = tmp();
  const cfg = intakeConfigFromEnv(envFor(root, extra));
  if (!cfg.enabled) throw new Error(`config: ${cfg.reason}`);
  let t = Date.now();
  const logs: string[] = [];
  const fetch: FetchLike = async () => ({ ok: true, status: 200 });
  const r = await startIntake(cfg.config, {
    fetch,
    log: (l) => (logs.push(l), allLogs.push(l)),
    now: () => t,
  });
  running.push(r);
  const ip = (n: number) => ({ 'x-forwarded-for': `198.51.100.${n}` });
  const dir = join(root, 'p');
  const h = (src: number, more: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    origin: SITE,
    ...ip(src),
    ...more,
  });
  const api = {
    r,
    dir,
    logs,
    advance: (ms: number) => (t += ms),
    now: () => t,
    post: (path: string, b: unknown, src = 1, more: Record<string, string> = {}) =>
      raw(r.port, 'POST', path, h(src, more), typeof b === 'string' ? b : JSON.stringify(b)),
    async formToken(src = 1): Promise<string> {
      const res = await raw(r.port, 'GET', '/signup/form-token', { origin: SITE, ...ip(src) });
      const tok = (JSON.parse(res.text) as { token: string }).token;
      t += 4000;
      return tok;
    },
    async signup(src = 1, fields: Record<string, unknown> = FIELDS) {
      const token = await api.formToken(src);
      return api.post('/signup/web', { ...fields, heardFrom: 'friend', token, website: '' }, src);
    },
    files: () => readdirSync(dir),
    ids: () =>
      readdirSync(dir)
        .filter((f) => /^[0-9A-Z]{26}\.json$/.test(f))
        .map((f) => f.slice(0, 26)),
    vtok: (id: string, expMs = t + 3_600_000) =>
      `v1.${id}.1.${Math.floor(expMs / 1000)}.${N22}.${M43}`,
  };
  return api;
}

describe('flag off (TBI_SIGNUP_VERIFY unset / 0) and TBI_SIGNUP_WEB=0', () => {
  for (const env of [
    WEB_ON,
    { ...WEB_ON, TBI_SIGNUP_VERIFY: '0' },
    { TBI_SIGNUP_VERIFY: '1', TBI_SIGNUP_WEB: '0' },
  ])
    it(`new paths answer exactly like an unknown path (${JSON.stringify(env)})`, async () => {
      const a = await up(env);
      const unknown = seen(await a.post('/signup/nothing', { token: 'x' }));
      expect(unknown.s).toBe(404);
      for (const p of ['/signup/verify', '/signup/resend'])
        expect(seen(await a.post(p, { token: a.vtok(UNKNOWN_ID) }))).toEqual(unknown);
      expect(seen(await raw(a.r.port, 'GET', '/signup/verify', {}))).toEqual(unknown);
    });

  it('a duplicate web sign-up writes no .rq and logs the same line as before', async () => {
    const a = await up(WEB_ON);
    expect((await a.signup(1)).status).toBe(200);
    expect((await a.signup(2)).status).toBe(200);
    await a.r.intake.settled();
    expect(a.files().filter((f) => f.endsWith('.rq') || f.includes('.vq-'))).toEqual([]);
    expect(a.ids()).toHaveLength(1);
    expect(a.logs.filter((l) => l.includes('duplicate'))).toEqual(['signup: duplicate ignored']);
  });

  it('a bad flag value refuses to start', () => {
    const c = intakeConfigFromEnv(envFor(tmp(), { ...WEB_ON, TBI_SIGNUP_VERIFY: 'yes' }));
    expect(c.enabled).toBe(false);
  });
});

describe('POST /signup/verify', () => {
  it('202 `received` identical for unknown, real, double click, 4th marker; markers empty 0600, max 3', async () => {
    const a = await up(ALL_ON);
    await a.signup(1);
    const [id] = a.ids();
    const answers = [
      await a.post('/signup/verify', { token: a.vtok(UNKNOWN_ID) }, 2),
      await a.post('/signup/verify', { token: a.vtok(id!) }, 2),
      await a.post('/signup/verify', { token: a.vtok(id!) }, 2),
      await a.post('/signup/verify', { token: a.vtok(id!, a.now() + 7_200_000) }, 2),
      await a.post('/signup/verify', { token: a.vtok(id!, a.now() + 10_800_000) }, 2),
      await a.post('/signup/verify', { token: a.vtok(id!, a.now() + 14_400_000) }, 2),
    ].map(seen);
    for (const x of answers) expect(x).toEqual(answers[0]);
    expect(answers[0]!.s).toBe(202);
    expect(JSON.parse(answers[0]!.b)).toEqual({ ok: true, status: 'received' });
    await a.r.intake.settled();
    const vq = a.files().filter((f) => f.includes('.vq-'));
    expect(vq).toHaveLength(3);
    for (const f of vq) {
      expect(f.startsWith(`${id}.vq-`)).toBe(true);
      const st = statSync(join(a.dir, f));
      expect(st.size).toBe(0);
      expect(st.mode & 0o777).toBe(0o600);
    }
    expect(a.logs.filter((l) => l === 'signup: verify marker limit')).toHaveLength(1);
  });

  it('refusals: malformed 400, bad format 400, expired 410, > 25 h ahead 400, hostile ids 400', async () => {
    const a = await up(ALL_ON);
    const code = async (b: unknown) => {
      const r = await a.post('/signup/verify', b, 3);
      return `${r.status} ${r.text}`;
    };
    expect(await code('{not json')).toBe('400 {"error":"invalid"}');
    expect(await code({})).toBe('400 {"error":"invalid"}');
    expect(await code({ token: 5 })).toBe('400 {"error":"invalid"}');
    expect(await code({ token: a.vtok(UNKNOWN_ID, a.now() - 1000) })).toBe(
      '410 {"error":"expired"}',
    );
    expect(await code({ token: a.vtok(UNKNOWN_ID, a.now() + 26 * 3_600_000) })).toBe(
      '400 {"error":"invalid"}',
    );
    for (const id of [
      '../../../../etc/passw',
      `${UNKNOWN_ID.slice(0, 25)}\u0000`,
      `${UNKNOWN_ID}A`,
    ])
      expect(await code({ token: a.vtok(id) })).toBe('400 {"error":"invalid"}');
    await a.r.intake.settled();
    expect(a.files().filter((f) => f.includes('.vq-'))).toEqual([]);
  });

  it('HTTP: GET 405, text/plain 415, > 1 KB 413, foreign origin 403, no credentials header', async () => {
    const a = await up(ALL_ON);
    const g = await raw(a.r.port, 'GET', '/signup/verify', {
      origin: SITE,
      'x-forwarded-for': '198.51.100.9',
    });
    expect(g.status).toBe(405);
    expect(
      (await a.post('/signup/verify', { token: 'x' }, 4, { 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect((await a.post('/signup/verify', { token: 'x'.repeat(1100) }, 4)).status).toBe(413);
    const f = await a.post('/signup/verify', { token: 'x' }, 4, {
      origin: 'https://evil.example.net',
    });
    expect(f.status).toBe(403);
    const ok = await a.post('/signup/verify', { token: a.vtok(UNKNOWN_ID) }, 4);
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const pre = await raw(a.r.port, 'OPTIONS', '/signup/resend', {
      origin: SITE,
      'access-control-request-method': 'POST',
    });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('per-/64 limit 10 per 10 min, own bucket (does not spend /signup/web); 429 reveals nothing', async () => {
    const a = await up(ALL_ON);
    for (let i = 0; i < 10; i++)
      expect((await a.post('/signup/verify', { token: a.vtok(UNKNOWN_ID) }, 5)).status).toBe(202);
    const r = await a.post('/signup/verify', { token: a.vtok(UNKNOWN_ID) }, 5);
    expect(r.status).toBe(429);
    expect(r.text).toBe('{"error":"rate_limited"}');
    expect((await a.signup(5)).status).toBe(200);
  });
});

describe('POST /signup/resend and duplicate sign-up', () => {
  it('200 identical for a waiting, an unknown and an invalid address; .rq only for the waiting one', async () => {
    const a = await up(ALL_ON);
    await a.signup(1);
    const [id] = a.ids();
    const res = async (email: unknown, src: number) =>
      seen(
        await a.post('/signup/resend', { email, token: await a.formToken(src), website: '' }, src),
      );
    const xs = [
      await res('dana@example.com', 6),
      await res('nobody@example.org', 7),
      await res('not an address', 8),
      await res(42, 9),
    ];
    for (const x of xs) expect(x).toEqual(xs[0]);
    expect(xs[0]!.s).toBe(200);
    await a.r.intake.settled();
    expect(a.files().filter((f) => f.endsWith('.rq'))).toEqual([`${id}.rq`]);
    expect(statSync(join(a.dir, `${id}.rq`)).size).toBe(0);
    // Second request: EEXIST is success, same answer.
    expect(await res('dana@example.com', 10)).toEqual(xs[0]);
  });

  it('form token, honeypot and min fill refuse exactly like /signup/web', async () => {
    const a = await up(ALL_ON);
    const both = async (b: (tok: string) => Record<string, unknown>, fill = true) => {
      const out: string[] = [];
      for (const [p, src] of [
        ['/signup/web', 11],
        ['/signup/resend', 12],
      ] as const) {
        const tok = await a.formToken(src);
        if (!fill) a.advance(-4000);
        const r = await a.post(p, b(tok), src);
        if (!fill) a.advance(4000);
        out.push(`${r.status} ${r.text} ${r.headers['content-length']}`);
      }
      return out;
    };
    const [w1, r1] = await both(() => ({
      ...FIELDS,
      email: 'x@example.com',
      heardFrom: 'f',
      token: 'bad',
      website: '',
    }));
    expect(r1).toBe(w1);
    const [w2, r2] = await both((tok) => ({
      ...FIELDS,
      email: 'y@example.com',
      heardFrom: 'f',
      token: tok,
      website: 'bot',
    }));
    expect(r2).toBe(w2);
    const [w3, r3] = await both(
      (tok) => ({ ...FIELDS, email: 'z@example.com', heardFrom: 'f', token: tok, website: '' }),
      false,
    );
    expect(r3).toBe(w3);
    expect(w3!.startsWith('400 {"error":"too_fast"}')).toBe(true);
  });

  it('a duplicate web sign-up of a waiting request writes one .rq; same answer and log as today', async () => {
    const a = await up(ALL_ON);
    const first = seen(await a.signup(1));
    const second = seen(await a.signup(2));
    expect(second).toEqual(first);
    await a.r.intake.settled();
    const [id] = a.ids();
    expect(a.files().filter((f) => f.endsWith('.rq'))).toEqual([`${id}.rq`]);
    expect(a.logs.filter((l) => l.includes('duplicate'))).toEqual(['signup: duplicate ignored']);
  });

  it('no .rq for a verified or non-web record', async () => {
    const a = await up(ALL_ON);
    await a.signup(1);
    const [id] = a.ids();
    const f = join(a.dir, `${id}.json`);
    writeFileSync(
      f,
      JSON.stringify({
        ...JSON.parse(readFileSync(f, 'utf8')),
        verifiedAt: new Date().toISOString(),
      }),
    );
    await a.signup(2);
    await a.r.intake.settled();
    expect(a.files().filter((x) => x.endsWith('.rq'))).toEqual([]);
  });
});

describe('response before any id/address-dependent work; failures', () => {
  function unit(store: Partial<PendingStore>, logs: string[]) {
    const now = () => 1_700_000_000_000;
    const lim = (n: number) => new SlidingWindowLimiter({ count: n, windowMs: 600_000 }, now);
    return new SignupIntake({
      secret: Buffer.from(SECRET),
      store: store as PendingStore,
      notifier: null,
      now,
      sourceRate: lim(10),
      globalRate: lim(10),
      nonces: new NonceCache(),
      log: (l) => (logs.push(l), allLogs.push(l)),
      web: {
        webKey: deriveWebKey(Buffer.from(SECRET)),
        tokenRate: lim(10),
        sourceRate: lim(10),
        globalRate: lim(10),
        nonces: new NonceCache({ windowMs: 600_000 }),
      },
      verify: {
        verifyRate: lim(10),
        verifyGlobal: lim(300),
        resendRate: lim(5),
        resendGlobal: lim(100),
      },
    });
  }
  const tok = `v1.${UNKNOWN_ID}.1.${Math.floor(1_700_000_000_000 / 1000) + 3600}.${N22}.${M43}`;

  it('a slow store: the answer is ready before the store is even called', async () => {
    const calls: string[] = [];
    const store = {
      writeVerifyMarker: () => (calls.push('verify'), new Promise<never>(() => undefined)),
      writeResendMarkerFor: () => (calls.push('resend'), new Promise<never>(() => undefined)),
    };
    const i = unit(store as unknown as Partial<PendingStore>, []);
    const out = await i.submitVerify(
      '198.51.100.1/64',
      Buffer.from(JSON.stringify({ token: tok })),
    );
    expect(out.status).toBe(202);
    expect(calls).toEqual([]);
    const ft = issueToken(deriveWebKey(Buffer.from(SECRET)), 1_700_000_000_000 - 5000);
    const r = await i.submitResend(
      '198.51.100.1/64',
      Buffer.from(JSON.stringify({ email: 'a@example.com', token: ft, website: '' })),
    );
    expect(r.status).toBe(200);
    expect(calls).toEqual([]);
    await new Promise((res) => setImmediate(res));
    expect(calls).toEqual(['verify', 'resend']);
  });

  it('a marker write failure still answers 202 and logs one class line; no unhandled rejection', async () => {
    const logs: string[] = [];
    const store = {
      writeVerifyMarker: () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })),
    };
    const i = unit(store as unknown as Partial<PendingStore>, logs);
    expect(
      (await i.submitVerify('198.51.100.1/64', Buffer.from(JSON.stringify({ token: tok })))).status,
    ).toBe(202);
    await i.settled();
    expect(logs.filter((l) => l.startsWith('signup: verify marker failed'))).toHaveLength(1);
  });

  it('limiter key table is bounded at 10 000 keys', () => {
    const l = new SlidingWindowLimiter({ count: 10, windowMs: 600_000 }, () => 0);
    for (let k = 0; k < 10_000; k++) expect(l.take(`k${k}`).ok).toBe(true);
    expect(l.take('one-more').ok).toBe(false);
  });
});
