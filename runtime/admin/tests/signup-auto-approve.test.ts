/** BETA-G1: auto-approve with a daily cap and a kill switch. Real temp store; fakes for the account path and mail. */
import {
  chmodSync,
  chownSync,
  lstatSync,
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_MARKER_FILE,
  AUTO_STATE_FILE,
  AUTO_PAUSE_FILE,
  AUTO_RETRIES_PER_SWEEP,
  AUTO_RETRY_BACKOFF_MS,
  autoStateDirCheck,
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
const DAY_MS = 86_400_000;
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
    o?: Partial<{
      cap: number;
      stat: (p: string) => Promise<unknown>;
      noOwner: boolean;
      stateDir: string;
      /** Cut-off (ms); default: one day before the test clock. `null` = unset (persisted default). */
      since: number | null;
      webSignups: 'excluded' | 'included';
    }>,
  ) => AutoApprover;
  manual: () => SignupApprover;
  onAdd?: () => void;
}

async function rig(opts: { quiet?: string } = {}): Promise<Rig> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-auto-')));
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
      dir: o.stateDir ?? dir,
      store,
      dailyCap: o.cap ?? 3,
      now,
      log,
      ...(o.since === null ? {} : { since: o.since ?? NOON_IL - DAY_MS }),
      ...(o.stat ? { stat: o.stat } : {}),
      ...(o.webSignups ? { webSignups: o.webSignups } : {}),
      approver: () =>
        o.noOwner
          ? null
          : new SignupApprover({ store, accounts, email, quiet, now, log, actor: 'auto' }),
    });
  return r;
}

const counter = (dir: string) =>
  JSON.parse(readFileSync(join(dir, AUTO_STATE_FILE), 'utf8')) as {
    day: string;
    count: number;
    retries: number;
    since?: string;
    claims: Record<
      string,
      { at: string; attempts: number; lastAttemptAt: string; spoolId?: string }
    >;
  };
const auditLines = (dir: string) =>
  existsSync(join(dir, 'audit.log'))
    ? readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n')
    : [];

/** Creates n requests one second apart, ending just before the current clock (FIFO order is by createdAt). */
async function createN(r: Rig, n: number, first = 0) {
  const ids: string[] = [];
  const base = r.clock.t;
  for (let i = 0; i < n; i++) {
    r.clock.t = base - (n - i) * 1000;
    ids.push((await r.store.createIfNew(person(first + i))).record.id);
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
    ).toEqual({ enabled: true, dailyCap: 50, webSignups: 'excluded' });
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
    ).toEqual({ enabled: true, dailyCap: 1000, webSignups: 'excluded' });
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
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-off-')));
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
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-bad-')));
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
    expect(existsSync(join(r.dir, AUTO_STATE_FILE))).toBe(false);
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
    expect(counter(r.dir)).toMatchObject({ v: 2, day: '2026-11-23', count: 1, retries: 0 });
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
    // No slot used, nothing claimed; only the DEC-11 marker of the first un-paused sweep is written.
    expect(counter(r.dir)).toMatchObject({ count: 0, retries: 0, claims: {}, active: true });
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
    // A paused first run is no longer a first run: the request of the pause stays manual.
    expect((await a.sweep()).claimed).toBe(0);
    expect((await r.store.get(id!)).status).toBe('pending');
    r.clock.t += 5_000;
    const [fresh] = await createN(r, 1, 1);
    expect((await a.sweep()).claimed).toBe(1);
    expect((await r.store.get(fresh!)).status).toBe('email_sent');
    expect(r.logs).toEqual(
      expect.arrayContaining(['signup: auto-approve paused', 'signup: auto-approve resumed']),
    );
  });

  it('DEC-11: re-enable (paused after active, then off->on) resets the cut-off; requests from the off period stay pending', async () => {
    const r = await rig();
    const a = r.auto({ since: null });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir).since).toBe(new Date(NOON_IL).toISOString());
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    r.clock.t += 10_000;
    const [during] = await createN(r, 1); // created while it was off
    expect((await a.sweep()).stopped).toBe('paused');
    r.clock.t += 60_000;
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    // A restarted process (new instance) resets too (every process starts unconfirmed).
    const b = r.auto({ since: null });
    expect(await b.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
    expect(r.logs.filter((l) => /cut-off reset/.test(l))).toHaveLength(1);
    r.clock.t += 5_000;
    const [after] = await createN(r, 1, 10);
    r.clock.t += 1_000;
    expect((await b.sweep()).claimed).toBe(1);
    expect((await r.store.get(after!)).status).toBe('email_sent');
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(r.logs.filter((l) => /cut-off reset/.test(l))).toHaveLength(1); // unchanged-on: no more resets
  });

  it('DEC-11: also with a configured cut-off (the later one wins); first enable after a paused start is unchanged', async () => {
    const r = await rig();
    const a = r.auto(); // env cut-off one day back
    const [old] = await createN(r, 1);
    expect((await a.sweep()).claimed).toBe(1); // first enable: old-but-after-cut-off request taken
    expect((await r.store.get(old!)).status).toBe('email_sent');
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    const [during] = await createN(r, 1, 5);
    expect((await a.sweep()).stopped).toBe('paused');
    r.clock.t += 30_000;
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect((await a.sweep()).claimed).toBe(0);
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
  });

  it('DEC-11 (H1): configured cut-off, un-paused sweep that claimed nothing, then pause -> resume still resets', async () => {
    const r = await rig();
    const a = r.auto(); // env cut-off set: sinceMs writes nothing
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir)).toMatchObject({ active: true });
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    r.clock.t += 10_000;
    const [during] = await createN(r, 1);
    expect((await a.sweep()).stopped).toBe('paused');
    expect(counter(r.dir)).toMatchObject({ active: false });
    r.clock.t += 60_000;
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
    expect(r.logs.filter((l) => /cut-off reset/.test(l))).toHaveLength(1);
  });

  it('a pre-upgrade state file (since, no active): the first sweep of a new process resets the cut-off; a later pause -> resume resets again', async () => {
    const r = await rig();
    const old = new Date(NOON_IL - 3_600_000).toISOString();
    writeFileSync(
      join(r.dir, AUTO_STATE_FILE),
      `${JSON.stringify({ v: 2, day: '2026-11-23', count: 0, retries: 0, since: old, claims: {} })}\n`,
      { mode: 0o600 },
    );
    const [before] = await createN(r, 1, 20); // after the old cut-off, before this process
    const a = r.auto({ since: null });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir)).toMatchObject({ since: new Date(NOON_IL).toISOString(), active: true });
    expect((await r.store.get(before!)).status).toBe('pending');
    expect(r.logs.filter((l) => /cut-off reset/.test(l))).toHaveLength(1);
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    r.clock.t += 10_000;
    const [during] = await createN(r, 1);
    expect((await a.sweep()).stopped).toBe('paused');
    r.clock.t += 60_000;
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect(await r.auto({ since: null }).sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
  });

  it('DEC-11 (L3): a reset after a clock step back never moves the cut-off earlier', async () => {
    const r = await rig();
    const a = r.auto({ since: null });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    const first = counter(r.dir).since;
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    expect((await a.sweep()).stopped).toBe('paused');
    r.clock.t -= 3_600_000; // clock stepped back one hour (same Israel day)
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir)).toMatchObject({ since: first, active: true });
  });

  it('DEC-11 (L2): pause not recordable -> the sweep still stops; the next un-paused sweep of this process resets', async () => {
    const r = await rig();
    const a = r.auto();
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    chmodSync(r.dir, 0o500); // the state write fails (EACCES)
    try {
      await expect(a.sweep()).rejects.toThrow();
    } finally {
      chmodSync(r.dir, 0o700);
    }
    expect(counter(r.dir)).toMatchObject({ active: true }); // not recorded on disk
    r.clock.t += 10_000;
    const [during] = await createN(r, 1);
    r.clock.t += 60_000;
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
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
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-eacces-')));
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
    const a = r.auto({ cap: 5 });
    const b = r.auto({ cap: 5 });
    // Both processes confirm (reset) their cut-off first; the requests arrive after that.
    await a.sweep();
    await b.sweep();
    r.clock.t += 60_000;
    await createN(r, 8);
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
      since: NOON_IL - DAY_MS,
      now: () => r.clock.t,
      approver: () => r.manual(),
    });
    expect(await again.todayCount()).toBe(2);
    // The restart resets the cut-off (nothing older is taken) and never touches the count.
    expect(await again.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir)).toMatchObject({ count: 2, since: new Date(r.clock.t).toISOString() });
    r.clock.t += 5_000;
    await createN(r, 1, 30);
    expect((await again.sweep()).stopped).toBe('cap');
    expect(r.added).toHaveLength(2);
    expect(counter(r.dir).count).toBe(2);
  });

  it('an unreadable counter fails closed (cap reached), logged, never reset', async () => {
    const r = await rig();
    await createN(r, 1);
    writeFileSync(join(r.dir, AUTO_STATE_FILE), '{not json', { mode: 0o600 });
    const out = await r.auto().sweep();
    expect(out).toMatchObject({ claimed: 0, stopped: 'counter_unreadable' });
    expect(readFileSync(join(r.dir, AUTO_STATE_FILE), 'utf8')).toBe('{not json');
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
    r.clock.t += AUTO_RETRY_BACKOFF_MS;
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
    expect(counter(r.dir)).toMatchObject({ active: false }); // no longer a first run
    expect(counter(r.dir).since).toBeUndefined();
  });
});

