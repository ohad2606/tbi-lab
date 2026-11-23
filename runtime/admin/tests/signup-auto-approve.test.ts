/** BETA-G1: auto-approve with a daily cap and a kill switch. Real temp store; fakes for the account path and mail. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_COUNTER_FILE,
  AUTO_PAUSE_FILE,
  AutoApprover,
  autoApproveConfigFromEnv,
  autoPauseCheck,
  israelDay,
} from '../signup/autoApprove.js';
import { signupWiringFromEnv, wireSignupAdmin } from '../signup/admin-wiring.js';
import type { EmailSender } from '../signup/email.js';
import type { FetchLike } from '../signup/notify.js';
import { parseQuiet } from '../signup/quietHours.js';
import { SignupApprover, type AccountAdder, type AddOutcome } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';
import type { AdminSpool } from '../accounts.js';
import type { Principal } from '../../identity/principal.js';

const NOON_IL = Date.parse('2026-11-23T10:00:00Z'); // 12:00 Israel (winter, UTC+2)
const person = (i: number) => ({
  name: `Tester ${i}`,
  email: `tester${i}@example.com`,
  role: 'Student',
  lang: 'en' as const,
  consent: true as const,
});

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** Every log line written by the code under test, checked for personal data at the end of each test. */
const allLogs: string[] = [];
afterEach(() => {
  for (const l of allLogs.splice(0)) {
    expect(l).not.toMatch(/@|example\.com|Tester|[0-9A-HJKMNP-TV-Z]{26}|\/tmp\//);
  }
});

interface Rig {
  dir: string;
  store: PendingStore;
  clock: { t: number };
  added: string[];
  mails: string[];
  logs: string[];
  addAnswers: AddOutcome[];
  auto: (
    o?: Partial<{ cap: number; stat: (p: string) => Promise<unknown>; noOwner: boolean }>,
  ) => AutoApprover;
  manual: () => SignupApprover;
  onAdd?: () => void;
}

async function rig(opts: { quiet?: string } = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'tbi-g1-auto-'));
  roots.push(root);
  const dir = join(root, 'p');
  const clock = { t: NOON_IL };
  const now = () => clock.t;
  const store = new PendingStore(dir, { now, maxRecords: 1000 });
  await store.init();
  const r: Rig = {
    dir,
    store,
    clock,
    added: [],
    mails: [],
    logs: [],
    addAnswers: [],
    auto: () => null as never,
    manual: () => null as never,
  };
  const accounts: AccountAdder = {
    add: async (email): Promise<AddOutcome> => {
      r.onAdd?.();
      const a = r.addAnswers.shift() ?? 'done';
      if (a === 'done') r.added.push(email);
      return a;
    },
  };
  const email: EmailSender = {
    sendApproval: async (to) => {
      r.mails.push(to.id);
    },
  };
  const quiet = opts.quiet ? parseQuiet(opts.quiet) : null;
  const log = (l: string) => {
    r.logs.push(l);
    allLogs.push(l);
  };
  r.manual = () => new SignupApprover({ store, accounts, email, quiet, now, log });
  r.auto = (o = {}) =>
    new AutoApprover({
      dir,
      store,
      dailyCap: o.cap ?? 3,
      now,
      log,
      ...(o.stat ? { stat: o.stat } : {}),
      approver: () =>
        o.noOwner
          ? null
          : new SignupApprover({ store, accounts, email, quiet, now, log, actor: 'auto' }),
    });
  return r;
}

const counter = (dir: string) =>
  JSON.parse(readFileSync(join(dir, AUTO_COUNTER_FILE), 'utf8')) as { day: string; count: number };
const auditLines = (dir: string) =>
  existsSync(join(dir, 'audit.log'))
    ? readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n')
    : [];

/** Creates n requests one second apart, ending just before the current clock (FIFO order is by createdAt). */
async function createN(r: Rig, n: number) {
  const ids: string[] = [];
  const base = r.clock.t;
  for (let i = 0; i < n; i++) {
    r.clock.t = base - (n - i) * 1000;
    ids.push((await r.store.createIfNew(person(i))).record.id);
  }
  r.clock.t = base;
  return ids;
}

