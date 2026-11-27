/**
 * BETA-G1 G1-AUTO-VERIFY slice 4b: the counts-only summary file (admin writes, intake reads), the
 * owner's morning summary and alerts, and the optional auto-approve cut-off heartbeat. Temp dirs
 * under the private TMPDIR only; fake clock; no network.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminSpool } from '../accounts.js';
import { signupWiringFromEnv } from '../signup/admin-wiring.js';
import {
  AUTO_HEARTBEAT_FILE,
  AUTO_PAUSE_FILE,
  AUTO_STATE_FILE,
  AutoApprover,
  israelDay,
} from '../signup/autoApprove.js';
import type { EmailSender } from '../signup/email.js';
import { sign } from '../signup/hmac.js';
import { intakeConfigFromEnv, startIntake } from '../signup/intake-server.js';
import { MailGate, safeguardsFromEnv } from '../signup/mailGate.js';
import type { FetchLike } from '../signup/notify.js';
import { parseQuiet } from '../signup/quietHours.js';
import { SignupApprover } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';
import {
  readSummary,
  replaceJson,
  SUMMARY_FILE,
  SUMMARY_SKEW_MS,
  SUMMARY_STALE_MS,
  type Summary,
} from '../signup/summary.js';
import { collectSummary, previousIsraelDay } from '../signup/summaryAdmin.js';
import { NOTIFY_STATE_FILE, SEND_RETRY_MS, SummaryNotifier } from '../signup/summaryNotify.js';
import { Verifier } from '../signup/verifyState.js';
import { loadVerifyKeys } from '../signup/verify.js';

const MIN = 60_000;
const H = 3_600_000;
const DAY = 86_400_000;
/** 2026-11-23 12:00 in Israel (UTC+2). */
const NOON = Date.parse('2026-11-23T10:00:00Z');
const at = (iso: string) => Date.parse(iso);
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
  // Class codes and counts only: no address, name, id, hash or path on any line of this suite.
  for (const l of allLogs.splice(0))
    expect(l).not.toMatch(/@|Tester|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{16}|\/tmp|\/var|\/home/);
});
const logger = () => {
  const lines: string[] = [];
  const f = (l: string) => {
    lines.push(l);
    allLogs.push(l);
  };
  return Object.assign(f, { lines });
};
function dirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-s4b-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const storeDir = join(root, 'p');
  const stateDir = join(root, 's');
  mkdirSync(storeDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  return { root, storeDir, stateDir };
}

const zero = () => ({ signups: 0, verifyMails: 0, verified: 0, autoApproved: 0 });
const noAlerts = () => ({
  autoCap: false,
  verifyCap: false,
  mailDay80: false,
  mail30d80: false,
  verifyKey: false,
});
function summaryAt(t: number, patch: Partial<Summary> = {}): Summary {
  return {
    v: 1,
    at: new Date(t).toISOString(),
    day: israelDay(t),
    today: zero(),
    yesterday: zero(),
    waitingCap: 0,
    mail: { dayUsed: 1, dayLimit: 95, d30Used: 2, d30Limit: 2700 },
    paused: false,
    alerts: noAlerts(),
    ...patch,
  };
}