describe('wiring with the flag on', () => {
  it('submits the account request as the recorded owner principal and starts / stops cleanly', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-wire-')));
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
        autoApprove: { dailyCap: 2, since: NOON_IL - DAY_MS },
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
    // A stop requested before the start check finished runs no sweep: wait for the first one.
    await vi.waitFor(() => expect(submitted.length).toBeGreaterThan(0));
    await stop();
    expect(submitted).toEqual([{ actor: owner, email: 'tester3@example.com' }]);
    expect(mails).toEqual([rec.id]);
    expect(logs).toContain('signup: auto-approve on (daily cap 2)');
    expect(logs).toContain('signup: auto-approve processed 1');
  });
});

describe('ops review follow-up (slice 2)', () => {
  it('L1: a counter dated after today fails closed (future_day), logged, never reset', async () => {
    const r = await rig();
    await createN(r, 2);
    const text = `${JSON.stringify({ v: 2, day: '2026-11-24', count: 0, retries: 0, claims: {} })}\n`;
    writeFileSync(join(r.dir, AUTO_STATE_FILE), text, { mode: 0o600 });
    const out = await r.auto().sweep();
    expect(out).toMatchObject({ claimed: 0, stopped: 'counter_unreadable' });
    expect(readFileSync(join(r.dir, AUTO_STATE_FILE), 'utf8')).toBe(text);
    expect(r.logs.some((l) => /counter unreadable \(future_day\)/.test(l))).toBe(true);
    expect(r.added).toEqual([]);
  });

  it('M2: a forged record (autoApprovedAt + approved, never claimed here) is not approved or mailed', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    // What a compromised intake could write into its own store.
    await r.store.update(id!, {
      status: 'approved',
      autoApprovedAt: new Date(NOON_IL - 60_000).toISOString(),
    });
    const a = r.auto();
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    r.clock.t += AUTO_RETRY_BACKOFF_MS * 10;
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(r.added).toEqual([]);
    expect(r.mails).toEqual([]);
    expect(auditLines(r.dir)).toEqual([]);
  });

  it('M2: retries count against a per-day bound (= the daily cap), logged once per day', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    r.addAnswers.push('pending', 'pending', 'pending', 'pending');
    const a = r.auto({ cap: 1 });
    expect(await a.sweep()).toEqual({ claimed: 1, attempted: 1 });
    r.clock.t += AUTO_RETRY_BACKOFF_MS;
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 1 });
    r.clock.t += AUTO_RETRY_BACKOFF_MS;
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    r.clock.t += AUTO_RETRY_BACKOFF_MS;
    await a.sweep();
    expect(counter(r.dir)).toMatchObject({ count: 1, retries: 1 });
    expect(r.logs.filter((l) => /retry limit reached/.test(l))).toHaveLength(1);
    // Next Israel day: one more retry allowed.
    r.clock.t = NOON_IL + DAY_MS;
    expect(await a.sweep()).toMatchObject({ claimed: 0, attempted: 1 });
    expect(r.addAnswers).toHaveLength(1);
    expect((await r.store.get(id!)).status).toBe('approved');
  });

  it('M3: helper outage: at most one resubmit per record per backoff window (fake clock)', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    let adds = 0;
    r.onAdd = () => adds++;
    r.addAnswers.push('pending', 'pending', 'pending');
    const a = r.auto();
    await a.sweep();
    expect(adds).toBe(1);
    const t0 = r.clock.t;
    for (let m = 1; m < AUTO_RETRY_BACKOFF_MS / 60_000; m++) {
      r.clock.t = t0 + m * 60_000;
      expect(await a.sweep()).toMatchObject({ attempted: 0 });
    }
    expect(adds).toBe(1);
    r.clock.t = t0 + AUTO_RETRY_BACKOFF_MS;
    expect(await a.sweep()).toMatchObject({ attempted: 1 });
    expect(adds).toBe(2);
    expect(counter(r.dir).claims[id!]).toMatchObject({
      attempts: 2,
      lastAttemptAt: new Date(t0 + AUTO_RETRY_BACKOFF_MS).toISOString(),
    });
  });

  it('M3: retries per sweep are bounded, so new claims are not starved', async () => {
    const r = await rig();
    await createN(r, 4);
    r.addAnswers.push('pending', 'pending', 'pending', 'pending');
    const a = r.auto({ cap: 8 });
    expect(await a.sweep()).toEqual({ claimed: 4, attempted: 4 });
    expect(r.added).toEqual([]);
    r.clock.t += AUTO_RETRY_BACKOFF_MS;
    const fresh = await createN(r, 2, 10);
    const out = await a.sweep();
    expect(out).toEqual({ claimed: 2, attempted: 2 + AUTO_RETRIES_PER_SWEEP });
    for (const id of fresh) expect((await r.store.get(id)).status).toBe('email_sent');
  });

  it('M3: the last spool request id and time are stored on the claim (wiring)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-spool-')));
    roots.push(root);
    const spool = {
      submit: async () => '01JBBBBBBBBBBBBBBBBBBBBBBB',
      wait: async () => 'pending',
    } as unknown as AdminSpool;
    const w = await wireSignupAdmin(
      {
        dir: join(root, 'p'),
        keyFile: join(root, 'k'),
        from: 'x',
        labUrl: 'https://l.example.invalid/',
        quiet: null,
        autoApprove: { dailyCap: 2, since: NOON_IL - DAY_MS },
      },
      spool,
      {
        fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
        log: (l) => allLogs.push(l),
        email: { sendApproval: async () => undefined },
        autoActor: () => 'p_ownerownerownerownerowner' as Principal,
        now: () => NOON_IL,
      },
    );
    const rec = (await w.store.createIfNew(person(4))).record;
    const stop = w.startAutoApprove();
    await vi.waitFor(() => expect(counter(join(root, 'p')).claims[rec.id]).toBeDefined());
    await stop();
    expect(counter(join(root, 'p')).claims[rec.id]).toEqual({
      at: new Date(NOON_IL).toISOString(),
      attempts: 1,
      lastAttemptAt: new Date(NOON_IL).toISOString(),
      spoolId: '01JBBBBBBBBBBBBBBBBBBBBBBB',
    });
  });

  it('M1: a separate state dir holds the pause file and the state; the store dir pause file is then ignored', async () => {
    const r = await rig();
    const sd = join(r.dir, '..', 'auto-state');
    mkdirSync(sd, { mode: 0o700 });
    writeFileSync(join(sd, AUTO_PAUSE_FILE), '');
    expect((await r.auto({ stateDir: sd }).sweep()).stopped).toBe('paused');
    rmSync(join(sd, AUTO_PAUSE_FILE));
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    const b = r.auto({ stateDir: sd });
    expect((await b.sweep()).claimed).toBe(0); // resume resets the cut-off to now
    r.clock.t += 5_000;
    await createN(r, 2);
    expect((await b.sweep()).claimed).toBe(2);
    expect(counter(sd).count).toBe(2);
    expect(existsSync(join(r.dir, AUTO_STATE_FILE))).toBe(false);
  });

  it('M1: a group/world-writable, foreign-owned, symlinked or missing state dir is refused (logged once)', async () => {
    const r = await rig();
    await createN(r, 1);
    const sd = join(r.dir, '..', 'loose');
    mkdirSync(sd, { mode: 0o700 });
    chmodSync(sd, 0o770);
    const a = r.auto({ stateDir: sd });
    expect((await a.sweep()).stopped).toBe('state_dir_unsafe');
    expect((await a.sweep()).stopped).toBe('state_dir_unsafe');
    expect(r.logs.filter((l) => /state dir unsafe \(mode\)/.test(l))).toHaveLength(1);
    chmodSync(sd, 0o702);
    expect(await autoStateDirCheck(sd)).toBe('mode');
    chmodSync(sd, 0o700);
    expect(await autoStateDirCheck(sd)).toBeNull();
    const link = join(r.dir, '..', 'link');
    symlinkSync(sd, link);
    expect(await autoStateDirCheck(link)).toBe('not_dir');
    expect(await autoStateDirCheck(join(r.dir, '..', 'nope'))).toBe('ENOENT');
    if (process.getuid?.() !== 0) expect(await autoStateDirCheck('/')).toBe('owner');
    expect(r.added).toEqual([]);
  });

  it('M1: the wiring refuses to start with an unsafe state dir (one log line, manual stays)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-unsafe-')));
    roots.push(root);
    const sd = join(root, 's');
    mkdirSync(sd, { mode: 0o700 });
    chmodSync(sd, 0o777);
    const submitted: string[] = [];
    const logs: string[] = [];
    const spool = {
      submit: async (_a: string, x: { email: string }) => {
        submitted.push(x.email);
        return '01JCCCCCCCCCCCCCCCCCCCCCCC';
      },
      wait: async () => ({ ok: true }),
    } as unknown as AdminSpool;
    const w = await wireSignupAdmin(
      {
        dir: join(root, 'p'),
        keyFile: join(root, 'k'),
        from: 'x',
        labUrl: 'https://l.example.invalid/',
        quiet: null,
        autoApprove: { dailyCap: 2, since: NOON_IL - DAY_MS, stateDir: sd },
      },
      spool,
      {
        fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
        log: (l) => {
          logs.push(l);
          allLogs.push(l);
        },
        email: { sendApproval: async () => undefined },
        autoActor: () => 'p_ownerownerownerownerowner' as Principal,
        now: () => NOON_IL,
      },
    );
    await w.store.createIfNew(person(5));
    await w.startAutoApprove()();
    expect(submitted).toEqual([]);
    expect(
      logs.filter((l) => /auto-approve not started \(state dir unsafe: mode\)/.test(l)),
    ).toHaveLength(1);
    expect(w.signups.approver).toBeTypeOf('function');
  });

  it('Q5: unset cut-off = first enable time, persisted; older requests stay pending, also after a restart', async () => {
    const r = await rig();
    const [old] = await createN(r, 1);
    const a = r.auto({ since: null });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir).since).toBe(new Date(NOON_IL).toISOString());
    expect(r.logs.filter((l) => /cut-off recorded/.test(l))).toHaveLength(1);
    r.clock.t += 5_000;
    const [fresh] = await createN(r, 1, 10);
    r.clock.t += 120_000;
    // The same process takes the newer request.
    expect(await a.sweep()).toEqual({ claimed: 1, attempted: 1 });
    expect((await r.store.get(fresh!)).status).toBe('email_sent');
    // A later process (restart) resets the cut-off to its start: forward only, older stay pending.
    r.clock.t += 5_000;
    const [between] = await createN(r, 1, 11);
    r.clock.t += 120_000;
    expect(await r.auto({ since: null }).sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
    expect((await r.store.get(old!)).status).toBe('pending');
    expect((await r.store.get(between!)).status).toBe('pending');
  });

  it('Q5: TBI_SIGNUP_AUTO_SINCE takes only requests created after it', async () => {
    const r = await rig();
    const ids = await createN(r, 3); // created at -3 s, -2 s, -1 s
    await r.auto({ since: NOON_IL - 2_000 }).sweep();
    expect((await r.store.get(ids[0]!)).status).toBe('pending');
    expect((await r.store.get(ids[1]!)).status).toBe('pending');
    expect((await r.store.get(ids[2]!)).status).toBe('email_sent');
  });

  it('config: state dir must be absolute, cut-off must be an ISO time with zone', () => {
    const on = { TBI_SIGNUP_AUTO_APPROVE: '1', TBI_SIGNUP_AUTO_DAILY_CAP: '5' };
    expect(
      autoApproveConfigFromEnv({
        ...on,
        TBI_SIGNUP_AUTO_STATE_DIR: '/var/lib/x',
        TBI_SIGNUP_AUTO_SINCE: '2026-12-12T08:00:00+02:00',
      }),
    ).toEqual({
      enabled: true,
      dailyCap: 5,
      stateDir: '/var/lib/x',
      since: Date.parse('2026-12-12T06:00:00Z'),
      webSignups: 'excluded',
    });
    for (const bad of [
      { TBI_SIGNUP_AUTO_STATE_DIR: 'rel/dir' },
      { TBI_SIGNUP_AUTO_STATE_DIR: '/a/../b' },
      { TBI_SIGNUP_AUTO_SINCE: '2026-12-12' },
      { TBI_SIGNUP_AUTO_SINCE: '2026-12-12T08:00:00' },
      { TBI_SIGNUP_AUTO_SINCE: '2026-13-40T08:00:00Z' },
      { TBI_SIGNUP_AUTO_SINCE: 'yesterday' },
    ])
      expect(autoApproveConfigFromEnv({ ...on, ...bad })).toMatchObject({
        enabled: false,
        error: true,
      });
  });
});

