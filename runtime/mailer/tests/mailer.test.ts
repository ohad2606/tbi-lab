/**
 * ARC-MAILER (D-ARC-2): queue writer (admin side) and mailer (sender side) against an injected
 * fetch. No network, no real key: the key below is a fake of the right shape.
 */
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalEmail, greetingName } from '../../admin/signup/email.js';
import type { FetchLike } from '../../admin/signup/notify.js';
import { parseQuiet } from '../../admin/signup/quietHours.js';
import { mailerConfigFromEnv } from '../config.js';
import {
  backoffMs,
  IDEMPOTENCY_WINDOW_MS,
  Mailer,
  MAX_ATTEMPTS,
  MAX_ITEM_AGE_MS,
  QUEUE_SCAN_MAX,
  STUCK_MAX_AGE_MS,
  STUCK_WARN_THRESHOLD,
  type Ledger,
  type MailerConfig,
} from '../mailer.js';
import {
  enqueueMail,
  itemKey,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_FILES,
  QueueError,
  type QueueItem,
} from '../queue.js';
import { isRetryable, RESEND_API_URL, ResendTransport } from '../transport.js';

const FAKE_KEY = 're_FAKEtestkey_0123456789abcdef';
const ID = '01JD0000000000000000000000';
const ID2 = '01JD0000000000000000000001';
const ID3 = '01JD0000000000000000000002';
const EMAIL = 'dana@example.com';
const NAME = 'Dana Levi';
const LAB = 'https://lab.example.com/';
const FROM = 'TBI Lab <support@example.com>';
// 10:00 Israel winter time: outside quiet hours.
const DAY = Date.parse('2026-01-15T10:00:00+02:00');
const NIGHT = Date.parse('2026-01-15T23:30:00+02:00');

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'tbi-mailer-'));
  roots.push(root);
  const queueDir = join(root, 'queue');
  const statusDir = join(root, 'status');
  mkdirSync(queueDir, { mode: 0o730 });
  mkdirSync(statusDir, { mode: 0o750 });
  chmodSync(queueDir, 0o730);
  chmodSync(statusDir, 0o750);
  return { root, queueDir, statusDir };
}

function item(over: Partial<QueueItem> = {}, to: Partial<QueueItem['to']> = {}): QueueItem {
  return {
    v: 1,
    template: 'signup-approval',
    id: ID,
    gen: 1,
    to: { email: EMAIL, name: NAME, lang: 'en', ...to },
    createdAt: DAY - 60_000,
    ...over,
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(answers: Array<number | 'throw'> = []) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const a = answers.length ? answers.shift()! : 200;
    if (a === 'throw')
      throw new Error(`connect failed to ${url} with ${init.headers.authorization}`);
    return { ok: a >= 200 && a < 300, status: a };
  };
  return { calls, fetch };
}

function setup(
  o: {
    answers?: Array<number | 'throw'>;
    readKey?: () => Promise<string>;
    cfg?: Partial<MailerConfig>;
    now?: number;
  } = {},
) {
  const d = dirs();
  const f = fakeFetch(o.answers);
  const logs: string[] = [];
  const clock = { now: o.now ?? DAY };
  const mailer = new Mailer(
    {
      queueDir: d.queueDir,
      statusDir: d.statusDir,
      from: FROM,
      labUrl: LAB,
      quiet: parseQuiet(undefined),
      maxPerRun: 10,
      maxPerHour: 20,
      maxPerDay: 100,
      ...o.cfg,
    },
    {
      transport: new ResendTransport({
        readKey: o.readKey ?? (async () => `${FAKE_KEY}\n`),
        fetch: f.fetch,
      }),
      log: (l) => logs.push(l),
      now: () => clock.now,
    },
  );
  const ledger = (key = itemKey(item())): Ledger =>
    JSON.parse(readFileSync(join(d.statusDir, `${key}.json`), 'utf8')) as Ledger;
  const queued = () => readdirSync(d.queueDir);
  return { ...d, ...f, logs, clock, mailer, ledger, queued };
}

/** Logs never carry personal data or the key. */
function expectCleanLogs(logs: string[]) {
  const all = logs.join('\n');
  for (const secret of [FAKE_KEY, 'FAKEtestkey', EMAIL, 'example.com', NAME, 'Dana', LAB, '/tmp'])
    expect(all, secret).not.toContain(secret);
}

describe('queue writer (admin side)', () => {
  it('writes one 0640 file named by the key, with only the template, id and recipient', async () => {
    const { queueDir } = dirs();
    expect(await enqueueMail(queueDir, item())).toBe('queued');
    const names = readdirSync(queueDir);
    expect(names).toEqual([`signup-approval-${ID}-g1.json`]);
    const p = join(queueDir, names[0]!);
    expect(statSync(p).mode & 0o777).toBe(0o640);
    expect(statSync(p).nlink).toBe(1);
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['createdAt', 'gen', 'id', 'template', 'to', 'v']);
    expect(JSON.stringify(raw)).not.toMatch(/subject|text|from|key|https?:/i);
  });

  it('is idempotent: the same key again is already_queued and the first entry is untouched', async () => {
    const { queueDir } = dirs();
    await enqueueMail(queueDir, item());
    const before = readFileSync(join(queueDir, `${itemKey(item())}.json`), 'utf8');
    expect(await enqueueMail(queueDir, item({}, { name: 'Other Name' }))).toBe('already_queued');
    expect(readdirSync(queueDir)).toHaveLength(1);
    expect(readFileSync(join(queueDir, `${itemKey(item())}.json`), 'utf8')).toBe(before);
  });

  it('refuses entries the mailer would refuse, leaving nothing behind', async () => {
    const { queueDir } = dirs();
    const bad: Array<[QueueItem, string]> = [
      [item({}, { email: 'Dana@Example.com' }), 'invalid_email'],
      [item({}, { email: 'not-an-address' }), 'invalid_email'],
      [item({}, { name: 'Dana‮Levi' }), 'invalid_name'],
      [item({}, { name: ' Dana' }), 'invalid_name'],
      [item({}, { name: 'x'.repeat(81) }), 'invalid_name'],
      [item({}, { lang: 'de' as 'en' }), 'invalid_lang'],
      [item({ gen: 0 }), 'invalid_gen'],
      [item({ gen: 10 }), 'invalid_gen'],
      [item({ id: '../../etc/passwd' }), 'invalid_id'],
      [item({ template: 'free-text' as 'signup-approval' }), 'invalid_template'],
      [{ ...item(), subject: 'x' } as unknown as QueueItem, 'invalid_shape'],
    ];
    for (const [i, code] of bad) {
      await expect(enqueueMail(queueDir, i), code).rejects.toEqual(new QueueError(code));
    }
    expect(readdirSync(queueDir)).toEqual([]);
  });
});