describe('config (off by default)', () => {
  it('unset or empty = off, silently; only exactly 1 with a valid cap enables', () => {
    expect(autoApproveConfigFromEnv({})).toEqual({ enabled: false, reason: expect.any(String) });
    expect(autoApproveConfigFromEnv({ TBI_SIGNUP_AUTO_APPROVE: '' }).enabled).toBe(false);
    expect(autoApproveConfigFromEnv({ TBI_SIGNUP_AUTO_APPROVE: '' })).not.toHaveProperty('error');
    expect(
      autoApproveConfigFromEnv({ TBI_SIGNUP_AUTO_APPROVE: '1', TBI_SIGNUP_AUTO_DAILY_CAP: '50' }),
    ).toEqual({ enabled: true, dailyCap: 50 });
    for (const [flag, cap] of [
      ['true', '50'],
      ['yes', '50'],
      ['1', undefined],
      ['1', ''],
      ['1', '0'],
      ['1', '1001'],
      ['1', '1.5'],
      ['1', '-3'],
      ['1', ' 5'],
      ['1', 'abc'],
    ] as const) {
      const r = autoApproveConfigFromEnv({
        TBI_SIGNUP_AUTO_APPROVE: flag,
        ...(cap !== undefined ? { TBI_SIGNUP_AUTO_DAILY_CAP: cap } : {}),
      });
      expect(r).toMatchObject({ enabled: false, error: true });
    }
    expect(
      autoApproveConfigFromEnv({ TBI_SIGNUP_AUTO_APPROVE: '1', TBI_SIGNUP_AUTO_DAILY_CAP: '1000' }),
    ).toEqual({ enabled: true, dailyCap: 1000 });
  });
});

describe('flag off: today behaviour unchanged', () => {
  const baseEnv = (root: string) => ({
    TBI_SIGNUP_ADMIN: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_RESEND_KEY_FILE: join(root, 'key'),
    TBI_SIGNUP_FROM: 'TBI Lab <support@example.com>',
    TBI_SIGNUP_LAB_URL: 'https://lab.example.com/',
    TBI_SIGNUP_QUIET: 'off',
  });
  const io = (logs: string[]) => ({
    fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
    log: (l: string) => logs.push(l),
    email: { sendApproval: async () => undefined } as EmailSender,
    autoActor: () => 'p_ownerownerownerownerowner' as Principal,
  });

  it('no auto vars: no sweeper, start is a no-op, no file written, record untouched, no log line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tbi-g1-off-'));
    roots.push(root);
    const logs: string[] = [];
    const w = await signupWiringFromEnv(baseEnv(root), {} as AdminSpool, io(logs));
    expect(w).not.toBeNull();
    expect(w!.auto).toBeNull();
    const rec = (await w!.store.createIfNew(person(1))).record;
    const before = readFileSync(join(root, 'p', `${rec.id}.json`), 'utf8');
    const filesBefore = readdirSync(join(root, 'p')).sort();
    const stop = w!.startAutoApprove();
    await stop();
    expect(readFileSync(join(root, 'p', `${rec.id}.json`), 'utf8')).toBe(before);
    expect(readdirSync(join(root, 'p')).sort()).toEqual(filesBefore);
    expect(before).not.toContain('autoApprovedAt');
    expect(logs.filter((l) => /auto/.test(l))).toEqual([]);
  });

  it('a malformed flag leaves auto-approve off (one log line) and manual routes on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tbi-g1-bad-'));
    roots.push(root);
    const logs: string[] = [];
    const w = await signupWiringFromEnv(
      { ...baseEnv(root), TBI_SIGNUP_AUTO_APPROVE: 'yes', TBI_SIGNUP_AUTO_DAILY_CAP: '5' },
      {} as AdminSpool,
      io(logs),
    );
    expect(w).not.toBeNull();
    expect(w!.auto).toBeNull();
    expect(logs.filter((l) => /auto-approve off \(config/.test(l))).toHaveLength(1);
    allLogs.push(...logs);
  });

  it('manual approve writes the same audit line as before (no actor tag) and no counter file', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    expect(await r.manual().approve(id!)).toMatchObject({ ok: true });
    expect(auditLines(r.dir)).toEqual([`${new Date(NOON_IL).toISOString()} ${id} approve ok`]);
    expect(existsSync(join(r.dir, AUTO_COUNTER_FILE))).toBe(false);
    expect(readFileSync(join(r.dir, `${id}.json`), 'utf8')).not.toContain('autoApprovedAt');
  });
});

