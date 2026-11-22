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
}

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

export class StoreError extends Error {
  constructor(readonly code: 'unsafe_dir' | 'not_found' | 'corrupt' | 'full') {
    super(code);
  }
}

export class PendingStore {
  constructor(
    private readonly dir: string,
    private readonly opts: { now?: () => number; maxRecords?: number } = {},
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

  /** Number of record files, without reading them. */
  private async count(): Promise<number> {
    return (await readdir(this.dir)).filter((f) => /^[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(f)).length;
  }

  /**
   * Create unless the address already has a live (non-rejected) request. The address is keyed by
   * sha256 in `<hash>.mark` (created exclusively, holds the record id), so concurrent posts, in
   * this process (mutex) or another one (O_EXCL), yield exactly one record. A marker whose record
   * is gone or rejected is stale and is taken over.
   */
  createIfNew(input: SignupInput): Promise<{ created: boolean; record: SignupRecord }> {
    return this.exclusive(async () => {
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
      const max = this.opts.maxRecords;
      if (max !== undefined && (await this.count()) >= max) throw new StoreError('full');
      const rec = this.build(input);
      if (!(await claim(rec.id))) {
        const holder = (await readFile(mark, 'utf8').catch(() => '')).trim();
        const cur = REQUEST_ID_RE.test(holder) ? await this.get(holder).catch(() => null) : null;
        if (cur && cur.status !== 'rejected') return { created: false, record: cur };
        await unlink(mark).catch(() => undefined); // stale: take over
        if (!(await claim(rec.id))) throw new StoreError('corrupt');
      }
      try {
        await this.write(rec.id, rec, true);
      } catch (e) {
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

  /** Append-only audit line: time, id, action, outcome class. No personal data. */
  async audit(id: string, action: string, outcome: string): Promise<void> {
    const line = `${new Date(this.now()).toISOString()} ${this.idOnly(id)} ${action} ${outcome}\n`;
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
      throw new StoreError('not_found');
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
   * Deletes records past their retention (see `Retention`, counted from `createdAt`); returns the
   * ids removed. `horizonMs` is the time until the next purge run: a record whose deadline falls
   * before that run is deleted now, so "within N days" holds although the purge is periodic.
   * Each candidate is re-read and re-judged under the per-id lock shared with the approver
   * (locks.ts), so a record approved, rejected or resent meanwhile is judged by its new status.
   * A record whose creation time cannot be read is deleted (it can never be shown to meet a limit).
   */
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
    for (const candidate of await this.list()) {
      if (!expired(candidate)) continue;
      const id = candidate.id;
      const gone = await serialById(id, async () => {
        const cur = await this.get(id).catch(() => null);
        if (!cur || !expired(cur)) return false;
        await unlink(this.path(id)).catch(() => undefined);
        await unlink(join(this.dir, `${id}.notified`)).catch(() => undefined);
        await unlink(join(this.dir, `${id}.notifyq`)).catch(() => undefined);
        return true;
      });
      if (gone) removed.push(id);
    }
    // Address markers whose record is gone, and orphaned temp files from a crash.
    for (const f of await readdir(this.dir)) {
      if (f.endsWith('.mark')) {
        const id = (await readFile(join(this.dir, f), 'utf8').catch(() => '')).trim();
        const s = await stat(join(this.dir, f)).catch(() => null);
        const live =
          REQUEST_ID_RE.test(id) &&
          (await this.get(id).then(
            () => true,
            () => false,
          ));
        if (!live && s && t - s.mtimeMs > 3600_000)
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