describe('review follow-up (slice 3)', () => {
  /** <root>/a/s, all 0700 and owned by this process: a safe chain (works as root and non-root). */
  async function chain() {
    const r = await rig();
    const root = join(r.dir, '..');
    const a = join(root, 'a');
    const s = join(a, 's');
    mkdirSync(s, { recursive: true, mode: 0o700 });
    chmodSync(a, 0o700);
    return { r, root, a, s };
  }

  it('a trailing slash on the state dir is accepted (same directory)', async () => {
    const { s } = await chain();
    expect(await autoStateDirCheck(s)).toBeNull();
    expect(await autoStateDirCheck(s + '/')).toBeNull();
    expect(await autoStateDirCheck(s + '//')).toBeNull();
  });

  it('ancestors: a group/world-writable ancestor without the sticky bit is refused; sticky (like /tmp) is fine', async () => {
    const { r, a, s } = await chain();
    await createN(r, 1);
    expect(await autoStateDirCheck(s)).toBeNull();
    chmodSync(a, 0o777);
    expect(await autoStateDirCheck(s)).toBe('ancestor_mode');
    chmodSync(a, 0o770);
    expect(await autoStateDirCheck(s)).toBe('ancestor_mode');
    chmodSync(a, 0o1777);
    expect(await autoStateDirCheck(s)).toBeNull();
    chmodSync(a, 0o707);
    const auto = r.auto({ stateDir: s });
    expect((await auto.sweep()).stopped).toBe('state_dir_unsafe');
    expect((await auto.sweep()).stopped).toBe('state_dir_unsafe');
    expect(r.logs.filter((l) => /state dir unsafe \(ancestor_mode\)/.test(l))).toHaveLength(1);
    expect(r.added).toEqual([]);
    chmodSync(a, 0o700);
    // Before-enable (req 8): unsafe -> safe with no state is lost state, not a first run: the
    // cut-off is now, so the request from the unsafe period stays for the owner.
    expect(await auto.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(r.logs.filter((l) => /state missing, cut-off = now/.test(l))).toHaveLength(1);
    r.clock.t += 5_000;
    await createN(r, 1, 1);
    expect((await auto.sweep()).claimed).toBe(1);
  });

  it('ancestors: a symlink anywhere in the path is refused (the path must be its own realpath)', async () => {
    const { root, s } = await chain();
    const link = join(root, 'l');
    symlinkSync(join(root, 'a'), link);
    expect(realpathSync(join(link, 's'))).toBe(s);
    expect(await autoStateDirCheck(join(link, 's'))).toBe('symlink');
    // The leaf itself as a symlink stays `not_dir` (lstat first).
    symlinkSync(s, join(root, 'leaf'));
    expect(await autoStateDirCheck(join(root, 'leaf'))).toBe('not_dir');
  });

  it('ancestors: one owned by another uid (not root) is refused (stat hook; works as root and non-root)', async () => {
    const { a, s } = await chain();
    const foreign = async (p: string) => {
      const st = lstatSync(p);
      return p === a ? Object.create(st, { uid: { value: 4242 } }) : st;
    };
    expect(await autoStateDirCheck(s, { lstat: foreign })).toBe('ancestor_owner');
    // Root-owned ancestors are fine (the chain up to / is checked; /tmp and / are root-owned).
    const rootOwned = async (p: string) => {
      const st = lstatSync(p);
      return p === a ? Object.create(st, { uid: { value: 0 } }) : st;
    };
    expect(await autoStateDirCheck(s, { lstat: rootOwned })).toBeNull();
  });

  it('ancestors: a real foreign-owned ancestor is refused (only when run as root, which can chown)', async () => {
    if (process.getuid?.() !== 0) return;
    const { a, s } = await chain();
    chownSync(a, 65534, 65534);
    expect(await autoStateDirCheck(s)).toBe('ancestor_owner');
    chownSync(a, 0, 0);
    expect(await autoStateDirCheck(s)).toBeNull();
  });

  it('ancestors: the wiring refuses to start when an ancestor is unsafe', async () => {
    const { root, a, s } = await chain();
    chmodSync(a, 0o777);
    const logs: string[] = [];
    const w = await wireSignupAdmin(
      {
        dir: join(root, 'w'),
        keyFile: join(root, 'k'),
        from: 'x',
        labUrl: 'https://l.example.invalid/',
        quiet: null,
        autoApprove: { dailyCap: 2, since: NOON_IL - DAY_MS, stateDir: s },
      },
      { submit: async () => 'x', wait: async () => ({ ok: true }) } as unknown as AdminSpool,
      {
        fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
        log: (l) => {
          logs.push(l);
          allLogs.push(l);
        },
        email: { sendApproval: async () => undefined },
        autoActor: () => 'p_ownerownerownerownerowner' as Principal,
        now: () => NOON_IL,
      },
    );
    await w.startAutoApprove()();
    expect(
      logs.filter((l) => /not started \(state dir unsafe: ancestor_mode\)/.test(l)),
    ).toHaveLength(1);
  });

  /** Makes store.update fail with `code` while it marks `autoApprovedAt` (the approver's updates still work). */
  function failMark(r: Rig, code: string) {
    const real = r.store.update.bind(r.store);
    const state = { on: true };
    r.store.update = (async (id, patch) => {
      if (state.on && 'autoApprovedAt' in patch)
        throw Object.assign(new Error(`boom ${code}`), { code });
      return real(id, patch);
    }) as PendingStore['update'];
    return state;
  }

  it('mark failure after the claim: the claim is released, the slot stays used, logged once per errno', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    const fail = failMark(r, 'EIO');
    const a = r.auto({ cap: 3 });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0, stopped: 'mark_failed' });
    expect(counter(r.dir)).toMatchObject({ count: 1, claims: {} });
    expect(await r.store.get(id!)).toMatchObject({ status: 'pending', lastError: null });
    expect((await r.store.get(id!)).autoApprovedAt).toBeUndefined();
    expect(await a.sweep()).toMatchObject({ stopped: 'mark_failed' });
    expect(counter(r.dir)).toMatchObject({ count: 2, claims: {} });
    expect(r.logs.filter((l) => /could not mark a claimed request \(EIO\)/.test(l))).toHaveLength(
      1,
    );
    expect(r.added).toEqual([]);
    // Store fixed: the request is taken again with a new slot (never more than the cap).
    fail.on = false;
    expect(await a.sweep()).toEqual({ claimed: 1, attempted: 1 });
    expect(counter(r.dir).count).toBe(3);
    expect(r.mails).toEqual([id]);
  });

  it('mark failure: the cap still holds (cap 1: the released request waits for the next day)', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    const fail = failMark(r, 'ENOSPC');
    const a = r.auto({ cap: 1 });
    expect((await a.sweep()).stopped).toBe('mark_failed');
    fail.on = false;
    expect((await a.sweep()).stopped).toBe('cap');
    expect(counter(r.dir)).toMatchObject({ count: 1, claims: {} });
    expect(r.added).toEqual([]);
    r.clock.t = NOON_IL + DAY_MS;
    expect(await a.sweep()).toEqual({ claimed: 1, attempted: 1 });
    expect(r.mails).toEqual([id]);
  });

  it('an orphan claim (claimed, never marked: crash or failed release) is pruned and can be re-claimed', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    const at = new Date(NOON_IL - 60_000).toISOString();
    const st = {
      v: 2,
      day: israelDay(NOON_IL),
      count: 1,
      retries: 0,
      claims: { [id!]: { at, attempts: 1, lastAttemptAt: at } },
    };
    writeFileSync(join(r.dir, AUTO_STATE_FILE), `${JSON.stringify(st)}\n`, { mode: 0o600 });
    expect(await r.auto({ cap: 2 }).sweep()).toEqual({ claimed: 1, attempted: 1 });
    expect(counter(r.dir).count).toBe(2);
    expect(r.mails).toEqual([id]);
  });

  it('a claimed and marked request is not pruned (still retried, no new slot)', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    r.addAnswers.push('pending');
    const a = r.auto({ cap: 2 });
    await a.sweep();
    await a.sweep();
    expect(Object.keys(counter(r.dir).claims)).toEqual([id]);
    expect(counter(r.dir).count).toBe(1);
  });

  it('the unreadable-counter line is logged at most once per hour per condition (fake clock)', async () => {
    const r = await rig();
    await createN(r, 1);
    writeFileSync(join(r.dir, AUTO_STATE_FILE), '{not json', { mode: 0o600 });
    const a = r.auto();
    const t0 = r.clock.t;
    const lines = (re: RegExp) => r.logs.filter((l) => re.test(l)).length;
    for (let m = 0; m < 60; m++) {
      r.clock.t = t0 + m * 60_000;
      expect((await a.sweep()).stopped).toBe('counter_unreadable');
    }
    expect(lines(/counter unreadable \(corrupt\)/)).toBe(1);
    // Another condition is logged at once, on its own hourly budget.
    const fut = { v: 2, day: '2099-01-01', count: 0, retries: 0, claims: {} };
    writeFileSync(join(r.dir, AUTO_STATE_FILE), JSON.stringify(fut), { mode: 0o600 });
    expect((await a.sweep()).stopped).toBe('counter_unreadable');
    expect((await a.sweep()).stopped).toBe('counter_unreadable');
    expect(lines(/counter unreadable \(future_day\)/)).toBe(1);
    writeFileSync(join(r.dir, AUTO_STATE_FILE), '{not json', { mode: 0o600 });
    r.clock.t = t0 + 60 * 60_000;
    await a.sweep();
    expect(lines(/counter unreadable \(corrupt\)/)).toBe(2);
    expect(r.added).toEqual([]);
  });
});

