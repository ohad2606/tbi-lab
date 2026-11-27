/**
 * BETA-G1: the pause file holds applicant approval mail (queued drain and automatic approval),
 * with or without the auto-approve drop-in and the mail caps; the owner's own approve / resend is
 * unchanged. Real wiring and temp dirs; fakes for the account path and the mail provider.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAIN_INTERVAL_MS, signupWiringFromEnv } from '../signup/admin-wiring.js';
import { AUTO_PAUSE_FILE, approvalHold } from '../signup/autoApprove.js';
import type { EmailSender } from '../signup/email.js';
import { gateCount, MailGate, MailPausedError } from '../signup/mailGate.js';
import type { FetchLike } from '../signup/notify.js';
import { SignupApprover } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';
import type { AdminSpool } from '../accounts.js';
import type { Principal } from '../../identity/principal.js';

const T0 = Date.parse('2026-11-23T10:00:00Z');
const OWNER = { id: 'owner', role: 'owner' } as unknown as Principal;
const LIMITS = { perHour: 30, perDay: 95, per30d: 2700 };
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
  vi.useRealTimers();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const l of allLogs.splice(0))
    expect(l).not.toMatch(/@|example\.com|Tester|[0-9A-HJKMNP-TV-Z]{26}|tbi-pause-/);
});

function dirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-pause-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const storeDir = join(root, 'p');
  const stateDir = join(root, 's');
  mkdirSync(storeDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  const pause = join(stateDir, AUTO_PAUSE_FILE);
  return { root, storeDir, stateDir, pause };
}
const touch = (p: string) => writeFileSync(p, '');

const AUTO = {
  TBI_SIGNUP_AUTO_APPROVE: '1',
  TBI_SIGNUP_AUTO_DAILY_CAP: '5',
  TBI_SIGNUP_AUTO_SINCE: '2026-11-22T10:00:00Z',
};
const CAPS = {
  TBI_SIGNUP_MAIL_MAX_PER_HOUR: '30',
  TBI_SIGNUP_MAIL_MAX_PER_DAY: '95',
  TBI_SIGNUP_MAIL_MAX_PER_30D: '2700',
};

type Dirs = ReturnType<typeof dirs>;
async function wired(d: Dirs, extra: Record<string, string>, onAdd: () => void = () => {}) {
  const mails: string[] = [];
  const logs: string[] = [];
  const added: number[] = [];
  const spool = {
    submit: async () => 'x',
    wait: async () => {
      added.push(1);
      onAdd();
      return { ok: true };
    },
  } as unknown as AdminSpool;
  const w = await signupWiringFromEnv(
    {
      TBI_SIGNUP_ADMIN: '1',
      TBI_SIGNUP_DIR: d.storeDir,
      TBI_SIGNUP_RESEND_KEY_FILE: join(d.root, 'key'),
      TBI_SIGNUP_FROM: 'x',
      TBI_SIGNUP_LAB_URL: 'https://l.example.invalid/',
      TBI_SIGNUP_QUIET: 'off',
      ...extra,
    },
    spool,
    {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log: (l) => {
        logs.push(l);
        allLogs.push(l);
      },
      email: { sendApproval: async (to) => void mails.push(to.id) },
      autoActor: () => OWNER,
      now: () => T0,
    },
  );
  if (!w) throw new Error('not wired');
  /** A queued approval mail that is due; `auto` = approved automatically. */
  const queued = async (i: number, auto: boolean) => {
    const id = (await w.store.createIfNew(person(i))).record.id;
    await w.store.update(id, {
      status: 'email_queued',
      accountAdded: true,
      emailSendAfter: new Date(T0 - 1000).toISOString(),
      ...(auto ? { autoApprovedAt: new Date(T0 - 5000).toISOString() } : {}),
    });
    return id;
  };
  const drain = () => w.startDrain()();
  /** One sweep: stop() before the state dir check resolves would skip it, so wait for the add. */
  const sweep = async () => {
    const stop = w.startAutoApprove();
    await vi.waitFor(() => expect(added).toHaveLength(1));
    await stop();
  };
  return { w, mails, logs, added, queued, drain, sweep };
}

const CONFIGS: [string, Record<string, string>][] = [
  ['state dir only (no drop-in, no caps)', {}],
  ['auto-approve on, no caps', AUTO],
  ['caps, auto-approve off', CAPS],
  ['auto-approve on with caps', { ...AUTO, ...CAPS }],
];

