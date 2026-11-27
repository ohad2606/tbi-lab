/**
 * BETA-G1 G1-AUTO-VERIFY slice 4a: mail gate, configurable caps, kill switch on verify mails,
 * key id per generation, unverified purge. Temp dirs under the private TMPDIR only.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_PAUSE_FILE } from '../signup/autoApprove.js';
import { signupWiringFromEnv, wireSignupAdmin } from '../signup/admin-wiring.js';
import { EmailError, type EmailSender, type VerifyMailTo } from '../signup/email.js';
import {
  GATE_FILE,
  GATE_SEEN_FILE,
  MailCapError,
  MailGate,
  MailPausedError,
  gateCount,
  nextIsraelDay,
  safeguardsFromEnv,
  type MailLimits,
} from '../signup/mailGate.js';
import type { FetchLike } from '../signup/notify.js';
import { SignupApprover } from '../signup/service.js';
import { serialById } from '../signup/locks.js';
import { PendingStore } from '../signup/store.js';
import { loadVerifyKeys, tokenHash } from '../signup/verify.js';
import { VERIFY_DIR, Verifier } from '../signup/verifyState.js';
import type { AdminSpool } from '../accounts.js';

const T0 = Date.parse('2026-11-23T10:00:00Z');
const H = 3_600_000;
const DAY = 86_400_000;
const SITE = 'https://site.example.com';
const KEY1 = randomBytes(32).toString('hex');
const KEY2 = randomBytes(32).toString('hex');
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
  // Req 13: class codes and counts only, on every line of this suite.
  for (const l of allLogs.splice(0)) {
    expect(l).not.toMatch(/@|Tester|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{16}|\/tmp|\/var/);
  }
});
function dirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-s4a-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const storeDir = join(root, 'p');
  const stateDir = join(root, 's');
  mkdirSync(storeDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  return { root, storeDir, stateDir };
}
const logger = (into: string[] = []) => {
  const f = (l: string) => {
    into.push(l);
    allLogs.push(l);
  };
  return Object.assign(f, { lines: into });
};
function gateRig(limits: Partial<MailLimits> = {}, t = T0) {
  const d = dirs();
  const clock = { t };
  const log = logger();
  const mk = () =>
    new MailGate({
      stateDir: d.stateDir,
      storeDir: d.storeDir,
      limits: { perHour: 1000, perDay: 10_000, per30d: 300_000, ...limits },
      now: () => clock.t,
      log,
    });
  return { ...d, clock, log, gate: mk(), mk };
}
const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(MailCapError);
  return e as MailCapError;
};

describe('req 1: settings (values are examples only, DEC-38 open)', () => {
  it('unset = nothing; examples 30/95/2700, 50, 7 parse; bounded ranges and partial sets refused', () => {
    expect(safeguardsFromEnv({})).toEqual({});
    expect(
      safeguardsFromEnv({
        TBI_SIGNUP_MAIL_MAX_PER_HOUR: '30',
        TBI_SIGNUP_MAIL_MAX_PER_DAY: '95',
        TBI_SIGNUP_MAIL_MAX_PER_30D: '2700',
        TBI_SIGNUP_VERIFY_MAX_PER_DAY: '50',
        TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS: '7',
      }),
    ).toEqual({
      mail: { perHour: 30, perDay: 95, per30d: 2700 },
      verifyPerDay: 50,
      unverifiedDays: 7,
    });
    const caps = { TBI_SIGNUP_MAIL_MAX_PER_DAY: '95', TBI_SIGNUP_MAIL_MAX_PER_30D: '2700' };
    for (const env of [
      { ...caps, TBI_SIGNUP_MAIL_MAX_PER_HOUR: '0' },
      { ...caps, TBI_SIGNUP_MAIL_MAX_PER_HOUR: '1001' },
      { ...caps, TBI_SIGNUP_MAIL_MAX_PER_HOUR: '3x' },
      { ...caps, TBI_SIGNUP_MAIL_MAX_PER_HOUR: '-1' },
      { ...caps, TBI_SIGNUP_MAIL_MAX_PER_HOUR: '96' },
      caps,
      { TBI_SIGNUP_VERIFY_MAX_PER_DAY: '1001' },
      { TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS: '91' },
      { TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS: '0' },
    ])
      expect(() => safeguardsFromEnv(env)).toThrow(/^TBI_SIGNUP_[A-Z_0-9]+[ ,]/);
  });

  const envOf = (root: string, sd: string, extra: Record<string, string>) => ({
    TBI_SIGNUP_ADMIN: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_RESEND_KEY_FILE: join(root, 'key'),
    TBI_SIGNUP_FROM: 'x',
    TBI_SIGNUP_LAB_URL: 'https://l.example.invalid/',
    TBI_SIGNUP_QUIET: 'off',
    TBI_SIGNUP_AUTO_STATE_DIR: sd,
    ...extra,
  });
  const wire = async (env: Record<string, string>) => {
    const log = logger();
    const w = await signupWiringFromEnv(env, {} as AdminSpool, {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log,
      email: { sendApproval: async () => undefined, sendVerify: async () => undefined },
      autoActor: () => null,
    });
    return { w, lines: log.lines };
  };
  const verifyOn = (root: string) => {
    writeFileSync(join(root, 'verify.key'), KEY1, { mode: 0o600 });
    return {
      TBI_SIGNUP_VERIFY: '1',
      TBI_SIGNUP_VERIFY_KEY_FILE: join(root, 'verify.key'),
      TBI_SIGNUP_SITE_URL: SITE,
    };
  };
  const caps = {
    TBI_SIGNUP_MAIL_MAX_PER_HOUR: '30',
    TBI_SIGNUP_MAIL_MAX_PER_DAY: '95',
    TBI_SIGNUP_MAIL_MAX_PER_30D: '2700',
  };
  it('a bad value refuses the wiring with one line naming the variable, never the value', async () => {
    const { root, stateDir } = dirs();
    const r = await wire(envOf(root, stateDir, { ...caps, TBI_SIGNUP_MAIL_MAX_PER_DAY: '99999' }));
    expect(r.w).toBeNull();
    expect(r.lines).toEqual([
      'signup: admin routes disabled (config: TBI_SIGNUP_MAIL_MAX_PER_DAY must be a whole number from 1 to 10000)',
    ]);
  });
  it('refuses verify/day > mail/day (also the default 50), and verify settings without verification', async () => {
    const { root, stateDir } = dirs();
    const low = { ...caps, TBI_SIGNUP_MAIL_MAX_PER_DAY: '40', TBI_SIGNUP_MAIL_MAX_PER_HOUR: '20' };
    for (const extra of [
      { ...verifyOn(root), ...caps, TBI_SIGNUP_VERIFY_MAX_PER_DAY: '96' },
      { ...verifyOn(root), ...low },
      { TBI_SIGNUP_VERIFY_MAX_PER_DAY: '10' },
      { TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS: '7' },
    ] as Record<string, string>[]) {
      const r = await wire(envOf(root, stateDir, extra));
      expect(r.w).toBeNull();
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toMatch(/^signup: admin routes disabled \(config: TBI_SIGNUP_/);
    }
    const ok = await wire(
      envOf(root, stateDir, { ...verifyOn(root), ...low, TBI_SIGNUP_VERIFY_MAX_PER_DAY: '40' }),
    );
    expect(ok.w?.verifier).not.toBeNull();
  });
  it('AUTO_WEB=verified refuses auto-approve unless the mail caps are on; caps need the state dir', async () => {
    const { root, stateDir } = dirs();
    const auto = {
      TBI_SIGNUP_AUTO_APPROVE: '1',
      TBI_SIGNUP_AUTO_DAILY_CAP: '5',
      TBI_SIGNUP_AUTO_WEB: 'verified',
    };
    const off = await wire(envOf(root, stateDir, { ...verifyOn(root), ...auto }));
    expect(off.w!.auto).toBeNull();
    expect(off.lines).toContain(
      'signup: auto-approve off (config: TBI_SIGNUP_AUTO_WEB=verified needs the mail caps)',
    );
    const on = await wire(envOf(root, stateDir, { ...verifyOn(root), ...auto, ...caps }));
    expect(on.w!.auto).not.toBeNull();
    const same = await wire(envOf(root, join(root, 'p'), caps));
    expect(same.w).toBeNull();
  });
  it('all S4 settings unset: no gate, nothing written to the state dir, sender called directly', async () => {
    const { root, storeDir, stateDir } = dirs();
    const calls: string[] = [];
    const inner: EmailSender = { sendApproval: async (to) => void calls.push(to.id) };
    const w = await wireSignupAdmin(
      {
        dir: storeDir,
        keyFile: join(root, 'k'),
        from: 'x',
        labUrl: 'https://l.example.invalid/',
        quiet: null,
      },
      { submit: async () => 's', wait: async () => ({ ok: true }) } as unknown as AdminSpool,
      {
        fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
        log: logger(),
        email: inner,
      },
    );
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await w.store.createIfNew(person(i))).record.id);
    for (const id of ids) {
      const out = await w.signups.approver('p_ownerownerownerownerowner' as never).approve(id);
      expect(out.ok).toBe(true);
    }
    expect(calls).toHaveLength(40);
    expect(readdirSync(stateDir)).toEqual([]);
  });
});

describe('req 2/3/14: the gate (persisted reservation, fail closed, fake clock edges)', () => {
  it('hour cap n-1 / n / n+1 and the exact 1 h edge', async () => {
    const g = gateRig({ perHour: 3 });
    await g.gate.reserve();
    g.clock.t += 1000;
    await g.gate.reserve();
    await g.gate.reserve(); // n
    const e = await refusal(g.gate.reserve()); // n+1
    expect([e.reason, e.retryAt]).toEqual(['hour', T0 + H]);
    g.clock.t = T0 + H - 1;
    await refusal(g.gate.reserve());
    g.clock.t = T0 + H;
    await g.gate.reserve();
    expect(await gateCount(g.stateDir)).toBe(4);
  });
  it('Israel day rollover on both DST days (27.3 and 25.10.2026)', async () => {
    expect(nextIsraelDay(Date.parse('2026-03-27T12:00:00Z'))).toBe(
      Date.parse('2026-03-27T21:00:00Z'),
    );
    expect(nextIsraelDay(Date.parse('2026-03-26T21:59:59Z'))).toBe(
      Date.parse('2026-03-26T22:00:00Z'),
    );
    expect(nextIsraelDay(Date.parse('2026-10-25T12:00:00Z'))).toBe(
      Date.parse('2026-10-25T22:00:00Z'),
    );
    for (const [last, next] of [
      ['2026-03-27T20:59:59.999Z', '2026-03-27T21:00:00Z'],
      ['2026-10-25T21:59:59.999Z', '2026-10-25T22:00:00Z'],
    ] as const) {
      const g = gateRig({ perDay: 2 }, Date.parse(last) - 2 * H);
      await g.gate.reserve();
      g.clock.t = Date.parse(last) - 1;
      await g.gate.reserve();
      g.clock.t = Date.parse(last);
      const e = await refusal(g.gate.reserve());
      expect([e.reason, e.retryAt]).toEqual(['day', Date.parse(next)]);
      g.clock.t = Date.parse(next);
      await g.gate.reserve();
    }
  });
  it('rolling 30 d edge', async () => {
    const g = gateRig({ perHour: 2, perDay: 2, per30d: 2 });
    await g.gate.reserve();
    g.clock.t = T0 + DAY;
    await g.gate.reserve();
    g.clock.t = T0 + 30 * DAY - 1;
    const e = await refusal(g.gate.reserve());
    expect([e.reason, e.retryAt]).toEqual(['30d', T0 + 30 * DAY]);
    g.clock.t = T0 + 30 * DAY;
    await g.gate.reserve();
  });
  it('crash between reserve and send over-counts; a retry counts again; a 429 blocks 1 h', async () => {
    const g = gateRig();
    let mode: 'hang' | 'fail' | '429' | 'ok' = 'hang';
    const sent: string[] = [];
    const inner: EmailSender = {
      sendApproval: async (to) => {
        if (mode === 'hang') return new Promise<void>(() => undefined); // the process dies here
        if (mode === 'fail') throw new EmailError('network');
        if (mode === '429') throw new EmailError('http_429');
        sent.push(to.id);
      },
    };
    void g.gate.wrap(inner).sendApproval({ email: 'a@example.com', name: '', lang: 'en', id: 'x' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await gateCount(g.stateDir)).toBe(1);
    const after = g.mk().wrap(inner); // "restarted" process
    mode = 'fail';
    await expect(
      after.sendApproval({ email: 'a@example.com', name: '', lang: 'en', id: 'x' }),
    ).rejects.toThrow('network');
    expect(await gateCount(g.stateDir)).toBe(2);
    mode = '429';
    const e = await refusal(
      after.sendApproval({ email: 'a@example.com', name: '', lang: 'en', id: 'x' }),
    );
    expect(e.retryAt).toBe(T0 + H);
    mode = 'ok';
    g.clock.t = T0 + H - 1;
    await refusal(after.sendApproval({ email: 'a@example.com', name: '', lang: 'en', id: 'x' }));
    g.clock.t = T0 + H;
    await after.sendApproval({ email: 'a@example.com', name: '', lang: 'en', id: 'x' });
    expect(sent).toEqual(['x']);
    expect(g.log.lines).toContain('signup: mail provider limited (http_429)');
  });
  it('fails closed: missing after it existed, unreadable, invalid, future-dated, unsafe dir, store dir', async () => {
    const cases: [string, (g: ReturnType<typeof gateRig>) => void][] = [
      ['missing', (g) => unlinkSync(join(g.stateDir, GATE_FILE))],
      ['unreadable', (g) => writeFileSync(join(g.stateDir, GATE_FILE), '{nope')],
      ['invalid', (g) => writeFileSync(join(g.stateDir, GATE_FILE), '{"v":1,"sent":["x"]}')],
      ['clock_back', (g) => void (g.clock.t = T0 - 1)],
      ['state_dir_unsafe', (g) => chmodSync(g.stateDir, 0o770)],
    ];
    for (const [cls, breakIt] of cases) {
      const g = gateRig();
      await g.gate.reserve();
      breakIt(g);
      expect((await refusal(g.gate.reserve())).reason).toBe(cls);
      expect(await g.gate.check()).toBeInstanceOf(MailCapError);
      // A new process sees the same (the seen marker survives a lost counter).
      expect((await refusal(g.mk().reserve())).reason).toBe(cls);
      // Once per hour per process (here: two processes).
      expect(g.log.lines.filter((l) => l === `signup: mail cap reached (${cls})`)).toHaveLength(2);
    }
    const d = dirs();
    const same = new MailGate({
      stateDir: d.storeDir,
      storeDir: d.storeDir,
      limits: { perHour: 1, perDay: 1, per30d: 1 },
    });
    expect((await refusal(same.reserve())).reason).toBe('state_dir_unsafe');
    expect(existsSync(join(d.storeDir, GATE_SEEN_FILE))).toBe(false);
  });
  it('req 6: kill switch before the reservation and again right before the verify send', async () => {
    const g = gateRig();
    let calls = 0;
    const stat = async () => {
      calls++;
      if (calls >= 2) return {}; // paused from the second check on
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    };
    const gate = new MailGate({
      stateDir: g.stateDir,
      storeDir: g.storeDir,
      limits: { perHour: 9, perDay: 9, per30d: 9 },
      now: () => T0,
      stat,
    });
    const sent: VerifyMailTo[] = [];
    const s = gate.wrap({
      sendApproval: async () => undefined,
      sendVerify: async (to) => void sent.push(to),
    });
    const to = { email: 'a@example.com', lang: 'en' as const, id: 'x', gen: 1, link: 'l' };
    await expect(s.sendVerify!(to)).rejects.toBeInstanceOf(MailPausedError);
    expect(await gateCount(g.stateDir)).toBe(1); // reserved, then paused: the slot stays counted
    await expect(s.sendVerify!(to)).rejects.toBeInstanceOf(MailPausedError);
    expect(await gateCount(g.stateDir)).toBe(1); // paused before the reservation
    expect(sent).toEqual([]);
  });
});

describe('req 4: over the cap approval mails wait (email_queued, never email_failed)', () => {
  it('40 queued, drain at 30/h: 30, then the exact hour edge, then 10; owner sees mail_cap', async () => {
    const g = gateRig({ perHour: 30, perDay: 95, per30d: 2700 });
    const store = new PendingStore(g.storeDir, { now: () => g.clock.t });
    await store.init();
    const sent: string[] = [];
    const email = g.gate.wrap({ sendApproval: async (to) => void sent.push(to.id) });
    const ids: string[] = [];
    for (let i = 0; i < 41; i++) {
      const id = (await store.createIfNew(person(i))).record.id;
      ids.push(id);
      if (i < 40)
        await store.update(id, {
          status: 'email_queued',
          accountAdded: true,
          emailSendAfter: new Date(T0 - 1).toISOString(),
        });
    }
    const log = logger();
    const drain = new SignupApprover({
      store,
      accounts: { add: async () => 'error' },
      email,
      now: () => g.clock.t,
      log,
    });
    expect(await drain.drainEmails()).toBe(30); // stops at the first refusal (re-queued)
    expect(sent).toHaveLength(30);
    const after = await store.list();
    expect(after.filter((r) => r.status === 'email_failed')).toEqual([]);
    const waiting = after.filter((r) => r.status === 'email_queued');
    expect(waiting).toHaveLength(10);
    expect(waiting.filter((r) => r.emailSendAfter === new Date(T0 + H).toISOString()).length).toBe(
      1,
    );
    const owner = new SignupApprover({
      store,
      accounts: { add: async () => 'done' },
      email,
      now: () => g.clock.t,
      log,
      ownerActions: true,
    });
    const o = await owner.approve(ids[40]!);
    expect(o).toMatchObject({
      ok: false,
      code: 'mail_cap',
      record: { status: 'email_queued', lastError: 'mail_cap' },
    });
    g.clock.t = T0 + H - 1;
    await drain.drainEmails();
    expect(sent).toHaveLength(30);
    g.clock.t = T0 + H;
    await drain.drainEmails();
    expect(sent).toHaveLength(41);
    expect((await store.list()).every((r) => r.status === 'email_sent')).toBe(true);
  });
});

/** A verifier rig: mail gate + verify state + store, fake clock, direct construction. */
async function verifyRig(
  o: { limits?: Partial<MailLimits>; maxPerDay?: number; claimed?: Set<string> | null } = {},
) {
  const g = gateRig({ perHour: 30, perDay: 95, per30d: 2700, ...o.limits });
  const keyFile = join(g.root, 'verify.key');
  writeFileSync(keyFile, KEY1, { mode: 0o600 });
  const log = logger();
  let v: Verifier | null = null;
  const store = new PendingStore(g.storeDir, {
    now: () => g.clock.t,
    onRemoved: (id) => v!.remove(id),
  });
  await store.init();
  const sent: VerifyMailTo[] = [];
  const email = g.gate.wrap({
    sendApproval: async () => undefined,
    sendVerify: async (to) => void sent.push(to),
  });
  v = new Verifier({
    stateDir: g.stateDir,
    storeDir: g.storeDir,
    store,
    email,
    siteUrl: SITE,
    keys: () => loadVerifyKeys(keyFile),
    since: T0 - DAY,
    gate: g.gate,
    now: () => g.clock.t,
    log,
    ...(o.maxPerDay ? { maxPerDay: o.maxPerDay } : {}),
    claimed: async () => (o.claimed === undefined ? new Set() : o.claimed),
  });
  return { ...g, keyFile, store, v, sent, email, vlog: log.lines };
}
const vpath = (r: { stateDir: string }, id: string) => join(r.stateDir, VERIFY_DIR, `${id}.json`);

