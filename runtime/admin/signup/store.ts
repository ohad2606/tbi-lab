/**
 * TBI-022: the pending sign-up store. One JSON file per request in a private directory
 * (dir 0700, files 0600, owned by the process user), written atomically (exclusive temp file,
 * fsync, rename). A directory that is readable by group/other is refused, not repaired.
 * Personal data (name, address, role) lives only here until the request is purged; the account
 * itself lives in the helper's registry once approved.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { newRequestId, REQUEST_ID_RE } from '../common.js';
import { serialById } from './locks.js';
import type { SignupInput } from './validate.js';

export const STATUSES = [
  'pending',
  'approved',
  'rejected',
  'email_queued',
  'email_sent',
  'email_failed',
] as const;
export type SignupStatus = (typeof STATUSES)[number];

/**
 * Requests that still need the owner or are still in flight: undecided, approved with the
 * account step or the email not finished, the email scheduled by quiet hours, or the email
 * failed (Resend). The admin UI lists exactly these (`GET /signups/open`).
 */
export const OPEN_STATUSES: readonly SignupStatus[] = [
  'pending',
  'approved',
  'email_queued',
  'email_failed',
];

export interface SignupRecord extends SignupInput {
  v: 1;
  id: string;
  status: SignupStatus;
  createdAt: string;
  updatedAt: string;
  /** The account was added through the existing account path (idempotent flag). */
  accountAdded: boolean;
  /** Set before a send is attempted: a crash mid-send never causes an automatic second email. */
  emailAttemptedAt: string | null;
  emailAttempts: number;
  /** While status is `email_queued`: ISO time from which the approval email may be sent (quiet hours). */
  emailSendAfter: string | null;
  /** Error class only (never a response body or address). */
  lastError: string | null;
  /** Derived on read from the `<id>.notified` marker (written by the intake, never a record rewrite). */
  notified: boolean;
  /** Derived on read from the `<id>.notifyq` marker: the alert was deferred by quiet hours and is not sent yet. */
  notifyPending: boolean;
  /**
   * BETA-G1: set (ISO time) when the auto-approve sweep claimed this request against the daily
   * cap. Absent on every record while auto-approve is off (records are then unchanged).
   */
  autoApprovedAt?: string;
  /**
   * BETA-G1: `'owner'` when the owner's own approver added the account (e.g. after a failed
   * automatic attempt). Display only: the row is shown as approved automatically only without
   * it. Never read for a decision (pause hold, cap, cut-off, eligibility); the record is
   * intake-writable, so a forged value changes the label only. Additive, no schema bump.
   */
  approvedBy?: 'owner';
  /**
   * BETA-G1 s8: `'web'` on a request that came through the browser route (`POST /signup/web`);
   * absent on every `/signup` (Apps Script) request. Additive, no schema bump (`v` stays 1).
   * Counted against the web sub-cap (`maxWebRecords`, via the `<id>.web` marker) and excluded
   * from auto-approval by default (autoApprove.ts).
   */
  origin?: 'web';
  /**
   * G1-AUTO-VERIFY: display mirrors written by the admin (verify mail sent / address confirmed).
   * Absent while email verification is off. Never trusted for a decision: the admin-only verify
   * state (verifyState.ts) is the source.
   */
  verifySentAt?: string;
  verifiedAt?: string;
}

/** G1-AUTO-VERIFY: a confirm marker dropped by the intake (`<id>.vq-<sha256(token)[0:16]>`). */
export const VERIFY_MARKER_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.vq-([0-9a-f]{16})$/;
/** G1-AUTO-VERIFY slice 2: a resend request dropped by the intake (`<id>.rq`, empty, one per id). */
export const RESEND_MARKER_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.rq$/;
/** At most this many confirm markers per request (counted under the store mutex). */
export const VERIFY_MARKERS_PER_ID = 3;
const VQ_SUFFIX_RE = /^[0-9a-f]{16}$/;

