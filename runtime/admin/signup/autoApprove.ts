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
 *                  uid and not group/world-writable, its path must be its own realpath (no
 *                  symlink component), and every parent up to / must be owned by this uid or root
 *                  and not group/world-writable unless sticky (autoStateDirCheck); else
 *                  auto-approve does not start / stops (logged once; manual mode stays). For
 *                  Alpha it must be an admin-only 0700 directory the intake user cannot write
 *                  (deploy item).
 *   Daily cap      at most `dailyCap` requests are CLAIMED for auto-approval per Israel calendar
 *                  day (Asia/Jerusalem, DST-correct via Intl). The count, the ids claimed by this
 *                  service and the cut-off live in `<state>/auto-approve.state.json` (0600, atomic
 *                  write), so they survive a restart. A slot is persisted BEFORE the record is
 *                  touched (a crash can waste a slot, never exceed the cap). Over the cap a request
 *                  simply stays `pending` (the "waitlist"): it is never lost, the owner may approve
 *                  it by hand, and later days' sweeps take it oldest first. An unreadable state
 *                  file, or one dated after today = cap reached (fail closed, logged at most once
 *                  an hour per reason, never reset silently). If marking the record fails after
 *                  the claim, the claim is released (or pruned as an orphan next sweep) but the
 *                  slot stays used.
 *   Cut-off        only requests created after the cut-off are auto-approved. The very first run
 *                  (no state file) records TBI_SIGNUP_AUTO_SINCE, or unset the current time. After
 *                  that, EVERY process starts unconfirmed: its first sweep that may approve (not
 *                  paused, owner recorded) first resets the cut-off to max(now, stored cut-off,
 *                  TBI_SIGNUP_AUTO_SINCE), so any restart, re-enable (env or drop-in off -> on),
 *                  resume after a pause, or recorded owner after `no_owner` leaves the requests
 *                  that arrived before it for the owner. The cut-off only moves forward. A reset
 *                  that cannot be persisted approves nothing (`reset_failed`) and is retried by
 *                  the next sweep; the daily count is never lowered by it. Lost state is never a
 *                  first run: once this process saw a paused / no_owner / unsafe-dir sweep or an
 *                  unreadable state, or the state file vanished after it had one, or any record
 *                  carries `autoApprovedAt`, or `<state>/auto-approve.marker` exists (both survive
 *                  a restart), a missing state file gets max(now, TBI_SIGNUP_AUTO_SINCE) ("state
 *                  missing, cut-off = now"). The empty marker is written (only into a dir that
 *                  passed the check) on every paused / no_owner sweep, on every sweep that ends
 *                  `counter_unreadable` (a failed write there is logged, at most hourly per errno,
 *                  and retried by the next such sweep) and with the first persisted cut-off; an
 *                  error looking for it counts as present. Limits, each looking like a first run
 *                  after a restart: state file and marker deleted (or the whole state dir) with no
 *                  marked record; state removed before any sweep of this release saw it (and no
 *                  marked record); a run that only ever saw an unsafe dir (nothing is written
 *                  there); a failed marker write followed by a restart.
 *   Heartbeat      S4b, only with TBI_SIGNUP_AUTO_CUTOFF_KEEP_S > 0 (owner decision open, DEC-38;
 *                  default off): every approving sweep writes `<state>/auto-approve.heartbeat.json`
 *                  after the cut-off is confirmed. A NEW process keeps the stored cut-off instead of
 *                  resetting it only when the state says `active`, this process saw no inactive
 *                  sweep, and the heartbeat is valid, not before the cut-off, not in the future and
 *                  at most KEEP_S old. Every paused, no_owner, unsafe-dir or unreadable-state sweep
 *                  removes it. Missing, invalid or not removable by the rules above = reset as
 *                  before. A pause set and removed while no sweep ran is not seen (as between two
 *                  sweeps).
 *   Kill switch    while `<state>/auto-approve.paused` exists (any entry: file, dir, symlink, even
 *                  dangling; lstat, never followed) nothing is auto-approved; every check error
 *                  other than ENOENT counts as paused (fail closed). Checked before every claim
 *                  and again inside it (under the state mutex, with the state dir check, right
 *                  before the slot is written), so `touch` / `rm` takes effect without a restart.
 *   Who is eligible  `pending`, created after the cut-off, not in the claim set and never marked
 *                  (`autoApprovedAt` unset), and without an error from an earlier approve attempt
 *                  (`lastError` null: those need the owner). Web-origin requests (`origin: 'web'`,
 *                  BETA-G1 s8 browser route) are NOT eligible unless TBI_SIGNUP_AUTO_WEB=included
 *                  (default `excluded`, until the owner decides O1 of BETA-G1-WEB-INTAKE.md): an
 *                  unauthenticated route must not be able to spend the daily cap and starve the
 *                  Apps Script requests, nor get accounts without the owner looking.
 *                  G1-AUTO-VERIFY: TBI_SIGNUP_AUTO_WEB=verified makes EVERY request (whatever its
 *                  `origin` says: the intake can drop the field) eligible only with an admin-written
 *                  verification (verifyState.ts) recorded after the cut-off for exactly the address
 *                  the record holds now; checked in the sweep, again inside the claim, and right
 *                  before the account request (`mayAdd`). Without a verifier nothing is eligible.
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
import { constants } from 'node:fs';
import { lstat as lstatAsync, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { errorClass } from './errors.js';
import { serialById } from './locks.js';
import type { SignupApprover } from './service.js';
import type { PendingStore, SignupRecord } from './store.js';
import { replaceJson } from './summary.js';

export const AUTO_PAUSE_FILE = 'auto-approve.paused';
/** Day count, retries, claim set and cut-off (admin-owned state). */
export const AUTO_STATE_FILE = 'auto-approve.state.json';
/** Empty file: "an earlier run used this dir". Must not end in `.mark` / `.tmp` (store purge). */
export const AUTO_MARKER_FILE = 'auto-approve.marker';
/** S4b: `{"v":1,"at":<ms>}`, only with a keep window. */
export const AUTO_HEARTBEAT_FILE = 'auto-approve.heartbeat.json';
export const AUTO_CAP_MAX = 1000;
export const AUTO_APPROVE_INTERVAL_MS = 60_000;
export const AUTO_TZ = 'Asia/Jerusalem';
/** A claimed record whose helper has not answered is resubmitted at most once per this window. */
export const AUTO_RETRY_BACKOFF_MS = 15 * 60_000;
/** Retries per sweep (the rest wait for the next sweep), so new claims are not starved. */
export const AUTO_RETRIES_PER_SWEEP = 2;
/** The unreadable-counter line repeats at most once per this window per reason. */
export const AUTO_UNREADABLE_LOG_MS = 60 * 60_000;

export type AutoApproveConfigResult =
  | { enabled: false; error?: false; reason: string }
  | { enabled: false; error: true; reason: string }
  | {
      enabled: true;
      dailyCap: number;
      stateDir?: string;
      since?: number;
      webSignups: AutoWebSignups;
    };

/** Whether web-origin requests may be auto-approved (default: excluded). */
export type AutoWebSignups = 'excluded' | 'included' | 'verified';

/** The admin-side verification as auto-approve sees it (verifyState.ts `Verifier`). */
export interface VerifiedCheck {
  verifiedFor(id: string, email: string, after?: number): Promise<boolean>;
}

const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/**
 *   TBI_SIGNUP_AUTO_APPROVE     must be exactly `1` to enable (unset or empty: off, silently)
 *   TBI_SIGNUP_AUTO_DAILY_CAP   required when enabled: whole number 1..1000
 *   TBI_SIGNUP_AUTO_STATE_DIR   optional absolute, normalized path (default: the store dir)
 *   TBI_SIGNUP_AUTO_SINCE       optional ISO time with zone; only newer requests are taken
 *   TBI_SIGNUP_AUTO_WEB         optional `excluded` (default when unset/empty), `included`, or
 *                               `verified` (every request needs an admin-recorded email proof)
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
  const web = env.TBI_SIGNUP_AUTO_WEB;
  if (
    web !== undefined &&
    web !== '' &&
    web !== 'excluded' &&
    web !== 'included' &&
    web !== 'verified'
  )
    return bad('TBI_SIGNUP_AUTO_WEB must be excluded, included, verified or unset');
  const out: {
    enabled: true;
    dailyCap: number;
    stateDir?: string;
    since?: number;
    webSignups: AutoWebSignups;
  } = {
    enabled: true,
    dailyCap: Number(cap),
    webSignups: web === 'included' || web === 'verified' ? web : 'excluded',
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

interface DirStat {
  uid: number;
  mode: number;
  isDirectory(): boolean;
}

/**
 * Whether the state dir can be swapped or rewritten by anyone but this process's uid (and root).
 * Returns null when safe, else a fixed reason, checked in this order:
 *   `not_dir`         the path itself is not a real directory (lstat: a symlink is refused)
 *   `owner` / `mode`  the dir is not owned by this uid, or is group/world-writable
 *   `symlink`         some component of the path is a symlink (realpath differs from the path)
 *   `ancestor_owner`  a parent (up to /) is owned by neither this uid nor root
 *   `ancestor_mode`   a parent is group/world-writable without the sticky bit (/tmp-style
 *                     1777 is fine: others can not rename or remove entries they do not own)
 *   an errno name     any lstat/realpath error (fail closed)
 * With no uid (non-POSIX) the owner checks are skipped. `lstat` is a test hook.
 */
export async function autoStateDirCheck(
  rawPath: string,
  opts: { lstat?: (p: string) => Promise<DirStat> } = {},
): Promise<string | null> {
  // A trailing slash is the same directory: strip it before the checks (a symlink is still refused: lstat says not_dir).
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') || '/' : rawPath;
  const stat = opts.lstat ?? lstatAsync;
  const uid = process.getuid?.();
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return 'not_dir';
    if (uid !== undefined && st.uid !== uid) return 'owner';
    if ((st.mode & 0o022) !== 0) return 'mode';
    if ((await realpath(path)) !== path) return 'symlink';
    for (let p = dirname(path); ; p = dirname(p)) {
      const a = await stat(p);
      if (!a.isDirectory()) return 'not_dir';
      if (uid !== undefined && a.uid !== uid && a.uid !== 0) return 'ancestor_owner';
      if ((a.mode & 0o022) !== 0 && (a.mode & 0o1000) === 0) return 'ancestor_mode';
      if (dirname(p) === p) return null;
    }
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
  /** Persisted cut-off: set by the first run, moved forward by every reset (confirm). */
  since?: string;
  /**
   * DEC-11: true once a sweep confirmed the cut-off, false after a paused / no_owner sweep. A
   * reset also happens on every new process (unconfirmed), whatever this says. Absent = never ran.
   */
  active?: boolean;
  /** Ids claimed by this service and not finished yet: the only ids ever retried. */
  claims: Record<string, Claim>;
}

/** The cut-off reset could not be written: the sweep stops with `reset_failed` (fail closed). */
class ResetFailed extends Error {
  constructor(readonly errno: string) {
    super('reset_failed');
  }
}

class CounterUnreadable extends Error {
  /** The errno name when the read itself failed (status route); the message stays the log class. */
  constructor(
    message: string,
    readonly errno?: string,
  ) {
    super(message);
  }
}

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
  if (s.active !== undefined && typeof s.active !== 'boolean') return false;
  if (!s.claims || typeof s.claims !== 'object' || Array.isArray(s.claims)) return false;
  for (const [id, e] of Object.entries(s.claims)) {
    if (!ID_RE.test(id) || !e || typeof e !== 'object') return false;
    if (!isTime(e.at) || !isTime(e.lastAttemptAt) || !isCount(e.attempts)) return false;
    if (e.spoolId !== undefined && (typeof e.spoolId !== 'string' || !SPOOL_ID_RE.test(e.spoolId)))
      return false;
  }
  return true;
}