describe('req 5: a verify mail needs a verify-day slot AND a mail slot', () => {
  it('mail cap full: no generation, no verify counter; minted fresh when a slot frees', async () => {
    const r = await verifyRig({ limits: { perHour: 1 } });
    await r.email.sendApproval({ email: 'o@example.com', name: '', lang: 'en', id: 'o' });
    const id = (await r.store.createIfNew(person(1), { origin: 'web' })).record.id;
    expect((await r.v.sweep()).sent).toBe(0);
    expect(existsSync(vpath(r, id))).toBe(false);
    expect(existsSync(join(r.stateDir, VERIFY_DIR, 'mail-counters.json'))).toBe(false);
    expect(r.vlog).toContain('signup: verify not sent (limit_mail) 1');
    r.clock.t = T0 + H;
    expect((await r.v.sweep()).sent).toBe(1);
    expect(r.sent.map((m) => m.gen)).toEqual([1]);
    expect(await gateCount(r.stateDir)).toBe(2);
  });
  it('verify-day cap (configurable) full: no mail slot taken', async () => {
    const r = await verifyRig({ maxPerDay: 1 });
    await r.store.createIfNew(person(1), { origin: 'web' });
    await r.store.createIfNew(person(2), { origin: 'web' });
    expect((await r.v.sweep()).sent).toBe(1);
    expect(await gateCount(r.stateDir)).toBe(1);
    expect(r.vlog).toContain('signup: verify not sent (limit_day) 1');
  });
  it('a send refused after the reservation (pause) revokes the generation', async () => {
    const r = await verifyRig();
    const id = (await r.store.createIfNew(person(1), { origin: 'web' })).record.id;
    const v2 = new Verifier({
      stateDir: r.stateDir,
      storeDir: r.storeDir,
      store: r.store,
      email: {
        sendApproval: async () => undefined,
        sendVerify: async () => {
          throw new MailPausedError();
        },
      },
      siteUrl: SITE,
      keys: () => loadVerifyKeys(r.keyFile),
      since: T0 - DAY,
      now: () => r.clock.t,
    });
    expect((await v2.sweep()).sent).toBe(0);
    expect(JSON.parse(readFileSync(vpath(r, id), 'utf8')).gens).toEqual([]);
    r.clock.t += 10 * 60_000; // the per-address gap (the refused send stays counted there)
    expect((await r.v.sweep()).sent).toBe(1); // minted fresh
  });
  it('req 6: auto-approve.paused stops minting; sign-ups are still stored', async () => {
    const r = await verifyRig();
    writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '');
    await r.store.createIfNew(person(1), { origin: 'web' });
    expect((await r.v.sweep()).sent).toBe(0);
    expect(await gateCount(r.stateDir)).toBeNull();
    expect(await r.store.list()).toHaveLength(1);
  });
});