/** Outcome class of an intake marker write (logged as a class only; the answer never depends on it). */
export type MarkerOutcome = 'written' | 'exists' | 'skip' | 'limit';

/**
 * Retention (owner directive 2026-11-21, matching the notice published in the sign-up form):
 * a request that was not approved (`pending`, `rejected`) is deleted within `notApprovedMs` of
 * its creation; every other request (approved, email queued / failed / sent) is deleted at the
 * latest `maxMs` after its creation. Both are absolute, counted from `createdAt`: an update
 * (a retry, a cap refusal) never extends them.
 */
export interface Retention {
  notApprovedMs: number;
  maxMs: number;
}
const DAY_MS = 86_400_000;
export const DEFAULT_RETENTION: Retention = {
  notApprovedMs: 90 * DAY_MS,
  maxMs: 365 * DAY_MS,
};
/** Upper bound of both settings: the published notice says "up to 12 months". */
export const RETENTION_MAX_DAYS = 365;

/**
 * `TBI_SIGNUP_RETENTION_PENDING_DAYS` (not approved, default 90) and
 * `TBI_SIGNUP_RETENTION_MAX_DAYS` (everything, default 365): whole days 1..365, the first not
 * larger than the second. A set but invalid value throws (the caller refuses the feature).
 */
export function retentionFromEnv(env: NodeJS.ProcessEnv): Retention {
  const days = (name: string, dflt: number): number => {
    const v = env[name];
    if (v === undefined || v === '') return dflt * DAY_MS;
    if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > RETENTION_MAX_DAYS)
      throw new Error(`${name} must be a whole number of days from 1 to ${RETENTION_MAX_DAYS}`);
    return Number(v) * DAY_MS;
  };
  const notApprovedMs = days(
    'TBI_SIGNUP_RETENTION_PENDING_DAYS',
    DEFAULT_RETENTION.notApprovedMs / DAY_MS,
  );
  const maxMs = days('TBI_SIGNUP_RETENTION_MAX_DAYS', DEFAULT_RETENTION.maxMs / DAY_MS);
  if (notApprovedMs > maxMs)
    throw new Error(
      'TBI_SIGNUP_RETENTION_PENDING_DAYS must not exceed TBI_SIGNUP_RETENTION_MAX_DAYS',
    );
  return { notApprovedMs, maxMs };
}

/** K12: the result of `PendingStore.deleteNow`. */
export type DeleteOutcome = 'deleted' | 'already_deleted' | 'not_found' | 'incomplete';

/**
 * `not_found`: no such record (ENOENT / ENOTDIR, or a malformed id). `unreadable`: the record
 * file exists but could not be read (EACCES, EIO, ...): never "gone", so callers keep every
 * marker, claim and verify state of it.
 */
export class StoreError extends Error {
  constructor(readonly code: 'unsafe_dir' | 'not_found' | 'unreadable' | 'corrupt' | 'full') {
    super(code);
  }
}

const errCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** Whether an error from `PendingStore.get` means the record is absent (or unusable garbage). */
const goneOrCorrupt = (e: unknown): boolean =>
  e instanceof StoreError && (e.code === 'not_found' || e.code === 'corrupt');