describe('mailer: send', () => {
  it('sends the approved English text once, with the key as idempotency key, and records sent', async () => {
    const t = setup();
    await enqueueMail(t.queueDir, item());
    const s = await t.mailer.runOnce();
    expect(s).toMatchObject({ sent: 1, dead: 0, rejected: 0 });
    expect(t.calls).toHaveLength(1);
    const c = t.calls[0]!;
    const mail = approvalEmail('en', { name: NAME, email: EMAIL }, { labUrl: LAB });
    expect(c.url).toBe(RESEND_API_URL);
    expect(c.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(c.headers['idempotency-key']).toBe(`signup-approval-${ID}-g1`);
    expect(c.body).toEqual({
      from: FROM,
      to: [EMAIL],
      reply_to: FROM,
      subject: mail.subject,
      text: mail.text,
    });
    expect(t.queued()).toEqual([]);
    expect(t.ledger()).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
    expect(statSync(join(t.statusDir, `${itemKey(item())}.json`)).mode & 0o777).toBe(0o640);
    expect(t.logs).toEqual([`mailer: sent signup-approval-${ID}-g1 (attempt 1)`]);
    expectCleanLogs(t.logs);
  });

  it('renders the approved Hebrew text for lang he', async () => {
    const t = setup({ cfg: { replyTo: 'reply@example.com' } });
    await enqueueMail(t.queueDir, item({}, { lang: 'he', name: 'דנה לוי' }));
    await t.mailer.runOnce();
    const mail = approvalEmail('he', { name: 'דנה לוי', email: EMAIL }, { labUrl: LAB });
    expect(t.calls[0]!.body).toMatchObject({
      subject: mail.subject,
      text: mail.text,
      reply_to: 'reply@example.com',
    });
  });

  it('never sends a key twice: a second run and a re-queued entry are no-ops', async () => {
    const t = setup();
    await enqueueMail(t.queueDir, item());
    await t.mailer.runOnce();
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0 });
    expect(await enqueueMail(t.queueDir, item())).toBe('queued');
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, dropped: 1 });
    expect(t.calls).toHaveLength(1);
    expect(t.queued()).toEqual([]);
    // An explicit owner resend is a new generation = a new key.
    await enqueueMail(t.queueDir, item({ gen: 2 }));
    await t.mailer.runOnce();
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.headers['idempotency-key']).toBe(`signup-approval-${ID}-g2`);
  });
});

describe('greeting: the only writer-controlled text in the body', () => {
  // The one thing a queue writer chooses that reaches the mail body is the first name token.
  // Anything shaped like a link or an address falls back to a generic greeting.
  const unsafe = [
    'https://evil.example/login',
    'http://x',
    'evil.example',
    'evil.example/login now',
    'www.evil',
    'wwwevil',
    'dana@example.com',
    'dana@evil',
    'mailto:dana',
    'javascript:alert',
    'a/b',
    'Dana.Levi',
    'Dana2',
    '<Dana>',
    'x'.repeat(41),
    '-Dana',
    "Dana'",
  ];
  const safe: Array<[string, string]> = [
    ['Dana Levi', 'Dana'],
    ['דנה לוי', 'דנה'],
    ['Jean-Luc Picard', 'Jean-Luc'],
    ["O'Brien", "O'Brien"],
    ['D\u2019Angelo', 'D\u2019Angelo'],
    ['ז\u05F3ניה כהן', 'ז\u05F3ניה'],
    ['José García', 'José'],
    ['D', 'D'],
  ];

  it('keeps HE and EN first names (letters, marks, hyphen, apostrophe)', () => {
    for (const [name, first] of safe) expect(greetingName(name), name).toBe(first);
  });

  it('refuses URL, domain, address and other non-name shapes', () => {
    for (const name of unsafe) expect(greetingName(name), name).toBeNull();
  });

  it('the mail falls back to a generic greeting and never carries the token', () => {
    for (const name of unsafe) {
      const en = approvalEmail('en', { name, email: EMAIL }, { labUrl: LAB });
      const he = approvalEmail('he', { name, email: EMAIL }, { labUrl: LAB });
      expect(en.text.split('\n')[0], name).toBe('Hi,');
      expect(he.text.split('\n')[0], name).toBe('שלום,');
      expect(en.text, name).not.toContain(name.split(' ')[0]);
      expect(he.text, name).not.toContain(name.split(' ')[0]);
    }
    expect(approvalEmail('en', { name: NAME, email: EMAIL }, { labUrl: LAB }).text).toMatch(
      /^Hi Dana,\n/,
    );
    expect(approvalEmail('he', { name: 'דנה לוי', email: EMAIL }, { labUrl: LAB }).text).toMatch(
      /^שלום דנה,\n/,
    );
  });

  it('a queued URL-shaped name is sent with the generic greeting, the URL never in the body', async () => {
    const t = setup();
    await enqueueMail(t.queueDir, item({}, { name: 'https://evil.example/login' }));
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1 });
    const text = t.calls[0]!.body.text as string;
    expect(text.startsWith('Hi,\n')).toBe(true);
    expect(text).not.toContain('evil');
    expectCleanLogs(t.logs);
  });
});