describe('BETA-G1 s8 fix round: web-origin requests are not auto-approved by default', () => {
  it('TBI_SIGNUP_AUTO_WEB: unset/empty/excluded = excluded, included = included, else error', () => {
    const on = { TBI_SIGNUP_AUTO_APPROVE: '1', TBI_SIGNUP_AUTO_DAILY_CAP: '5' };
    for (const v of [undefined, '', 'excluded'])
      expect(
        autoApproveConfigFromEnv(v === undefined ? on : { ...on, TBI_SIGNUP_AUTO_WEB: v }),
      ).toMatchObject({ enabled: true, webSignups: 'excluded' });
    expect(autoApproveConfigFromEnv({ ...on, TBI_SIGNUP_AUTO_WEB: 'included' })).toMatchObject({
      enabled: true,
      webSignups: 'included',
    });
    for (const v of ['1', 'yes', 'Included', 'include'])
      expect(autoApproveConfigFromEnv({ ...on, TBI_SIGNUP_AUTO_WEB: v })).toMatchObject({
        enabled: false,
        error: true,
      });
  });

  it('default: a web request stays pending for the owner and spends no slot; signed ones go', async () => {
    const r = await rig();
    const base = r.clock.t;
    r.clock.t = base - 3000;
    const web = (await r.store.createIfNew(person(1), { origin: 'web' })).record.id;
    r.clock.t = base - 2000;
    const signed = (await r.store.createIfNew(person(2))).record.id;
    r.clock.t = base;
    const out = await r.auto({ cap: 1 }).sweep();
    expect(out).toEqual({ claimed: 1, attempted: 1 });
    expect(r.added).toEqual(['tester2@example.com']);
    expect((await r.store.get(web)).status).toBe('pending');
    expect((await r.store.get(web)).autoApprovedAt).toBeUndefined();
    expect((await r.store.get(signed)).status).toBe('email_sent');
    // A later day: still not taken.
    r.clock.t += DAY_MS;
    expect((await r.auto({ cap: 1 }).sweep()).claimed).toBe(0);
    expect((await r.store.get(web)).status).toBe('pending');
    // The owner can still approve it by hand.
    expect((await r.manual().approve(web)).ok).toBe(true);
  });

  it('included: a web request is auto-approved like any other', async () => {
    const r = await rig();
    r.clock.t -= 1000;
    const web = (await r.store.createIfNew(person(1), { origin: 'web' })).record.id;
    r.clock.t += 1000;
    expect(await r.auto({ webSignups: 'included' }).sweep()).toEqual({ claimed: 1, attempted: 1 });
    expect((await r.store.get(web)).status).toBe('email_sent');
  });

  it('wiring: without webSignups the admin unit leaves web requests to the owner', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-wire-')));
    roots.push(root);
    const submitted: string[] = [];
    const spool = {
      submit: async (_actor: string, a: { email: string }) => {
        submitted.push(a.email);
        return '01JAAAAAAAAAAAAAAAAAAAAAAA';
      },
      wait: async () => ({ ok: true }),
    } as unknown as AdminSpool;
    const w = await wireSignupAdmin(
      {
        dir: join(root, 'p'),
        keyFile: join(root, 'k'),
        from: 'x',
        labUrl: 'https://l.example.invalid/',
        quiet: null,
        autoApprove: { dailyCap: 5, since: NOON_IL - DAY_MS },
      },
      spool,
      {
        fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
        log: (l) => void allLogs.push(l),
        email: { sendApproval: async () => undefined },
        autoActor: () => 'p_ownerownerownerownerowner' as Principal,
        now: () => NOON_IL,
      },
    );
    await w.store.createIfNew(person(4), { origin: 'web' });
    await w.store.createIfNew(person(5));
    const stop = w.startAutoApprove();
    // A stop requested before the start check finished runs no sweep: wait for the first one.
    await vi.waitFor(() => expect(submitted.length).toBeGreaterThan(0));
    await stop();
    expect(submitted).toEqual(['tester5@example.com']);
  });
});

