/**
 * BETA-G1 S5: the owner's read-only view of email verification on `GET /signups*` and
 * `GET /signups/auto-approve`. Real admin server behind test gates, real temp store and state
 * dir; fake spool and mail. Synthetic data only.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
import { wireSignupAdmin, type AdminSignupConfig } from '../signup/admin-wiring.js';
import { AUTO_PAUSE_FILE } from '../signup/autoApprove.js';
import type { FetchLike } from '../signup/notify.js';
import { coalesce, ownerView, READS } from '../signup/rowState.js';
import { PendingStore } from '../signup/store.js';
import { addressHash, peekVerifyState } from '../signup/verifyState.js';
import { loadVerifyKeys } from '../signup/verify.js';

const OWNER = { sub: '1000000001', email: 'owner@example.invalid' };
const TESTER = { sub: '2000000002', email: 'tester@example.invalid' };
const P = (u: { sub: string }) => principalFor(u.sub);
const tag = (e: string) => deriveEmailTag(TEST_IDENTITY, e);
const NOON = Date.parse('2026-11-23T10:00:00Z');
const DAY = 86_400_000;
const STATUS = '/signups/auto-approve';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

interface Opts {
  verify?: boolean;
  caps?: boolean;
  auto?: number;
  failSend?: (email: string) => boolean;
}

async function rig(o: Opts = { verify: true, caps: true }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-rows-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const storeDir = join(root, 'p');
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  const keyFile = join(root, 'verify.key');
  writeFileSync(keyFile, `${'k'.repeat(48)}\n`, { mode: 0o600 });
  const clock = { t: NOON };
  const logs: string[] = [];
  const links: string[] = [];
  const config: AdminSignupConfig = {
    dir: storeDir,
    keyFile: join(root, 'k'),
    from: 'x',
    labUrl: 'https://l.example.invalid/',
    quiet: null,
    ...(o.verify
      ? {
          verify: {
            keyFile,
            stateDir,
            siteUrl: 'https://site.example.invalid',
            since: NOON - DAY,
          },
          verifiedMode: true,
        }
      : {}),
    ...(o.caps ? { mailCaps: { perHour: 30, perDay: 95, per30d: 2700, stateDir } } : {}),
    ...(o.auto
      ? {
          autoApprove: {
            dailyCap: o.auto,
            stateDir,
            since: NOON - DAY,
            webSignups: 'verified' as const,
          },
        }
      : {}),
  };
  const wiring = await wireSignupAdmin(
    config,
    {
      submit: async () => '01JAAAAAAAAAAAAAAAAAAAAAAA',
      wait: async () => ({ ok: true, code: 'done' }),
    } as unknown as AdminSpool,
    {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log: (l) => logs.push(l),
      email: {
        sendApproval: async () => undefined,
        sendVerify: async (to) => {
          if (o.failSend?.(to.email)) throw new Error('http_500');
          links.push(to.link);
        },
      },
      autoActor: () => P(OWNER),
      now: () => clock.t,
    },
  );
  const viewFile = join(root, 'access.json');
  writeFileSync(
    viewFile,
    JSON.stringify({
      v: 1,
      generated: new Date().toISOString(),
      seq: 1,
      owner: { principal: P(OWNER), emailTag: tag(OWNER.email) },
      authorized: {
        principals: [P(OWNER), P(TESTER)],
        emailTags: [tag(OWNER.email), tag(TESTER.email)],
      },
      revoked: { principals: [], emailTags: [] },
    }),
  );
  const access = new AccessView(viewFile, { pollMs: 10_000 });
  access.reload();
  cleanup.push(() => access.stop());
  const server: Server = createAdminServer(TEST_IDENTITY, {
    access,
    spool: null,
    capacity: async () => null,
    signups: wiring.signups,
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
  const owner = await gate(OWNER);
  const get = async (path: string, base = owner) => {
    const res = await fetch(`${base}${path}`);
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, body: JSON.parse(text) };
  };
  let n = 0;
  const add = async (web = true) => {
    const i = ++n;
    const out = await wiring.store.createIfNew(
      {
        name: `Tester ${i}`,
        email: `tester${i}@example.com`,
        role: 'Student',
        lang: 'en',
        consent: true,
      },
      web ? { origin: 'web' } : {},
    );
    const id = (out as { record: { id: string } }).record.id;
    return id;
  };
  const keys = () => loadVerifyKeys(keyFile);
  const mint = async (id: string) => {
    await wiring.verifier!.checkDirs(); // as the sweep does first
    return wiring.verifier!.mint(id, await keys());
  };
  /** Writes the admin state of a confirmation, as `consume` does. */
  const confirm = (id: string, email: string, at = clock.t) => {
    const f = join(stateDir, 'verify', `${id}.json`);
    const s = JSON.parse(readFileSync(f, 'utf8'));
    const iso = new Date(at).toISOString();
    writeFileSync(
      f,
      JSON.stringify({ ...s, usedAt: iso, verifiedAt: iso, verifiedAddr: addressHash(email) }),
    );
  };
  const rows = async (path = '/signups/open') => {
    const a = await get(path);
    expect(a.status).toBe(200);
    return new Map<string, { verification?: { state: string; sentAt?: string } }>(
      a.body.signups.map((r: { id: string }) => [r.id, r]),
    );
  };
  return {
    root,
    storeDir,
    stateDir,
    wiring,
    logs,
    links,
    clock,
    gate,
    get,
    add,
    mint,
    confirm,
    rows,
  };
}