describe('queued-mail drain', () => {
  for (const [name, extra] of CONFIGS) {
    it(`${name}: paused holds auto-approved mail; resume sends it`, async () => {
      const d = dirs();
      const r = await wired(d, { TBI_SIGNUP_AUTO_STATE_DIR: d.stateDir, ...extra });
      const auto = await r.queued(1, true);
      const own = await r.queued(2, false);
      touch(d.pause);
      const before = await r.w.store.get(auto);
      await r.drain();
      // The owner's own queued mail goes, as before.
      expect(r.mails).toEqual([own]);
      expect(await r.w.store.get(auto)).toEqual(before);
      expect((await gateCount(d.stateDir)) ?? 0).toBe(
        'TBI_SIGNUP_MAIL_MAX_PER_DAY' in extra ? 1 : 0,
      );
      rmSync(d.pause);
      await r.drain();
      expect(r.mails).toEqual([own, auto]);
      expect((await r.w.store.get(auto)).status).toBe('email_sent');
    });
  }

  const unsafe: [string, (d: Dirs) => string][] = [
    [
      'group-writable state dir',
      (d) => {
        chmodSync(d.stateDir, 0o770);
        return d.stateDir;
      },
    ],
    ['missing state dir', (d) => join(d.root, 'nope')],
    ['state dir = store dir', (d) => d.storeDir],
    [
      'state dir inside the store dir',
      (d) => {
        mkdirSync(join(d.storeDir, 'in'), { recursive: true, mode: 0o700 });
        chmodSync(d.storeDir, 0o700);
        return join(d.storeDir, 'in');
      },
    ],
    ['relative state dir', () => 'rel/dir'],
  ];
  for (const [name, make] of unsafe)
    it(`${name}: held (fail closed), one class line over several drains`, async () => {
      const d = dirs();
      const r = await wired(d, { TBI_SIGNUP_AUTO_STATE_DIR: make(d) });
      const auto = await r.queued(1, true);
      await r.drain();
      await r.drain();
      expect(r.mails).toEqual([]);
      expect((await r.w.store.get(auto)).status).toBe('email_queued');
      expect(r.logs.filter((l) => /mail held/.test(l))).toEqual([
        'signup: approval mail held (state_dir_unsafe)',
      ]);
    });

  it('a pause file in the store dir has no effect when the state dir is configured', async () => {
    const d = dirs();
    const r = await wired(d, { TBI_SIGNUP_AUTO_STATE_DIR: d.stateDir });
    const auto = await r.queued(1, true);
    touch(join(d.storeDir, AUTO_PAUSE_FILE));
    await r.drain();
    expect(r.mails).toEqual([auto]);
  });

  it('state dir not configured: sent as before, one log line however many sweeps', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const d = dirs();
    const r = await wired(d, {});
    const auto = await r.queued(1, true);
    touch(d.pause);
    const stop = r.w.startDrain();
    await vi.advanceTimersByTimeAsync(3 * DRAIN_INTERVAL_MS);
    await stop();
    expect(r.mails).toEqual([auto]);
    expect(r.logs.filter((l) => /pause/.test(l))).toEqual([
      'signup: approval mail pause check not configured (state_dir_unset)',
    ]);
  });

  it('auto-approve without a state dir: the drain still holds on the store-dir file (unchanged)', async () => {
    const d = dirs();
    const r = await wired(d, AUTO);
    await r.queued(1, true);
    touch(join(d.storeDir, AUTO_PAUSE_FILE));
    await r.drain();
    expect(r.mails).toEqual([]);
  });
});

describe('automatic approval', () => {
  for (const [name, extra] of [CONFIGS[1]!, CONFIGS[3]!]) {
    it(`${name}: a pause during the account step holds the mail; no slot; resume sends`, async () => {
      const d = dirs();
      const r = await wired(d, { TBI_SIGNUP_AUTO_STATE_DIR: d.stateDir, ...extra }, () =>
        touch(d.pause),
      );
      const id = (await r.w.store.createIfNew(person(1))).record.id;
      await r.sweep();
      expect(r.added).toHaveLength(1);
      expect(r.mails).toEqual([]);
      expect(await r.w.store.get(id)).toMatchObject({
        status: 'email_queued',
        accountAdded: true,
        emailAttemptedAt: null,
        emailAttempts: 0,
        lastError: null,
        emailSendAfter: new Date(T0).toISOString(),
      });
      expect(await gateCount(d.stateDir)).toBeNull();
      await r.drain();
      expect(r.mails).toEqual([]);
      rmSync(d.pause);
      await r.drain();
      expect(r.mails).toEqual([id]);
      expect(await gateCount(d.stateDir)).toBe('TBI_SIGNUP_MAIL_MAX_PER_DAY' in extra ? 1 : null);
    });
  }
});