describe('BETA-G1 follow-up: every process starts unconfirmed (cut-off reset before any claim)', () => {
  const OLD = NOON_IL - 3_600_000;
  const seed = (dir: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(dir, AUTO_STATE_FILE),
      `${JSON.stringify({ v: 2, day: '2026-11-23', count: 1, retries: 0, since: new Date(OLD).toISOString(), active: true, claims: {}, ...extra })}\n`,
      { mode: 0o600 },
    );
  const resets = (r: Rig) => r.logs.filter((l) => /cut-off reset/.test(l));

  it('a new instance on state active:true resets; a request between the old and the new cut-off stays pending; count unchanged', async () => {
    const r = await rig();
    seed(r.dir);
    const [between] = await createN(r, 1); // after OLD, before this process
    const a = r.auto({ since: null });
    expect((await a.status()).cutoff).toBe('unknown'); // the old cut-off is not shown
    expect((await a.status()).unknownReasons).toMatchObject({
      cutoff: 'reset_pending',
      waitingBacklog: 'reset_pending',
    });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(between!)).status).toBe('pending');
    expect(counter(r.dir)).toMatchObject({
      count: 1,
      since: new Date(NOON_IL).toISOString(),
      active: true,
    });
    expect(resets(r)).toEqual([
      'signup: auto-approve cut-off reset (only requests created from now on)',
    ]);
    const st = await a.status();
    expect(st.cutoff).toBe(new Date(NOON_IL).toISOString());
    expect(st.waitingBacklog).toBe(1); // the request now needs the owner
    r.clock.t += 5_000;
    const [fresh] = await createN(r, 1, 1);
    expect((await a.sweep()).claimed).toBe(1);
    expect((await r.store.get(fresh!)).status).toBe('email_sent');
    expect(counter(r.dir).count).toBe(2);
    expect(resets(r)).toHaveLength(1);
  });

  it('pause on -> off in the same process resets; status shows reset pending while paused', async () => {
    const r = await rig();
    const a = r.auto({ since: null });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    expect((await a.sweep()).stopped).toBe('paused');
    expect((await a.status()).unknownReasons?.cutoff).toBe('reset_pending');
    r.clock.t += 10_000;
    const [during] = await createN(r, 1);
    r.clock.t += 10_000;
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
    expect(resets(r)).toHaveLength(1);
  });

  it('first enable ever (no state file, no env): nothing older is approved; status says not_recorded, not reset_pending', async () => {
    const r = await rig();
    const [older] = await createN(r, 2);
    const a = r.auto({ since: null });
    expect((await a.status()).unknownReasons?.cutoff).toBe('not_recorded');
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(older!)).status).toBe('pending');
    expect(counter(r.dir)).toMatchObject({ since: new Date(NOON_IL).toISOString(), active: true });
    expect(r.logs.filter((l) => /cut-off recorded/.test(l))).toHaveLength(1);
    expect(resets(r)).toHaveLength(0);
  });

  it('a write failure at the reset: zero claims, stopped reset_failed (logged once), retried and done next sweep', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const r = await rig();
    seed(r.dir);
    r.clock.t += 60_000;
    await createN(r, 2); // after OLD, before this process: must never be taken
    const a = r.auto({ since: null });
    chmodSync(r.dir, 0o500); // reads work, the state write fails (EACCES)
    try {
      expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0, stopped: 'reset_failed' });
      expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0, stopped: 'reset_failed' });
    } finally {
      chmodSync(r.dir, 0o700);
    }
    expect(
      r.logs.filter((l) => /cut-off reset failed \(EACCES\); nothing approved, retried/.test(l)),
    ).toHaveLength(1);
    expect(counter(r.dir)).toMatchObject({ count: 1, since: new Date(OLD).toISOString() });
    expect((await a.status()).unknownReasons?.cutoff).toBe('reset_pending');
    expect(r.added).toEqual([]);
    r.clock.t += 1_000;
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir)).toMatchObject({ count: 1, since: new Date(r.clock.t).toISOString() });
    expect(r.added).toEqual([]);
  });

  it('an unreadable state at the reset approves nothing (counter_unreadable) and keeps the flag', async () => {
    const r = await rig();
    writeFileSync(join(r.dir, AUTO_STATE_FILE), '{not json', { mode: 0o600 });
    await createN(r, 1);
    const a = r.auto();
    expect((await a.sweep()).stopped).toBe('counter_unreadable');
    expect(r.added).toEqual([]);
    rmSync(join(r.dir, AUTO_STATE_FILE));
    // Before-enable (req 6): after an unreadable state a missing file is never a first run.
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
  });

  it('env TBI_SIGNUP_AUTO_SINCE older than the reset: the reset (now) wins', async () => {
    const r = await rig();
    seed(r.dir);
    const [between] = await createN(r, 1);
    const a = r.auto({ since: OLD - DAY_MS });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(between!)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(NOON_IL).toISOString());
  });

  it('env TBI_SIGNUP_AUTO_SINCE newer than the reset: the env cut-off wins (persisted, forward only)', async () => {
    const r = await rig();
    seed(r.dir);
    const future = NOON_IL + 60_000;
    const a = r.auto({ since: future });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir).since).toBe(new Date(future).toISOString());
    r.clock.t = NOON_IL + 30_000;
    const [early] = await createN(r, 1); // after the reset time, before the env cut-off
    r.clock.t = NOON_IL + 120_000;
    const [late] = await createN(r, 1, 1);
    expect((await a.sweep()).claimed).toBe(1);
    expect((await r.store.get(early!)).status).toBe('pending');
    expect((await r.store.get(late!)).status).toBe('email_sent');
    expect((await a.status()).cutoff).toBe(new Date(future).toISOString());
  });

  it('a clock stepped back before a restart never moves the cut-off earlier', async () => {
    const r = await rig();
    seed(r.dir, { since: new Date(NOON_IL + 600_000).toISOString() });
    const a = r.auto({ since: null });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(counter(r.dir).since).toBe(new Date(NOON_IL + 600_000).toISOString());
  });

  it('no_owner is treated like a pause: requests that piled up meanwhile stay pending after the owner is recorded', async () => {
    const r = await rig();
    let owner = true;
    const a = new AutoApprover({
      dir: r.dir,
      store: r.store,
      dailyCap: 3,
      now: () => r.clock.t,
      approver: () => (owner ? r.manual() : null),
    });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    owner = false;
    expect((await a.sweep()).stopped).toBe('no_owner');
    expect(counter(r.dir)).toMatchObject({ active: false });
    r.clock.t += 10_000;
    const [piled] = await createN(r, 1);
    r.clock.t += 10_000;
    owner = true;
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(piled!)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
  });

  it('status() concurrent with the resetting sweep never shows the old cut-off', async () => {
    const r = await rig();
    seed(r.dir);
    const a = r.auto({ since: null });
    const [s1, out, s2] = await Promise.all([a.status(), a.sweep(), a.status()]);
    expect(out).toEqual({ claimed: 0, attempted: 0 });
    for (const st of [s1, s2]) expect(st.cutoff).not.toBe(new Date(OLD).toISOString());
    expect((await a.status()).cutoff).toBe(new Date(NOON_IL).toISOString());
  });
});