describe('mailer: quiet hours (Asia/Jerusalem 23:00-08:00)', () => {
  it('sends nothing at night and leaves the entry; sends at 08:00', async () => {
    const t = setup({ now: NIGHT });
    await enqueueMail(t.queueDir, item({ createdAt: NIGHT - 1000 }));
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, deferred: 1 });
    expect(t.calls).toHaveLength(0);
    expect(t.queued()).toHaveLength(1);
    t.clock.now = Date.parse('2026-01-16T07:59:00+02:00');
    await t.mailer.runOnce();
    expect(t.calls).toHaveLength(0);
    t.clock.now = Date.parse('2026-01-16T08:00:00+02:00');
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1 });
    expect(t.calls).toHaveLength(1);
  });

  it('quiet off sends at night', async () => {
    const t = setup({ now: NIGHT, cfg: { quiet: null } });
    await enqueueMail(t.queueDir, item({ createdAt: NIGHT - 1000 }));
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1 });
  });
});

describe('mailer: retry and dead letters', () => {
  it('retries a 503 with backoff and the same idempotency key, then succeeds', async () => {
    const t = setup({ answers: [503, 'throw', 200] });
    await enqueueMail(t.queueDir, item());
    expect(await t.mailer.runOnce()).toMatchObject({ retrying: 1 });
    expect(t.ledger()).toMatchObject({
      status: 'retry',
      attempts: 1,
      lastError: 'http_503',
      nextAt: DAY + 60_000,
    });
    expect(t.queued()).toHaveLength(1);
    t.clock.now = DAY + 30_000;
    expect(await t.mailer.runOnce()).toMatchObject({ skipped: 1 });
    expect(t.calls).toHaveLength(1);
    t.clock.now = DAY + 60_000;
    await t.mailer.runOnce();
    expect(t.ledger()).toMatchObject({ status: 'retry', attempts: 2, lastError: 'network' });
    t.clock.now = DAY + 60_000 + backoffMs(2);
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1 });
    expect(t.calls.map((c) => c.headers['idempotency-key'])).toEqual(
      Array(3).fill(`signup-approval-${ID}-g1`),
    );
    expect(t.ledger()).toMatchObject({ status: 'sent', attempts: 3, firstAttemptAt: DAY });
    expectCleanLogs(t.logs);
  });

  it('a permanent provider error is a dead letter at once', async () => {
    const t = setup({ answers: [422] });
    await enqueueMail(t.queueDir, item());
    expect(await t.mailer.runOnce()).toMatchObject({ dead: 1 });
    expect(t.ledger()).toMatchObject({ status: 'dead', attempts: 1, lastError: 'http_422' });
    expect(t.queued()).toEqual([]);
    await enqueueMail(t.queueDir, item());
    await t.mailer.runOnce();
    expect(t.calls).toHaveLength(1);
  });

  it('gives up inside the idempotency window, never after it', async () => {
    const t = setup({ answers: Array(50).fill(503) as number[] });
    await enqueueMail(t.queueDir, item());
    for (let i = 0; i < 50; i++) {
      await t.mailer.runOnce();
      const l = t.ledger();
      if (l.status === 'dead') break;
      t.clock.now = l.nextAt!;
    }
    const l = t.ledger();
    expect(l.status).toBe('dead');
    expect(t.calls.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
    expect(l.lastAttemptAt! - l.firstAttemptAt!).toBeLessThanOrEqual(IDEMPOTENCY_WINDOW_MS);
    expect(t.queued()).toEqual([]);
  });

  it('the attempt is on disk (sending) before the provider is called', async () => {
    const t = setup();
    await enqueueMail(t.queueDir, item());
    let seen: Ledger | null = null;
    const m = new Mailer(
      {
        queueDir: t.queueDir,
        statusDir: t.statusDir,
        from: FROM,
        labUrl: LAB,
        quiet: parseQuiet(undefined),
        maxPerRun: 10,
        maxPerHour: 20,
        maxPerDay: 100,
      },
      {
        transport: {
          send: async () => {
            seen = t.ledger();
          },
        },
        log: () => undefined,
        now: () => DAY,
      },
    );
    await m.runOnce();
    expect(seen).toMatchObject({ status: 'sending', attempts: 1, firstAttemptAt: DAY });
    expect(t.ledger()).toMatchObject({ status: 'sent' });
  });

  it('an interrupted send (ledger left at sending) is retried with the same key', async () => {
    const t = setup();
    await enqueueMail(t.queueDir, item());
    const key = itemKey(item());
    writeFileSync(
      join(t.statusDir, `${key}.json`),
      JSON.stringify({
        v: 1,
        key,
        status: 'sending',
        attempts: 1,
        firstAttemptAt: DAY - 600_000,
        lastAttemptAt: DAY - 600_000,
        nextAt: null,
        lastError: null,
        updatedAt: DAY - 600_000,
      }),
    );
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1 });
    expect(t.ledger()).toMatchObject({ attempts: 2, firstAttemptAt: DAY - 600_000 });
    expect(t.calls[0]!.headers['idempotency-key']).toBe(key);
  });

  it('an interrupted send older than the window is not retried', async () => {
    const t = setup();
    await enqueueMail(t.queueDir, item());
    const key = itemKey(item());
    const first = DAY - IDEMPOTENCY_WINDOW_MS - 1;
    writeFileSync(
      join(t.statusDir, `${key}.json`),
      JSON.stringify({
        v: 1,
        key,
        status: 'sending',
        attempts: 1,
        firstAttemptAt: first,
        lastAttemptAt: first,
        nextAt: null,
        lastError: null,
        updatedAt: first,
      }),
    );
    expect(await t.mailer.runOnce()).toMatchObject({ dead: 1, sent: 0 });
    expect(t.ledger()).toMatchObject({ status: 'dead', lastError: 'window_expired' });
    expect(t.calls).toHaveLength(0);
  });

  it('an unreadable ledger fails closed: nothing sent, entry kept', async () => {
    const t = setup();
    await enqueueMail(t.queueDir, item());
    writeFileSync(join(t.statusDir, `${itemKey(item())}.json`), '{not json');
    expect(await t.mailer.runOnce()).toMatchObject({ skipped: 1, sent: 0 });
    expect(t.calls).toHaveLength(0);
    expect(t.queued()).toHaveLength(1);
  });

  it('a stale entry (never attempted, older than the max age) is not sent', async () => {
    const t = setup();
    await enqueueMail(t.queueDir, item({ createdAt: DAY - MAX_ITEM_AGE_MS - 1 }));
    expect(await t.mailer.runOnce()).toMatchObject({ dead: 1 });
    expect(t.ledger()).toMatchObject({ status: 'dead', lastError: 'stale' });
    expect(t.calls).toHaveLength(0);
  });
});

