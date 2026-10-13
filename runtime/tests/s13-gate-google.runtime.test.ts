/**
 * Sprint 13 security gate (G1 / G2): the REAL oauth2-proxy binary the gate runs (v7.15.4) with the
 * gate's OWN configuration file (deploy/dev-lab/oauth2-proxy.cfg, byte-identical to the live
 * /etc/oauth2-proxy/oauth2-proxy.cfg) and the GOOGLE provider, pointed by flags at a local mock of
 * Google's authorize, token and tokeninfo endpoints. Only fake values are used; nothing deployed
 * is touched. Opt-in: needs the binary (TBI_OAUTH2_PROXY, default /usr/local/bin/oauth2-proxy).
 *
 * The earlier OS-11 tests used the generic OIDC provider. The Google provider adds its own log
 * line (token validation, providers/internal_util.go:74), so the log scan here covers what the
 * live gate actually writes.
 *
 * Variants: `current` (the live file, also what a rollback restores), `G1` (+ the two approved
 * cookie_csrf_* lines), `G1+G2a` (+ exclude_logging_path). G2b (journald LogFilterPatterns) is
 * applied to the captured output with the same patterns as the proposed drop-in.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEvidence } from '../harness/env.js';

const BIN = process.env.TBI_OAUTH2_PROXY ?? '/usr/local/bin/oauth2-proxy';
const HAVE = existsSync(BIN);
const LIVE_CFG = join(__dirname, '../../deploy/dev-lab/oauth2-proxy.cfg');
const SESSION = '__Host-tbi_dev_lab';
const ALLOWED = 'owner@example.test';
const G1_LINES = ['cookie_csrf_per_request = true', 'cookie_csrf_expire = "15m"'];
// NOTE: the config-file key is PLURAL; the singular form (the flag's name) is rejected by v7.15.4
// as an invalid key and the proxy does not start.
const G2A_LINES = ['exclude_logging_paths = ["/oauth2/callback"]'];
// The configuration as it was before G1 (= what a rollback restores): the repository file with the
// G1 block removed. The test fails if the block is not exactly the approved two keys.
const INSTALLED = existsSync(LIVE_CFG) ? readFileSync(LIVE_CFG, 'utf8') : '';
const G1_BLOCK = /# Sprint 13 G1 [^\n]*\n(# [^\n]*\n)*cookie_csrf_per_request = true\ncookie_csrf_expire = "15m"\n/;
const PRE_G1 = INSTALLED.replace(G1_BLOCK, '');
const AS_INSTALLED: readonly string[] = [];
// The proposed drop-in's LogFilterPatterns=~ (journald drops matching lines at ingestion).
const JOURNAL_DROP = [/&\{(GET|POST|HEAD)/, /\/oauth2\/callback\?/];

// ---- Mock Google: authorize (auto-approves as `nextEmail`), token (single use), tokeninfo.
let idp: Server;
let IDP = '';
let nextEmail = ALLOWED;
const redeemed = new Map<string, number>();
const emailOfCode = new Map<string, string>();
/** Every secret value the mock or the proxy hands out, so the log scan can look for each one. */
const secrets = { code: new Set<string>(), state: new Set<string>(), access: new Set<string>(), id: new Set<string>() };
const b64u = (s: string) => Buffer.from(s).toString('base64url');
async function startIdp() {
  idp = createServer((req, res) => {
    const u = new URL(req.url!, IDP);
    const json = (o: unknown, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (u.pathname === '/authorize') {
      const code = `4/FAKE-${randomBytes(12).toString('hex')}`;
      redeemed.set(code, 0);
      secrets.code.add(code);
      secrets.state.add(u.searchParams.get('state')!);
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('state', u.searchParams.get('state')!);
      back.searchParams.set('code', code);
      back.searchParams.set('scope', 'email profile openid');
      emailOfCode.set(code, nextEmail);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (u.pathname === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') ?? '';
        const n = redeemed.get(code);
        if (n === undefined || n > 0) return json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400);
        redeemed.set(code, n + 1);
        const access = `ya29.FAKE-${randomBytes(16).toString('hex')}`;
        const now = Math.floor(Date.now() / 1000);
        const id = `${b64u('{"alg":"RS256","typ":"JWT"}')}.${b64u(
          JSON.stringify({ iss: 'https://accounts.google.com', sub: '1000000001', email: emailOfCode.get(code), email_verified: true, iat: now, exp: now + 3600 }),
        )}.${b64u('fake-signature')}`;
        secrets.access.add(access);
        secrets.id.add(id);
        json({ access_token: access, id_token: id, token_type: 'Bearer', expires_in: 3599 });
      });
      return;
    }
    if (u.pathname === '/tokeninfo')
      return json({ issued_to: 'fake-client.apps.example', email: 'redacted@example.test', expires_in: 3598, access_type: 'online' });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()));
  IDP = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
}

