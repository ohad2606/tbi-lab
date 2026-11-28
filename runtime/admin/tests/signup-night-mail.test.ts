/**
 * DEC-39 (BETA-G1): with TBI_SIGNUP_QUIET_AUTO_MAIL=1 (honoured only with the mail caps, the pause
 * state dir and verified mode) the approval mail of an auto-approved AND verified web request may
 * go out in quiet hours. Everything else keeps waiting for the end of quiet hours. Real store, real
 * mail gate, real pause check in a private temp dir; fakes for the provider and the binding.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { signupWiringFromEnv } from '../signup/admin-wiring.js';
import { AUTO_PAUSE_FILE, approvalHold } from '../signup/autoApprove.js';
import type { EmailSender } from '../signup/email.js';
import { GATE_FILE, gateCount, MailGate, type MailLimits } from '../signup/mailGate.js';
import type { FetchLike } from '../signup/notify.js';
import { parseQuiet } from '../signup/quietHours.js';
import { SignupApprover, type ApprovalMailBinding } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';
import { addressHash, VERIFY_DIR } from '../signup/verifyState.js';
import type { AdminSpool } from '../accounts.js';
import type { Principal } from '../../identity/principal.js';

// Israel is UTC+2 in November.
const AT_2330 = Date.parse('2026-11-23T21:30:00Z');
const AT_0200 = Date.parse('2026-11-24T00:00:00Z');
const NEXT_0800 = '2026-11-24T06:00:00.000Z';
const QUIET = parseQuiet('23:00-08:00');
const LIMITS: MailLimits = { perHour: 30, perDay: 95, per30d: 2700 };
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
  // Class codes and counts only: no id, address, name or path.
  for (const l of allLogs.splice(0))
    expect(l).not.toMatch(/@|example\.com|Tester|[0-9A-HJKMNP-TV-Z]{26}|tbi-night-/);
});

function dirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-night-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const storeDir = join(root, 'p');
  const stateDir = join(root, 's');
  mkdirSync(storeDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  return { root, storeDir, stateDir, pause: join(stateDir, AUTO_PAUSE_FILE) };
}
const log = (l: string) => void allLogs.push(l);

/** A fake binding: `bound` id -> address; `proven` ids carry a recorded confirmation. */
function fakeBinding() {
  const bound = new Map<string, string>();
  const proven = new Set<string>();
  let broken = false;
  const b: ApprovalMailBinding = {
    bindApproval: async (id, email) => void bound.set(id, email),
    checkApproval: async (id, email, needProof) => {
      if (broken) throw new Error('EIO');
      if (!bound.has(id)) return 'unbound';
      if (bound.get(id) !== email) return 'addr_changed';
      return needProof && !proven.has(id) ? 'unproven' : 'ok';
    },
    hasApproval: async (id) => bound.has(id),
  };
  return { b, bound, proven, breakIt: () => (broken = true) };
}