describe("the owner's own approve and resend are unchanged while paused", () => {
  for (const [name, extra] of CONFIGS) {
    it(name, async () => {
      const d = dirs();
      const r = await wired(d, { TBI_SIGNUP_AUTO_STATE_DIR: d.stateDir, ...extra });
      touch(d.pause);
      const id = (await r.w.store.createIfNew(person(1))).record.id;
      const owner = r.w.signups.approver(OWNER);
      expect(await owner.approve(id)).toMatchObject({ ok: true });
      await r.w.store.update(id, {
        status: 'email_failed',
        autoApprovedAt: new Date(T0).toISOString(),
      });
      expect(await owner.resend(id)).toMatchObject({ ok: true });
      expect(r.mails).toEqual([id, id]);
      expect(existsSync(d.pause)).toBe(true);
    });
  }
});

describe('a pause that appears between the checks', () => {
  async function rig(answers: boolean[], gated: boolean) {
    const d = dirs();
    const store = new PendingStore(d.storeDir, { now: () => T0 });
    await store.init();
    const mails: string[] = [];
    const raw: EmailSender = { sendApproval: async (to) => void mails.push(to.id) };
    const gate = new MailGate({
      stateDir: d.stateDir,
      storeDir: d.storeDir,
      limits: LIMITS,
      now: () => T0,
    });
    let calls = 0;
    const approver = new SignupApprover({
      store,
      accounts: { add: async () => 'done' },
      email: gated ? gate.wrap(raw) : raw,
      now: () => T0,
      actor: 'auto',
      paused: async () => answers[calls++] ?? true,
    });
    const id = (await store.createIfNew(person(1))).record.id;
    return { d, store, mails, approver, id, calls: () => calls };
  }
  const held = {
    status: 'email_queued',
    emailAttemptedAt: null,
    emailAttempts: 0,
    lastError: null,
  };
  it('right before the send (no gate): not sent, stays queued', async () => {
    const r = await rig([false, true], false);
    expect(await r.approver.approve(r.id)).toMatchObject({ ok: true, note: 'email_queued' });
    expect(r.mails).toEqual([]);
    expect(await r.store.get(r.id)).toMatchObject(held);
    expect(r.calls()).toBe(2);
  });
  it('after the slot reservation: not sent, stays queued, the slot is given back', async () => {
    const r = await rig([false, false, true], true);
    expect(await r.approver.approve(r.id)).toMatchObject({ ok: true, note: 'email_queued' });
    expect(r.mails).toEqual([]);
    expect(await r.store.get(r.id)).toMatchObject(held);
    expect(await gateCount(r.d.stateDir)).toBe(0);
    expect(r.calls()).toBe(3);
  });
  it('before the reservation: the gate is never touched', async () => {
    const r = await rig([true], true);
    await r.approver.approve(r.id);
    expect(await gateCount(r.d.stateDir)).toBeNull();
    expect(await r.store.get(r.id)).toMatchObject(held);
  });
  it('a check that throws counts as paused', async () => {
    const r = await rig([], false);
    const a = new SignupApprover({
      store: r.store,
      accounts: { add: async () => 'done' },
      email: { sendApproval: async () => void r.mails.push('sent') },
      actor: 'auto',
      paused: async () => {
        throw new Error('boom');
      },
    });
    await a.approve(r.id);
    expect(r.mails).toEqual([]);
  });
  it('the gate releases only its own slot', async () => {
    const d = dirs();
    const gate = new MailGate({
      stateDir: d.stateDir,
      storeDir: d.storeDir,
      limits: LIMITS,
      now: () => T0,
    });
    let sent = 0;
    const s = gate.wrap({ sendApproval: async () => void sent++ });
    const to = { email: 'a', name: '', lang: 'en' as const, id: 'i' };
    await s.sendApproval(to);
    await expect(s.sendApproval(to, async () => true)).rejects.toBeInstanceOf(MailPausedError);
    expect(sent).toBe(1);
    expect(await gateCount(d.stateDir)).toBe(1);
  });
});

describe('approvalHold', () => {
  const hold = (d: Dirs, stat?: (p: string) => Promise<unknown>) =>
    approvalHold({ stateDir: d.stateDir, storeDir: d.storeDir, ...(stat ? { stat } : {}) });
  it('no entry = not held; any entry = held', async () => {
    const d = dirs();
    expect(await hold(d)()).toBe(false);
    mkdirSync(d.pause);
    expect(await hold(d)()).toBe(true);
  });
  for (const code of ['EACCES', 'ENOTDIR', 'EIO'])
    it(`lstat ${code} = held, class line only`, async () => {
      const d = dirs();
      const logs: string[] = [];
      const h = approvalHold({
        stateDir: d.stateDir,
        storeDir: d.storeDir,
        stat: async () => {
          throw Object.assign(new Error(d.pause), { code });
        },
        log: (l) => logs.push(l),
      });
      expect(await h()).toBe(true);
      expect(await h()).toBe(true);
      expect(logs).toEqual(['signup: approval mail held (pause_check_failed)']);
      allLogs.push(...logs);
    });
});