describe('BETA-G1 QA: a paused or no_owner first run is no longer a first run', () => {
  const ENV = NOON_IL - DAY_MS; // TBI_SIGNUP_AUTO_SINCE one day back
  const resets = (r: Rig) => r.logs.filter((l) => /cut-off reset/.test(l));

  it('paused first run (backdated env): persists active:false; a request during the pause stays pending after resume, also across restart', async () => {
    const r = await rig();
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    const a = r.auto({ since: ENV });
    expect((await a.sweep()).stopped).toBe('paused');
    expect(counter(r.dir)).toMatchObject({ active: false });
    expect(counter(r.dir).since).toBeUndefined();
    r.clock.t += 10_000;
    const [during] = await createN(r, 1);
    r.clock.t += 10_000;
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    const b = r.auto({ since: ENV }); // restart after the pause
    expect(await b.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(counter(r.dir)).toMatchObject({
      since: new Date(r.clock.t).toISOString(),
      active: true,
    });
    expect(resets(r)).toHaveLength(1);
    expect(r.added).toEqual([]);
  });

  it('paused first run, resume in the same process: the request of the pause stays pending', async () => {
    const r = await rig();
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    const a = r.auto({ since: ENV });
    expect((await a.sweep()).stopped).toBe('paused');
    r.clock.t += 10_000;
    const [during] = await createN(r, 1);
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(r.added).toEqual([]);
  });

  it('no_owner first run (backdated env): persists active:false; once the owner is recorded (restart) the waiting request stays pending', async () => {
    const r = await rig();
    const a = r.auto({ since: ENV, noOwner: true });
    expect((await a.sweep()).stopped).toBe('no_owner');
    expect(counter(r.dir)).toMatchObject({ active: false });
    r.clock.t += 10_000;
    const [during] = await createN(r, 1);
    expect((await a.sweep()).stopped).toBe('no_owner');
    r.clock.t += 10_000;
    const b = r.auto({ since: ENV });
    expect(await b.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
    expect(r.added).toEqual([]);
  });

  it('a true first approving run with a backdated env still honours it, within the cap', async () => {
    const r = await rig();
    const ids = await createN(r, 4); // all after ENV
    const a = r.auto({ since: ENV, cap: 3 });
    expect((await a.sweep()).claimed).toBe(3);
    expect((await r.store.get(ids[3]!)).status).toBe('pending');
    expect(counter(r.dir)).toMatchObject({
      count: 3,
      since: new Date(ENV).toISOString(),
      active: true,
    });
    expect(r.logs.filter((l) => /cut-off recorded/.test(l))).toHaveLength(1);
  });

  it('paused with an unreadable state: fails closed (stopped, nothing approved, file not rewritten)', async () => {
    const r = await rig();
    await createN(r, 1);
    writeFileSync(join(r.dir, AUTO_STATE_FILE), 'not json', { mode: 0o600 });
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    const a = r.auto({ since: ENV });
    const out = await a.sweep();
    expect(out.claimed).toBe(0);
    expect(out.stopped).toBeDefined();
    expect(readFileSync(join(r.dir, AUTO_STATE_FILE), 'utf8')).toBe('not json');
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect((await a.sweep()).claimed).toBe(0);
    expect(r.added).toEqual([]);
  });

  it('state_dir_unsafe makes the process unconfirmed: the next safe sweep resets the cut-off', async () => {
    const r = await rig();
    const sd = join(r.dir, '..', 'sd');
    mkdirSync(sd, { mode: 0o700 });
    const a = r.auto({ since: null, stateDir: sd });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 }); // first enable, confirmed
    chmodSync(sd, 0o770);
    expect((await a.sweep()).stopped).toBe('state_dir_unsafe');
    r.clock.t += 10_000;
    const [during] = await createN(r, 1);
    chmodSync(sd, 0o700);
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect((await r.store.get(during!)).status).toBe('pending');
    expect(counter(sd).since).toBe(new Date(r.clock.t).toISOString());
    expect(resets(r)).toHaveLength(1);
  });
});

