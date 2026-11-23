/**
 * BETA-G1: automatic approval of validated sign-ups (docs/plans/BETA-G1-AUTO-APPROVE.md). OFF by
 * default: nothing here runs unless the admin service is started with TBI_SIGNUP_AUTO_APPROVE=1
 * and a valid TBI_SIGNUP_AUTO_DAILY_CAP. With the flag absent the sign-up flow is unchanged
 * (no timer, no file written, no record field added).
 *
 * It runs in the ADMIN SERVICE (the only process with the account spool and the mail key), never
 * in the public intake, which keeps its create-only role. A periodic sweep approves pending
 * requests through the SAME `SignupApprover.approve` the owner's Approve button uses (same
 * account path, same idempotency, same quiet-hours mail queue, same audit log; the audit line is
 * marked `actor=auto`).
 *
 *   State dir      `<state>` = TBI_SIGNUP_AUTO_STATE_DIR (default: the store dir). Holds the pause
 *                  file and the state file. It must be a real directory owned by this process's
 *                  uid and not group/world-writable, else auto-approve does not start / stops
 *                  (logged once; manual mode stays). For Alpha it must be an admin-only directory
 *                  the intake user cannot write (deploy item).
 *   Daily cap      at most `dailyCap` requests are CLAIMED for auto-approval per Israel calendar
 *                  day (Asia/Jerusalem, DST-correct via Intl). The count, the ids claimed by this
 *                  service and the cut-off live in `<state>/auto-approve.state.json` (0600, atomic
 *                  write), so they survive a restart. A slot is persisted BEFORE the record is
 *                  touched (a crash can waste a slot, never exceed the cap). Over the cap a request
 *                  simply stays `pending` (the "waitlist"): it is never lost, the owner may approve
 *                  it by hand, and later days' sweeps take it oldest first. An unreadable state
 *                  file, or one dated after today = cap reached (fail closed, logged once per
 *                  sweep, never reset silently).
 *   Cut-off        only requests created after TBI_SIGNUP_AUTO_SINCE (or, unset, after the time
 *                  auto-approve first ran, persisted in the state file) are auto-approved.
 *   Kill switch    while `<state>/auto-approve.paused` exists (any entry: file, dir, symlink, even
 *                  dangling; lstat, never followed) nothing is auto-approved; every check error
 *                  other than ENOENT counts as paused (fail closed). Checked before every claim,
 *                  so `touch` / `rm` takes effect without a restart.
 *   Who is eligible  `pending`, created after the cut-off, not in the claim set and never marked
 *                  (`autoApprovedAt` unset), and without an error from an earlier approve attempt
 *                  (`lastError` null: those need the owner).
 *   Retries        only ids in the admin-owned claim set (never on record fields alone: the intake
 *                  can write records) whose account step answered `account_pending` (status
 *                  `approved`, nothing sent yet). At most one per record per
 *                  AUTO_RETRY_BACKOFF_MS, at most AUTO_RETRIES_PER_SWEEP per sweep, and at most
 *                  `dailyCap` per Israel day; the attempt is persisted before the call.
 *
 * Log lines carry counts, states and error classes only: never an id, name, address or path.
 * Single writer: only one admin service runs the sweep (the in-process mutex below, plus the
 * per-id lock shared with the owner's actions, locks.ts).
 */
