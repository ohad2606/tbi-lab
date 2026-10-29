/**
 * Sprint 23C, adversarial: the dedicated admin service (runtime/admin), the owner's ACCOUNT
 * administration moved out of the Session Host (D1), with its s23b boundary tests moved here:
 * authorization (the access view's owner, deny wins), CSRF, rate limits, input validation, the
 * spool format, mode and atomicity, results, the masked accounts view and the capacity. Users
 * reach the service through test gates (oauth2-proxy's role); the helper is played by the test,
 * writing results and views into a temporary directory laid out as /var/lib/tbi-admin.
 */
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessView, deriveEmailTag } from '../../identity/access.js';
import type { Principal } from '../../identity/principal.js';
import { TEST_IDENTITY, principalFor, startTestGate } from '../../identity/test-gate.js';
import {
  AdminSpool,
  DEFAULT_ADMIN,
  createAdminServer,
  normalizeAddEmail,
  parseAccountsView,
  type AdminConfig,
} from '../accounts.js';
import { REQUEST_ID_RE, newRequestId, writeSpoolFile, type SpoolIo } from '../common.js';

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
  revokedTags?: string[];
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
    revoked: {
      principals: s.revoked ?? [P(REVOKED)],
      emailTags: s.revokedTags ?? [tag(REVOKED.email)],
    },
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

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function adminDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tbi-admin-test-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  for (const sub of ['spool', 'results', 'view']) mkdirSync(join(d, sub));
  return d;
}

const CAPACITY = { live: 2, max: 6 };

interface Setup {
  dir: string;
  access: AccessView;
  gate: (u: { sub: string; email?: string } | null, email?: string | null) => Promise<string>;
  writeView: (s?: ViewSpec) => void;
  setCapacity: (c: { live: number; max: number } | null) => void;
}