/** Frozen copy of validState as released at dea6f93 (the previous release's reader). */
function oldValidState(c: unknown): boolean {
  const s = c as Record<string, unknown> | null;
  const isTime = (x: unknown) => typeof x === 'string' && Number.isFinite(Date.parse(x));
  const isCount = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
  if (!s || typeof s !== 'object' || s.v !== 2) return false;
  if (typeof s.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.day)) return false;
  if (!isCount(s.count) || !isCount(s.retries)) return false;
  if (s.since !== undefined && !isTime(s.since)) return false;
  if (s.active !== undefined && typeof s.active !== 'boolean') return false;
  const claims = s.claims as Record<string, Record<string, unknown>> | undefined;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return false;
  for (const [id, e] of Object.entries(claims)) {
    if (!/^[0-9A-Za-z]{1,64}$/.test(id) || !e || typeof e !== 'object') return false;
    if (!isTime(e.at) || !isTime(e.lastAttemptAt) || !isCount(e.attempts)) return false;
    if (
      e.spoolId !== undefined &&
      (typeof e.spoolId !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(e.spoolId))
    )
      return false;
  }
  return true;
}
/** The previous release's first-run test on a state it read. */
const oldFirstRun = (s: { since?: string; active?: boolean }) =>
  s.since === undefined && s.active === undefined;

describe('before-enable (BACKLOG 12/G1): lost state is never a first run; pause race', () => {
  it('pause -> state deleted -> resume with a backdated SINCE approves no old request', async () => {
    const r = await rig();
    const a = r.auto(); // TBI_SIGNUP_AUTO_SINCE one day before the clock
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 }); // first run, recorded
    writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
    expect((await a.sweep()).stopped).toBe('paused');
    r.clock.t += 10_000;
    const ids = await createN(r, 2); // after SINCE, while paused
    rmSync(join(r.dir, AUTO_STATE_FILE));
    rmSync(join(r.dir, AUTO_PAUSE_FILE));
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    for (const id of ids) expect((await r.store.get(id)).status).toBe('pending');
    const s = counter(r.dir) as ReturnType<typeof counter> & { active?: boolean };
    expect(s.since).toBe(new Date(r.clock.t).toISOString());
    expect(r.logs.filter((l) => /state missing, cut-off = now/.test(l))).toHaveLength(1);
    expect(r.added).toEqual([]);
    // The state written keeps v:2 and loads in the previous release, not as a first run.
    expect(oldValidState(s)).toBe(true);
    expect(oldFirstRun(s)).toBe(false);
  });

  it('restart with the state file lost: a record auto-approved earlier marks it; cut-off = now', async () => {
    const r = await rig();
    await createN(r, 1);
    expect((await r.auto().sweep()).claimed).toBe(1);
    rmSync(join(r.dir, AUTO_STATE_FILE));
    r.clock.t += 10_000;
    const ids = await createN(r, 2, 1); // after the backdated SINCE
    const b = r.auto(); // a new process, same backdated SINCE
    expect(await b.sweep()).toEqual({ claimed: 0, attempted: 0 });
    for (const id of ids) expect((await r.store.get(id)).status).toBe('pending');
    expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
  });

  it('a true first run (no state, no earlier auto mark) still records SINCE', async () => {
    const r = await rig();
    await createN(r, 1);
    expect((await r.auto().sweep()).claimed).toBe(1);
    expect(r.logs.filter((l) => /state missing/.test(l))).toHaveLength(0);
  });

  it('pause created between the sweep check and the claim: 0 claims, count unchanged, nothing written', async () => {
    const r = await rig();
    const a = r.auto();
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0 });
    r.clock.t += 10_000;
    const ids = await createN(r, 2);
    const before = readFileSync(join(r.dir, AUTO_STATE_FILE), 'utf8');
    const get = r.store.get.bind(r.store);
    const list = r.store.list.bind(r.store);
    let armed = false;
    // Armed once the sweep has listed (list() reads records itself): the next get is the claim's.
    r.store.list = async () => {
      const out = await list();
      armed = true;
      return out;
    };
    r.store.get = async (id: string) => {
      if (armed) {
        armed = false; // the owner pauses while the claim is being checked
        writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
      }
      return get(id);
    };
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0, stopped: 'paused' });
    expect(readFileSync(join(r.dir, AUTO_STATE_FILE), 'utf8')).toBe(before);
    expect(counter(r.dir).count).toBe(0);
    for (const id of ids) {
      const rec = await get(id);
      expect(rec.status).toBe('pending');
      expect(rec.autoApprovedAt).toBeUndefined();
    }
    expect(r.added).toEqual([]);
  });

  it('a pause check that errors inside the claim counts as paused', async () => {
    const r = await rig();
    await createN(r, 1);
    let calls = 0;
    const enoent = () => Object.assign(new Error('x'), { code: 'ENOENT' });
    const a = r.auto({
      stat: async () => {
        calls++;
        // 1: sweep start, 2: before the claim, 3: inside the claim -> EIO.
        throw calls === 3 ? Object.assign(new Error('x'), { code: 'EIO' }) : enoent();
      },
    });
    expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0, stopped: 'paused' });
    expect(counter(r.dir).count).toBe(0);
  });

  it('pause created between the retry check and reserveRetry: no retry reserved, nothing called', async () => {
    const r = await rig();
    await createN(r, 1);
    r.addAnswers.push('pending');
    expect(await r.auto({ cap: 1 }).sweep()).toEqual({ claimed: 1, attempted: 1 });
    r.clock.t += AUTO_RETRY_BACKOFF_MS;
    let calls = 0;
    const b = r.auto({
      cap: 1,
      stat: async () => {
        calls++;
        // 1: sweep start, 2: before reserveRetry, 3: inside it -> paused.
        if (calls >= 3) return {};
        throw Object.assign(new Error('x'), { code: 'ENOENT' });
      },
    });
    const addsBefore = r.added.length;
    expect(await b.sweep()).toEqual({ claimed: 0, attempted: 0, stopped: 'paused' });
    const s = counter(r.dir);
    expect(s.retries).toBe(0);
    expect(Object.values(s.claims)[0]!.attempts).toBe(1);
    expect(r.added.length).toBe(addsBefore);
  });
});

