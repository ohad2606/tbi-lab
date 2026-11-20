/**
 * TBI-022: the pending sign-up store. One JSON file per request in a private directory
 * (dir 0700, files 0600, owned by the process user), written atomically (exclusive temp file,
 * fsync, rename). A directory that is readable by group/other is refused, not repaired.
 * Personal data (name, address, role) lives only here until the request is purged; the account
 * itself lives in the helper's registry once approved.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { newRequestId, REQUEST_ID_RE } from '../common.js';
import type { SignupInput } from './validate.js';

export const STATUSES = ['pending', 'approved', 'rejected', 'email_sent', 'email_failed'] as const;
export type SignupStatus = (typeof STATUSES)[number];

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
  /** Error class only (never a response body or address). */
  lastError: string | null;
  notified: boolean;
}

export interface Retention {
  /** Rejected requests are deleted after this long. */
  rejectedMs: number;
  /** Requests never decided are deleted after this long. */
  pendingMs: number;
  /** Finished requests (email sent) are deleted after this long: the account is in the registry. */
  doneMs: number;
}
export const DEFAULT_RETENTION: Retention = {
  rejectedMs: 30 * 86_400_000,
  pendingMs: 60 * 86_400_000,
  doneMs: 90 * 86_400_000,
};

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

  async create(input: SignupInput): Promise<SignupRecord> {
    const max = this.opts.maxRecords;
    if (max !== undefined && (await this.list()).length >= max) throw new StoreError('full');
    const at = new Date(this.now()).toISOString();
    const rec: SignupRecord = {
      v: 1,
      id: newRequestId(this.now()),
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      accountAdded: false,
      emailAttemptedAt: null,
      emailAttempts: 0,
      lastError: null,
      notified: false,
      ...input,
    };
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

  /** Deletes records past their retention (by last update); returns the ids removed. */
  async purge(retention: Retention = DEFAULT_RETENTION): Promise<string[]> {
    const t = this.now();
    const removed: string[] = [];
    for (const r of await this.list()) {
      const age = t - Date.parse(r.updatedAt);
      const limit =
        r.status === 'rejected'
          ? retention.rejectedMs
          : r.status === 'pending'
            ? retention.pendingMs
            : r.status === 'email_sent'
              ? retention.doneMs
              : Infinity; // approved / email_failed need the owner's attention, never auto-deleted
      if (age > limit) {
        await unlink(this.path(r.id)).catch(() => undefined);
        removed.push(r.id);
      }
    }
    // Orphaned temp files from a crash.
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith('.tmp')) continue;
      const s = await stat(join(this.dir, f)).catch(() => null);
      if (s && t - s.mtimeMs > 3600_000) await unlink(join(this.dir, f)).catch(() => undefined);
    }
    return removed;
  }
}