describe('key id per generation (security review of slice 2)', () => {
  it('an empty marker matches only a generation minted by the current or prev key', async () => {
    const r = await verifyRig();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++)
      ids.push((await r.store.createIfNew(person(i), { origin: 'web' })).record.id);
    await r.v.sweep();
    const tok = (id: string) => r.sent.find((m) => m.id === id)!.link.split('#verify=')[1]!;
    const drop = (id: string) =>
      writeFileSync(join(r.storeDir, `${id}.vq-${tokenHash(tok(id)).slice(0, 16)}`), '');
    const gen = (id: string) => JSON.parse(readFileSync(vpath(r, id), 'utf8')).gens[0];
    expect(gen(ids[0]!).kid).toMatch(/^[0-9a-f]{16}$/);
    // Rotation: new key current, old key prev: outstanding links still work.
    writeFileSync(r.keyFile, KEY2);
    writeFileSync(`${r.keyFile}.prev`, KEY1, { mode: 0o600 });
    drop(ids[0]!);
    expect((await r.v.sweep()).verified).toBe(1);
    // Old key removed: its links are revoked.
    unlinkSync(`${r.keyFile}.prev`);
    drop(ids[1]!);
    const s = await r.v.sweep();
    expect([s.verified, s.rejected]).toEqual([0, 1]);
    expect(r.vlog).toContain('signup: verify rejected (key_retired) 1');
    // A generation without a key id (older state) never matches an empty marker.
    writeFileSync(r.keyFile, KEY1);
    const st = JSON.parse(readFileSync(vpath(r, ids[2]!), 'utf8'));
    delete st.gens[0].kid;
    writeFileSync(vpath(r, ids[2]!), JSON.stringify(st));
    drop(ids[2]!);
    expect((await r.v.sweep()).verified).toBe(0);
  });
});