describe('mailer: the key', () => {
  it('a malformed or missing key is retried as a class code, never logged', async () => {
    let read: () => Promise<string> = async () => 'sk_live_wrong_shape_secret';
    const t = setup({ readKey: () => read() });
    await enqueueMail(t.queueDir, item());
    await t.mailer.runOnce();
    expect(t.calls).toHaveLength(0);
    expect(t.ledger()).toMatchObject({ status: 'retry', lastError: 'bad_key' });
    read = async () => {
      throw Object.assign(new Error(`ENOENT: no such file '/etc/x/resend.key'`), {
        code: 'ENOENT',
      });
    };
    t.clock.now = t.ledger().nextAt!;
    await t.mailer.runOnce();
    expect(t.ledger()).toMatchObject({ status: 'retry', lastError: 'secret_missing' });
    const all =
      t.logs.join('\n') + readFileSync(join(t.statusDir, `${itemKey(item())}.json`), 'utf8');
    expect(all).not.toContain('sk_live_wrong_shape_secret');
    expect(all).not.toContain('resend.key');
    expectCleanLogs(t.logs);
  });

  it('a transport error message carrying the key never reaches the log or ledger', async () => {
    const t = setup({ answers: ['throw'] });
    await enqueueMail(t.queueDir, item());
    await t.mailer.runOnce();
    const all =
      t.logs.join('\n') + readFileSync(join(t.statusDir, `${itemKey(item())}.json`), 'utf8');
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain('api.resend.com');
    expect(t.ledger().lastError).toBe('network');
  });
});

describe('mailer: malformed queue entries are refused, never sent', () => {
  const key = `signup-approval-${ID}-g1`;
  const good = () => JSON.stringify(item());

  async function refused(
    write: (queueDir: string) => void,
    reason: string,
    cfg: Partial<MailerConfig> = {},
  ) {
    const t = setup({ cfg });
    write(t.queueDir);
    const s = await t.mailer.runOnce();
    expect(s, reason).toMatchObject({ rejected: 1, sent: 0 });
    expect(t.calls, reason).toHaveLength(0);
    expect(t.queued(), reason).toEqual([]);
    expect(t.ledger(key), reason).toMatchObject({
      status: 'dead',
      lastError: `rejected_${reason}`,
    });
    expectCleanLogs(t.logs);
    return t;
  }
  const put =
    (text: string | Buffer, mode = 0o640, name = `${key}.json`) =>
    (q: string) => {
      writeFileSync(join(q, name), text, { mode });
      chmodSync(join(q, name), mode);
    };

  it('bad JSON, encoding, schema, size, extra fields, name/content mismatch, future time', async () => {
    await refused(put('{"v":1,'), 'bad_json');
    await refused(put(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])), 'bad_encoding');
    await refused(put(JSON.stringify({ ...item(), subject: 'Win a prize' })), 'bad_shape');
    await refused(put(JSON.stringify({ ...item(), v: 2 })), 'bad_version');
    await refused(put(JSON.stringify(item({}, { email: 'a@b' }))), 'bad_email');
    await refused(put(JSON.stringify(item({}, { name: 'Dana\nBcc: x' }))), 'bad_name');
    await refused(
      put(JSON.stringify({ ...item(), pad: 'x'.repeat(QUEUE_MAX_BYTES) })),
      'too_large',
    );
    await refused(put(JSON.stringify(item({ id: ID2 }))), 'name_mismatch');
    await refused(put(JSON.stringify(item({ createdAt: DAY + 3_600_000 }))), 'bad_time');
  });

  it('unsafe mode, a symlink and a foreign owner', async () => {
    await refused(put(good(), 0o660), 'unsafe_mode');
    await refused(put(good(), 0o644), 'unsafe_mode');
    await refused((q) => {
      writeFileSync(join(q, '..', 'target.json'), good(), { mode: 0o640 });
      symlinkSync(join(q, '..', 'target.json'), join(q, `${key}.json`));
    }, 'not_file');
    await refused(put(good()), 'bad_owner', { queueUid: (process.getuid?.() ?? 0) + 1 });
  });

  it('a file with an invalid name is removed and its name never logged', async () => {
    const t = setup();
    writeFileSync(join(t.queueDir, 'evil-dana@example.com.json'), good(), { mode: 0o640 });
    expect(await t.mailer.runOnce()).toMatchObject({ rejected: 1 });
    expect(t.queued()).toEqual([]);
    expect(t.logs).toEqual(['mailer: rejected an entry with an invalid name (bad_name)']);
    expect(readdirSync(t.statusDir)).toEqual([]);
  });

  it('a hard-linked entry (writer mid-enqueue, or a planted link) is skipped and kept', async () => {
    const t = setup();
    put(good())(t.queueDir);
    linkSync(join(t.queueDir, `${key}.json`), join(t.root, 'other-link'));
    expect(await t.mailer.runOnce()).toMatchObject({ skipped: 1, sent: 0 });
    expect(t.queued()).toHaveLength(1);
  });

  it('an unreadable entry (EACCES) is a skip: kept, no ledger, the class logged once per run', async () => {
    const t = setup();
    for (const id of [ID, ID2]) {
      const n = `${itemKey(item({ id }))}.json`;
      writeFileSync(join(t.queueDir, n), JSON.stringify(item({ id })), { mode: 0o640 });
      chmodSync(join(t.queueDir, n), 0o000);
    }
    expect(await t.mailer.runOnce()).toMatchObject({ skipped: 2, rejected: 0, dead: 0, sent: 0 });
    expect(t.queued()).toHaveLength(2);
    expect(readdirSync(t.statusDir)).toEqual([]);
    expect(t.logs).toEqual(['mailer: queue entries unreadable (EACCES); kept, not sent']);
    expect(t.calls).toHaveLength(0);
    // Once readable (operator fixed permissions), they are sent normally.
    for (const n of t.queued()) chmodSync(join(t.queueDir, n), 0o640);
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 2 });
    expectCleanLogs(t.logs);
  });

  it('a directory with a valid key name: removed when empty, else kept; no ledger, logged once', async () => {
    const t = setup();
    mkdirSync(join(t.queueDir, `${key}.json`));
    const k2 = `${itemKey(item({ id: ID2 }))}.json`;
    mkdirSync(join(t.queueDir, k2));
    writeFileSync(join(t.queueDir, k2, 'x'), 'x');
    expect(await t.mailer.runOnce()).toMatchObject({ skipped: 2, rejected: 0, sent: 0 });
    expect(t.queued()).toEqual([k2]);
    expect(readdirSync(t.statusDir)).toEqual([]);
    expect(t.logs).toEqual([
      'mailer: directory entries in the queue (2): 1 empty removed, 1 non-empty kept',
    ]);
    expectCleanLogs(t.logs);
  });

  it('stale writer temp files are removed, fresh ones kept and never read', async () => {
    const t = setup();
    writeFileSync(join(t.queueDir, '.tmp-old'), good(), { mode: 0o640 });
    writeFileSync(join(t.queueDir, '.tmp-new'), good(), { mode: 0o640 });
    const old = (DAY - 2 * 3_600_000) / 1000;
    utimesSync(join(t.queueDir, '.tmp-old'), old, old);
    const now = DAY / 1000;
    utimesSync(join(t.queueDir, '.tmp-new'), now, now);
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, rejected: 0 });
    expect(t.queued()).toEqual(['.tmp-new']);
    expect(t.calls).toHaveLength(0);
  });
});

