/**
 * Sprint 23B, adversarial: access enforcement, revocation of live sessions, the owner's
 * administration API (spool, results, views), identity observations and the extended feedback.
 * Users reach the host through test gates (oauth2-proxy's role: it deletes the client's identity
 * headers and asserts its own subject and address); the helper is played by the test, writing
 * results and views into a temporary directory laid out as /var/lib/tbi-admin.
 */
import {
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
import type { Principal } from '../../identity/principal.js';
import { TEST_IDENTITY, principalFor, startTestGate, ticketFor } from '../../identity/test-gate.js';
import {
  AdminSpool,
  DEFAULT_ADMIN,
  IdentityObserver,
  REQUEST_ID_RE,
  newRequestId,
  normalizeAddEmail,
  parseAccountsView,
  writeSpoolFile,
  type AdminConfig,
  type SpoolIo,
} from '../admin.js';
import { revokeOnReload, type SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import { MAX_COMPONENT_NAME_CHARS, validateReport } from '../reportProtocol.js';
import { DEFAULT_REPORTS, ReportStore } from '../reports.js';
import { createRequest, fakeHost, waitState } from './support.js';

// Gate subjects (Google subjects are decimal) and addresses (example.invalid only).
const OWNER = { sub: '1000000001', email: 'owner@example.invalid' };
const TESTER = { sub: '2000000002', email: 'tester@example.invalid' };
const PENDING = { sub: '4000000004', email: 'pending@example.invalid' }; // no principal recorded yet
const OTHER = { sub: '5000000005', email: 'other@example.invalid' };
const REVOKED = { sub: '3000000003', email: 'revoked@example.invalid' };
const UNKNOWN = { sub: '9000000009', email: 'unknown@example.invalid' };
const P = (u: { sub: string }) => principalFor(u.sub);
const tag = (e: string) => deriveEmailTag(TEST_IDENTITY, e);
const TARGET = 't_AAAAAAAAAAAAAAAA';

interface ViewSpec {
  ownerPrincipal?: Principal | null;
  principals?: Principal[];
  emailTags?: string[];
  revoked?: Principal[];
}
const accessJson = (s: ViewSpec = {}) =>
  JSON.stringify({
    v: 1,
    generated: new Date().toISOString(),
    seq: 1,
    owner: {
      principal: s.ownerPrincipal === undefined ? P(OWNER) : s.ownerPrincipal,
      emailTag: tag(OWNER.email),
    },
    authorized: {
      principals: s.principals ?? [P(OWNER), P(TESTER), P(OTHER)],
      emailTags: s.emailTags ?? [tag(OWNER.email), tag(TESTER.email), tag(PENDING.email)],
    },
    revoked: { principals: s.revoked ?? [P(REVOKED)], emailTags: [tag(REVOKED.email)] },
  });

const accountsJson = () =>
  JSON.stringify({
    v: 1,
    generated: '2026-10-29T10:00:00Z',
    cap: 20,
    authorizedTesters: 2,
    owner: 1,
    accounts: [
      {
        target: 't_OWNERxxxxxxxxxxx',
        masked: 'ow***@example.invalid',
        class: 'owner',
        status: 'authorized',
        dateAdded: '2026-09-25',
        googleIdRecorded: true,
        lastSignIn: '2026-10-29T09:00:00Z',
        statusUpdated: '2026-09-25T10:00:00Z',
      },
      {
        target: TARGET,
        // A helper bug that leaked a full address is hidden, not passed on.
        masked: 'tester@example.invalid',
        class: 'alpha_tester',
        status: 'authorized',
        dateAdded: '2026-10-01',
        googleIdRecorded: false,
        lastSignIn: null,
        statusUpdated: null,
      },
    ],
    warnings: [
      {
        target: TARGET,
        kind: 'identity_mismatch',
        first: '2026-10-28T10:00:00Z',
        last: '2026-10-29T08:00:00Z',
        count: 3,
      },
      { kind: 'Bad Kind <script>' },
    ],
  });

let shared: { host: SessionHost; art: { sha256: string } };
beforeAll(() => {
  shared = fakeHost('normal');
});
afterAll(async () => {
  await shared.host.shutdown();
});
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function adminDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tbi-admin-test-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  for (const sub of ['spool', 'results', 'view', 'observations']) mkdirSync(join(d, sub));
  return d;
}

interface Setup {
  dir: string;
  access: AccessView;
  store: ReportStore;
  lines: string[];
  host: SessionHost;
  gate: (u: { sub: string; email?: string } | null, email?: string | null) => Promise<string>;
  writeView: (s?: ViewSpec) => void;
}

async function serve(
  opts: {
    host?: SessionHost;
    admin?: Partial<AdminConfig> | false;
    io?: SpoolIo;
    view?: ViewSpec | false;
    observerNow?: () => number;
    roomyLimits?: boolean;
  } = {},
): Promise<Setup> {
  const dir = adminDir();
  const file = join(dir, 'view', 'access.json');
  const writeView = (s: ViewSpec = {}) => writeFileSync(file, accessJson(s));
  if (opts.view !== false) writeView(opts.view);
  writeFileSync(join(dir, 'view', 'accounts.json'), accountsJson());
  const access = new AccessView(file, { pollMs: 10_000 });
  access.reload();
  cleanup.push(() => access.stop());
  const lines: string[] = [];
  const store = new ReportStore(
    { ...DEFAULT_REPORTS, dir: join(dir, 'reports') },
    { log: (l) => void lines.push(l) },
  );
  const host = opts.host ?? shared.host;
  const admin =
    opts.admin === false
      ? null
      : new AdminSpool(
          { ...DEFAULT_ADMIN, dir, resultWaitMs: 400, pollMs: 20, ...opts.admin },
          opts.io ? { io: opts.io } : {},
        );
  const observer = new IdentityObserver(join(dir, 'observations'), {
    ...(opts.observerNow ? { now: opts.observerNow } : {}),
  });
  const server: Server = createHttpServer(host, TEST_IDENTITY, store, {
    access,
    admin,
    observer,
    ...(opts.roomyLimits
      ? {
          adminLimits: {
            all: { count: 1000, windowMs: 60_000 },
            write: { count: 1000, windowMs: 60_000 },
          },
        }
      : {}),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  return {
    dir,
    access,
    store,
    lines,
    host,
    writeView,
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

/** A same-origin JSON mutation as the app's fetch sends it. */
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
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
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
  return { status: res.status, body, text, headers: res.headers };
}

const ls = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);

/** The helper's part: answer every spooled request (or leave them, for the timeout case). */
function helperAnswers(dir: string, code = 'done', ok = true) {
  for (const name of ls(join(dir, 'spool')).filter((n) => n.endsWith('.json'))) {
    const req = JSON.parse(readFileSync(join(dir, 'spool', name), 'utf8')) as { id: string };
    writeFileSync(
      join(dir, 'results', `${req.id}.json`),
      JSON.stringify({
        v: 1,
        id: req.id,
        ok,
        code,
        target: TARGET,
        masked: 'ne***@example.invalid',
        backup: 'alpha-allowlist-pre-add-x-20261029T100000Z',
        at: new Date().toISOString(),
      }),
    );
    rmSync(join(dir, 'spool', name));
  }
}

describe('access enforcement (TBI_ACCESS_VIEW)', () => {
  it('health needs nothing, even with no view; every other route needs an authorized account', async () => {
    const s = await serve({ view: false });
    const nobody = await s.gate(null);
    expect((await call(nobody, '/health')).status).toBe(200);
    // Fail closed: no view, no access (any identity).
    const r = await call(await s.gate(OWNER), '/sessions/' + '0'.repeat(32));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'access_view_unavailable' });
    expect((await call(nobody, '/sessions')).status).toBe(401);
  });

  it('owner and testers pass, a pending account passes by its email tag; revoked and unknown are 403', async () => {
    const s = await serve();
    const probe = async (u: { sub: string; email?: string } | null, email?: string | null) =>
      call(await s.gate(u, email), `/sessions/${'0'.repeat(32)}`);
    // Authorized: the route answers on its own terms (no such session).
    expect((await probe(OWNER)).status).toBe(404);
    expect((await probe(TESTER, null)).status).toBe(404); // by principal, no address
    expect((await probe(PENDING)).status).toBe(404); // principal unknown, email tag authorized
    for (const u of [REVOKED, UNKNOWN]) {
      const r = await probe(u);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'account_disabled' });
    }
    // The pending account's subject without its address is not authorized.
    expect((await probe(PENDING, null)).status).toBe(403);
    expect((await probe(null)).status).toBe(401);
  });

  it('forged headers: a client-sent X-Forwarded-Email / X-Forwarded-User / X-Tbi-* changes nothing', async () => {
    const s = await serve();
    // An unknown account claims the owner's address and identity headers: the gate replaces them.
    const r = await call(await s.gate(UNKNOWN), `/admin/me`, {
      headers: {
        'x-forwarded-email': OWNER.email,
        'x-forwarded-user': OWNER.sub,
        'x-tbi-owner': '1',
        'x-tbi-principal': P(OWNER),
      },
    });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'account_disabled' });
    // No gate identity at all but a forged address: still none.
    const n = await call(await s.gate(null), `/admin/me`, {
      headers: { 'x-forwarded-email': OWNER.email },
    });
    expect(n.status).toBe(401);
  });

  it('reloads: an account removed from the view is refused at once (no restart)', async () => {
    const s = await serve();
    const base = await s.gate(TESTER);
    expect((await call(base, `/sessions/${'0'.repeat(32)}`)).status).toBe(404);
    s.writeView({ principals: [P(OWNER)], emailTags: [tag(OWNER.email)] });
    s.access.reload();
    expect((await call(base, `/sessions/${'0'.repeat(32)}`)).status).toBe(403);
    writeFileSync(join(s.dir, 'view', 'access.json'), '{ broken');
    s.access.reload();
    expect((await call(await s.gate(OWNER), `/sessions/${'0'.repeat(32)}`)).status).toBe(503);
  });

  it('without TBI_ACCESS_VIEW nothing changes: any gate identity is served, /admin does not exist', async () => {
    const server = createHttpServer(shared.host, TEST_IDENTITY, null);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const g = await startTestGate(
      { host: '127.0.0.1', port: (server.address() as AddressInfo).port },
      TEST_IDENTITY,
      UNKNOWN.sub,
      UNKNOWN.email,
    );
    cleanup.push(g.close);
    expect((await call(g.base, `/sessions/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await call(g.base, '/admin/me')).status).toBe(404);
  });
});

describe('revocation of live sessions', () => {
  it('ends only the revoked account’s sessions (reason account_disabled) and closes its streams', async () => {
    const { host, art } = fakeHost('normal');
    cleanup.push(() => host.shutdown());
    const s = await serve({ host });
    const lines: string[] = [];
    revokeOnReload(host, s.access, (l) => void lines.push(l));
    const start = async (u: { sub: string; email: string }) => {
      const base = await s.gate(u);
      const created = await call(
        base,
        '/sessions',
        mutation(base, 'POST', createRequest(art.sha256, { ticket: ticketFor(art.sha256, P(u)) })),
      );
      expect(created.status).toBe(201);
      const { sessionId, token } = created.body as { sessionId: string; token: string };
      const auth = { authorization: `Bearer ${token}` };
      expect(
        (await call(base, `/sessions/${sessionId}/run`, { method: 'POST', headers: auth })).status,
      ).toBe(202);
      const found = host.get(sessionId, token, P(u));
      if (!found.ok) throw new Error('no session');
      await waitState(found.value, 'running');
      // An open event stream.
      const res = await fetch(`${base}/sessions/${sessionId}/events`, { headers: auth });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const ended = (async () => {
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) return true;
          }
        } catch {
          return false; // cut at teardown
        }
      })();
      return { session: found.value, ended, base, auth, sessionId };
    };
    const tester = await start(TESTER);
    const other = await start(OTHER);
    const pending = await start(PENDING);
    expect(tester.session.emailTag).toBe(tag(TESTER.email));
    expect(pending.session.emailTag).toBe(tag(PENDING.email));

    // The owner disables TESTER: principal and email tag both leave the view.
    s.writeView({
      principals: [P(OWNER), P(OTHER)],
      emailTags: [tag(OWNER.email), tag(PENDING.email)],
      revoked: [P(REVOKED), P(TESTER)],
    });
    s.access.reload();
    await waitState(tester.session, 'ended');
    expect(tester.session.status().reason).toBe('account_disabled');
    expect(await tester.ended).toBe(true); // its stream is closed
    expect(tester.session.streams).toBe(0);
    // Nobody else is touched.
    expect(other.session.state).toBe('running');
    expect(pending.session.state).toBe('running');
    expect(lines).toEqual([JSON.stringify({ event: 'access_revoked', sessions: 1 })]);
    // Its requests are refused from now on.
    const again = await call(tester.base, `/sessions/${tester.sessionId}`, {
      headers: tester.auth,
    });
    expect(again.status).toBe(403);

    // A session admitted by its email tag only ends when that tag leaves the view.
    s.writeView({ principals: [P(OWNER), P(OTHER)], emailTags: [tag(OWNER.email)] });
    s.access.reload();
    await waitState(pending.session, 'ended');
    expect(pending.session.status().reason).toBe('account_disabled');
    expect(await pending.ended).toBe(true);
    expect(other.session.state).toBe('running');
    // A reload with nothing to revoke ends nothing and logs nothing.
    s.access.reload();
    expect(other.session.state).toBe('running');
    expect(lines).toHaveLength(2);
    await host.terminate(other.session);
  });
});

describe('admin API: authorization', () => {
  it('only the owner: 401 without identity, 403 for testers, pending, revoked, unknown; decided per call', async () => {
    const s = await serve();
    const paths = ['/admin/me', '/admin/accounts', '/admin/sessions', '/admin/reports'];
    for (const path of paths) {
      expect((await call(await s.gate(null), path)).status, path).toBe(401);
      for (const u of [TESTER, PENDING, OTHER]) {
        const r = await call(await s.gate(u), path);
        expect(r.status, `${path} ${u.sub}`).toBe(403);
        expect(r.body).toEqual({ error: 'forbidden' });
      }
      for (const u of [REVOKED, UNKNOWN])
        expect((await call(await s.gate(u), path)).status).toBe(403);
      expect((await call(await s.gate(OWNER), path)).status, path).toBe(200);
    }
    // Mutations by a tester never reach the spool, even when well formed and same-origin.
    const t = await s.gate(TESTER);
    expect(
      (await call(t, '/admin/accounts', mutation(t, 'POST', { email: 'x@example.invalid' })))
        .status,
    ).toBe(403);
    expect(
      (await call(t, '/admin/accounts/disable', mutation(t, 'POST', { target: TARGET }))).status,
    ).toBe(403);
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
  });

  it('the owner by email tag only while no owner principal is recorded; the owner address on another account is not the owner', async () => {
    const s = await serve();
    // OTHER signs in with the owner's address (an address reassigned at the provider).
    expect((await call(await s.gate(OTHER, OWNER.email), '/admin/me')).status).toBe(403);
    // OWNER's subject with no address is still the owner (by principal).
    expect((await call(await s.gate(OWNER, null), '/admin/me')).status).toBe(200);
    s.writeView({ ownerPrincipal: null, principals: [P(TESTER)] });
    s.access.reload();
    // First sign-in of the owner, before the helper recorded its Google id: by email tag.
    expect((await call(await s.gate(OWNER), '/admin/me')).status).toBe(200);
    expect((await call(await s.gate(TESTER), '/admin/me')).status).toBe(403);
    // The owner principal is then whoever presents the owner's address; once recorded, only it.
    s.writeView({ ownerPrincipal: P(OWNER) });
    s.access.reload();
    expect((await call(await s.gate(TESTER, OWNER.email), '/admin/me')).status).toBe(403);
  });

  it('a client cannot claim ownership with body fields or query flags', async () => {
    const s = await serve();
    const t = await s.gate(TESTER);
    expect((await call(t, '/admin/me?owner=1')).status).toBe(403);
    const r = await call(
      t,
      '/admin/accounts',
      mutation(t, 'POST', { email: 'x@example.invalid', actor: P(OWNER), owner: true }),
    );
    expect(r.status).toBe(403);
  });
});

describe('admin API: CSRF, rate limit, input', () => {
  it('a mutation needs JSON and a same-origin request', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    const body = JSON.stringify({ email: 'new@example.invalid' });
    const tries: [string, Record<string, string>][] = [
      ['no content type', { origin: o }],
      ['form type', { 'content-type': 'application/x-www-form-urlencoded', origin: o }],
      ['text type', { 'content-type': 'text/plain', origin: o }],
      [
        'cross origin',
        { 'content-type': 'application/json', origin: 'https://evil.example.invalid' },
      ],
      ['null origin', { 'content-type': 'application/json', origin: 'null' }],
      ['no origin, no fetch site', { 'content-type': 'application/json' }],
      [
        'cross-site fetch with a matching origin',
        { 'content-type': 'application/json', origin: o, 'sec-fetch-site': 'cross-site' },
      ],
      [
        'same-site (another subdomain)',
        { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' },
      ],
    ];
    for (const [what, headers] of tries) {
      const r = await call(o, '/admin/accounts', { method: 'POST', headers, body });
      expect(r.status, what).toBe(403);
      expect(r.body, what).toEqual({ error: 'csrf' });
    }
    // DELETE is a mutation too.
    expect((await call(o, `/admin/reports/AAAA-BBBB-CCCC`, { method: 'DELETE' })).status).toBe(403);
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
    // Same-origin by Sec-Fetch-Site alone (no Origin) is accepted.
    const ok = await call(o, '/admin/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body,
    });
    expect(ok.status).toBe(202); // accepted, no helper running
  });

  it('per-caller rate limit on mutations (429 + Retry-After), the owner’s reads unaffected by testers', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    for (let i = 0; i < 20; i++)
      expect(
        (await call(o, '/admin/accounts/disable', mutation(o, 'POST', { target: 'bad' }))).status,
      ).toBe(400);
    const r = await call(o, '/admin/accounts/disable', mutation(o, 'POST', { target: TARGET }));
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('rate_limited');
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
  });

  it('malformed and injection inputs are refused and never reach the spool', async () => {
    const s = await serve({ roomyLimits: true });
    const o = await s.gate(OWNER);
    const add = (body: unknown) => call(o, '/admin/accounts', mutation(o, 'POST', body));
    for (const email of [
      '',
      'not-an-address',
      'a@b',
      'a@@example.invalid',
      '.a@example.invalid',
      'a..b@example.invalid',
      'a@.example.invalid',
      'a b@example.invalid',
      'a@example.invalid\n{"action":"disable"}',
      'a@example.invalid","action":"disable',
      '"quoted"@example.invalid',
      'ä@example.invalid',
      `${'a'.repeat(65)}@example.invalid`,
      `a@${'b'.repeat(250)}.invalid`,
      '../../etc/passwd@example.invalid',
      42,
      null,
      ['a@example.invalid'],
    ])
      expect((await add({ email })).status, JSON.stringify(email)).toBe(400);
    expect((await add({ email: 'a@example.invalid', extra: 1 })).status).toBe(400);
    expect((await add('[]')).status).toBe(400);
    expect((await add('{"email":')).status).toBe(400);
    expect((await add({ email: `${'a'.repeat(1100)}@example.invalid` })).status).toBe(413);
    for (const target of [
      't_short',
      't_AAAAAAAAAAAAAAAA/../x',
      'x_AAAAAAAAAAAAAAAA',
      'tester@example.invalid',
    ])
      expect(
        (await call(o, '/admin/accounts/disable', mutation(o, 'POST', { target }))).status,
      ).toBe(400);
    expect(
      (
        await call(
          o,
          '/admin/accounts/reactivate',
          mutation(o, 'POST', { target: TARGET, email: 'a@example.invalid' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await call(o, '/admin/accounts/delete', mutation(o, 'POST', { target: TARGET }))).status,
    ).toBe(404);
    expect((await call(o, '/admin/requests/..%2F..%2Fview%2Faccess')).status).toBe(404);
    expect((await call(o, '/admin/requests/' + 'Z'.repeat(26))).status).toBe(404); // unknown id
    expect((await call(o, '/admin/reports/..%2Fx')).status).toBe(404);
    expect((await call(o, '/admin/reports?principal=../x', mutation(o, 'DELETE'))).status).toBe(
      400,
    );
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
    expect(normalizeAddEmail(' New.Tester+x@example.invalid ')).toBe(
      'new.tester+x@example.invalid',
    );
  });
});

describe('admin API: accounts, spool and results', () => {
  it('lists the masked accounts and the capacity; full addresses never leave the host', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    const r = await call(o, '/admin/accounts');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cap: 20, authorizedTesters: 2, owner: 1 });
    const accounts = r.body.accounts as { masked: string; lastSignIn: string | null }[];
    expect(accounts.map((a) => a.masked)).toEqual(['ow***@example.invalid', '***']);
    expect(r.text).not.toContain('tester@example.invalid');
    expect(accounts[1]!.lastSignIn).toBeNull();
    expect(r.body.warnings).toEqual([
      {
        target: TARGET,
        kind: 'identity_mismatch',
        first: '2026-10-28T10:00:00Z',
        last: '2026-10-29T08:00:00Z',
        count: 3,
      },
    ]);
    const sessions = await call(o, '/admin/sessions');
    expect(sessions.body).toEqual(s.host.capacity());
    expect(Object.keys(sessions.body).sort()).toEqual(['live', 'max']);
    // An unusable view is 503, never a partial list.
    writeFileSync(join(s.dir, 'view', 'accounts.json'), '{"v":1,"accounts":[{}]}');
    expect((await call(o, '/admin/accounts')).status).toBe(503);
    expect(
      parseAccountsView('{"v":1,"cap":20,"authorizedTesters":0,"owner":1,"accounts":[]}'),
    ).not.toBeNull();
  });

  it('add: an atomic 0600 spool file in the exact format, then the helper’s result (200)', async () => {
    const s = await serve({ admin: { resultWaitMs: 3000 } });
    const o = await s.gate(OWNER);
    const pendingCall = call(
      o,
      '/admin/accounts',
      mutation(o, 'POST', { email: ' NEW@example.invalid ' }),
    );
    // The helper sees exactly one finished request (no temporary file), owned by the host, 0600.
    let names: string[] = [];
    for (let i = 0; i < 100 && !names.length; i++) {
      names = ls(join(s.dir, 'spool'));
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.json$/);
    const path = join(s.dir, 'spool', names[0]!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(path).size).toBeLessThan(4096);
    const req = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(req)).toEqual(['v', 'id', 'at', 'actor', 'action', 'email']);
    expect(req).toMatchObject({
      v: 1,
      actor: P(OWNER),
      action: 'add',
      email: 'new@example.invalid',
    });
    expect(`${req.id as string}.json`).toBe(names[0]);
    expect(Number.isFinite(Date.parse(req.at as string))).toBe(true);
    helperAnswers(s.dir);
    const r = await pendingCall;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      code: 'done',
      target: TARGET,
      masked: 'ne***@example.invalid',
    });
    // The answer carries no address (the owner's screen keeps what was typed).
    expect(r.text).not.toContain('new@example.invalid');
  });

  it('disable / reactivate carry the target and never an address; a refusal is 409 with its code', async () => {
    const s = await serve({ admin: { resultWaitMs: 3000 } });
    const o = await s.gate(OWNER);
    for (const action of ['disable', 'reactivate'] as const) {
      const p = call(o, `/admin/accounts/${action}`, mutation(o, 'POST', { target: TARGET }));
      let names: string[] = [];
      while (!names.length) {
        names = ls(join(s.dir, 'spool'));
        await new Promise((r) => setTimeout(r, 10));
      }
      const req = JSON.parse(readFileSync(join(s.dir, 'spool', names[0]!), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(Object.keys(req)).toEqual(['v', 'id', 'at', 'actor', 'action', 'target']);
      expect(req).toMatchObject({ action, target: TARGET, actor: P(OWNER) });
      helperAnswers(s.dir, action === 'disable' ? 'last_owner' : 'cap_reached', false);
      const r = await p;
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({
        ok: false,
        code: action === 'disable' ? 'last_owner' : 'cap_reached',
      });
    }
  });

  it('result timeout: 202 with the request id, then the result by GET once the helper answers', async () => {
    const s = await serve({ admin: { resultWaitMs: 150 } });
    const o = await s.gate(OWNER);
    const r = await call(
      o,
      '/admin/accounts',
      mutation(o, 'POST', { email: 'late@example.invalid' }),
    );
    expect(r.status).toBe(202);
    const id = r.body.id as string;
    expect(id).toMatch(REQUEST_ID_RE);
    expect(r.body).toEqual({ id, pending: true, result: `requests/${id}` });
    expect((await call(o, `/admin/requests/${id}`)).status).toBe(202);
    // Only the owner may read it.
    expect((await call(await s.gate(TESTER), `/admin/requests/${id}`)).status).toBe(403);
    helperAnswers(s.dir);
    const done = await call(o, `/admin/requests/${id}`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id, ok: true, code: 'done' });
    // A malformed result file is not a result.
    writeFileSync(join(s.dir, 'results', `${id}.json`), '{"v":1}');
    expect((await call(o, `/admin/requests/${id}`)).status).toBe(404);
  });

  it('spool failures are 503 and leave nothing; the spool file is never half-written', async () => {
    const failing: SpoolIo = { syncFile: () => Promise.reject(new Error('EIO')) };
    const s = await serve({ io: failing });
    const o = await s.gate(OWNER);
    const r = await call(
      o,
      '/admin/accounts',
      mutation(o, 'POST', { email: 'new@example.invalid' }),
    );
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'spool_unavailable' });
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
    // Exclusive creation: an existing temporary file of the same id is never overwritten.
    const d = adminDir();
    const id = newRequestId();
    writeFileSync(join(d, 'spool', `${id}.tmp`), 'someone else');
    await expect(writeSpoolFile(join(d, 'spool'), id, '{}')).rejects.toThrow();
    expect(readFileSync(join(d, 'spool', `${id}.tmp`), 'utf8')).toBe('someone else');
    await expect(writeSpoolFile(join(d, 'spool'), '../x', '{}')).rejects.toThrow('bad id');
  });

  it('a forbidden while the owner’s Google id is unrecorded says so (ownerIdentityPending)', async () => {
    const s = await serve({ view: { ownerPrincipal: null }, admin: { resultWaitMs: 3000 } });
    const o = await s.gate(OWNER); // recognised by the owner email tag
    const p = call(o, '/admin/accounts/disable', mutation(o, 'POST', { target: TARGET }));
    while (!ls(join(s.dir, 'spool')).length) await new Promise((r) => setTimeout(r, 10));
    helperAnswers(s.dir, 'forbidden', false);
    const r = await p;
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'forbidden', ownerIdentityPending: true });
    // Once the owner principal is recorded, a forbidden is just forbidden.
    s.writeView({ ownerPrincipal: P(OWNER) });
    s.access.reload();
    const p2 = call(o, '/admin/accounts/disable', mutation(o, 'POST', { target: TARGET }));
    while (!ls(join(s.dir, 'spool')).length) await new Promise((r) => setTimeout(r, 10));
    helperAnswers(s.dir, 'forbidden', false);
    expect((await p2).body.ownerIdentityPending).toBeUndefined();
  });

  it('a mutation needs the gate principal (an address alone names no actor)', async () => {
    const s = await serve({ view: { ownerPrincipal: null } });
    const o = await s.gate(null, OWNER.email);
    expect((await call(o, '/admin/me')).status).toBe(200);
    const r = await call(
      o,
      '/admin/accounts',
      mutation(o, 'POST', { email: 'new@example.invalid' }),
    );
    expect(r.status).toBe(401);
  });

  it('no admin directory: the API answers 503 for accounts, the rest still works', async () => {
    const s = await serve({ admin: false });
    const o = await s.gate(OWNER);
    expect((await call(o, '/admin/accounts')).status).toBe(503);
    expect((await call(o, '/admin/me')).status).toBe(200);
  });
});

describe('identity observations', () => {
  it('one atomic 0600 file per principal per hour, only with both headers; never slows or fails a request', async () => {
    let now = Date.parse('2026-10-29T10:00:00Z');
    const s = await serve({ observerNow: () => now });
    const obs = join(s.dir, 'observations');
    const waitFiles = async (n: number) => {
      for (let i = 0; i < 100 && ls(obs).length < n; i++)
        await new Promise((r) => setTimeout(r, 10));
      return ls(obs);
    };
    const t = await s.gate(TESTER);
    await call(t, '/health'); // health: no identity processing
    expect(ls(obs)).toEqual([]);
    for (let i = 0; i < 3; i++) await call(t, `/sessions/${'0'.repeat(32)}`);
    const files = await waitFiles(1);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.json$/);
    expect(statSync(join(obs, files[0]!)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(obs, files[0]!), 'utf8'))).toEqual({
      v: 1,
      at: '2026-10-29T10:00:00.000Z',
      sub: TESTER.sub,
      email: TESTER.email,
    });
    // Without the address: nothing.
    await call(await s.gate(OWNER, null), `/sessions/${'0'.repeat(32)}`);
    // Another principal: its own file. An hour later: the same principal again.
    await call(await s.gate(OTHER), `/sessions/${'0'.repeat(32)}`);
    expect(await waitFiles(2)).toHaveLength(2);
    now += 3600_000;
    await call(t, `/sessions/${'0'.repeat(32)}`);
    expect(await waitFiles(3)).toHaveLength(3);
    // A broken observations directory changes no answer.
    rmSync(obs, { recursive: true });
    now += 3600_000;
    expect((await call(t, `/sessions/${'0'.repeat(32)}`)).status).toBe(404);
  });

  it('non-decimal subjects are never observed; a stalled disk bounds the writes in flight', async () => {
    const d = adminDir();
    const never: SpoolIo = { syncFile: () => new Promise(() => undefined) };
    const o = new IdentityObserver(join(d, 'observations'), { io: never, maxPending: 2 });
    expect(o.observe(principalFor('x'), 'user-a', 'a@example.invalid')).toBeNull();
    expect(o.observe(principalFor('1'), '1', 'a@example.invalid')).not.toBeNull();
    expect(o.observe(principalFor('2'), '2', 'b@example.invalid')).not.toBeNull();
    expect(o.observe(principalFor('3'), '3', 'c@example.invalid')).toBeNull();
    expect(o.inFlight).toBe(2);
  });
});

describe('feedback (problem_report v2)', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    description: 'Please add a rotary encoder.',
    category: 'other',
    blocking: false,
    locale: 'en',
    view: 'editor',
    ...over,
  });
  const post = (base: string, b: unknown) =>
    call(base, '/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });

  it('every kind is accepted; the line says kind and whether a component was named, never the text or the name', async () => {
    const s = await serve();
    const t = await s.gate(TESTER);
    for (const kind of ['component', 'feature', 'general']) {
      const r = await post(
        t,
        body({ kind, ...(kind === 'component' ? { component: 'KY-040 encoder' } : {}) }),
      );
      expect(r.status, kind).toBe(201);
    }
    expect((await post(t, body({ category: 'simulation' }))).status).toBe(201); // RC4 client: a bug report
    const notes = s.lines
      .filter((l) => l.includes('"problem_report"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(notes.map((n) => [n.v, n.kind, n.category, n.component])).toEqual([
      [2, 'component', 'other', true],
      [2, 'feature', 'other', false],
      [2, 'general', 'other', false],
      [2, 'bug', 'simulation', false],
    ]);
    for (const l of s.lines) {
      expect(l).not.toContain('encoder');
      expect(l).not.toContain('KY-040');
      expect(l).not.toContain(TESTER.email);
    }
    const list = await s.store.list();
    const component = list.find((m) => m.kind === 'component')!;
    const rec = await s.store.get(component.id);
    expect(rec).toMatchObject({
      kind: 'component',
      component: 'KY-040 encoder',
      principal: P(TESTER),
    });
  });

  it('kind rules, the component name limit and the context are validated; RC4 limits unchanged', async () => {
    const s = await serve();
    const t = await s.gate(TESTER);
    expect((await post(t, body({ kind: 'feature', category: 'build' }))).status).toBe(400);
    expect((await post(t, body({ kind: 'bug', category: 'other', component: 'x' }))).status).toBe(
      400,
    );
    expect((await post(t, body({ kind: 'praise' }))).status).toBe(400);
    expect(
      (
        await post(
          t,
          body({ kind: 'component', component: 'x'.repeat(MAX_COMPONENT_NAME_CHARS + 1) }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await post(t, body({ kind: 'component', component: 'x'.repeat(MAX_COMPONENT_NAME_CHARS) })))
        .status,
    ).toBe(201);
    expect((await post(t, body({ description: 'x'.repeat(1001), kind: 'general' }))).status).toBe(
      400,
    );
    for (const context of [
      { runtime: '1.0 ; rm -rf' },
      { device: 'iPhone 15' },
      { projectId: '../etc' },
      { project: { name: 'mine' } },
      { logs: 'serial' },
      'desktop',
    ])
      expect(
        (await post(t, body({ kind: 'general', context }))).status,
        JSON.stringify(context),
      ).toBe(400);
    const ok = await post(
      t,
      body({
        kind: 'general',
        context: { runtime: '0.23.0', device: 'tablet', projectId: 'prj_abc123' },
      }),
    );
    expect(ok.status).toBe(201);
    expect((await s.store.get(ok.body.id as string))?.context).toEqual({
      runtime: '0.23.0',
      device: 'tablet',
      projectId: 'prj_abc123',
    });
    // Multi-line names are kept on one line.
    const v = validateReport(body({ kind: 'component', component: ' Rotary\n\tencoder ' }));
    expect(v.ok && v.value.component).toBe('Rotary encoder');
    // An empty name is no name.
    const e = validateReport(body({ kind: 'component', component: '   ' }));
    expect(e.ok && e.value.component).toBeUndefined();
  });

  it('the reporter is the gate’s principal; a disabled account cannot send', async () => {
    const s = await serve();
    const r = await post(await s.gate(TESTER), body({ kind: 'general', principal: P(OWNER) }));
    expect(r.status).toBe(400);
    const ok = await call(await s.gate(TESTER), '/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-user': OWNER.sub },
      body: JSON.stringify(body({ kind: 'general' })),
    });
    expect((await s.store.get(ok.body.id as string))?.principal).toBe(P(TESTER));
    expect((await post(await s.gate(REVOKED), body({ kind: 'general' }))).status).toBe(403);
  });
});

describe('admin API: reports', () => {
  it('list (metadata only), detail, delete one and delete by tester: owner only', async () => {
    const s = await serve();
    const send = async (u: { sub: string; email: string }, description: string) =>
      (
        await call(await s.gate(u), '/reports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            description,
            category: 'other',
            blocking: false,
            locale: 'he',
            view: 'home',
            kind: 'general',
          }),
        })
      ).body.id as string;
    const a1 = await send(TESTER, 'secret words one');
    await send(TESTER, 'secret words two');
    const b1 = await send(OTHER, 'from another tester');
    const o = await s.gate(OWNER);
    const t = await s.gate(TESTER);
    // Testers can read nothing, not even their own.
    expect((await call(t, '/admin/reports')).status).toBe(403);
    expect((await call(t, `/admin/reports/${a1}`)).status).toBe(403);
    expect((await call(t, `/admin/reports/${a1}`, mutation(t, 'DELETE'))).status).toBe(403);
    const list = await call(o, '/admin/reports');
    expect(list.status).toBe(200);
    const reports = list.body.reports as {
      id: string;
      principal: string;
      kind: string;
      length: number;
    }[];
    expect(reports).toHaveLength(3);
    expect(list.text).not.toContain('secret');
    expect(reports.find((r) => r.id === a1)).toMatchObject({
      kind: 'general',
      principal: P(TESTER),
      length: 16,
    });
    const detail = await call(o, `/admin/reports/${a1}`);
    expect(detail.body.description).toBe('secret words one');
    expect((await call(o, '/admin/reports/AAAA-AAAA-AAAA')).status).toBe(404);
    expect((await call(o, `/admin/reports/${b1}`, mutation(o, 'DELETE'))).body).toEqual({
      deleted: 1,
    });
    expect((await call(o, `/admin/reports/${b1}`, mutation(o, 'DELETE'))).status).toBe(404);
    const byTester = await call(o, `/admin/reports?principal=${P(TESTER)}`, mutation(o, 'DELETE'));
    expect(byTester.body).toEqual({ deleted: 2 });
    expect(await s.store.list()).toEqual([]);
  });
});
