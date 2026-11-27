/**
 * BETA-G1 fix bundle (pre-build security review): admin-owned state decides approve / resend in
 * verified mode, the counters file read cap, contradictory verify settings refuse, the drain holds
 * auto-approved mails while paused, and the unverified purge finishes a half-removed web request.
 * Temp dirs under the private TMPDIR only.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signupWiringFromEnv } from '../signup/admin-wiring.js';
import type { EmailSender } from '../signup/email.js';
import type { FetchLike } from '../signup/notify.js';
import { SignupApprover, type AddOutcome } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';
import { loadVerifyKeys } from '../signup/verify.js';
import {
  addressHash,
  peekMailCount,
  VERIFY_COUNTERS_MAX_BYTES,
  VERIFY_DIR,
  Verifier,
} from '../signup/verifyState.js';
import type { AdminSpool } from '../accounts.js';

const T0 = Date.parse('2026-11-23T10:00:00Z'); // 12:00 Israel
const DAY = 86_400_000;
const SITE = 'https://site.example.com';
const KEY = randomBytes(32).toString('hex');
const person = (i: number) => ({
  name: `Tester ${i}`,
  email: `tester${i}@example.com`,
  role: 'Student',
  lang: 'en' as const,
  consent: true as const,
});

const roots: string[] = [];
const allLogs: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  // Class codes and counts only, on every line of this suite.
  for (const l of allLogs.splice(0))
    expect(l).not.toMatch(/@|Tester|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{16}|\/tmp|\/var|\/home/);
});

function dirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1fix-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const storeDir = join(root, 'p');
  const stateDir = join(root, 's');
  mkdirSync(storeDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  return { root, storeDir, stateDir };
}
const log = (into: string[]) => (l: string) => {
  into.push(l);
  allLogs.push(l);
};

async function rig(o: { claimed?: Set<string> } = {}) {
  const d = dirs();
  const clock = { t: T0 };
  const keyFile = join(d.root, 'verify.key');
  writeFileSync(keyFile, KEY, { mode: 0o600 });
  const logs: string[] = [];
  let v: Verifier | null = null;
  const store = new PendingStore(d.storeDir, {
    now: () => clock.t,
    onRemoved: (id) => v!.remove(id),
  });
  await store.init();
  const mails: { id: string; email: string }[] = [];
  const email: EmailSender = {
    sendApproval: async (to) => void mails.push({ id: to.id, email: to.email }),
    sendVerify: async () => undefined,
  };
  v = new Verifier({
    stateDir: d.stateDir,
    storeDir: d.storeDir,
    store,
    email,
    siteUrl: SITE,
    keys: () => loadVerifyKeys(keyFile),
    since: T0 - DAY,
    now: () => clock.t,
    log: log(logs),
    claimed: async () => o.claimed ?? new Set(),
  });
  const adds: string[] = [];
  const add = { out: 'done' as AddOutcome };
  const owner = new SignupApprover({
    store,
    accounts: {
      add: async (e) => {
        adds.push(e);
        return add.out;
      },
    },
    email,
    quiet: null,
    now: () => clock.t,
    log: log(logs),
    mailBinding: v,
    ownerActions: true,
  });
  const vpath = (id: string) => join(d.stateDir, VERIFY_DIR, `${id}.json`);
  return { ...d, clock, store, v, owner, adds, add, mails, logs, vpath };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const webId = async (r: Rig, i = 1) =>
  (await r.store.createIfNew(person(i), { origin: 'web' })).record.id;
const bound = (r: Rig, id: string) =>
  existsSync(r.vpath(id)) &&
  (JSON.parse(readFileSync(r.vpath(id), 'utf8')) as { approvedAddr?: string }).approvedAddr ===
    addressHash(person(1).email);

describe('fix 1: verified mode, a row claiming progress without an admin binding', () => {
  it('approve of a normal pending request: one add, bound, mailed (unchanged path)', async () => {
    const r = await rig();
    const id = await webId(r);
    expect(await r.owner.approve(id)).toMatchObject({ ok: true });
    expect(r.adds).toHaveLength(1);
    expect(bound(r, id)).toBe(true);
    expect(r.mails).toHaveLength(1);
    // Once bound, a later approve is the old answer and adds nothing.
    expect(await r.owner.approve(id)).toMatchObject({ ok: true, note: 'already_done' });
    expect(r.adds).toHaveLength(1);
  });

  for (const forged of [
    { status: 'pending' as const, accountAdded: true },
    { status: 'approved' as const, accountAdded: true },
  ])
    it(`approve of ${forged.status} + accountAdded with no binding: the add runs again`, async () => {
      const r = await rig();
      const id = await webId(r);
      await r.store.update(id, forged);
      const out = await r.owner.approve(id);
      expect(out).toMatchObject({ ok: true, record: { status: 'email_sent' } });
      expect(r.adds).toEqual([person(1).email]);
      expect(bound(r, id)).toBe(true);
      expect(r.mails).toHaveLength(1);
    });

  it('resend of email_failed + accountAdded with no binding: the add runs, then the mail', async () => {
    const r = await rig();
    const id = await webId(r);
    await r.store.update(id, { status: 'email_failed', accountAdded: true });
    expect(await r.owner.resend(id)).toMatchObject({ ok: true });
    expect(r.adds).toHaveLength(1);
    expect(r.mails).toHaveLength(1);
  });

  it('approve of email_queued with no binding: the add runs; the mail stays queued', async () => {
    const r = await rig();
    const id = await webId(r);
    await r.store.update(id, { status: 'email_queued', accountAdded: false });
    const out = await r.owner.approve(id);
    expect(out).toMatchObject({ ok: true, note: 'email_queued' });
    expect(r.adds).toHaveLength(1);
    expect(bound(r, id)).toBe(true);
    expect((await r.store.get(id)).accountAdded).toBe(true);
    expect(r.mails).toHaveLength(0);
  });

  it('the add fails (error / cap): refused unbound_state, nothing mailed, nothing bound', async () => {
    for (const fail of ['error', 'cap_reached'] as const) {
      const r = await rig();
      const id = await webId(r);
      await r.store.update(id, { status: 'email_failed', accountAdded: true });
      r.add.out = fail;
      expect(await r.owner.resend(id)).toMatchObject({ ok: false, code: 'unbound_state' });
      expect(await r.owner.approve(id)).toMatchObject({ ok: false, code: 'unbound_state' });
      expect(r.mails).toEqual([]);
      expect(bound(r, id)).toBe(false);
      expect(r.logs).toContain(`signup: unbound record state refused (account_${fail})`);
    }
  });

  it('unreadable verify state: refused unbound_state without any add or mail', async () => {
    const r = await rig();
    const id = await webId(r);
    await r.store.update(id, { status: 'approved', accountAdded: true });
    mkdirSync(join(r.stateDir, VERIFY_DIR), { mode: 0o700 });
    writeFileSync(r.vpath(id), '{bad', { mode: 0o600 });
    expect(await r.owner.approve(id)).toMatchObject({ ok: false, code: 'unbound_state' });
    expect(await r.owner.resend(id)).toMatchObject({ ok: false, code: 'unbound_state' });
    expect(r.adds).toEqual([]);
    expect(r.mails).toEqual([]);
    expect(r.logs).toContain('signup: unbound record state refused (state_unreadable)');
  });

  it('the add is still pending: account_pending, no mail', async () => {
    const r = await rig();
    const id = await webId(r);
    await r.store.update(id, { status: 'email_failed', accountAdded: true });
    r.add.out = 'pending';
    expect(await r.owner.resend(id)).toMatchObject({ ok: false, code: 'account_pending' });
    expect(r.mails).toEqual([]);
  });

  it('a row approved before verified mode (account exists, no binding): re-add answers exists', async () => {
    const r = await rig();
    const id = (await r.store.createIfNew(person(1))).record.id; // Apps Script shape
    await r.store.update(id, { status: 'email_failed', accountAdded: true });
    r.add.out = 'exists';
    expect(await r.owner.resend(id)).toMatchObject({ ok: true, record: { status: 'email_sent' } });
    expect(r.adds).toHaveLength(1);
    expect(bound(r, id)).toBe(true);
    // Already sent before verified mode: nothing is re-added and nothing is sent.
    const sentId = (await r.store.createIfNew(person(2))).record.id;
    await r.store.update(sentId, { status: 'email_sent', accountAdded: true });
    expect(await r.owner.approve(sentId)).toMatchObject({ ok: true, note: 'already_done' });
    expect(r.adds).toHaveLength(1);
  });

  it('a forged email_sent web row: the add runs and binds, no mail, already_done', async () => {
    for (const accountAdded of [true, false]) {
      const r = await rig();
      const id = await webId(r);
      await r.store.update(id, { status: 'email_sent', accountAdded });
      expect(await r.owner.approve(id)).toMatchObject({ ok: true, note: 'already_done' });
      expect(r.adds).toEqual([person(1).email]);
      expect(bound(r, id)).toBe(true);
      expect((await r.store.get(id)).accountAdded).toBe(true);
      expect(r.mails).toEqual([]);
    }
  });

  it('a legacy email_sent web row (account exists): resend binds once and sends nothing', async () => {
    const r = await rig();
    const id = await webId(r);
    await r.store.update(id, { status: 'email_sent', accountAdded: true });
    r.add.out = 'exists';
    for (let i = 0; i < 2; i++)
      expect(await r.owner.resend(id)).toMatchObject({ ok: true, note: 'already_done' });
    expect(r.adds).toHaveLength(1);
    expect(bound(r, id)).toBe(true);
    expect(r.mails).toEqual([]);
  });

  it('an email_sent web row whose add or binding fails: unbound_state, no mail', async () => {
    for (const fail of ['error', 'cap_reached', 'bind'] as const) {
      const r = await rig();
      const id = await webId(r);
      await r.store.update(id, { status: 'email_sent', accountAdded: true });
      if (fail === 'bind')
        r.v.bindApproval = async () => {
          throw new Error('EACCES');
        };
      else r.add.out = fail;
      expect(await r.owner.approve(id)).toMatchObject({ ok: false, code: 'unbound_state' });
      expect(await r.owner.resend(id)).toMatchObject({ ok: false, code: 'unbound_state' });
      expect(bound(r, id)).toBe(false);
      expect(r.mails).toEqual([]);
    }
  });

  it('without verified mode (no binding configured) nothing changes: no extra add', async () => {
    const d = dirs();
    const store = new PendingStore(d.storeDir, { now: () => T0 });
    await store.init();
    const adds: string[] = [];
    const mails: string[] = [];
    const a = new SignupApprover({
      store,
      accounts: {
        add: async (e) => {
          adds.push(e);
          return 'done' as const;
        },
      },
      email: { sendApproval: async (to) => void mails.push(to.id) },
      quiet: null,
      now: () => T0,
      ownerActions: true,
    });
    const id = (await store.createIfNew(person(1))).record.id;
    await store.update(id, { status: 'email_failed', accountAdded: true });
    expect(await a.resend(id)).toMatchObject({ ok: true });
    expect(adds).toEqual([]);
    expect(mails).toEqual([id]);
  });
});

describe('fix 2: mail-counters.json has its own read cap', () => {
  const at = (t: number) => new Date(t).toISOString();
  const hex = (i: number) => i.toString(16).padStart(64, '0');
  it('the worst case (1000 a day on 8 calendar days, distinct addresses) reads and shrinks', async () => {
    const r = await rig();
    mkdirSync(join(r.stateDir, VERIFY_DIR), { mode: 0o700 });
    const addrs: Record<string, string[]> = {};
    // The 7-day window back from T0 touches 8 Israel days; 1000 mails on each.
    for (let day = 0; day < 8; day++)
      for (let i = 0; i < 1000; i++)
        addrs[hex(day * 1000 + i)] = [at(T0 - 7 * DAY + 60_000 + day * (DAY - 3_600_000) + i)];
    const file = join(r.stateDir, VERIFY_DIR, 'mail-counters.json');
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(T0);
    writeFileSync(file, `${JSON.stringify({ v: 1, day, dayCount: 1000, addrs })}\n`, {
      mode: 0o600,
    });
    const size = statSync(file).size;
    expect(size).toBeGreaterThan(256 * 1024);
    expect(size).toBeLessThan(VERIFY_COUNTERS_MAX_BYTES);
    expect(await peekMailCount(r.stateDir, day)).toBe(1000);
    expect(await r.v.mailCounts([day])).toEqual([1000]);
    // A day later the oldest entries are out of the window: the purge rewrites a smaller file.
    r.clock.t = T0 + DAY;
    expect(await r.v.purgeUnverified(7)).toMatchObject({ purged: 0 });
    expect(statSync(file).size).toBeLessThan(size);
    const left = JSON.parse(readFileSync(file, 'utf8')) as { addrs: Record<string, string[]> };
    expect(Object.keys(left.addrs).length).toBeLessThan(8000);
  });
  it('an oversized file stays fail closed (limit reached) and is never reset', async () => {
    const r = await rig();
    mkdirSync(join(r.stateDir, VERIFY_DIR), { mode: 0o700 });
    const file = join(r.stateDir, VERIFY_DIR, 'mail-counters.json');
    writeFileSync(file, ' '.repeat(VERIFY_COUNTERS_MAX_BYTES + 1), { mode: 0o600 });
    const before = readFileSync(file, 'utf8');
    expect(await r.v.mailCounts(['2026-11-23'])).toBeNull();
    expect(await peekMailCount(r.stateDir, '2026-11-23')).toBeNull();
    await webId(r, 1);
    const keys = await loadVerifyKeys(join(r.root, 'verify.key'));
    const ids = (await r.store.list()).map((x) => x.id);
    expect(await r.v.mint(ids[0]!, keys)).toBe('limit_unreadable');
    await r.v.purgeUnverified(7);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('fix 3: contradictory verification settings refuse the sign-up admin wiring', () => {
  const base = (root: string, sd: string) => ({
    TBI_SIGNUP_ADMIN: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_RESEND_KEY_FILE: join(root, 'key'),
    TBI_SIGNUP_FROM: 'x',
    TBI_SIGNUP_LAB_URL: 'https://l.example.invalid/',
    TBI_SIGNUP_QUIET: 'off',
    TBI_SIGNUP_AUTO_APPROVE: '1',
    TBI_SIGNUP_AUTO_DAILY_CAP: '5',
    TBI_SIGNUP_AUTO_STATE_DIR: sd,
    TBI_SIGNUP_MAIL_MAX_PER_HOUR: '30',
    TBI_SIGNUP_MAIL_MAX_PER_DAY: '95',
    TBI_SIGNUP_MAIL_MAX_PER_30D: '2700',
  });
  const wire = async (env: Record<string, string>, logs: string[]) =>
    signupWiringFromEnv(env, {} as AdminSpool, {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log: log(logs),
      email: { sendApproval: async () => undefined, sendVerify: async () => undefined },
      autoActor: () => null,
    });
  const cases: [string, Record<string, string>, string][] = [
    [
      'AUTO_WEB=verified without TBI_SIGNUP_VERIFY',
      { TBI_SIGNUP_AUTO_WEB: 'verified' },
      'signup: admin routes disabled (config: TBI_SIGNUP_AUTO_WEB=verified needs TBI_SIGNUP_VERIFY=1 with valid settings)',
    ],
    [
      'AUTO_WEB=verified with a bad verify setting',
      {
        TBI_SIGNUP_AUTO_WEB: 'verified',
        TBI_SIGNUP_VERIFY: '1',
        TBI_SIGNUP_SITE_URL: 'http://site.example.com',
      },
      'signup: admin routes disabled (config: TBI_SIGNUP_AUTO_WEB=verified needs TBI_SIGNUP_VERIFY=1 with valid settings)',
    ],
    [
      'AUTO_WEB=included with TBI_SIGNUP_VERIFY=1',
      { TBI_SIGNUP_AUTO_WEB: 'included', TBI_SIGNUP_VERIFY: '1', TBI_SIGNUP_SITE_URL: SITE },
      'signup: admin routes disabled (config: TBI_SIGNUP_VERIFY needs TBI_SIGNUP_AUTO_WEB verified or excluded)',
    ],
  ];
  for (const [name, extra, line] of cases)
    it(`${name}: refused, one class line, nothing written in the state dir`, async () => {
      const d = dirs();
      rmSync(d.storeDir, { recursive: true });
      const keyFile = join(d.root, 'verify.key');
      writeFileSync(keyFile, KEY, { mode: 0o600 });
      const logs: string[] = [];
      const env = { ...base(d.root, d.stateDir), TBI_SIGNUP_VERIFY_KEY_FILE: keyFile, ...extra };
      expect(await wire(env, logs)).toBeNull();
      expect(logs.filter((l) => /admin routes disabled/.test(l))).toEqual([line]);
      expect(readdirSync(d.stateDir)).toEqual([]);
      expect(existsSync(join(d.root, 'p'))).toBe(false);
    });
  for (const flag of ['0', ''])
    it(`AUTO_WEB=included with TBI_SIGNUP_VERIFY="${flag}" is verification off: wired`, async () => {
      const d = dirs();
      const logs: string[] = [];
      const env = {
        ...base(d.root, d.stateDir),
        TBI_SIGNUP_AUTO_WEB: 'included',
        TBI_SIGNUP_VERIFY: flag,
      };
      writeFileSync(join(d.root, 'key'), KEY, { mode: 0o600 });
      expect(await wire(env, logs)).not.toBeNull();
      expect(logs.filter((l) => /disabled/.test(l))).toEqual([]);
    });
  it('AUTO_WEB=included with another non-empty TBI_SIGNUP_VERIFY value is refused', async () => {
    const d = dirs();
    const env = {
      ...base(d.root, d.stateDir),
      TBI_SIGNUP_AUTO_WEB: 'included',
      TBI_SIGNUP_VERIFY: 'yes',
    };
    expect(await wire(env, [])).toBeNull();
  });
  it('valid configs still wire: excluded + VERIFY=1, included without VERIFY', async () => {
    for (const extra of <Record<string, string>[]>[
      { TBI_SIGNUP_AUTO_WEB: 'excluded', TBI_SIGNUP_VERIFY: '1', TBI_SIGNUP_SITE_URL: SITE },
      { TBI_SIGNUP_AUTO_WEB: 'included' },
    ]) {
      const d = dirs();
      const keyFile = join(d.root, 'verify.key');
      writeFileSync(keyFile, KEY, { mode: 0o600 });
      const logs: string[] = [];
      const env = { ...base(d.root, d.stateDir), TBI_SIGNUP_VERIFY_KEY_FILE: keyFile, ...extra };
      expect(await wire(env, logs)).not.toBeNull();
      expect(logs.filter((l) => /disabled/.test(l))).toEqual([]);
    }
  });
});

describe('fix 4: the drain holds auto-approved mails while auto-approve.paused exists', () => {
  async function drainRig(paused: () => Promise<boolean>) {
    const d = dirs();
    const store = new PendingStore(d.storeDir, { now: () => T0 });
    await store.init();
    const mails: string[] = [];
    const drainer = new SignupApprover({
      store,
      accounts: { add: async () => 'error' },
      email: { sendApproval: async (to) => void mails.push(to.id) },
      quiet: null,
      now: () => T0,
      paused,
    });
    const queued = async (i: number, auto: boolean) => {
      const id = (await store.createIfNew(person(i))).record.id;
      await store.update(id, {
        status: 'email_queued',
        accountAdded: true,
        emailSendAfter: new Date(T0 - 1000).toISOString(),
        ...(auto ? { autoApprovedAt: new Date(T0 - 5000).toISOString() } : {}),
      });
      return id;
    };
    return { store, mails, drainer, queued, ...d };
  }
  it('paused: auto-approved mails wait; the owner-approved queued mail is sent', async () => {
    const flag = { paused: true };
    const r = await drainRig(async () => flag.paused);
    const auto = await r.queued(1, true);
    const own = await r.queued(2, false);
    expect(await r.drainer.drainEmails()).toBe(1);
    expect(r.mails).toEqual([own]);
    expect((await r.store.get(auto)).status).toBe('email_queued');
    flag.paused = false;
    expect(await r.drainer.drainEmails()).toBe(1);
    expect(r.mails).toEqual([own, auto]);
  });
  it('a pause check that errors counts as paused', async () => {
    const r = await drainRig(async () => {
      throw new Error('EACCES');
    });
    await r.queued(1, true);
    expect(await r.drainer.drainEmails()).toBe(0);
    expect(r.mails).toEqual([]);
  });
});

describe('fix 5: the unverified purge finishes a web request whose .web marker is gone', () => {
  it('never purges a request whose admin state holds an approval binding', async () => {
    const r = await rig();
    const id = await webId(r);
    await r.v.bindApproval(id, person(1).email);
    if (existsSync(join(r.storeDir, `${id}.web`))) unlinkSync(join(r.storeDir, `${id}.web`));
    r.clock.t = T0 + 7 * DAY;
    expect((await r.v.purgeUnverified(7)).purged).toBe(0);
    expect((await r.store.list()).map((x) => x.id)).toEqual([id]);
  });

  it('purges the orphan; never a verified, approved, account-added or non-web record', async () => {
    const r = await rig();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await webId(r, i));
    const [orphan, verified, approved, added, withMarker] = ids as [
      string,
      string,
      string,
      string,
      string,
    ];
    const apps = (await r.store.createIfNew(person(7))).record.id;
    for (const id of [orphan, verified, approved, added, apps])
      if (existsSync(join(r.storeDir, `${id}.web`))) unlinkSync(join(r.storeDir, `${id}.web`));
    await r.store.update(verified, { verifiedAt: new Date(T0).toISOString() });
    await r.store.update(approved, { status: 'approved' });
    await r.store.update(added, { accountAdded: true });
    r.clock.t = T0 + 7 * DAY;
    const p = await r.v.purgeUnverified(7);
    expect(p.purged).toBe(2);
    const left = (await r.store.list()).map((x) => x.id).sort();
    expect(left).toEqual([verified, approved, added, apps].sort());
    expect(left).not.toContain(orphan);
    expect(left).not.toContain(withMarker);
  });
});
