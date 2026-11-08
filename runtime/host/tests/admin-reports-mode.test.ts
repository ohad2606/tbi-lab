/**
 * Sprint 23C, adversarial: the feedback-only release (`TBI_ADMIN_MODE=reports`). The Session Host
 * serves the owner's report routes only; every account, request and sessions path is 404 for
 * every identity, the owner included; the owner comes from a root-provided owner reference file
 * (fail closed: 503); nothing is written outside the report store (no spool, no observations).
 * Users reach the host through test gates (oauth2-proxy's role). Addresses: example.invalid only.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccessView, deriveEmailTag } from '../../identity/access.js';
import { TEST_IDENTITY, principalFor, startTestGate } from '../../identity/test-gate.js';
import { IdentityObserver, adminEnvFromEnv } from '../admin.js';
import type { SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import { OwnerReference } from '../owner.js';
import { DEFAULT_REPORTS, ReportStore } from '../reports.js';
import { fakeHost } from './support.js';

const OWNER = { sub: '1000000001', email: 'owner@example.invalid' };
const TESTER = { sub: '2000000002', email: 'tester@example.invalid' };
const P = (u: { sub: string }) => principalFor(u.sub);
const UID = process.getuid!();
const GID = process.getgid!();

let shared: SessionHost;
beforeAll(() => {
  shared = fakeHost('normal').host;
});
afterAll(async () => {
  await shared.shutdown();
});
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** Every file and directory under `d` (relative), to assert what was written. */
function tree(d: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(d).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    out.push(rel);
    if (statSync(join(d, name)).isDirectory()) out.push(...tree(join(d, name), rel));
  }
  return out;
}

interface Setup {
  root: string;
  access: AccessView | null;
  ownerFile: string;
  owner: OwnerReference;
  store: ReportStore;
  gate: (u: { sub: string; email?: string } | null, email?: string | null) => Promise<string>;
}

/**
 * A Session Host in reports mode. It is also HANDED an observer (as if a deployment left
 * TBI_ADMIN_DIR's objects in place): reports mode must not use it.
 */
async function serve(
  opts: { ownerExpect?: { uid?: number; gid?: number }; withAccess?: boolean } = {},
): Promise<Setup> {
  const root = mkdtempSync(join(tmpdir(), 'tbi-reports-mode-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const adminDir = join(root, 'admin');
  for (const sub of ['spool', 'results', 'view', 'observations'])
    mkdirSync(join(adminDir, sub), { recursive: true });
  const ownerFile = join(root, 'owner.principal');
  writeFileSync(ownerFile, `${P(OWNER)}\n`, { mode: 0o640 });
  chmodSync(ownerFile, 0o640);
  const owner = new OwnerReference(ownerFile, { uid: UID, gid: GID, ...opts.ownerExpect });
  const store = new ReportStore(
    { ...DEFAULT_REPORTS, dir: join(root, 'reports') },
    { log: () => undefined },
  );
  let access: AccessView | null = null;
  if (opts.withAccess) {
    access = new AccessView(join(adminDir, 'view', 'access.json'));
    cleanup.push(() => access!.stop());
  }
  const server: Server = createHttpServer(shared, TEST_IDENTITY, store, {
    adminMode: 'reports',
    owner,
    access,
    observer: new IdentityObserver(join(adminDir, 'observations')),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  return {
    root,
    access,
    ownerFile,
    owner,
    store,
    gate: async (u, email) => {
      const g = await startTestGate(
        target,
        TEST_IDENTITY,
        u?.sub ?? null,
        email === undefined ? (u?.email ?? null) : email,
      );
      cleanup.push(g.close);
      return g.base;
    },
  };
}

function mutation(
  base: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      origin: base,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function call(base: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, text };
}

/** A raw request with the path exactly as written (fetch would normalize `.` and `..`). */
function raw(base: string, method: string, path: string): Promise<number> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const r = request({ host: u.hostname, port: u.port, method, path }, (res) => {
      res.resume();
      res.on('end', () => ok(res.statusCode ?? 0));
    });
    r.on('error', fail);
    r.end();
  });
}

const report = (description: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    description,
    category: 'other',
    blocking: false,
    locale: 'en',
    view: 'home',
    kind: 'general',
  }),
});