async function rig(o: { limits?: MailLimits; paused?: () => Promise<boolean> } = {}) {
  const d = dirs();
  const clock = { t: AT_2330 };
  const now = () => clock.t;
  const store = new PendingStore(d.storeDir, { now });
  await store.init();
  const calls: string[] = [];
  const raw: EmailSender = { sendApproval: async (to) => void calls.push(to.id) };
  const gate = new MailGate({
    stateDir: d.stateDir,
    storeDir: d.storeDir,
    limits: o.limits ?? LIMITS,
    now,
    log,
  });
  const email = gate.wrap(raw);
  const bind = fakeBinding();
  const paused = o.paused ?? approvalHold({ stateDir: d.stateDir, storeDir: d.storeDir, now, log });
  const common = { store, email, quiet: QUIET, now, log, mailBinding: bind.b };
  const auto = (night = true) =>
    new SignupApprover({
      ...common,
      accounts: { add: async () => 'done' },
      actor: 'auto',
      paused,
      ...(night ? { nightAutoMail: true } : {}),
    });
  const drainer = (night = true) =>
    new SignupApprover({
      ...common,
      accounts: { add: async () => 'error' },
      paused,
      ...(night ? { nightAutoMail: true } : {}),
    });
  const owner = (night = false) =>
    new SignupApprover({
      ...common,
      accounts: { add: async () => 'done' },
      ownerActions: true,
      ...(night ? { nightAutoMail: true } : {}),
    });
  /** A web request claimed by auto-approve and confirmed (still pending). */
  const autoPending = async (i: number, o2: { proven?: boolean; web?: boolean } = {}) => {
    const id = (await store.createIfNew(person(i), o2.web === false ? {} : { origin: 'web' }))
      .record.id;
    await store.update(id, { autoApprovedAt: new Date(clock.t - 60_000).toISOString() });
    if (o2.proven !== false) bind.proven.add(id);
    return id;
  };
  /** A queued approval mail; `auto` = auto-approved, confirmed and bound. */
  const queued = async (i: number, auto: boolean, sendAfter = clock.t - 1000) => {
    const id = (await store.createIfNew(person(i), { origin: 'web' })).record.id;
    await store.update(id, {
      status: 'email_queued',
      accountAdded: true,
      emailSendAfter: new Date(sendAfter).toISOString(),
      ...(auto ? { autoApprovedAt: new Date(clock.t - 5 * 60_000).toISOString() } : {}),
    });
    bind.bound.set(id, person(i).email);
    if (auto) bind.proven.add(id);
    return id;
  };
  return { ...d, clock, store, calls, gate, bind, auto, drainer, owner, autoPending, queued };
}

describe('DEC-39: the exempt path', () => {
  it('23:30: an auto-approved verified web request is mailed at once, through the gate', async () => {
    const r = await rig();
    const id = await r.autoPending(1);
    const out = await r.auto().approve(id);
    expect(out).toMatchObject({ ok: true, record: { status: 'email_sent', emailSendAfter: null } });
    expect(r.calls).toEqual([id]);
    expect(await gateCount(r.stateDir)).toBe(1);
  });

  it('23:30: the drain sends a due auto-approved verified mail (and only that one)', async () => {
    const r = await rig();
    const auto = await r.queued(1, true);
    const manual = await r.queued(2, false);
    expect(await r.drainer().drainEmails()).toBe(1);
    expect(r.calls).toEqual([auto]);
    expect((await r.store.get(manual)).status).toBe('email_queued');
  });
});

