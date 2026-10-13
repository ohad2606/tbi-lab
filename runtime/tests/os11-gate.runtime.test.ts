/**
 * OS-11 (P1): "Login Failed: Unable to find a valid CSRF token" after about an hour. Reproduced
 * against the REAL oauth2-proxy binary the gate runs (v7.15.4), on loopback, with a mock OpenID
 * provider: no real credentials, nothing deployed is touched. Opt-in: needs the binary
 * (TBI_OAUTH2_PROXY, default /usr/local/bin/oauth2-proxy).
 *
 * Root cause (gate log 2026-10-13 06:05): once the sign-in session has expired, every request
 * without `Accept: application/json` makes oauth2-proxy START A NEW LOGIN and overwrite its single
 * CSRF cookie. The app's background request (/version.json on window focus) did so in the same
 * second as the owner's refresh, so the owner's login came back from the provider with a state the
 * cookie no longer held: "CSRF token mismatch", 403, and a refresh only replays the dead callback.
 *
 * Cases (each against the real proxy):
 *  1. the root cause, reproduced: a background request during a login in flight -> 403;
 *  2. the app fix: the same request with Accept application/json -> 401, no cookie written, and
 *     the login completes on the application URL (never left on the callback);
 *  3. a stale callback (the completed one, replayed by refresh or history) is refused, and the
 *     authorization code is never redeemed twice;
 *  4. an expired or missing CSRF cookie -> 403 (rejected safely);
 *  5. after the session expires: a background request gets 401 (no login), a top-level request
 *     starts exactly one login;
 *  6. two tabs signing in at once: fails with the CURRENT gate configuration; passes with the
 *     proposed `cookie_csrf_per_request` (gate change G1, needs separate approval);
 *  7. what the 403 page offers the user (recovery), recorded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEvidence } from '../harness/env.js';

const BIN = process.env.TBI_OAUTH2_PROXY ?? '/usr/local/bin/oauth2-proxy';
const HAVE = existsSync(BIN);
const CLIENT = 'os11-client';

// ---- A minimal OpenID provider: discovery, JWKS, authorize (auto-approves), token (single use).
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
let idp: Server;
let IDP = '';
const redeemed = new Map<string, number>();
const tokenLifetimeS = 3600;
function idToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(
    JSON.stringify({
      iss: IDP,
      aud: CLIENT,
      sub: 'tester-1',
      email: 'tester@example.test',
      email_verified: true,
      iat: now,
      exp: now + tokenLifetimeS,
    }),
  );
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey);
  return `${h}.${p}.${b64u(s)}`;
}
async function startIdp() {
  idp = createServer((req, res) => {
    const u = new URL(req.url!, IDP);
    const json = (o: unknown, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (u.pathname === '/.well-known/openid-configuration')
      return json({
        issuer: IDP,
        authorization_endpoint: `${IDP}/authorize`,
        token_endpoint: `${IDP}/token`,
        jwks_uri: `${IDP}/jwks`,
        userinfo_endpoint: `${IDP}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    if (u.pathname === '/jwks')
      return json({
        keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }],
      });
    if (u.pathname === '/authorize') {
      const code = `c${randomBytes(8).toString('hex')}`;
      redeemed.set(code, 0);
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', u.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (u.pathname === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') ?? '';
        const n = redeemed.get(code);
        if (n === undefined || n > 0) return json({ error: 'invalid_grant' }, 400);
        redeemed.set(code, n + 1);
        json({
          access_token: `a${randomBytes(8).toString('hex')}`,
          id_token: idToken(),
          token_type: 'Bearer',
          expires_in: tokenLifetimeS,
        });
      });
      return;
    }
    if (u.pathname === '/userinfo')
      return json({ email: 'tester@example.test', email_verified: true });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()));
  IDP = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
}

// ---- The real oauth2-proxy, configured like the gate (skip_provider_button, lax cookies).
const procs: ChildProcess[] = [];
async function startProxy(extra: string[] = []): Promise<string> {
  const port = 6100 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const p = spawn(
    BIN,
    [
      `--http-address=127.0.0.1:${port}`,
      '--provider=oidc',
      `--oidc-issuer-url=${IDP}`,
      `--client-id=${CLIENT}`,
      '--client-secret=os11-not-a-secret',
      `--cookie-secret=${randomBytes(32).toString('base64url').slice(0, 32)}`,
      '--cookie-name=os11',
      '--cookie-secure=false',
      '--cookie-samesite=lax',
      '--cookie-expire=8h',
      '--email-domain=*',
      '--skip-provider-button=true',
      `--redirect-url=${base}/oauth2/callback`,
      '--upstream=static://200',
      ...extra,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  procs.push(p);
  let log = '';
  p.stdout!.on('data', (d) => (log += d));
  p.stderr!.on('data', (d) => (log += d));
  (p as unknown as { log: () => string }).log = () => log;
  for (let k = 0; k < 100; k++) {
    try {
      if ((await fetch(`${base}/ping`)).ok) return base;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`oauth2-proxy did not start: ${log}`);
}
const proxyLog = () => (procs.at(-1) as unknown as { log: () => string }).log();

/** One browser profile: a cookie jar shared by its tabs. Values never leave the test. */
class Browser {
  jar = new Map<string, string>();
  cookieHeader = () => [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [nv, ...attrs] = c.split(';');
      const i = nv!.indexOf('=');
      const name = nv!.slice(0, i).trim();
      const value = nv!.slice(i + 1);
      const gone = attrs.some(
        (a) =>
          /^\s*max-age=(-|0\b)/i.test(a) ||
          (/^\s*expires=/i.test(a) && Date.parse(a.split('=')[1]!) < Date.now()),
      );
      if (gone || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  csrfCookies = () => [...this.jar.keys()].filter((k) => k.includes('csrf'));
  async get(url: string, accept = 'text/html,application/xhtml+xml') {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { accept, cookie: this.cookieHeader() },
    });
    this.absorb(res);
    return res;
  }
  /** A top-level navigation to the provider's authorize URL: it answers with the callback URL. */
  async approveAt(authorizeUrl: string): Promise<string> {
    const r = await fetch(authorizeUrl, { redirect: 'manual' });
    return r.headers.get('location')!;
  }
}