describe('strict reader', () => {
  const write = (dir: string, body: unknown) =>
    writeFileSync(join(dir, SUMMARY_FILE), typeof body === 'string' ? body : JSON.stringify(body), {
      mode: 0o600,
    });
  const refused = async (dir: string, t = NOON) => {
    const r = await readSummary(dir, t);
    return 'refused' in r ? r.refused : 'accepted';
  };

  it('accepts the exact schema, null for unknown values, and both freshness edges', async () => {
    const { storeDir } = dirs();
    const s = summaryAt(NOON, {
      waitingCap: null,
      mail: null,
      today: { signups: 3, verifyMails: null, verified: null, autoApproved: 1 },
    });
    await replaceJson(storeDir, SUMMARY_FILE, s);
    expect(await readSummary(storeDir, NOON)).toEqual({ summary: s });
    expect(await refused(storeDir, NOON + SUMMARY_STALE_MS)).toBe('accepted');
    expect(await refused(storeDir, NOON + SUMMARY_STALE_MS + 1)).toBe('stale');
    expect(await refused(storeDir, NOON - SUMMARY_SKEW_MS)).toBe('accepted');
    expect(await refused(storeDir, NOON - SUMMARY_SKEW_MS - 1)).toBe('future');
    expect(statSync(join(storeDir, SUMMARY_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(storeDir)).toEqual([SUMMARY_FILE]);
  });

  it('rejects extra / missing keys, strings, negatives, fractions, out of range and bad dates', async () => {
    const { storeDir } = dirs();
    const base = summaryAt(NOON);
    const bad: unknown[] = [
      'not json',
      [],
      null,
      { ...base, note: 'approve everyone' },
      { ...base, today: { ...zero(), extra: 1 } },
      { ...base, alerts: { ...noAlerts(), other: true } },
      '{"__proto__":1,' + JSON.stringify(base).slice(1),
      { ...base, paused: undefined },
      { ...base, v: 2 },
      { ...base, paused: 'no' },
      { ...base, waitingCap: '4' },
      { ...base, today: { ...zero(), signups: -1 } },
      { ...base, today: { ...zero(), signups: 1.5 } },
      { ...base, today: { ...zero(), signups: 1_000_001 } },
      { ...base, today: { ...zero(), signups: null } },
      { ...base, mail: { dayUsed: 1, dayLimit: 0, d30Used: 1, d30Limit: 1 } },
      { ...base, alerts: { ...noAlerts(), autoCap: 1 } },
      { ...base, at: '2026-11-23 10:00:00' },
      { ...base, at: '2026-02-30T10:00:00.000Z' },
      { ...base, day: '2026-11-22' },
      { ...base, day: 'today' },
    ];
    for (const b of bad) {
      write(storeDir, b);
      expect(await refused(storeDir), JSON.stringify(b)).toBe('invalid');
    }
  });

  it('rejects a symlink, a hard link, a directory, a FIFO, an oversize file and a missing one', async () => {
    const { root, storeDir } = dirs();
    const path = join(storeDir, SUMMARY_FILE);
    expect(await refused(storeDir)).toBe('missing');
    const real = join(root, 'real.json');
    writeFileSync(real, JSON.stringify(summaryAt(NOON)));
    symlinkSync(real, path);
    expect(await refused(storeDir)).toBe('not_file');
    unlinkSync(path);
    linkSync(real, path);
    expect(await refused(storeDir)).toBe('not_file');
    unlinkSync(path);
    mkdirSync(path);
    expect(await refused(storeDir)).toBe('not_file');
    rmSync(path, { recursive: true });
    execFileSync('mkfifo', [path]);
    expect(await refused(storeDir)).toBe('not_file');
    unlinkSync(path);
    write(storeDir, JSON.stringify(summaryAt(NOON)).padEnd(2048, ' '));
    expect(await refused(storeDir)).toBe('accepted');
    write(storeDir, JSON.stringify(summaryAt(NOON)).padEnd(2049, ' '));
    expect(await refused(storeDir)).toBe('too_large');
  });

  it('the writer replaces a planted symlink without writing through it', async () => {
    const { root, storeDir } = dirs();
    const victim = join(root, 'victim');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, join(storeDir, SUMMARY_FILE));
    await replaceJson(storeDir, SUMMARY_FILE, summaryAt(NOON));
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(await refused(storeDir)).toBe('accepted');
  });
});

function notifier(start: number, quiet: string | undefined = undefined) {
  const d = dirs();
  const clock = { t: start };
  const sent: { t: number; text: string }[] = [];
  const fail = { on: false, attempts: 0 };
  const log = logger();
  const mk = () =>
    new SummaryNotifier({
      storeDir: d.storeDir,
      quiet: parseQuiet(quiet),
      now: () => clock.t,
      log,
      send: async (text) => {
        fail.attempts++;
        if (fail.on) throw new Error('network');
        sent.push({ t: clock.t, text });
      },
    });
  let n = mk();
  const put = (patch: Partial<Summary> = {}) =>
    replaceJson(d.storeDir, SUMMARY_FILE, summaryAt(clock.t, patch));
  return {
    ...d,
    clock,
    sent,
    fail,
    log,
    put,
    restart: () => (n = mk()),
    /** The admin writes (when `patch` is given), then the intake ticks, at time `t`. */
    step: async (t: number, patch: Partial<Summary> | null = {}) => {
      clock.t = t;
      if (patch) await put(patch);
      await n.tick();
    },
    texts: () => sent.map((s) => s.text),
  };
}

describe('morning summary', () => {
  it.each([
    // Israel leaves summer time on 2026-10-25 and enters it on 2027-03-26.
    ['autumn change', '2026-10-24T00:00:00Z', ['05:00', '06:00', '06:00']],
    ['spring change', '2027-03-25T00:00:00Z', ['06:00', '05:00', '05:00']],
  ])('once per Israel day at 08:00 local across the %s', async (_n, from, utc) => {
    const r = notifier(at(from));
    for (let t = at(from); t < at(from) + 3 * DAY; t += 15 * MIN) {
      await r.step(t);
      if (t % (6 * H) === 0) r.restart();
    }
    expect(r.sent.map((s) => new Date(s.t).toISOString().slice(11, 16))).toEqual(utc);
    expect(new Set(r.sent.map((s) => israelDay(s.t))).size).toBe(3);
  });

  it('is built from the fixed template and numbers; n/a for unknown values', async () => {
    const r = notifier(at('2026-11-23T05:59:59Z'));
    await r.step(r.clock.t);
    expect(r.sent).toEqual([]);
    await r.step(at('2026-11-23T06:00:00Z'), {
      yesterday: { signups: 12, verifyMails: 14, verified: 9, autoApproved: 8 },
      today: { signups: 2, verifyMails: null, verified: null, autoApproved: 0 },
      waitingCap: null,
    });
    expect(r.texts()).toEqual([
      [
        'TBI Lab sign-ups, summary 2026-11-23',
        'Yesterday: sign-ups 12, verification mails 14, confirmed 9, auto-approved 8',
        'Today so far: sign-ups 2, verification mails n/a, confirmed n/a, auto-approved 0',
        'Waiting for the daily cap: n/a',
        'Mail budget used: today 1/95, 30 days 2/2700',
        'Paused: no',
      ].join('\n'),
    ]);
    r.restart();
    await r.step(r.clock.t + H);
    expect(r.sent).toHaveLength(1);
    expect(statSync(join(r.storeDir, NOTIFY_STATE_FILE)).mode & 0o777).toBe(0o600);
  });

  it('waits for a fresh file: a stale or invalid one is ignored with a class line', async () => {
    const r = notifier(NOON);
    await r.put();
    await r.step(NOON + H, null);
    writeFileSync(join(r.storeDir, SUMMARY_FILE), '{"v":1,"secret":"x"}');
    await r.step(NOON + H + MIN, null);
    expect(r.sent).toEqual([]);
    expect(r.log.lines).toEqual([
      'signup: summary ignored (stale)',
      'signup: summary ignored (invalid)',
    ]);
    await r.step(NOON + 2 * H);
    expect(r.sent).toHaveLength(1);
  });

  it('quiet off: from 08:00; another window: from its end', async () => {
    for (const [quiet, due] of [
      ['off', '2026-11-23T06:00:00Z'],
      ['22:00-06:30', '2026-11-23T04:30:00Z'],
    ] as const) {
      const r = notifier(at(due) - MIN, quiet);
      await r.step(at(due) - MIN);
      expect(r.sent).toEqual([]);
      await r.step(at(due));
      expect(r.sent).toHaveLength(1);
    }
  });
});

describe('alerts', () => {
  const all = {
    autoCap: true,
    verifyCap: true,
    mailDay80: true,
    mail30d80: true,
    verifyKey: true,
  };
  const alertsOf = (texts: string[]) => texts.filter((t) => t.startsWith('TBI Lab alert'));

  it('each type once per day, restart or not; again the next day while it holds', async () => {
    const r = notifier(NOON);
    await r.step(NOON, { alerts: all });
    expect(alertsOf(r.texts())).toEqual([
      'TBI Lab alert (2026-11-23): the daily auto-approval cap was reached; further requests wait.',
      'TBI Lab alert (2026-11-23): the daily verification mail cap was reached; further verification mails wait.',
      'TBI Lab alert (2026-11-23): at least 80% of the daily mail limit is used.',
      'TBI Lab alert (2026-11-23): at least 80% of the 30-day mail limit is used.',
      'TBI Lab alert (2026-11-23): the verification key cannot be read; email verification is not working.',
    ]);
    for (let i = 1; i < 5; i++) {
      r.restart();
      await r.step(NOON + i * MIN, { alerts: all });
    }
    expect(alertsOf(r.texts())).toHaveLength(5);
    // Cleared and set again the same day: still one per type.
    await r.step(NOON + H);
    await r.step(NOON + 2 * H, { alerts: all });
    expect(alertsOf(r.texts())).toHaveLength(5);
    await r.step(NOON + DAY, { alerts: { ...noAlerts(), verifyKey: true } });
    expect(alertsOf(r.texts())).toHaveLength(6);
  });

  it('quiet hours: nothing at night; a cap seen at 23:30 is sent at 08:00 with its day', async () => {
    const night = at('2026-11-23T21:30:00Z'); // 23:30 local
    const r = notifier(night);
    await r.step(night, { alerts: { ...noAlerts(), autoCap: true } });
    r.restart();
    for (let t = night; t < at('2026-11-24T06:00:00Z'); t += 30 * MIN) await r.step(t);
    expect(r.sent).toEqual([]);
    await r.step(at('2026-11-24T06:00:00Z'));
    expect(alertsOf(r.texts())).toEqual([
      expect.stringContaining('(2026-11-23): the daily auto-approval cap'),
    ]);
    // The new day's cap in daytime: one per type per day, so it follows the next morning.
    await r.step(NOON + DAY, { alerts: { ...noAlerts(), autoCap: true } });
    expect(alertsOf(r.texts())).toHaveLength(1);
    await r.step(at('2026-11-25T06:00:00Z'));
    expect(alertsOf(r.texts())[1]).toContain('(2026-11-24)');
  });

  it('pause on and off, once each per day; flapping ends in the true state the next day', async () => {
    const r = notifier(NOON);
    for (const [i, paused] of [false, true, true, false, true, true].entries())
      await r.step(NOON + i * MIN, { paused });
    expect(alertsOf(r.texts())).toEqual([
      'TBI Lab alert (2026-11-23): automatic sign-up is paused.',
      'TBI Lab alert (2026-11-23): automatic sign-up is no longer paused.',
    ]);
    r.restart();
    await r.step(NOON + DAY, { paused: true });
    expect(alertsOf(r.texts())[2]).toBe('TBI Lab alert (2026-11-24): automatic sign-up is paused.');
  });

  it('a failed send is retried with growing gaps, across a restart, and sent once', async () => {
    const r = notifier(NOON);
    r.fail.on = true;
    const alerts = { ...noAlerts(), autoCap: true };
    for (let m = 0; m <= 60; m++) {
      if (m === 7) r.restart();
      await r.step(NOON + m * MIN, { alerts });
    }
    // Attempts at 0, 5, 15, 35 minutes (gaps 5, 10, 20, then 40).
    expect(r.fail.attempts).toBe(4);
    expect(r.log.lines).toContain('signup: summary send failed (network)');
    r.fail.on = false;
    for (let m = 61; m <= 130; m++) await r.step(NOON + m * MIN, { alerts });
    expect(r.sent.map((s) => (s.t - NOON) / MIN)).toEqual([75, 75]);
    expect(SEND_RETRY_MS).toBe(5 * MIN);
  });

  it('an invalid state is reset to "all sent today"; an unwritable one sends nothing', async () => {
    const r = notifier(NOON);
    writeFileSync(join(r.storeDir, NOTIFY_STATE_FILE), '{"v":1,"sent":{"x":"y"}}');
    await r.step(NOON, { alerts: all, paused: true });
    await r.step(NOON + MIN, { alerts: all, paused: true });
    expect(r.sent).toEqual([]);
    expect(r.log.lines).toContain('signup: summary state invalid; reset, nothing more today');
    await r.step(NOON + DAY, { alerts: all, paused: true });
    expect(r.sent.length).toBeGreaterThan(0);
    // A directory in the state's place: unreadable, so nothing is sent.
    const o = notifier(NOON);
    mkdirSync(join(o.storeDir, NOTIFY_STATE_FILE, 'x'), { recursive: true });
    await o.step(NOON, { alerts: all });
    expect(o.sent).toEqual([]);
  });
});

describe('settings', () => {
  const intakeEnv = (extra: Record<string, string>) => ({
    TBI_SIGNUP_INTAKE: '1',
    TBI_SIGNUP_DIR: '/x/p',
    TBI_SIGNUP_HMAC_FILE: '/x/h',
    TBI_SIGNUP_TELEGRAM_TOKEN_FILE: '/x/t',
    TBI_SIGNUP_TELEGRAM_CHAT_ID: '1',
    TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.com/',
    TBI_SIGNUP_SOURCE_HEADER: 'x-forwarded-for',
    ...extra,
  });

  it('TBI_SIGNUP_NOTIFY: unset or empty is today, summary, anything else refuses', () => {
    const unset = intakeConfigFromEnv(intakeEnv({}));
    expect(unset.enabled && 'notify' in unset.config).toBe(false);
    expect(intakeConfigFromEnv(intakeEnv({ TBI_SIGNUP_NOTIFY: '' }))).toEqual(unset);
    const on = intakeConfigFromEnv(intakeEnv({ TBI_SIGNUP_NOTIFY: 'summary' }));
    expect(on.enabled && on.config.notify).toBe('summary');
    for (const v of ['1', 'Summary', 'off', 'summary '])
      expect(intakeConfigFromEnv(intakeEnv({ TBI_SIGNUP_NOTIFY: v }))).toEqual({
        enabled: false,
        error: true,
        reason: 'TBI_SIGNUP_NOTIFY must be summary or unset',
      });
  });

  it('TBI_SIGNUP_AUTO_CUTOFF_KEEP_S: unset and 0 are off; 1..3600; anything else throws', () => {
    for (const v of [undefined, '', '0'])
      expect(safeguardsFromEnv({ TBI_SIGNUP_AUTO_CUTOFF_KEEP_S: v })).toEqual({});
    expect(safeguardsFromEnv({ TBI_SIGNUP_AUTO_CUTOFF_KEEP_S: '3600' })).toEqual({
      cutoffKeepMs: H,
    });
    for (const v of ['3601', '-1', '10m', '1.5', ' 600', '99999'])
      expect(() => safeguardsFromEnv({ TBI_SIGNUP_AUTO_CUTOFF_KEEP_S: v })).toThrow(
        'TBI_SIGNUP_AUTO_CUTOFF_KEEP_S must be a whole number from 0 to 3600',
      );
  });
});

describe('intake wiring', () => {
  const SECRET = 's'.repeat(40);
  async function run(notify: boolean) {
    const { root, storeDir } = dirs();
    writeFileSync(join(root, 'h'), SECRET, { mode: 0o600 });
    writeFileSync(join(root, 't'), `123456:${'A'.repeat(30)}`, { mode: 0o600 });
    const bodies: string[] = [];
    const fetch: FetchLike = async (_u, i) => {
      bodies.push(i.body);
      return { ok: true, status: 200 };
    };
    const log = logger();
    const running = await startIntake(
      {
        ...(notify ? { notify: 'summary' as const } : {}),
        dir: storeDir,
        hmacFile: join(root, 'h'),
        tokenFile: join(root, 't'),
        chatId: '1',
        adminLink: 'https://admin.example.com/',
        host: '127.0.0.1',
        port: 0,
        sourceHeader: 'x-forwarded-for',
        quiet: null,
      },
      { fetch, log, now: () => NOON },
    );
    await replaceJson(storeDir, SUMMARY_FILE, summaryAt(NOON));
    const body = Buffer.from(JSON.stringify(person(1)));
    const ts = Math.floor(NOON / 1000);
    const nonce = randomBytes(16).toString('hex');
    const out = await running.intake.submit(
      'src',
      {
        'content-type': 'application/json',
        'x-tbi-timestamp': String(ts),
        'x-tbi-nonce': nonce,
        'x-tbi-signature': sign(Buffer.from(SECRET), ts, nonce, body),
      },
      body,
    );
    await running.summary?.tick();
    await running.close();
    return { out, bodies, storeDir, running };
  }

  it('unset: one alert per request, the summary file is not read, no new file', async () => {
    const r = await run(false);
    expect(r.out.status).toBe(202);
    expect(r.running.summary).toBeNull();
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]).toContain('New TBI Lab sign-up request');
    expect(readdirSync(r.storeDir)).not.toContain(NOTIFY_STATE_FILE);
  });

  it('summary: no per-request alert (nor a deferred one); the summary goes out', async () => {
    const r = await run(true);
    expect(r.out.status).toBe(202);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]).toContain('TBI Lab sign-ups, summary 2026-11-23');
    expect(r.bodies[0]).not.toMatch(/Tester|example\.com/);
    expect(readdirSync(r.storeDir).filter((f) => /\.notif/.test(f))).toEqual([]);
  });
});