/** tmp (O_EXCL, 0600) + fsync + rename + dir fsync. */
async function replaceDurably(dir: string, name: string, value: unknown): Promise<void> {
  await replaceJson(dir, name, value);
  const dh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
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
  /** TBI_SIGNUP_AUTO_WEB; unset = `excluded` (web-origin requests stay for the owner). */
  webSignups?: AutoWebSignups;
  /**
   * The approver for one sweep (built with the owner's principal as the spool actor, because the
   * root helper accepts account requests from the owner only), or null when the owner principal
   * is not recorded yet: then nothing is auto-approved (manual only, logged once). `onSpoolRequest`
   * is called with the id of each spool request its account step submits.
   */
  approver: (hooks: {
    onSpoolRequest(id: string): void;
    /** Called right before an account request with its address: false = do not submit. */
    mayAdd(email: string): Promise<boolean>;
  }) => SignupApprover | null;
  /** With webSignups `verified`: the admin-side verification; unset = nothing eligible. */
  verified?: VerifiedCheck;
  now?: () => number;
  log?: (line: string) => void;
  /** Test hook: replaces lstat for the kill switch. */
  stat?: (p: string) => Promise<unknown>;
  /** S4b: TBI_SIGNUP_AUTO_CUTOFF_KEEP_S in ms; unset = no heartbeat, every restart resets. */
  keepMs?: number;
}