export class PendingStore {
  constructor(
    private readonly dir: string,
    private readonly opts: {
      now?: () => number;
      maxRecords?: number;
      /**
       * BETA-G1 s8: at most this many web-origin records in the store at once (a sub-cap of
       * `maxRecords`), so the browser route can never fill the store shared with `/signup`.
       */
      maxWebRecords?: number;
      /**
       * G1-AUTO-VERIFY: called under the per-id lock after a record was deleted (owner delete or
       * purge), to remove the admin's verify state for it. Errors are ignored here (the verify
       * sweep also removes orphan state).
       */
      onRemoved?: (id: string) => Promise<void>;
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Creates the directory (0700) when missing; refuses one that others can read or write. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const s = await stat(this.dir);
    if (!s.isDirectory() || (s.mode & 0o077) !== 0) throw new StoreError('unsafe_dir');
  }

  private path(id: string): string {
    if (!REQUEST_ID_RE.test(id)) throw new StoreError('not_found');
    return join(this.dir, `${id}.json`);
  }

  private async write(id: string, rec: SignupRecord, exclusive: boolean): Promise<void> {
    const tmp = join(this.dir, `${id}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      try {
        await fh.chmod(0o600);
        await fh.writeFile(`${JSON.stringify(rec)}\n`, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (exclusive) {
        // A fresh id never collides in practice; refuse rather than overwrite if it does.
        if (
          await stat(this.path(id)).then(
            () => true,
            () => false,
          )
        )
          throw new Error('exists');
      }
      await rename(tmp, this.path(id));
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  private markPath(email: string): string {
    return join(this.dir, `${createHash('sha256').update(email).digest('hex')}.mark`);
  }

  private chain: Promise<unknown> = Promise.resolve();
  /** In-process mutex for intake (the marker file is the cross-process guard). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Number of record files, and of those with a `<id>.web` marker (web origin), without reading
   * them. A marker without its record (a crash between the two writes) is not counted.
   */
  private async count(): Promise<{ all: number; web: number }> {
    const files = await readdir(this.dir);
    const ids = new Set<string>();
    for (const f of files) {
      const m = /^([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(f);
      if (m) ids.add(m[1]!);
    }
    let web = 0;
    for (const f of files) {
      const m = /^([0-9A-HJKMNP-TV-Z]{26})\.web$/.exec(f);
      if (m && ids.has(m[1]!)) web++;
    }
    return { all: ids.size, web };
  }

  /** A web, pending, not (mirror-)verified record, else null; never throws for a missing one. */
  private async markerTarget(id: string): Promise<SignupRecord | null> {
    if (!REQUEST_ID_RE.test(id)) return null;
    const r = await this.getOrNull(id);
    return r && r.origin === 'web' && r.status === 'pending' && !r.verifiedAt ? r : null;
  }

  /** Empty file, exclusive, 0600; EEXIST counts as success. Names only from fixed patterns. */
  private async touchMarker(name: string): Promise<MarkerOutcome> {
    try {
      const fh = await open(join(this.dir, name), 'wx', 0o600);
      await fh.close();
      return 'written';
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') return 'exists';
      throw e;
    }
  }

  /**
   * G1-AUTO-VERIFY slice 2 (intake): `<id>.vq-<suffix>`, zero bytes, only for an existing web
   * pending unverified record, at most VERIFY_MARKERS_PER_ID per id (counted under the mutex).
   */
  writeVerifyMarker(id: string, suffix: string): Promise<MarkerOutcome> {
    if (!REQUEST_ID_RE.test(id) || !VQ_SUFFIX_RE.test(suffix)) return Promise.resolve('skip');
    return this.exclusive(async () => {
      if (!(await this.markerTarget(id))) return 'skip';
      const name = `${id}.vq-${suffix}`;
      let n = 0;
      for (const f of await readdir(this.dir)) {
        if (f === name) return 'exists';
        const m = VERIFY_MARKER_RE.exec(f);
        if (m && m[1] === id) n++;
      }
      if (n >= VERIFY_MARKERS_PER_ID) return 'limit';
      return this.touchMarker(name);
    });
  }

  /** `<id>.rq` for an existing web pending unverified record (empty, one per id). */
  writeResendMarker(id: string): Promise<MarkerOutcome> {
    if (!REQUEST_ID_RE.test(id)) return Promise.resolve('skip');
    return this.exclusive(async () => {
      if (!(await this.markerTarget(id))) return 'skip';
      return this.touchMarker(`${id}.rq`);
    });
  }

  /** Resend by address: the address marker's holder (sha256 key), then as `writeResendMarker`. */
  async writeResendMarkerFor(email: string): Promise<MarkerOutcome> {
    const holder = (await readFile(this.markPath(email), 'utf8').catch(() => '')).trim();
    return REQUEST_ID_RE.test(holder) ? this.writeResendMarker(holder) : 'skip';
  }

  private webMarkPath(id: string): string {
    return join(this.dir, `${this.idOnly(id)}.web`);
  }

  /**
   * Create unless the address already has a live (non-rejected) request. The address is keyed by
   * sha256 in `<hash>.mark` (created exclusively, holds the record id), so concurrent posts, in
   * this process (mutex) or another one (O_EXCL), yield exactly one record. A marker whose record
   * is gone or rejected is stale and is taken over.
   *
   * BETA-G1 s8, `origin: 'web'`: the record carries `origin: 'web'` and a `<id>.web` marker
   * (written before the record, so a stored web record is always counted). The caps are checked
   * BEFORE the dedupe for web: at the web sub-cap a known and an unknown address both get `full`
   * (no address oracle for the unauthenticated route).
   */
  createIfNew(
    input: SignupInput,
    o: { origin?: 'web' } = {},
  ): Promise<{ created: boolean; record: SignupRecord }> {
    return this.exclusive(async () => {
      const web = o.origin === 'web';
      const max = this.opts.maxRecords;
      const maxWeb = this.opts.maxWebRecords;
      const capped = async (): Promise<boolean> => {
        if (max === undefined && (!web || maxWeb === undefined)) return false;
        const n = await this.count();
        return (
          (max !== undefined && n.all >= max) || (web && maxWeb !== undefined && n.web >= maxWeb)
        );
      };
      if (web && (await capped())) throw new StoreError('full');
      const mark = this.markPath(input.email);
      const claim = async (id: string): Promise<boolean> => {
        try {
          await writeFile(mark, `${id}\n`, { flag: 'wx', mode: 0o600 });
          return true;
        } catch (e) {
          if ((e as { code?: string }).code === 'EEXIST') return false;
          throw e;
        }
      };
      // Dedupe first: at the cap a repeat of a live request is still answered (not 'full').
      const existing = (await readFile(mark, 'utf8').catch(() => '')).trim();
      if (REQUEST_ID_RE.test(existing)) {
        const cur = await this.getOrNull(existing);
        if (cur && cur.status !== 'rejected') return { created: false, record: cur };
      }
      if (!web && (await capped())) throw new StoreError('full');
      const rec = this.build(input);
      if (web) rec.origin = 'web';
      if (!(await claim(rec.id))) {
        const holder = (await readFile(mark, 'utf8').catch(() => '')).trim();
        const cur = REQUEST_ID_RE.test(holder) ? await this.getOrNull(holder) : null;
        if (cur && cur.status !== 'rejected') return { created: false, record: cur };
        await unlink(mark).catch(() => undefined); // stale: take over
        if (!(await claim(rec.id))) throw new StoreError('corrupt');
      }
      try {
        if (web) await writeFile(this.webMarkPath(rec.id), '', { flag: 'wx', mode: 0o600 });
        await this.write(rec.id, rec, true);
      } catch (e) {
        if (web) await unlink(this.webMarkPath(rec.id)).catch(() => undefined);
        await unlink(mark).catch(() => undefined);
        throw e;
      }
      return { created: true, record: rec };
    });
  }

  /** Intake-only marker; the record file is not rewritten, so an owner update cannot be lost. */
  async markNotified(id: string): Promise<void> {
    await writeFile(join(this.dir, `${this.idOnly(id)}.notified`), '', { mode: 0o600 });
  }

  /** Intake-only: the owner alert is deferred (quiet hours); the intake's drain sends it later. */
  async markNotifyPending(id: string): Promise<void> {
    await writeFile(join(this.dir, `${this.idOnly(id)}.notifyq`), '', { mode: 0o600 });
  }

  /** Removes the deferral marker (claim before a send: at most one attempt per record). */
  async clearNotifyPending(id: string): Promise<void> {
    await unlink(join(this.dir, `${this.idOnly(id)}.notifyq`)).catch(() => undefined);
  }

  private idOnly(id: string): string {
    if (!REQUEST_ID_RE.test(id)) throw new StoreError('not_found');
    return id;
  }

  /**
   * Append-only audit line: time, id, action, outcome class, and (BETA-G1, only when given) a
   * fixed actor tag such as `actor=auto`. No personal data.
   */
  async audit(id: string, action: string, outcome: string, actor?: 'auto'): Promise<void> {
    const tag = actor ? ` actor=${actor}` : '';
    const line = `${new Date(this.now()).toISOString()} ${this.idOnly(id)} ${action} ${outcome}${tag}\n`;
    await appendFile(join(this.dir, 'audit.log'), line, { mode: 0o600 });
  }

  private build(input: SignupInput): SignupRecord {
    const at = new Date(this.now()).toISOString();
    return {
      v: 1,
      id: newRequestId(this.now()),
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      accountAdded: false,
      emailAttemptedAt: null,
      emailAttempts: 0,
      emailSendAfter: null,
      lastError: null,
      notified: false,
      notifyPending: false,
      ...input,
    };
  }

  async create(input: SignupInput): Promise<SignupRecord> {
    const max = this.opts.maxRecords;
    if (max !== undefined && (await this.list()).length >= max) throw new StoreError('full');
    const rec = this.build(input);
    await this.write(rec.id, rec, true);
    return rec;
  }

  async get(id: string): Promise<SignupRecord> {
    let text: string;
    try {
      text = await readFile(this.path(id), 'utf8');
    } catch (e) {
      if (e instanceof StoreError) throw e;
      const code = errCode(e);
      throw new StoreError(code === 'ENOENT' || code === 'ENOTDIR' ? 'not_found' : 'unreadable');
    }
    try {
      const r = JSON.parse(text) as SignupRecord;
      if (r.v !== 1 || r.id !== id || !STATUSES.includes(r.status)) throw new Error('shape');
      r.notified = await stat(join(this.dir, `${id}.notified`)).then(
        () => true,
        () => false,
      );
      r.emailSendAfter = r.emailSendAfter ?? null;
      r.notifyPending = await stat(join(this.dir, `${id}.notifyq`)).then(
        () => true,
        () => false,
      );
      return r;
    } catch {
      throw new StoreError('corrupt');
    }
  }

  /** The record, or null when it is absent or corrupt; an unreadable record throws. */
  private getOrNull(id: string): Promise<SignupRecord | null> {
    return this.get(id).catch((e: unknown) => {
      if (goneOrCorrupt(e)) return null;
      throw e;
    });
  }

  /** Read-modify-write of one record. Callers serialise per id (see SignupService). */
  async update(
    id: string,
    patch: Partial<Omit<SignupRecord, 'v' | 'id' | 'createdAt'>>,
  ): Promise<SignupRecord> {
    const cur = await this.get(id);
    const next: SignupRecord = { ...cur, ...patch, updatedAt: new Date(this.now()).toISOString() };
    await this.write(id, next, false);
    return next;
  }

  /** All readable records, oldest first; corrupt files are skipped (and left for the operator). */
  async list(): Promise<SignupRecord[]> {
    const out: SignupRecord[] = [];
    for (const f of await readdir(this.dir)) {
      const m = /^([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(f);
      if (!m) continue;
      try {
        out.push(await this.get(m[1]!));
      } catch {
        /* skipped */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * K12: the owner deletes one request now (a person asked to be forgotten), whatever its status.
   * Under the per-id lock shared with the approver and the purge, it removes the `<id>.notified`,
   * `<id>.notifyq` and `<id>.web` (web sub-cap) markers, the address marker (`<sha256>.mark`, the de-duplication lock)
   * that points to this id, any `<id>.*.tmp` left by a crash, the record `<id>.json`, and then
   * the admin verify state (`onRemoved`). Only when every step succeeded is one audit line
   * `<time> <id> delete ok` written (no personal data). A record file that cannot be parsed is
   * deleted too.
   *
   *   deleted          every file and the verify state are gone (audited `delete ok`)
   *   already_deleted  no record, but the audit log shows an earlier `delete ok` for this id: no-op
   *   not_found        no record and no earlier delete (unknown id, or removed by retention)
   *   incomplete       a step failed (EPERM, an unreadable address marker, the verify state...):
   *                    audited `delete incomplete`, never `ok`; a retry finishes the job (it
   *                    answers `deleted` once the rest is gone)
   *
   * An account already added for the request is NOT touched (accounts.ts: disable).
   */
  deleteNow(id: string): Promise<DeleteOutcome> {
    if (!REQUEST_ID_RE.test(id)) return Promise.resolve('not_found');
    return serialById(id, async () => {
      try {
        const existed = await stat(this.path(id)).then(
          () => true,
          (e: unknown) => {
            if (errCode(e) === 'ENOENT') return false;
            throw e;
          },
        );
        await this.removeSideFiles(id);
        await this.unlinkGone(`${id}.web`);
        if (existed) await this.unlinkGone(`${id}.json`);
        // Idempotent; also on a retry whose record is already gone.
        await this.opts.onRemoved?.(id);
        if (!existed) {
          if (await this.auditHas(id, 'delete', 'ok')) return 'already_deleted';
          // An earlier attempt removed the record but not the rest: this retry finished it.
          if (!(await this.auditHas(id, 'delete', 'incomplete'))) return 'not_found';
        }
        await this.audit(id, 'delete', 'ok');
        return 'deleted';
      } catch {
        await this.audit(id, 'delete', 'incomplete').catch(() => undefined);
        return 'incomplete';
      }
    });
  }

  /** Unlink one file of the store dir; only ENOENT counts as already gone. */
  private async unlinkGone(name: string): Promise<void> {
    try {
      await unlink(join(this.dir, name));
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
  }

  /**
   * Every file of `id` but the record and `.web` (the caller holds the per-id lock): `.notified`,
   * `.notifyq`, `.rq`, every `.vq-*`, `<id>.*.tmp`, and the address marker this id holds. The
   * caller removes `.web` after this, just before the record (the unverified purge selects on it).
   * Throws on any failure (the caller keeps the record and retries): only an intake-made name
   * (`.vq-*`, `.rq`) may be a directory (EISDIR, left alone); an address marker that cannot be
   * read is a failure, never "someone else's".
   */
  private async removeSideFiles(id: string): Promise<void> {
    await this.unlinkGone(`${id}.notified`);
    await this.unlinkGone(`${id}.notifyq`);
    for (const f of await readdir(this.dir)) {
      if (f.startsWith(`${id}.vq-`) || f === `${id}.rq`)
        await this.unlinkGone(f).catch((e: unknown) => {
          if (errCode(e) !== 'EISDIR') throw e;
        });
      else if (f.startsWith(`${id}.`) && f.endsWith('.tmp')) await this.unlinkGone(f);
      else if (/^[0-9a-f]{64}\.mark$/.test(f)) {
        let holder: string;
        try {
          holder = (await readFile(join(this.dir, f), 'utf8')).trim();
        } catch (e) {
          if (errCode(e) === 'ENOENT') continue;
          throw e;
        }
        if (holder === id) await this.unlinkGone(f);
      }
    }
  }

  /**
   * S4a unverified purge: under the per-id lock, re-reads the record; only a web record (origin
   * `web` AND its `<id>.web` marker) for which `judge` still says yes is removed: side files,
   * then `beforeRecord` (the admin verify state), then the `.web` marker, then LAST the record, so
   * a failure part-way is finished by the next run. Returns whether removed.
   */
  purgeIf(
    id: string,
    judge: (r: SignupRecord) => Promise<boolean>,
    beforeRecord: () => Promise<void>,
  ): Promise<boolean> {
    if (!REQUEST_ID_RE.test(id)) return Promise.resolve(false);
    return serialById(id, async () => {
      // Absent, corrupt or unreadable: nothing is removed here.
      const cur = await this.get(id).catch(() => null);
      if (!cur || cur.origin !== 'web') return false;
      const web = await stat(join(this.dir, `${id}.web`)).then(
        (s) => (s.isFile() ? 'file' : 'other'),
        (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? 'gone' : 'other'),
      );
      // BETA-G1 fix 5: a crash between the `.web` unlink and the record unlink leaves the record
      // without its marker. Such a record is finished only while it still looks unconfirmed and
      // untouched: `pending`, no `verifiedAt` mirror, no account; `judge` re-checks the admin
      // state as for any candidate. Anything but ENOENT on the marker keeps the record.
      const orphan =
        web === 'gone' &&
        cur.status === 'pending' &&
        !cur.verifiedAt &&
        !cur.accountAdded &&
        !cur.autoApprovedAt;
      if ((web !== 'file' && !orphan) || !(await judge(cur))) return false;
      await this.removeSideFiles(id);
      await beforeRecord();
      await unlink(join(this.dir, `${id}.web`)).catch((e: NodeJS.ErrnoException) => {
        if (!orphan || e.code !== 'ENOENT') throw e;
      });
      await unlink(this.path(id));
      return true;
    });
  }

  /** Purge only: the record is gone; a failure is counted (`purgeIncomplete`), never silent. */
  private async removed(id: string): Promise<void> {
    await this.opts.onRemoved?.(id).catch(() => {
      this.purgeIncomplete++;
    });
  }

  /** Whether the audit log has a line `<time> <id> <action> <outcome>[ actor=...]`. */
  private async auditHas(id: string, action: string, outcome: string): Promise<boolean> {
    const text = await readFile(join(this.dir, 'audit.log'), 'utf8').catch(() => '');
    const needle = ` ${id} ${action} ${outcome}`;
    return text.split('\n').some((l) => {
      const i = l.indexOf(needle);
      return i > 0 && !l.slice(0, i).includes(' ') && /^(\s|$)/.test(l.slice(i + needle.length));
    });
  }

  /**
   * Deletes records past their retention (see `Retention`, counted from `createdAt`); returns the
   * ids removed. `horizonMs` is the time until the next purge run: a record whose deadline falls
   * before that run is deleted now, so "within N days" holds although the purge is periodic.
   * Each candidate is re-read and re-judged under the per-id lock shared with the approver
   * (locks.ts), so a record approved, rejected or resent meanwhile is judged by its new status.
   * A record whose creation time cannot be read is deleted (it can never be shown to meet a limit).
   */
  /** Unparseable record files removed by the last purge run. */
  corruptPurged = 0;
  /**
   * Requests of the last purge run whose removal failed (the record could not be unlinked: kept,
   * with its verify state, for the next run; or its verify state could not be removed). The
   * caller logs the count; the next run retries.
   */
  purgeIncomplete = 0;

  async purge(retention: Retention = DEFAULT_RETENTION, horizonMs = 0): Promise<string[]> {
    const t = this.now();
    const expired = (r: SignupRecord): boolean => {
      const limit =
        r.status === 'pending' || r.status === 'rejected'
          ? Math.min(retention.notApprovedMs, retention.maxMs)
          : retention.maxMs;
      const created = Date.parse(r.createdAt);
      if (!Number.isFinite(created)) return true;
      return t + horizonMs - created >= limit;
    };
    const removed: string[] = [];
    this.purgeIncomplete = 0;
    /** The record first, strictly: a failure keeps everything else for the next run. */
    const dropRecord = async (id: string): Promise<boolean> => {
      try {
        await this.unlinkGone(`${id}.json`);
        return true;
      } catch {
        this.purgeIncomplete++;
        return false;
      }
    };
    for (const candidate of await this.list()) {
      if (!expired(candidate)) continue;
      const id = candidate.id;
      const gone = await serialById(id, async () => {
        const cur = await this.get(id).catch(() => null);
        if (!cur || !expired(cur)) return false;
        if (!(await dropRecord(id))) return false;
        await unlink(join(this.dir, `${id}.notified`)).catch(() => undefined);
        await unlink(join(this.dir, `${id}.notifyq`)).catch(() => undefined);
        await unlink(join(this.dir, `${id}.web`)).catch(() => undefined);
        await unlink(join(this.dir, `${id}.rq`)).catch(() => undefined);
        await this.removed(id);
        return true;
      });
      if (gone) removed.push(id);
    }
    // Unparseable `<ULID>.json` files can never be shown to meet a limit and list() skips them:
    // remove those older than the not-approved retention (by file time).
    this.corruptPurged = 0;
    const notApproved = Math.min(retention.notApprovedMs, retention.maxMs);
    for (const f of await readdir(this.dir)) {
      const m = /^([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(f);
      if (!m) continue;
      const id = m[1]!;
      const gone = await serialById(id, async () => {
        const ok = await this.get(id).then(
          () => true,
          (e: unknown) => !(e instanceof StoreError && e.code === 'corrupt'),
        );
        if (ok) return false;
        const s = await stat(this.path(id)).catch(() => null);
        if (!s || t + horizonMs - s.mtimeMs < notApproved) return false;
        if (!(await dropRecord(id))) return false;
        await unlink(join(this.dir, `${id}.notified`)).catch(() => undefined);
        await unlink(join(this.dir, `${id}.notifyq`)).catch(() => undefined);
        await unlink(join(this.dir, `${id}.web`)).catch(() => undefined);
        await unlink(join(this.dir, `${id}.rq`)).catch(() => undefined);
        await this.removed(id);
        return true;
      });
      if (gone) this.corruptPurged++;
    }
    // Address markers whose record is gone, and orphaned temp files from a crash.
    for (const f of await readdir(this.dir)) {
      if (f.endsWith('.mark')) {
        const id = (await readFile(join(this.dir, f), 'utf8').catch(() => '')).trim();
        const s = await stat(join(this.dir, f)).catch(() => null);
        const live =
          REQUEST_ID_RE.test(id) &&
          // Unreadable (not absent) keeps its marker.
          (await this.get(id).then(
            () => true,
            (e: unknown) => !goneOrCorrupt(e),
          ));
        if (!live && s && t - s.mtimeMs > 3600_000)
          await unlink(join(this.dir, f)).catch(() => undefined);
        continue;
      }
      // Confirm markers whose record is gone (G1-AUTO-VERIFY): nothing can consume them any more.
      const vq = VERIFY_MARKER_RE.exec(f) ?? RESEND_MARKER_RE.exec(f);
      if (vq) {
        if (
          !(await stat(this.path(vq[1]!)).then(
            () => true,
            (e: unknown) => errCode(e) !== 'ENOENT',
          ))
        )
          await unlink(join(this.dir, f)).catch(() => undefined);
        continue;
      }
      // Web markers whose record is gone (a crash between marker and record); not counted anyway.
      const wm = /^([0-9A-HJKMNP-TV-Z]{26})\.web$/.exec(f);
      if (wm) {
        const gone = await stat(this.path(wm[1]!)).then(
          () => false,
          (e: unknown) => errCode(e) === 'ENOENT',
        );
        const s = await stat(join(this.dir, f)).catch(() => null);
        if (gone && s && t - s.mtimeMs > 3600_000)
          await unlink(join(this.dir, f)).catch(() => undefined);
        continue;
      }
      if (!f.endsWith('.tmp')) continue;
      const s = await stat(join(this.dir, f)).catch(() => null);
      if (s && t - s.mtimeMs > 3600_000) await unlink(join(this.dir, f)).catch(() => undefined);
    }
    return removed;
  }
}