describe('req 11/12: unverified purge (createdAt + N days)', () => {
  it('purges only unverified web pending after the cut-off; removes every file; keeps the rest', async () => {
    const r = await verifyRig();
    const mk = async (i: number, web = true) =>
      (await r.store.createIfNew(person(i), web ? { origin: 'web' } : {})).record.id;
    r.clock.t = T0 - 2 * DAY; // before the verify cut-off (T0 - DAY)
    const preCut = await mk(9);
    r.clock.t = T0;
    const victim = await mk(1);
    const neverMailed = await mk(2);
    const verified = await mk(3);
    const apps = await mk(4, false);
    const approved = await mk(5);
    const unreadable = await mk(6);
    const claimed = await mk(7);
    await r.v.sweep(); // mints for every web record after the cut-off
    unlinkSync(vpath(r, neverMailed));
    await r.store.update(neverMailed, { verifySentAt: undefined });
    writeFileSync(
      vpath(r, verified),
      JSON.stringify({
        ...JSON.parse(readFileSync(vpath(r, verified), 'utf8')),
        usedAt: new Date(T0).toISOString(),
        verifiedAt: new Date(T0).toISOString(),
        verifiedAddr: 'a'.repeat(64),
      }),
    );
    await r.store.update(approved, { status: 'approved' });
    writeFileSync(vpath(r, unreadable), '{bad');
    for (const f of [
      `${victim}.notified`,
      `${victim}.notifyq`,
      `${victim}.rq`,
      `${victim}.vq-0123456789abcdef`,
      `${victim}.x1.tmp`,
    ])
      writeFileSync(join(r.storeDir, f), '');
    const markOf = (i: number) =>
      `${createHash('sha256').update(person(i).email).digest('hex')}.mark`;
    expect(existsSync(join(r.storeDir, markOf(1)))).toBe(true);
    const r2 = {
      ...r,
      v: new Verifier({
        stateDir: r.stateDir,
        storeDir: r.storeDir,
        store: r.store,
        email: r.email,
        siteUrl: SITE,
        keys: () => loadVerifyKeys(r.keyFile),
        since: T0 - DAY,
        now: () => r.clock.t,
        log: logger(r.vlog),
        claimed: async () => new Set([claimed]),
      }),
    };
    r.clock.t = T0 + 7 * DAY - 1;
    expect((await r2.v.purgeUnverified(7)).purged).toBe(0); // n-1
    r.clock.t = T0 + 7 * DAY;
    const p = await r2.v.purgeUnverified(7);
    expect(p).toEqual({ purged: 2, neverMailed: 1 });
    const left = (await r.store.list()).map((x) => x.id).sort();
    expect(left).toEqual([preCut, verified, apps, approved, unreadable, claimed].sort());
    for (const id of [victim, neverMailed]) {
      expect(readdirSync(r.storeDir).filter((f) => f.startsWith(id))).toEqual([]);
      expect(existsSync(vpath(r, id))).toBe(false);
    }
    expect(existsSync(join(r.storeDir, markOf(1)))).toBe(false);
    expect(existsSync(join(r.storeDir, markOf(3)))).toBe(true); // another .mark survives
    expect(r.vlog).toContain('signup: purge unverified removed 2');
    expect(r.vlog).toContain('signup: purge unverified never mailed 1');
    // Address-hash counters expire after 7 days.
    const c = JSON.parse(readFileSync(join(r.stateDir, VERIFY_DIR, 'mail-counters.json'), 'utf8'));
    expect(c.addrs).toEqual({});
  });
  it('race: a confirmation recorded while the purge waits for the per-id lock keeps the request', async () => {
    const r = await verifyRig();
    const id = (await r.store.createIfNew(person(1), { origin: 'web' })).record.id;
    await r.v.sweep();
    r.clock.t = T0 + 8 * DAY;
    let release!: () => void;
    const held = serialById(id, async () => {
      await new Promise<void>((res) => (release = res));
      const s = JSON.parse(readFileSync(vpath(r, id), 'utf8'));
      writeFileSync(
        vpath(r, id),
        JSON.stringify({
          ...s,
          usedAt: new Date(T0).toISOString(),
          verifiedAt: new Date(T0).toISOString(),
          verifiedAddr: s.gens[0].addr,
        }),
      );
    });
    const purge = r.v.purgeUnverified(7);
    await new Promise((res) => setTimeout(res, 30));
    release();
    await held;
    expect((await purge).purged).toBe(0);
    expect(await r.store.list()).toHaveLength(1);
  });
  it('unreadable claim set or unsafe state dir: nothing is purged', async () => {
    const r = await verifyRig({ claimed: null });
    await r.store.createIfNew(person(1), { origin: 'web' });
    r.clock.t = T0 + 8 * DAY;
    expect((await r.v.purgeUnverified(7)).purged).toBe(0);
    chmodSync(r.stateDir, 0o770);
    expect(await r.v.purgeUnverified(7)).toMatchObject({ purged: 0, stopped: 'state_dir_unsafe' });
    chmodSync(r.stateDir, 0o700);
    expect(await r.store.list()).toHaveLength(1);
  });
});