describe('mailer: abuse limits', () => {
  it('caps attempts per run and per hour; the rest waits', async () => {
    const t = setup({ cfg: { maxPerRun: 2, maxPerHour: 3 } });
    for (const id of [ID, ID2, ID3]) await enqueueMail(t.queueDir, item({ id }));
    await enqueueMail(t.queueDir, item({ id: '01JD0000000000000000000003' }));
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 2, deferred: 2 });
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1, deferred: 1 });
    t.clock.now = DAY + 3_600_001;
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1, deferred: 0 });
    expect(t.calls).toHaveLength(4);
  });
});

describe('mailer: rate counters survive a restart', () => {
  it('init() rebuilds the hour/day counters from the ledgers', async () => {
    const t = setup({ cfg: { maxPerHour: 2, maxPerDay: 3 } });
    const led = (id: string, at: number, attempts = 1, first = at): Ledger => ({
      v: 1,
      key: itemKey(item({ id })),
      status: 'sent',
      attempts,
      firstAttemptAt: first,
      lastAttemptAt: at,
      nextAt: null,
      lastError: null,
      updatedAt: at,
    });
    const w = (l: Ledger) =>
      writeFileSync(join(t.statusDir, `${l.key}.json`), JSON.stringify(l), { mode: 0o640 });
    // Two attempts in the last hour (one entry retried: first and last attempt both count).
    w(led('01JD0000000000000000000010', DAY - 10 * 60_000, 2, DAY - 20 * 60_000));
    // Older than 24 h: ignored. A junk file: ignored.
    w(led('01JD0000000000000000000011', DAY - 25 * 3_600_000));
    writeFileSync(join(t.statusDir, 'junk.json'), '{', { mode: 0o640 });
    await t.mailer.init();
    await enqueueMail(t.queueDir, item());
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, deferred: 1 });
    t.clock.now = DAY + 3_600_000;
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1 });
    await enqueueMail(t.queueDir, item({ id: ID2 }));
    // Day cap 3 reached (2 rebuilt + 1 sent).
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, deferred: 1 });
    expectCleanLogs(t.logs);
  });
});

describe('mailer: start checks', () => {
  it('refuses missing or world-accessible directories', async () => {
    const t = setup();
    await expect(t.mailer.init()).resolves.toBeUndefined();
    chmodSync(t.queueDir, 0o733);
    await expect(t.mailer.init()).rejects.toThrow('unsafe_queue_dir');
    chmodSync(t.queueDir, 0o730);
    chmodSync(t.statusDir, 0o755);
    await expect(t.mailer.init()).rejects.toThrow('unsafe_status_dir');
    rmSync(t.statusDir, { recursive: true });
    await expect(t.mailer.init()).rejects.toThrow('unsafe_status_dir');
  });
});

describe('transport classification', () => {
  it('retries transient and operator-fixable failures only', () => {
    for (const c of [
      'network',
      'bad_key',
      'secret_missing',
      'secret_unreadable',
      'http_401',
      'http_403',
      'http_408',
      'http_429',
      'http_500',
      'http_503',
    ])
      expect(isRetryable(c), c).toBe(true);
    for (const c of [
      'http_400',
      'http_404',
      'http_409',
      'http_413',
      'http_422',
      'error',
      'bad_json',
    ])
      expect(isRetryable(c), c).toBe(false);
  });
});

describe('mailerConfigFromEnv', () => {
  const ok = {
    TBI_MAILER: '1',
    TBI_MAILER_QUEUE_DIR: '/var/lib/q',
    TBI_MAILER_STATUS_DIR: '/var/lib/s',
    TBI_MAILER_KEY_FILE: '/run/credentials/x/resend.key',
    TBI_MAILER_FROM: FROM,
    TBI_MAILER_LAB_URL: LAB,
  };
  it('is off unless TBI_MAILER=1', () => {
    expect(mailerConfigFromEnv({})).toMatchObject({ enabled: false });
    expect(mailerConfigFromEnv({ ...ok, TBI_MAILER: 'true' })).toMatchObject({ enabled: false });
    expect(mailerConfigFromEnv({ ...ok, TBI_MAILER: 'true' }).error).toBeFalsy();
  });
  it('accepts a full config with defaults', () => {
    const r = mailerConfigFromEnv(ok);
    expect(r.enabled).toBe(true);
    if (!r.enabled) return;
    expect(r.config).toMatchObject({
      maxPerHour: 20,
      maxPerDay: 100,
      quiet: { startMin: 1380, endMin: 480 },
    });
    expect(r.config.queueUid).toBeUndefined();
  });
  it('fails closed on missing or bad settings, without echoing values', () => {
    const cases: Array<Record<string, string | undefined>> = [
      { TBI_MAILER_QUEUE_DIR: undefined },
      { TBI_MAILER_KEY_FILE: 'relative/key' },
      { TBI_MAILER_STATUS_DIR: '/var/lib/q' },
      { TBI_MAILER_LAB_URL: 'http://lab.example.com/' },
      { TBI_MAILER_FROM: 'a\nBcc: b@example.com' },
      { TBI_MAILER_QUIET: '25:00-08:00' },
      { TBI_MAILER_MAX_PER_HOUR: '0' },
      { TBI_MAILER_MAX_PER_DAY: '5', TBI_MAILER_MAX_PER_HOUR: '10' },
      { TBI_MAILER_QUEUE_UID: '0' },
      { TBI_MAILER_QUEUE_UID: 'admin' },
    ];
    for (const c of cases) {
      const r = mailerConfigFromEnv({ ...ok, ...c });
      expect(r, JSON.stringify(c)).toMatchObject({ enabled: false, error: true });
      for (const v of Object.values(c)) if (v && v.length > 4) expect(r.reason).not.toContain(v);
    }
  });
});