// ---- The real proxy with the gate's configuration file; flags override only what a loopback
// test must change (addresses, provider endpoints, secrets, the allowlist file, Secure).
const procs: ChildProcess[] = [];
async function startProxy(extraLines: readonly string[], flags: readonly string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 's13-gate-'));
  const cfg = join(dir, 'oauth2-proxy.cfg');
  writeFileSync(cfg, (extraLines === AS_INSTALLED ? readFileSync(LIVE_CFG, 'utf8') : PRE_G1) + '\n' + extraLines.join('\n') + '\n');
  writeFileSync(join(dir, 'allowed-emails'), ALLOWED + '\n');
  const port = await new Promise<number>((resolve) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as { port: number };
      probe.close(() => resolve(free));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const p = spawn(
    BIN,
    [
      `--config=${cfg}`,
      `--http-address=127.0.0.1:${port}`,
      `--redirect-url=${base}/oauth2/callback`,
      `--login-url=${IDP}/authorize`,
      `--redeem-url=${IDP}/token`,
      `--validate-url=${IDP}/tokeninfo`,
      '--client-id=fake-client.apps.example',
      '--client-secret=FAKE-client-secret-not-real',
      `--cookie-secret=${randomBytes(32).toString('base64url').slice(0, 32)}`,
      `--authenticated-emails-file=${join(dir, 'allowed-emails')}`,
      '--cookie-secure=false', // plain-http loopback; the live gate keeps Secure
      '--upstream=static://200',
      ...flags,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  procs.push(p);
  let log = '';
  p.stdout!.on('data', (d) => (log += d));
  p.stderr!.on('data', (d) => (log += d));
  for (let k = 0; k < 100; k++) {
    try {
      if (p.exitCode !== null) throw new Error(`oauth2-proxy exited: ${log}`);
      if ((await fetch(`${base}/ping`)).ok && log.includes(`127.0.0.1:${port}`))
        return { base, log: () => log };
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`oauth2-proxy did not start: ${log}`);
}
type Proxy = Awaited<ReturnType<typeof startProxy>>;

/** One browser profile (a cookie jar shared by its tabs). Values never leave the test. */
class Browser {
  jar = new Map<string, string>();
  cookieHeader = () => [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  setCookies: string[] = [];
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      this.setCookies.push(c);
      const [nv, ...attrs] = c.split(';');
      const i = nv!.indexOf('=');
      const name = nv!.slice(0, i).trim();
      const value = nv!.slice(i + 1);
      const gone = attrs.some(
        (a) => /^\s*max-age=(-|0\b)/i.test(a) || (/^\s*expires=/i.test(a) && Date.parse(a.split('=')[1]!) < Date.now()),
      );
      if (gone || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  csrfCookies = () => [...this.jar.keys()].filter((k) => k.endsWith('_csrf'));
  async get(url: string, accept = 'text/html,application/xhtml+xml') {
    const res = await fetch(url, { redirect: 'manual', headers: { accept, cookie: this.cookieHeader() } });
    this.absorb(res);
    return res;
  }
  async approveAt(authorizeUrl: string) {
    return (await fetch(authorizeUrl, { redirect: 'manual' })).headers.get('location')!;
  }
}
async function startLogin(b: Browser, base: string, path = '/') {
  const r = await b.get(`${base}${path}`);
  expect(r.status).toBe(302);
  expect(r.headers.get('location')!.startsWith(`${IDP}/authorize?`)).toBe(true);
  return r.headers.get('location')!;
}
const settle = async (px: Proxy) => {
  let last = -1;
  for (let k = 0; k < 40 && px.log().length !== last; k++) {
    last = px.log().length;
    await new Promise((r) => setTimeout(r, 150));
  }
};

/** Count every fake secret in `text` (the values are never printed). */
function leakCounts(text: string, cookieValues: Iterable<string>) {
  const count = (vals: Iterable<string>) => {
    let n = 0;
    for (const v of vals) if (v && text.includes(v)) n++;
    return n;
  };
  return {
    codes: count(secrets.code),
    states: count([...secrets.state].map((s) => s.slice(0, 24))),
    accessTokens: count(secrets.access),
    idTokens: count(secrets.id),
    cookieValues: count(cookieValues),
    clientSecret: text.includes('FAKE-client-secret-not-real') ? 1 : 0,
    cookieHeaderDumps: (text.match(/Cookie:\[/g) ?? []).length,
    callbackQueries: (text.match(/\/oauth2\/callback\?/g) ?? []).length,
  };
}

const evidence: Record<string, unknown> = {};
beforeAll(async () => {
  if (HAVE) await startIdp();
});
afterAll(() => {
  for (const p of procs) p.kill();
  idp?.close();
  if (HAVE) recordEvidence('s13-gate-google', evidence);
});

const VARIANTS = [
  ['current', [] as string[]],
  ['installed file (G1)', AS_INSTALLED],
  ['G1', G1_LINES],
  ['G1+G2a', [...G1_LINES, ...G2A_LINES]],
] as const;

describe.skipIf(!HAVE)('Gate G1/G2 on the live configuration file, Google provider', () => {
  for (const [name, lines] of VARIANTS) {
    it(`${name}: the configuration loads on v7.15.4 and the CSRF cookie is named as expected`, async () => {
      const px = await startProxy(lines);
      const b = new Browser();
      await startLogin(b, px.base);
      const names = b.csrfCookies();
      expect(names).toHaveLength(1);
      if (name === 'current') {
        expect(PRE_G1).not.toBe(INSTALLED); // the G1 block is present, exactly as approved
        expect(PRE_G1).not.toMatch(/cookie_csrf/);
        expect(names[0]).toBe(`${SESSION}_csrf`);
      }
      else expect(names[0]).toMatch(new RegExp(`^${SESSION}_[A-Za-z0-9_-]+_csrf$`));
      const attrs = b.setCookies.find((c) => c.startsWith(names[0]!))!;
      expect(attrs).toMatch(/HttpOnly/i);
      expect(attrs).toMatch(/SameSite=Lax/i);
      expect(attrs).toMatch(/Max-Age=900\b|Expires=/i);
      expect(px.log()).toMatch(new RegExp(`Cookie settings: name:${SESSION} `));
      evidence[name] = { ...(evidence[name] as object), csrfCookieName: name === 'current' ? names[0] : `${SESSION}_<per-login hash>_csrf` };
    });

    it(`${name}: login, two tabs, CSRF enforcement, replay, expiry, allowlist`, async () => {
      const px = await startProxy(lines);
      const r: Record<string, unknown> = {};
      nextEmail = ALLOWED;
      // normal login: back on the original URL, session set, CSRF cookie cleared
      const ok = new Browser();
      const cb = await ok.approveAt(await startLogin(ok, px.base, '/x'));
      const done = await ok.get(cb);
      expect([done.status, done.headers.get('location')]).toEqual([302, '/x']);
      expect(ok.jar.has(SESSION)).toBe(true);
      expect(ok.csrfCookies()).toEqual([]);
      expect((await ok.get(`${px.base}/`)).status).toBe(200);
      r.normal = 302;
      // replayed callback (refresh/back): refused; the code was redeemed exactly once
      r.replay = (await ok.get(cb)).status;
      expect(r.replay).toBe(403);
      expect(redeemed.get(new URL(cb).searchParams.get('code')!)).toBe(1);
      // two tabs signing in at once
      const tabs = new Browser();
      const t1 = await startLogin(tabs, px.base, '/a');
      const t2 = await startLogin(tabs, px.base, '/b');
      const a1 = await tabs.get(await tabs.approveAt(t1));
      const a2 = await tabs.get(await tabs.approveAt(t2));
      r.twoTabs = [a1.status, a2.status];
      if (name === 'current') expect(r.twoTabs).toEqual([403, 403]);
      else {
        expect(r.twoTabs).toEqual([302, 302]);
        expect([a1.headers.get('location'), a2.headers.get('location')]).toEqual(['/a', '/b']);
        expect((await tabs.get(`${px.base}/`)).status).toBe(200);
      }
      // missing CSRF cookie
      const none = new Browser();
      const s1 = await startLogin(none, px.base);
      for (const k of none.csrfCookies()) none.jar.delete(k);
      r.missingCsrf = (await none.get(await none.approveAt(s1))).status;
      // tampered state
      const tam = new Browser();
      const back = new URL(await tam.approveAt(await startLogin(tam, px.base)));
      const st = back.searchParams.get('state')!;
      back.searchParams.set('state', (st[0] === 'A' ? 'B' : 'A') + st.slice(1));
      r.tamperedState = (await tam.get(back.toString())).status;
      // only another login's CSRF cookie
      const mix = new Browser();
      const la = await startLogin(mix, px.base, '/a');
      const ca = mix.csrfCookies();
      await startLogin(mix, px.base, '/b');
      if (name !== 'current') for (const k of ca) mix.jar.delete(k);
      r.foreignCsrfOnly = (await mix.get(await mix.approveAt(la))).status;
      // the callback URL presented by another browser
      const victim = new Browser();
      r.otherBrowser = (await new Browser().get(await victim.approveAt(await startLogin(victim, px.base)))).status;
      expect([r.missingCsrf, r.tamperedState, r.foreignCsrfOnly, r.otherBrowser]).toEqual([403, 403, 403, 403]);
      // an account not on the allowlist: 403, no session
      nextEmail = 'intruder@example.test';
      const intr = new Browser();
      r.unauthorized = (await intr.get(await intr.approveAt(await startLogin(intr, px.base)))).status;
      nextEmail = ALLOWED;
      expect(r.unauthorized).toBe(403);
      expect(intr.jar.has(SESSION)).toBe(false);
      expect((await intr.get(`${px.base}/`)).status).toBe(302);
      evidence[name] = { ...(evidence[name] as object), matrix: r };
    });

    it(`${name}: an expired session: background 401 without a login, then one clean login`, async () => {
      const px = await startProxy(lines, ['--cookie-expire=3s']);
      const b = new Browser();
      expect((await b.get(await b.approveAt(await startLogin(b, px.base)))).status).toBe(302);
      await new Promise((r) => setTimeout(r, 4000));
      const bg = await b.get(`${px.base}/version.json`, '*/*, application/json');
      expect(bg.status).toBe(401);
      expect(bg.headers.get('location')).toBeNull();
      for (const c of bg.headers.getSetCookie()) expect(c).toMatch(new RegExp(`^${SESSION}=;.*Max-Age=0`, 'i'));
      expect(b.csrfCookies()).toEqual([]);
      const top = await b.get(`${px.base}/`);
      expect(top.status).toBe(302);
      expect(b.csrfCookies()).toHaveLength(1);
      const fin = await b.get(await b.approveAt(top.headers.get('location')!));
      expect(fin.status).toBe(302);
      expect((await b.get(`${px.base}/`)).status).toBe(200);
      evidence[name] = { ...(evidence[name] as object), expired: { background: 401, relogin: 302 } };
    });

    it(`${name}: what reaches the log (success, a signed-in browser's failed callback, unauthorized)`, async () => {
      const px = await startProxy(lines);
      nextEmail = ALLOWED;
      const b = new Browser();
      expect((await b.get(await b.approveAt(await startLogin(b, px.base)))).status).toBe(302);
      expect((await b.get(`${px.base}/`)).status).toBe(200);
      const sessionValue = b.jar.get(SESSION)!;
      // The dangerous case: a browser that is STILL signed in presents a callback it holds no
      // CSRF cookie for (an old tab, a stale history entry): v7.15.4 dumps the whole request,
      // this browser's Cookie header included.
      const other = new Browser();
      const stale = await other.approveAt(await startLogin(other, px.base));
      const csrf2 = other.csrfCookies().map((k) => other.jar.get(k)!);
      expect((await b.get(stale)).status).toBe(403);
      nextEmail = 'intruder@example.test';
      const intr = new Browser();
      expect((await intr.get(await intr.approveAt(await startLogin(intr, px.base)))).status).toBe(403);
      nextEmail = ALLOWED;
      await settle(px);
      const all = px.log();
      const lines2 = all.split('\n');
      const kept = lines2.filter((l) => !JOURNAL_DROP.some((re) => re.test(l)));
      const cookieVals = [sessionValue, ...csrf2];
      const raw = leakCounts(all, cookieVals);
      const filtered = leakCounts(kept.join('\n'), cookieVals);
      const diagnostics = {
        authSuccessWithRequestId: kept.some((l) => /[0-9a-f]{8}-[0-9a-f]{4}-.*\[AuthSuccess\]/.test(l)),
        authFailureUnauthorized: kept.some((l) => /\[AuthFailure\].*unauthorized/.test(l)),
        tokenValidationLine: kept.some((l) => /internal_util\.go:\d+\] 200 GET .*tokeninfo\?access_token=[^&\s]{0,5}\.\.\./.test(l)),
        requestLogLines: kept.filter((l) => /\] 127\.0\.0\.1:\d+ GET /.test(l) || / - \[\d{4}\/.*\] 127\.0\.0\.1/.test(l)).length,
      };
      evidence[name] = { ...(evidence[name] as object), log: { raw, afterJournalDrop: filtered, diagnostics } };
      // Never in any variant: the full access token, the id token, the client secret.
      expect([raw.accessTokens, raw.idTokens, raw.clientSecret]).toEqual([0, 0, 0]);
      expect(diagnostics.tokenValidationLine).toBe(true);
      // Today (and with G1 only): the callback query and the request dump with the cookie.
      if (name !== 'G1+G2a') expect(raw.codes).toBeGreaterThan(0);
      expect(raw.cookieHeaderDumps).toBeGreaterThan(0); // the failure path, in every variant
      expect(raw.cookieValues).toBeGreaterThan(0);
      // With G2a + the journald drop: nothing sensitive is stored; the audit lines stay.
      if (name === 'G1+G2a') {
        expect(filtered).toEqual({ codes: 0, states: 0, accessTokens: 0, idTokens: 0, cookieValues: 0, clientSecret: 0, cookieHeaderDumps: 0, callbackQueries: 0 });
        expect(diagnostics.authSuccessWithRequestId && diagnostics.authFailureUnauthorized).toBe(true);
      }
    });
  }

  it('G1: CSRF cookies from abandoned logins accumulate only until they expire (15 min)', async () => {
    const px = await startProxy(G1_LINES);
    const b = new Browser();
    const starts: string[] = [];
    for (let k = 0; k < 20; k++) starts.push(await startLogin(b, px.base, `/p${k}`));
    const n = b.csrfCookies().length;
    const header = b.cookieHeader().length;
    // the LAST and the FIRST of them still complete (each has its own cookie)
    const last = await b.get(await b.approveAt(starts.at(-1)!));
    const first = await b.get(await b.approveAt(starts[0]!));
    evidence.accumulation = { abandonedLogins: 20, csrfCookies: n, cookieHeaderBytes: header, lastCompletes: last.status, firstCompletes: first.status };
    expect(n).toBe(20);
    expect([last.status, first.status]).toEqual([302, 302]);
  });
});
