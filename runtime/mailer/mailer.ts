/**
 * ARC-MAILER (D-ARC-2): the mailer side. Reads the queue written by the admin service, renders the
 * owner-approved template, sends through an injected transport, and records the outcome in its
 * status ledger (no personal data). Design: docs/alpha/MAILER-DESIGN.md.
 *
 * Guarantees (each unit-tested):
 * - No duplicate send: the attempt is persisted (`sending`) BEFORE the provider call; a `sent` or
 *   `dead` ledger makes a re-queued entry with the same key a no-op; every retry reuses the same
 *   provider idempotency key and is allowed only inside the provider's de-duplication window
 *   (IDEMPOTENCY_WINDOW_MS, with margin), never after it.
 * - Quiet hours (Asia/Jerusalem, default 23:00-08:00): nothing is sent inside the window; the
 *   entries wait in the queue untouched.
 * - Malformed entries (name, size, mode, owner, link, encoding, schema) are refused: removed from
 *   the queue and, when the name is a valid key, recorded as dead with the reason. Never repaired.
 *   An entry the mailer cannot read (EACCES, EMFILE, EIO ...: an operator or host problem, not a
 *   content fault) is kept and retried next run; a directory with a key name is removed when
 *   empty, else left alone; neither gets a ledger.
 * - The only queue value that reaches the mail body is the recipient's first name, and only as a
 *   plain letters-only token (`greetingName`); anything else gets the generic greeting.
 * - Abuse limits: per run, per hour and per day attempt caps (rebuilt from the ledgers at start);
 *   the queue listing is capped.
 * - Logs carry keys (a random request id) and class codes only: never an address, a name, the
 *   mail text, the key or a path.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { approvalEmail } from '../admin/signup/email.js';
import { errorClass } from '../admin/signup/errors.js';
import { isQuiet, type QuietWindow } from '../admin/signup/quietHours.js';
import {
  itemKey,
  parseQueueItem,
  QUEUE_KEY_RE,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_FILES,
  QUEUE_NAME_RE,
  QUEUE_TMP_PREFIX,
  type QueueItem,
} from './queue.js';
import { isRetryable, MailError, type MailTransport, type OutgoingMail } from './transport.js';

const HOUR = 3_600_000;
/** Resend keeps an idempotency key for 24 h; we stop retrying one hour before that. */
export const IDEMPOTENCY_WINDOW_MS = 23 * HOUR;
export const MAX_ATTEMPTS = 10;
/** An entry never attempted and older than this is not sent (dead `stale`). */
export const MAX_ITEM_AGE_MS = 7 * 24 * HOUR;
/** Allowed clock difference between writer and mailer for `createdAt`. */
export const CLOCK_SKEW_MS = 5 * 60_000;
/** Writer temporary files older than this are removed. */
export const TMP_STALE_MS = HOUR;

/** 1, 2, 4, ... minutes, at most 2 h. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 2 * HOUR);
}

export type LedgerStatus = 'sending' | 'retry' | 'sent' | 'dead';
const STATUSES: readonly string[] = ['sending', 'retry', 'sent', 'dead'];

/** Status ledger entry `<statusDir>/<key>.json`; readable by the admin service, no personal data. */
export interface Ledger {
  v: 1;
  key: string;
  status: LedgerStatus;
  attempts: number;
  firstAttemptAt: number | null;
  lastAttemptAt: number | null;
  nextAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface MailerConfig {
  queueDir: string;
  statusDir: string;
  from: string;
  replyTo?: string;
  labUrl: string;
  quiet: QuietWindow | null;
  maxPerRun: number;
  maxPerHour: number;
  maxPerDay: number;
  /** When set, queue files must be owned by this uid (the admin service user). */
  queueUid?: number;
}

export interface MailerIo {
  transport: MailTransport;
  log: (line: string) => void;
  now?: () => number;
}

export interface RunSummary {
  sent: number;
  /** Entries left waiting because of quiet hours or a rate limit. */
  deferred: number;
  /** Failed attempts scheduled for a retry. */
  retrying: number;
  /** Entries given up (permanent failure, attempts or window exhausted, stale). */
  dead: number;
  /** Malformed entries refused and removed. */
  rejected: number;
  /** Re-queued entries whose key was already sent or dead. */
  dropped: number;
  /** Entries not due yet, not ready (still linked), or with an unreadable ledger. */
  skipped: number;
}

export class MailerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Read =
  | { ok: true; item: QueueItem }
  | { ok: false; reason: string }
  | { ok: 'skip' }
  /** Could not be opened or read (errno class): kept for the next run. */
  | { ok: 'unreadable'; code: string }
  | { ok: 'dir' };

/** An errno code (`EACCES`), else `fs_error`: never a message or a path. */
function errnoClass(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code) ? code : 'fs_error';
}

