/**
 * Sprint 8 Phase 1 heavy check: the REAL gate binaries in the deployment's arrangement, all over
 * unix sockets — oauth2-proxy (a throwaway local test user instead of Google) → Caddy internal
 * origin (strips `X-Tbi-*`) → the real build service and Session Host HTTP layers, which derive
 * the principal from the gate's subject header.
 *
 * Needs `oauth2-proxy` and `caddy` on the PATH (the dev-lab host has both); skipped otherwise.
 * Other-user socket access is checked with `sudo -n -u nobody` when passwordless sudo exists.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBuildHttpServer } from '../builder/http.js';
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import { Grants } from '../builder/grants.js';
import { FakeProvider } from '../builder/tests/support.js';
import { listen } from '../identity/listen.js';
import { derivePrincipal, identityConfig, principalOf } from '../identity/principal.js';

const which = (b: string) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
const HAVE = which('oauth2-proxy') && which('caddy');
const SUDO = HAVE && spawnSync('sudo', ['-n', '-u', 'nobody', 'true']).status === 0;

const dir = HAVE ? mkdtempSync('/var/tmp/tbi-s8-gate-') : '';
const children: ChildProcess[] = [];
const servers: Server[] = [];
const identity = identityConfig({ issuer: 'test', key: randomBytes(32) });
const user = 'gateuser';
const pass = randomBytes(12).toString('base64url');
let base = '';

async function waitFor(url: string, auth: string) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { headers: { authorization: auth } });
      if (r.status !== 502) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gate not up: ${url}`);
}

beforeAll(async () => {
  if (!HAVE) return;
  // Backends on unix sockets (mode 0660) in a directory only this user can traverse.
  const run = join(dir, 'run');
  mkdirSync(run, { mode: 0o700 });
  const echo = createServer((req, res) => {
    // Reports what the backend sees: the derived principal and any X-Tbi header that got through.
    res.end(
      JSON.stringify({
        principal: principalOf(req, identity),
        tbiHeaders: Object.keys(req.headers).filter((h) => h.startsWith('x-tbi')),
      }),
    );
  });
  await listen(echo, { unix: join(run, 'echo.sock') });
  mkdirSync(join(dir, 'store'));
  const store = new ArtifactStore({ dir: join(dir, 'store'), capBytes: 64 << 20, graceMs: 0 });
  mkdirSync(join(dir, 'work'));
  const grants = new Grants(':memory:');
  const build = createBuildHttpServer(
    new BuildService([new FakeProvider()], store, join(dir, 'work'), DEFAULT_LIMITS, {
      grants,
      ticketKey: randomBytes(32),
      systemKeys: new Set(),
    }),
    { leaseMs: 60_000, identity, allowPrebuiltBinary: () => false },
  );
  await listen(build, { unix: join(run, 'build.sock') });
  servers.push(echo, build);

  // The internal origin exactly as deployed (deploy/dev-lab/Caddyfile): unix socket in and out,
  // `X-Tbi-*` stripped on the way to every backend.
  writeFileSync(
    join(dir, 'Caddyfile'),
    `{\n\tadmin off\n\tauto_https off\n}\nhttp:// {\n\tbind unix/${run}/internal.sock\n` +
      `\thandle_path /echo/* {\n\t\treverse_proxy unix/${run}/echo.sock {\n\t\t\theader_up -X-Tbi-*\n\t\t}\n\t}\n` +
      `\thandle_path /build/* {\n\t\treverse_proxy unix/${run}/build.sock {\n\t\t\theader_up -X-Tbi-*\n\t\t}\n\t}\n}\n`,
  );
  const caddy = spawn(
    'caddy',
    ['run', '--config', join(dir, 'Caddyfile'), '--adapter', 'caddyfile'],
    {
      env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir },
      stdio: 'ignore',
    },
  );
  children.push(caddy);
  // oauth2-proxy with a local htpasswd user (the Google provider is configured but unused).
  const sha1 = createHash('sha1').update(pass).digest('base64');
  writeFileSync(join(dir, 'htpasswd'), `${user}:{SHA}${sha1}\n`);
  const port = 4300 + Math.floor(Math.random() * 500);
  const proxy = spawn(
    'oauth2-proxy',
    [
      `--http-address=127.0.0.1:${port}`,
      `--upstream=unix://${run}/internal.sock`,
      '--provider=google',
      '--client-id=test',
      '--client-secret=test',
      `--cookie-secret=${randomBytes(16).toString('hex')}`,
      '--email-domain=*',
      `--htpasswd-file=${join(dir, 'htpasswd')}`,
      `--redirect-url=http://127.0.0.1:${port}/oauth2/callback`,
      '--reverse-proxy=true',
      '--cookie-secure=false',
    ],
    { stdio: 'ignore' },
  );
  children.push(proxy);
  base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/echo/`, basic());
});

afterAll(() => {
  for (const c of children) c.kill('SIGTERM');
  for (const s of servers) s.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const basic = () => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe.skipIf(!HAVE)('the real gate (oauth2-proxy → Caddy → backends, unix sockets)', () => {
  it('without a login nothing reaches a backend, forged headers or not', async () => {
    const r = await fetch(`${base}/echo/`, { headers: { 'x-forwarded-user': 'victim' } });
    expect(r.status).toBe(403);
  });

  it('forged identity headers are replaced or stripped; the principal is the logged-in user', async () => {
    const r = await fetch(`${base}/echo/`, {
      headers: {
        authorization: basic(),
        'x-forwarded-user': 'victim',
        'x-forwarded-email': 'victim@example.com',
        'x-tbi-principal': 'p_forged',
      },
    });
    expect(r.status).toBe(200);
    const seen = (await r.json()) as { principal: string; tbiHeaders: string[] };
    expect(seen.principal).toBe(derivePrincipal(identity, user));
    expect(seen.principal).not.toBe(derivePrincipal(identity, 'victim'));
    expect(seen.tbiHeaders).toEqual([]);
  });

  it('the same login is the same principal on every request', async () => {
    const a = (await (
      await fetch(`${base}/echo/`, { headers: { authorization: basic() } })
    ).json()) as {
      principal: string;
    };
    const b = (await (
      await fetch(`${base}/echo/x`, { headers: { authorization: basic() } })
    ).json()) as {
      principal: string;
    };
    expect(a.principal).toBe(b.principal);
  });

  it('the build service behind the gate answers the logged-in user', async () => {
    const r = await fetch(`${base}/build/v1/lookup?key=${'0'.repeat(64)}`, {
      headers: { authorization: basic() },
    });
    expect(r.status).toBe(404); // identity accepted; nothing built yet
  });

  it.skipIf(!SUDO)('another local user cannot reach the gate or a backend socket directly', () => {
    // The socket directory is private to the service user; everything else is refused.
    for (const sock of ['internal.sock', 'build.sock', 'echo.sock']) {
      const out = spawnSync(
        'sudo',
        ['-n', '-u', 'nobody', 'curl', '-sS', '--unix-socket', join(dir, 'run', sock), 'http://x/'],
        { encoding: 'utf8' },
      );
      expect(out.status, sock).not.toBe(0);
    }
    // Even with the directory opened up, the 0660 socket itself refuses other users.
    chmodSync(join(dir, 'run'), 0o755);
    try {
      const out = spawnSync(
        'sudo',
        [
          '-n',
          '-u',
          'nobody',
          'curl',
          '-sS',
          '--unix-socket',
          join(dir, 'run', 'build.sock'),
          'http://x/',
        ],
        { encoding: 'utf8' },
      );
      expect(out.status).not.toBe(0);
    } finally {
      chmodSync(join(dir, 'run'), 0o700);
    }
  });
});