import { lstat as lstatAsync, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { errorClass } from './errors.js';
import { serialById } from './locks.js';
import type { SignupApprover } from './service.js';
import type { PendingStore, SignupRecord } from './store.js';

export const AUTO_PAUSE_FILE = 'auto-approve.paused';
/** Day count, retries, claim set and cut-off (admin-owned state). */
export const AUTO_STATE_FILE = 'auto-approve.state.json';
export const AUTO_CAP_MAX = 1000;
export const AUTO_APPROVE_INTERVAL_MS = 60_000;
export const AUTO_TZ = 'Asia/Jerusalem';
/** A claimed record whose helper has not answered is resubmitted at most once per this window. */
export const AUTO_RETRY_BACKOFF_MS = 15 * 60_000;
/** Retries per sweep (the rest wait for the next sweep), so new claims are not starved. */
export const AUTO_RETRIES_PER_SWEEP = 2;

export type AutoApproveConfigResult =
  | { enabled: false; error?: false; reason: string }
  | { enabled: false; error: true; reason: string }
  | { enabled: true; dailyCap: number; stateDir?: string; since?: number };

const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/**
 *   TBI_SIGNUP_AUTO_APPROVE     must be exactly `1` to enable (unset or empty: off, silently)
 *   TBI_SIGNUP_AUTO_DAILY_CAP   required when enabled: whole number 1..1000
 *   TBI_SIGNUP_AUTO_STATE_DIR   optional absolute, normalized path (default: the store dir)
 *   TBI_SIGNUP_AUTO_SINCE       optional ISO time with zone; only newer requests are taken
 * Any other value is an error: auto-approve stays OFF (manual approval keeps working).
 */
export function autoApproveConfigFromEnv(env: NodeJS.ProcessEnv): AutoApproveConfigResult {
  const flag = env.TBI_SIGNUP_AUTO_APPROVE;
  if (flag === undefined || flag === '')
    return { enabled: false, reason: 'TBI_SIGNUP_AUTO_APPROVE is not set (feature off)' };
  const bad = (reason: string): AutoApproveConfigResult => ({
    enabled: false,
    error: true,
    reason,
  });
  if (flag !== '1') return bad('TBI_SIGNUP_AUTO_APPROVE must be 1 or unset');
  const cap = env.TBI_SIGNUP_AUTO_DAILY_CAP;
  if (cap === undefined || !/^\d{1,4}$/.test(cap) || Number(cap) < 1 || Number(cap) > AUTO_CAP_MAX)
    return bad(`TBI_SIGNUP_AUTO_DAILY_CAP must be a whole number from 1 to ${AUTO_CAP_MAX}`);
  const out: { enabled: true; dailyCap: number; stateDir?: string; since?: number } = {
    enabled: true,
    dailyCap: Number(cap),
  };
  const sd = env.TBI_SIGNUP_AUTO_STATE_DIR;
  if (sd !== undefined && sd !== '') {
    if (!isAbsolute(sd) || normalize(sd) !== sd || sd.includes('\0'))
      return bad('TBI_SIGNUP_AUTO_STATE_DIR must be an absolute, normalized path');
    out.stateDir = sd;
  }
  const since = env.TBI_SIGNUP_AUTO_SINCE;
  if (since !== undefined && since !== '') {
    const ms = Date.parse(since);
    if (!ISO_ZONED.test(since) || !Number.isFinite(ms))
      return bad('TBI_SIGNUP_AUTO_SINCE must be an ISO time with a zone (e.g. ...T08:00:00Z)');
    out.since = ms;
  }
  return out;
}

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: AUTO_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Israel calendar day of an instant, `YYYY-MM-DD`. */
export function israelDay(ms: number): string {
  const p: Record<string, string> = {};
  for (const x of dayFmt.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

const ERRNO_NAME = /^E[A-Z0-9]{1,15}$/;
const errnoOf = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && ERRNO_NAME.test(code) ? code : 'unknown';
};

/** One lstat of the pause path: any entry = paused; ENOENT = not; any other error = paused. */
export async function autoPauseCheck(
  path: string,
  stat: (p: string) => Promise<unknown> = lstatAsync,
): Promise<{ paused: boolean; error?: string }> {
  try {
    await stat(path);
    return { paused: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { paused: false };
    return { paused: true, error: errnoOf(e) };
  }
}

/**
 * The state dir must be a real directory (lstat: a symlink is refused), owned by this process's
 * uid, and not group/world-writable. Returns null when safe, else a fixed reason
 * (`not_dir` | `owner` | `mode` | an errno name).
 */
export async function autoStateDirCheck(path: string): Promise<string | null> {
  try {
    const st = await lstatAsync(path);
    if (!st.isDirectory()) return 'not_dir';
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) return 'owner';
    if ((st.mode & 0o022) !== 0) return 'mode';
    return null;
  } catch (e) {
    return errnoOf(e);
  }
}

interface Claim {
  /** When the slot was taken. */
  at: string;
  /** Approve calls made for it (the claim's own call included). */
  attempts: number;
  /** Persisted before each call: the backoff counts from here. */
  lastAttemptAt: string;
  /** The last spool request id the account step submitted (operator diagnosis). */
  spoolId?: string;
}

interface AutoState {
  v: 2;
  day: string;
  count: number;
  /** Retries made on `day` (bounded by the daily cap). */
  retries: number;
  /** Persisted cut-off when TBI_SIGNUP_AUTO_SINCE is unset: the first time a sweep ran. */
  since?: string;
  /** Ids claimed by this service and not finished yet: the only ids ever retried. */
  claims: Record<string, Claim>;
}

class CounterUnreadable extends Error {}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9A-Za-z]{1,64}$/;
const SPOOL_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const isTime = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
const isCount = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;

function validState(c: unknown): c is AutoState {
  const s = c as AutoState | null;
  if (!s || typeof s !== 'object' || s.v !== 2) return false;
  if (typeof s.day !== 'string' || !DAY_RE.test(s.day) || !isCount(s.count) || !isCount(s.retries))
    return false;
  if (s.since !== undefined && !isTime(s.since)) return false;
  if (!s.claims || typeof s.claims !== 'object' || Array.isArray(s.claims)) return false;
  for (const [id, e] of Object.entries(s.claims)) {
    if (!ID_RE.test(id) || !e || typeof e !== 'object') return false;
    if (!isTime(e.at) || !isTime(e.lastAttemptAt) || !isCount(e.attempts)) return false;
    if (e.spoolId !== undefined && (typeof e.spoolId !== 'string' || !SPOOL_ID_RE.test(e.spoolId)))
      return false;
  }
  return true;
}

/** Per state directory: one sweep step / claim at a time in this process. */
const mutexes = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  mutexes.set(key, tail);
  void tail.then(() => {
    if (mutexes.get(key) === tail) mutexes.delete(key);
  });
  return run;
}