describe('mailer: stuck entries never starve real mail (ops review A)', () => {
  // `01JC...` ids sort before ID (`01JD...`): the stuck entries come first in the listing.
  const stuckId = (i: number) => `01JC${String(i).padStart(22, '0')}`;
  const stuckKey = (i: number) => itemKey(item({ id: stuckId(i) }));
  const stuckName = (i: number) => `${stuckKey(i)}.json`;
  const OLD = (DAY - 25 * 3_600_000) / 1000;
  const FRESH = (DAY - 60_000) / 1000;
  const LATER = DAY + STUCK_MAX_AGE_MS;
  function unreadable(q: string, i: number, mtime: number) {
    const p = join(q, stuckName(i));
    writeFileSync(p, JSON.stringify(item({ id: stuckId(i) })), { mode: 0o640 });
    chmodSync(p, 0o000);
    utimesSync(p, mtime, mtime);
  }
  function corruptLedger(t: ReturnType<typeof setup>, i: number, mtime: number) {
    writeFileSync(join(t.queueDir, stuckName(i)), JSON.stringify(item({ id: stuckId(i) })), {
      mode: 0o640,
    });
    writeFileSync(join(t.statusDir, stuckName(i)), '{', { mode: 0o640 });
    utimesSync(join(t.statusDir, stuckName(i)), mtime, mtime);
  }

  it('500 stuck unreadable entries do not use the cap: the real mail is sent; after 24 h seen stuck they are dead-lettered', async () => {
    const t = setup();
    for (let i = 0; i < 500; i++) unreadable(t.queueDir, i, OLD);
    await enqueueMail(t.queueDir, item());
    // First sight: kept even though the files are old (a transient EIO/EMFILE after a downtime
    // must not lose a valid mail); the real one is sent anyway.
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1, dead: 0, skipped: 500 });
    expect(t.queued()).toHaveLength(500);
    expect(t.logs.filter((l) => l.includes('WARNING'))).toEqual([
      'mailer: WARNING: 500 stuck queue entries (unreadable, non-empty directories or unreadable ledgers); operator action needed',
    ]);
    // Still unreadable 24 h later: dead-lettered, and the dead-letters do not use the cap either.
    t.clock.now = LATER;
    await enqueueMail(t.queueDir, item({ id: ID2, createdAt: LATER - 60_000 }));
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1, dead: 500 });
    expect(t.calls).toHaveLength(2);
    expect(t.queued()).toEqual([]);
    expect(t.ledger(stuckKey(7))).toMatchObject({ status: 'dead', lastError: 'stuck_unreadable' });
    expectCleanLogs(t.logs);
  });

  it('an unreadable entry is dead-lettered only after 24 h seen stuck AND a file mtime older than 24 h', async () => {
    const t = setup();
    unreadable(t.queueDir, 1, OLD); // old file
    unreadable(t.queueDir, 2, FRESH); // file only seen for a day, mtime refreshed later below
    expect(await t.mailer.runOnce()).toMatchObject({ dead: 0, skipped: 2 });
    t.clock.now = LATER - 1;
    expect(await t.mailer.runOnce()).toMatchObject({ dead: 0, skipped: 2 });
    // Entry 2's mtime is "now": seen stuck for 24 h but the file itself is not old.
    const fresh = LATER / 1000;
    utimesSync(join(t.queueDir, stuckName(2)), fresh, fresh);
    t.clock.now = LATER;
    expect(await t.mailer.runOnce()).toMatchObject({ dead: 1, skipped: 1 });
    expect(t.queued()).toEqual([stuckName(2)]);
    expect(t.ledger(stuckKey(1))).toMatchObject({ status: 'dead', lastError: 'stuck_unreadable' });
    expect(t.logs).toContain(`mailer: dead ${stuckKey(1)} (stuck_unreadable)`);
    expectCleanLogs(t.logs);
  });

  it('an entry that becomes readable again restarts the 24 h count and is sent', async () => {
    const t = setup();
    unreadable(t.queueDir, 1, OLD);
    expect(await t.mailer.runOnce()).toMatchObject({ skipped: 1 });
    chmodSync(join(t.queueDir, stuckName(1)), 0o640);
    t.clock.now = DAY + 3_600_000;
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1, dead: 0 });
    expect(t.ledger(stuckKey(1))).toMatchObject({ status: 'sent' });
  });

  it('a restarted mailer starts the 24 h count again (never dead-letters on first sight)', async () => {
    const t = setup();
    unreadable(t.queueDir, 1, OLD);
    expect(await t.mailer.runOnce()).toMatchObject({ skipped: 1 });
    const again = new Mailer(
      {
        queueDir: t.queueDir,
        statusDir: t.statusDir,
        from: FROM,
        labUrl: LAB,
        quiet: parseQuiet(undefined),
        maxPerRun: 10,
        maxPerHour: 20,
        maxPerDay: 100,
      },
      {
        transport: new ResendTransport({ readKey: async () => FAKE_KEY, fetch: t.fetch }),
        log: (l) => t.logs.push(l),
        now: () => LATER,
      },
    );
    expect(await again.runOnce()).toMatchObject({ dead: 0, skipped: 1 });
    expect(t.queued()).toEqual([stuckName(1)]);
  });

  it('fresh stuck entries (unreadable, non-empty dirs, unreadable ledgers) do not use the cap; kept; one warning, counts only', async () => {
    const t = setup();
    for (let i = 0; i < 200; i++) unreadable(t.queueDir, i, FRESH);
    for (let i = 200; i < 400; i++) {
      mkdirSync(join(t.queueDir, stuckName(i)));
      writeFileSync(join(t.queueDir, stuckName(i), 'x'), 'x');
    }
    for (let i = 400; i < 520; i++) corruptLedger(t, i, FRESH);
    await enqueueMail(t.queueDir, item());
    const s = await t.mailer.runOnce();
    expect(s).toMatchObject({ sent: 1, dead: 0, skipped: 520 });
    expect(t.queued()).toHaveLength(520);
    expect(t.logs.filter((l) => l.includes('WARNING'))).toEqual([
      'mailer: WARNING: 520 stuck queue entries (unreadable, non-empty directories or unreadable ledgers); operator action needed',
    ]);
    expect(t.logs.filter((l) => l.includes('with an unreadable ledger'))).toEqual([
      'mailer: queue entries with an unreadable ledger (120); kept, not sent',
    ]);
    expect(t.logs).toContain(
      'mailer: directory entries in the queue (200): 0 empty removed, 200 non-empty kept',
    );
    // Only the sent line names a key; the stuck ones are counted, never listed.
    expect(t.logs.filter((l) => l.includes('01JC'))).toEqual([]);
    expectCleanLogs(t.logs);
  });

  it('below the threshold there is no WARNING line', async () => {
    const t = setup();
    for (let i = 0; i < STUCK_WARN_THRESHOLD - 1; i++) unreadable(t.queueDir, i, FRESH);
    expect(await t.mailer.runOnce()).toMatchObject({ skipped: STUCK_WARN_THRESHOLD - 1 });
    expect(t.logs.filter((l) => l.includes('WARNING'))).toEqual([]);
    expect(t.logs).toEqual(['mailer: queue entries unreadable (EACCES); kept, not sent']);
  });

  it('the handled-entry cap still applies to real entries (500 per run)', async () => {
    const t = setup();
    // 501 entries already sent (ledger `sent`): each is a handled `dropped`.
    for (let i = 0; i < 501; i++) {
      writeFileSync(join(t.queueDir, stuckName(i)), JSON.stringify(item({ id: stuckId(i) })), {
        mode: 0o640,
      });
      writeFileSync(
        join(t.statusDir, stuckName(i)),
        JSON.stringify({
          v: 1,
          key: stuckKey(i),
          status: 'sent',
          attempts: 1,
          firstAttemptAt: DAY - 3_600_000,
          lastAttemptAt: DAY - 3_600_000,
          nextAt: null,
          lastError: null,
          updatedAt: DAY - 3_600_000,
        }),
        { mode: 0o640 },
      );
    }
    expect(await t.mailer.runOnce()).toMatchObject({ dropped: QUEUE_MAX_FILES });
    expect(t.queued()).toEqual([stuckName(500)]);
    expect(t.logs).toContain('mailer: queue over cap; 1 entr(y/ies) left for the next run');
  });

  it(`at most QUEUE_SCAN_MAX (${QUEUE_SCAN_MAX}) names are examined per run`, async () => {
    const t = setup();
    for (let i = 0; i < QUEUE_SCAN_MAX; i++) unreadable(t.queueDir, i, FRESH);
    await enqueueMail(t.queueDir, item()); // sorts last: beyond the scan cap
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, skipped: QUEUE_SCAN_MAX });
    expect(t.calls).toHaveLength(0);
    expect(t.logs).toContain(
      `mailer: queue over scan cap (${QUEUE_SCAN_MAX + 1}); examining the oldest ${QUEUE_SCAN_MAX}`,
    );
    expectCleanLogs(t.logs);
  }, 60_000);

  it('an unreadable ledger is dead-lettered (stuck_ledger) only after 24 h seen stuck and an mtime older than 24 h; an old non-empty dir is kept', async () => {
    const t = setup();
    corruptLedger(t, 1, OLD);
    mkdirSync(join(t.queueDir, stuckName(2)));
    writeFileSync(join(t.queueDir, stuckName(2), 'x'), 'x');
    utimesSync(join(t.queueDir, stuckName(2)), OLD, OLD);
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, dead: 0, skipped: 2 });
    t.clock.now = LATER;
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, dead: 1, skipped: 1 });
    expect(t.calls).toHaveLength(0);
    expect(t.queued()).toEqual([stuckName(2)]);
    expect(t.ledger(stuckKey(1))).toMatchObject({ status: 'dead', lastError: 'stuck_ledger' });
    // Re-queued later: a no-op (dead).
    writeFileSync(join(t.queueDir, stuckName(1)), JSON.stringify(item({ id: stuckId(1) })), {
      mode: 0o640,
    });
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, dropped: 1 });
    expectCleanLogs(t.logs);
  });

  it('a transiently unreadable `sent` ledger is not overwritten on first sight; once readable the re-queue is dropped', async () => {
    const t = setup();
    const k = stuckKey(1);
    const sent = {
      v: 1,
      key: k,
      status: 'sent',
      attempts: 1,
      firstAttemptAt: DAY - 30 * 3_600_000,
      lastAttemptAt: DAY - 30 * 3_600_000,
      nextAt: null,
      lastError: null,
      updatedAt: DAY - 30 * 3_600_000,
    };
    const lp = join(t.statusDir, stuckName(1));
    writeFileSync(lp, JSON.stringify(sent), { mode: 0o640 });
    utimesSync(lp, OLD, OLD);
    chmodSync(lp, 0o000);
    writeFileSync(join(t.queueDir, stuckName(1)), JSON.stringify(item({ id: stuckId(1) })), {
      mode: 0o640,
    });
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, dead: 0, skipped: 1 });
    chmodSync(lp, 0o640);
    expect(t.ledger(k)).toEqual(sent);
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, dropped: 1 });
    expect(t.ledger(k)).toEqual(sent);
    expect(t.calls).toHaveLength(0);
  });
});