export interface SweepResult {
  /** Requests claimed (a slot of today's cap was used) in this sweep. */
  claimed: number;
  /** Approve calls made (claims plus retries of earlier claims). */
  attempted: number;
  /** Why the sweep stopped early, if it did. */
  stopped?:
    | 'paused'
    | 'cap'
    | 'no_owner'
    | 'counter_unreadable'
    | 'busy'
    | 'state_dir_unsafe'
    | 'mark_failed'
    /** The cut-off reset of an unconfirmed process could not be persisted: nothing approved. */
    | 'reset_failed';
}

/**
 * The owner's read-only view of auto-approve (`GET /signups/auto-approve`, slice 5). Counts, the
 * cap, booleans, the Israel day, the cut-off time and fixed reason codes only: never an id, name,
 * address or path. A value that cannot be read is the string `unknown` (never a guessed number),
 * with its reason (an errno name or a fixed class) in `unknownReasons`.
 */
export interface AutoApproveStatus {
  /** The Israel calendar day the count belongs to (`YYYY-MM-DD`). */
  day: string;
  dailyCap: number;
  /** Requests claimed today (0 when the state file is from an earlier day or absent). */
  count: number | 'unknown';
  capReached: boolean | 'unknown';
  /** The kill switch, as the sweep sees it: any check error but ENOENT counts as paused. */
  paused: boolean;
  /** The errno name when the pause check failed (paused is then true, fail closed). */
  pauseError?: string;
  /** Whether the sweep accepts the state dir (autoStateDirCheck). */
  stateDir: 'ok' | 'unsafe';
  stateDirReason?: string;
  /**
   * Only requests created after this ISO time are auto-approved. `unknown` with the reason
   * `reset_pending` while this process has not reset the cut-off yet (before its first
   * approving sweep, or while paused / without the owner): the stored value is about to be
   * replaced, so it is not shown.
   */
  cutoff: string | 'unknown';
  /** Pending requests created at or before the cut-off: never auto-approved, they need the owner. */
  waitingBacklog: number | 'unknown';
  unknownReasons?: { count?: string; cutoff?: string; waitingBacklog?: string };
}