const stateOf = (m: Awaited<ReturnType<Awaited<ReturnType<typeof rig>>['rows']>>, id: string) =>
  m.get(id)?.verification;

describe('S5: off', () => {
  it('nothing new without verification and caps: same answers, no dir created', async () => {
    const r = await rig({});
    const id = await r.add();
    await r.wiring.store.update(id, { verification: 'forged' } as never);
    const stored = await r.wiring.store.list();
    expect(r.wiring.signups.rowStates).toBeUndefined();
    for (const p of ['/signups', '/signups/open', '/signups/pending'])
      expect((await r.get(p)).text).toBe(`${JSON.stringify({ signups: stored })}\n`.trimEnd());
    expect((await r.get(STATUS)).body).toEqual({ enabled: false });
    expect(readdirSync(r.stateDir)).toEqual([]);
  });

  it('mail caps alone: rows unchanged, the status block has mail numbers only', async () => {
    const r = await rig({ caps: true });
    await r.add();
    expect((await r.get('/signups')).body.rowStates).toBeUndefined();
    expect((await r.get(STATUS)).body).toEqual({
      enabled: false,
      safeguards: {
        paused: false,
        mail: { day: 0, dayLimit: 95, d30: 0, d30Limit: 2700 },
      },
    });
    expect(readdirSync(r.stateDir)).toEqual([]);
  });
});

describe('mailHeld: the server says a queued mail is held by the pause', () => {
  it('only an auto-approved queued row, only while paused; a stored key is dropped; no write', async () => {
    const r = await rig();
    const queue = async (extra: object) => {
      const id = await r.add();
      await r.wiring.store.update(id, {
        status: 'email_queued',
        accountAdded: true,
        emailSendAfter: new Date(NOON).toISOString(),
        mailHeld: true,
        ...extra,
      } as never);
      return id;
    };
    const auto = await queue({ autoApprovedAt: new Date(NOON).toISOString() });
    const mine = await queue({});
    const held = async (path: string) =>
      new Map(
        (await r.get(path)).body.signups.map((x: { id: string; mailHeld?: unknown }) => [
          x.id,
          x.mailHeld,
        ]),
      );
    for (const p of ['/signups', '/signups/open']) {
      expect((await held(p)).get(auto)).toBeUndefined();
      expect((await held(p)).get(mine)).toBeUndefined();
    }
    writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '', { mode: 0o600 });
    const file = join(r.storeDir, `${auto}.json`);
    const before = readFileSync(file, 'utf8');
    for (const p of ['/signups', '/signups/open']) {
      expect((await held(p)).get(auto)).toBe(true);
      expect((await held(p)).get(mine)).toBeUndefined();
    }
    // Marking the lists wrote nothing.
    expect(readFileSync(file, 'utf8')).toBe(before);
    // The action answers carry the same mark (the route passes its record through this).
    const approver = r.wiring.signups.approver(P(OWNER));
    const out = await approver.resend(auto);
    expect(out).toMatchObject({ ok: true, note: 'email_held_paused' });
    expect(await approver.withMailHeld([out.record!])).toMatchObject([{ mailHeld: true }]);
  });
});