describe('happy path', () => {
  it('a validated pending request is approved through the owner path: account, mail, audit actor=auto', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    const out = await r.auto().sweep();
    expect(out).toEqual({ claimed: 1, attempted: 1 });
    expect(r.added).toEqual(['tester0@example.com']);
    expect(r.mails).toEqual([id]);
    const rec = await r.store.get(id!);
    expect(rec).toMatchObject({
      status: 'email_sent',
      accountAdded: true,
      emailAttempts: 1,
      autoApprovedAt: new Date(NOON_IL).toISOString(),
    });
    expect(auditLines(r.dir)).toEqual([
      `${new Date(NOON_IL).toISOString()} ${id} approve ok actor=auto`,
    ]);
    expect(counter(r.dir)).toEqual({ v: 1, day: '2026-11-23', count: 1 });
  });

  it('inside quiet hours the account is added and the mail is queued (sent by the existing drain)', async () => {
    const r = await rig({ quiet: '23:00-08:00' });
    r.clock.t = Date.parse('2026-11-23T21:30:00Z'); // 23:30 Israel
    const [id] = await createN(r, 1);
    await r.auto().sweep();
    expect(r.mails).toEqual([]);
    expect(await r.store.get(id!)).toMatchObject({ status: 'email_queued', accountAdded: true });
    expect(counter(r.dir).day).toBe('2026-11-23');
    r.clock.t = Date.parse('2026-11-24T06:01:00Z'); // 08:01 Israel
    expect(await r.manual().drainEmails()).toBe(1);
    expect(r.mails).toEqual([id]);
  });

  it('rejected, owner-approved and earlier-failed requests are not touched', async () => {
    const r = await rig();
    const [a, b, c] = await createN(r, 3);
    await r.manual().reject(a!);
    await r.manual().approve(b!);
    await r.store.update(c!, { lastError: 'cap_reached' });
    const out = await r.auto().sweep();
    expect(out.claimed).toBe(0);
    expect((await r.store.get(c!)).status).toBe('pending');
    expect(existsSync(join(r.dir, AUTO_COUNTER_FILE))).toBe(false);
  });
});

describe('daily cap boundary (cap 3)', () => {
  for (const [n, expectApproved] of [
    [2, 2],
    [3, 3],
    [4, 3],
  ] as const) {
    it(`${n} pending -> ${expectApproved} approved, the rest stay pending`, async () => {
      const r = await rig();
      const ids = await createN(r, n);
      const a = r.auto({ cap: 3 });
      const out = await a.sweep();
      expect(out.claimed).toBe(expectApproved);
      expect(out.stopped).toBe(n > 3 ? 'cap' : undefined);
      expect(r.mails).toEqual(ids.slice(0, expectApproved)); // oldest first
      expect(counter(r.dir).count).toBe(expectApproved);
      for (const id of ids.slice(expectApproved)) {
        const rec = await r.store.get(id);
        expect(rec.status).toBe('pending');
        expect(rec.autoApprovedAt).toBeUndefined();
      }
      // A second sweep the same day changes nothing and does not repeat the cap line.
      await a.sweep();
      expect(r.mails).toHaveLength(expectApproved);
      expect(r.logs.filter((l) => /daily cap reached/.test(l))).toHaveLength(n > 3 ? 1 : 0);
    });
  }

  it('the owner can still approve a waitlisted request by hand (not counted)', async () => {
    const r = await rig();
    const ids = await createN(r, 2);
    await r.auto({ cap: 1 }).sweep();
    expect(await r.manual().approve(ids[1]!)).toMatchObject({ ok: true });
    expect(counter(r.dir).count).toBe(1);
    expect(r.mails).toEqual(ids);
  });
});