async function serve(
  opts: {
    admin?: Partial<AdminConfig> | false;
    io?: SpoolIo;
    view?: ViewSpec | false;
    roomyLimits?: boolean;
    limits?: {
      all: { count: number; windowMs: number };
      write: { count: number; windowMs: number };
    };
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
  const admin =
    opts.admin === false
      ? null
      : new AdminSpool(
          { ...DEFAULT_ADMIN, dir, resultWaitMs: 400, pollMs: 20, ...opts.admin },
          opts.io ? { io: opts.io } : {},
        );
  let capacity: { live: number; max: number } | null = CAPACITY;
  const server: Server = createAdminServer(TEST_IDENTITY, {
    access,
    spool: admin,
    capacity: async () => capacity,
    ...(opts.limits
      ? { limits: opts.limits }
      : opts.roomyLimits
        ? {
            limits: {
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
    writeView,
    setCapacity: (c) => void (capacity = c),
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
/** Finished entries only: the helper ignores `*.tmp` (a write in progress). */
const done = (d: string) => ls(d).filter((n) => n.endsWith('.json'));

/** The helper's part: answer every spooled request (or leave them, for the timeout case). */
function helperAnswers(dir: string, code = 'done', ok = true) {
  for (const name of ls(join(dir, 'spool')).filter((n) => n.endsWith('.json'))) {
    const req = JSON.parse(readFileSync(join(dir, 'spool', name), 'utf8')) as { id: string };
    // Atomic, as the helper writes it: the host never reads a half-written result.
    const tmp = join(dir, 'results', `.${req.id}.tmp`);
    writeFileSync(
      tmp,
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
    renameSync(tmp, join(dir, 'results', `${req.id}.json`));
    rmSync(join(dir, 'spool', name));
  }
}

describe('admin service: authorization', () => {
  it('only the owner: 401 without identity, 403 for testers, pending, revoked, unknown; decided per call', async () => {
    const s = await serve();
    const paths = ['/accounts', '/sessions'];
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
      (await call(t, '/accounts', mutation(t, 'POST', { email: 'x@example.invalid' }))).status,
    ).toBe(403);
    expect(
      (await call(t, '/accounts/disable', mutation(t, 'POST', { target: TARGET }))).status,
    ).toBe(403);
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
  });

  it('the owner by email tag only while no owner principal is recorded; the owner address on another account is not the owner', async () => {
    const s = await serve();
    // OTHER signs in with the owner's address (an address reassigned at the provider).
    expect((await call(await s.gate(OTHER, OWNER.email), '/sessions')).status).toBe(403);
    // OWNER's subject with no address is still the owner (by principal).
    expect((await call(await s.gate(OWNER, null), '/sessions')).status).toBe(200);
    s.writeView({ ownerPrincipal: null, principals: [P(TESTER)] });
    s.access.reload();
    // First sign-in of the owner, before the helper recorded its Google id: by email tag.
    expect((await call(await s.gate(OWNER), '/sessions')).status).toBe(200);
    expect((await call(await s.gate(TESTER), '/sessions')).status).toBe(403);
    // The owner principal is then whoever presents the owner's address; once recorded, only it.
    s.writeView({ ownerPrincipal: P(OWNER) });
    s.access.reload();
    expect((await call(await s.gate(TESTER, OWNER.email), '/sessions')).status).toBe(403);
  });

  it('a client cannot claim ownership with body fields or query flags', async () => {
    const s = await serve();
    const t = await s.gate(TESTER);
    expect((await call(t, '/sessions?owner=1')).status).toBe(403);
    const r = await call(
      t,
      '/accounts',
      mutation(t, 'POST', { email: 'x@example.invalid', actor: P(OWNER), owner: true }),
    );
    expect(r.status).toBe(403);
  });
});

describe('admin service: CSRF, rate limit, input', () => {
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
      const r = await call(o, '/accounts', { method: 'POST', headers, body });
      expect(r.status, what).toBe(403);
      expect(r.body, what).toEqual({ error: 'csrf' });
    }
    // DELETE is a mutation too.
    expect((await call(o, '/accounts', { method: 'DELETE' })).status).toBe(403);
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
    // Same-origin by Sec-Fetch-Site alone (no Origin) is accepted.
    const ok = await call(o, '/accounts', {
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
        (await call(o, '/accounts/disable', mutation(o, 'POST', { target: 'bad' }))).status,
      ).toBe(400);
    const r = await call(o, '/accounts/disable', mutation(o, 'POST', { target: TARGET }));
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('rate_limited');
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
  });

  it('every caller is rate limited before the owner check (replaces the host backstop, review I5)', async () => {
    const s = await serve({
      limits: { all: { count: 3, windowMs: 60_000 }, write: { count: 3, windowMs: 60_000 } },
    });
    const t = await s.gate(TESTER);
    for (let i = 0; i < 3; i++) expect((await call(t, '/accounts')).status).toBe(403);
    const r = await call(t, '/accounts');
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('rate_limited');
    // Per caller: the owner has its own budget.
    expect((await call(await s.gate(OWNER), '/sessions')).status).toBe(200);
  });

  it('malformed and injection inputs are refused and never reach the spool', async () => {
    const s = await serve({ roomyLimits: true });
    const o = await s.gate(OWNER);
    const add = (body: unknown) => call(o, '/accounts', mutation(o, 'POST', body));
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
      expect((await call(o, '/accounts/disable', mutation(o, 'POST', { target }))).status).toBe(
        400,
      );
    expect(
      (
        await call(
          o,
          '/accounts/reactivate',
          mutation(o, 'POST', { target: TARGET, email: 'a@example.invalid' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await call(o, '/accounts/delete', mutation(o, 'POST', { target: TARGET }))).status,
    ).toBe(404);
    expect((await call(o, '/requests/..%2F..%2Fview%2Faccess')).status).toBe(404);
    expect((await call(o, '/requests/' + 'Z'.repeat(26))).status).toBe(404); // unknown id
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
    // Review I2: ASCII before lower-casing (U+212A KELVIN SIGN would fold to `k`).
    expect((await add({ email: '\u212aate@example.invalid' })).status).toBe(400);
    expect(normalizeAddEmail('\u212aate@example.invalid')).toBeNull();
    expect(normalizeAddEmail('a@ex\u212aample.invalid')).toBeNull();
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
    expect(normalizeAddEmail(' New.Tester+x@example.invalid ')).toBe(
      'new.tester+x@example.invalid',
    );
  });
});

describe('admin service: accounts, spool and results', () => {
  it('lists the masked accounts and the capacity; full addresses never leave the host', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    const r = await call(o, '/accounts');
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
    const sessions = await call(o, '/sessions');
    expect(sessions.body).toEqual(CAPACITY);
    expect(Object.keys(sessions.body).sort()).toEqual(['live', 'max']);
    // An unusable view is 503, never a partial list.
    writeFileSync(join(s.dir, 'view', 'accounts.json'), '{"v":1,"accounts":[{}]}');
    expect((await call(o, '/accounts')).status).toBe(503);
    expect(
      parseAccountsView('{"v":1,"cap":20,"authorizedTesters":0,"owner":1,"accounts":[]}'),
    ).not.toBeNull();
  });

  it('add: an atomic 0640 spool file in the exact format, then the helper’s result (200)', async () => {
    const s = await serve({ admin: { resultWaitMs: 60_000 } });
    const o = await s.gate(OWNER);
    const pendingCall = call(
      o,
      '/accounts',
      mutation(o, 'POST', { email: ' NEW@example.invalid ' }),
    );
    // The helper sees exactly one finished request (no temporary file), owned by the host, 0640 (group-readable by the helper, interface N1).
    let names: string[] = [];
    for (let i = 0; i < 100 && !names.length; i++) {
      names = done(join(s.dir, 'spool'));
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.json$/);
    const path = join(s.dir, 'spool', names[0]!);
    expect(statSync(path).mode & 0o777).toBe(0o640);
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
    const s = await serve({ admin: { resultWaitMs: 60_000 } });
    const o = await s.gate(OWNER);
    for (const action of ['disable', 'reactivate'] as const) {
      const p = call(o, `/accounts/${action}`, mutation(o, 'POST', { target: TARGET }));
      let names: string[] = [];
      while (!names.length) {
        names = done(join(s.dir, 'spool'));
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
    const r = await call(o, '/accounts', mutation(o, 'POST', { email: 'late@example.invalid' }));
    expect(r.status).toBe(202);
    const id = r.body.id as string;
    expect(id).toMatch(REQUEST_ID_RE);
    expect(r.body).toEqual({ id, pending: true, result: `requests/${id}` });
    expect((await call(o, `/requests/${id}`)).status).toBe(202);
    // Only the owner may read it.
    expect((await call(await s.gate(TESTER), `/requests/${id}`)).status).toBe(403);
    helperAnswers(s.dir);
    const done = await call(o, `/requests/${id}`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id, ok: true, code: 'done' });
    // A malformed result file is not a result.
    writeFileSync(join(s.dir, 'results', `${id}.json`), '{"v":1}');
    expect((await call(o, `/requests/${id}`)).status).toBe(404);
  });

  it('a setgid spool directory gives the file its group; the mode is 0640 whatever the umask (N1)', async () => {
    const groups = process.getgroups?.() ?? [];
    const gid = groups.find((g) => g !== process.getgid?.()) ?? process.getgid!();
    const d = adminDir();
    const spool = join(d, 'spool');
    chownSync(spool, -1, gid);
    chmodSync(spool, 0o2730);
    const old = process.umask(0o077);
    try {
      const id = newRequestId();
      await writeSpoolFile(spool, id, '{}\n');
      const st = statSync(join(spool, `${id}.json`));
      expect(st.mode & 0o777).toBe(0o640);
      expect(st.gid).toBe(gid);
      expect(st.uid).toBe(process.getuid!());
    } finally {
      process.umask(old);
      chmodSync(spool, 0o700);
    }
  });

  it('spool failures are 503 and leave nothing; the spool file is never half-written', async () => {
    const failing: SpoolIo = { syncFile: () => Promise.reject(new Error('EIO')) };
    const s = await serve({ io: failing });
    const o = await s.gate(OWNER);
    const r = await call(o, '/accounts', mutation(o, 'POST', { email: 'new@example.invalid' }));
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
    const s = await serve({ view: { ownerPrincipal: null }, admin: { resultWaitMs: 60_000 } });
    const o = await s.gate(OWNER); // recognised by the owner email tag
    const p = call(o, '/accounts/disable', mutation(o, 'POST', { target: TARGET }));
    while (!done(join(s.dir, 'spool')).length) await new Promise((r) => setTimeout(r, 10));
    helperAnswers(s.dir, 'forbidden', false);
    const r = await p;
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'forbidden', ownerIdentityPending: true });
    // Once the owner principal is recorded, a forbidden is just forbidden.
    s.writeView({ ownerPrincipal: P(OWNER) });
    s.access.reload();
    const p2 = call(o, '/accounts/disable', mutation(o, 'POST', { target: TARGET }));
    while (!done(join(s.dir, 'spool')).length) await new Promise((r) => setTimeout(r, 10));
    helperAnswers(s.dir, 'forbidden', false);
    expect((await p2).body.ownerIdentityPending).toBeUndefined();
  });

  it('a mutation needs the gate principal (an address alone names no actor)', async () => {
    const s = await serve({ view: { ownerPrincipal: null } });
    const o = await s.gate(null, OWNER.email);
    expect((await call(o, '/sessions')).status).toBe(200);
    const r = await call(o, '/accounts', mutation(o, 'POST', { email: 'new@example.invalid' }));
    expect(r.status).toBe(401);
  });

  it('no admin directory: the API answers 503 for accounts, the rest still works', async () => {
    const s = await serve({ admin: false });
    const o = await s.gate(OWNER);
    expect((await call(o, '/accounts')).status).toBe(503);
    expect((await call(o, '/sessions')).status).toBe(200);
  });
});

describe('admin service: its own boundary (Sprint 23C)', () => {
  it('serves account administration only: the report and owner routes are the Session Host’s', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    for (const path of ['/me', '/reports', '/admin/accounts', '/', '/accounts/x/y'])
      expect((await call(o, path)).status, path).toBe(404);
    // Liveness for the operator: no identity needed, no account data (the commit when stamped).
    const h = await call(await s.gate(null), '/health');
    expect(h.status).toBe(200);
    expect(h.body).toEqual({ service: 'tbi-admin' }); // an unstamped (test) build
    expect((await call(await s.gate(null), '/health', { method: 'POST' })).status).toBe(401);
    // Non-owners learn nothing about which paths exist.
    expect((await call(await s.gate(TESTER), '/reports')).status).toBe(403);
  });

  it('the access view decides first: revoked is 403 account_disabled, no view is 503', async () => {
    const s = await serve();
    expect((await call(await s.gate(REVOKED), '/accounts')).body).toEqual({
      error: 'account_disabled',
    });
    // The owner's principal revoked: deny wins, even for the owner.
    s.writeView({ revoked: [P(OWNER)] });
    s.access.reload();
    expect((await call(await s.gate(OWNER), '/accounts')).status).toBe(403);
    rmSync(join(s.dir, 'view', 'access.json'));
    s.access.reload();
    const r = await call(await s.gate(OWNER), '/accounts');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'access_view_unavailable' });
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
  });

  it('capacity: the Session Host’s counts, or 503 when they are unknown', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    s.setCapacity(null);
    const r = await call(o, '/sessions');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'capacity_unavailable' });
  });

  it('forged identity headers change nothing (the gate replaces them; X-Tbi-* dropped)', async () => {
    const s = await serve();
    const t = await s.gate(TESTER);
    for (const headers of [
      { 'x-forwarded-user': OWNER.sub },
      { 'x-forwarded-email': OWNER.email },
      { 'x-tbi-owner': '1', 'x-tbi-principal': P(OWNER) },
    ])
      expect((await call(t, '/accounts', { headers })).status).toBe(403);
    expect(ls(join(s.dir, 'spool'))).toEqual([]);
  });
});