export class Mailer {
  private readonly now: () => number;
  /** Provider attempts of this process (rate limits). */
  private readonly attemptsAt: number[] = [];

  constructor(
    private readonly c: MailerConfig,
    private readonly io: MailerIo,
  ) {
    this.now = io.now ?? Date.now;
  }

  /** Refuses (MailerError) a missing directory, a symlink, or one other users can access. */
  async init(): Promise<void> {
    for (const [dir, code] of [
      [this.c.queueDir, 'unsafe_queue_dir'],
      [this.c.statusDir, 'unsafe_status_dir'],
    ] as const) {
      const st = await lstat(dir).catch(() => null);
      if (!st || !st.isDirectory() || (st.mode & 0o007) !== 0) throw new MailerError(code);
    }
    await this.restoreRateCounters();
  }

  /**
   * A restart must not reset the hour/day caps: every ledger's first and last attempt inside the
   * last 24 h counts. A lower bound (middle attempts of a retried entry are not recorded); invalid
   * names and unreadable ledgers are ignored.
   */
  private async restoreRateCounters(): Promise<void> {
    const now = this.now();
    const keys = (await readdir(this.c.statusDir))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((k) => QUEUE_KEY_RE.test(k));
    for (const k of keys) {
      const l = await this.readLedger(k);
      if (!l || l === 'corrupt') continue;
      for (const t of new Set([l.firstAttemptAt, l.lastAttemptAt]))
        if (typeof t === 'number' && t > now - 24 * HOUR && t <= now) this.attemptsAt.push(t);
    }
    // mayAttempt() expires from the front: keep it oldest first.
    this.attemptsAt.sort((a, b) => a - b);
  }