describe('Israel calendar day and rollover', () => {
  it('israelDay follows Asia/Jerusalem including both DST edges of 2026', () => {
    // Winter (UTC+2)
    expect(israelDay(Date.parse('2026-11-23T21:59:59Z'))).toBe('2026-11-23');
    expect(israelDay(Date.parse('2026-11-23T22:00:00Z'))).toBe('2026-11-24');
    // DST starts Fri 2026-03-27 02:00 -> 03:00. Midnight before it is UTC+2, midnight after is UTC+3.
    expect(israelDay(Date.parse('2026-03-26T21:59:59Z'))).toBe('2026-03-26');
    expect(israelDay(Date.parse('2026-03-26T22:00:00Z'))).toBe('2026-03-27');
    expect(israelDay(Date.parse('2026-03-27T20:59:59Z'))).toBe('2026-03-27');
    expect(israelDay(Date.parse('2026-03-27T21:00:00Z'))).toBe('2026-03-28');
    // DST ends Sun 2026-10-25 02:00 -> 01:00 (a 25-hour day).
    expect(israelDay(Date.parse('2026-10-24T20:59:59Z'))).toBe('2026-10-24');
    expect(israelDay(Date.parse('2026-10-24T21:00:00Z'))).toBe('2026-10-25');
    expect(israelDay(Date.parse('2026-10-25T21:59:59Z'))).toBe('2026-10-25');
    expect(israelDay(Date.parse('2026-10-25T22:00:00Z'))).toBe('2026-10-26');
  });

  it('the cap resets at Israel midnight, not at UTC midnight', async () => {
    const r = await rig();
    const ids = await createN(r, 3);
    const a = r.auto({ cap: 1 });
    r.clock.t = Date.parse('2026-11-23T21:59:00Z'); // 23:59 Israel
    expect((await a.sweep()).claimed).toBe(1);
    r.clock.t = Date.parse('2026-11-23T22:00:30Z'); // 00:00:30 Israel next day, still 23-11 in UTC
    expect((await a.sweep()).claimed).toBe(1);
    expect(counter(r.dir)).toMatchObject({ day: '2026-11-24', count: 1 });
    r.clock.t = Date.parse('2026-11-24T21:00:00Z'); // 23:00 Israel, same Israel day
    expect((await a.sweep()).claimed).toBe(0);
    expect(r.mails).toEqual(ids.slice(0, 2));
  });

  it('DST end day (25 h): one cap for the whole Israel day, reset at the next Israel midnight', async () => {
    const r = await rig();
    await createN(r, 3);
    const a = r.auto({ cap: 1 });
    r.clock.t = Date.parse('2026-10-24T21:00:00Z'); // 00:00 Israel 25-10 (still UTC+3)
    expect((await a.sweep()).claimed).toBe(1);
    r.clock.t = Date.parse('2026-10-25T21:30:00Z'); // 23:30 Israel 25-10 (now UTC+2)
    expect((await a.sweep()).claimed).toBe(0);
    r.clock.t = Date.parse('2026-10-25T22:00:00Z'); // 00:00 Israel 26-10
    expect((await a.sweep()).claimed).toBe(1);
    expect(counter(r.dir)).toMatchObject({ day: '2026-10-26', count: 1 });
  });
});