export class AutoApprover {
  private lastPaused = false;
  private readonly seenErrors = new Set<string>();
  private capLoggedDay: string | null = null;
  private retryLoggedDay: string | null = null;
  private unsafeLogged: string | null = null;
  private noOwnerLogged = false;
  /** Last time (ms) each unreadable-counter reason was logged: at most once per hour each. */
  private readonly unreadableLoggedAt = new Map<string, number>();
  /** Errno classes of failed record marks already logged (once each). */
  private readonly markErrors = new Set<string>();
  private spoolId: string | null = null;
  /**
   * BETA-G1 follow-up: every process starts unconfirmed (restart, env/drop-in off -> on). Set
   * again by every paused or `no_owner` sweep. While true nothing is claimed; the next sweep
   * that may approve first resets the cut-off (confirm) and only then clears it.
   */
  private unconfirmed = true;
  /** Last time (ms) each reset-failure class was logged: at most once per hour each. */
  private readonly resetFailLoggedAt = new Map<string, number>();
  /**
   * Set (never cleared) once this process saw a paused / no_owner / state_dir_unsafe sweep, an
   * unreadable state, or a missing state file after it had read one: a missing state can then
   * never be a first run (a backdated TBI_SIGNUP_AUTO_SINCE must not apply), see confirm().
   */
  private sawInactive = false;
  /** Last time (ms) each marker-write failure errno was logged: at most once per hour each. */
  private readonly markerFailLoggedAt = new Map<string, number>();
  private readonly heartbeatLoggedAt = new Map<string, number>();
  /** This process has read a state file (so a later ENOENT is lost state, not a first run). */
  private hadState = false;

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
  private async readState(day: string, track = true): Promise<AutoState> {
    let text: string;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        if (track && this.hadState) this.sawInactive = true;
        return { v: 2, day, count: 0, retries: 0, claims: {} };
      }
      throw new CounterUnreadable(errorClass(e), errnoOf(e));
    }
    if (track) this.hadState = true;
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

  /**
   * S4a (unverified purge): the ids in the claim set; null when the state dir is unsafe or the
   * state unreadable (the caller then purges nothing). No write, no log.
   */
  async claimedIds(): Promise<Set<string> | null> {
    if (await autoStateDirCheck(this.d.dir)) return null;
    try {
      return new Set(Object.keys((await this.readState(this.today(), false)).claims));
    } catch {
      return null;
    }
  }

  /**
   * S4b (summary file, read-only): whether today's cap is used up, and how many eligible requests
   * it holds back (0 while not used up; null while the cut-off is not confirmed). null = unsafe
   * state dir or unreadable state.
   */
  async capStatus(
    listed?: SignupRecord[],
  ): Promise<{ reached: boolean; waiting: number | null } | null> {
    if (await autoStateDirCheck(this.d.dir)) return null;
    let s: AutoState;
    try {
      s = await this.readState(this.today(), false);
    } catch {
      return null;
    }
    if (s.count < this.d.dailyCap) return { reached: false, waiting: 0 };
    if (this.unconfirmed || s.active !== true || !s.since) return { reached: true, waiting: null };
    const since = Math.max(this.d.since ?? -Infinity, Date.parse(s.since));
    let waiting = 0;
    for (const r of listed ?? (await this.d.store.list())) {
      if (!eligible(r, s, since, this.d.webSignups)) continue;
      // The record mirror first: the admin proof check costs several file system calls.
      if (this.d.webSignups === 'verified' && !r.verifiedAt) continue;
      if (await this.proven(r, since)) waiting++;
    }
    return { reached: true, waiting };
  }

  /** Today's count as persisted (for tests and the design's operator check). */
  async todayCount(): Promise<number> {
    return (await this.readState(this.today())).count;
  }

  /**
   * Read-only status for the owner's UI: no write, no lock, no log line, no change to the
   * transition/once-only log memory of the sweep. Reads the state file without the claim mutex
   * (it is replaced by an atomic rename, so a read sees one whole version). In an unsafe state
   * dir the state file is not read at all (the pause entry is only lstat'ed, never followed).
   */
  async status(): Promise<AutoApproveStatus> {
    const day = this.today();
    const unknown: NonNullable<AutoApproveStatus['unknownReasons']> = {};
    const bad = await autoStateDirCheck(this.d.dir);
    const pause = await autoPauseCheck(join(this.d.dir, AUTO_PAUSE_FILE), this.d.stat);
    let state: AutoState | null = null;
    if (bad) unknown.count = 'state_dir_unsafe';
    else
      try {
        state = await this.readState(day, false);
      } catch (e) {
        unknown.count = !(e instanceof CounterUnreadable)
          ? errorClass(e)
          : e.errno && e.errno !== 'unknown'
            ? e.errno
            : e.message;
      }
    let cutoff: number | null = null;
    // As confirm() will judge it: lost state is no first run (also not while paused).
    const firstRun =
      state &&
      this.unconfirmed &&
      !state.since &&
      state.active === undefined &&
      !pause.paused &&
      !this.hadState &&
      !(await this.lostState());
    if (state && !firstRun && (this.unconfirmed || state.active !== true || !state.since)) {
      // The stored cut-off is replaced by the next approving sweep: neither it nor a backlog
      // counted against it is shown (neutral `unknown`, reason reset_pending).
      unknown.cutoff = 'reset_pending';
    } else if (this.d.since !== undefined)
      cutoff = Math.max(this.d.since, state?.since ? Date.parse(state.since) : -Infinity);
    else if (state?.since) cutoff = Date.parse(state.since);
    else unknown.cutoff = state ? 'not_recorded' : unknown.count!;
    let backlog: number | null = null;
    if (cutoff === null) unknown.waitingBacklog = unknown.cutoff!;
    else
      try {
        const records = await this.d.store.list();
        backlog = records.filter(
          (r) => r.status === 'pending' && !(Date.parse(r.createdAt) > cutoff),
        ).length;
      } catch (e) {
        unknown.waitingBacklog = errnoOf(e) === 'unknown' ? errorClass(e) : errnoOf(e);
      }
    return {
      day,
      dailyCap: this.d.dailyCap,
      count: state ? state.count : 'unknown',
      capReached: state ? state.count >= this.d.dailyCap : 'unknown',
      paused: pause.paused,
      ...(pause.error ? { pauseError: pause.error } : {}),
      stateDir: bad ? 'unsafe' : 'ok',
      ...(bad ? { stateDirReason: bad } : {}),
      cutoff: cutoff === null ? 'unknown' : new Date(cutoff).toISOString(),
      waitingBacklog: backlog ?? 'unknown',
      ...(Object.keys(unknown).length > 0 ? { unknownReasons: unknown } : {}),
    };
  }

  /**
   * A paused or `no_owner` sweep: this process becomes unconfirmed (in memory, always) and the
   * state file records `active: false` (secondary: a failed write still stops the sweep, the
   * error propagates, and the in-memory flag makes the next approving sweep reset).
   * Written whenever `active` is not already false, also on an absent state: a paused or
   * `no_owner` first run is then no longer a first run, so a backdated TBI_SIGNUP_AUTO_SINCE
   * cannot approve requests that arrived meanwhile (also across a restart). An unreadable state
   * propagates (fail closed, nothing rewritten).
   */
  private markInactive(): Promise<void> {
    this.unconfirmed = true;
    this.sawInactive = true;
    return exclusive(this.d.dir, async () => {
      await this.dropHeartbeat();
      // First, so that it is there even when the state cannot be read or written.
      try {
        await this.writeMarker();
      } catch (e) {
        // An unreadable state still ends as counter_unreadable (the sweep retries the marker).
        await this.readState(this.today());
        throw e;
      }
      const s = await this.readState(this.today());
      if (s.active !== false) await this.writeState({ ...s, active: false });
    });
  }

  /**
   * The first approving sweep of an unconfirmed process (and any sweep that finds `active` not
   * true) persists the cut-off before anything is claimed, under the state-dir mutex:
   *   first run ever (no cut-off, no `active`): TBI_SIGNUP_AUTO_SINCE, else now;
   *   otherwise: max(now, stored cut-off, TBI_SIGNUP_AUTO_SINCE), never earlier (clock step back).
   * The count, retries and claims are written back unchanged. An unreadable state propagates
   * (counter_unreadable); a failed write throws ResetFailed. Either way the flag stays set.
   */
  private confirm(): Promise<void> {
    return exclusive(this.d.dir, async () => {
      const s = await this.readState(this.today());
      if (!this.unconfirmed && s.active === true && s.since) return;
      const env = this.d.since;
      let firstRun = this.unconfirmed && s.since === undefined && s.active === undefined;
      const kept = await this.keptCutoff(s);
      // Lost state (not a true first run): fail closed, the cut-off is now (or a later SINCE).
      if (firstRun && (await this.lostState())) {
        firstRun = false;
        this.log('signup: auto-approve state missing, cut-off = now');
      }
      const since = firstRun
        ? (env ?? this.now())
        : Math.max(kept ?? this.now(), s.since ? Date.parse(s.since) : -Infinity, env ?? -Infinity);
      try {
        await this.writeState({ ...s, since: new Date(since).toISOString(), active: true });
        // After the state, so a failed first write stays a first run; nothing is claimed without it.
        await this.writeMarker();
      } catch (e) {
        throw new ResetFailed(errnoOf(e));
      }
      this.unconfirmed = false;
      this.log(
        firstRun
          ? 'signup: auto-approve cut-off recorded (only requests created from now on)'
          : kept !== null
            ? 'signup: auto-approve cut-off kept (restart within the heartbeat window)'
            : 'signup: auto-approve cut-off reset (only requests created from now on)',
      );
    });
  }

  /**
   * S4b: the stored cut-off (ms) when this restart may keep it, else null (= reset). Fail closed
   * on anything missing, invalid, in the future, older than the window or older than the cut-off
   * (a run that moved the cut-off without writing a heartbeat).
   */
  private async keptCutoff(s: AutoState): Promise<number | null> {
    const keep = this.d.keepMs;
    if (!keep || !this.unconfirmed || this.sawInactive || s.active !== true || !s.since)
      return null;
    const cut = Date.parse(s.since);
    const at = await this.readHeartbeat();
    const t = this.now();
    return at !== null && at >= cut && at <= t && t - at <= keep ? cut : null;
  }

  private async readHeartbeat(): Promise<number | null> {
    try {
      const fh = await open(
        join(this.d.dir, AUTO_HEARTBEAT_FILE),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > 128) return null;
        const h = JSON.parse(await fh.readFile('utf8')) as { v?: unknown; at?: unknown } | null;
        return h?.v === 1 && Number.isSafeInteger(h.at) ? (h.at as number) : null;
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  /** A failed write only lets the heartbeat age (= reset at the next restart). */
  private async writeHeartbeat(): Promise<void> {
    if (!this.d.keepMs) return;
    await exclusive(this.d.dir, async () => {
      if (this.unconfirmed) return;
      await replaceDurably(this.d.dir, AUTO_HEARTBEAT_FILE, { v: 1, at: this.now() });
    }).catch((e: unknown) => this.logHeartbeat('written', errnoOf(e)));
  }

  /** Removing it can only cause a reset, so it is also tried when the dir check failed. */
  async dropHeartbeat(): Promise<void> {
    if (!this.d.keepMs) return;
    await unlink(join(this.d.dir, AUTO_HEARTBEAT_FILE)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') this.logHeartbeat('removed', errnoOf(e));
    });
  }

  /** At most once per hour per failure. */
  private logHeartbeat(what: 'written' | 'removed', cls: string): void {
    const key = `${what} ${cls}`;
    const last = this.heartbeatLoggedAt.get(key);
    const t = this.now();
    if (last !== undefined && t >= last && t - last < AUTO_UNREADABLE_LOG_MS) return;
    this.heartbeatLoggedAt.set(key, t);
    this.log(`signup: auto-approve heartbeat not ${what} (${cls})`);
  }

  /** An inactive sweep: unconfirmed, never a first run again, and no heartbeat to keep. */
  private async inactive(): Promise<void> {
    this.unconfirmed = true;
    this.sawInactive = true;
    await this.dropHeartbeat();
  }

  /** Creates the marker when no entry of that name exists (the caller has checked the dir). */
  private async writeMarker(): Promise<void> {
    try {
      const fh = await open(join(this.d.dir, AUTO_MARKER_FILE), 'wx', 0o600);
      await fh.close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }

  /**
   * A sweep that ends counter_unreadable leaves the marker, so a new process does not take a
   * later missing state file for a first run. Nothing goes into an unsafe dir. Never throws: a
   * failed write is logged (errno only) and the next such sweep tries again.
   */
  private async markUnreadable(): Promise<void> {
    try {
      if (await this.checkStateDir()) return;
      await this.writeMarker();
    } catch (e) {
      const cls = errnoOf(e);
      const last = this.markerFailLoggedAt.get(cls);
      const t = this.now();
      if (last === undefined || t - last >= AUTO_UNREADABLE_LOG_MS || t < last) {
        this.markerFailLoggedAt.set(cls, t);
        this.log(
          `signup: auto-approve marker not written (${cls}); retried at the next unreadable-state sweep`,
        );
      }
    }
  }

  /** Whether a missing cut-off means lost state rather than a first run. Read-only. */
  private async lostState(): Promise<boolean> {
    if (this.sawInactive) return true;
    try {
      await lstatAsync(join(this.d.dir, AUTO_MARKER_FILE));
      return true;
    } catch (e) {
      // Any error but "no such entry" counts as present (fail closed).
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
    return this.earlierRunInStore();
  }

  /**
   * Whether an earlier run left a mark in the store (a record with `autoApprovedAt`): then a
   * missing state file was lost, not never written. A listing error counts as yes (fail closed).
   */
  private async earlierRunInStore(): Promise<boolean> {
    try {
      return (await this.d.store.list()).some((r) => !!r.autoApprovedAt);
    } catch {
      return true;
    }
  }

  /**
   * Kill switch and state dir, re-checked under the state mutex right before a slot or a retry is
   * written (closes the race with a pause created after the sweep's own check). A check that
   * errors counts as paused. Not ok: this process is unconfirmed and the sweep stops.
   */
  private async stillMayApprove(): Promise<'ok' | 'paused' | 'state_dir_unsafe'> {
    let r: 'ok' | 'paused' | 'state_dir_unsafe';
    try {
      r = (await this.checkStateDir())
        ? 'state_dir_unsafe'
        : (await this.paused())
          ? 'paused'
          : 'ok';
    } catch {
      r = 'paused';
    }
    if (r !== 'ok') await this.inactive();
    return r;
  }

  /**
   * The cut-off (ms): the later of the configured and the persisted one. Read-only: confirm()
   * has persisted it before this is asked; none at all = nothing is eligible (fail closed).
   */
  private async sinceMs(): Promise<number> {
    const s = await this.readState(this.today());
    const t = Math.max(this.d.since ?? -Infinity, s.since ? Date.parse(s.since) : -Infinity);
    return t === -Infinity ? Infinity : t;
  }

  /**
   * Claims one slot for `id` if it is still eligible and today's cap allows: the slot and the
   * claim are persisted first, then the record is marked (`autoApprovedAt`). Atomic with the
   * owner's actions (per-id lock) and with other claims (state-dir mutex).
   */
  private claim(
    id: string,
    since: number,
  ): Promise<'claimed' | 'ineligible' | 'cap' | 'mark_failed' | 'paused' | 'state_dir_unsafe'> {
    return exclusive(this.d.dir, async () => {
      // Defence in depth: never a claim before this process has reset the cut-off.
      if (this.unconfirmed) return 'ineligible';
      const day = this.today();
      const s = await this.readState(day);
      if (s.count >= this.d.dailyCap) return 'cap';
      // The cut-off as persisted now (under the mutex), never older than the sweep's.
      const cut = Math.max(since, s.since ? Date.parse(s.since) : -Infinity);
      return serialById(id, async () => {
        const cur = await this.d.store.get(id).catch(() => null);
        if (!cur || !eligible(cur, s, cut, this.d.webSignups)) return 'ineligible' as const;
        if (!(await this.proven(cur, cut))) return 'ineligible' as const;
        // A pause (or unsafe dir) that appeared since the sweep's check: nothing is written.
        const may = await this.stillMayApprove();
        if (may !== 'ok') return may;
        const at = new Date(this.now()).toISOString();
        const taken: AutoState = {
          ...s,
          active: true,
          count: s.count + 1,
          claims: { ...s.claims, [id]: { at, attempts: 1, lastAttemptAt: at } },
        };
        await this.writeState(taken);
        try {
          await this.d.store.update(id, { autoApprovedAt: at });
        } catch (e) {
          // Approve was never called, so the claim is released (the request becomes eligible
          // again), but the slot stays used: the count never goes down, so the cap holds. If the
          // release itself fails, prune drops the orphan claim at the next sweep.
          const released = await this.writeState({ ...taken, claims: s.claims }).then(
            () => true,
            () => false,
          );
          const cls = errnoOf(e);
          if (!this.markErrors.has(cls) && this.markErrors.size < 16) {
            this.markErrors.add(cls);
            this.log(
              `signup: auto-approve could not mark a claimed request (${cls}); ` +
                `${released ? 'claim released' : 'claim left for the next sweep'}, slot stays used`,
            );
          }
          return 'mark_failed' as const;
        }
        return 'claimed' as const;
      });
    });
  }

  /** Reserves one retry of a claimed id (persisted before the call), within all three bounds. */
  private reserveRetry(
    id: string,
  ): Promise<'ok' | 'skip' | 'limit' | 'paused' | 'state_dir_unsafe'> {
    return exclusive(this.d.dir, async () => {
      const s = await this.readState(this.today());
      const e = s.claims[id];
      if (!e || this.now() - Date.parse(e.lastAttemptAt) < AUTO_RETRY_BACKOFF_MS) return 'skip';
      if (s.retries >= this.d.dailyCap) return 'limit';
      const may = await this.stillMayApprove();
      if (may !== 'ok') return may;
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

  /**
   * Drops claims that are finished or now the owner's (or whose record is gone), and orphan
   * claims: still `pending` and never marked, i.e. the mark failed or the process died between
   * the claim and the mark (outside this mutex a live claim is always marked). Approve was never
   * called for an orphan, so its request may be claimed again (with a new slot).
   */
  private prune(records: Map<string, SignupRecord>): Promise<AutoState> {
    return exclusive(this.d.dir, async () => {
      const s = await this.readState(this.today());
      const keep: Record<string, Claim> = {};
      let dropped = false;
      const fresh = (id: string) => this.d.store.get(id).catch(() => undefined);
      for (const [id, e] of Object.entries(s.claims)) {
        // Not in this sweep's listing (claimed meanwhile, or purged): drop only when it is gone.
        let r = records.get(id) ?? (await fresh(id));
        // The listing may predate a claim made since: re-read before calling it an orphan.
        if (r?.status === 'pending' && !r.autoApprovedAt) r = await fresh(id);
        const open =
          r !== undefined &&
          !r.emailAttemptedAt &&
          (r.status === 'approved' ||
            (r.status === 'pending' && r.lastError === null && !!r.autoApprovedAt));
        if (open) keep[id] = e;
        else dropped = true;
      }
      if (!dropped) return s;
      const next = { ...s, claims: keep };
      await this.writeState(next);
      return next;
    });
  }

  /** Verified mode: the record's current address carries a verification newer than `after`. */
  private async proven(r: SignupRecord, after: number): Promise<boolean> {
    if (this.d.webSignups !== 'verified') return true;
    return (await this.d.verified?.verifiedFor(r.id, r.email, after)) === true;
  }

  /** The id whose approve call is running (for the `mayAdd` hook). */
  private current: string | null = null;

  private async approveOnce(approver: SignupApprover, id: string): Promise<void> {
    this.spoolId = null;
    this.current = id;
    try {
      await approver.approve(id);
    } finally {
      this.current = null;
    }
    await this.noteSpool(id);
  }

  /** Right before the account request: in verified mode the address must still be the proven one. */
  private async mayAdd(email: string): Promise<boolean> {
    if (this.d.webSignups !== 'verified') return true;
    const id = this.current;
    return id !== null && (await this.d.verified?.verifiedFor(id, email)) === true;
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
        this.sawInactive = true;
        await this.dropHeartbeat();
        const last = this.unreadableLoggedAt.get(e.message);
        const t = this.now();
        // A clock stepped back also logs again (never silent for longer than the window).
        if (last === undefined || t - last >= AUTO_UNREADABLE_LOG_MS || t < last) {
          this.unreadableLoggedAt.set(e.message, t);
          this.log(
            `signup: auto-approve counter unreadable (${e.message}); treated as cap reached`,
          );
        }
        await this.markUnreadable();
        return { ...out, stopped: 'counter_unreadable' };
      }
      if (e instanceof ResetFailed) {
        const last = this.resetFailLoggedAt.get(e.errno);
        const t = this.now();
        if (last === undefined || t - last >= AUTO_UNREADABLE_LOG_MS || t < last) {
          this.resetFailLoggedAt.set(e.errno, t);
          this.log(
            `signup: auto-approve cut-off reset failed (${e.errno}); nothing approved, retried next sweep`,
          );
        }
        return { ...out, stopped: 'reset_failed' };
      }
      throw e;
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepInner(out: SweepResult): Promise<SweepResult> {
    if (await this.checkStateDir()) {
      // Like a pause (the state is not touched: the dir is not trusted): reset on recovery, and
      // a missing state file after it is lost state (cut-off = now), never a first run.
      await this.inactive();
      return { ...out, stopped: 'state_dir_unsafe' };
    }
    if (await this.paused()) {
      await this.markInactive();
      return { ...out, stopped: 'paused' };
    }
    const approver = this.d.approver({
      onSpoolRequest: (sid) => {
        this.spoolId = sid;
      },
      mayAdd: (email) => this.mayAdd(email),
    });
    if (!approver) {
      if (!this.noOwnerLogged) {
        this.noOwnerLogged = true;
        this.log('signup: auto-approve waiting (owner principal not recorded; manual only)');
      }
      // Like a pause: requests that pile up meanwhile are left for the owner (reset on recovery).
      await this.markInactive();
      return { ...out, stopped: 'no_owner' };
    }
    this.noOwnerLogged = false;
    // The reset completes (persisted) before any retry or claim of this sweep.
    await this.confirm();
    await this.writeHeartbeat();
    const since = await this.sinceMs();
    const records = await this.d.store.list(); // oldest first
    const state = await this.prune(new Map(records.map((r) => [r.id, r])));
    // 1. Earlier claims of THIS service whose account step did not finish: no new slot, bounded.
    let retries = 0;
    for (const r of records) {
      if (retries >= AUTO_RETRIES_PER_SWEEP) break;
      const e = state.claims[r.id];
      if (!e || r.status !== 'approved' || r.emailAttemptedAt) continue;
      if (this.now() - Date.parse(e.lastAttemptAt) < AUTO_RETRY_BACKOFF_MS) continue;
      if (await this.paused()) {
        await this.inactive();
        return { ...out, stopped: 'paused' };
      }
      const res = await this.reserveRetry(r.id);
      if (res === 'paused' || res === 'state_dir_unsafe') return { ...out, stopped: res };
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
      if (!eligible(r, state, since, this.d.webSignups)) continue;
      if (!(await this.proven(r, since))) continue;
      if (await this.paused()) {
        await this.inactive();
        return { ...out, stopped: 'paused' };
      }
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
      if (c === 'mark_failed') return { ...out, stopped: 'mark_failed' };
      if (c === 'paused' || c === 'state_dir_unsafe') return { ...out, stopped: c };
      if (c !== 'claimed') continue;
      out.claimed++;
      out.attempted++;
      await this.approveOnce(approver, r.id);
    }
    return out;
  }
}

function eligible(
  r: SignupRecord,
  s: AutoState,
  since: number,
  web: AutoWebSignups = 'excluded',
): boolean {
  return (
    r.status === 'pending' &&
    // `verified`: origin is ignored (every request needs a proof, checked by proven()).
    (web !== 'excluded' || r.origin !== 'web') &&
    !r.autoApprovedAt &&
    r.lastError === null &&
    !Object.hasOwn(s.claims, r.id) &&
    Date.parse(r.createdAt) > since
  );
}