  async runOnce(): Promise<RunSummary> {
    const now = this.now();
    const s: RunSummary = {
      sent: 0,
      deferred: 0,
      retrying: 0,
      dead: 0,
      rejected: 0,
      dropped: 0,
      skipped: 0,
    };
    const all = await readdir(this.c.queueDir);
    await this.removeStaleTmp(
      all.filter((n) => n.startsWith(QUEUE_TMP_PREFIX)),
      now,
    );
    let names = all.filter((n) => !n.startsWith(QUEUE_TMP_PREFIX)).sort();
    if (names.length > QUEUE_MAX_FILES) {
      this.log(`queue over cap (${names.length}); processing the oldest ${QUEUE_MAX_FILES}`);
      names = names.slice(0, QUEUE_MAX_FILES);
    }
    if (isQuiet(now, this.c.quiet)) {
      s.deferred = names.length;
      if (names.length) this.log(`quiet hours: ${names.length} entr(y/ies) waiting`);
      return s;
    }
    let attemptsThisRun = 0;
    const unreadable = new Map<string, number>();
    let dirs = 0;
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      const m = QUEUE_NAME_RE.exec(name);
      if (!m) {
        await this.reject(name, null, 'bad_name', now);
        s.rejected++;
        continue;
      }
      const key = name.slice(0, -'.json'.length);
      const ledger = await this.readLedger(key);
      if (ledger === 'corrupt') {
        // Fail closed: without a trustworthy record a send could be a duplicate.
        this.log(`ledger unreadable for ${key}; entry kept, not sent`);
        s.skipped++;
        continue;
      }
      if (ledger && (ledger.status === 'sent' || ledger.status === 'dead')) {
        await this.unlinkEntry(name);
        this.log(`dropped ${key} (already ${ledger.status})`);
        s.dropped++;
        continue;
      }
      if (ledger?.nextAt != null && now < ledger.nextAt) {
        s.skipped++;
        continue;
      }
      const r = await this.readEntry(name);
      if (r.ok === 'skip') {
        s.skipped++;
        continue;
      }
      if (r.ok === 'unreadable') {
        // Not a content fault: keep it (no ledger) and try again next run.
        unreadable.set(r.code, (unreadable.get(r.code) ?? 0) + 1);
        s.skipped++;
        continue;
      }
      if (r.ok === 'dir') {
        await rmdir(join(this.c.queueDir, name)).catch(() => undefined);
        dirs++;
        s.skipped++;
        continue;
      }
      if (!r.ok) {
        await this.reject(name, key, r.reason, now);
        s.rejected++;
        continue;
      }
      const item = r.item;
      if (itemKey(item) !== key) {
        await this.reject(name, key, 'name_mismatch', now);
        s.rejected++;
        continue;
      }
      if (item.createdAt > now + CLOCK_SKEW_MS) {
        await this.reject(name, key, 'bad_time', now);
        s.rejected++;
        continue;
      }
      const first = ledger?.firstAttemptAt ?? null;
      if (first === null && now - item.createdAt > MAX_ITEM_AGE_MS) {
        await this.giveUp(name, key, ledger, 'stale', now);
        s.dead++;
        continue;
      }
      if (first !== null && now - first > IDEMPOTENCY_WINDOW_MS) {
        await this.giveUp(name, key, ledger, 'window_expired', now);
        s.dead++;
        continue;
      }
      if (!this.mayAttempt(now, attemptsThisRun)) {
        const left = names.length - i;
        this.log(`rate limit reached; ${left} entr(y/ies) left for later`);
        s.deferred += left;
        break;
      }
      const attempts = (ledger?.attempts ?? 0) + 1;
      const firstAt = first ?? now;
      try {
        await this.writeLedger({
          v: 1,
          key,
          status: 'sending',
          attempts,
          firstAttemptAt: firstAt,
          lastAttemptAt: now,
          nextAt: null,
          lastError: ledger?.lastError ?? null,
          updatedAt: now,
        });
      } catch (e) {
        // No record of the attempt = no attempt.
        this.log(`ledger write failed for ${key} (${errorClass(e)}); not sent`);
        s.skipped++;
        continue;
      }
      attemptsThisRun++;
      this.attemptsAt.push(now);
      try {
        await this.io.transport.send(this.render(item, key));
      } catch (e) {
        const code = e instanceof MailError ? e.code : errorClass(e);
        const nextAt = now + backoffMs(attempts);
        if (
          isRetryable(code) &&
          attempts < MAX_ATTEMPTS &&
          nextAt - firstAt <= IDEMPOTENCY_WINDOW_MS
        ) {
          await this.writeLedgerLogged({
            v: 1,
            key,
            status: 'retry',
            attempts,
            firstAttemptAt: firstAt,
            lastAttemptAt: now,
            nextAt,
            lastError: code,
            updatedAt: now,
          });
          this.log(
            `retry ${key} (${code}, attempt ${attempts}, next in ${backoffMs(attempts) / 1000}s)`,
          );
          s.retrying++;
        } else {
          await this.giveUp(
            name,
            key,
            { attempts, firstAttemptAt: firstAt, lastAttemptAt: now },
            code,
            now,
          );
          s.dead++;
        }
        continue;
      }
      // A failed ledger write here leaves `sending` and the entry in the queue: the next run
      // retries with the same key and the provider de-duplicates it (inside the window).
      const recorded = await this.writeLedgerLogged({
        v: 1,
        key,
        status: 'sent',
        attempts,
        firstAttemptAt: firstAt,
        lastAttemptAt: now,
        nextAt: null,
        lastError: null,
        updatedAt: now,
      });
      if (recorded) await this.unlinkEntry(name);
      this.log(`sent ${key} (attempt ${attempts})`);
      s.sent++;
    }
    // One line per class per run (counts, no names).
    if (unreadable.size)
      this.log(
        `queue entries unreadable (${[...unreadable.keys()].sort().join(', ')}); kept, not sent`,
      );
    if (dirs) this.log(`directory entries in the queue (${dirs}); empty ones removed`);
    return s;
  }

  private log(line: string): void {
    this.io.log(`mailer: ${line}`);
  }

  private render(item: QueueItem, key: string): OutgoingMail {
    // The only template today; the switch makes a new one a compile error until it is handled.
    switch (item.template) {
      case 'signup-approval': {
        const mail = approvalEmail(item.to.lang, item.to, { labUrl: this.c.labUrl });
        return {
          from: this.c.from,
          to: item.to.email,
          replyTo: this.c.replyTo ?? this.c.from,
          subject: mail.subject,
          text: mail.text,
          idempotencyKey: key,
        };
      }
    }
  }

  private mayAttempt(now: number, thisRun: number): boolean {
    while (this.attemptsAt.length && this.attemptsAt[0]! <= now - 24 * HOUR)
      this.attemptsAt.shift();
    const lastHour = this.attemptsAt.filter((t) => t > now - HOUR).length;
    return (
      thisRun < this.c.maxPerRun &&
      lastHour < this.c.maxPerHour &&
      this.attemptsAt.length < this.c.maxPerDay
    );
  }

  private async readEntry(name: string): Promise<Read> {
    let fh;
    try {
      fh = await open(
        join(this.c.queueDir, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code === 'ENOENT') return { ok: 'skip' };
      // O_NOFOLLOW on a symlink: a content/shape fault, refused.
      if (code === 'ELOOP') return { ok: false, reason: 'not_file' };
      return { ok: 'unreadable', code: errnoClass(e) };
    }
    try {
      let st;
      try {
        st = await fh.stat();
      } catch (e) {
        return { ok: 'unreadable', code: errnoClass(e) };
      }
      if (st.isDirectory()) return { ok: 'dir' };
      if (!st.isFile()) return { ok: false, reason: 'not_file' };
      // The writer links the final name before removing its temporary one: not ready yet.
      if (st.nlink !== 1) return { ok: 'skip' };
      if ((st.mode & 0o027) !== 0) return { ok: false, reason: 'unsafe_mode' };
      if (this.c.queueUid !== undefined && st.uid !== this.c.queueUid)
        return { ok: false, reason: 'bad_owner' };
      if (st.size > QUEUE_MAX_BYTES) return { ok: false, reason: 'too_large' };
      const buf = Buffer.alloc(QUEUE_MAX_BYTES + 1);
      let bytesRead: number;
      try {
        ({ bytesRead } = await fh.read(buf, 0, buf.length, 0));
      } catch (e) {
        return { ok: 'unreadable', code: errnoClass(e) };
      }
      if (bytesRead > QUEUE_MAX_BYTES) return { ok: false, reason: 'too_large' };
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead));
      } catch {
        return { ok: false, reason: 'bad_encoding' };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, reason: 'bad_json' };
      }
      return parseQueueItem(raw);
    } finally {
      await fh.close();
    }
  }

  private async reject(name: string, key: string | null, reason: string, now: number) {
    await this.unlinkEntry(name);
    if (key && QUEUE_KEY_RE.test(key)) {
      await this.writeLedgerLogged({
        v: 1,
        key,
        status: 'dead',
        attempts: 0,
        firstAttemptAt: null,
        lastAttemptAt: null,
        nextAt: null,
        lastError: `rejected_${reason}`,
        updatedAt: now,
      });
      this.log(`rejected ${key} (${reason})`);
    } else {
      // The name itself is untrusted: never logged.
      this.log(`rejected an entry with an invalid name (${reason})`);
    }
  }

  private async giveUp(
    name: string,
    key: string,
    prev: Pick<Ledger, 'attempts' | 'firstAttemptAt' | 'lastAttemptAt'> | null,
    code: string,
    now: number,
  ) {
    await this.writeLedgerLogged({
      v: 1,
      key,
      status: 'dead',
      attempts: prev?.attempts ?? 0,
      firstAttemptAt: prev?.firstAttemptAt ?? null,
      lastAttemptAt: prev?.lastAttemptAt ?? null,
      nextAt: null,
      lastError: code,
      updatedAt: now,
    });
    await this.unlinkEntry(name);
    this.log(`dead ${key} (${code})`);
  }

  private async unlinkEntry(name: string): Promise<void> {
    await unlink(join(this.c.queueDir, name)).catch((e: unknown) => {
      if ((e as { code?: unknown }).code !== 'ENOENT')
        this.log(`could not remove a queue entry (${errorClass(e)})`);
    });
  }

  private async removeStaleTmp(names: string[], now: number): Promise<void> {
    for (const n of names) {
      const p = join(this.c.queueDir, n);
      const st = await lstat(p).catch(() => null);
      if (st && st.mtimeMs < now - TMP_STALE_MS) await unlink(p).catch(() => undefined);
    }
  }

  private async readLedger(key: string): Promise<Ledger | null | 'corrupt'> {
    let text: string;
    try {
      text = await readFile(join(this.c.statusDir, `${key}.json`), 'utf8');
    } catch (e) {
      return (e as { code?: unknown }).code === 'ENOENT' ? null : 'corrupt';
    }
    try {
      const l = JSON.parse(text) as Ledger;
      if (
        l?.v !== 1 ||
        l.key !== key ||
        !STATUSES.includes(l.status) ||
        !Number.isInteger(l.attempts) ||
        l.attempts < 0
      )
        return 'corrupt';
      return l;
    } catch {
      return 'corrupt';
    }
  }

  /** Atomic: exclusive temporary file (0640), fsync, rename over the ledger. */
  private async writeLedger(l: Ledger): Promise<void> {
    const final = join(this.c.statusDir, `${l.key}.json`);
    const tmp = join(this.c.statusDir, `.${l.key}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o640);
    try {
      try {
        await fh.chmod(0o640);
        await fh.writeFile(JSON.stringify(l), 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, final);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  private async writeLedgerLogged(l: Ledger): Promise<boolean> {
    try {
      await this.writeLedger(l);
      return true;
    } catch (e) {
      this.log(`ledger write failed for ${l.key} (${errorClass(e)})`);
      return false;
    }
  }
}
