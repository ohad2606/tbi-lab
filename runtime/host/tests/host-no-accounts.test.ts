/**
 * Sprint 23C (D1): the Session Host has no account administration in any mode, and never writes
 * the root helper's spool. Account administration lives in the dedicated admin service
 * (runtime/admin); the Session Host keeps the owner's report routes and, in `full` mode, the
 * identity observations (their own directory and group).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccessView, deriveEmailTag } from '../../identity/access.js';
import { TEST_IDENTITY, principalFor, startTestGate } from '../../identity/test-gate.js';
import { IdentityObserver, type AdminMode } from '../admin.js';
import type { SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import { OwnerReference } from '../owner.js';
import { DEFAULT_REPORTS, ReportStore } from '../reports.js';
import { fakeHost } from './support.js';

const OWNER = { sub: '1000000001', email: 'owner@example.invalid' };
const TESTER = { sub: '2000000002', email: 'tester@example.invalid' };
const P = (u: { sub: string }) => principalFor(u.sub);

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

const ls = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);

async function serve(mode: AdminMode) {
  const root = mkdtempSync(join(tmpdir(), 'tbi-host-boundary-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'admin');
  for (const sub of ['spool', 'results', 'view', 'observations'])
    mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(
    join(dir, 'view', 'access.json'),
    JSON.stringify({
      v: 1,
      generated: '2026-10-29T00:00:00Z',
      seq: 1,
      owner: { principal: P(OWNER), emailTag: deriveEmailTag(TEST_IDENTITY, OWNER.email) },
      authorized: { principals: [P(OWNER), P(TESTER)], emailTags: [] },
      revoked: { principals: [], emailTags: [] },
    }),
  );
  writeFileSync(
    join(dir, 'view', 'accounts.json'),
    '{"v":1,"cap":20,"authorizedTesters":0,"owner":1,"accounts":[]}',
  );
  const ownerFile = join(root, 'owner.principal');
  writeFileSync(ownerFile, `${P(OWNER)}\n`);
  chmodSync(ownerFile, 0o640);
  const access = mode === 'full' ? new AccessView(join(dir, 'view', 'access.json')) : null;
  access?.reload();
  cleanup.push(() => access?.stop());
  const server: Server = createHttpServer(
    shared,
    TEST_IDENTITY,
    new ReportStore({ ...DEFAULT_REPORTS, dir: join(root, 'reports') }, { log: () => undefined }),
    {
      adminMode: mode,
      access,
      owner:
        mode === 'reports'
          ? new OwnerReference(ownerFile, { uid: process.getuid!(), gid: process.getgid!() })
          : null,
      observer: mode === 'full' ? new IdentityObserver(join(dir, 'observations')) : null,
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  return {
    dir,
    gate: async (u: { sub: string; email: string }) => {
      const g = await startTestGate(target, TEST_IDENTITY, u.sub, u.email);
      cleanup.push(g.close);
      return g.base;
    },
  };
}

const ACCOUNT_PATHS = [
  '/admin/accounts',
  '/admin/accounts/disable',
  '/admin/accounts/reactivate',
  `/admin/requests/${'0'.repeat(26)}`,
  '/admin/sessions',
];

describe('Session Host: no account administration, never the spool (D1)', () => {
  for (const mode of ['off', 'reports', 'full'] as const)
    it(`${mode}: every account, request and sessions path is 404 for the owner, any method; the spool stays empty`, async () => {
      const s = await serve(mode);
      const o = await s.gate(OWNER);
      for (const path of ACCOUNT_PATHS)
        for (const method of ['GET', 'POST', 'DELETE', 'PUT', 'PATCH']) {
          const init =
            method === 'GET'
              ? {}
              : {
                  method,
                  headers: {
                    'content-type': 'application/json',
                    origin: o,
                    'sec-fetch-site': 'same-origin',
                  },
                  body: JSON.stringify({
                    email: 'new@example.invalid',
                    target: 't_AAAAAAAAAAAAAAAA',
                  }),
                };
          const r = await fetch(`${o}${path}`, init);
          expect(r.status, `${mode} ${method} ${path}`).toBe(404);
        }
      // The owner's own routes exist exactly where the mode says.
      expect((await fetch(`${o}/admin/me`)).status).toBe(mode === 'off' ? 404 : 200);
      await new Promise((r) => setTimeout(r, 50));
      expect(ls(join(s.dir, 'spool'))).toEqual([]);
      expect(ls(join(s.dir, 'results'))).toEqual([]);
    });

  it('full: identity observations go to observations/ only (0640), never to the spool', async () => {
    const s = await serve('full');
    await fetch(`${await s.gate(TESTER)}/sessions/${'0'.repeat(32)}`);
    let files: string[] = [];
    for (let i = 0; i < 100 && !files.length; i++) {
      files = ls(join(s.dir, 'observations')).filter((n) => n.endsWith('.json'));
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(files).toHaveLength(1);
    expect(statSync(join(s.dir, 'observations', files[0]!)).mode & 0o777).toBe(0o640);
    expect(JSON.parse(readFileSync(join(s.dir, 'observations', files[0]!), 'utf8'))).toMatchObject({
      sub: TESTER.sub,
    });
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
  });

  it('no Session Host module can write a spool request: the account code is not imported', () => {
    const dir = new URL('../', import.meta.url).pathname;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/from '\.\.\/admin\/accounts\.js'/);
      expect(text, name).not.toMatch(/AdminSpool|'spool'/);
    }
  });
});
