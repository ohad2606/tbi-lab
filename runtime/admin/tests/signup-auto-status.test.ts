/**
 * BETA-G1 slice 5: the owner's read-only auto-approve status route `GET /signups/auto-approve`.
 * Real admin server behind test gates, real temp store and state dir; fake spool and mail.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessView, deriveEmailTag } from '../../identity/access.js';
import { TEST_IDENTITY, principalFor, startTestGate } from '../../identity/test-gate.js';
import { createAdminServer, type AdminSpool } from '../accounts.js';
import { wireSignupAdmin, type SignupAdminWiring } from '../signup/admin-wiring.js';
import { AUTO_PAUSE_FILE, AUTO_STATE_FILE } from '../signup/autoApprove.js';
import type { FetchLike } from '../signup/notify.js';

const OWNER = { sub: '1000000001', email: 'owner@example.invalid' };
const TESTER = { sub: '2000000002', email: 'tester@example.invalid' };
const REVOKED = { sub: '3000000003', email: 'revoked@example.invalid' };
const P = (u: { sub: string }) => principalFor(u.sub);
const tag = (e: string) => deriveEmailTag(TEST_IDENTITY, e);
const NOON_IL = Date.parse('2026-11-23T10:00:00Z'); // 12:00 Israel
const DAY_MS = 86_400_000;
const STATUS = '/signups/auto-approve';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

const accessJson = () =>
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
  });

interface Rig {
  root: string;
  storeDir: string;
  stateDir: string;
  wiring: SignupAdminWiring;
  logs: string[];
  clock: { t: number };
  gate: (u: { sub: string; email?: string } | null) => Promise<string>;
}

async function rig(
  auto: { dailyCap: number; since?: number | null } | null,
  opts: { noStateDir?: boolean } = {},
): Promise<Rig> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-status-')));
  cleanup.push(() => {
    for (const d of [root, join(root, 'state'), join(root, 'p')])
      try {
        chmodSync(d, 0o700);
      } catch {
        /* ignore */
      }
    rmSync(root, { recursive: true, force: true });
  });
  const storeDir = join(root, 'p');
  const stateDir = join(root, 'state');
  if (!opts.noStateDir) mkdirSync(stateDir, { mode: 0o700 });
  const clock = { t: NOON_IL };
  const logs: string[] = [];
  const spool = {
    submit: async () => '01JAAAAAAAAAAAAAAAAAAAAAAA',
    wait: async () => ({ ok: true, code: 'done' }),
  } as unknown as AdminSpool;
  const wiring = await wireSignupAdmin(
    {
      dir: storeDir,
      keyFile: join(root, 'k'),
      from: 'x',
      labUrl: 'https://l.example.invalid/',
      quiet: null,
      ...(auto
        ? {
            autoApprove: {
              dailyCap: auto.dailyCap,
              stateDir,
              ...(auto.since === null ? {} : { since: auto.since ?? NOON_IL - DAY_MS }),
            },
          }
        : {}),
    },
    spool,
    {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log: (l) => logs.push(l),
      email: { sendApproval: async () => undefined },
      autoActor: () => P(OWNER),
      now: () => clock.t,
    },
  );
  const viewFile = join(root, 'access.json');
  writeFileSync(viewFile, accessJson());
  const access = new AccessView(viewFile, { pollMs: 10_000 });
  access.reload();
  cleanup.push(() => access.stop());
  const server: Server = createAdminServer(TEST_IDENTITY, {
    access,
    spool: null,
    capacity: async () => null,
    signups: wiring.signups,
    limits: {
      all: { count: 1000, windowMs: 60_000 },
      write: { count: 1000, windowMs: 60_000 },
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  return {
    root,
    storeDir,
    stateDir,
    wiring,
    logs,
    clock,
    gate: async (u) => {
      const g = await startTestGate(target, TEST_IDENTITY, u?.sub ?? null, u?.email ?? null);
      cleanup.push(g.close);
      return g.base;
    },
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

const sameOrigin = (base: string, method: string) => ({
  method,
  headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
  body: '{}',
});

const person = (i: number) => ({
  name: `Tester ${i}`,
  email: `tester${i}@example.com`,
  role: 'Student',
  lang: 'en' as const,
  consent: true as const,
});

/** No path, address, name or request id in an answer. */
function expectNoPrivateData(r: Rig, text: string) {
  expect(text).not.toContain(r.root);
  expect(text).not.toMatch(/\/|@|example\.com|Tester|[0-9A-HJKMNP-TV-Z]{26}/);
}

const listing = (d: string) => readdirSync(d).sort();

describe('GET /signups/auto-approve: access', () => {
  it('needs the owner: no identity 401, non-owner and revoked 403 (like the sibling routes)', async () => {
    const r = await rig({ dailyCap: 3 });
    for (const [u, status] of [
      [null, 401],
      [TESTER, 403],
      [REVOKED, 403],
    ] as const) {
      const a = await call(await r.gate(u), STATUS);
      expect(a.status).toBe(status);
      expect(a.body.enabled).toBeUndefined();
      // The sibling list answers the same.
      expect((await call(await r.gate(u), '/signups/open')).status).toBe(status);
    }
  });

  it('is GET only: other methods 405 (CSRF still first), nothing written', async () => {
    const r = await rig({ dailyCap: 3 });
    const o = await r.gate(OWNER);
    const before = listing(r.stateDir);
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH'])
      expect((await call(o, STATUS, sameOrigin(o, m))).status, m).toBe(405);
    // A cross-site mutation is refused by the CSRF rule before the route.
    const x = await call(o, STATUS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(x.status).toBe(403);
    expect(x.body).toEqual({ error: 'csrf' });
    expect(listing(r.stateDir)).toEqual(before);
    // Deeper paths do not exist.
    expect((await call(o, `${STATUS}/x`)).status).toBe(404);
  });
});

describe('GET /signups/auto-approve: answers', () => {
  it('auto-approve off: {enabled:false} only, the state dir is not touched', async () => {
    const r = await rig(null);
    // Off, the default state dir would be the store dir: a pause file there and a locked dir
    // must change nothing (it is never read).
    writeFileSync(join(r.storeDir, AUTO_PAUSE_FILE), '');
    const before = listing(r.storeDir);
    chmodSync(r.storeDir, 0o000);
    const o = await r.gate(OWNER);
    const a = await call(o, STATUS);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ enabled: false });
    expect(a.headers.get('cache-control')).toContain('no-store');
    chmodSync(r.storeDir, 0o700);
    expect(listing(r.storeDir)).toEqual(before);
    expect(r.logs.filter((l) => l.includes('auto-approve'))).toEqual([]);
  });

  it('on, before any sweep: count 0, cut-off not recorded yet = unknown; read-only (no file, no log)', async () => {
    const r = await rig({ dailyCap: 5, since: null });
    await r.wiring.store.createIfNew(person(1));
    const o = await r.gate(OWNER);
    const logsBefore = [...r.logs];
    const a = await call(o, STATUS);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({
      enabled: true,
      running: false,
      day: '2026-11-23',
      dailyCap: 5,
      count: 0,
      capReached: false,
      paused: false,
      stateDir: 'ok',
      cutoff: 'unknown',
      waitingBacklog: 'unknown',
      unknownReasons: { cutoff: 'not_recorded', waitingBacklog: 'not_recorded' },
    });
    expect(listing(r.stateDir)).toEqual([]);
    expect(r.logs).toEqual(logsBefore);
    expectNoPrivateData(r, a.text);
  });

  it('on: today count against the cap, the backlog before the cut-off, running after start', async () => {
    const r = await rig({ dailyCap: 2, since: NOON_IL - 60_000 });
    // One request before the cut-off (stays for the owner), three after it (cap 2: one waits).
    r.clock.t = NOON_IL - 120_000;
    await r.wiring.store.createIfNew(person(0));
    for (let i = 1; i <= 3; i++) {
      r.clock.t = NOON_IL - 30_000 + i * 1000;
      await r.wiring.store.createIfNew(person(i));
    }
    r.clock.t = NOON_IL;
    const stop = r.wiring.startAutoApprove();
    // Wait for the first sweep (it runs once the state dir check has passed).
    for (let i = 0; i < 200 && !r.logs.some((l) => l.includes('processed')); i++)
      await new Promise((res) => setTimeout(res, 10));
    const o = await r.gate(OWNER);
    const a = await call(o, STATUS);
    await stop();
    expect(a.status).toBe(200);
    expect(a.body).toEqual({
      enabled: true,
      running: true,
      day: '2026-11-23',
      dailyCap: 2,
      count: 2,
      capReached: true,
      paused: false,
      stateDir: 'ok',
      cutoff: new Date(NOON_IL - 60_000).toISOString(),
      waitingBacklog: 1,
    });
    expectNoPrivateData(r, a.text);
    // After stop the sweeper no longer runs.
    expect((await call(o, STATUS)).body.running).toBe(false);
    // The next Israel day: a fresh count (the file still says yesterday; nothing is written).
    const file = readFileSync(join(r.stateDir, AUTO_STATE_FILE), 'utf8');
    r.clock.t = NOON_IL + DAY_MS;
    const next = await call(o, STATUS);
    expect(next.body).toMatchObject({ day: '2026-11-24', count: 0, capReached: false });
    expect(readFileSync(join(r.stateDir, AUTO_STATE_FILE), 'utf8')).toBe(file);
  });

  it('the persisted cut-off is reported when none is configured', async () => {
    const r = await rig({ dailyCap: 3, since: null });
    await r.wiring.auto!.sweep();
    const a = await call(await r.gate(OWNER), STATUS);
    expect(a.body).toMatchObject({ cutoff: new Date(NOON_IL).toISOString(), waitingBacklog: 0 });
    expect(a.body.unknownReasons).toBeUndefined();
  });

  it('paused: the kill switch shows at once (file or any entry), and clears on rm', async () => {
    const r = await rig({ dailyCap: 3 });
    const o = await r.gate(OWNER);
    writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '');
    expect((await call(o, STATUS)).body).toMatchObject({ enabled: true, paused: true });
    rmSync(join(r.stateDir, AUTO_PAUSE_FILE));
    mkdirSync(join(r.stateDir, AUTO_PAUSE_FILE));
    expect((await call(o, STATUS)).body).toMatchObject({ paused: true });
    rmSync(join(r.stateDir, AUTO_PAUSE_FILE), { recursive: true });
    const a = await call(o, STATUS);
    expect(a.body).toMatchObject({ paused: false });
    expect(a.body.pauseError).toBeUndefined();
  });

  it('a corrupt or future-dated state file gives count unknown, never a number', async () => {
    const r = await rig({ dailyCap: 3 });
    const o = await r.gate(OWNER);
    writeFileSync(join(r.stateDir, AUTO_STATE_FILE), '{not json', { mode: 0o600 });
    const a = await call(o, STATUS);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      enabled: true,
      dailyCap: 3,
      count: 'unknown',
      capReached: 'unknown',
      paused: false,
      stateDir: 'ok',
      // The configured cut-off does not need the state file.
      cutoff: new Date(NOON_IL - DAY_MS).toISOString(),
      waitingBacklog: 0,
      unknownReasons: { count: 'corrupt' },
    });
    expectNoPrivateData(r, a.text);
    writeFileSync(
      join(r.stateDir, AUTO_STATE_FILE),
      JSON.stringify({ v: 2, day: '2026-11-24', count: 0, retries: 0, claims: {} }),
    );
    expect((await call(o, STATUS)).body).toMatchObject({
      count: 'unknown',
      unknownReasons: { count: 'future_day' },
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable state file (EACCES) gives count unknown with the errno name',
    async () => {
      const r = await rig({ dailyCap: 3, since: null });
      const f = join(r.stateDir, AUTO_STATE_FILE);
      writeFileSync(
        f,
        JSON.stringify({ v: 2, day: '2026-11-23', count: 1, retries: 0, claims: {} }),
      );
      chmodSync(f, 0o000);
      const a = await call(await r.gate(OWNER), STATUS);
      chmodSync(f, 0o600);
      expect(a.body).toMatchObject({
        count: 'unknown',
        capReached: 'unknown',
        cutoff: 'unknown',
        waitingBacklog: 'unknown',
        unknownReasons: { count: 'EACCES', cutoff: 'EACCES', waitingBacklog: 'EACCES' },
      });
      expectNoPrivateData(r, a.text);
    },
  );

  it('an unsafe or missing state dir: stateDir unsafe with its reason, count unknown, nothing read', async () => {
    const r = await rig({ dailyCap: 3 });
    const o = await r.gate(OWNER);
    writeFileSync(
      join(r.stateDir, AUTO_STATE_FILE),
      JSON.stringify({ v: 2, day: '2026-11-23', count: 1, retries: 0, claims: {} }),
    );
    chmodSync(r.stateDir, 0o770);
    const a = await call(o, STATUS);
    expect(a.body).toMatchObject({
      stateDir: 'unsafe',
      stateDirReason: 'mode',
      count: 'unknown',
      capReached: 'unknown',
      unknownReasons: { count: 'state_dir_unsafe' },
    });
    expectNoPrivateData(r, a.text);
    chmodSync(r.stateDir, 0o700);
    expect((await call(o, STATUS)).body).toMatchObject({ stateDir: 'ok', count: 1 });
    rmSync(r.stateDir, { recursive: true });
    const gone = await call(o, STATUS);
    expect(gone.body).toMatchObject({
      stateDir: 'unsafe',
      stateDirReason: 'ENOENT',
      count: 'unknown',
      capReached: 'unknown',
    });
    expectNoPrivateData(r, gone.text);
  });
});
