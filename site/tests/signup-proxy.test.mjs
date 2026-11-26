/**
 * BETA-G1 (gate G1, K4/K5/K8): the sign-up site's Caddy config (site/deploy/) against a real
 * Caddy, offline: admin off, auto_https off, temp HOME/XDG, client listener on 127.0.0.1, a
 * recording fake intake on a unix socket in a 0700 temp dir, plus one end-to-end token-then-post
 * against the real intake (TBI_SIGNUP_WEB=1, loopback TCP). Skipped without caddy, unless
 * TBI_REQUIRE_CADDY=1 (then absence or a version < 2.6 is a failure).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCaddyfile } from '../deploy/caddy.mjs';
import { SITE_CSP } from '../csp.mjs';
import { buildSite } from '../build.mjs';

function caddyVersion() {
  try {
    const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(
      execFileSync('caddy', ['version'], { encoding: 'utf8' }),
    );
    return m ? m.slice(1).map(Number) : null;
  } catch {
    return null;
  }
}
const VERSION = caddyVersion();
const HAVE = VERSION !== null && (VERSION[0] > 2 || (VERSION[0] === 2 && VERSION[1] >= 6));
const SITE = 'signup.example.test';
const HDR = 'X-Tbi-Client-Ip';
const VALUES = (upstream) => ({
  SITE_HOST: SITE,
  SITE_ROOT: '/srv/example-site',
  INTAKE_UPSTREAM: upstream,
  SOURCE_HEADER: HDR,
});

describe('TBI_REQUIRE_CADDY', () => {
  it.runIf(process.env.TBI_REQUIRE_CADDY === '1')('caddy >= 2.6 is on the PATH', () => {
    expect(VERSION, 'caddy missing').not.toBeNull();
    expect(HAVE, `caddy ${VERSION?.join('.')} < 2.6`).toBe(true);
  });
});

describe('renderCaddyfile (offline)', () => {
  it('refuses missing, unknown and unsafe values and unreplaced placeholders', () => {
    const ok = VALUES('unix//tmp/x.sock');
    expect(() => renderCaddyfile({ ...ok, SITE_HOST: '' })).toThrow(/missing/);
    expect(() => renderCaddyfile({ ...ok, EXTRA: 'a' })).toThrow(/unknown/);
    for (const bad of ['a b', 'a{b', 'a}b', 'a"b', "a'b", 'a\nb', 'a\tb', 'a\u0001b'])
      expect(() => renderCaddyfile({ ...ok, SITE_ROOT: bad }), JSON.stringify(bad)).toThrow(
        /unsafe/,
      );
    expect(() => renderCaddyfile({ ...ok, SOURCE_HEADER: 'X:Y' })).toThrow(/unsafe/);
    expect(() =>
      renderCaddyfile(ok, { template: '{{SITE_HOST}} {{OTHER}}\n\t#proxy-begin\n\t#proxy-end\n' }),
    ).toThrow(/unreplaced/);
  });
  it('allow-lists every value: each rejected example', () => {
    const ok = VALUES('127.0.0.1:7411');
    const rejected = {
      SITE_HOST: [
        '*',
        '*.example.test',
        'signup.example.test:443',
        'a.example.test,b.example.test',
        'https://signup.example.test',
        'signup.example.test/x',
        ':443',
        '0.0.0.0',
        '-a.example.test',
        'a..example.test',
        'signup\u0085.example.test',
      ],
      SITE_ROOT: [
        '/',
        '//',
        '/.',
        '/..',
        '/srv/../..',
        'srv/site',
        './site',
        '/srv/*',
        '/srv/$X',
        '/srv/a;b',
        '/srv/a\u0085b',
      ],
      INTAKE_UPSTREAM: [
        '0.0.0.0:7411',
        '198.51.100.5:7411',
        'intake.example.test:7411',
        '127.0.0.1',
        '127.0.0.1:0',
        '127.0.0.1:65536',
        ':7411',
        'http://127.0.0.1:7411',
        '127.0.0.1:7411,198.51.100.5:7411',
        '127.0.0.1.example.test:7411',
        '[::]:7411',
        'unix/relative.sock',
        'unix//tmp/x',
        'unix//tmp/../x.sock',
        '127.0.0.1:7411\u0085',
      ],
      SOURCE_HEADER: [
        'Host',
        'Origin',
        'Content-Type',
        'X-Forwarded-For',
        'X-Real-Ip',
        'X-Tbi-',
        'X-Tbi-*',
        'X-Tbi-Ip\u0085',
      ],
    };
    for (const [key, list] of Object.entries(rejected))
      for (const bad of list)
        expect(
          () => renderCaddyfile({ ...ok, [key]: bad }),
          `${key} ${JSON.stringify(bad)}`,
        ).toThrow(`unsafe value for ${key}`);
    for (const good of ['[::1]:7411', 'localhost:7411', 'unix//run/tbi/intake.sock'])
      expect(() => renderCaddyfile({ ...ok, INTAKE_UPSTREAM: good }), good).not.toThrow();
  });
  it('has no log directive, no handle_path, no wildcard route; rollback has no proxy; HSTS only on tls', () => {
    const tls = renderCaddyfile(VALUES('127.0.0.1:7411'));
    const plain = renderCaddyfile(VALUES('127.0.0.1:7411'), { variant: 'plain' });
    const rollback = renderCaddyfile(VALUES('127.0.0.1:7411'), { proxy: false });
    for (const t of [tls, plain, rollback]) {
      expect(t).not.toMatch(/^\s*log\b/m);
      expect(t).not.toMatch(/handle_path|\/signup\/\*|\/signup\s*\{/);
      expect(t).not.toMatch(/\{\{/);
    }
    expect(tls).toMatch(/Strict-Transport-Security "max-age=31536000"/);
    expect(tls).not.toMatch(/preload/);
    expect(plain).not.toMatch(/Strict-Transport-Security/);
    expect(rollback).not.toMatch(/reverse_proxy|\/signup\/|@tbi_intake/);
  });
  it('the template CSP is the exported SITE_CSP (also sent by site/serve.mjs)', () => {
    expect(renderCaddyfile(VALUES('127.0.0.1:7411'))).toContain(
      `Content-Security-Policy "${SITE_CSP}"`,
    );
    expect(readFileSync(new URL('../serve.mjs', import.meta.url), 'utf8')).toMatch(/SITE_CSP/);
  });
});

const run = (args, env) => execFileSync('caddy', args, { env, encoding: 'utf8', stdio: 'pipe' });

describe.skipIf(!HAVE)(`real caddy ${VERSION?.join('.')} (loopback only)`, () => {
  let dir, sockDir, siteRoot, env;
  const children = [];
  const servers = [];
  const seen = []; // recording fake intake

  /** Free loopback port (closed again before caddy binds it). */
  const freePort = () =>
    new Promise((res) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => res(port));
      });
    });
  /** Raw request: exact path and Host as given (no client-side normalisation). */
  const send = (
    port,
    path,
    { method = 'GET', headers = {}, body, chunked = false, host = SITE } = {},
  ) =>
    new Promise((res, rej) => {
      const r = request(
        { host: '127.0.0.1', port, path, method, headers: { host, ...headers } },
        (resp) => {
          let b = '';
          resp.on('data', (c) => (b += c));
          resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: b }));
        },
      );
      r.on('error', rej);
      if (body !== undefined) {
        if (chunked) for (let i = 0; i < body.length; i += 1024) r.write(body.slice(i, i + 1024));
        else r.write(body);
      }
      r.end();
    });
  const start = async (name, text) => {
    const port = await freePort();
    // Harness only: admin off, auto_https off, bind loopback with an explicit port.
    const conf = text
      .replace(/^\{\n/m, '{\n\tadmin off\n\tauto_https off\n')
      .replace(`http://${SITE} {`, `http://${SITE}:${port} {\n\tbind 127.0.0.1`);
    const f = join(dir, `${name}.Caddyfile`);
    writeFileSync(f, conf);
    run(['validate', '--config', f, '--adapter', 'caddyfile'], env);
    const c = spawn('caddy', ['run', '--config', f, '--adapter', 'caddyfile'], {
      env,
      stdio: 'ignore',
    });
    children.push(c);
    for (let i = 0; i < 100; i++) {
      try {
        await send(port, '/');
        return port;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(`caddy ${name} did not start`);
  };

  let port, rollbackPort, downPort;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tbi-g1-caddy-'));
    sockDir = join(dir, 'sock');
    mkdirSync(sockDir, { mode: 0o700 });
    env = { PATH: process.env.PATH, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir };
    siteRoot = join(dir, 'site');
    buildSite(siteRoot, { signupPreview: true });
    const sock = join(sockDir, 'intake.sock');
    const fake = createServer((req, res) => {
      let n = 0;
      req.on('data', (c) => (n += c.length));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          bodyBytes: n,
          complete: true,
        });
        res.writeHead(200, { 'content-type': 'application/json', server: 'fake-intake' });
        res.end('{"ok":true}');
      });
      req.on('aborted', () => seen.push({ url: req.url, bodyBytes: n, complete: false }));
    });
    await new Promise((r) => fake.listen(sock, r));
    servers.push(fake);
    const v = { ...VALUES(`unix/${sock}`), SITE_ROOT: siteRoot };
    port = await start('proxy', renderCaddyfile(v, { variant: 'plain' }));
    rollbackPort = await start('rollback', renderCaddyfile(v, { variant: 'plain', proxy: false }));
    downPort = await start(
      'down',
      renderCaddyfile(
        { ...v, INTAKE_UPSTREAM: `unix/${join(sockDir, 'absent.sock')}` },
        { variant: 'plain' },
      ),
    );
  });
  afterAll(() => {
    for (const c of children) c.kill('SIGTERM');
    for (const s of servers) s.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('caddy validate accepts both rendered production configs (tls and rollback)', () => {
    for (const [n, o] of [
      ['tls', {}],
      ['tls-rollback', { proxy: false }],
    ]) {
      const f = join(dir, `${n}.Caddyfile`);
      writeFileSync(f, renderCaddyfile({ ...VALUES('127.0.0.1:7411'), SITE_ROOT: siteRoot }, o));
      expect(() => run(['validate', '--config', f, '--adapter', 'caddyfile'], env)).not.toThrow();
    }
  });

  it('routes exactly the two paths (query allowed) and strips identity headers', async () => {
    seen.length = 0;
    const forged = {
      'x-tbi-user': 'admin',
      'x-forwarded-for': '6.6.6.6',
      'x-forwarded-host': 'evil.example',
      forwarded: 'for=6.6.6.6',
      'x-real-ip': '6.6.6.6',
      'true-client-ip': '6.6.6.6',
      'cf-connecting-ip': '6.6.6.6',
      [HDR]: '6.6.6.6',
      cookie: 'a=b',
      origin: `https://${SITE}`,
      referer: `https://${SITE}/en/signup/`,
    };
    const a = await send(port, '/signup/form-token?x=1', { headers: forged });
    const b = await send(port, '/signup/web', {
      method: 'POST',
      headers: { ...forged, 'content-type': 'application/json' },
      body: '{}',
    });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /signup/form-token?x=1',
      'POST /signup/web',
    ]);
    for (const s of seen) {
      const h = s.headers;
      expect(h[HDR.toLowerCase()]).toBe('127.0.0.1');
      for (const k of [
        'x-tbi-user',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
        'forwarded',
      ])
        expect(h[k], k).toBeUndefined();
      for (const k of ['x-real-ip', 'true-client-ip', 'cf-connecting-ip', 'cookie'])
        expect(h[k], k).toBeUndefined();
      expect(h.origin).toBe(forged.origin);
      expect(h.referer).toBe(forged.referer);
    }
    expect(seen[1].headers['content-type']).toBe('application/json');
    expect(b.headers.server).toBeUndefined();
  });

  it('path confusion and foreign Host: nothing reaches the intake', async () => {
    seen.length = 0;
    const paths = [
      '/signup',
      '/signup/',
      '/signup/web/',
      '/signup/webx',
      '/SIGNUP/WEB',
      '/Signup/Form-Token',
      '/signup/web/../../x',
      '/x/../signup/web',
      '/signup%2Fweb',
      '/signup/%77eb',
      '/signup//web',
      '/signup/other',
      '/admin',
    ];
    const got = {};
    for (const p of paths) {
      got[p] = (await send(port, p)).status;
      got[`POST ${p}`] = (await send(port, p, { method: 'POST', body: '{}' })).status;
    }
    // Caddy 2.6 answers a Host no site matches with an EMPTY 200 (its default, nothing routed);
    // the template adds no catch-all site because the live config may hold other sites.
    const foreign = await send(port, '/signup/web', {
      method: 'POST',
      host: 'other.example.test',
      body: '{}',
    });
    expect(seen.map((s) => s.url)).toEqual([]);
    for (const [k, v] of Object.entries(got)) expect([k, v]).toEqual([k, 404]);
    expect([foreign.status, foreign.body]).toEqual([200, '']);
  });

  it('oversize bodies (Content-Length and chunked) are refused before the intake gets them', async () => {
    seen.length = 0;
    const big = 'x'.repeat(64 * 1024);
    const h = { 'content-type': 'application/json' };
    const cl = await send(port, '/signup/web', { method: 'POST', headers: h, body: big });
    const ch = await send(port, '/signup/web', {
      method: 'POST',
      headers: h,
      body: big,
      chunked: true,
    });
    // Caddy 2.6.2: 413 for both. Chunked is streamed, so the intake may see up to 8 KB and then an
    // aborted request (never the full body; the intake's own 4 KiB cap stays authoritative).
    expect([cl.status, ch.status]).toEqual([413, 413]);
    await new Promise((r) => setTimeout(r, 200));
    for (const s of seen) {
      expect(s.complete, JSON.stringify(s)).toBe(false);
      expect(s.bodyBytes).toBeLessThanOrEqual(8 * 1024);
    }
  });

  it('security headers on static, proxied and error responses; built pages need no inline code', async () => {
    for (const r of [
      await send(port, '/en/'),
      await send(port, '/signup/form-token'),
      await send(port, '/nope'),
    ]) {
      expect(r.headers['content-security-policy']).toBe(SITE_CSP);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(r.headers['permissions-policy']).toMatch(/camera=\(\)/);
      expect(r.headers['strict-transport-security']).toBeUndefined(); // plain variant
      expect(r.headers.server).toBeUndefined();
    }
    const html = [];
    const walk = (d) =>
      readdirSync(d, { withFileTypes: true }).forEach((e) =>
        e.isDirectory()
          ? walk(join(d, e.name))
          : e.name.endsWith('.html') && html.push(join(d, e.name)),
      );
    walk(siteRoot);
    expect(html.some((f) => f.includes('signup'))).toBe(true);
    for (const f of html) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
      expect(t, f).not.toMatch(/<style|\sstyle=|\son[a-z]+=|javascript:/i);
    }
  });

  it('rollback config: both paths 404 from Caddy, the intake gets nothing, the site serves', async () => {
    seen.length = 0;
    expect((await send(rollbackPort, '/signup/form-token')).status).toBe(404);
    expect((await send(rollbackPort, '/signup/web', { method: 'POST', body: '{}' })).status).toBe(
      404,
    );
    expect((await send(rollbackPort, '/en/')).status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it('intake down: generic 502 without the upstream address, static site keeps serving', async () => {
    const r = await send(downPort, '/signup/web', { method: 'POST', body: '{}' });
    expect(r.status).toBe(502);
    expect(r.body.trim()).toBe('502 Bad Gateway');
    expect(r.body).not.toMatch(/sock|unix|127\.0\.0\.1|dial/);
    expect((await send(downPort, '/en/')).status).toBe(200);
  });

  it('end to end: token then post through Caddy into the real intake (TBI_SIGNUP_WEB=1)', async () => {
    const { intakeConfigFromEnv, startIntake } =
      await import('../../runtime/admin/signup/intake-server.ts');
    const root = join(dir, 'intake');
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, 'hmac'), 'test-secret-not-real-0123456789abcdef\n', { mode: 0o600 });
    writeFileSync(join(root, 'tg'), '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test\n', { mode: 0o600 });
    const cfg = intakeConfigFromEnv({
      TBI_SIGNUP_INTAKE: '1',
      TBI_SIGNUP_DIR: join(root, 'p'),
      TBI_SIGNUP_HMAC_FILE: join(root, 'hmac'),
      TBI_SIGNUP_TELEGRAM_TOKEN_FILE: join(root, 'tg'),
      TBI_SIGNUP_TELEGRAM_CHAT_ID: '42',
      TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.invalid/signups',
      TBI_SIGNUP_LISTEN: '127.0.0.1:0',
      TBI_SIGNUP_SOURCE_HEADER: HDR.toLowerCase(),
      TBI_SIGNUP_QUIET: 'off',
      TBI_SIGNUP_WEB: '1',
      TBI_SIGNUP_WEB_ORIGINS: `https://${SITE}`,
    });
    if (!cfg.enabled) throw new Error(`intake config: ${cfg.reason}`);
    let t = Date.now();
    const intake = await startIntake(cfg.config, {
      fetch: async () => ({ ok: true, status: 200 }),
      log: () => undefined,
      now: () => t,
    });
    try {
      const v = { ...VALUES(`127.0.0.1:${intake.port}`), SITE_ROOT: siteRoot };
      const p = await start('e2e', renderCaddyfile(v, { variant: 'plain' }));
      const origin = { origin: `https://${SITE}`, 'x-forwarded-for': '6.6.6.6' };
      const tok = await send(p, '/signup/form-token', { headers: origin });
      expect(tok.status).toBe(200);
      t += 5_000; // past minFill (3 s) on the intake's injected clock
      const fields = {
        name: 'Dana Levi',
        email: 'dana@example.com',
        role: 'T',
        lang: 'en',
        consent: true,
      };
      const post = await send(p, '/signup/web', {
        method: 'POST',
        headers: { ...origin, 'content-type': 'application/json' },
        body: JSON.stringify({ ...fields, token: JSON.parse(tok.body).token, website: '' }),
      });
      expect([post.status, JSON.parse(post.body)]).toEqual([200, { ok: true, status: 'received' }]);
      // No-JS form POST (urlencoded) is refused by the intake with 415.
      const form = await send(p, '/signup/web', {
        method: 'POST',
        headers: { ...origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=x',
      });
      expect(form.status).toBe(415);
    } finally {
      await intake.close();
    }
  });
});