describe('mailer: rate counters over-count safely (ops review B, C)', () => {
  const led = (id: string, o: Partial<Ledger>): Ledger => ({
    v: 1,
    key: itemKey(item({ id })),
    status: 'sent',
    attempts: 1,
    firstAttemptAt: DAY - 2 * 3_600_000,
    lastAttemptAt: DAY - 2 * 3_600_000,
    nextAt: null,
    lastError: null,
    updatedAt: DAY - 2 * 3_600_000,
    ...o,
  });
  const w = (dir: string, l: Ledger) =>
    writeFileSync(join(dir, `${l.key}.json`), JSON.stringify(l), { mode: 0o640 });

  it('all attempts of a ledger whose first attempt is in the window count; init is idempotent', async () => {
    const t = setup({ cfg: { maxPerHour: 100, maxPerDay: 6 } });
    w(
      t.statusDir,
      led('01JD0000000000000000000010', {
        attempts: 5,
        firstAttemptAt: DAY - 3 * 3_600_000,
        lastAttemptAt: DAY - 2 * 3_600_000,
      }),
    );
    await t.mailer.init();
    await t.mailer.init();
    for (const id of [ID, ID2]) await enqueueMail(t.queueDir, item({ id }));
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1, deferred: 1 });
  });

  it('a ledger whose first attempt is outside the window counts attempts - 1 at lastAttemptAt', async () => {
    const t = setup({ cfg: { maxPerHour: 100, maxPerDay: 4 } });
    w(
      t.statusDir,
      led('01JD0000000000000000000010', {
        status: 'retry',
        attempts: 4,
        firstAttemptAt: DAY - 25 * 3_600_000,
        lastAttemptAt: DAY - 3_600_000,
        nextAt: DAY + 3_600_000,
      }),
    );
    await t.mailer.init();
    for (const id of [ID, ID2]) await enqueueMail(t.queueDir, item({ id }));
    // 3 of the 4 day slots are used: one more attempt, the other waits.
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1, deferred: 1 });
    // The 3 counted attempts sit at lastAttemptAt (DAY - 1 h): they expire at DAY + 23 h.
    t.clock.now = DAY + 23 * 3_600_000 - 1;
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, deferred: 1 });
    t.clock.now = DAY + 23 * 3_600_000 + 1;
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1 });
  });

  it('a huge attempts count is bounded by the day cap and blocks until it expires', async () => {
    const t = setup({ cfg: { maxPerHour: 100, maxPerDay: 6 } });
    w(t.statusDir, led('01JD0000000000000000000010', { attempts: 1_000_000_000 }));
    await t.mailer.init();
    await enqueueMail(t.queueDir, item());
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 0, deferred: 1 });
    t.clock.now = DAY + 22 * 3_600_000 + 1;
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1 });
  });

  it('ledgers with an mtime older than 24 h and oversized ledgers are not parsed for counters', async () => {
    const t = setup({ cfg: { maxPerHour: 1, maxPerDay: 1 } });
    const l = led('01JD0000000000000000000010', {});
    w(t.statusDir, l);
    const old = (DAY - 25 * 3_600_000) / 1000;
    utimesSync(join(t.statusDir, `${l.key}.json`), old, old);
    const big = led('01JD0000000000000000000011', {});
    writeFileSync(join(t.statusDir, `${big.key}.json`), JSON.stringify(big) + ' '.repeat(8192), {
      mode: 0o640,
    });
    await t.mailer.init();
    await enqueueMail(t.queueDir, item());
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 1 });
  });
});