const sender: EmailSender = { sendApproval: async () => undefined, sendVerify: async () => {} };

describe('admin summary', () => {
  it('counts per Israel day, the cap backlog, verify mails, mail budget, pause and flags', async () => {
    const { root, storeDir, stateDir } = dirs();
    const clock = { t: NOON - DAY };
    const now = () => clock.t;
    const store = new PendingStore(storeDir, { now });
    await store.init();
    const keyFile = join(root, 'verify.key');
    writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const limits = { perHour: 10, perDay: 10, per30d: 100 };
    const gate = new MailGate({ stateDir, storeDir, limits, now });
    const verifier = new Verifier({
      stateDir,
      storeDir,
      store,
      email: gate.wrap(sender),
      siteUrl: 'https://site.example.com',
      keys: () => loadVerifyKeys(keyFile),
      since: NOON - 2 * DAY,
      maxPerDay: 3,
      gate,
      now,
    });
    const auto = new AutoApprover({
      dir: stateDir,
      store,
      dailyCap: 1,
      since: NOON - 2 * DAY,
      webSignups: 'included',
      now,
      approver: () =>
        new SignupApprover({
          store,
          accounts: { add: async () => 'done' },
          email: gate.wrap(sender),
          now,
          actor: 'auto',
        }),
    });
    const web = (i: number) => store.createIfNew(person(i), { origin: 'web' });
    await auto.sweep(); // records the cut-off
    await web(1);
    await web(2);
    await verifier.sweep(); // 2 verify mails yesterday
    clock.t = NOON;
    await auto.sweep(); // first run of today: one claim, cap 1
    for (const i of [3, 4, 5]) await web(i);
    await verifier.sweep(); // 3 verify mails today = the verify cap
    await auto.sweep();
    const deps = {
      storeDir,
      store,
      auto,
      verify: { verifier, maxPerDay: 3, keys: () => loadVerifyKeys(keyFile) },
      mail: { gate, limits },
      pauseDir: stateDir,
      now,
    };
    expect(previousIsraelDay(NOON)).toBe('2026-11-22');
    const s = await collectSummary(deps);
    expect(s).toMatchObject({
      day: '2026-11-23',
      yesterday: { signups: 2, verifyMails: 2, verified: 0, autoApproved: 0 },
      today: { signups: 3, verifyMails: 3, verified: 0, autoApproved: 1 },
      // 4 of 5 are waiting: one was approved today.
      waitingCap: 4,
      mail: { dayUsed: 4, dayLimit: 10, d30Used: 6, d30Limit: 100 },
      paused: false,
      alerts: { ...noAlerts(), autoCap: true, verifyCap: true },
    });
    await replaceJson(storeDir, SUMMARY_FILE, s);
    expect(await readSummary(storeDir, NOON)).toEqual({ summary: s });
    // 8 of 10 mails = 80%; paused; key gone.
    for (let i = 0; i < 4; i++) await gate.reserve();
    writeFileSync(join(stateDir, AUTO_PAUSE_FILE), '');
    unlinkSync(keyFile);
    const t = await collectSummary(deps);
    expect(t.paused).toBe(true);
    expect(t.alerts).toMatchObject({ mailDay80: true, mail30d80: false, verifyKey: true });
    // Unreadable state is unknown, never zero.
    writeFileSync(join(stateDir, 'mail-gate.json'), 'x');
    writeFileSync(join(stateDir, 'verify', 'mail-counters.json'), 'x');
    writeFileSync(join(stateDir, AUTO_STATE_FILE), 'x');
    const u = await collectSummary(deps);
    expect(u.mail).toBeNull();
    expect(u.waitingCap).toBeNull();
    expect(u.today.verifyMails).toBeNull();
  });

  const env = (root: string, extra: Record<string, string> = {}) => ({
    TBI_SIGNUP_ADMIN: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_RESEND_KEY_FILE: join(root, 'key'),
    TBI_SIGNUP_FROM: 'x',
    TBI_SIGNUP_LAB_URL: 'https://l.example.invalid/',
    TBI_SIGNUP_QUIET: 'off',
    TBI_SIGNUP_AUTO_STATE_DIR: join(root, 's'),
    ...extra,
  });
  const wire = async (e: Record<string, string>) => {
    const log = logger();
    const w = await signupWiringFromEnv(e, {} as AdminSpool, {
      fetch: async () => ({ ok: true, status: 200 }),
      log,
      email: sender,
      autoActor: () => null,
      now: () => NOON,
    });
    return { w, log };
  };

  it('flag unset: no sweeper, no file, no log line; a bad value says so and writes nothing', async () => {
    for (const extra of [{}, { TBI_SIGNUP_SUMMARY: 'yes' }] as Record<string, string>[]) {
      const d = dirs();
      const { w, log } = await wire(env(d.root, extra));
      await w!.startAutoApprove()();
      expect(readdirSync(d.storeDir)).toEqual([]);
      expect(readdirSync(d.stateDir)).toEqual([]);
      expect(log.lines).toEqual(
        'TBI_SIGNUP_SUMMARY' in extra
          ? ['signup: summary file off (config: TBI_SIGNUP_SUMMARY must be 1 or unset)']
          : [],
      );
    }
  });

  it('flag 1: writes the file each sweep, overwrites a forged one, changes no request', async () => {
    const d = dirs();
    const { w, log } = await wire(env(d.root, { TBI_SIGNUP_SUMMARY: '1' }));
    const rec = (await w!.store.createIfNew(person(1))).record;
    const forged = summaryAt(NOON, { alerts: { ...noAlerts(), autoCap: true }, waitingCap: 999 });
    await replaceJson(d.storeDir, SUMMARY_FILE, forged);
    const stop = w!.startAutoApprove();
    await vi.waitFor(async () => {
      const r = await readSummary(d.storeDir, NOON);
      expect('summary' in r && r.summary.today.signups).toBe(1);
    });
    await stop();
    expect(await w!.store.get(rec.id)).toEqual(rec);
    expect(readdirSync(d.stateDir)).toEqual([]);
    const text = readFileSync(join(d.storeDir, SUMMARY_FILE), 'utf8');
    expect(text).not.toMatch(/Tester|example|Student/);
    expect(text).not.toContain(rec.id);
    expect(log.lines).toEqual(['signup: summary file on']);
  });

  it('keep window: needs its own state dir; a bad value refuses the wiring', async () => {
    const d = dirs();
    for (const extra of [
      { TBI_SIGNUP_AUTO_CUTOFF_KEEP_S: '4000' },
      { TBI_SIGNUP_AUTO_CUTOFF_KEEP_S: '600', TBI_SIGNUP_AUTO_STATE_DIR: d.storeDir },
    ] as Record<string, string>[]) {
      const r = await wire(env(d.root, extra));
      expect(r.w).toBeNull();
      expect(r.log.lines).toHaveLength(1);
      expect(r.log.lines[0]).toMatch(
        /^signup: admin routes disabled \(config: TBI_SIGNUP_AUTO_CUTOFF_KEEP_S/,
      );
    }
  });

  it('a start without auto-approve or without the window removes an old heartbeat', async () => {
    const on = { TBI_SIGNUP_AUTO_APPROVE: '1', TBI_SIGNUP_AUTO_DAILY_CAP: '5' };
    const keep = { TBI_SIGNUP_AUTO_CUTOFF_KEEP_S: '600' };
    const cases: [Record<string, string>, boolean][] = [
      [{ ...on, ...keep }, true],
      [on, false],
      [keep, false],
      [{ ...on, ...keep, TBI_SIGNUP_AUTO_WEB: 'verified' }, false], // refused: no mail caps
      [{ ...on, ...keep, TBI_SIGNUP_ADMIN: '0' }, false],
      [{ ...on, ...keep, TBI_SIGNUP_VERIFY_MAX_PER_DAY: '5' }, false], // wiring refused
    ];
    for (const [extra, stays] of cases) {
      const d = dirs();
      const hb = join(d.stateDir, AUTO_HEARTBEAT_FILE);
      writeFileSync(hb, '{"v":1,"at":1}');
      await wire(env(d.root, extra));
      expect(existsSync(hb), JSON.stringify(extra)).toBe(stays);
    }
  });
});

describe('cut-off heartbeat', () => {
  const KEEP = 10 * MIN;
  async function rig(keepMs: number | null = KEEP) {
    const { storeDir, stateDir } = dirs();
    const clock = { t: NOON };
    const now = () => clock.t;
    const store = new PendingStore(storeDir, { now });
    await store.init();
    const log = logger();
    const owner = { known: true };
    const mk = () =>
      new AutoApprover({
        dir: stateDir,
        store,
        dailyCap: 10,
        ...(keepMs !== null ? { keepMs } : {}),
        now,
        log,
        approver: () =>
          owner.known
            ? new SignupApprover({
                store,
                accounts: { add: async () => 'done' },
                email: sender,
                now,
                actor: 'auto',
              })
            : null,
      });
    const hb = join(stateDir, AUTO_HEARTBEAT_FILE);
    const first = mk();
    await first.sweep(); // cut-off and heartbeat at NOON
    clock.t = NOON + MIN;
    await store.createIfNew(person(1)); // waiting when the service restarts
    /** A restart: a new process sweeps `gap` after the heartbeat; true = cut-off kept. */
    const restart = async (gap: number) => {
      clock.t = NOON + gap;
      return (await mk().sweep()).claimed >= 1;
    };
    return { stateDir, clock, store, log, owner, first, mk, hb, restart };
  }

  it('is written (0600) by every approving sweep', async () => {
    const r = await rig();
    expect(JSON.parse(readFileSync(r.hb, 'utf8'))).toEqual({ v: 1, at: NOON });
    expect(statSync(r.hb).mode & 0o777).toBe(0o600);
  });

  it.each([
    [KEEP - 1, true],
    [KEEP, true],
    [KEEP + 1, false],
    [DAY, false],
  ])('restart %i ms after the heartbeat: kept = %s', async (gap, kept) => {
    const r = await rig();
    expect(await r.restart(gap)).toBe(kept);
    expect(r.log.lines.some((l) => l.includes('cut-off kept'))).toBe(kept);
    expect(r.log.lines.some((l) => l.includes('cut-off reset'))).toBe(!kept);
  });

  it('chained restarts inside the window keep it; setting unset writes nothing and resets', async () => {
    const r = await rig();
    expect(await r.restart(8 * MIN)).toBe(true);
    await r.store.createIfNew(person(2));
    expect(await r.restart(16 * MIN)).toBe(true);
    const off = await rig(null);
    expect(existsSync(off.hb)).toBe(false);
    expect(await off.restart(2 * MIN)).toBe(false);
    expect(existsSync(off.hb)).toBe(false);
  });

  it.each([
    ['missing', null],
    ['not json', 'x'],
    ['wrong version', `{"v":2,"at":${NOON}}`],
    ['string time', `{"v":1,"at":"${NOON}"}`],
    ['future', `{"v":1,"at":${NOON + 5 * MIN}}`],
    ['older than the cut-off', `{"v":1,"at":${NOON - 1}}`],
    ['oversize', `{"v":1,"at":${NOON}}`.padEnd(200, ' ')],
    ['symlink', 'symlink'],
  ])('a %s heartbeat resets', async (_n, body) => {
    const r = await rig();
    unlinkSync(r.hb);
    if (body === 'symlink') {
      writeFileSync(`${r.hb}.real`, `{"v":1,"at":${NOON}}`);
      symlinkSync(`${r.hb}.real`, r.hb);
    } else if (body !== null) writeFileSync(r.hb, body);
    expect(await r.restart(2 * MIN)).toBe(false);
  });

  it('a pause seen by a sweep removes it: pause, resume, restart = reset', async () => {
    const r = await rig();
    writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '');
    await r.first.sweep();
    expect(existsSync(r.hb)).toBe(false);
    unlinkSync(join(r.stateDir, AUTO_PAUSE_FILE));
    expect(await r.restart(2 * MIN)).toBe(false);
  });

  it('resume in the same process resets as before, window or not', async () => {
    const r = await rig();
    writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '');
    await r.first.sweep();
    unlinkSync(join(r.stateDir, AUTO_PAUSE_FILE));
    expect((await r.first.sweep()).claimed).toBe(0);
  });

  it('a pause present at the restart resets, also after it is lifted', async () => {
    const r = await rig();
    writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '');
    const next = r.mk();
    await next.sweep();
    unlinkSync(join(r.stateDir, AUTO_PAUSE_FILE));
    expect((await next.sweep()).claimed).toBe(0);
  });

  it('no owner, an unsafe dir and an unreadable state remove it', async () => {
    const a = await rig();
    a.owner.known = false;
    await a.first.sweep();
    expect(existsSync(a.hb)).toBe(false);
    const b = await rig();
    chmodSync(b.stateDir, 0o770);
    await b.first.sweep();
    expect(existsSync(b.hb)).toBe(false);
    chmodSync(b.stateDir, 0o700);
    expect(await b.restart(2 * MIN)).toBe(false);
    const c = await rig();
    const state = readFileSync(join(c.stateDir, AUTO_STATE_FILE), 'utf8');
    writeFileSync(join(c.stateDir, AUTO_STATE_FILE), 'x');
    await c.first.sweep();
    writeFileSync(join(c.stateDir, AUTO_STATE_FILE), state);
    expect(existsSync(c.hb)).toBe(false);
    expect(await c.restart(2 * MIN)).toBe(false);
  });
});
