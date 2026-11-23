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
 *   content fault) is kept and retried next run, and dead-lettered (`stuck_unreadable`) once this
 *   process has seen it unreadable for 24 h and its file is older than 24 h; an entry with an
 *   unreadable ledger likewise (`stuck_ledger`, by the ledger's mtime); a directory with a key name is removed when empty, else left alone. Stuck
 *   entries do not use the listing cap (only handled entries do; at most QUEUE_SCAN_MAX names
 *   are examined per run), and many of them raise one loud warning per run.
 * - The only queue value that reaches the mail body is the recipient's first name, and only as a
 *   plain letters-only token (`greetingName`); anything else gets the generic greeting.
 * - Abuse limits: per run, per hour and per day attempt caps (rebuilt from the ledgers at start,
 *   over-counted, never under-counted);
 *   the queue listing is capped.
 * - Logs carry keys (a random request id) and class codes only: never an address, a name, the
 *   mail text, the key or a path.
 */
import { constants } from 'node:fs';
import { lstat, open, opendir, readdir, rename, rmdir, unlink } from 'node:fs/promises';
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
/**
 * A stuck entry (unreadable file, unreadable ledger) is dead-lettered (`stuck_unreadable` /
 * `stuck_ledger`) once this process has seen it stuck on every run for this long AND its file (or
 * ledger) mtime is older than this. Seen-stuck, not only mtime: a valid old entry (mailer down for
 * days) hit by a transient error must not be lost on first sight. Longer than
 * IDEMPOTENCY_WINDOW_MS, so a stuck entry with an attempt on record could not be retried safely
 * anyway.
 */
export const STUCK_MAX_AGE_MS = 24 * HOUR;
/** At most this many queue names are examined per run (stuck entries do not use QUEUE_MAX_FILES). */
export const QUEUE_SCAN_MAX = 10 * QUEUE_MAX_FILES;
/** One loud warning per run when this many entries are stuck. */
export const STUCK_WARN_THRESHOLD = 50;
/** A ledger is a few hundred bytes; a larger one is unreadable (fail closed). */
export const LEDGER_MAX_BYTES = 4096;
/** The status directory listing is bounded; over it the mailer refuses to start (fail closed). */
export const STATUS_SCAN_MAX = 100_000;

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
  /** Key -> first run (this process) that saw it stuck, on every run since. In memory only. */
  private stuckSince = new Map<string, number>();

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
   * A restart must not reset the hour/day caps. Over-counts, never under-counts: a ledger whose
   * first attempt is inside the last 24 h counts all its attempts (the first at firstAttemptAt, the
   * others approximated at lastAttemptAt); one whose first attempt is older counts attempts - 1 at
   * lastAttemptAt (when that is inside the window). Each ledger counts at most maxPerDay, and only
   * the newest maxPerDay timestamps are kept (they block longest). Idempotent: starts from zero.
   * Ledgers whose mtime is older than 24 h are not parsed (every attempt rewrites the ledger, so its
   * mtime is >= its last attempt); invalid names, non-files and unreadable ledgers are ignored.
   */
  private async restoreRateCounters(): Promise<void> {
    this.attemptsAt.length = 0;
    const now = this.now();
    const from = now - 24 * HOUR;
    const inWindow = (t: unknown): t is number => typeof t === 'number' && t > from && t <= now;
    const cap = Math.max(0, this.c.maxPerDay);
    const keys: string[] = [];
    let listed = 0;
    for await (const d of await opendir(this.c.statusDir)) {
      if (++listed > STATUS_SCAN_MAX) throw new MailerError('status_dir_over_cap');
      if (!d.name.endsWith('.json')) continue;
      const k = d.name.slice(0, -'.json'.length);
      if (QUEUE_KEY_RE.test(k)) keys.push(k);
    }
    for (const k of keys) {
      const st = await lstat(join(this.c.statusDir, `${k}.json`)).catch(() => null);
      if (!st || !st.isFile() || st.mtimeMs <= from) continue;
      const l = await this.readLedger(k);
      if (!l || l === 'corrupt') continue;
      const firstIn = inWindow(l.firstAttemptAt);
      const n = Math.min(cap, firstIn ? l.attempts : Math.max(0, l.attempts - 1));
      for (let i = 0; i < n; i++) {
        const t = i === 0 && firstIn ? l.firstAttemptAt : l.lastAttemptAt;
        // A missing or out-of-window lastAttemptAt for a first-in-window ledger: use the first.
        if (inWindow(t)) this.attemptsAt.push(t);
        else if (firstIn) this.attemptsAt.push(l.firstAttemptAt as number);
      }
    }
    // mayAttempt() expires from the front: keep it oldest first.
    this.attemptsAt.sort((a, b) => a - b);
    if (this.attemptsAt.length > cap) this.attemptsAt.splice(0, this.attemptsAt.length - cap);
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
    if (names.length > QUEUE_SCAN_MAX) {
      this.log(`queue over scan cap (${names.length}); examining the oldest ${QUEUE_SCAN_MAX}`);
      names = names.slice(0, QUEUE_SCAN_MAX);
    }
    if (isQuiet(now, this.c.quiet)) {
      s.deferred = Math.min(names.length, QUEUE_MAX_FILES);
      if (names.length) this.log(`quiet hours: ${names.length} entr(y/ies) waiting`);
      return s;
    }
    let attemptsThisRun = 0;
    const unreadable = new Map<string, number>();
    let dirsRemoved = 0;
    let dirsKept = 0;
    let ledgersCorrupt = 0;
    /** Stuck entries dead-lettered this run: cheap, and not counted against the listing cap. */
    let stuckDead = 0;
    const seenStuck = new Map<string, number>();
    /** Seen stuck since STUCK_MAX_AGE_MS (this process, every run) and the file is that old. */
    const stuckLongEnough = async (key: string, path: string): Promise<boolean> => {
      const since = this.stuckSince.get(key) ?? now;
      seenStuck.set(key, since);
      return now - since >= STUCK_MAX_AGE_MS && (await this.olderThan(path, now));
    };
    let i = 0;
    for (; i < names.length; i++) {
      // The listing cap counts handled entries only: skipped/stuck ones never starve real mail.
      if (s.sent + s.retrying + s.dead + s.rejected + s.dropped - stuckDead >= QUEUE_MAX_FILES) {
        this.log(`queue over cap; ${names.length - i} entr(y/ies) left for the next run`);
        break;
      }
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
        // Fail closed: without a trustworthy record a send could be a duplicate. Once the ledger
        // is older than STUCK_MAX_AGE_MS any attempt on it is outside the idempotency window, so
        // it can never be retried safely: dead-letter it (replaces the unreadable ledger).
        if (await stuckLongEnough(key, join(this.c.statusDir, `${key}.json`))) {
          await this.giveUp(name, key, null, 'stuck_ledger', now);
          seenStuck.delete(key);
          s.dead++;
          stuckDead++;
          continue;
        }
        ledgersCorrupt++;
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
        // Not a content fault: keep it (no ledger) and try again next run; once stuck for
        // STUCK_MAX_AGE_MS it is dead-lettered. It can never be sent without being read, so
        // removing it cannot cause a duplicate.
        if (await stuckLongEnough(key, join(this.c.queueDir, name))) {
          await this.giveUp(name, key, ledger, 'stuck_unreadable', now);
          seenStuck.delete(key);
          s.dead++;
          stuckDead++;
          continue;
        }
        unreadable.set(r.code, (unreadable.get(r.code) ?? 0) + 1);
        s.skipped++;
        continue;
      }
      if (r.ok === 'dir') {
        // Only an empty one is removed: never a recursive delete of writer-controlled content.
        const removed = await rmdir(join(this.c.queueDir, name)).then(
          () => true,
          () => false,
        );
        if (removed) dirsRemoved++;
        else dirsKept++;
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
    // Entries not examined this run (cap or rate limit) keep their stuck-since time; an entry
    // examined and not stuck (or gone) starts again from zero.
    for (const n of names.slice(i)) {
      const k = n.endsWith('.json') ? n.slice(0, -'.json'.length) : n;
      const since = this.stuckSince.get(k);
      if (since !== undefined && !seenStuck.has(k)) seenStuck.set(k, since);
    }
    this.stuckSince = seenStuck;
    // One line per class per run (counts, no names).
    if (unreadable.size)
      this.log(
        `queue entries unreadable (${[...unreadable.keys()].sort().join(', ')}); kept, not sent`,
      );
    if (ledgersCorrupt)
      this.log(`queue entries with an unreadable ledger (${ledgersCorrupt}); kept, not sent`);
    if (dirsRemoved + dirsKept)
      this.log(
        `directory entries in the queue (${dirsRemoved + dirsKept}): ${dirsRemoved} empty removed, ${dirsKept} non-empty kept`,
      );
    const stuck = [...unreadable.values()].reduce((a, b) => a + b, 0) + dirsKept + ledgersCorrupt;
    if (stuck >= STUCK_WARN_THRESHOLD)
      this.log(
        `WARNING: ${stuck} stuck queue entries (unreadable, non-empty directories or unreadable ledgers); operator action needed`,
      );
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

  /** lstat mtime older than STUCK_MAX_AGE_MS (a future mtime is not old). */
  private async olderThan(path: string, now: number): Promise<boolean> {
    const st = await lstat(path).catch(() => null);
    return st !== null && st.mtimeMs < now - STUCK_MAX_AGE_MS;
  }

  private async removeStaleTmp(names: string[], now: number): Promise<void> {
    for (const n of names) {
      const p = join(this.c.queueDir, n);
      const st = await lstat(p).catch(() => null);
      if (st && st.mtimeMs < now - TMP_STALE_MS) await unlink(p).catch(() => undefined);
    }
  }

  private async readLedger(key: string): Promise<Ledger | null | 'corrupt'> {
    // Bounded read, no symlink, regular file only: anything else is unreadable (fail closed).
    let text: string;
    let fh;
    try {
      fh = await open(
        join(this.c.statusDir, `${key}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      return (e as { code?: unknown }).code === 'ENOENT' ? null : 'corrupt';
    }
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > LEDGER_MAX_BYTES) return 'corrupt';
      const buf = Buffer.alloc(LEDGER_MAX_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > LEDGER_MAX_BYTES) return 'corrupt';
      text = buf.subarray(0, bytesRead).toString('utf8');
    } catch {
      return 'corrupt';
    } finally {
      await fh.close();
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