export interface AutoApproverDeps {
  /** The admin-owned state dir (pause file + state file); the store dir by default. */
  dir: string;
  store: PendingStore;
  dailyCap: number;
  /** TBI_SIGNUP_AUTO_SINCE (ms); unset: the persisted first-run time. */
  since?: number;
  /**
   * The approver for one sweep (built with the owner's principal as the spool actor, because the
   * root helper accepts account requests from the owner only), or null when the owner principal
   * is not recorded yet: then nothing is auto-approved (manual only, logged once). `onSpoolRequest`
   * is called with the id of each spool request its account step submits.
   */
  approver: (hooks: { onSpoolRequest(id: string): void }) => SignupApprover | null;
  now?: () => number;
  log?: (line: string) => void;
  /** Test hook: replaces lstat for the kill switch. */
  stat?: (p: string) => Promise<unknown>;
}

export interface SweepResult {
  /** Requests claimed (a slot of today's cap was used) in this sweep. */
  claimed: number;
  /** Approve calls made (claims plus retries of earlier claims). */
  attempted: number;
  /** Why the sweep stopped early, if it did. */
  stopped?: 'paused' | 'cap' | 'no_owner' | 'counter_unreadable' | 'busy' | 'state_dir_unsafe';
}

export class AutoApprover {
  private lastPaused = false;
  private readonly seenErrors = new Set<string>();
  private capLoggedDay: string | null = null;
  private retryLoggedDay: string | null = null;
  private unsafeLogged: string | null = null;
  private noOwnerLogged = false;
  private spoolId: string | null = null;

  constructor(private readonly d: AutoApproverDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private log(line: string): void {
    try {
      this.d.log?.(line);
    } catch {
      /* logging never changes the answer */
    }
  }

  private get statePath(): string {
    return join(this.d.dir, AUTO_STATE_FILE);
  }

  /** The state dir check, logged once per distinct reason; null = safe. */
  async checkStateDir(): Promise<string | null> {
    const bad = await autoStateDirCheck(this.d.dir);
    if (bad && this.unsafeLogged !== bad) {
      this.unsafeLogged = bad;
      this.log(`signup: auto-approve state dir unsafe (${bad}); manual only`);
    }
    if (!bad) this.unsafeLogged = null;
    return bad;
  }

  /** Kill switch, with one log line per transition and per distinct error code. */
  async paused(): Promise<boolean> {
    const r = await autoPauseCheck(join(this.d.dir, AUTO_PAUSE_FILE), this.d.stat);
    if (r.error && !this.seenErrors.has(r.error) && this.seenErrors.size < 16) {
      this.seenErrors.add(r.error);
      this.log(`signup: auto-approve pause check failed (${r.error}); treated as paused`);
    }
    if (r.paused !== this.lastPaused) {
      this.lastPaused = r.paused;
      this.log(`signup: auto-approve ${r.paused ? 'paused' : 'resumed'}`);
    }
    return r.paused;
  }

  /**
   * The state as of `day`: empty when the file is missing; count and retries reset when it is
   * from an earlier day. Throws CounterUnreadable when unreadable, corrupt or from a later day.
   */
  private async readState(day: string): Promise<AutoState> {
    let text: string;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { v: 2, day, count: 0, retries: 0, claims: {} };
      throw new CounterUnreadable(errorClass(e));
    }
    let c: unknown;
    try {
      c = JSON.parse(text);
    } catch {
      throw new CounterUnreadable('corrupt');
    }
    if (!validState(c)) throw new CounterUnreadable('corrupt');
    // A clock stepped back across midnight must not grant a fresh cap (fail closed).
    if (c.day > day) throw new CounterUnreadable('future_day');
    return c.day === day ? c : { ...c, day, count: 0, retries: 0 };
  }