describe('restart gap: the marker file makes a lost state visible to a new process', () => {
  const lose = (r: Rig) => rmSync(join(r.dir, AUTO_STATE_FILE));
  const lostLines = (r: Rig) => r.logs.filter((l) => /state missing, cut-off = now/.test(l));

  for (const [name, first] of [
    ['paused', {}],
    ['no_owner', { noOwner: true }],
    ['a recorded cut-off', {}],
  ] as const) {
    it(`earlier run: ${name}, nothing approved, state lost, restart: a past SINCE is not applied`, async () => {
      const r = await rig();
      if (name === 'paused') writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
      await r.auto(first).sweep();
      expect(lstatSync(join(r.dir, AUTO_MARKER_FILE)).mode & 0o777).toBe(0o600);
      rmSync(join(r.dir, AUTO_PAUSE_FILE), { force: true });
      lose(r);
      await createN(r, 1);
      const next = r.auto();
      // status() says what the next sweep will do, and writes nothing.
      const before = readdirSync(r.dir).sort();
      expect(await next.status()).toMatchObject({
        cutoff: 'unknown',
        waitingBacklog: 'unknown',
        unknownReasons: { cutoff: 'reset_pending' },
      });
      expect(readdirSync(r.dir).sort()).toEqual(before);
      expect(await next.sweep()).toEqual({ claimed: 0, attempted: 0 });
      expect(lostLines(r)).toHaveLength(1);
      expect(r.added).toEqual([]);
    });
  }

  it('status(): marked records and no state file or marker: reset pending, not the past SINCE', async () => {
    const r = await rig();
    const [id] = await createN(r, 1);
    await r.store.update(id!, { autoApprovedAt: new Date(NOON_IL).toISOString() });
    expect(await r.auto().status()).toMatchObject({
      cutoff: 'unknown',
      waitingBacklog: 'unknown',
      unknownReasons: { cutoff: 'reset_pending' },
    });
    expect(existsSync(join(r.dir, AUTO_MARKER_FILE))).toBe(false);
  });

  it('a marker entry that is not a plain file (dangling symlink) still counts: fail closed', async () => {
    const r = await rig();
    symlinkSync(join(r.dir, 'nowhere'), join(r.dir, AUTO_MARKER_FILE));
    await createN(r, 1);
    expect(await r.auto().sweep()).toEqual({ claimed: 0, attempted: 0 });
    expect(lostLines(r)).toHaveLength(1);
    expect(existsSync(join(r.dir, 'nowhere'))).toBe(false);
  });

  it('nothing is written into an unsafe state dir', async () => {
    const r = await rig();
    chmodSync(r.dir, 0o777);
    const before = readdirSync(r.dir).sort();
    expect((await r.auto().sweep()).stopped).toBe('state_dir_unsafe');
    expect(readdirSync(r.dir).sort()).toEqual(before);
  });

  it('rollback: the store listing and purge (unchanged from the previous release) leave the marker', async () => {
    const r = await rig();
    await createN(r, 1);
    await r.auto().sweep();
    r.clock.t += 400 * DAY_MS;
    await r.store.purge();
    expect(await r.store.list()).toEqual([]);
    expect(existsSync(join(r.dir, AUTO_MARKER_FILE))).toBe(true);
    expect(await autoStateDirCheck(r.dir)).toBeNull();
  });
});

describe('unreadable state leaves the marker for the next process', () => {
  const state = (r: Rig) => join(r.dir, AUTO_STATE_FILE);
  const marker = (r: Rig) => join(r.dir, AUTO_MARKER_FILE);
  const corrupt = (r: Rig) => writeFileSync(state(r), '{not json', { mode: 0o600 });
  const future = JSON.stringify({ v: 2, day: '2099-01-01', count: 0, retries: 0, claims: {} });
  const failLines = (r: Rig) => r.logs.filter((l) => /marker not written/.test(l));

  const kinds: [string, (r: Rig) => void][] = [
    ['corrupt', corrupt],
    ['future_day', (r) => writeFileSync(state(r), future, { mode: 0o600 })],
    ['unreadable errno (EISDIR)', (r) => mkdirSync(state(r))],
  ];
  for (const [name, breakState] of kinds) {
    for (const paused of [false, true]) {
      it(`${name}${paused ? ', paused' : ''}: marker written; state deleted, new process: nothing older approved`, async () => {
        const r = await rig();
        await createN(r, 2); // after the past SINCE
        breakState(r);
        if (paused) writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
        expect((await r.auto().sweep()).stopped).toBe('counter_unreadable');
        const m = lstatSync(marker(r));
        expect([m.isFile(), m.mode & 0o777, m.size]).toEqual([true, 0o600, 0]);
        rmSync(join(r.dir, AUTO_PAUSE_FILE), { force: true });
        rmSync(state(r), { recursive: true });
        expect(await r.auto().sweep()).toEqual({ claimed: 0, attempted: 0 });
        expect(r.logs.filter((l) => /state missing, cut-off = now/.test(l))).toHaveLength(1);
        expect(counter(r.dir).since).toBe(new Date(r.clock.t).toISOString());
        expect(r.added).toEqual([]);
      });
    }
  }

  it('every such sweep ensures the marker, also within the log rate limit; status() writes nothing', async () => {
    const r = await rig();
    corrupt(r);
    const a = r.auto();
    await a.status();
    await expect(a.todayCount()).rejects.toThrow();
    expect(existsSync(marker(r))).toBe(false);
    await a.sweep();
    rmSync(marker(r));
    await a.sweep();
    expect(existsSync(marker(r))).toBe(true);
    expect((await a.sweep()).stopped).toBe('counter_unreadable'); // EEXIST is fine
    expect(failLines(r)).toHaveLength(0);
    expect(readFileSync(state(r), 'utf8')).toBe('{not json');
  });

  // The state turns corrupt after confirm(): at the listing (prune reads next) or at the pause
  // check right before claim() / reserveRetry().
  for (const step of ['prune', 'claim', 'retry'] as const) {
    it(`corrupted before ${step}: counter_unreadable and the marker is back`, async () => {
      const r = await rig();
      await createN(r, 1);
      if (step === 'retry') r.addAnswers.push('pending');
      let armed = false;
      let checks = 0;
      const breakNow = () => {
        rmSync(marker(r), { force: true });
        corrupt(r);
      };
      const a = r.auto({
        stat: async () => {
          // 1: sweep start, 2: before the claim or the retry.
          if (armed && step !== 'prune' && ++checks === 2) breakNow();
          throw Object.assign(new Error('x'), { code: 'ENOENT' });
        },
      });
      // Confirm the process first (claim: with the request not yet eligible for a claim).
      if (step === 'retry') {
        await a.sweep();
        r.clock.t += AUTO_RETRY_BACKOFF_MS;
      } else {
        writeFileSync(state(r), future.replace('2099-01-01', '2026-11-23'), { mode: 0o600 });
        const list = r.store.list.bind(r.store);
        r.store.list = async () => [];
        await a.sweep();
        r.clock.t += 10_000;
        await createN(r, 1, 1);
        r.store.list = async () => {
          const out = await list();
          if (step === 'prune') breakNow();
          return out;
        };
      }
      armed = true;
      expect(await a.sweep()).toEqual({ claimed: 0, attempted: 0, stopped: 'counter_unreadable' });
      if (step !== 'prune') expect(checks).toBe(2);
      expect(existsSync(marker(r))).toBe(true);
    });
  }

  it('the dir turned unsafe during the sweep: nothing is written into it', async () => {
    const r = await rig();
    await createN(r, 1);
    const a = r.auto();
    const list = r.store.list.bind(r.store);
    r.store.list = async () => {
      const out = await list();
      rmSync(marker(r), { force: true });
      corrupt(r);
      chmodSync(r.dir, 0o777);
      return out;
    };
    expect((await a.sweep()).stopped).toBe('counter_unreadable');
    expect(existsSync(marker(r))).toBe(false);
  });

  for (const paused of [false, true]) {
    it(`marker write failure${paused ? ' while paused' : ''}: still counter_unreadable, logged hourly (errno only), retried`, async () => {
      const r = await rig();
      await createN(r, 1);
      corrupt(r);
      if (paused) writeFileSync(join(r.dir, AUTO_PAUSE_FILE), '');
      chmodSync(r.dir, 0o500); // safe for the dir check, but nothing can be created
      try {
        const a = r.auto();
        expect(await a.sweep()).toEqual({
          claimed: 0,
          attempted: 0,
          stopped: 'counter_unreadable',
        });
        r.clock.t += 60_000;
        expect((await a.sweep()).stopped).toBe('counter_unreadable');
        expect(failLines(r)).toEqual([
          'signup: auto-approve marker not written (EACCES); retried at the next unreadable-state sweep',
        ]);
        r.clock.t += 60 * 60_000;
        await a.sweep();
        expect(failLines(r)).toHaveLength(2);
        chmodSync(r.dir, 0o700);
        await a.sweep();
        expect(existsSync(marker(r))).toBe(true);
        expect(readFileSync(state(r), 'utf8')).toBe('{not json');
        expect(r.added).toEqual([]);
      } finally {
        chmodSync(r.dir, 0o700);
      }
    });
  }
});