/** Start a login by a top-level navigation; returns the provider URL (the state is inside). */
async function startLogin(b: Browser, base: string, path = '/') {
  const r = await b.get(`${base}${path}`);
  expect(r.status).toBe(302);
  return r.headers.get('location')!;
}

const evidence: Record<string, unknown> = {};

describe.skipIf(!HAVE)('OS-11: the gate CSRF failure, reproduced on the real oauth2-proxy', () => {
  let base = '';
  beforeAll(async () => {
    await startIdp();
    base = await startProxy();
    evidence.version = await new Promise<string>((r) => {
      const v = spawn(BIN, ['--version']);
      let o = '';
      v.stdout.on('data', (d) => (o += d));
      v.on('close', () => r(o.trim()));
    });
  });
  afterAll(() => {
    for (const p of procs) p.kill();
    idp?.close();
    recordEvidence('os11-gate', evidence);
  });

  it('1. root cause: a background request during a login in flight overwrites the CSRF cookie -> 403', async () => {
    const b = new Browser();
    const authorize = await startLogin(b, base); // the owner's refresh
    const first = b.jar.get('os11_csrf');
    const bg = await b.get(`${base}/version.json`, '*/*'); // the version check on focus
    expect(bg.status).toBe(302); // it started another login...
    expect(b.jar.get('os11_csrf')).not.toBe(first); // ...and replaced the cookie
    const cb = await b.get(await b.approveAt(authorize));
    expect(cb.status).toBe(403);
    expect(proxyLog()).toMatch(/CSRF token mismatch/);
    evidence.rootCause = { backgroundStatus: bg.status, callbackStatus: cb.status };
  });

  it('2. fix: with Accept application/json the background request gets 401 and the login completes on the app URL', async () => {
    const b = new Browser();
    const authorize = await startLogin(b, base, '/editor?x=1');
    const before = b.cookieHeader();
    const bg = await b.get(`${base}/version.json`, '*/*, application/json');
    expect(bg.status).toBe(401);
    expect(bg.headers.getSetCookie()).toEqual([]); // nothing written
    expect(b.cookieHeader()).toBe(before);
    const cb = await b.get(await b.approveAt(authorize));
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/editor?x=1'); // back where the user was
    const app = await b.get(`${base}/editor?x=1`);
    expect(app.status).toBe(200);
    expect(b.csrfCookies()).toEqual([]); // the CSRF cookie is cleared after use
    evidence.fix = {
      backgroundStatus: bg.status,
      callbackStatus: cb.status,
      landing: cb.headers.get('location'),
      app: app.status,
    };
  });

  it('3. a stale (completed) callback is refused and its code is never redeemed twice', async () => {
    const b = new Browser();
    const callback = await b.approveAt(await startLogin(b, base));
    expect((await b.get(callback)).status).toBe(302);
    const code = new URL(callback).searchParams.get('code')!;
    expect(redeemed.get(code)).toBe(1);
    const replay = await b.get(callback); // refresh / back button on the callback
    expect(replay.status).toBe(403);
    expect(redeemed.get(code)).toBe(1); // refused before any token request
    // A second profile replaying the same URL is refused too.
    const other = new Browser();
    expect((await other.get(callback)).status).toBe(403);
    expect(redeemed.get(code)).toBe(1);
    evidence.staleCallback = { replay: replay.status, redemptions: redeemed.get(code) };
  });

  it('4. an expired or missing CSRF cookie is rejected safely (403)', async () => {
    const b = new Browser();
    const authorize = await startLogin(b, base);
    b.jar.delete('os11_csrf'); // expired (15 min) or cleared
    const cb = await b.get(await b.approveAt(authorize));
    expect(cb.status).toBe(403);
    evidence.missingCsrf = cb.status;
  });

  it('5. after the session expires: background -> 401 (no login), top-level -> exactly one login', async () => {
    // The gate session lives as long as its cookie (cookie_expire 8h on the gate, from login; not
    // the provider token's 1 h: without a refresh token the proxy keeps the session to the
    // cookie's end). Here the cookie lives 3 s.
    const short = await startProxy(['--cookie-expire=3s']);
    const b = new Browser();
    expect((await b.get(await b.approveAt(await startLogin(b, short)))).status).toBe(302);
    expect((await b.get(`${short}/`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 4000));
    const bg = await b.get(`${short}/runtime/health`, 'application/json');
    expect(bg.status).toBe(401);
    expect(b.csrfCookies()).toEqual([]);
    const top = await b.get(`${short}/`);
    expect(top.status).toBe(302);
    expect(b.csrfCookies()).toHaveLength(1);
    expect((await b.get(await b.approveAt(top.headers.get('location')!))).status).toBe(302);
    expect((await b.get(`${short}/`)).status).toBe(200);
    evidence.expiry = { background: bg.status, topLevel: top.status };
  });

  it('6. two tabs signing in at once: fails with the current configuration', async () => {
    const b = new Browser();
    const tab1 = await startLogin(b, base, '/a');
    const tab2 = await startLogin(b, base, '/b');
    const r1 = await b.get(await b.approveAt(tab1));
    const r2 = await b.get(await b.approveAt(tab2));
    evidence.twoTabsCurrent = { tab1: r1.status, tab2: r2.status };
    // Both are lost: tab 1's state no longer matches the shared cookie, and its failed callback
    // clears the cookie, so tab 2 then finds none.
    expect([r1.status, r2.status]).toEqual([403, 403]);
  });

  it('6b. two tabs signing in at once: both succeed with cookie_csrf_per_request (proposed G1)', async () => {
    const g1 = await startProxy(['--cookie-csrf-per-request=true', '--cookie-csrf-expire=15m']);
    const b = new Browser();
    const tab1 = await startLogin(b, g1, '/a');
    const tab2 = await startLogin(b, g1, '/b');
    const r1 = await b.get(await b.approveAt(tab1));
    const r2 = await b.get(await b.approveAt(tab2));
    evidence.twoTabsG1 = {
      tab1: r1.status,
      tab2: r2.status,
      landing: [r1.headers.get('location'), r2.headers.get('location')],
    };
    expect([r1.status, r2.status]).toEqual([302, 302]);
    // The root cause is also defused at the gate: a background login no longer clobbers.
    const fresh = new Browser();
    const t = await startLogin(fresh, g1, '/c');
    await fresh.get(`${g1}/version.json`, '*/*');
    const done = await fresh.get(await fresh.approveAt(t));
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/c');
  });

  it('7. the 403 page: what recovery it offers', async () => {
    const b = new Browser();
    const authorize = await startLogin(b, base);
    b.jar.delete('os11_csrf');
    const cb = await b.get(await b.approveAt(authorize));
    const html = await cb.text();
    const links = [...html.matchAll(/(?:href|action)="([^"]*)"/g)]
      .map((m) => m[1]!)
      .filter((h) => !h.includes('/static/'));
    evidence.errorPage = {
      status: cb.status,
      links: links.map((l) =>
        l.replace(/code=[^&"]*/g, 'code=<r>').replace(/state=[^&"]*/g, 'state=<r>'),
      ),
      mentionsSignIn: /sign in/i.test(html),
    };
    expect(cb.status).toBe(403);
    // Recovery: the page's sign-in link starts ONE fresh login that ends on the application.
    const start = await b.get(`${base}/oauth2/sign_in`);
    expect(start.status).toBe(302);
    const done = await b.get(await b.approveAt(start.headers.get('location')!));
    expect(done.status).toBe(302);
    expect((await b.get(`${base}${done.headers.get('location')}`)).status).toBe(200);
    (evidence.errorPage as Record<string, unknown>).recoveryViaSignIn =
      done.headers.get('location');
  });
});
