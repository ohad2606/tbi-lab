/**
 * Admin app design §2: the admin service's read-only history views, `GET /usage` and
 * `GET /audit`. The same authorization chain as `GET /accounts` (the access view decides, the
 * caller is rate limited, then only the owner); GET only; a missing, oversized, unknown-version
 * or malformed file is 503; ranges and limits are validated. The ops side's files are played by
 * the test (example.invalid identities only; targets are opaque).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessView, deriveEmailTag } from '../../identity/access.js';
import { TEST_IDENTITY, principalFor, startTestGate } from '../../identity/test-gate.js';
import { AdminSpool, DEFAULT_ADMIN, createAdminServer } from '../accounts.js';
import {
  AdminViews,
  MAX_VIEW_BYTES,
  parseAudit,
  parseUsage,
  usageRange,
  viewPathsFromEnv,
} from '../views.js';

const OWNER = { sub: '1000000001', email: 'owner@example.invalid' };
const TESTER = { sub: '2000000002', email: 'tester@example.invalid' };
const STRANGER = { sub: '9000000009', email: 'stranger@example.invalid' };
const REVOKED = { sub: '3000000003', email: 'revoked@example.invalid' };
const tag = (e: string) => deriveEmailTag(TEST_IDENTITY, e);
const T1 = 't_AAAAAAAAAAAAAAAA';
const T2 = 't_BBBBBBBBBBBBBBBB';
// 2026-11-11 10:00 UTC is 12:00 in Israel: "today" is 2026-11-11.
const NOW = Date.parse('2026-11-11T10:00:00Z');
/** The usage exporter's real output shape (synthetic values): simSeconds rounded to 0.1 s. */
const EXPORTER_FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usage-exporter-v1.json'),
  'utf8',
);

const m = (p: Partial<Record<string, number>> = {}) => ({
  signIns: 0,
  builds: 0,
  prebuilt: 0,
  runs: 0,
  simSeconds: 0,
  refusals: 0,
  ...p,
});

function usageJson(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    generated: '2026-11-11T09:55:00Z',
    tz: 'Asia/Jerusalem',
    from: '2025-10-08',
    days: {
      '2026-10-01': { [T1]: m({ builds: 9 }) },
      '2026-10-13': { [T1]: m({ signIns: 1 }) },
      '2026-11-10': { [T1]: m({ signIns: 2, builds: 3, runs: 4, simSeconds: 600 }) },
      '2026-11-11': {
        [T1]: m({ runs: 1, simSeconds: 61 }),
        [T2]: m({ prebuilt: 1, refusals: 2 }),
        unmatched: m({ runs: 1 }),
      },
    },
    lastActivity: { [T1]: '2026-11-11T09:00:00Z', [T2]: '2026-11-11T08:00:00Z' },
    ...extra,
  });
}