describe('DEC-39: held until the end of quiet hours', () => {
  it('23:30: owner approve and resend are queued and the provider is not called', async () => {
    const r = await rig();
    const pending = await r.autoPending(1);
    const failed = await r.queued(2, true);
    await r.store.update(failed, { status: 'email_failed', emailAttempts: 1 });
    // Even an owner approver that was (wrongly) given the option never skips quiet hours.
    for (const night of [false, true]) {
      const a = await r.owner(night).approve(pending);
      expect(a).toMatchObject({
        ok: true,
        note: 'email_queued',
        record: { status: 'email_queued', emailSendAfter: NEXT_0800 },
      });
    }
    const s = await r.owner(true).resend(failed);
    expect(s).toMatchObject({
      ok: true,
      record: { status: 'email_queued', emailSendAfter: NEXT_0800 },
    });
    expect(r.calls).toEqual([]);
    expect(await gateCount(r.stateDir)).toBeNull();
  });

  it('manual and unverified records are queued until 08:00', async () => {
    const r = await rig();
    const unproven = await r.autoPending(1, { proven: false });
    const signed = await r.autoPending(2, { web: false });
    for (const id of [unproven, signed]) {
      const out = await r.auto().approve(id);
      expect(out).toMatchObject({
        ok: true,
        record: { status: 'email_queued', emailSendAfter: NEXT_0800 },
      });
      expect(out.ok && out.record.emailAttemptedAt).toBeFalsy();
    }
    // A manual (owner) queued record that is due: not sent by the night drain.
    const manual = await r.queued(3, false);
    // An auto record whose verify state cannot be read: held.
    const unreadable = await r.queued(4, true);
    r.bind.breakIt();
    expect(await r.drainer().drainEmails()).toBe(0);
    expect(r.calls).toEqual([]);
    for (const id of [manual, unreadable])
      expect((await r.store.get(id)).status).toBe('email_queued');
  });

  it('an auto record the owner approved, or one with an earlier attempt, is not exempt', async () => {
    const r = await rig();
    const byOwner = await r.queued(1, true);
    await r.store.update(byOwner, { approvedBy: 'owner' });
    const retried = await r.queued(2, true);
    await r.store.update(retried, { emailAttempts: 1 });
    expect(await r.drainer().drainEmails()).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it('02:00: mail queued earlier keeps its emailSendAfter (owner-queued and auto)', async () => {
    const r = await rig();
    r.clock.t = AT_2330;
    const owner = await r.autoPending(1);
    await r.owner().approve(owner);
    const oldAuto = await r.queued(2, true, Date.parse(NEXT_0800));
    r.clock.t = AT_0200;
    const before = await Promise.all([owner, oldAuto].map((id) => r.store.get(id)));
    expect(await r.drainer().drainEmails()).toBe(0);
    expect(r.calls).toEqual([]);
    const after = await Promise.all([owner, oldAuto].map((id) => r.store.get(id)));
    expect(after).toEqual(before);
    expect(after.map((x) => x.emailSendAfter)).toEqual([NEXT_0800, NEXT_0800]);
  });

  it('night pause holds with no attempt recorded; after resume the drain sends', async () => {
    const r = await rig();
    writeFileSync(r.pause, '');
    const id = await r.autoPending(1);
    const out = await r.auto().approve(id);
    expect(out).toMatchObject({
      ok: true,
      note: 'email_queued',
      record: { status: 'email_queued' },
    });
    const rec = await r.store.get(id);
    expect(rec.emailAttemptedAt).toBeFalsy();
    expect(rec.emailAttempts).toBe(0);
    expect(await r.drainer().drainEmails()).toBe(0);
    expect(r.calls).toEqual([]);
    expect(await gateCount(r.stateDir)).toBeNull();
    unlinkSync(r.pause);
    r.clock.t += 60_000;
    expect(await r.drainer().drainEmails()).toBe(1);
    expect(r.calls).toEqual([id]);
  });

  it('a pause read error holds with no attempt recorded', async () => {
    const r = await rig({
      paused: async () => {
        throw new Error('EIO');
      },
    });
    const id = await r.autoPending(1);
    await r.auto().approve(id);
    const q = await r.queued(2, true);
    expect(await r.drainer().drainEmails()).toBe(0);
    expect(r.calls).toEqual([]);
    for (const x of [id, q]) {
      const rec = await r.store.get(x);
      expect(rec.status).toBe('email_queued');
      expect(rec.emailAttemptedAt).toBeFalsy();
      expect(rec.emailAttempts).toBe(0);
    }
  });

  it('the hour cap at night stops the drain (queued with retryAt, never failed)', async () => {
    const r = await rig({ limits: { perHour: 1, perDay: 95, per30d: 2700 } });
    const ids = [await r.queued(1, true), await r.queued(2, true), await r.queued(3, true)];
    expect(await r.drainer().drainEmails()).toBe(1);
    expect(r.calls).toEqual([ids[0]]);
    const second = await r.store.get(ids[1]!);
    expect(second).toMatchObject({
      status: 'email_queued',
      lastError: 'mail_cap',
      emailAttempts: 0,
    });
    expect(Date.parse(second.emailSendAfter!)).toBeGreaterThan(r.clock.t);
    // The drain stopped at the cap: the third was not touched.
    expect((await r.store.get(ids[2]!)).lastError).toBeNull();
    expect(await gateCount(r.stateDir)).toBe(1);
  });

  it('an unreadable gate state holds (email_queued, mail_cap; never email_failed)', async () => {
    const r = await rig();
    writeFileSync(join(r.stateDir, GATE_FILE), 'not json', { mode: 0o600 });
    const id = await r.autoPending(1);
    const out = await r.auto().approve(id);
    expect(out).toMatchObject({
      ok: true,
      note: 'email_queued',
      record: { status: 'email_queued', lastError: 'mail_cap' },
    });
    expect(r.calls).toEqual([]);
  });

  it('flags off: the record is queued exactly as before (snapshot)', async () => {
    const r = await rig();
    const id = await r.autoPending(1);
    const out = await r.auto(false).approve(id);
    expect(out.ok && out.note).toBe('email_queued');
    const rec = JSON.parse(readFileSync(join(r.storeDir, `${id}.json`), 'utf8'));
    expect(rec).toEqual({
      v: rec.v,
      id,
      createdAt: rec.createdAt,
      updatedAt: new Date(AT_2330).toISOString(),
      name: 'Tester 1',
      email: 'tester1@example.com',
      role: 'Student',
      lang: 'en',
      consent: true,
      ...(rec.heardFrom !== undefined ? { heardFrom: rec.heardFrom } : {}),
      origin: 'web',
      status: 'email_queued',
      accountAdded: true,
      emailAttemptedAt: null,
      emailAttempts: 0,
      emailSendAfter: NEXT_0800,
      lastError: null,
      notified: false,
      notifyPending: false,
      autoApprovedAt: new Date(AT_2330 - 60_000).toISOString(),
    });
    expect(await r.drainer(false).drainEmails()).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it('concurrent drains and an auto sweep send the mail once', async () => {
    const r = await rig();
    const id = await r.queued(1, true);
    await Promise.all([
      r.drainer().drainEmails(),
      r.drainer().drainEmails(),
      r.auto().approve(id),
      r.drainer().drainEmails(),
    ]);
    expect(r.calls).toEqual([id]);
    expect((await r.store.get(id)).status).toBe('email_sent');
    expect(await gateCount(r.stateDir)).toBe(1);
  });
});

// ------------------------------------------------------------------ wiring (env opt-in)

const OWNER = { id: 'owner', role: 'owner' } as unknown as Principal;
const FULL = {
  TBI_SIGNUP_MAIL_MAX_PER_HOUR: '30',
  TBI_SIGNUP_MAIL_MAX_PER_DAY: '95',
  TBI_SIGNUP_MAIL_MAX_PER_30D: '2700',
  TBI_SIGNUP_VERIFY: '1',
  TBI_SIGNUP_SITE_URL: 'https://site.example.com',
  TBI_SIGNUP_AUTO_WEB: 'verified',
};

async function wired(extra: Record<string, string>, drop: string[] = []) {
  const d = dirs();
  writeFileSync(join(d.root, 'verify.key'), randomBytes(32).toString('hex'), { mode: 0o600 });
  const env: Record<string, string> = {
    TBI_SIGNUP_ADMIN: '1',
    TBI_SIGNUP_DIR: d.storeDir,
    TBI_SIGNUP_RESEND_KEY_FILE: join(d.root, 'key'),
    TBI_SIGNUP_FROM: 'x',
    TBI_SIGNUP_LAB_URL: 'https://l.example.invalid/',
    TBI_SIGNUP_AUTO_STATE_DIR: d.stateDir,
    TBI_SIGNUP_VERIFY_KEY_FILE: join(d.root, 'verify.key'),
    ...FULL,
    ...extra,
  };
  for (const k of drop) delete env[k];
  const logs: string[] = [];
  const calls: string[] = [];
  const w = await signupWiringFromEnv(
    env,
    { submit: async () => 's', wait: async () => ({ ok: true }) } as unknown as AdminSpool,
    {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log: (l) => {
        logs.push(l);
        allLogs.push(l);
      },
      email: {
        sendApproval: async (to) => void calls.push(to.id),
        sendVerify: async () => undefined,
      },
      autoActor: () => OWNER,
      now: () => AT_2330,
    },
  );
  if (!w) throw new Error('not wired');
  /** A due queued mail of an auto-approved web request, bound and confirmed in the admin state. */
  const autoQueued = async (i: number) => {
    const id = (await w.store.createIfNew(person(i), { origin: 'web' })).record.id;
    await w.store.update(id, {
      status: 'email_queued',
      accountAdded: true,
      emailSendAfter: new Date(AT_2330 - 1000).toISOString(),
      autoApprovedAt: new Date(AT_2330 - 5 * 60_000).toISOString(),
    });
    if (w.verifier) {
      await w.verifier.bindApproval(id, person(i).email);
      const f = join(d.stateDir, VERIFY_DIR, `${id}.json`);
      const s = JSON.parse(readFileSync(f, 'utf8'));
      const iso = new Date(AT_2330 - 10 * 60_000).toISOString();
      writeFileSync(
        f,
        JSON.stringify({
          ...s,
          usedAt: iso,
          verifiedAt: iso,
          verifiedAddr: addressHash(person(i).email),
        }),
        { mode: 0o600 },
      );
    }
    return id;
  };
  const drain = () => w.startDrain()();
  return { w, logs, calls, autoQueued, drain };
}

describe('DEC-39: TBI_SIGNUP_QUIET_AUTO_MAIL wiring', () => {
  it('=1 with caps, state dir and verified mode: the night drain sends the exempt mail', async () => {
    const x = await wired({ TBI_SIGNUP_QUIET_AUTO_MAIL: '1' });
    const id = await x.autoQueued(1);
    await x.drain();
    expect(x.calls).toEqual([id]);
    expect(x.logs).toContain('signup: night approval mail on (auto-approved, verified)');
  });

  it('unset: nothing is sent at night, no new log line', async () => {
    const x = await wired({});
    await x.autoQueued(1);
    await x.drain();
    expect(x.calls).toEqual([]);
    expect(x.logs.filter((l) => l.includes('night approval mail'))).toEqual([]);
  });

  it('=1 without the mail caps: no exemption (one log line)', async () => {
    const x = await wired({ TBI_SIGNUP_QUIET_AUTO_MAIL: '1' }, [
      'TBI_SIGNUP_MAIL_MAX_PER_HOUR',
      'TBI_SIGNUP_MAIL_MAX_PER_DAY',
      'TBI_SIGNUP_MAIL_MAX_PER_30D',
    ]);
    await x.autoQueued(1);
    await x.drain();
    expect(x.calls).toEqual([]);
    expect(x.logs).toContain(
      'signup: night approval mail off (config: TBI_SIGNUP_QUIET_AUTO_MAIL needs the mail caps, TBI_SIGNUP_AUTO_STATE_DIR and TBI_SIGNUP_AUTO_WEB=verified with verification)',
    );
  });

  it('=1 without verified mode: no exemption', async () => {
    const x = await wired({ TBI_SIGNUP_QUIET_AUTO_MAIL: '1', TBI_SIGNUP_AUTO_WEB: 'excluded' });
    await x.autoQueued(1);
    await x.drain();
    expect(x.calls).toEqual([]);
    expect(x.logs.some((l) => l.startsWith('signup: night approval mail off (config:'))).toBe(true);
  });

  it('another value: off with one log line', async () => {
    const x = await wired({ TBI_SIGNUP_QUIET_AUTO_MAIL: 'yes' });
    await x.autoQueued(1);
    await x.drain();
    expect(x.calls).toEqual([]);
    expect(x.logs).toContain(
      'signup: night approval mail off (config: TBI_SIGNUP_QUIET_AUTO_MAIL must be 1 or unset)',
    );
  });
});