describe('S4a QA A: a verify send refused over the cap is not counted against the person', () => {
  it('3 x 429 an hour apart, then the provider recovers: sent, and never purged as never mailed', async () => {
    const r = await verifyRig();
    let limited = true;
    const sent: string[] = [];
    const v = new Verifier({
      stateDir: r.stateDir,
      storeDir: r.storeDir,
      store: r.store,
      email: r.gate.wrap({
        sendApproval: async () => undefined,
        sendVerify: async (to) => {
          if (limited) throw new EmailError('http_429');
          sent.push(to.id);
        },
      }),
      siteUrl: SITE,
      keys: () => loadVerifyKeys(r.keyFile),
      since: T0 - DAY,
      gate: r.gate,
      now: () => r.clock.t,
      claimed: async () => new Set<string>(),
    });
    const id = (await r.store.createIfNew(person(1), { origin: 'web' })).record.id;
    const counters = () =>
      JSON.parse(readFileSync(join(r.stateDir, VERIFY_DIR, 'mail-counters.json'), 'utf8'));
    for (let i = 0; i < 3; i++) {
      r.clock.t = T0 + i * H;
      expect((await v.sweep()).sent).toBe(0);
      expect(counters()).toMatchObject({ dayCount: 0, addrs: {} });
    }
    limited = false;
    r.clock.t = T0 + 3 * H;
    expect((await v.sweep()).sent).toBe(1);
    expect(sent).toEqual([id]);
    expect(counters().dayCount).toBe(1);
    expect(Object.values(counters().addrs).flat()).toHaveLength(1);
    r.clock.t = T0 + 7 * DAY;
    expect(await v.purgeUnverified(7)).toEqual({ purged: 1, neverMailed: 0 });
  });
});