function auditJson(entries?: unknown[]) {
  return JSON.stringify({
    v: 1,
    generated: '2026-11-11T09:56:00Z',
    entries: entries ?? [
      { at: '2026-11-11T09:00:00Z', action: 'rename', target: T1, result: 'done', corr: 'c-3' },
      { at: '2026-11-10T09:00:00Z', action: 'disable', target: T2, result: 'done', corr: 'c-2' },
      {
        at: '2026-11-09T09:00:00Z',
        action: 'sign_ins',
        target: null,
        result: 'ok',
        corr: 'c-1',
        count: 4,
      },
    ],
  });
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function serve(opts: { views?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tbi-admin-views-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['spool', 'results', 'view', 'usage']) mkdirSync(join(dir, sub));
  const P = (u: { sub: string }) => principalFor(u.sub);
  writeFileSync(
    join(dir, 'view', 'access.json'),
    JSON.stringify({
      v: 1,
      generated: new Date().toISOString(),
      seq: 1,
      owner: { principal: P(OWNER), emailTag: tag(OWNER.email) },
      authorized: {
        principals: [P(OWNER), P(TESTER)],
        emailTags: [tag(OWNER.email), tag(TESTER.email)],
      },
      revoked: { principals: [P(REVOKED)], emailTags: [tag(REVOKED.email)] },
    }),
  );
  writeFileSync(join(dir, 'usage', 'usage.json'), usageJson());
  writeFileSync(join(dir, 'view', 'audit.json'), auditJson());
  const access = new AccessView(join(dir, 'view', 'access.json'), { pollMs: 10_000 });
  access.reload();
  cleanup.push(() => access.stop());
  const server: Server = createAdminServer(TEST_IDENTITY, {
    access,
    spool: new AdminSpool({ ...DEFAULT_ADMIN, dir }),
    capacity: async () => ({ live: 0, max: 6 }),
    views: opts.views === false ? null : new AdminViews(viewPathsFromEnv(dir, {})),
    now: () => NOW,
    limits: { all: { count: 1000, windowMs: 60_000 }, write: { count: 1000, windowMs: 60_000 } },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  const gate = async (u: { sub: string; email?: string } | null) => {
    const g = await startTestGate(target, TEST_IDENTITY, u?.sub ?? null, u?.email ?? null);
    cleanup.push(g.close);
    return g.base;
  };
  return { dir, gate };
}

const json = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
};

async function call(base: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: json(await res.text()), headers: res.headers };
}

describe('admin service: usage and audit views (admin app)', () => {
  it('owner only, as GET /accounts: none 401, tester / stranger / revoked 403, owner 200, no-store', async () => {
    const s = await serve();
    for (const path of ['/usage', '/audit']) {
      expect((await call(await s.gate(null), path)).status, path).toBe(401);
      // A tester is authorized by the access view but is not the owner.
      const t = await call(await s.gate(TESTER), path);
      expect(t.status, path).toBe(403);
      expect(t.body).toEqual({ error: 'forbidden' });
      // A stranger is refused by the access view itself; nothing of the view is in the answer.
      const x = await call(await s.gate(STRANGER), path);
      expect(x.status, path).toBe(403);
      expect(Object.keys(x.body)).toEqual(['error']);
      expect((await call(await s.gate(REVOKED), path)).status).toBe(403);
      const ok = await call(await s.gate(OWNER), path);
      expect(ok.status, path).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(ok.headers.get('content-type')).toMatch(/^application\/json/);
    }
  });

  it('GET only: a same-origin JSON POST is 405, a cross-site one is the CSRF refusal', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    for (const path of ['/usage', '/audit']) {
      const same = await call(o, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: o, 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      expect(same.status).toBe(405);
      const cross = await call(o, path, { method: 'POST', body: '{}' });
      expect(cross.status).toBe(403);
      expect(cross.body).toEqual({ error: 'csrf' });
      expect((await call(o, `${path}/x`)).status).toBe(404);
    }
  });

  it('usage: default last 30 Israel days, ascending, only days in range, unmatched kept', async () => {
    const s = await serve();
    const r = await call(await s.gate(OWNER), '/usage');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      generated: '2026-11-11T09:55:00Z',
      tz: 'Asia/Jerusalem',
      from: '2026-10-13',
      to: '2026-11-11',
    });
    const days = r.body.days as { date: string; accounts: Record<string, unknown> }[];
    expect(days.map((d) => d.date)).toEqual(['2026-10-13', '2026-11-10', '2026-11-11']);
    expect(days[2]!.accounts.unmatched).toEqual(m({ runs: 1 }));
    expect(days[1]!.accounts[T1]).toEqual(m({ signIns: 2, builds: 3, runs: 4, simSeconds: 600 }));
    expect(r.body.lastActivity).toEqual({
      [T1]: '2026-11-11T09:00:00Z',
      [T2]: '2026-11-11T08:00:00Z',
    });
  });

  it('usage: explicit ranges, and every invalid one refused', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    const dates = async (q: string) =>
      ((await call(o, `/usage?${q}`)).body.days as { date: string }[]).map((d) => d.date);
    expect(await dates('from=2026-10-01&to=2026-10-13')).toEqual(['2026-10-01', '2026-10-13']);
    expect(await dates('from=2026-11-11&to=2026-11-11')).toEqual(['2026-11-11']);
    expect(await dates('from=2026-11-01')).toEqual(['2026-11-10', '2026-11-11']);
    expect(await dates('to=2026-10-13')).toEqual(['2026-10-01', '2026-10-13']);
    for (const [q, error] of [
      ['from=2026-11-12&to=2026-11-11', 'invalid_range'],
      ['from=2025-01-01&to=2026-11-11', 'range_too_long'],
      ['from=2026-02-30', 'invalid_from'],
      ['to=2026-1-1', 'invalid_to'],
      ['from=../../etc', 'invalid_from'],
      ['from=2026-11-01&from=2026-11-02', 'invalid_query'],
      ['owner=1', 'invalid_query'],
    ] as const) {
      const r = await call(o, `/usage?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body).toEqual({ error });
    }
    // Exactly 400 days is allowed.
    expect((await call(o, '/usage?from=2025-10-08&to=2026-11-11')).status).toBe(200);
  });

  it('usage: missing, unreadable, oversized, unknown version or malformed file is 503', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    const file = join(s.dir, 'usage', 'usage.json');
    const expect503 = async (why: string) => {
      const r = await call(o, '/usage');
      expect(r.status, why).toBe(503);
      expect(r.body).toEqual({ error: 'usage_unavailable' });
    };
    rmSync(file);
    await expect503('missing');
    mkdirSync(file);
    await expect503('a directory');
    rmSync(file, { recursive: true });
    writeFileSync(file, usageJson({ v: 2 }));
    await expect503('unknown version');
    writeFileSync(file, '{"v":1');
    await expect503('truncated');
    writeFileSync(file, usageJson({ pad: 'x'.repeat(MAX_VIEW_BYTES) }));
    await expect503('too large');
    writeFileSync(file, usageJson({ tz: 'Mars/Olympus_Mons' }));
    await expect503('a time zone the runtime does not know');
    writeFileSync(file, usageJson());
    expect((await call(o, '/usage')).status).toBe(200);
    // No views configured at all.
    const n = await serve({ views: false });
    expect((await call(await n.gate(OWNER), '/usage')).body).toEqual({
      error: 'usage_unavailable',
    });
    expect((await call(await n.gate(OWNER), '/audit')).body).toEqual({
      error: 'audit_unavailable',
    });
  });

  it('usage parser: strict fields; an address or a bad key fails the whole file', () => {
    expect(parseUsage(usageJson())).not.toBeNull();
    const bad = (days: unknown, extra: Record<string, unknown> = {}) =>
      parseUsage(usageJson({ days, ...extra }));
    expect(bad({ '2026-11-11': { 'tester@example.invalid': m() } })).toBeNull();
    expect(bad({ '2026-13-01': { [T1]: m() } })).toBeNull();
    expect(bad({ '2026-11-11': { [T1]: m({ runs: -1 }) } })).toBeNull();
    expect(bad({ '2026-11-11': { [T1]: m({ runs: 1.5 }) } })).toBeNull();
    expect(bad({ '2026-11-11': { [T1]: { runs: '3' } } })).toBeNull();
    expect(bad({}, { tz: 'Asia/Jerusalem; rm' })).toBeNull();
    expect(bad({}, { tz: 'Not/AZone' })).toBeNull();
    expect(bad({}, { generated: 'yesterday' })).toBeNull();
    expect(bad({}, { lastActivity: { 'a@example.invalid': '2026-11-11T09:00:00Z' } })).toBeNull();
    // Absent metrics are 0; unknown ones are dropped.
    const u = parseUsage(usageJson({ days: { '2026-11-11': { [T1]: { runs: 2, future: 7 } } } }));
    expect(u!.days.get('2026-11-11')![T1]).toEqual(m({ runs: 2 }));
  });

  it('usage parser: simulated seconds are a duration (0.1 s), every other metric a count', () => {
    const one = (p: Record<string, unknown>) =>
      parseUsage(usageJson({ days: { '2026-11-11': { [T1]: { ...m(), ...p } } } }))?.days.get(
        '2026-11-11',
      )?.[T1] ?? null;
    expect(one({ simSeconds: 71.3 })).toEqual(m({ simSeconds: 71.3 }));
    expect(one({ simSeconds: 0.4 })!.simSeconds).toBe(0.4);
    expect(one({ simSeconds: 1e9 })!.simSeconds).toBe(1e9);
    // More precision than the exporter writes is rounded to 0.1 s on the way out.
    expect(one({ simSeconds: 12.345 })!.simSeconds).toBe(12.3);
    expect(one({ simSeconds: 0.04 })!.simSeconds).toBe(0);
    for (const bad of [-0.1, 1e9 + 0.5, '71.3', null, Number.POSITIVE_INFINITY])
      expect(one({ simSeconds: bad }), String(bad)).toBeNull();
    // NaN and Infinity cannot be written in JSON at all; the file is then malformed.
    expect(parseUsage(usageJson().replace('"simSeconds":61', '"simSeconds":NaN'))).toBeNull();
    for (const name of ['signIns', 'builds', 'prebuilt', 'runs', 'refusals'])
      expect(one({ [name]: 1.5 }), name).toBeNull();
  });

  it('usage parser: the exporter contract fixture (real shape, synthetic values) is accepted', () => {
    const u = parseUsage(EXPORTER_FIXTURE);
    expect(u).not.toBeNull();
    expect(u!.tz).toBe('Asia/Jerusalem');
    expect([...u!.days.keys()]).toEqual(['2026-11-09', '2026-11-11']);
    expect(u!.days.get('2026-11-09')![T1]).toEqual(
      m({ signIns: 1, builds: 3, runs: 4, simSeconds: 71.3 }),
    );
    expect(u!.days.get('2026-11-11')!.unmatched!.simSeconds).toBe(12.5);
    expect(u!.days.get('2026-11-11')![T2]!.simSeconds).toBe(0.4);
    expect(u!.lastActivity[T1]).toBe('2026-11-11T16:42:10Z');
  });

  it('usage: the exporter file with fractional simulated seconds is served (not 503)', async () => {
    const s = await serve();
    writeFileSync(join(s.dir, 'usage', 'usage.json'), EXPORTER_FIXTURE);
    const r = await call(await s.gate(OWNER), '/usage');
    expect(r.status).toBe(200);
    const days = r.body.days as {
      date: string;
      accounts: Record<string, Record<string, number>>;
    }[];
    expect(days.map((d) => d.date)).toEqual(['2026-11-09', '2026-11-11']);
    expect(days[0]!.accounts[T1]!.simSeconds).toBe(71.3);
    expect(days[1]!.accounts[T1]).toEqual(
      m({ signIns: 2, builds: 5, prebuilt: 1, runs: 6, simSeconds: 188.7, refusals: 1 }),
    );
    expect(days[1]!.accounts.unmatched!.simSeconds).toBe(12.5);
  });

  it('audit: newest first, limit 1..500 (default 100), unknown entries left out', async () => {
    const s = await serve();
    const o = await s.gate(OWNER);
    const r = await call(o, '/audit');
    expect(r.status).toBe(200);
    expect(r.body.generated).toBe('2026-11-11T09:56:00Z');
    const entries = r.body.entries as { action: string; corr: string; count?: number }[];
    expect(entries.map((e) => e.corr)).toEqual(['c-3', 'c-2', 'c-1']);
    expect(entries[2]).toEqual({
      at: '2026-11-09T09:00:00Z',
      action: 'sign_ins',
      target: null,
      result: 'ok',
      corr: 'c-1',
      count: 4,
    });
    expect(((await call(o, '/audit?limit=2')).body.entries as unknown[]).length).toBe(2);
    expect(((await call(o, '/audit?limit=500')).body.entries as unknown[]).length).toBe(3);
    for (const q of ['limit=0', 'limit=501', 'limit=abc', 'limit=1&limit=2', 'limit=-1', 'x=1'])
      expect((await call(o, `/audit?${q}`)).status, q).toBe(400);

    // The file in any order comes out newest first; entries it cannot vouch for are dropped.
    writeFileSync(
      join(s.dir, 'view', 'audit.json'),
      auditJson([
        { at: '2026-11-01T00:00:00Z', action: 'add', target: T1, result: 'done', corr: 'a' },
        { at: '2026-11-05T00:00:00Z', action: 'add', target: T2, result: 'done', corr: 'b' },
        { at: '2026-11-06T00:00:00Z', action: 'explode', target: T2, result: 'done', corr: 'x1' },
        {
          at: '2026-11-06T00:00:00Z',
          action: 'add',
          target: 'someone@example.invalid',
          result: 'done',
          corr: 'x2',
        },
        { at: 'soon', action: 'add', target: null, result: 'done', corr: 'x3' },
        { at: '2026-11-06T00:00:00Z', action: 'add', target: null, result: 'Done!', corr: 'x4' },
        // Automatic events (the helper's sign-in and identity records) carry no correlation id.
        {
          at: '2026-11-07T00:00:00Z',
          action: 'sign_ins',
          target: null,
          result: 'done',
          corr: null,
          count: 3,
        },
        {
          at: '2026-11-07T01:00:00Z',
          action: 'record_identity',
          target: T1,
          result: 'done',
          corr: null,
        },
        { at: '2026-11-06T00:00:00Z', action: 'add', target: T1, result: 'done', corr: 42 },
        {
          at: '2026-11-06T00:00:00Z',
          action: 'add',
          target: T1,
          result: 'done',
          corr: 'bad corr!',
        },
      ]),
    );
    expect(
      ((await call(o, '/audit')).body.entries as { corr: string | null }[]).map((e) => e.corr),
    ).toEqual([null, null, 'b', 'a']);
    for (const text of [auditJson().replace('"v":1', '"v":2'), 'not json']) {
      writeFileSync(join(s.dir, 'view', 'audit.json'), text);
      expect((await call(o, '/audit')).body).toEqual({ error: 'audit_unavailable' });
    }
    rmSync(join(s.dir, 'view', 'audit.json'));
    expect((await call(o, '/audit')).status).toBe(503);
  });

  it('audit parser caps at 500 entries', () => {
    const many = Array.from({ length: 700 }, (_, i) => ({
      at: new Date(NOW - i * 60_000).toISOString(),
      action: 'sign_ins',
      target: null,
      result: 'ok',
      corr: `c${i}`,
    }));
    expect(parseAudit(auditJson(many))!.entries.length).toBe(500);
  });

  it('audit parser sorts before the cap: an oldest-first file still yields the newest 500', () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({
      at: new Date(NOW - (1199 - i) * 60_000).toISOString(),
      action: 'sign_ins',
      target: null,
      result: 'ok',
      corr: `c${i}`,
    }));
    const entries = parseAudit(auditJson(many))!.entries;
    expect(entries.length).toBe(500);
    expect(entries[0]!.corr).toBe('c1199');
    expect(entries[499]!.corr).toBe('c700');
  });

  it('range defaults follow the file’s time zone', () => {
    // 2026-11-10 23:30 UTC is already 2026-11-11 in Israel.
    const late = Date.parse('2026-11-10T23:30:00Z');
    expect(usageRange(new URLSearchParams(), 'Asia/Jerusalem', late)).toEqual({
      from: '2026-10-13',
      to: '2026-11-11',
    });
    expect(usageRange(new URLSearchParams(), 'UTC', late)).toEqual({
      from: '2026-10-12',
      to: '2026-11-10',
    });
  });

  it('paths: TBI_ADMIN_USAGE / TBI_ADMIN_AUDIT_VIEW, absolute only', () => {
    expect(viewPathsFromEnv('/var/lib/tbi-admin', {})).toEqual({
      usage: '/var/lib/tbi-admin/usage/usage.json',
      audit: '/var/lib/tbi-admin/view/audit.json',
    });
    expect(
      viewPathsFromEnv('/d', { TBI_ADMIN_USAGE: '/x/u.json', TBI_ADMIN_AUDIT_VIEW: '/x/a.json' }),
    ).toEqual({ usage: '/x/u.json', audit: '/x/a.json' });
    expect(() => viewPathsFromEnv('/d', { TBI_ADMIN_USAGE: 'u.json' })).toThrow(/absolute/);
  });
});