describe('kill switch', () => {
  it('present: nothing approved; removed: resumes without a restart; transitions logged', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    const a = r.auto();
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    expect(await a.sweep()).toMatchObject({ claimed: 0, stopped: 'paused' });
    expect((await r.store.get(id!)).status).toBe('pending');
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect((await a.sweep()).claimed).toBe(1);
    expect(r.logs).toEqual(
      expect.arrayContaining(['signup: auto-approve paused', 'signup: auto-approve resumed']),
    );
  });

  it('absent: not paused', async () => {
    const r = await rig();
    expect(await autoPauseCheck(join(r.dir, AUTO_PAUSE_FILE))).toEqual({ paused: false });
  });

  it('a dangling symlink, a symlink to a file and a directory all count as paused (lstat, not followed)', async () => {
    const r = await rig();
    const p = join(r.dir, AUTO_PAUSE_FILE);
    symlinkSync(join(r.dir, 'does-not-exist'), p);
    expect(await autoPauseCheck(p)).toEqual({ paused: true });
    rmSync(p);
    writeFileSync(join(r.dir, 'target'), '');
    symlinkSync(join(r.dir, 'target'), p);
    expect(await autoPauseCheck(p)).toEqual({ paused: true });
    rmSync(p);
    mkdirSync(p);
    expect(await autoPauseCheck(p)).toEqual({ paused: true });
  });

  it('EACCES / ENOTDIR / non-errno errors fail closed, each code logged once, no path in the log', async () => {
    const r = await rig();
    await createN(r, 1);
    let code: string | undefined = 'EACCES';
    const stat = async () => {
      const e = new Error(`EACCES: permission denied, lstat '${r.dir}/x'`) as NodeJS.ErrnoException;
      if (code !== undefined) e.code = code;
      throw e;
    };
    const a = r.auto({ stat });
    expect((await a.sweep()).stopped).toBe('paused');
    expect((await a.sweep()).stopped).toBe('paused');
    code = 'ENOTDIR';
    expect((await a.sweep()).stopped).toBe('paused');
    code = undefined;
    expect((await a.sweep()).stopped).toBe('paused');
    const errLines = r.logs.filter((l) => /pause check failed/.test(l));
    expect(errLines).toEqual([
      'signup: auto-approve pause check failed (EACCES); treated as paused',
      'signup: auto-approve pause check failed (ENOTDIR); treated as paused',
      'signup: auto-approve pause check failed (unknown); treated as paused',
    ]);
    expect(r.added).toEqual([]);
  });

  it('a real EACCES (unreadable parent directory) fails closed', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const root = mkdtempSync(join(tmpdir(), 'tbi-g1-eacces-'));
    roots.push(root);
    const locked = join(root, 'locked');
    mkdirSync(locked, { mode: 0o700 });
    chmodSync(locked, 0o000);
    try {
      expect(await autoPauseCheck(join(locked, AUTO_PAUSE_FILE))).toEqual({
        paused: true,
        error: 'EACCES',
      });
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('switched on mid-sweep: the next request is not claimed', async () => {
    const r = await rig();
    const ids = await createN(r, 3);
    r.onAdd = () => writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    const out = await r.auto({ cap: 10 }).sweep();
    expect(out).toMatchObject({ claimed: 1, stopped: 'paused' });
    expect((await r.store.get(ids[1]!)).status).toBe('pending');
    expect(counter(r.dir).count).toBe(1);
  });
});

describe('idempotency, double submit, concurrency, restart', () => {
  it('a double submit of the same address gives one record and one approval', async () => {
    const r = await rig();
    const [x, y] = await Promise.all([
      r.store.createIfNew(person(7)),
      r.store.createIfNew(person(7)),
    ]);
    expect([x.created, y.created].sort()).toEqual([false, true]);
    const a = r.auto();
    await a.sweep();
    await a.sweep();
    expect(r.added).toEqual(['tester7@example.com']);
    expect(r.mails).toHaveLength(1);
    expect(counter(r.dir).count).toBe(1);
  });

  it('owner Approve racing the sweep: one account add, one mail', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    await Promise.all([r.auto().sweep(), r.manual().approve(id!), r.manual().approve(id!)]);
    expect(r.added).toHaveLength(1);
    expect(r.mails).toEqual([id]);
    expect((await r.store.get(id!)).status).toBe('email_sent');
  });

  it('two sweepers on one store, concurrently: exactly the cap, each request once', async () => {
    const r = await rig();
    await createN(r, 8);
    const a = r.auto({ cap: 5 });
    const b = r.auto({ cap: 5 });
    const outs = await Promise.all([a.sweep(), b.sweep(), a.sweep()]);
    expect(outs.reduce((s, o) => s + o.claimed, 0)).toBe(5);
    expect(new Set(r.added).size).toBe(5);
    expect(r.added).toHaveLength(5);
    expect(new Set(r.mails).size).toBe(5);
    expect(counter(r.dir).count).toBe(5);
  });

  it("restart: a new store and sweeper on the same directory keep today's count", async () => {
    const r = await rig();
    await createN(r, 4);
    expect((await r.auto({ cap: 2 }).sweep()).claimed).toBe(2);
    const store2 = new PendingStore(r.dir, { now: () => r.clock.t });
    await store2.init();
    const again = new AutoApprover({
      dir: r.dir,
      store: store2,
      dailyCap: 2,
      now: () => r.clock.t,
      approver: () => r.manual(),
    });
    expect(await again.todayCount()).toBe(2);
    expect((await again.sweep()).stopped).toBe('cap');
    expect(r.added).toHaveLength(2);
  });

  it('an unreadable counter fails closed (cap reached), logged, never reset', async () => {
    const r = await rig();
    await createN(r, 1);
    writeFileSync(join(r.dir, AUTO_COUNTER_FILE), '{not json', { mode: 0o600 });
    const out = await r.auto().sweep();
    expect(out).toMatchObject({ claimed: 0, stopped: 'counter_unreadable' });
    expect(readFileSync(join(r.dir, AUTO_COUNTER_FILE), 'utf8')).toBe('{not json');
    expect(r.logs.some((l) => /counter unreadable \(corrupt\)/.test(l))).toBe(true);
    expect(r.added).toEqual([]);
  });

  it('helper had not answered (account_pending): retried by the next sweep without a new slot', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    r.addAnswers.push('pending');
    const a = r.auto({ cap: 1 });
    expect(await a.sweep()).toEqual({ claimed: 1, attempted: 1 });
    expect((await r.store.get(id!)).status).toBe('approved');
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 1 });
    expect((await r.store.get(id!)).status).toBe('email_sent');
    expect(counter(r.dir).count).toBe(1);
    expect(r.mails).toEqual([id]);
  });

  it('helper cap_reached on an auto attempt: stays pending for the owner, never retried automatically', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    r.addAnswers.push('cap_reached');
    const a = r.auto();
    await a.sweep();
    await a.sweep();
    expect(await r.store.get(id!)).toMatchObject({ status: 'pending', lastError: 'cap_reached' });
    expect(auditLines(r.dir)).toEqual([
      `${new Date(NOON_IL).toISOString()} ${id} approve cap_reached actor=auto`,
    ]);
    expect(r.addAnswers).toEqual([]);
  });

  it('no owner principal recorded: waits (manual only), logs once', async () => {
    const r = await rig();
    await createN(r, 1);
    const a = r.auto({ noOwner: true });
    expect((await a.sweep()).stopped).toBe('no_owner');
    expect((await a.sweep()).stopped).toBe('no_owner');
    expect(r.logs.filter((l) => /owner principal not recorded/.test(l))).toHaveLength(1);
    expect(existsSync(join(r.dir, AUTO_COUNTER_FILE))).toBe(false);
  });
});