describe('S4a QA C: upgrade of a verified deployment without mail caps', () => {
  it('auto-approve off, no uncapped verify mail or purge, approval mail binding kept', async () => {
    const { root, storeDir, stateDir } = dirs();
    writeFileSync(join(root, 'verify.key'), KEY1, { mode: 0o600 });
    const approvals: string[] = [];
    const verifies: string[] = [];
    const log = logger();
    const clock = { t: T0 };
    const w = (await signupWiringFromEnv(
      {
        TBI_SIGNUP_ADMIN: '1',
        TBI_SIGNUP_DIR: storeDir,
        TBI_SIGNUP_RESEND_KEY_FILE: join(root, 'key'),
        TBI_SIGNUP_FROM: 'x',
        TBI_SIGNUP_LAB_URL: 'https://l.example.invalid/',
        TBI_SIGNUP_QUIET: 'off',
        TBI_SIGNUP_AUTO_STATE_DIR: stateDir,
        TBI_SIGNUP_VERIFY: '1',
        TBI_SIGNUP_VERIFY_KEY_FILE: join(root, 'verify.key'),
        TBI_SIGNUP_SITE_URL: SITE,
        TBI_SIGNUP_VERIFY_SINCE: '2026-11-01T00:00:00Z',
        TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS: '7',
        TBI_SIGNUP_AUTO_APPROVE: '1',
        TBI_SIGNUP_AUTO_DAILY_CAP: '5',
        TBI_SIGNUP_AUTO_WEB: 'verified',
      },
      { submit: async () => 's', wait: async () => ({ ok: true }) } as unknown as AdminSpool,
      {
        fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
        log,
        now: () => clock.t,
        email: {
          sendApproval: async (to) => void approvals.push(to.email),
          sendVerify: async (to) => void verifies.push(to.id),
        },
        autoActor: () => null,
      },
    ))!;
    expect(w.auto).toBeNull();
    const waiting = (await w.store.createIfNew(person(1), { origin: 'web' })).record.id;
    writeFileSync(join(storeDir, `${waiting}.rq`), '');
    clock.t = T0 + 8 * DAY;
    const s = await w.verifier!.sweep();
    expect(s.sent).toBe(0);
    expect(verifies).toEqual([]);
    expect(existsSync(join(storeDir, `${waiting}.rq`))).toBe(true);
    expect((await w.store.list()).map((x) => x.id)).toEqual([waiting]); // not purged unmailed
    expect(log.lines).toContain('signup: verify mails held (mail_caps_missing)');
    // An account added for one address; the intake-writable record then changes it.
    const id = (await w.store.createIfNew(person(2))).record.id;
    await w.verifier!.bindApproval(id, person(2).email);
    await w.store.update(id, {
      status: 'approved',
      accountAdded: true,
      email: 'other@example.com',
    });
    const out = await w.signups.approver('p_ownerownerownerownerowner' as never).resend(id);
    expect(out).toMatchObject({ ok: false, record: { lastError: 'mail_addr_changed' } });
    expect(approvals).toEqual([]);
  });
});