describe('S5: access', () => {
  it('anonymous 401, non-owner 403, status stays GET only, no-store', async () => {
    const r = await rig();
    for (const p of ['/signups', '/signups/open', STATUS]) {
      for (const [u, code] of [
        [null, 401],
        [TESTER, 403],
      ] as const) {
        const a = await r.get(p, await r.gate(u));
        expect(a.status).toBe(code);
        expect(a.text).not.toMatch(/verification|safeguards|rowStates/);
      }
      expect((await r.get(p)).headers.get('cache-control')).toContain('no-store');
    }
    const base = await r.gate(OWNER);
    const post = await fetch(`${base}${STATUS}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        'sec-fetch-site': 'same-origin',
      },
      body: '{}',
    });
    expect(post.status).toBe(405);
  });
});

describe('S5: row states', () => {
  it('not sent, failed send, sent with time; record mirrors and forged keys are ignored', async () => {
    const r = await rig({
      verify: true,
      caps: true,
      failSend: (e) => e.startsWith('tester2@'),
    });
    const none = await r.add();
    const failed = await r.add();
    const sent = await r.add();
    const other = await r.add(false);
    await r.wiring.store.update(none, {
      verifySentAt: new Date(NOON).toISOString(),
      verifiedAt: new Date(NOON).toISOString(),
      verification: { state: 'approved_auto', sentAt: 'SENTINEL' },
    } as never);
    await r.wiring.store.update(other, { verification: { state: 'sent' } } as never);
    // Before the first sweep there is no verify/ dir: unknown, and the GET creates none.
    expect(stateOf(await r.rows(), none)).toEqual({ state: 'unknown' });
    expect(existsSync(join(r.stateDir, 'verify'))).toBe(false);
    expect(await r.mint(failed)).toBe('send_failed');
    expect(await r.mint(sent)).toBe('sent');
    const m = await r.rows();
    expect(stateOf(m, none)).toEqual({ state: 'not_sent' });
    expect(stateOf(m, failed)).toEqual({ state: 'not_sent' });
    expect(stateOf(m, sent)).toEqual({ state: 'sent', sentAt: new Date(NOON).toISOString() });
    expect(stateOf(m, other)).toBeUndefined();
    expect((await r.get('/signups')).body.rowStates).toBe(1);
  });

  it('confirmed: queued, waiting for the limit, needs review, address changed', async () => {
    const r = await rig({ verify: true, caps: true, auto: 1 });
    const stop = r.wiring.startAutoApprove();
    cleanup.push(stop);
    await expect.poll(() => r.logs.some((l) => l.includes('cut-off recorded'))).toBe(true);
    r.clock.t += 1000;
    const a = await r.add();
    const b = await r.add();
    const c = await r.add();
    for (const id of [a, b, c]) expect(await r.mint(id)).toBe('sent');
    r.confirm(a, 'tester1@example.com');
    r.confirm(b, 'tester2@example.com', NOON - 2 * DAY); // before the cut-off
    r.confirm(c, 'someone-else@example.com');
    let m = await r.rows();
    expect(stateOf(m, a)).toEqual({ state: 'confirmed_queued' });
    expect(stateOf(m, b)).toEqual({ state: 'confirmed_review' });
    expect(stateOf(m, c)).toEqual({ state: 'address_changed' });
    // Today's single slot used by someone else.
    const f = join(r.stateDir, 'auto-approve.state.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), count: 1 }));
    m = await r.rows();
    expect(stateOf(m, a)).toEqual({ state: 'confirmed_waiting_limit' });
    expect(stateOf(m, b)).toEqual({ state: 'confirmed_review' });
    expect((await r.get(STATUS)).body.safeguards).toEqual({
      paused: false,
      verify: { today: 3, limit: 50, waiting: 2 },
      mail: { day: 3, dayLimit: 95, d30: 3, d30Limit: 2700 },
    });
    // An earlier failure and the kill switch: never "waiting for the limit".
    await r.wiring.store.update(a, { lastError: 'account_error' });
    expect(stateOf(await r.rows(), a)).toEqual({ state: 'confirmed_review' });
    await r.wiring.store.update(a, { lastError: null });
    writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '');
    expect(stateOf(await r.rows(), a)).toEqual({ state: 'confirmed_review' });
    expect((await r.get(STATUS)).body.safeguards.paused).toBe(true);
    await stop();
  });

  it('only as many rows are "queued" as today has free slots, oldest first', async () => {
    const r = await rig({ verify: true, caps: true, auto: 3 });
    const stop = r.wiring.startAutoApprove();
    cleanup.push(stop);
    await expect.poll(() => r.logs.some((l) => l.includes('cut-off recorded'))).toBe(true);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      r.clock.t += 1000;
      const id = await r.add();
      await r.mint(id);
      r.confirm(id, `tester${i}@example.com`);
      ids.push(id);
    }
    const states = async () => {
      const m = await r.rows();
      return ids.map((id) => stateOf(m, id)?.state);
    };
    expect(await states()).toEqual(['confirmed_queued', 'confirmed_queued', 'confirmed_queued']);
    const f = join(r.stateDir, 'auto-approve.state.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), count: 2 }));
    expect(await states()).toEqual([
      'confirmed_queued',
      'confirmed_waiting_limit',
      'confirmed_waiting_limit',
    ]);
    // Paused: they did confirm, and say so; none is promised an automatic approval.
    writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '');
    expect(await states()).toEqual(['confirmed_review', 'confirmed_review', 'confirmed_review']);
  });

  it('an unreadable count of today promises nothing: the queued rows need review', async () => {
    const r = await rig({ verify: true, caps: true });
    const id = await r.add();
    await r.mint(id);
    r.confirm(id, 'tester1@example.com');
    // The facts are readable, then the count is not (or the status itself fails).
    for (const status of [
      async () => ({ count: 'unknown' as const, dailyCap: 5 }),
      async () => Promise.reject(new Error('EIO')),
      async () => ({ count: 0, dailyCap: 5 }),
    ]) {
      const view = ownerView({
        storeDir: r.storeDir,
        store: r.wiring.store,
        verify: { stateDir: r.stateDir, maxPerDay: 50 },
        auto: {
          queueFacts: async () => ({ capReached: false, since: 0, eligible: () => true }),
          status,
        } as never,
        autoDir: r.stateDir,
        running: () => true,
        mail: null,
        pauseDir: r.stateDir,
        now: () => r.clock.t,
      });
      const [row] = await view.rows!();
      const readable = await status().then(
        (s) => typeof s.count === 'number',
        () => false,
      );
      expect(row!.verification).toEqual({
        state: readable ? 'confirmed_queued' : 'confirmed_review',
      });
    }
  });

  it('without a running auto-approver a confirmed row needs review', async () => {
    const r = await rig({ verify: true, caps: true });
    const id = await r.add();
    await r.mint(id);
    r.confirm(id, 'tester1@example.com');
    expect(stateOf(await r.rows(), id)).toEqual({ state: 'confirmed_review' });
  });

  it('a forged pending record with the auto mark keeps its real state', async () => {
    const r = await rig();
    const id = await r.add();
    await r.mint(id);
    await r.wiring.store.update(id, {
      accountAdded: true,
      autoApprovedAt: new Date(NOON).toISOString(),
    });
    expect(stateOf(await r.rows(), id)?.state).toBe('sent');
  });

  it('"sent" is never said about a different address than the record holds', async () => {
    const r = await rig();
    const id = await r.add();
    await r.mint(id);
    await r.wiring.store.update(id, { email: 'other@example.com' });
    expect(stateOf(await r.rows(), id)).toEqual({ state: 'address_changed' });
  });

  it('a state file holding null or a non-object is unknown', async () => {
    const r = await rig();
    const id = await r.add();
    await r.mint(id);
    for (const text of ['null', '0', '"x"', 'false', '[]']) {
      writeFileSync(join(r.stateDir, 'verify', `${id}.json`), text);
      expect(stateOf(await r.rows(), id), text).toEqual({ state: 'unknown' });
    }
  });

  it('approved automatically needs accountAdded and autoApprovedAt', async () => {
    const r = await rig();
    const id = await r.add();
    await r.wiring.store.update(id, { autoApprovedAt: new Date(NOON).toISOString() });
    expect(stateOf(await r.rows(), id)?.state).not.toBe('approved_auto');
    await r.wiring.store.update(id, { status: 'approved', accountAdded: true });
    expect(stateOf(await r.rows(), id)).toEqual({ state: 'approved_auto' });
    // BETA-G1: the owner's approver added the account (a failed automatic add before it).
    await r.wiring.store.update(id, { approvedBy: 'owner' });
    expect(stateOf(await r.rows(), id)?.state).not.toBe('approved_auto');
  });

  it('unreadable or unsafe state is unknown; list and actions still work; no secrets', async () => {
    const r = await rig();
    const bad = await r.add();
    const link = await r.add();
    const ok = await r.add();
    for (const id of [bad, link, ok]) await r.mint(id);
    const vdir = join(r.stateDir, 'verify');
    const state = JSON.parse(readFileSync(join(vdir, `${ok}.json`), 'utf8'));
    writeFileSync(join(vdir, `${bad}.json`), '{"SENTINEL":');
    rmSync(join(vdir, `${link}.json`));
    symlinkSync(join(vdir, `${ok}.json`), join(vdir, `${link}.json`));
    writeFileSync(join(vdir, 'mail-counters.json'), 'x');
    writeFileSync(join(r.stateDir, 'mail-gate.json'), 'x');
    const a = await r.get('/signups/open');
    const m = await r.rows();
    expect(stateOf(m, bad)).toEqual({ state: 'unknown' });
    expect(stateOf(m, link)).toEqual({ state: 'unknown' });
    expect(stateOf(m, ok)?.state).toBe('sent');
    const s = await r.get(STATUS);
    expect(s.body.safeguards).toEqual({
      paused: false,
      verify: { today: 'unknown', limit: 50, waiting: 'unknown' },
      mail: { day: 'unknown', dayLimit: 95, d30: 'unknown', d30Limit: 2700 },
    });
    const g = state.gens[0];
    for (const text of [a.text, s.text, r.logs.join('\n')])
      for (const secret of [
        g.hash,
        g.addr,
        g.kid,
        r.root,
        'site.example.invalid',
        'verifiedAddr',
        'SENTINEL',
        new URL(r.links.at(-1)!).hash.slice(9),
      ])
        expect(text).not.toContain(secret);
    expect(s.text).not.toMatch(/@|[0-9A-HJKMNP-TV-Z]{26}/);
    chmodSync(vdir, 0o777);
    expect(stateOf(await r.rows(), ok)).toEqual({ state: 'unknown' });
    chmodSync(vdir, 0o700);
    const base = await r.gate(OWNER);
    const rej = await fetch(`${base}/signups/${bad}/reject`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        'sec-fetch-site': 'same-origin',
      },
      body: '{}',
    });
    expect(rej.status).toBe(200);
  });
});

describe('S5: bounded work', () => {
  it('one list, one dir check, one state read per web pending row, at most 16 at once', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-bound-')));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const stateDir = join(root, 'state');
    mkdirSync(join(stateDir, 'verify'), { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const store = new PendingStore(join(root, 'p'));
    await store.init();
    const records = Array.from({ length: 300 }, (_, i) => ({
      id: `01J${String(i).padStart(23, '0')}`,
      status: i < 200 ? 'pending' : 'email_sent',
      origin: i < 250 && i % 2 === 0 ? 'web' : undefined,
      email: `t${i}@example.com`,
    }));
    const calls = { list: 0, dir: 0, peek: 0, open: 0, max: 0 };
    store.list = async () => {
      calls.list++;
      return records as never;
    };
    const view = ownerView({
      storeDir: join(root, 'p'),
      store,
      verify: { stateDir, maxPerDay: 50 },
      auto: null,
      autoDir: null,
      running: () => false,
      mail: null,
      pauseDir: stateDir,
      dirCheck: async () => {
        calls.dir++;
        return null;
      },
      peek: async (dir, id) => {
        calls.peek++;
        calls.max = Math.max(calls.max, ++calls.open);
        try {
          return await peekVerifyState(dir, id);
        } finally {
          calls.open--;
        }
      },
    });
    await Promise.all([view.rows!(), view.rows!(), view.rows!()]);
    expect(calls).toMatchObject({ list: 1, dir: 1, peek: 100 });
    expect(calls.max).toBeLessThanOrEqual(READS);
    Object.assign(calls, { list: 0, dir: 0, peek: 0 });
    await view.status();
    expect(calls).toMatchObject({ list: 1, dir: 1, peek: 100 });
  });

  it('coalesce never answers with a computation started before the call', async () => {
    let started = 0;
    let release!: () => void;
    const f = coalesce(async () => {
      const n = ++started;
      if (n === 1) await new Promise<void>((r) => (release = r));
      return n;
    });
    const first = f();
    await expect.poll(() => started).toBe(1);
    const later = [f(), f()];
    release();
    expect(await first).toBe(1);
    expect(await Promise.all(later)).toEqual([2, 2]);
  });
});