/** Every account, request and sessions path s23b served, and a few that never existed. */
const ACCOUNT_PATHS = [
  '/admin/accounts',
  '/admin/accounts/',
  '/admin/accounts/disable',
  '/admin/accounts/reactivate',
  '/admin/accounts/add',
  `/admin/requests/${'0'.repeat(26)}`,
  '/admin/requests',
  '/admin/sessions',
  '/admin/sessions/',
  '/admin//accounts',
  '/admin/%61ccounts',
  '/admin/accounts%2Fdisable',
  '/admin/ACCOUNTS',
  '/admin/view',
  '/admin/spool',
  '/admin/observations',
  '/admin',
  '/admin/',
  '/admin/unknown',
  '/admin/me/accounts',
];
const METHODS = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'];

describe('reports mode: authorization', () => {
  it('no identity is 401; a tester is 403 on the report routes; only the owner reads them', async () => {
    const s = await serve();
    for (const path of ['/admin/me', '/admin/reports', '/admin/reports/AAAA-BBBB-CCCC']) {
      expect((await call(await s.gate(null), path)).status, path).toBe(401);
      const t = await call(await s.gate(TESTER), path);
      expect(t.status, path).toBe(403);
      expect(t.body).toEqual({ error: 'forbidden' });
    }
    const o = await s.gate(OWNER);
    expect((await call(o, '/admin/me')).body).toEqual({ owner: true });
    expect((await call(o, '/admin/reports')).body).toEqual({ reports: [] });
    expect((await call(o, '/admin/reports/AAAA-BBBB-CCCC')).status).toBe(404);
    // The owner's address on another account is not the owner (the principal decides).
    expect((await call(await s.gate(TESTER, OWNER.email), '/admin/me')).status).toBe(403);
    // Address only (no subject): no principal, so never the owner. With no access view the host
    // reads no address at all: 401, as for every route.
    expect((await call(await s.gate({ sub: '' } as never, OWNER.email), '/admin/me')).status).toBe(
      401,
    );
  });

  it('every account, request and sessions path is 404 for everyone, the owner included, any method', async () => {
    const s = await serve();
    const users = [await s.gate(OWNER), await s.gate(TESTER), await s.gate(TESTER, OWNER.email)];
    for (const base of users)
      for (const path of ACCOUNT_PATHS)
        for (const method of METHODS) {
          const init =
            method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
              ? { method }
              : mutation(base, method, {
                  email: 'new@example.invalid',
                  target: 't_AAAAAAAAAAAAAAAA',
                });
          const r = await call(base, path, init);
          expect(r.status, `${method} ${path}`).toBe(404);
          if (method !== 'HEAD')
            expect(r.body, `${method} ${path}`).toEqual({ error: 'not_found' });
        }
    // Dot segments as sent on the wire (no client normalization) are no way around it.
    for (const path of ['/admin/./accounts', '/admin/reports/../accounts', '/admin/me/../sessions'])
      expect(await raw(users[0]!, 'GET', path), path).toBe(404);
    // Without an identity every route is 401 (route-independent: no oracle either).
    expect((await call(await s.gate(null), '/admin/accounts')).status).toBe(401);
  });

  it('the 404 does not depend on the owner file: account paths stay 404 when it is broken', async () => {
    const s = await serve();
    rmSync(s.ownerFile);
    const o = await s.gate(OWNER);
    expect((await call(o, '/admin/accounts')).status).toBe(404);
    expect((await call(o, '/admin/sessions')).status).toBe(404);
    expect((await call(o, '/admin/me')).status).toBe(503);
  });

  it('wrong methods on the report routes are 404', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    for (const [method, path] of [
      ['POST', '/admin/me'],
      ['DELETE', '/admin/me'],
      ['PUT', '/admin/reports'],
      ['PATCH', '/admin/reports/AAAA-BBBB-CCCC'],
      ['POST', '/admin/reports'],
      ['HEAD', '/admin/me'],
      ['OPTIONS', '/admin/reports'],
    ] as const) {
      const init = method === 'HEAD' || method === 'OPTIONS' ? { method } : mutation(o, method, {});
      expect((await call(o, path, init)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('forged identity headers change nothing: the gate replaces them, X-Tbi-* are dropped', async () => {
    const s = await serve();
    const t = await s.gate(TESTER);
    for (const headers of [
      { 'x-forwarded-user': OWNER.sub },
      { 'x-forwarded-email': OWNER.email },
      { 'x-tbi-owner': '1', 'x-tbi-principal': P(OWNER) },
      { 'x-tbi-admin-mode': 'full' },
    ]) {
      expect((await call(t, '/admin/me', { headers })).status).toBe(403);
      expect((await call(t, '/admin/reports', { headers })).status).toBe(403);
      expect((await call(t, '/admin/accounts', { headers })).status).toBe(404);
    }
    // Nor a query flag or a body field.
    expect((await call(t, `/admin/me?owner=1&principal=${P(OWNER)}`)).status).toBe(403);
  });
});

describe('reports mode: the owner reference file (fail closed)', () => {
  const broken: [string, (s: Setup) => void][] = [
    ['missing', (s) => rmSync(s.ownerFile)],
    ['empty', (s) => writeFileSync(s.ownerFile, '')],
    ['two principals', (s) => writeFileSync(s.ownerFile, `${P(OWNER)}\n${P(TESTER)}\n`)],
    ['two principals, one line', (s) => writeFileSync(s.ownerFile, `${P(OWNER)} ${P(TESTER)}`)],
    ['not a principal', (s) => writeFileSync(s.ownerFile, 'owner@example.invalid\n')],
    ['a principal too short', (s) => writeFileSync(s.ownerFile, `${P(OWNER).slice(0, 20)}\n`)],
    ['leading space', (s) => writeFileSync(s.ownerFile, ` ${P(OWNER)}\n`)],
    ['two newlines', (s) => writeFileSync(s.ownerFile, `${P(OWNER)}\n\n`)],
    ['CRLF', (s) => writeFileSync(s.ownerFile, `${P(OWNER)}\r\n`)],
    ['mode 0644', (s) => chmodSync(s.ownerFile, 0o644)],
    ['mode 0600', (s) => chmodSync(s.ownerFile, 0o600)],
    ['mode 0660', (s) => chmodSync(s.ownerFile, 0o660)],
    ['mode 2640', (s) => chmodSync(s.ownerFile, 0o2640)],
    ['unreadable (0000)', (s) => chmodSync(s.ownerFile, 0o000)],
    ['a directory', (s) => (rmSync(s.ownerFile), mkdirSync(s.ownerFile, { mode: 0o750 }))],
    [
      'a symlink to a valid file',
      (s) => {
        const real = `${s.ownerFile}.real`;
        writeFileSync(real, `${P(OWNER)}\n`);
        chmodSync(real, 0o640);
        rmSync(s.ownerFile);
        symlinkSync(real, s.ownerFile);
      },
    ],
  ];
  for (const [what, breakIt] of broken)
    it(`${what}: /admin answers 503 for the owner; reports can still be sent`, async () => {
      const s = await serve();
      breakIt(s);
      const o = await s.gate(OWNER);
      for (const path of ['/admin/me', '/admin/reports']) {
        const r = await call(o, path);
        expect(r.status, `${what} ${path}`).toBe(503);
        expect(r.body).toEqual({ error: 'owner_unavailable' });
      }
      expect((await call(o, '/admin/reports/AAAA-BBBB-CCCC', mutation(o, 'DELETE'))).status).toBe(
        503,
      );
      // The rest of the app is unaffected.
      expect((await call(await s.gate(TESTER), '/reports', report('still works'))).status).toBe(
        201,
      );
      expect((await call(await s.gate(TESTER), '/sessions/x')).status).toBe(404);
    });

  it('wrongly owned (another user, another group): 503', async () => {
    for (const ownerExpect of [{ uid: UID + 1 }, { gid: GID + 1 }, { uid: 0, gid: 0 }]) {
      const s = await serve({ ownerExpect });
      expect(
        (await call(await s.gate(OWNER), '/admin/me')).status,
        JSON.stringify(ownerExpect),
      ).toBe(503);
    }
  });

  it('read on every check: replacing the file takes effect at once, without a restart', async () => {
    const s = await serve();
    expect((await call(await s.gate(TESTER), '/admin/me')).status).toBe(403);
    writeFileSync(s.ownerFile, `${P(TESTER)}`); // no newline: also exactly one principal
    expect((await call(await s.gate(TESTER), '/admin/me')).status).toBe(200);
    expect((await call(await s.gate(OWNER), '/admin/me')).status).toBe(403);
  });

  it('the reference is root-owned by default and refuses a relative path', () => {
    expect(new OwnerReference('/etc/x').expect).toEqual({ uid: 0, gid: GID });
    expect(() => new OwnerReference('owner.principal')).toThrow(/absolute/);
  });
});

describe('reports mode: CSRF, reports and what is written', () => {
  it('report delete needs JSON and a same-origin request; then deletes', async () => {
    const s = await serve();
    const id = (await call(await s.gate(TESTER), '/reports', report('one'))).body.id as string;
    const o = await s.gate(OWNER);
    for (const headers of [
      {},
      { 'content-type': 'text/plain', origin: o },
      { 'content-type': 'application/json', origin: 'https://evil.example.invalid' },
      { 'content-type': 'application/json', origin: o, 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'application/json' },
    ]) {
      const r = await call(o, `/admin/reports/${id}`, { method: 'DELETE', headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.body).toEqual({ error: 'csrf' });
    }
    expect(
      (await call(o, `/admin/reports?principal=${P(TESTER)}`, { method: 'DELETE' })).status,
    ).toBe(403);
    expect((await s.store.list()).map((m) => m.id)).toEqual([id]);
    expect((await call(o, `/admin/reports/${id}`, mutation(o, 'DELETE'))).body).toEqual({
      deleted: 1,
    });
  });

  it('list, detail, delete one and delete by tester work for the owner', async () => {
    const s = await serve();
    const t = await s.gate(TESTER);
    const a = (await call(t, '/reports', report('secret one'))).body.id as string;
    await call(t, '/reports', report('secret two'));
    const o = await s.gate(OWNER);
    const list = await call(o, '/admin/reports');
    expect((list.body.reports as unknown[]).length).toBe(2);
    expect(list.text).not.toContain('secret');
    expect((await call(o, `/admin/reports/${a}`)).body.description).toBe('secret one');
    expect((await call(o, `/admin/reports/${a}`, mutation(o, 'DELETE'))).body).toEqual({
      deleted: 1,
    });
    expect(
      (await call(o, `/admin/reports?principal=${P(TESTER)}`, mutation(o, 'DELETE'))).body,
    ).toEqual({
      deleted: 1,
    });
    expect((await call(o, '/admin/reports?principal=../x', mutation(o, 'DELETE'))).status).toBe(
      400,
    );
  });

  it('rate limits apply to the owner as before (429)', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    let last = 0;
    for (let i = 0; i < 25 && last !== 429; i++)
      last = (await call(o, '/admin/reports/AAAA-BBBB-CCCC', mutation(o, 'DELETE'))).status;
    expect(last).toBe(429);
  });

  it('no spool write and no identity observation, whatever the traffic (asserted on the filesystem)', async () => {
    const s = await serve();
    const before = tree(s.root);
    // Every kind of caller, with both gate headers (an observation would be due for each).
    for (const u of [OWNER, TESTER, { sub: '3000000003', email: 'third@example.invalid' }]) {
      const b = await s.gate(u);
      await call(b, '/admin/me');
      await call(b, '/admin/reports');
      await call(b, '/admin/accounts', mutation(b, 'POST', { email: 'new@example.invalid' }));
      await call(
        b,
        '/admin/accounts/disable',
        mutation(b, 'POST', { target: 't_AAAAAAAAAAAAAAAA' }),
      );
      await call(b, '/sessions/none');
    }
    await new Promise((r) => setTimeout(r, 100)); // an observation is written detached
    const after = tree(s.root);
    expect(after.filter((p) => p.startsWith('admin'))).toEqual(
      before.filter((p) => p.startsWith('admin')),
    );
    expect(after.filter((p) => p.startsWith('admin/'))).toEqual([
      'admin/observations',
      'admin/results',
      'admin/spool',
      'admin/view',
    ]);
    // Only the report store and the owner file exist besides.
    expect(after.filter((p) => !p.startsWith('admin'))).toEqual(['owner.principal']);
    // A sent report creates the report store, and only that.
    await call(await s.gate(TESTER), '/reports', report('x'));
    expect(
      tree(s.root)
        .filter((p) => !p.startsWith('admin') && p !== 'owner.principal')
        .every((p) => p.startsWith('reports')),
    ).toBe(true);
  });

  it('an access view does not change the owner: the reference file decides', async () => {
    const s = await serve({ withAccess: true });
    // A view that names the TESTER as its owner: in reports mode it only authorizes requests.
    writeFileSync(
      join(s.root, 'admin', 'view', 'access.json'),
      JSON.stringify({
        v: 1,
        generated: '2026-10-29T00:00:00Z',
        seq: 1,
        owner: { principal: P(TESTER), emailTag: deriveEmailTag(TEST_IDENTITY, TESTER.email) },
        authorized: { principals: [P(OWNER), P(TESTER)], emailTags: [] },
        revoked: { principals: [], emailTags: [] },
      }),
    );
    s.access!.reload();
    expect((await call(await s.gate(OWNER), '/admin/me')).status).toBe(200);
    expect((await call(await s.gate(TESTER), '/admin/me')).status).toBe(403);
    expect((await call(await s.gate(TESTER), '/admin/accounts')).status).toBe(404);
  });
});

describe('reports mode: the environment', () => {
  const env = (e: Record<string, string>) => adminEnvFromEnv(e);
  it('unset is the Sprint 23B rule: full with an access view (or admin dir), off without', () => {
    expect(env({}).mode).toBe('off');
    expect(env({ TBI_ACCESS_VIEW: '/v/access.json' }).mode).toBe('full');
    expect(env({ TBI_ACCESS_VIEW: '/v/access.json', TBI_ADMIN_DIR: '/a' })).toMatchObject({
      mode: 'full',
      observationsDir: '/a/observations',
      ownerFile: null,
    });
    expect(() => env({ TBI_ADMIN_DIR: '/a' })).toThrow('TBI_ADMIN_DIR needs TBI_ACCESS_VIEW');
  });

  it('reports: needs an absolute owner file; refuses TBI_ADMIN_DIR; never a spool', () => {
    expect(env({ TBI_ADMIN_MODE: 'reports', TBI_OWNER_PRINCIPAL_FILE: '/etc/x' })).toEqual({
      mode: 'reports',
      observationsDir: null,
      ownerFile: '/etc/x',
    });
    expect(() => env({ TBI_ADMIN_MODE: 'reports' })).toThrow(/needs TBI_OWNER_PRINCIPAL_FILE/);
    expect(() => env({ TBI_ADMIN_MODE: 'reports', TBI_OWNER_PRINCIPAL_FILE: 'x' })).toThrow(
      /absolute/,
    );
    expect(() =>
      env({
        TBI_ADMIN_MODE: 'reports',
        TBI_OWNER_PRINCIPAL_FILE: '/etc/x',
        TBI_ADMIN_DIR: '/a',
        TBI_ACCESS_VIEW: '/v',
      }),
    ).toThrow(/TBI_ADMIN_DIR is for TBI_ADMIN_MODE=full only/);
  });

  it('Sprint 23C: TBI_OBSERVATIONS_DIR, full mode only; never with TBI_ADMIN_DIR', () => {
    expect(
      env({ TBI_ADMIN_MODE: 'full', TBI_ACCESS_VIEW: '/v', TBI_OBSERVATIONS_DIR: '/o' }),
    ).toEqual({ mode: 'full', observationsDir: '/o', ownerFile: null });
    expect(env({ TBI_ACCESS_VIEW: '/v', TBI_OBSERVATIONS_DIR: '/o' }).mode).toBe('full');
    expect(() =>
      env({
        TBI_ADMIN_MODE: 'reports',
        TBI_OWNER_PRINCIPAL_FILE: '/x',
        TBI_ACCESS_VIEW: '/v',
        TBI_OBSERVATIONS_DIR: '/o',
      }),
    ).toThrow(/TBI_OBSERVATIONS_DIR is for TBI_ADMIN_MODE=full only/);
    expect(() =>
      env({ TBI_ACCESS_VIEW: '/v', TBI_OBSERVATIONS_DIR: '/o', TBI_ADMIN_DIR: '/a' }),
    ).toThrow(/not both/);
    expect(() => env({ TBI_OBSERVATIONS_DIR: '/o' })).toThrow(/needs TBI_ACCESS_VIEW/);
    expect(() =>
      env({ TBI_ADMIN_MODE: 'full', TBI_ACCESS_VIEW: '/v', TBI_OBSERVATIONS_DIR: 'o' }),
    ).toThrow(/absolute/);
    // The feedback-only mode with an access view (enforcement) is allowed, without observations.
    expect(
      env({ TBI_ADMIN_MODE: 'reports', TBI_OWNER_PRINCIPAL_FILE: '/x', TBI_ACCESS_VIEW: '/v' }),
    ).toEqual({ mode: 'reports', observationsDir: null, ownerFile: '/x' });
  });

  it('off and full refuse what they do not use; unknown modes refuse to start', () => {
    expect(() => env({ TBI_ADMIN_MODE: 'off', TBI_ADMIN_DIR: '/a' })).toThrow(/full only/);
    expect(() => env({ TBI_ADMIN_MODE: 'off', TBI_OWNER_PRINCIPAL_FILE: '/x' })).toThrow(
      /reports only/,
    );
    expect(() =>
      env({ TBI_ADMIN_MODE: 'full', TBI_ACCESS_VIEW: '/v', TBI_OWNER_PRINCIPAL_FILE: '/x' }),
    ).toThrow(/reports only/);
    expect(() => env({ TBI_ADMIN_MODE: 'full' })).toThrow(/needs TBI_ACCESS_VIEW/);
    for (const bad of ['on', '1', 'REPORTS', 'reports '])
      expect(() => env({ TBI_ADMIN_MODE: bad }), bad).toThrow(/must be off, reports or full/);
    expect(env({ TBI_ADMIN_MODE: 'off', TBI_ACCESS_VIEW: '/v' }).mode).toBe('off');
  });

  it('off mode: /admin does not exist (404, as RC4), even for the owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tbi-reports-off-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const server = createHttpServer(shared, TEST_IDENTITY, null, { adminMode: 'off' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const g = await startTestGate(
      { host: '127.0.0.1', port: (server.address() as AddressInfo).port },
      TEST_IDENTITY,
      OWNER.sub,
      OWNER.email,
    );
    cleanup.push(g.close);
    for (const path of ['/admin/me', '/admin/reports', '/admin/accounts'])
      expect((await call(g.base, path)).status, path).toBe(404);
  });
});