describe('S4a QA B: the unverified purge is resumable and reports what it skips', () => {
  const purger = async (claimed: () => Promise<Set<string> | null>) => {
    const r = await verifyRig();
    const lines: string[] = [];
    const v = new Verifier({
      stateDir: r.stateDir,
      storeDir: r.storeDir,
      store: r.store,
      email: r.email,
      siteUrl: SITE,
      keys: () => loadVerifyKeys(r.keyFile),
      since: T0 - DAY,
      now: () => r.clock.t,
      log: logger(lines),
      claimed,
    });
    const id = (await r.store.createIfNew(person(1), { origin: 'web' })).record.id;
    r.clock.t = T0 + 8 * DAY;
    return { ...r, v, id, lines };
  };
  it('a failure part-way keeps the .web marker; the next run finishes the job', async () => {
    const r = await purger(async () => new Set<string>());
    const remove = r.v.remove.bind(r.v);
    r.v.remove = async () => {
      throw Object.assign(new Error('x'), { code: 'EIO' });
    };
    expect((await r.v.purgeUnverified(7)).purged).toBe(0);
    expect(existsSync(join(r.storeDir, `${r.id}.web`))).toBe(true);
    expect(r.lines.some((l) => /^signup: purge unverified failed \(\w+\) 1$/.test(l))).toBe(true);
    r.v.remove = remove;
    expect((await r.v.purgeUnverified(7)).purged).toBe(1);
    expect(readdirSync(r.storeDir).filter((f) => f.startsWith(r.id))).toEqual([]);
  });
  it('unreadable claims and unreadable state are logged as class only', async () => {
    const a = await purger(async () => null);
    await a.v.purgeUnverified(7);
    expect(a.lines).toContain('signup: purge unverified kept (claims_unreadable) 1');
    const b = await purger(async () => new Set<string>());
    await b.v.checkDirs();
    writeFileSync(vpath(b, b.id), '{bad');
    await b.v.purgeUnverified(7);
    expect(b.lines).toContain('signup: purge unverified kept (state_unreadable) 1');
  });
});

