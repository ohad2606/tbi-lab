/** TBI-022: quiet hours helper (Asia/Jerusalem, DST), clock injected. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adminSignupConfigFromEnv } from '../signup/admin-wiring.js';
import { NonceCache, sign } from '../signup/hmac.js';
import { intakeConfigFromEnv } from '../signup/intake-server.js';
import { SlidingWindowLimiter } from '../signup/limits.js';
import { TelegramNotifier } from '../signup/notify.js';
import { SignupApprover, SignupIntake } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';
import { isQuiet, nextSendAt, parseQuiet } from '../signup/quietHours.js';

const Q = parseQuiet(undefined);
const iso = (ms: number) => new Date(ms).toISOString();
// Winter (IST, UTC+2) and summer (IDT, UTC+3) instants by local wall time.
const winter = (hm: string) => Date.parse(`2026-01-15T${hm}:00+02:00`);
const summer = (hm: string) => Date.parse(`2026-07-15T${hm}:00+03:00`);

describe('parseQuiet', () => {
  it('defaults, off, custom, and malformed', () => {
    expect(Q).toEqual({ startMin: 1380, endMin: 480 });
    expect(parseQuiet('off')).toBeNull();
    expect(parseQuiet('22:30-07:15')).toEqual({ startMin: 1350, endMin: 435 });
    for (const bad of ['', '24:00-08:00', '23:00', '23:00-23:00', '8-9', '23:60-08:00'])
      expect(() => parseQuiet(bad), bad).toThrow();
  });
});

describe('isQuiet boundaries', () => {
  for (const [name, at] of [
    ['winter', winter],
    ['summer', summer],
  ] as const) {
    it(`${name}: 22:59 / 23:00 / 07:59 / 08:00`, () => {
      expect(isQuiet(at('22:59'), Q)).toBe(false);
      expect(isQuiet(at('23:00'), Q)).toBe(true);
      expect(isQuiet(at('00:00'), Q)).toBe(true);
      expect(isQuiet(at('07:59'), Q)).toBe(true);
      expect(isQuiet(at('08:00'), Q)).toBe(false);
      expect(isQuiet(at('12:00'), Q)).toBe(false);
    });
  }
  it('off never quiet; a same-day window works', () => {
    expect(isQuiet(winter('03:00'), null)).toBe(false);
    const day = parseQuiet('12:00-14:00');
    expect(isQuiet(winter('11:59'), day)).toBe(false);
    expect(isQuiet(winter('12:00'), day)).toBe(true);
    expect(isQuiet(winter('14:00'), day)).toBe(false);
  });
});

describe('nextSendAt', () => {
  it('is now outside quiet hours', () => {
    expect(nextSendAt(winter('09:00'), Q)).toBe(winter('09:00'));
    expect(nextSendAt(winter('22:59'), Q)).toBe(winter('22:59'));
  });
  it('queues to 08:00 local, before and after midnight, winter and summer', () => {
    expect(iso(nextSendAt(winter('23:30'), Q))).toBe(iso(Date.parse('2026-01-16T08:00:00+02:00')));
    expect(iso(nextSendAt(winter('23:00'), Q))).toBe(iso(Date.parse('2026-01-16T08:00:00+02:00')));
    expect(iso(nextSendAt(winter('02:00'), Q))).toBe(iso(Date.parse('2026-01-15T08:00:00+02:00')));
    expect(iso(nextSendAt(winter('07:59'), Q))).toBe(iso(Date.parse('2026-01-15T08:00:00+02:00')));
    expect(iso(nextSendAt(summer('23:30'), Q))).toBe(iso(Date.parse('2026-07-16T08:00:00+03:00')));
    expect(iso(nextSendAt(summer('03:00'), Q))).toBe(iso(Date.parse('2026-07-15T08:00:00+03:00')));
  });
  it('DST: spring forward (night of 2026-03-27) and fall back (night of 2026-10-25)', () => {
    // 2026-03-27 02:00 IST -> 03:00 IDT. Queued at 23:30 on the 26th, send 08:00 IDT = 05:00Z.
    expect(iso(nextSendAt(Date.parse('2026-03-26T23:30:00+02:00'), Q))).toBe(
      '2026-03-27T05:00:00.000Z',
    );
    // Triggered at 01:30 IST the same night (before the jump).
    expect(iso(nextSendAt(Date.parse('2026-03-27T01:30:00+02:00'), Q))).toBe(
      '2026-03-27T05:00:00.000Z',
    );
    // 2026-10-25 02:00 IDT -> 01:00 IST. Queued 23:30 on the 24th (IDT), send 08:00 IST = 06:00Z.
    expect(iso(nextSendAt(Date.parse('2026-10-24T23:30:00+03:00'), Q))).toBe(
      '2026-10-25T06:00:00.000Z',
    );
    // Triggered in the repeated hour (01:30 IDT = 22:30Z, and 01:30 IST = 23:30Z).
    expect(iso(nextSendAt(Date.parse('2026-10-24T22:30:00Z'), Q))).toBe('2026-10-25T06:00:00.000Z');
    expect(iso(nextSendAt(Date.parse('2026-10-24T23:30:00Z'), Q))).toBe('2026-10-25T06:00:00.000Z');
  });
  it('a window ending in the skipped DST hour resolves to a real instant after now', () => {
    const q = parseQuiet('23:00-02:30')!;
    const now = Date.parse('2026-03-26T23:30:00+02:00');
    const t = nextSendAt(now, q);
    expect(t).toBeGreaterThan(now);
    expect(isQuiet(t, q)).toBe(false);
  });
});

// ---------------------------------------------------------------- workflow

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const clock = (at: number) => {
  const c = { t: at, now: () => c.t };
  return c;
};
const NIGHT = Date.parse('2026-01-15T23:30:00+02:00');
const MORNING = Date.parse('2026-01-16T08:00:00+02:00');
const PERSON = {
  name: 'Dana',
  email: 'dana@example.com',
  role: 'T',
  lang: 'en' as const,
  consent: true as const,
};

async function newStore(c: { now: () => number }) {
  const root = mkdtempSync(join(tmpdir(), 'tbi-quiet-'));
  roots.push(root);
  const store = new PendingStore(join(root, 'p'), { now: c.now });
  await store.init();
  return store;
}

describe('approval email in quiet hours', () => {
  async function setup(fail = false) {
    const c = clock(NIGHT);
    const store = await newStore(c);
    const rec = await store.create(PERSON);
    const mails: string[] = [];
    const adds: string[] = [];
    const mk = () =>
      new SignupApprover({
        store,
        quiet: Q,
        now: c.now,
        accounts: { add: async (e) => (adds.push(e), 'done') },
        email: {
          sendApproval: async (to: { id: string }) => {
            mails.push(to.id);
            if (fail) throw new Error('http_500');
          },
        },
      });
    return { c, store, rec, mails, adds, approver: mk(), mk };
  }

  it('approve at night adds the account, queues the email, sends nothing', async () => {
    const s = await setup();
    const out = await s.approver.approve(s.rec.id);
    expect(out).toMatchObject({ ok: true, note: 'email_queued' });
    const r = await s.store.get(s.rec.id);
    expect(r).toMatchObject({
      status: 'email_queued',
      accountAdded: true,
      emailAttempts: 0,
      emailSendAfter: iso(MORNING),
    });
    expect(s.adds).toHaveLength(1);
    expect(s.mails).toEqual([]);
    // Repeating approve or resend neither adds, nor sends, nor changes the state.
    expect(await s.approver.approve(s.rec.id)).toMatchObject({ ok: true, note: 'email_queued' });
    expect(await s.approver.resend(s.rec.id)).toMatchObject({ ok: true, note: 'email_queued' });
    expect(s.adds).toHaveLength(1);
  });

  it('the drain waits for 08:00, then sends exactly once (also under parallel drains)', async () => {
    const s = await setup();
    await s.approver.approve(s.rec.id);
    s.c.t = Date.parse('2026-01-16T07:59:00+02:00');
    expect(await s.approver.drainEmails()).toBe(0);
    s.c.t = MORNING;
    const [a, b] = await Promise.all([s.approver.drainEmails(), s.mk().drainEmails()]);
    expect(a + b).toBe(1);
    expect(s.mails).toEqual([s.rec.id]);
    expect(await s.store.get(s.rec.id)).toMatchObject({
      status: 'email_sent',
      emailSendAfter: null,
    });
    expect(await s.approver.drainEmails()).toBe(0);
    expect(s.mails).toHaveLength(1);
  });

  it('a failed drained send ends email_failed (owner resends), never retried automatically', async () => {
    const s = await setup(true);
    await s.approver.approve(s.rec.id);
    s.c.t = MORNING;
    expect(await s.approver.drainEmails()).toBe(1);
    expect(await s.store.get(s.rec.id)).toMatchObject({
      status: 'email_failed',
      lastError: 'http_500',
    });
    expect(await s.approver.drainEmails()).toBe(0);
    expect(s.mails).toHaveLength(1);
  });

  it('daytime approve still sends at once; quiet off sends at night', async () => {
    const s = await setup();
    s.c.t = Date.parse('2026-01-15T12:00:00+02:00');
    expect(await s.approver.approve(s.rec.id)).toMatchObject({
      ok: true,
      record: { status: 'email_sent' },
    });
    const c = clock(NIGHT);
    const store = await newStore(c);
    const rec = await store.create(PERSON);
    const mails: string[] = [];
    const ap = new SignupApprover({
      store,
      quiet: null,
      now: c.now,
      accounts: { add: async () => 'done' },
      email: { sendApproval: async (to: { id: string }) => void mails.push(to.id) },
    });
    await ap.approve(rec.id);
    expect(mails).toEqual([rec.id]);
  });

  it('resend at night is queued too', async () => {
    const s = await setup(true);
    s.c.t = Date.parse('2026-01-15T12:00:00+02:00');
    await s.approver.approve(s.rec.id); // fails -> email_failed
    s.c.t = NIGHT;
    expect(await s.approver.resend(s.rec.id)).toMatchObject({ ok: true, note: 'email_queued' });
    expect(s.mails).toHaveLength(1);
  });
});

describe('owner alert in quiet hours', () => {
  const SECRET = Buffer.from('test-secret-not-real-0123456789abcdef');
  async function setup(c: { t: number; now: () => number }) {
    const store = await newStore(c);
    const texts: string[] = [];
    const intake = new SignupIntake({
      secret: SECRET,
      store,
      quiet: Q,
      notifier: new TelegramNotifier({
        readToken: async () => '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test',
        chatId: '42',
        adminLink: 'https://admin.example.invalid/signups',
        fetch: async (_u, i) => (texts.push(i.body), { ok: true, status: 200 }),
      }),
      now: c.now,
      sourceRate: new SlidingWindowLimiter({ count: 9, windowMs: 60_000 }, c.now),
      globalRate: new SlidingWindowLimiter({ count: 99, windowMs: 60_000 }, c.now),
      nonces: new NonceCache(),
    });
    const post = (n: string, email = PERSON.email) => {
      const raw = Buffer.from(JSON.stringify({ ...PERSON, email }));
      const ts = Math.floor(c.t / 1000);
      return intake.submit(
        'x',
        {
          'x-tbi-timestamp': String(ts),
          'x-tbi-nonce': n.repeat(20),
          'x-tbi-signature': sign(SECRET, ts, n.repeat(20), raw),
        },
        raw,
      );
    };
    return { store, texts, intake, post };
  }

  it('stores at night, defers the alert, sends it once at 08:00', async () => {
    const c = clock(NIGHT);
    const s = await setup(c);
    expect(await s.post('a')).toEqual({ status: 202 });
    expect(s.texts).toEqual([]);
    expect((await s.store.list())[0]).toMatchObject({
      status: 'pending',
      notified: false,
      notifyPending: true,
    });
    c.t = Date.parse('2026-01-16T07:59:00+02:00');
    expect(await s.intake.drainNotifications()).toBe(0);
    c.t = MORNING;
    expect(await s.intake.drainNotifications()).toBe(1);
    expect(s.texts).toHaveLength(1);
    expect(s.texts[0]).not.toContain('dana@example.com');
    expect((await s.store.list())[0]).toMatchObject({ notified: true, notifyPending: false });
    expect(await s.intake.drainNotifications()).toBe(0);
    expect(s.texts).toHaveLength(1);
  });

  it('daytime alerts go out at once; a request decided meanwhile is not alerted', async () => {
    const c = clock(Date.parse('2026-01-15T12:00:00+02:00'));
    const s = await setup(c);
    await s.post('a');
    expect(s.texts).toHaveLength(1);
    c.t = NIGHT;
    await s.post('b', 'eli@example.com');
    expect(s.texts).toHaveLength(1);
    const [, b] = await s.store.list();
    await s.store.update(b!.id, { status: 'rejected' });
    c.t = MORNING;
    expect(await s.intake.drainNotifications()).toBe(0);
    expect(s.texts).toHaveLength(1);
    expect((await s.store.get(b!.id)).notifyPending).toBe(false);
  });
});

describe('a failed deferral never loses the owner alert (FABLE-REVIEW 7)', () => {
  const SECRET = Buffer.from('test-secret-not-real-0123456789abcdef');
  async function setup(c: { t: number; now: () => number }) {
    const store = await newStore(c);
    const texts: string[] = [];
    const logs: string[] = [];
    const intake = new SignupIntake({
      secret: SECRET,
      store,
      quiet: Q,
      notifier: {
        notify: async (m: { name: string; role: string }) => void texts.push(m.name),
      },
      now: c.now,
      sourceRate: new SlidingWindowLimiter({ count: 9, windowMs: 60_000 }, c.now),
      globalRate: new SlidingWindowLimiter({ count: 99, windowMs: 60_000 }, c.now),
      nonces: new NonceCache(),
      log: (l) => logs.push(l),
    });
    const raw = Buffer.from(JSON.stringify(PERSON));
    const ts = Math.floor(c.t / 1000);
    const post = () =>
      intake.submit(
        'x',
        {
          'x-tbi-timestamp': String(ts),
          'x-tbi-nonce': 'n'.repeat(20),
          'x-tbi-signature': sign(SECRET, ts, 'n'.repeat(20), raw),
        },
        raw,
      );
    return { store, texts, logs, intake, post };
  }

  it('the marker write fails once: it is written again by the next drain, alert at 08:00', async () => {
    const c = clock(NIGHT);
    const s = await setup(c);
    const real = s.store.markNotifyPending.bind(s.store);
    let fail = 1;
    s.store.markNotifyPending = async (id: string) => {
      if (fail-- > 0) throw Object.assign(new Error('disk'), { code: 'EIO' });
      return real(id);
    };
    expect(await s.post()).toEqual({ status: 202 });
    expect(s.logs.join('\n')).toMatch(/notify defer failed \(\w+\); kept in memory/);
    expect((await s.store.list())[0]!.notifyPending).toBe(false);
    // Still night: the drain sends nothing but persists the deferral.
    expect(await s.intake.drainNotifications()).toBe(0);
    expect((await s.store.list())[0]!.notifyPending).toBe(true);
    expect(s.texts).toEqual([]);
    c.t = MORNING;
    expect(await s.intake.drainNotifications()).toBe(1);
    expect(s.texts).toEqual([PERSON.name]);
    expect(await s.intake.drainNotifications()).toBe(0);
    expect(s.texts).toHaveLength(1);
  });

  it('the marker can never be written: the alert still goes out once at 08:00 (memory)', async () => {
    const c = clock(NIGHT);
    const s = await setup(c);
    s.store.markNotifyPending = async () => {
      throw Object.assign(new Error('disk'), { code: 'EIO' });
    };
    await s.post();
    expect(await s.intake.drainNotifications()).toBe(0);
    expect(s.texts).toEqual([]);
    c.t = MORNING;
    expect(await s.intake.drainNotifications()).toBe(1);
    expect(s.texts).toEqual([PERSON.name]);
    expect((await s.store.list())[0]!.notified).toBe(true);
    expect(await s.intake.drainNotifications()).toBe(0);
    expect(s.texts).toHaveLength(1);
  });

  it('a throw mid-drain keeps the not-yet-handled in-memory deferrals for the next drain', async () => {
    const c = clock(NIGHT);
    const s = await setup(c);
    const post = (email: string, nonce: string) => {
      const raw = Buffer.from(JSON.stringify({ ...PERSON, name: email, email }));
      const ts = Math.floor(c.t / 1000);
      return s.intake.submit(
        'x',
        {
          'x-tbi-timestamp': String(ts),
          'x-tbi-nonce': nonce.repeat(20),
          'x-tbi-signature': sign(SECRET, ts, nonce.repeat(20), raw),
        },
        raw,
      );
    };
    await post('first@example.com', 'a'); // marker written to disk
    c.t += 1000;
    const real = s.store.markNotifyPending.bind(s.store);
    s.store.markNotifyPending = async () => {
      throw new Error('disk');
    };
    await post('second@example.com', 'b'); // deferral only in memory
    s.store.markNotifyPending = real;
    c.t = MORNING;
    const realClear = s.store.clearNotifyPending.bind(s.store);
    let boom = true;
    s.store.clearNotifyPending = async (id: string) => {
      if (boom) {
        boom = false;
        throw new Error('disk');
      }
      return realClear(id);
    };
    await s.intake.drainNotifications(); // throws on the first record: nothing may be forgotten
    await s.intake.drainNotifications();
    expect(s.texts.sort()).toEqual(['first@example.com', 'second@example.com']);
  });

  it('a request decided before 08:00 is not alerted from memory either', async () => {
    const c = clock(NIGHT);
    const s = await setup(c);
    s.store.markNotifyPending = async () => {
      throw new Error('disk');
    };
    await s.post();
    const [r] = await s.store.list();
    await s.store.update(r!.id, { status: 'rejected' });
    c.t = MORNING;
    expect(await s.intake.drainNotifications()).toBe(0);
    expect(s.texts).toEqual([]);
  });
});

describe('TBI_SIGNUP_QUIET in the process configs', () => {
  const admin = {
    TBI_SIGNUP_ADMIN: '1',
    TBI_SIGNUP_DIR: '/d',
    TBI_SIGNUP_RESEND_KEY_FILE: '/k',
    TBI_SIGNUP_FROM: 'a <a@example.com>',
    TBI_SIGNUP_LAB_URL: 'https://lab.example.invalid',
  };
  const intake = {
    TBI_SIGNUP_INTAKE: '1',
    TBI_SIGNUP_DIR: '/d',
    TBI_SIGNUP_HMAC_FILE: '/h',
    TBI_SIGNUP_TELEGRAM_TOKEN_FILE: '/t',
    TBI_SIGNUP_TELEGRAM_CHAT_ID: '1',
    TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.invalid',
    TBI_SIGNUP_SOURCE_HEADER: 'x-forwarded-for',
  };
  it('default window, off, and a malformed value is a config error', () => {
    for (const [fn, base] of [
      [adminSignupConfigFromEnv, admin],
      [intakeConfigFromEnv, intake],
    ] as const) {
      const d = fn(base);
      expect(d.enabled && d.config.quiet).toEqual({ startMin: 1380, endMin: 480 });
      const off = fn({ ...base, TBI_SIGNUP_QUIET: 'off' });
      expect(off.enabled && off.config.quiet).toBeNull();
      expect(fn({ ...base, TBI_SIGNUP_QUIET: 'nonsense' })).toMatchObject({
        enabled: false,
        error: true,
      });
    }
  });
});
