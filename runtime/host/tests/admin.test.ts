/**
 * Sprint 23B, adversarial: access enforcement, revocation of live sessions, identity
 * observations, the extended feedback and the owner's report routes. (Sprint 23C: the account
 * administration moved to the admin service, runtime/admin/tests/admin-service.test.ts.)
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
import type { SpoolIo } from '../../admin/common.js';
import { IdentityObserver } from '../admin.js';
import { revokeOnReload, type SessionHost } from '../host.js';
import { createHealthServer, createHttpServer } from '../http.js';
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
    view?: ViewSpec | false;
    observerNow?: () => number;
    roomyLimits?: boolean;
  } = {},
): Promise<Setup> {
  const dir = adminDir();
  const file = join(dir, 'view', 'access.json');
  const writeView = (s: ViewSpec = {}) => writeFileSync(file, accessJson(s));
  if (opts.view !== false) writeView(opts.view);
  const access = new AccessView(file, { pollMs: 10_000 });
  access.reload();
  cleanup.push(() => access.stop());
  const lines: string[] = [];
  const store = new ReportStore(
    { ...DEFAULT_REPORTS, dir: join(dir, 'reports') },
    { log: (l) => void lines.push(l) },
  );
  const host = opts.host ?? shared.host;
  const observer = new IdentityObserver(join(dir, 'observations'), {
    ...(opts.observerNow ? { now: opts.observerNow } : {}),
  });
  const server: Server = createHttpServer(host, TEST_IDENTITY, store, {
    access,
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
/** Finished entries only: the helper ignores `*.tmp` (a write in progress). */
const done = (d: string) => ls(d).filter((n) => n.endsWith('.json'));

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

  it('deny wins, both ways: a revoked principal with an authorized address, an authorized principal with a revoked address', async () => {
    const s = await serve();
    // REVOKED's principal is revoked; its gate sends an authorized address (TESTER's).
    const r1 = await call(await s.gate(REVOKED, TESTER.email), `/sessions/${'0'.repeat(32)}`);
    expect(r1.status).toBe(403);
    expect(r1.body).toEqual({ error: 'account_disabled' });
    // TESTER's principal is authorized; its gate sends a revoked address.
    const r2 = await call(await s.gate(TESTER, REVOKED.email), `/sessions/${'0'.repeat(32)}`);
    expect(r2.status).toBe(403);
    // The owner is not an exception either.
    s.writeView({ revokedTags: [tag(OWNER.email)] });
    s.access.reload();
    expect((await call(await s.gate(OWNER), '/admin/me')).status).toBe(403);
    expect((await call(await s.gate(OWNER, null), '/admin/me')).status).toBe(200);
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

describe('revocation follows deny-wins', () => {
  it('a live session ends when its principal is revoked (address still authorized) or its address is revoked (principal still authorized)', async () => {
    const { host, art } = fakeHost('normal');
    cleanup.push(() => host.shutdown());
    const s = await serve({ host });
    revokeOnReload(host, s.access, () => undefined);
    const start = async (u: { sub: string; email: string }) => {
      const base = await s.gate(u);
      const created = await call(
        base,
        '/sessions',
        mutation(base, 'POST', createRequest(art.sha256, { ticket: ticketFor(art.sha256, P(u)) })),
      );
      expect(created.status).toBe(201);
      const { sessionId, token } = created.body as { sessionId: string; token: string };
      const found = host.get(sessionId, token, P(u));
      if (!found.ok) throw new Error('no session');
      return found.value;
    };
    const tester = await start(TESTER);
    const other = await start(OTHER);
    // TESTER: principal revoked, its address still in the authorized tags.
    s.writeView({ revoked: [P(TESTER)] });
    s.access.reload();
    await waitState(tester, 'ended');
    expect(tester.status().reason).toBe('account_disabled');
    expect(other.state).toBe('ready');
    // OTHER: principal still authorized, its address now revoked.
    s.writeView({ revoked: [P(TESTER)], revokedTags: [tag(OTHER.email)] });
    s.access.reload();
    await waitState(other, 'ended');
    expect(other.status().reason).toBe('account_disabled');
  });
});

describe('identity observations', () => {
  it('one atomic 0640 file per principal per hour, only with both headers; never slows or fails a request', async () => {
    let now = Date.parse('2026-10-29T10:00:00Z');
    const s = await serve({ observerNow: () => now });
    const obs = join(s.dir, 'observations');
    const waitFiles = async (n: number) => {
      for (let i = 0; i < 100 && done(obs).length < n; i++)
        await new Promise((r) => setTimeout(r, 10));
      return done(obs);
    };
    const t = await s.gate(TESTER);
    await call(t, '/health'); // health: no identity processing
    expect(ls(obs)).toEqual([]);
    for (let i = 0; i < 3; i++) await call(t, `/sessions/${'0'.repeat(32)}`);
    const files = await waitFiles(1);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.json$/);
    expect(statSync(join(obs, files[0]!)).mode & 0o777).toBe(0o640);
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
    // Review I3: bidi embedding / override / isolate controls are removed from both texts.
    const bidi = validateReport(
      body({
        kind: 'component',
        component: 'A\u202eB\u2066C\u2069D\u202a\u202b\u202c\u202d\u2067\u2068',
        description: 'x\u202ey\u2069z',
      }),
    );
    expect(bidi.ok && bidi.value.component).toBe('ABCD');
    expect(bidi.ok && bidi.value.description).toBe('xyz');
    // Hebrew text itself is untouched.
    const he = validateReport(body({ kind: 'component', component: 'חיישן DHT22' }));
    expect(he.ok && he.value.component).toBe('חיישן DHT22');
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

describe('health-only socket for the build service (review H1)', () => {
  it('answers GET /health only; no identity is read, no other route exists', async () => {
    const server = createHealthServer(shared.host);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const h = await call(base, '/health');
    expect(h.status).toBe(200);
    expect(Object.keys(h.body)).toContain('sessions');
    for (const [method, path] of [
      ['GET', '/admin/me'],
      ['GET', '/admin/accounts'],
      ['POST', '/sessions'],
      ['POST', '/reports'],
      ['GET', `/sessions/${'0'.repeat(32)}`],
      ['POST', '/health'],
    ] as const) {
      const r = await call(base, path, {
        method,
        headers: { 'x-forwarded-user': OWNER.sub, 'x-forwarded-email': OWNER.email },
      });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });
});