describe('S4a QA E: gate file at the largest 30 d setting, and recovery', () => {
  it('a full 300000-entry state is readable', async () => {
    const g = gateRig({ per30d: 300_000 }, T0);
    const sent = Array.from({ length: 299_999 }, (_, i) => T0 - 3 * DAY - i);
    writeFileSync(join(g.stateDir, GATE_FILE), `${JSON.stringify({ v: 1, sent })}\n`);
    expect(await g.gate.check()).toBeNull();
    await g.gate.reserve();
    expect((await g.mk().check())?.reason).toBe('30d');
  }, 60_000);
  it('removing both files recovers after a restart, not in the running process', async () => {
    const g = gateRig();
    await g.gate.reserve();
    await g.gate.reserve();
    unlinkSync(join(g.stateDir, GATE_FILE));
    unlinkSync(join(g.stateDir, GATE_SEEN_FILE));
    expect((await g.gate.check())?.reason).toBe('missing');
    expect(await g.mk().check()).toBeNull();
  });
});

describe('S4a QA: a cap-refused approval mail is not treated as already attempted', () => {
  it('approve and resend answer email_queued; the drain sends it exactly once', async () => {
    const g = gateRig({ perHour: 1 });
    const store = new PendingStore(g.storeDir, { now: () => g.clock.t });
    await store.init();
    const sent: string[] = [];
    const email = g.gate.wrap({ sendApproval: async (to) => void sent.push(to.id) });
    await email.sendApproval({ email: 'o@example.com', name: '', lang: 'en', id: 'o' });
    const approver = new SignupApprover({
      store,
      accounts: { add: async () => 'done' },
      email,
      now: () => g.clock.t,
      ownerActions: true,
    });
    const id = (await store.createIfNew(person(1))).record.id;
    expect(await approver.approve(id)).toMatchObject({ ok: false, code: 'mail_cap' });
    for (const out of [await approver.approve(id), await approver.resend(id)])
      expect(out).toMatchObject({ ok: true, note: 'email_queued' });
    g.clock.t = T0 + H;
    await approver.drainEmails();
    await approver.drainEmails();
    expect(sent).toEqual(['o', id]);
    expect((await store.get(id)).status).toBe('email_sent');
  });
});
