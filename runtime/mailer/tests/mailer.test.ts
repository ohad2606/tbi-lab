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
import { approvalEmail } from '../../admin/signup/email.js';
import type { FetchLike } from '../../admin/signup/notify.js';
import { parseQuiet } from '../../admin/signup/quietHours.js';
import { mailerConfigFromEnv } from '../config.js';
import {
  backoffMs,
  IDEMPOTENCY_WINDOW_MS,
  Mailer,
  MAX_ATTEMPTS,
  MAX_ITEM_AGE_MS,
  type Ledger,
  type MailerConfig,
} from '../mailer.js';
import { enqueueMail, itemKey, QUEUE_MAX_BYTES, QueueError, type QueueItem } from '../queue.js';
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
        quiet: null,
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