describe('greetingName hardening (ops review D)', () => {
  // Built from code points so the fixture is explicit: fullwidth `ｗｗｗ`, superscript-w, fullwidth dot.
  const FW_WWW = '\uFF57\uFF57\uFF57';
  const unsafe = [
    `${FW_WWW}evil`,
    `${FW_WWW}\uFF0Eevil\uFF0Eexample`, // fullwidth dots: `www.evil.example` after NFKC
    'Ｗｗｗ',
    '\u02B7\u02B7\u02B7evil', // modifier letter small w: NFKC `www`
    '\u0301Dana', // combining mark first
    'evil\uFF0Eexample', // fullwidth dot
    'evil\u2024example', // one dot leader: NFKC `.`
    'Dana\uFF11', // fullwidth digit
    '\uFF20evil', // fullwidth @
  ];

  it('NFKC-normalizes before every check and requires a letter first', () => {
    for (const n of unsafe) expect(greetingName(n), n).toBeNull();
    expect(greetingName('\uFF24\uFF41\uFF4E\uFF41')).toBe('Dana'); // fullwidth, shown normalized
    expect(greetingName('José')).toBe('José');
    expect(greetingName('Jose\u0301')).toBe('José'); // decomposed: normalized (NFKC composes)
    expect(greetingName('דנה')).toBe('דנה');
  });

  it('the admin direct sender (approvalEmail) gives the generic greeting for fullwidth www', () => {
    for (const n of unsafe) {
      expect(approvalEmail('en', { name: n, email: EMAIL }, { labUrl: LAB }).text, n).toMatch(
        /^Hi,\n/,
      );
      expect(approvalEmail('he', { name: n, email: EMAIL }, { labUrl: LAB }).text, n).toMatch(
        /^שלום,\n/,
      );
    }
  });

  it('the mailer gives the generic greeting for a queued fullwidth-www name (same greetingName)', async () => {
    const t = setup();
    await enqueueMail(t.queueDir, item({}, { name: `${FW_WWW}evil Levi` }));
    await enqueueMail(t.queueDir, item({ id: ID2 }, { name: `${FW_WWW}evil`, lang: 'he' }));
    expect(await t.mailer.runOnce()).toMatchObject({ sent: 2 });
    const texts = t.calls.map((c) => String(c.body.text));
    expect(texts[0]).toMatch(/^Hi,\n/);
    expect(texts[1]).toMatch(/^שלום,\n/);
    for (const x of texts) {
      expect(x).not.toContain(FW_WWW);
      expect(x).not.toMatch(/www/i);
    }
    expectCleanLogs(t.logs);
  });
});
