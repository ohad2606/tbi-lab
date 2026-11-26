/**
 * K12 slice 1: server-side funnel counters (funnel/counters.ts) and their two sign-up hooks
 * (signup_submitted in the intake, signup_approved in the approver). Temporary directories and
 * fakes only; no network.
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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FUNNEL_DAY_CAP,
  FUNNEL_EVENTS,
  FUNNEL_FILE,
  FUNNEL_LOCK,
  FUNNEL_LOCK_RETRY_MS,
  FUNNEL_WRITE_INTERVAL_MS,
  FunnelCounters,
  funnelCountersFromEnv,
  parseFunnelFile,
  type FunnelEvent,
} from '../funnel/counters.js';
import { NonceCache, sign } from '../signup/hmac.js';
import { handleSignupRequest } from '../signup/http.js';
import { SlidingWindowLimiter } from '../signup/limits.js';
import { SignupApprover, SignupIntake } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of closers.splice(0)) await c();
  for (const d of roots.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function root(): string {
  const d = mkdtempSync(join(tmpdir(), 'tbi-funnel-'));
  roots.push(d);
  return d;
}

const T0 = Date.UTC(2026, 10, 24, 12);
const DAY = 86_400_000;

async function counters(opts: ConstructorParameters<typeof FunnelCounters>[1] = {}) {
  const dir = join(root(), 'f');
  const logs: string[] = [];
  let t = T0;
  const c = new FunnelCounters(dir, {
    now: () => t,
    log: (l) => logs.push(l),
    ...opts,
  });
  await c.init();
  closers.push(async () => c.stop());
  return {
    c,
    dir,
    logs,
    file: join(dir, FUNNEL_FILE),
    setNow: (v: number) => void (t = v),
  };
}

describe('funnel counters: store', () => {
  it('counts add up per UTC day and event; the file holds only days, events and integers', async () => {
    const s = await counters();
    expect(s.c.increment('signup_submitted')).toBe(true);
    expect(s.c.increment('signup_submitted')).toBe(true);
    expect(s.c.increment('signup_approved')).toBe(true);
    await s.c.flush();
    expect(await s.c.snapshot()).toEqual({
      v: 1,
      days: { '2026-11-24': { signup_submitted: 2, signup_approved: 1 } },
    });
    s.c.increment('signup_submitted');
    expect((await s.c.snapshot()).days['2026-11-24']!.signup_submitted).toBe(3);
    const raw = JSON.parse(readFileSync(s.file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['days', 'v']);
    expect(s.logs).toEqual([]);
  });

  it('day rollover starts a new day; earlier days are kept', async () => {
    const s = await counters();
    s.setNow(Date.UTC(2026, 10, 24, 23, 59, 59));
    s.c.increment('landing_view');
    s.setNow(Date.UTC(2026, 10, 25, 0, 0, 1));
    s.c.increment('landing_view');
    s.c.increment('landing_view');
    expect((await s.c.snapshot()).days).toEqual({
      '2026-11-24': { landing_view: 1 },
      '2026-11-25': { landing_view: 2 },
    });
  });

  it('an unknown event is rejected: not counted, nothing written, never throws', async () => {
    const s = await counters();
    for (const bad of ['page_view', '', 'signup_submitted ', '__proto__', 'x'.repeat(500)])
      expect(s.c.increment(bad as FunnelEvent)).toBe(false);
    expect(s.c.increment(null as unknown as FunnelEvent)).toBe(false);
    await s.c.flush();
    expect(existsSync(s.file)).toBe(false);
    expect(s.logs.join('\n')).toContain('funnel: increment refused (unknown_event)');
    expect(s.logs.join('\n')).not.toContain('page_view');
  });

  it('the allow-list is exactly the five K12 events', () => {
    expect([...FUNNEL_EVENTS]).toEqual([
      'landing_view',
      'signup_form_view',
      'signup_submitted',
      'signup_approved',
      'first_session',
    ]);
  });

  it('above the per-day per-event cap increments are silently not counted', async () => {
    const s = await counters({ cap: 3 });
    const results = Array.from({ length: 6 }, () => s.c.increment('signup_form_view'));
    expect(results).toEqual([true, true, true, false, false, false]);
    s.c.increment('landing_view');
    expect((await s.c.snapshot()).days['2026-11-24']).toEqual({
      signup_form_view: 3,
      landing_view: 1,
    });
    // Also across writes: the file value never exceeds the cap.
    s.c.increment('signup_form_view');
    await s.c.flush();
    expect((await s.c.snapshot()).days['2026-11-24']!.signup_form_view).toBe(3);
    expect(s.logs).toEqual([]);
    expect(FUNNEL_DAY_CAP).toBe(10_000);
  });

  it('days older than the kept window (400 days) are pruned on write', async () => {
    const s = await counters();
    s.c.increment('first_session');
    await s.c.flush();
    s.setNow(T0 + 399 * DAY);
    s.c.increment('first_session');
    expect(Object.keys((await s.c.snapshot()).days)).toHaveLength(2);
    s.setNow(T0 + 400 * DAY);
    s.c.increment('first_session');
    const days = (await s.c.snapshot()).days;
    expect(Object.keys(days)).toEqual([
      new Date(T0 + 399 * DAY).toISOString().slice(0, 10),
      new Date(T0 + 400 * DAY).toISOString().slice(0, 10),
    ]);
  });

  it('dir 0700, file 0600, no temp or lock file left behind', async () => {
    const s = await counters();
    s.c.increment('signup_submitted');
    await s.c.flush();
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(s.dir)).toEqual([FUNNEL_FILE]);
  });

  it('refuses to start on a directory group or others can access', async () => {
    for (const mode of [0o750, 0o705, 0o770, 0o701]) {
      const dir = join(root(), 'f');
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, mode);
      await expect(new FunnelCounters(dir).init()).rejects.toThrow('unsafe_dir');
    }
    // A refused store counts nothing (and writes nothing).
    const dir = join(root(), 'g');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const c = new FunnelCounters(dir);
    await c.init().catch(() => undefined);
    expect(c.increment('signup_submitted')).toBe(false);
    await c.flush();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a corrupt file is renamed aside (kept), logged once, and never silently reset in place', async () => {
    const s = await counters();
    const junk = '{"v":1,"days":{"2026-11-23":{"signup_submitted":"lots"}}}\n';
    writeFileSync(s.file, junk, { mode: 0o600 });
    await expect(s.c.snapshot()).rejects.toThrow('corrupt');
    // Snapshot does not touch it; the next write moves it aside first.
    expect(readFileSync(s.file, 'utf8')).toBe(junk);
    s.c.increment('signup_submitted');
    await s.c.flush();
    const aside = readdirSync(s.dir).filter((f) => f.startsWith(`${FUNNEL_FILE}.corrupt-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(s.dir, aside[0]!), 'utf8')).toBe(junk);
    expect((await s.c.snapshot()).days).toEqual({ '2026-11-24': { signup_submitted: 1 } });
    expect(s.logs).toEqual(['funnel: counters file unreadable, moved aside (corrupt)']);
  });

  it('the parser accepts only our exact format', () => {
    expect(parseFunnelFile('{"v":1,"days":{}}')).toEqual({});
    for (const bad of [
      '',
      'null',
      '[]',
      '{"v":2,"days":{}}',
      '{"v":1,"days":{},"ip":"x"}',
      '{"v":1,"days":{"yesterday":{}}}',
      '{"v":1,"days":{"2026-11-24":{"email":1}}}',
      '{"v":1,"days":{"2026-11-24":{"landing_view":-1}}}',
      '{"v":1,"days":{"2026-11-24":{"landing_view":1.5}}}',
      '{"v":1,"days":{"2026-11-24":{"landing_view":10001}}}',
    ])
      expect(parseFunnelFile(bad)).toBeNull();
  });

  it('an unwritable directory fails closed: increment still returns at once, logs the class only, keeps counts for later', async () => {
    const s = await counters();
    chmodSync(s.dir, 0o500);
    const t0 = performance.now();
    expect(s.c.increment('signup_submitted')).toBe(true);
    expect(performance.now() - t0).toBeLessThan(50);
    await s.c.flush();
    expect(s.logs).toEqual(['funnel: write failed (EACCES)']);
    // Writable again: the kept count is written with the next one.
    chmodSync(s.dir, 0o700);
    s.c.increment('signup_submitted');
    expect((await s.c.snapshot()).days['2026-11-24']!.signup_submitted).toBe(2);
  });

  it('a full disk (ENOSPC on write) fails closed and leaves no temp file', async () => {
    let full = true;
    const s = await counters({
      io: {
        open: (async (p: string, flags: string, mode: number) => {
          if (full && p.endsWith('.tmp'))
            throw Object.assign(new Error('no space /secret/path'), { code: 'ENOSPC' });
          return open(p, flags, mode);
        }) as typeof open,
      },
    });
    expect(s.c.increment('signup_approved')).toBe(true);
    await s.c.flush();
    expect(s.logs).toEqual(['funnel: write failed (ENOSPC)']);
    expect(readdirSync(s.dir)).toEqual([]);
    full = false;
    await s.c.flush();
    expect((await s.c.snapshot()).days['2026-11-24']!.signup_approved).toBe(1);
  });

  it('two writers sharing a directory do not lose each other’s counts; a stale lock is broken', async () => {
    const dir = join(root(), 'f');
    const a = new FunnelCounters(dir, { now: () => T0 });
    const b = new FunnelCounters(dir, { now: () => T0 });
    await a.init();
    await b.init();
    closers.push(async () => (a.stop(), b.stop()));
    for (let i = 0; i < 5; i++) {
      a.increment('signup_submitted');
      b.increment('signup_submitted');
    }
    // Lock contention is retried (100 ms timer); wait until both writers are done.
    for (let i = 0; i < 50; i++) {
      await Promise.all([a.flush(), b.flush()]);
      const snap = await a.snapshot().catch(() => null);
      if (snap?.days['2026-11-24']?.signup_submitted === 10) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await a.snapshot()).days['2026-11-24']!.signup_submitted).toBe(10);
    // A lock left by a crashed writer (mtime long ago) does not block for ever.
    const lock = join(dir, FUNNEL_LOCK);
    writeFileSync(lock, '', { mode: 0o600 });
    utimesSync(lock, (T0 - 3_600_000) / 1000, (T0 - 3_600_000) / 1000);
    const later = new FunnelCounters(dir, { now: () => T0 + 60_000 });
    await later.init();
    later.increment('signup_submitted');
    await later.flush();
    expect((await later.snapshot()).days['2026-11-24']!.signup_submitted).toBe(11);
    expect(readdirSync(dir)).toEqual([FUNNEL_FILE]);
  });

  it('kill switch: without TBI_FUNNEL_COUNTERS=1 nothing is created or written', async () => {
    const dir = join(root(), 'off');
    const logs: string[] = [];
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
      const env = { TBI_FUNNEL_DIR: dir, ...(v === undefined ? {} : { TBI_FUNNEL_COUNTERS: v }) };
      expect(await funnelCountersFromEnv(env, { log: (l) => logs.push(l) })).toBeNull();
    }
    expect(existsSync(dir)).toBe(false);
    expect(logs).toEqual([]);
  });

  it('enabled: needs an absolute TBI_FUNNEL_DIR; an unsafe dir turns only the counters off (one line, no path)', async () => {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    expect(await funnelCountersFromEnv({ TBI_FUNNEL_COUNTERS: '1' }, { log })).toBeNull();
    expect(
      await funnelCountersFromEnv({ TBI_FUNNEL_COUNTERS: '1', TBI_FUNNEL_DIR: 'rel/dir' }, { log }),
    ).toBeNull();
    const open_ = join(root(), 'open');
    mkdirSync(open_);
    chmodSync(open_, 0o777);
    expect(
      await funnelCountersFromEnv({ TBI_FUNNEL_COUNTERS: '1', TBI_FUNNEL_DIR: open_ }, { log }),
    ).toBeNull();
    expect(logs).toEqual([
      'funnel: counters off (config: TBI_FUNNEL_DIR must be an absolute path)',
      'funnel: counters off (config: TBI_FUNNEL_DIR must be an absolute path)',
      'funnel: counters off (unsafe_dir)',
    ]);
    const good = join(root(), 'good');
    const c = await funnelCountersFromEnv(
      { TBI_FUNNEL_COUNTERS: '1', TBI_FUNNEL_DIR: good },
      { log, now: () => T0 },
    );
    expect(c).not.toBeNull();
    c!.increment('landing_view');
    expect((await c!.snapshot()).days).toEqual({ '2026-11-24': { landing_view: 1 } });
    expect(logs.at(-1)).toBe('funnel: counters on');
    expect(logs.join('\n')).not.toContain(good);
  });
});

describe('funnel counters: write rate and cap', () => {
  /** Fake timers (and Date) with real file I/O; `writes()` = completed atomic writes. */
  async function timed(opts: { cap?: number; minWriteIntervalMs?: number } = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let renames = 0;
    let opens = 0;
    const s = await counters({
      ...opts,
      io: {
        open: (async (p: string, flags: string, mode: number) => {
          opens++;
          return open(p, flags, mode);
        }) as typeof open,
        rename: async (a, b) => {
          await rename(a, b);
          renames++;
        },
      },
    });
    /** Waits for the writes already queued, without forcing one. */
    const settled = () => (s.c as unknown as { chain: Promise<void> }).chain;
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await settled();
    };
    return { ...s, settled, advance, writes: () => renames, opens: () => opens };
  }

  it('a burst causes at most one write per interval (default 5 s)', async () => {
    expect(FUNNEL_WRITE_INTERVAL_MS).toBe(5_000);
    const s = await timed();
    s.c.increment('landing_view');
    await s.settled();
    expect(s.writes()).toBe(1); // the first one is not delayed
    for (let i = 0; i < 100; i++) s.c.increment('landing_view');
    await s.advance(4_999);
    expect(s.writes()).toBe(1);
    await s.advance(1);
    expect(s.writes()).toBe(2);
    expect(readFileSync(s.file, 'utf8')).toContain('"landing_view":101');
    // Steady traffic, one increment per 100 ms for 20 s: one write per 5 s.
    for (let i = 0; i < 200; i++) {
      s.c.increment('landing_view');
      await s.advance(100);
    }
    expect(s.writes()).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('increments during a write wait for the next interval', async () => {
    const s = await timed();
    s.c.increment('landing_view');
    await Promise.resolve(); // the write has started
    s.c.increment('landing_view');
    await s.settled();
    expect(s.writes()).toBe(1);
    await s.advance(5_000);
    expect(s.writes()).toBe(2);
  });

  it('flush writes at once and clears the delay timer', async () => {
    const s = await timed();
    s.c.increment('signup_submitted');
    await s.settled();
    s.c.increment('signup_submitted');
    expect(vi.getTimerCount()).toBe(1);
    await s.c.flush(); // no time passes
    expect(s.writes()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(readFileSync(s.file, 'utf8')).toContain('"signup_submitted":2');
  });

  it('a busy lock is retried after 100 ms, not after the write interval', async () => {
    const s = await timed();
    const lock = join(s.dir, FUNNEL_LOCK);
    writeFileSync(lock, '', { mode: 0o600 });
    utimesSync(lock, T0 / 1000, T0 / 1000);
    s.c.increment('signup_submitted');
    await s.settled();
    const opens = s.opens();
    for (let i = 0; i < 50; i++) s.c.increment('signup_submitted');
    await s.settled();
    expect(s.opens()).toBe(opens); // no extra lock attempts while the retry is pending
    rmSync(lock);
    await s.advance(FUNNEL_LOCK_RETRY_MS);
    expect(s.writes()).toBe(1);
    expect(readFileSync(s.file, 'utf8')).toContain('"signup_submitted":51');
  });

  it('over-cap increments are refused and cause no write and no timer', async () => {
    const s = await timed({ cap: 3 });
    for (let i = 0; i < 3; i++) s.c.increment('signup_form_view');
    await s.c.flush();
    const opens = s.opens();
    for (let i = 0; i < 100; i++) expect(s.c.increment('signup_form_view')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await s.advance(60_000);
    await s.c.flush();
    expect([s.writes(), s.opens()]).toEqual([1, opens]);
  });

  it('increments during the write that reaches the cap are refused', async () => {
    const s = await timed({ cap: 2 });
    s.c.increment('landing_view');
    s.c.increment('landing_view');
    await Promise.resolve(); // the write has started
    expect(s.c.increment('landing_view')).toBe(false);
    await s.settled();
    expect(s.c.increment('landing_view')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a cap filled by another writer (or before a restart) is learned without writing', async () => {
    const s = await timed({ cap: 3 });
    const full = '{"v":1,"days":{"2026-11-24":{"signup_form_view":3}}}\n';
    writeFileSync(s.file, full, { mode: 0o600 });
    expect(s.c.increment('signup_form_view')).toBe(true); // not known yet
    await s.c.flush();
    expect(s.writes()).toBe(0);
    expect(s.c.increment('signup_form_view')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(readFileSync(s.file, 'utf8')).toBe(full);
    // The next day counts again.
    s.setNow(T0 + DAY);
    expect(s.c.increment('signup_form_view')).toBe(true);
  });
});

// ---------------------------------------------------------------- hooks

const SECRET = Buffer.from('test-secret-not-real-0123456789abcdef');
const GOOD = {
  name: 'Dana Levi',
  email: 'dana@example.com',
  role: 'Teacher',
  lang: 'he' as const,
  consent: true as const,
};
function signed(body: unknown, now: number, nonce: string) {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = Math.floor(now / 1000);
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-tbi-timestamp': String(ts),
      'x-tbi-nonce': nonce,
      'x-tbi-signature': sign(SECRET, ts, nonce, raw),
    },
  };
}

async function intakeWith(sink: ConstructorParameters<typeof SignupIntake>[0]['counters']) {
  const store = new PendingStore(join(root(), 'p'), { now: () => T0, maxRecords: 100 });
  await store.init();
  const logs: string[] = [];
  const intake = new SignupIntake({
    secret: SECRET,
    store,
    notifier: null,
    now: () => T0,
    sourceRate: new SlidingWindowLimiter({ count: 100, windowMs: 60_000 }, () => T0),
    globalRate: new SlidingWindowLimiter({ count: 100, windowMs: 60_000 }, () => T0),
    nonces: new NonceCache(),
    log: (l) => logs.push(l),
    counters: sink ?? null,
  });
  return { store, intake, logs };
}

describe('funnel hooks', () => {
  it('signup_submitted: counted once per NEW request (not duplicates, not refusals); nothing personal in the file', async () => {
    const s = await counters();
    const i = await intakeWith(s.c);
    const a = signed(GOOD, T0, 'a'.repeat(20));
    expect((await i.intake.submit('203.0.113.7', a.headers, a.raw)).status).toBe(202);
    const dup = signed(GOOD, T0, 'b'.repeat(20));
    expect((await i.intake.submit('203.0.113.7', dup.headers, dup.raw)).status).toBe(202);
    const bad = signed({ ...GOOD, consent: false }, T0, 'c'.repeat(20));
    expect((await i.intake.submit('203.0.113.7', bad.headers, bad.raw)).status).toBe(400);
    expect((await i.intake.submit('203.0.113.7', {}, a.raw)).status).toBe(401);
    const b = signed({ ...GOOD, email: 'other@example.com' }, T0, 'd'.repeat(20));
    expect((await i.intake.submit('203.0.113.7', b.headers, b.raw)).status).toBe(202);
    expect((await s.c.snapshot()).days).toEqual({ '2026-11-24': { signup_submitted: 2 } });
    const text = readFileSync(s.file, 'utf8');
    for (const secret of ['dana', 'example.com', 'Dana', 'Teacher', '203.0.113', 'other'])
      expect(text).not.toContain(secret);
    expect(s.logs).toEqual([]);
  });

  it('a counter that throws or a store that fails never fails the sign-up', async () => {
    const i = await intakeWith({
      increment: () => {
        throw new Error('boom');
      },
    });
    const a = signed(GOOD, T0, 'a'.repeat(20));
    expect(await i.intake.submit('x', a.headers, a.raw)).toEqual({ status: 202 });
    expect(await i.store.list()).toHaveLength(1);
    // Real counters on an unwritable directory: the request is stored, the count is not.
    const s = await counters();
    chmodSync(s.dir, 0o500);
    const j = await intakeWith(s.c);
    const b = signed(GOOD, T0, 'b'.repeat(20));
    expect(await j.intake.submit('x', b.headers, b.raw)).toEqual({ status: 202 });
    expect(await j.store.list()).toHaveLength(1);
    await s.c.flush();
    expect(s.logs).toEqual(['funnel: write failed (EACCES)']);
  });

  it('signup_approved: counted once per request, when the account is added (repeat, cap and failures not counted)', async () => {
    const s = await counters();
    const store = new PendingStore(join(root(), 'p'), { now: () => T0 });
    await store.init();
    let outcome: 'done' | 'cap_reached' = 'cap_reached';
    const approver = new SignupApprover({
      store,
      accounts: { add: async () => outcome },
      email: { sendApproval: async () => undefined },
      now: () => T0,
      counters: s.c,
    });
    const r = await store.create({ ...GOOD });
    expect((await approver.approve(r.id)).ok).toBe(false); // cap: back to pending
    outcome = 'done';
    expect((await approver.approve(r.id)).ok).toBe(true);
    expect((await approver.approve(r.id)).ok).toBe(true); // already_done
    const other = await store.create({ ...GOOD, email: 'b@example.com' });
    await approver.reject(other.id);
    expect((await s.c.snapshot()).days).toEqual({ '2026-11-24': { signup_approved: 1 } });
  });

  it('the intake HTTP answers never set a cookie', async () => {
    const s = await counters();
    const i = await intakeWith(s.c);
    const server: Server = createServer(
      (req, res) => void handleSignupRequest(req, res, i.intake, 'x-forwarded-for'),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/signup`;
    const a = signed(GOOD, T0, 'a'.repeat(20));
    const answers = [
      await fetch(base, { method: 'POST', headers: a.headers, body: a.raw }), // 202
      await fetch(base, { method: 'POST', headers: a.headers, body: a.raw }), // replay 401
      await fetch(base, { method: 'GET' }), // 405
      await fetch(base, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }), // 415
    ];
    expect(answers.map((r) => r.status)).toEqual([202, 401, 405, 415]);
    for (const r of answers) {
      expect(r.headers.get('set-cookie')).toBeNull();
      expect(r.headers.getSetCookie()).toEqual([]);
      await r.text();
    }
    expect((await s.c.snapshot()).days).toEqual({ '2026-11-24': { signup_submitted: 1 } });
  });
});