describe('wiring with the flag on', () => {
  it('submits the account request as the recorded owner principal and starts / stops cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tbi-g1-wire-'));
    roots.push(root);
    const submitted: { actor: string; email: string }[] = [];
    const spool = {
      submit: async (actor: string, a: { email: string }) => {
        submitted.push({ actor, email: a.email });
        return '01JAAAAAAAAAAAAAAAAAAAAAAA';
      },
      wait: async () => ({ ok: true }),
    } as unknown as AdminSpool;
    const logs: string[] = [];
    const mails: string[] = [];
    const owner = 'p_ownerownerownerownerowner' as Principal;
    const w = await wireSignupAdmin(
      {
        dir: join(root, 'p'),
        keyFile: join(root, 'k'),
        from: 'x',
        labUrl: 'https://l.example.invalid/',
        quiet: null,
        autoApprove: { dailyCap: 2 },
      },
      spool,
      {
        fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
        log: (l) => {
          logs.push(l);
          allLogs.push(l);
        },
        email: { sendApproval: async (t) => void mails.push(t.id) },
        autoActor: () => owner,
        now: () => NOON_IL,
      },
    );
    const rec = (await w.store.createIfNew(person(3))).record;
    const stop = w.startAutoApprove();
    await stop();
    expect(submitted).toEqual([{ actor: owner, email: 'tester3@example.com' }]);
    expect(mails).toEqual([rec.id]);
    expect(logs).toContain('signup: auto-approve on (daily cap 2)');
    expect(logs).toContain('signup: auto-approve processed 1');
  });
});