  private async writeState(c: AutoState): Promise<void> {
    const tmp = join(this.d.dir, `auto-approve.state.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      try {
        await fh.writeFile(`${JSON.stringify(c)}\n`, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.statePath);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  private today(): string {
    return israelDay(this.now());
  }

  /** Today's count as persisted (for tests and the design's operator check). */
  async todayCount(): Promise<number> {
    return (await this.readState(this.today())).count;
  }

  /** The cut-off (ms): the configured one, else the persisted first-run time (written now if new). */
  private sinceMs(): Promise<number> {
    if (this.d.since !== undefined) return Promise.resolve(this.d.since);
    return exclusive(this.d.dir, async () => {
      const s = await this.readState(this.today());
      if (s.since) return Date.parse(s.since);
      const since = new Date(this.now()).toISOString();
      await this.writeState({ ...s, since });
      this.log('signup: auto-approve cut-off recorded (only requests created from now on)');
      return Date.parse(since);
    });
  }

  /**
   * Claims one slot for `id` if it is still eligible and today's cap allows: the slot and the
   * claim are persisted first, then the record is marked (`autoApprovedAt`). Atomic with the
   * owner's actions (per-id lock) and with other claims (state-dir mutex).
   */
  private claim(id: string, since: number): Promise<'claimed' | 'ineligible' | 'cap'> {
    return exclusive(this.d.dir, async () => {
      const day = this.today();
      const s = await this.readState(day);
      if (s.count >= this.d.dailyCap) return 'cap';
      return serialById(id, async () => {
        const cur = await this.d.store.get(id).catch(() => null);
        if (!cur || !eligible(cur, s, since)) return 'ineligible' as const;
        const at = new Date(this.now()).toISOString();
        await this.writeState({
          ...s,
          count: s.count + 1,
          claims: { ...s.claims, [id]: { at, attempts: 1, lastAttemptAt: at } },
        });
        await this.d.store.update(id, { autoApprovedAt: at });
        return 'claimed' as const;
      });
    });
  }

  /** Reserves one retry of a claimed id (persisted before the call), within all three bounds. */
  private reserveRetry(id: string): Promise<'ok' | 'skip' | 'limit'> {
    return exclusive(this.d.dir, async () => {
      const s = await this.readState(this.today());
      const e = s.claims[id];
      if (!e || this.now() - Date.parse(e.lastAttemptAt) < AUTO_RETRY_BACKOFF_MS) return 'skip';
      if (s.retries >= this.d.dailyCap) return 'limit';
      const lastAttemptAt = new Date(this.now()).toISOString();
      await this.writeState({
        ...s,
        retries: s.retries + 1,
        claims: { ...s.claims, [id]: { ...e, attempts: e.attempts + 1, lastAttemptAt } },
      });
      return 'ok';
    });
  }

  /** Records the spool request id of the last call (diagnosis only; no decision depends on it). */
  private async noteSpool(id: string): Promise<void> {
    const sid = this.spoolId;
    this.spoolId = null;
    if (!sid || !SPOOL_ID_RE.test(sid)) return;
    await exclusive(this.d.dir, async () => {
      const s = await this.readState(this.today());
      const e = s.claims[id];
      if (!e) return;
      await this.writeState({ ...s, claims: { ...s.claims, [id]: { ...e, spoolId: sid } } });
    });
  }

  /** Drops claims that are finished or now the owner's (or whose record is gone). */
  private prune(records: Map<string, SignupRecord>): Promise<AutoState> {
    return exclusive(this.d.dir, async () => {
      const s = await this.readState(this.today());
      const keep: Record<string, Claim> = {};
      let dropped = false;
      for (const [id, e] of Object.entries(s.claims)) {
        // Not in this sweep's listing (claimed meanwhile, or purged): drop only when it is gone.
        const r = records.get(id) ?? (await this.d.store.get(id).catch(() => undefined));
        const open =
          r !== undefined &&
          !r.emailAttemptedAt &&
          (r.status === 'approved' || (r.status === 'pending' && r.lastError === null));
        if (open) keep[id] = e;
        else dropped = true;
      }
      if (!dropped) return s;
      const next = { ...s, claims: keep };
      await this.writeState(next);
      return next;
    });
  }

  private async approveOnce(approver: SignupApprover, id: string): Promise<void> {
    this.spoolId = null;
    await approver.approve(id);
    await this.noteSpool(id);
  }

  private sweeping = false;

  /** One pass: bounded retries of earlier claims, then new claims oldest first, until the cap. */
  async sweep(): Promise<SweepResult> {
    const out: SweepResult = { claimed: 0, attempted: 0 };
    if (this.sweeping) return { ...out, stopped: 'busy' };
    this.sweeping = true;
    try {
      return await this.sweepInner(out);
    } catch (e) {
      if (e instanceof CounterUnreadable) {
        this.log(`signup: auto-approve counter unreadable (${e.message}); treated as cap reached`);
        return { ...out, stopped: 'counter_unreadable' };
      }
      throw e;
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepInner(out: SweepResult): Promise<SweepResult> {
    if (await this.checkStateDir()) return { ...out, stopped: 'state_dir_unsafe' };
    const since = await this.sinceMs();
    if (await this.paused()) return { ...out, stopped: 'paused' };
    const approver = this.d.approver({
      onSpoolRequest: (sid) => {
        this.spoolId = sid;
      },
    });
    if (!approver) {
      if (!this.noOwnerLogged) {
        this.noOwnerLogged = true;
        this.log('signup: auto-approve waiting (owner principal not recorded; manual only)');
      }
      return { ...out, stopped: 'no_owner' };
    }
    this.noOwnerLogged = false;
    const records = await this.d.store.list(); // oldest first
    const state = await this.prune(new Map(records.map((r) => [r.id, r])));
    // 1. Earlier claims of THIS service whose account step did not finish: no new slot, bounded.
    let retries = 0;
    for (const r of records) {
      if (retries >= AUTO_RETRIES_PER_SWEEP) break;
      const e = state.claims[r.id];
      if (!e || r.status !== 'approved' || r.emailAttemptedAt) continue;
      if (this.now() - Date.parse(e.lastAttemptAt) < AUTO_RETRY_BACKOFF_MS) continue;
      if (await this.paused()) return { ...out, stopped: 'paused' };
      const res = await this.reserveRetry(r.id);
      if (res === 'limit') {
        const day = this.today();
        if (this.retryLoggedDay !== day) {
          this.retryLoggedDay = day;
          this.log(
            `signup: auto-approve retry limit reached (${this.d.dailyCap} today); the rest wait`,
          );
        }
        break;
      }
      if (res !== 'ok') continue;
      retries++;
      out.attempted++;
      await this.approveOnce(approver, r.id);
    }
    // 2. New claims.
    for (const r of records) {
      if (!eligible(r, state, since)) continue;
      if (await this.paused()) return { ...out, stopped: 'paused' };
      const c = await this.claim(r.id, since);
      if (c === 'cap') {
        const day = this.today();
        if (this.capLoggedDay !== day) {
          this.capLoggedDay = day;
          this.log(
            `signup: auto-approve daily cap reached (${this.d.dailyCap}); the rest stay pending`,
          );
        }
        return { ...out, stopped: 'cap' };
      }
      if (c !== 'claimed') continue;
      out.claimed++;
      out.attempted++;
      await this.approveOnce(approver, r.id);
    }
    return out;
  }
}

function eligible(r: SignupRecord, s: AutoState, since: number): boolean {
  return (
    r.status === 'pending' &&
    !r.autoApprovedAt &&
    r.lastError === null &&
    !Object.hasOwn(s.claims, r.id) &&
    Date.parse(r.createdAt) > since
  );
}
